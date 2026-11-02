"use client";

import { useQueryClient } from "@tanstack/react-query";
import { ChevronDownIcon, HistoryIcon, PlusIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { toast } from "sonner";

import { type PromptInputMessage } from "@/components/ai-elements/prompt-input";
import { Button } from "@/components/ui/button";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { ExportTrigger } from "@/components/workspace/export-trigger";
import { GoalStatus } from "@/components/workspace/goal-status";
import {
  InputBox,
  type InputBoxSubmitOptions,
} from "@/components/workspace/input-box";
import {
  MessageList,
  MESSAGE_LIST_DEFAULT_PADDING_BOTTOM,
} from "@/components/workspace/messages";
import { ThreadContext } from "@/components/workspace/messages/context";
import { SkillMenu } from "@/components/workspace/skill-menu";
import { ThreadScheduledTasksLink } from "@/components/workspace/thread-scheduled-tasks-link";
import { ThreadTitle } from "@/components/workspace/thread-title";
import { TodoList } from "@/components/workspace/todo-list";
import { TokenUsageIndicator } from "@/components/workspace/token-usage-indicator";
import { Tooltip } from "@/components/workspace/tooltip";
import { useActiveGoal } from "@/components/workspace/use-active-goal";
import { useI18n } from "@/core/i18n/hooks";
import {
  buildHumanInputResponseText,
  hasOpenHumanInputRequest,
  type HumanInputRequest,
  type HumanInputResponse,
} from "@/core/messages/human-input";
import { isHiddenFromUIMessage } from "@/core/messages/utils";
import { useModels } from "@/core/models/hooks";
import { useNotification } from "@/core/notification/hooks";
import { useLocalSettings, useThreadSettings } from "@/core/settings";
import { useSkills } from "@/core/skills/hooks";
import {
  useBranchThread,
  useThreadMetadata,
  useThreadStream,
  useThreadTokenUsage,
} from "@/core/threads/hooks";
import {
  selectContextUsage,
  threadTokenUsageToTokenUsage,
} from "@/core/threads/token-usage";
import { textOfMessage } from "@/core/threads/utils";
import { env } from "@/env";
import { cn } from "@/lib/utils";

import { useLeadAgent } from "./lead-agent-context";
import { ResourceUndoControl } from "./resource-undo-control";

export function LeadAgentConversation({
  onCollapse,
}: {
  onCollapse: () => void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const {
    threadId,
    isNewThread,
    markThreadStarted,
    newConversation,
    openHistory,
    activeSkillName,
    setActiveSkillName,
  } = useLeadAgent();
  const [settings, setSettings] = useThreadSettings(threadId);
  const [localSettings, setLocalSettings] = useLocalSettings();
  const { tokenUsageEnabled } = useModels();
  const { skills, isLoading: skillsLoading } = useSkills();
  const threadTokenUsage = useThreadTokenUsage(
    isNewThread ? undefined : threadId,
  );
  const threadMetadata = useThreadMetadata(threadId, {
    enabled: !isNewThread,
  });
  const branchThread = useBranchThread();
  const streamContext = useMemo(
    () => ({
      ...settings.context,
      active_skills: activeSkillName ? [activeSkillName] : [],
    }),
    [activeSkillName, settings.context],
  );
  const backendTokenUsage = threadTokenUsageToTokenUsage(threadTokenUsage.data);
  const contextUsage = selectContextUsage(threadTokenUsage.data);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
  }, []);

  useEffect(() => {
    if (
      !skillsLoading &&
      activeSkillName &&
      !skills.some((skill) => skill.enabled && skill.name === activeSkillName)
    ) {
      setActiveSkillName(null);
    }
  }, [activeSkillName, setActiveSkillName, skills, skillsLoading]);

  const { showNotification } = useNotification();

  const {
    thread,
    pendingUsageMessages,
    sendMessage,
    regenerateMessage,
    editAndRegenerateMessage,
    isUploading,
    isHistoryLoading,
    hasMoreHistory,
    loadMoreHistory,
  } = useThreadStream({
    threadId: isNewThread ? undefined : threadId,
    displayThreadId: threadId,
    context: streamContext,
    onStart: (createdThreadId) => {
      markThreadStarted(createdThreadId);
    },
    onFinish: (state) => {
      void queryClient.invalidateQueries({
        queryKey: ["workspace-resource-changes", threadId],
      });
      void queryClient.invalidateQueries({ queryKey: ["workflows"] });
      void queryClient.invalidateQueries({ queryKey: ["workflow-folders"] });
      void queryClient.invalidateQueries({ queryKey: ["workbenches"] });
      if (document.hidden || !document.hasFocus()) {
        let body = "Conversation finished";
        const lastMessage = state.messages.at(-1);
        if (lastMessage) {
          const textContent = textOfMessage(lastMessage);
          if (textContent) {
            body =
              textContent.length > 200
                ? textContent.substring(0, 200) + "..."
                : textContent;
          }
        }
        showNotification(state.title, { body });
      }
    },
  });

  const hasThreadMessages = thread.messages.length > 0;

  useEffect(() => {
    if (
      !isNewThread &&
      threadMetadata.data === null &&
      !threadMetadata.isLoading &&
      !threadMetadata.isFetching &&
      !isHistoryLoading &&
      !hasMoreHistory &&
      !hasThreadMessages
    ) {
      newConversation();
    }
  }, [
    hasMoreHistory,
    hasThreadMessages,
    isHistoryLoading,
    isNewThread,
    newConversation,
    threadMetadata.data,
    threadMetadata.isFetching,
    threadMetadata.isLoading,
  ]);

  const handleSubmit = useCallback(
    (message: PromptInputMessage, options?: InputBoxSubmitOptions) => {
      const sendPromise = sendMessage(threadId, message, undefined, options);
      if (message.files.length > 0) {
        return sendPromise;
      }
      void sendPromise;
    },
    [sendMessage, threadId],
  );

  const handleSubmitHumanInput = useCallback(
    async (request: HumanInputRequest, response: HumanInputResponse) => {
      let sent = false;
      await sendMessage(
        threadId,
        {
          text: buildHumanInputResponseText(request, response),
          files: [],
        },
        undefined,
        {
          additionalKwargs: {
            hide_from_ui: true,
            human_input_response: response,
          },
          onSent: () => {
            sent = true;
          },
        },
      );
      return sent;
    },
    [sendMessage, threadId],
  );

  const handleStop = useCallback(async () => {
    await thread.stop();
  }, [thread]);

  const handleRegenerate = useCallback(
    (messageId: string, supersededMessageIds: string[]) =>
      regenerateMessage(threadId, messageId, supersededMessageIds),
    [regenerateMessage, threadId],
  );

  const handleEditAndRegenerate = useCallback(
    (messageId: string, replacementText: string) =>
      editAndRegenerateMessage(threadId, messageId, replacementText),
    [editAndRegenerateMessage, threadId],
  );

  const handleBranchTurn = useCallback(
    async (messageId: string, messageIds: string[]) => {
      if (isNewThread || env.NEXT_PUBLIC_STATIC_WEBSITE_ONLY === "true") {
        return;
      }

      try {
        const response = await branchThread.mutateAsync({
          threadId,
          messageId,
          messageIds,
        });
        toast.success(t.conversation.branchCreated);
        markThreadStarted(response.thread_id);
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : t.conversation.branchFailed,
        );
      }
    },
    [branchThread, isNewThread, markThreadStarted, t, threadId],
  );

  const tokenUsageInlineMode = tokenUsageEnabled
    ? localSettings.tokenUsage.inlineMode
    : "off";
  const hasTodos = (thread.values.todos?.length ?? 0) > 0;
  const { activeGoal, hasGoal, setLocalGoal } = useActiveGoal(
    threadId,
    thread.values.goal,
  );
  const hasOpenHumanInputCard = useMemo(
    () =>
      hasOpenHumanInputRequest(
        thread.messages,
        (message) => !isHiddenFromUIMessage(message),
      ),
    [thread.messages],
  );

  return (
    <ThreadContext.Provider value={{ thread, isMock: false }}>
      <div
        className="flex size-full min-h-0 flex-col"
        data-testid="lead-agent-conversation"
      >
        <header className="flex h-10 shrink-0 items-center gap-1 border-b px-2">
          <SidebarTrigger className="md:hidden" />
          <Tooltip content={t.leadAgent.history}>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t.leadAgent.history}
              title={t.leadAgent.history}
              onClick={openHistory}
              data-testid="lead-agent-history"
            >
              <HistoryIcon className="size-4" />
            </Button>
          </Tooltip>
          <Tooltip content={t.leadAgent.newChat}>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t.leadAgent.newChat}
              title={t.leadAgent.newChat}
              onClick={newConversation}
              data-testid="lead-agent-new"
            >
              <PlusIcon className="size-4" />
            </Button>
          </Tooltip>
          <div className="flex min-w-0 flex-1 items-center text-sm font-medium">
            <ThreadTitle
              threadId={threadId}
              thread={thread}
              isNewThread={isNewThread}
            />
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {!isNewThread && <ThreadScheduledTasksLink threadId={threadId} />}
            {tokenUsageEnabled && (
              <TokenUsageIndicator
                threadId={isNewThread ? undefined : threadId}
                backendUsage={backendTokenUsage}
                contextUsage={contextUsage}
                enabled={tokenUsageEnabled}
                messages={thread.messages}
                pendingMessages={pendingUsageMessages}
                preferences={localSettings.tokenUsage}
                onPreferencesChange={(preferences) =>
                  setLocalSettings("tokenUsage", preferences)
                }
              />
            )}
            {!isNewThread && <ExportTrigger threadId={threadId} />}
            <Tooltip content={t.leadAgent.collapse}>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t.leadAgent.collapse}
                title={t.leadAgent.collapse}
                onClick={onCollapse}
                data-testid="lead-agent-collapse"
              >
                <ChevronDownIcon className="size-4" />
              </Button>
            </Tooltip>
          </div>
        </header>

        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 justify-center">
            <MessageList
              className="size-full"
              testId="main-message-list"
              threadId={threadId}
              thread={thread}
              paddingBottom={MESSAGE_LIST_DEFAULT_PADDING_BOTTOM}
              hasMoreHistory={hasMoreHistory}
              loadMoreHistory={loadMoreHistory}
              isHistoryLoading={isHistoryLoading}
              tokenUsageInlineMode={tokenUsageInlineMode}
              canRegenerate={
                !isNewThread &&
                env.NEXT_PUBLIC_STATIC_WEBSITE_ONLY !== "true" &&
                !isUploading &&
                !thread.isLoading
              }
              onRegenerateMessage={handleRegenerate}
              canEdit={
                !isNewThread &&
                env.NEXT_PUBLIC_STATIC_WEBSITE_ONLY !== "true" &&
                !isUploading &&
                !thread.isLoading &&
                !branchThread.isPending &&
                !hasGoal &&
                !hasOpenHumanInputCard
              }
              onEditAndRegenerateMessage={handleEditAndRegenerate}
              onSubmitHumanInput={
                env.NEXT_PUBLIC_STATIC_WEBSITE_ONLY === "true"
                  ? undefined
                  : handleSubmitHumanInput
              }
              canBranch={
                !isNewThread &&
                env.NEXT_PUBLIC_STATIC_WEBSITE_ONLY !== "true" &&
                !isUploading &&
                !thread.isLoading &&
                !branchThread.isPending
              }
              onBranchTurn={handleBranchTurn}
            />
          </div>

          <div className="relative z-20 flex shrink-0 justify-center px-3 pb-3">
            <div className="relative w-full max-w-(--container-width-md)">
              {(hasGoal || hasTodos) && (
                <div className="right-0 left-0 z-0">
                  <div className="right-0 bottom-0 left-0 flex flex-col">
                    {activeGoal && <GoalStatus goal={activeGoal} />}
                    {hasTodos && (
                      <TodoList
                        className="bg-background/5"
                        todos={thread.values.todos ?? []}
                        hidden={false}
                      />
                    )}
                  </div>
                </div>
              )}
              {mountedRef.current ? (
                <InputBox
                  className={cn("bg-background/5 w-full")}
                  isWelcomeMode={false}
                  leadingActions={
                    <>
                      <SkillMenu
                        activeSkillName={activeSkillName}
                        onSelect={setActiveSkillName}
                        disabled={
                          env.NEXT_PUBLIC_STATIC_WEBSITE_ONLY === "true" ||
                          thread.isLoading
                        }
                      />
                      <ResourceUndoControl
                        threadId={threadId}
                        disabled={
                          isNewThread ||
                          env.NEXT_PUBLIC_STATIC_WEBSITE_ONLY === "true" ||
                          thread.isLoading
                        }
                      />
                    </>
                  }
                  activeSkillName={activeSkillName}
                  onClearActiveSkill={() => setActiveSkillName(null)}
                  threadId={threadId}
                  draftThreadId={isNewThread ? "new" : threadId}
                  status={
                    thread.error
                      ? "error"
                      : thread.isLoading
                        ? "streaming"
                        : "ready"
                  }
                  context={settings.context}
                  disabled={
                    env.NEXT_PUBLIC_STATIC_WEBSITE_ONLY === "true" ||
                    isUploading ||
                    (!isNewThread && isHistoryLoading)
                  }
                  onContextChange={(context) => setSettings("context", context)}
                  onGoalChange={setLocalGoal}
                  onSubmit={handleSubmit}
                  onStop={handleStop}
                />
              ) : (
                <div
                  aria-hidden="true"
                  className="bg-background/5 h-32 w-full rounded-2xl"
                />
              )}
            </div>
          </div>
        </div>
      </div>
    </ThreadContext.Provider>
  );
}
