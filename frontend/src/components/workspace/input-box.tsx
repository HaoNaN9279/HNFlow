"use client";

import type { Message } from "@langchain/langgraph-sdk";
import { useQueryClient } from "@tanstack/react-query";
import type { ChatStatus } from "ai";
import {
  BookOpenIcon,
  CheckIcon,
  MicIcon,
  PaperclipIcon,
  SparklesIcon,
  SquareIcon,
  TargetIcon,
  XIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ComponentProps,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { toast } from "sonner";

import {
  PromptInput,
  PromptInputAttachment,
  PromptInputAttachments,
  PromptInputButton,
  PromptInputFooter,
  PromptInputHeader,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputAttachments,
  usePromptInputController,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
import { fetch } from "@/core/api/fetcher";
import { useAuth } from "@/core/auth/AuthProvider";
import { getBackendBaseURL } from "@/core/config";
import { useI18n } from "@/core/i18n/hooks";
import { useModelProfiles } from "@/core/model-profiles/hooks";
import { useModels } from "@/core/models/hooks";
import { useSkills } from "@/core/skills/hooks";
import type { AgentThreadContext, GoalState } from "@/core/threads";
import { compactThreadContext } from "@/core/threads/api";
import {
  buildComposerDraftKey,
  clearComposerDraft,
  getSessionComposerDraftStorage,
  readComposerDraft,
  resolveComposerDraft,
  type ComposerDraft,
  writeComposerDraft,
} from "@/core/threads/composer-draft";
import { threadTokenUsageQueryKey } from "@/core/threads/token-usage";
import { textOfMessage } from "@/core/threads/utils";
import {
  formatUploadSize,
  splitUnsupportedUploadFiles,
  useUploadLimits,
  validateUploadLimits,
  type UploadLimits,
  type UploadLimitViolation,
} from "@/core/uploads";
import {
  appendSpeechTranscript,
  getSpeechRecognitionConstructor,
  getSpeechRecognitionLanguage,
  mapSpeechRecognitionError,
  readSpeechRecognitionTranscript,
  shouldRestartSpeechRecognition,
  type BrowserSpeechRecognition,
  type SpeechRecognitionErrorKind,
} from "@/core/voice-input/speech-recognition";
import { isIMEComposing } from "@/lib/ime";
import { cn } from "@/lib/utils";

import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorName,
  ModelSelectorTrigger,
} from "../ai-elements/model-selector";

import {
  abortGoalRequest,
  beginGoalRequest,
  createGoalRequestState,
  findSuggestionTemplatePlaceholder,
  finishGoalRequest,
  getGoalObjectiveCounter,
  getInputSubmitAction,
  getLeadingSlashSkillQuery,
  getMatchingSkillSuggestions,
  type GoalCommand,
  isAbortError,
  isCurrentGoalRequest,
  isGoalObjectiveTooLong,
  MAX_GOAL_OBJECTIVE_CHARS,
  readGoalResponseError,
  type SlashSuggestion,
} from "./input-box-helpers";
import { useThread } from "./messages/context";
import { SlashSkillChip } from "./slash-skill-chip";
import { Tooltip } from "./tooltip";

const COMPOSER_DRAFT_SAVE_DELAY_MS = 300;

function focusContentEditableEnd(element: HTMLElement | null) {
  if (!element) {
    return;
  }

  element.focus();
  const selection = window.getSelection();
  if (!selection) {
    return;
  }

  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

function insertPlainTextAtSelection(container: HTMLElement, text: string) {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return false;
  }

  const range = selection.getRangeAt(0);
  const ancestor = range.commonAncestorContainer;
  if (ancestor !== container && !container.contains(ancestor)) {
    return false;
  }

  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.setEndAfter(node);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

export type InputBoxSubmitOptions = {
  additionalKwargs?: Record<string, unknown>;
  additionalInputMessages?: Message[];
  onSent?: () => void;
};

type VoiceRecognitionStartOptions = {
  focusAfterStart?: boolean;
};

export function InputBox({
  className,
  disabled,
  autoFocus,
  status = "ready",
  context,
  extraHeader,
  leadingActions,
  activeSkillName,
  onClearActiveSkill,
  isWelcomeMode,
  threadId,
  draftThreadId = threadId,
  draftAgentName,
  initialValue,
  onContextChange,
  onGoalChange,
  onSubmit,
  onStop,
  ...props
}: Omit<ComponentProps<typeof PromptInput>, "onSubmit"> & {
  assistantId?: string | null;
  status?: ChatStatus;
  disabled?: boolean;
  context: Omit<
    AgentThreadContext,
    "thread_id" | "is_plan_mode" | "thinking_enabled" | "subagent_enabled"
  > & {
    mode: "flash" | "thinking" | "pro" | "ultra" | undefined;
    reasoning_effort?: "minimal" | "low" | "medium" | "high";
  };
  extraHeader?: React.ReactNode;
  /** Extra buttons rendered at the left of the composer toolbar. */
  leadingActions?: ReactNode;
  /** Skill selected from the Lead Agent skill menu and active for this thread. */
  activeSkillName?: string | null;
  onClearActiveSkill?: () => void;
  /**
   * Whether to render the input in welcome layout (vertically centered,
   * with hero + quick action suggestions).  This is purely a visual flag,
   * decoupled from "the backend has created the thread" —see issue #2746.
   */
  isWelcomeMode?: boolean;
  threadId: string;
  draftThreadId?: string;
  draftAgentName?: string | null;
  initialValue?: string;
  onContextChange?: (
    context: Omit<
      AgentThreadContext,
      "thread_id" | "is_plan_mode" | "thinking_enabled" | "subagent_enabled"
    > & {
      mode: "flash" | "thinking" | "pro" | "ultra" | undefined;
      reasoning_effort?: "minimal" | "low" | "medium" | "high";
    },
  ) => void;
  onGoalChange?: (goal: GoalState | null) => void;
  onSubmit?: (
    message: PromptInputMessage,
    options?: InputBoxSubmitOptions,
  ) => void | Promise<void>;
  onStop?: () => void;
}) {
  const { locale, t } = useI18n();
  const queryClient = useQueryClient();
  const [modelDialogOpen, setModelDialogOpen] = useState(false);
  const { models } = useModels();
  const { data: modelProfiles = [] } = useModelProfiles();
  const { user } = useAuth();
  const { thread } = useThread();
  const { attachments, textInput } = usePromptInputController();
  const setTextInput = textInput.setInput;
  const attachmentParts = attachments.files;
  const removeAttachment = attachments.remove;
  const { skills, isLoading: skillsLoading } = useSkills();
  const { data: uploadLimits } = useUploadLimits(threadId);
  const promptRootRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const inlineSkillTextRef = useRef<HTMLSpanElement | null>(null);
  const inlineSkillComposingRef = useRef(false);
  const goalRequestStateRef = useRef(createGoalRequestState());
  const compactRequestStateRef = useRef(createGoalRequestState());
  const voiceRecognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const voiceBaseTextRef = useRef("");
  const voiceLatestTextRef = useRef("");
  const voiceLastErrorKindRef = useRef<SpeechRecognitionErrorKind | null>(null);
  const voiceStopRequestedRef = useRef(false);
  const voiceRestartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const startVoiceRecognitionRef = useRef<
    ((options?: VoiceRecognitionStartOptions) => boolean) | null
  >(null);
  const promptHistoryIndexRef = useRef<number | null>(null);
  const promptHistoryDraftRef = useRef("");
  const pendingDraftSubmissionKeyRef = useRef<string | null>(null);
  const latestDraftRef = useRef<{
    key: string;
    draft: { text: string; skillName: string | null };
  } | null>(null);
  const draftSaveTimerRef = useRef<number | null>(null);
  const draftSaveGenerationRef = useRef(0);

  const [voiceListening, setVoiceListening] = useState(false);
  const [textareaFocused, setTextareaFocused] = useState(false);
  const [skillSuggestionIndex, setSkillSuggestionIndex] = useState(0);
  const [selectedSlashSkill, setSelectedSlashSkill] =
    useState<SlashSuggestion | null>(null);
  const [hydratedDraftKey, setHydratedDraftKey] = useState<string | null>(null);
  const [dismissedSkillSuggestionValue, setDismissedSkillSuggestionValue] =
    useState<string | null>(null);

  const clearVoiceRestartTimer = useCallback(() => {
    if (voiceRestartTimerRef.current === null) {
      return;
    }
    clearTimeout(voiceRestartTimerRef.current);
    voiceRestartTimerRef.current = null;
  }, []);

  const cleanupVoiceRecognition = useCallback(
    (
      recognition: BrowserSpeechRecognition | null,
      options: { keepListening?: boolean } = {},
    ) => {
      clearVoiceRestartTimer();
      if (!recognition) {
        if (!options.keepListening) {
          voiceLastErrorKindRef.current = null;
          voiceStopRequestedRef.current = false;
          setVoiceListening(false);
        }
        return;
      }
      recognition.onend = null;
      recognition.onerror = null;
      recognition.onresult = null;
      if (voiceRecognitionRef.current === recognition) {
        voiceRecognitionRef.current = null;
      }
      if (!options.keepListening) {
        voiceLastErrorKindRef.current = null;
        voiceStopRequestedRef.current = false;
        setVoiceListening(false);
      }
    },
    [clearVoiceRestartTimer],
  );

  const abortVoiceInput = useCallback(() => {
    const recognition = voiceRecognitionRef.current;
    voiceStopRequestedRef.current = true;
    if (!recognition) {
      cleanupVoiceRecognition(null);
      return;
    }
    cleanupVoiceRecognition(recognition);
    try {
      recognition.abort();
    } catch {
      // Browser implementations can throw when the recognizer already ended.
    }
  }, [cleanupVoiceRecognition]);

  const builtinSlashCommands = useMemo<SlashSuggestion[]>(
    () => [
      {
        name: "goal",
        description: t.inputBox.goalCommandDescription,
        kind: "builtin",
      },
      {
        name: "compact",
        description: t.inputBox.compactCommandDescription,
        kind: "builtin",
      },
    ],
    [t.inputBox.compactCommandDescription, t.inputBox.goalCommandDescription],
  );

  const reportUploadLimitViolations = useCallback(
    (violations: UploadLimitViolation[]) => {
      for (const violation of violations) {
        if (violation.code === "max_file_size") {
          toast.error(
            t.uploads.filesTooLarge(
              violation.files.map((file) => file.name).join(", "),
              formatUploadSize(violation.limit),
            ),
          );
        } else if (violation.code === "max_files") {
          toast.error(
            t.uploads.tooManyFiles(violation.files.length, violation.limit),
          );
        } else {
          toast.error(
            t.uploads.totalSizeTooLarge(
              violation.files.length,
              formatUploadSize(violation.limit),
            ),
          );
        }
      }
    },
    [t.uploads],
  );

  useEffect(() => {
    if (!uploadLimits) {
      return;
    }

    const attachmentEntries = attachmentParts.flatMap((attachment) =>
      attachment.file instanceof File
        ? [{ id: attachment.id, file: attachment.file }]
        : [],
    );
    const validation = validateUploadLimits(
      [],
      attachmentEntries.map(({ file }) => file),
      uploadLimits,
    );
    if (validation.rejected.length === 0) {
      return;
    }

    const rejected = new Set(validation.rejected);
    for (const entry of attachmentEntries) {
      if (rejected.has(entry.file)) {
        removeAttachment(entry.id);
      }
    }
    reportUploadLimitViolations(validation.violations);
  }, [
    attachmentParts,
    removeAttachment,
    reportUploadLimitViolations,
    uploadLimits,
  ]);

  const availableProfiles = useMemo(
    () =>
      modelProfiles.filter(
        (profile) =>
          profile.enabled &&
          profile.target.available &&
          typeof profile.target.model === "string",
      ),
    [modelProfiles],
  );

  const selectedProfile = useMemo(
    () =>
      availableProfiles.find(
        (profile) => profile.target.model === context.model_name,
      ) ?? availableProfiles[0],
    [availableProfiles, context.model_name],
  );

  const selectedModel = useMemo(() => {
    const modelName = selectedProfile?.target.model ?? context.model_name;
    return models.find((model) => model.name === modelName) ?? models[0];
  }, [context.model_name, models, selectedProfile]);

  const resolvedModelName =
    selectedProfile?.target.model ?? selectedModel?.name;

  useEffect(() => {
    if (availableProfiles.length === 0) {
      if (models.length === 0) {
        return;
      }
      const fallbackModel =
        models.find((model) => model.name === context.model_name) ?? models[0]!;
      const nextMode = fallbackModel.supports_thinking ? "thinking" : "flash";
      if (
        context.model_name === fallbackModel.name &&
        context.mode === nextMode
      ) {
        return;
      }
      onContextChange?.({
        ...context,
        model_name: fallbackModel.name,
        mode: nextMode,
      });
      return;
    }

    const profile =
      availableProfiles.find(
        (candidate) => candidate.target.model === context.model_name,
      ) ?? availableProfiles[0]!;
    const nextMode = profile.target.supports_thinking ? "thinking" : "flash";
    if (
      context.model_name === profile.target.model &&
      context.mode === nextMode
    ) {
      return;
    }
    onContextChange?.({
      ...context,
      model_name: profile.target.model!,
      mode: nextMode,
    });
  }, [availableProfiles, context, models, onContextChange]);

  const draftKey = useMemo(
    () =>
      buildComposerDraftKey({
        userId: user?.id ?? "anonymous",
        agentName:
          draftAgentName ??
          (typeof context.agent_name === "string" ? context.agent_name : null),
        threadId: draftThreadId,
      }),
    [context.agent_name, draftAgentName, draftThreadId, user?.id],
  );
  const enabledSkillNames = useMemo(
    () =>
      new Set(
        skills.filter((skill) => skill.enabled).map((skill) => skill.name),
      ),
    [skills],
  );
  const cancelDraftSaveTimer = useCallback(() => {
    if (draftSaveTimerRef.current === null) {
      return;
    }
    window.clearTimeout(draftSaveTimerRef.current);
    draftSaveTimerRef.current = null;
  }, []);
  const invalidateDraftSaveTimer = useCallback(() => {
    draftSaveGenerationRef.current += 1;
    cancelDraftSaveTimer();
  }, [cancelDraftSaveTimer]);
  const scheduleDraftSave = useCallback(
    (draft: ComposerDraft, key = draftKey) => {
      if (
        !draft.text &&
        !draft.skillName &&
        pendingDraftSubmissionKeyRef.current === key
      ) {
        return null;
      }
      if (draft.text || draft.skillName) {
        pendingDraftSubmissionKeyRef.current = null;
      }

      latestDraftRef.current = { key, draft };
      cancelDraftSaveTimer();
      draftSaveGenerationRef.current += 1;
      const generation = draftSaveGenerationRef.current;
      const timer = window.setTimeout(() => {
        if (
          draftSaveGenerationRef.current !== generation ||
          draftSaveTimerRef.current !== timer
        ) {
          return;
        }
        draftSaveTimerRef.current = null;
        writeComposerDraft(getSessionComposerDraftStorage(), key, draft);
      }, COMPOSER_DRAFT_SAVE_DELAY_MS);
      draftSaveTimerRef.current = timer;
      return timer;
    },
    [cancelDraftSaveTimer, draftKey],
  );
  const flushLatestDraft = useCallback(
    (expectedKey?: string) => {
      const latest = latestDraftRef.current;
      if (!latest || (expectedKey && latest.key !== expectedKey)) {
        return;
      }
      cancelDraftSaveTimer();
      writeComposerDraft(
        getSessionComposerDraftStorage(),
        latest.key,
        latest.draft,
      );
    },
    [cancelDraftSaveTimer],
  );

  const promptHistory = useMemo(() => {
    const history: string[] = [];
    for (const message of thread.messages) {
      if (message.type !== "human") {
        continue;
      }
      const additionalKwargs = message.additional_kwargs;
      if (
        additionalKwargs &&
        typeof additionalKwargs === "object" &&
        Reflect.get(additionalKwargs, "hide_from_ui") === true
      ) {
        continue;
      }
      const text = textOfMessage(message)?.trim();
      if (!text) {
        continue;
      }
      if (history.at(-1) !== text) {
        history.push(text);
      }
    }
    return history;
  }, [thread.messages]);

  useLayoutEffect(() => {
    promptHistoryIndexRef.current = null;
    promptHistoryDraftRef.current = "";
    setTextInput("");
    setSelectedSlashSkill(null);
    setHydratedDraftKey(null);
    pendingDraftSubmissionKeyRef.current = null;
    latestDraftRef.current = null;
    invalidateDraftSaveTimer();
    return () => flushLatestDraft(draftKey);
  }, [draftKey, flushLatestDraft, invalidateDraftSaveTimer, setTextInput]);

  useLayoutEffect(() => {
    const handlePageHide = () => flushLatestDraft();
    window.addEventListener("pagehide", handlePageHide);
    return () => window.removeEventListener("pagehide", handlePageHide);
  }, [flushLatestDraft]);

  useEffect(() => {
    if (skillsLoading || hydratedDraftKey === draftKey) {
      return;
    }

    const savedDraft = readComposerDraft(
      getSessionComposerDraftStorage(),
      draftKey,
    );
    if (!savedDraft) {
      if (!textInput.value && initialValue) {
        setTextInput(initialValue);
      }
      setHydratedDraftKey(draftKey);
      return;
    }

    const resolvedDraft = resolveComposerDraft(savedDraft, enabledSkillNames);
    setTextInput(resolvedDraft.text);
    const restoredSkill = resolvedDraft.skillName
      ? skills.find(
          (skill) => skill.enabled && skill.name === resolvedDraft.skillName,
        )
      : undefined;
    setSelectedSlashSkill(
      restoredSkill
        ? {
            name: restoredSkill.name,
            description: restoredSkill.description,
            kind: "skill",
          }
        : null,
    );
    setHydratedDraftKey(draftKey);
  }, [
    draftKey,
    enabledSkillNames,
    hydratedDraftKey,
    initialValue,
    setTextInput,
    skills,
    skillsLoading,
    textInput.value,
  ]);

  useEffect(() => {
    if (hydratedDraftKey !== draftKey) {
      return;
    }

    const draft: ComposerDraft = {
      text: textInput.value ?? "",
      skillName:
        selectedSlashSkill?.kind === "skill" ? selectedSlashSkill.name : null,
    };
    const timer = scheduleDraftSave(draft, draftKey);
    return () => {
      if (timer === null) {
        return;
      }
      window.clearTimeout(timer);
      if (draftSaveTimerRef.current === timer) {
        draftSaveTimerRef.current = null;
      }
    };
  }, [
    draftKey,
    hydratedDraftKey,
    scheduleDraftSave,
    selectedSlashSkill,
    textInput.value,
  ]);

  useEffect(() => {
    const goalRequestState = goalRequestStateRef.current;
    const compactRequestState = compactRequestStateRef.current;
    return () => {
      abortGoalRequest(goalRequestState);
      abortGoalRequest(compactRequestState);
    };
  }, [threadId]);

  useEffect(() => {
    const currentIndex = promptHistoryIndexRef.current;
    if (currentIndex !== null && currentIndex >= promptHistory.length) {
      promptHistoryIndexRef.current = null;
      promptHistoryDraftRef.current = "";
    }
  }, [promptHistory.length]);

  const handleProfileSelect = useCallback(
    (profileId: string) => {
      if (disabled) {
        return;
      }
      const profile = availableProfiles.find(
        (candidate) => candidate.id === profileId,
      );
      const modelName = profile?.target.model;
      if (!modelName) {
        return;
      }
      onContextChange?.({
        ...context,
        model_name: modelName,
        mode: profile.target.supports_thinking ? "thinking" : "flash",
      });
      setModelDialogOpen(false);
    },
    [availableProfiles, disabled, onContextChange, context],
  );

  const handleGoalCommand = useCallback(
    async (command: GoalCommand): Promise<boolean> => {
      const request = beginGoalRequest(goalRequestStateRef.current, threadId);
      const signal = request.controller.signal;
      try {
        let goal: GoalState | null = null;
        if (command.kind === "status") {
          const response = await fetch(
            `${getBackendBaseURL()}/api/threads/${encodeURIComponent(
              threadId,
            )}/goal`,
            { method: "GET", signal },
          );
          if (!response.ok) {
            throw new Error(await readGoalResponseError(response));
          }
          goal =
            ((await response.json()) as { goal?: GoalState | null }).goal ??
            null;
          if (
            !isCurrentGoalRequest(
              goalRequestStateRef.current,
              request,
              threadId,
            )
          ) {
            return false;
          }
          const objective = goal?.objective;
          toast.info(
            objective !== undefined
              ? // Function replacer so a goal containing `$&`/`$1` isn't
                // interpreted as a replacement pattern.
                t.inputBox.goalActive.replace("{goal}", () => objective)
              : t.inputBox.goalNone,
          );
          onGoalChange?.(goal);
        } else if (command.kind === "clear") {
          const response = await fetch(
            `${getBackendBaseURL()}/api/threads/${encodeURIComponent(
              threadId,
            )}/goal`,
            { method: "DELETE", signal },
          );
          if (!response.ok) {
            throw new Error(await readGoalResponseError(response));
          }
          if (
            !isCurrentGoalRequest(
              goalRequestStateRef.current,
              request,
              threadId,
            )
          ) {
            return false;
          }
          toast.success(t.inputBox.goalCleared);
          onGoalChange?.(null);
        } else {
          const response = await fetch(
            `${getBackendBaseURL()}/api/threads/${encodeURIComponent(
              threadId,
            )}/goal`,
            {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ objective: command.objective }),
              signal,
            },
          );
          if (!response.ok) {
            throw new Error(await readGoalResponseError(response));
          }
          goal =
            ((await response.json()) as { goal?: GoalState | null }).goal ??
            null;
          if (
            !isCurrentGoalRequest(
              goalRequestStateRef.current,
              request,
              threadId,
            )
          ) {
            return false;
          }
          toast.success(t.inputBox.goalSet);
          onGoalChange?.(goal);
        }
        textInput.setInput("");
        return true;
      } catch (error) {
        if (
          isAbortError(error) ||
          !isCurrentGoalRequest(goalRequestStateRef.current, request, threadId)
        ) {
          return false;
        }
        toast.error(
          error instanceof Error ? error.message : t.inputBox.goalFailed,
        );
        return false;
      } finally {
        finishGoalRequest(goalRequestStateRef.current, request);
      }
    },
    [
      onGoalChange,
      t.inputBox.goalActive,
      t.inputBox.goalCleared,
      t.inputBox.goalFailed,
      t.inputBox.goalNone,
      t.inputBox.goalSet,
      textInput,
      threadId,
    ],
  );

  const handleCompactCommand = useCallback(async (): Promise<void> => {
    if (isWelcomeMode) {
      textInput.setInput("");
      toast.info(t.inputBox.compactSkipped);
      return;
    }
    const request = beginGoalRequest(compactRequestStateRef.current, threadId);
    const signal = request.controller.signal;
    try {
      const result = await compactThreadContext(threadId, {
        signal,
        agentName:
          typeof context.agent_name === "string" ? context.agent_name : null,
        modelName:
          typeof context.model_name === "string" ? context.model_name : null,
      });
      if (
        !isCurrentGoalRequest(compactRequestStateRef.current, request, threadId)
      ) {
        return;
      }
      textInput.setInput("");
      promptHistoryIndexRef.current = null;
      promptHistoryDraftRef.current = "";

      void queryClient.invalidateQueries({ queryKey: ["thread", threadId] });
      void queryClient.invalidateQueries({
        queryKey: threadTokenUsageQueryKey(threadId),
      });

      if (result.compacted) {
        toast.success(t.inputBox.compactSuccess);
      } else {
        toast.info(t.inputBox.compactSkipped);
      }
    } catch (error) {
      if (
        isAbortError(error) ||
        !isCurrentGoalRequest(compactRequestStateRef.current, request, threadId)
      ) {
        return;
      }
      toast.error(
        error instanceof Error ? error.message : t.inputBox.compactFailed,
      );
    } finally {
      finishGoalRequest(compactRequestStateRef.current, request);
    }
  }, [
    context.agent_name,
    context.model_name,
    queryClient,
    t.inputBox.compactFailed,
    t.inputBox.compactSkipped,
    t.inputBox.compactSuccess,
    isWelcomeMode,
    textInput,
    threadId,
  ]);

  const submitThreadMessage = useCallback(
    (message: PromptInputMessage) => {
      const files = message.files.flatMap((file) =>
        file.file instanceof File ? [file.file] : [],
      );
      const uploadValidation = validateUploadLimits([], files, uploadLimits);
      if (uploadValidation.violations.length > 0) {
        reportUploadLimitViolations(uploadValidation.violations);
        return Promise.reject(new Error("Attachment limits exceeded."));
      }
      const placeholder = findSuggestionTemplatePlaceholder(message.text);
      if (placeholder) {
        toast.warning(t.inputBox.suggestionPlaceholderRequired);
        requestAnimationFrame(() => {
          const textarea = textareaRef.current;
          if (!textarea) {
            return;
          }
          textarea.focus();
          textarea.setSelectionRange(placeholder.start, placeholder.end);
        });
        return Promise.reject(
          new Error("Suggestion template placeholder is unresolved."),
        );
      }
      promptHistoryIndexRef.current = null;
      promptHistoryDraftRef.current = "";
      pendingDraftSubmissionKeyRef.current = draftKey;
      const submitOptions: InputBoxSubmitOptions = {
        // Clear one-time state only once the send genuinely proceeds. If the
        // send is dropped by the in-flight guard, `onSent` never fires.
        onSent: () => {
          if (pendingDraftSubmissionKeyRef.current === draftKey) {
            pendingDraftSubmissionKeyRef.current = null;
            latestDraftRef.current = null;
            invalidateDraftSaveTimer();
            clearComposerDraft(getSessionComposerDraftStorage(), draftKey);
          }
        },
      };
      const submit = () => onSubmit?.(message, submitOptions);

      // Guard against submitting before the initial model auto-selection
      // effect has flushed thread settings to storage/state.
      if (resolvedModelName && context.model_name !== resolvedModelName) {
        onContextChange?.({
          ...context,
          model_name: resolvedModelName,
          mode:
            (selectedProfile?.target.supports_thinking ??
            selectedModel?.supports_thinking)
              ? "thinking"
              : "flash",
        });
        return new Promise<void>((resolve, reject) => {
          setTimeout(() => {
            Promise.resolve(submit()).then(resolve).catch(reject);
          }, 0);
        });
      }

      return submit();
    },
    [
      context,
      draftKey,
      invalidateDraftSaveTimer,
      onContextChange,
      onSubmit,
      reportUploadLimitViolations,
      resolvedModelName,
      selectedModel?.supports_thinking,
      selectedProfile?.target.supports_thinking,
      t.inputBox.suggestionPlaceholderRequired,
      uploadLimits,
    ],
  );

  const handleStopStreaming = useCallback(() => {
    onStop?.();
  }, [onStop]);

  const handleSubmit = useCallback(
    async (message: PromptInputMessage) => {
      if (status === "streaming") {
        toast.info(t.inputBox.pleaseWaitStreaming);
        return Promise.reject(new Error("streaming"));
      }
      abortVoiceInput();
      const messageWithSlashSkill = selectedSlashSkill
        ? {
            ...message,
            text: `/${selectedSlashSkill.name} ${message.text}`,
          }
        : message;
      const submitAction = getInputSubmitAction({
        text: messageWithSlashSkill.text,
        fileCount: messageWithSlashSkill.files.length,
        status,
      });
      if (submitAction.kind === "goal") {
        if (
          submitAction.command.kind === "set" &&
          isGoalObjectiveTooLong(submitAction.command.objective)
        ) {
          toast.error(
            t.inputBox.goalTooLong.replace("{max}", () =>
              String(MAX_GOAL_OBJECTIVE_CHARS),
            ),
          );
          // Reject so the composer keeps the user's text for editing instead of
          // clearing it (PromptInput only preserves input on a rejected submit).
          return Promise.reject(new Error("goal-too-long"));
        }
        promptHistoryIndexRef.current = null;
        promptHistoryDraftRef.current = "";
        const saved = await handleGoalCommand(submitAction.command);
        // Only start a run when a goal was actually saved; status/clear never run.
        if (saved && submitAction.command.kind === "set") {
          return submitThreadMessage({
            ...message,
            text: submitAction.command.objective,
            files: [],
          });
        }
        return;
      }
      if (submitAction.kind === "compact") {
        return handleCompactCommand();
      }
      if (submitAction.kind === "stop") {
        handleStopStreaming();
        return;
      }
      if (submitAction.kind === "empty") {
        return;
      }
      await submitThreadMessage(messageWithSlashSkill);
      if (selectedSlashSkill) {
        setSelectedSlashSkill(null);
      }
    },
    [
      abortVoiceInput,
      handleCompactCommand,
      handleGoalCommand,
      handleStopStreaming,
      selectedSlashSkill,
      status,
      submitThreadMessage,
      t.inputBox.goalTooLong,
      t.inputBox.pleaseWaitStreaming,
    ],
  );

  const slashSkillQuery = useMemo(
    () => getLeadingSlashSkillQuery(textInput.value ?? ""),
    [textInput.value],
  );
  const goalObjectiveCounter = useMemo(
    () => getGoalObjectiveCounter(textInput.value ?? ""),
    [textInput.value],
  );
  const skillSuggestions = useMemo(() => {
    if (slashSkillQuery === null) {
      return [];
    }
    const matches = getMatchingSkillSuggestions(
      skills,
      slashSkillQuery,
      builtinSlashCommands,
    );
    // Builtin commands own the whole composer line, so they cannot be combined
    // with a skill activation: `/goal` behind a selected skill would submit as
    // chat text instead of running the command. Drop them from the result
    // rather than withholding them from the helper, which needs the list to
    // reserve their names —a skill named after a builtin is unusable for the
    // mirrored reason, its submitted text runs the command, not the skill.
    return selectedSlashSkill
      ? matches.filter(({ kind }) => kind === "skill")
      : matches;
  }, [builtinSlashCommands, selectedSlashSkill, skills, slashSkillQuery]);
  // A selected skill does not close the catalog: `/` reopens it so a skill can
  // be found by browsing and swapped without first clearing the chip.
  const showSkillSuggestions =
    !disabled &&
    textareaFocused &&
    slashSkillQuery !== null &&
    skillSuggestions.length > 0 &&
    dismissedSkillSuggestionValue !== textInput.value;
  const isComposerDisabled = disabled === true;
  const composerLocked = isComposerDisabled;
  const speechRecognitionConstructor = useMemo(
    () =>
      typeof window === "undefined"
        ? null
        : getSpeechRecognitionConstructor(window),
    [],
  );
  const voiceInputSupported = speechRecognitionConstructor !== null;

  const getVoiceInputErrorMessage = useCallback(
    (kind: SpeechRecognitionErrorKind) => {
      switch (kind) {
        case "permission_denied":
          return t.inputBox.voiceInputPermissionDenied;
        case "microphone_unavailable":
          return t.inputBox.voiceInputMicrophoneUnavailable;
        case "unsupported_language":
          return t.inputBox.voiceInputUnsupportedLanguage;
        case "network":
          return t.inputBox.voiceInputNetworkError;
        case "no_speech":
          return t.inputBox.voiceInputNoSpeech;
        case "cancelled":
          return null;
        default:
          return t.inputBox.voiceInputFailed;
      }
    },
    [t],
  );

  const startVoiceRecognition = useCallback(
    (options: VoiceRecognitionStartOptions = {}) => {
      if (composerLocked || !speechRecognitionConstructor) {
        return false;
      }

      const recognition = new speechRecognitionConstructor();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = getSpeechRecognitionLanguage(locale);
      recognition.maxAlternatives = 1;
      voiceLastErrorKindRef.current = null;
      voiceLatestTextRef.current = voiceBaseTextRef.current;
      voiceRecognitionRef.current = recognition;

      recognition.onresult = (event) => {
        if (voiceRecognitionRef.current !== recognition) {
          return;
        }
        const transcript = readSpeechRecognitionTranscript(event.results).text;
        const nextValue = appendSpeechTranscript(
          voiceBaseTextRef.current,
          transcript,
        );
        voiceLatestTextRef.current = nextValue;
        textInput.setInput(nextValue);
      };
      recognition.onerror = (event) => {
        const errorKind = mapSpeechRecognitionError(event.error);
        voiceLastErrorKindRef.current = errorKind;
        if (
          !voiceStopRequestedRef.current &&
          shouldRestartSpeechRecognition(errorKind)
        ) {
          return;
        }

        const message = getVoiceInputErrorMessage(errorKind);
        if (message) {
          toast.error(message);
        }
      };
      recognition.onend = () => {
        const shouldRestart =
          voiceRecognitionRef.current === recognition &&
          !voiceStopRequestedRef.current &&
          shouldRestartSpeechRecognition(voiceLastErrorKindRef.current);
        if (shouldRestart) {
          voiceBaseTextRef.current = voiceLatestTextRef.current;
          cleanupVoiceRecognition(recognition, { keepListening: true });
          voiceRestartTimerRef.current = setTimeout(() => {
            voiceRestartTimerRef.current = null;
            if (voiceStopRequestedRef.current) {
              cleanupVoiceRecognition(null);
              return;
            }
            const restarted = startVoiceRecognitionRef.current?.() ?? false;
            if (!restarted) {
              cleanupVoiceRecognition(null);
            }
          }, 150);
          return;
        }
        cleanupVoiceRecognition(recognition);
      };

      setVoiceListening(true);
      try {
        recognition.start();
        if (options.focusAfterStart) {
          requestAnimationFrame(() => {
            if (selectedSlashSkill) {
              focusContentEditableEnd(inlineSkillTextRef.current);
            } else {
              textareaRef.current?.focus();
            }
          });
        }
        return true;
      } catch {
        cleanupVoiceRecognition(recognition);
        toast.error(t.inputBox.voiceInputFailed);
        return false;
      }
    },
    [
      cleanupVoiceRecognition,
      composerLocked,
      getVoiceInputErrorMessage,
      locale,
      selectedSlashSkill,
      speechRecognitionConstructor,
      t.inputBox.voiceInputFailed,
      textInput,
    ],
  );

  useEffect(() => {
    startVoiceRecognitionRef.current = startVoiceRecognition;
  }, [startVoiceRecognition]);

  const stopVoiceInput = useCallback(() => {
    const recognition = voiceRecognitionRef.current;
    voiceStopRequestedRef.current = true;
    if (!recognition) {
      cleanupVoiceRecognition(null);
      return;
    }
    try {
      recognition.stop();
    } catch {
      cleanupVoiceRecognition(recognition);
    }
  }, [cleanupVoiceRecognition]);

  const toggleVoiceInput = useCallback(() => {
    if (voiceListening) {
      stopVoiceInput();
      return;
    }
    if (composerLocked) {
      return;
    }
    if (!speechRecognitionConstructor) {
      toast.error(t.inputBox.voiceInputUnsupported);
      return;
    }

    promptHistoryIndexRef.current = null;
    promptHistoryDraftRef.current = "";
    voiceStopRequestedRef.current = false;
    voiceBaseTextRef.current = textInput.value ?? "";
    voiceLatestTextRef.current = voiceBaseTextRef.current;
    startVoiceRecognition({ focusAfterStart: true });
  }, [
    composerLocked,
    speechRecognitionConstructor,
    startVoiceRecognition,
    stopVoiceInput,
    t.inputBox.voiceInputUnsupported,
    textInput,
    voiceListening,
  ]);

  useEffect(() => {
    if (composerLocked && voiceListening) {
      stopVoiceInput();
    }
  }, [composerLocked, stopVoiceInput, voiceListening]);

  useEffect(() => {
    return () => abortVoiceInput();
  }, [abortVoiceInput, threadId]);

  useEffect(() => {
    setSkillSuggestionIndex(0);
  }, [slashSkillQuery, skillSuggestions.length]);

  const applySkillSuggestion = useCallback(
    (suggestion: SlashSuggestion) => {
      if (suggestion.kind === "skill") {
        setSelectedSlashSkill(suggestion);
        textInput.setInput("");
        setDismissedSkillSuggestionValue(null);
        requestAnimationFrame(() => {
          focusContentEditableEnd(inlineSkillTextRef.current);
        });
        return;
      }

      const nextValue = `/${suggestion.name} `;
      textInput.setInput(nextValue);
      setDismissedSkillSuggestionValue(nextValue);
      requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        if (!textarea) {
          return;
        }
        textarea.focus();
        textarea.setSelectionRange(nextValue.length, nextValue.length);
      });
    },
    [textInput],
  );

  const handleSkillSuggestionKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (!showSkillSuggestions) {
        return;
      }

      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSkillSuggestionIndex(
          (index) => (index + 1) % skillSuggestions.length,
        );
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSkillSuggestionIndex(
          (index) =>
            (index - 1 + skillSuggestions.length) % skillSuggestions.length,
        );
        return;
      }

      if (event.key === "Enter" || event.key === "Tab") {
        if (event.shiftKey) {
          return;
        }
        event.preventDefault();
        const selectedSkill = skillSuggestions[skillSuggestionIndex];
        if (selectedSkill) {
          applySkillSuggestion(selectedSkill);
        }
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        setDismissedSkillSuggestionValue(textInput.value);
      }
    },
    [
      applySkillSuggestion,
      showSkillSuggestions,
      skillSuggestionIndex,
      skillSuggestions,
      textInput.value,
    ],
  );

  const setPromptHistoryValue = useCallback(
    (value: string) => {
      textInput.setInput(value);
      requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        if (!textarea) {
          return;
        }
        textarea.focus();
        textarea.setSelectionRange(value.length, value.length);
      });
    },
    [textInput],
  );

  const handlePromptHistoryKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        isIMEComposing(event) ||
        selectedSlashSkill ||
        promptHistory.length === 0 ||
        (event.key !== "ArrowUp" && event.key !== "ArrowDown")
      ) {
        return;
      }

      const currentValue = textInput.value ?? "";
      const currentHistoryIndex = promptHistoryIndexRef.current;
      const isBrowsingHistory = currentHistoryIndex !== null;

      if (!isBrowsingHistory && currentValue.length > 0) {
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        const nextIndex = isBrowsingHistory
          ? Math.max(currentHistoryIndex - 1, 0)
          : promptHistory.length - 1;
        if (!isBrowsingHistory) {
          promptHistoryDraftRef.current = currentValue;
        }
        promptHistoryIndexRef.current = nextIndex;
        setPromptHistoryValue(promptHistory[nextIndex] ?? "");
        return;
      }

      if (!isBrowsingHistory) {
        return;
      }

      event.preventDefault();
      if (currentHistoryIndex >= promptHistory.length - 1) {
        promptHistoryIndexRef.current = null;
        setPromptHistoryValue(promptHistoryDraftRef.current);
        promptHistoryDraftRef.current = "";
        return;
      }

      const nextIndex = currentHistoryIndex + 1;
      promptHistoryIndexRef.current = nextIndex;
      setPromptHistoryValue(promptHistory[nextIndex] ?? "");
    },
    [promptHistory, selectedSlashSkill, setPromptHistoryValue, textInput.value],
  );

  const handleSelectedSlashSkillKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (
        event.key !== "Backspace" ||
        !selectedSlashSkill ||
        textInput.value.length > 0 ||
        isIMEComposing(event)
      ) {
        return;
      }

      event.preventDefault();
      setSelectedSlashSkill(null);
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
      });
    },
    [selectedSlashSkill, textInput.value],
  );

  const handlePromptTextareaKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      handleSkillSuggestionKeyDown(event);
      if (event.defaultPrevented) {
        return;
      }
      handleSelectedSlashSkillKeyDown(event);
      if (event.defaultPrevented) {
        return;
      }
      handlePromptHistoryKeyDown(event);
    },
    [
      handlePromptHistoryKeyDown,
      handleSelectedSlashSkillKeyDown,
      handleSkillSuggestionKeyDown,
    ],
  );

  const handlePromptTextareaChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      if (voiceListening) {
        abortVoiceInput();
      }
      promptHistoryIndexRef.current = null;
      promptHistoryDraftRef.current = "";
      scheduleDraftSave({
        text: event.currentTarget.value,
        skillName:
          selectedSlashSkill?.kind === "skill" ? selectedSlashSkill.name : null,
      });
    },
    [abortVoiceInput, scheduleDraftSave, selectedSlashSkill, voiceListening],
  );

  const updateInlineSkillTextInput = useCallback(
    (element: HTMLElement) => {
      if (voiceListening) {
        abortVoiceInput();
      }
      promptHistoryIndexRef.current = null;
      promptHistoryDraftRef.current = "";
      const nextText = element.textContent ?? "";
      textInput.setInput(nextText);
      scheduleDraftSave({
        text: nextText,
        skillName:
          selectedSlashSkill?.kind === "skill" ? selectedSlashSkill.name : null,
      });
    },
    [
      abortVoiceInput,
      scheduleDraftSave,
      selectedSlashSkill,
      textInput,
      voiceListening,
    ],
  );

  useEffect(() => {
    if (!selectedSlashSkill) {
      return;
    }

    const element = inlineSkillTextRef.current;
    if (element && element.textContent !== textInput.value) {
      element.textContent = textInput.value;
    }
  }, [selectedSlashSkill, textInput.value]);

  const handleInlineSkillInput = useCallback(
    (event: FormEvent<HTMLSpanElement>) => {
      updateInlineSkillTextInput(event.currentTarget);
    },
    [updateInlineSkillTextInput],
  );

  const handleInlineSkillPaste = useCallback(
    (event: ClipboardEvent<HTMLSpanElement>) => {
      const pastedFiles = Array.from(event.clipboardData.items)
        .filter((item) => item.kind === "file")
        .flatMap((item) => {
          const file = item.getAsFile();
          return file ? [file] : [];
        });

      if (pastedFiles.length > 0) {
        event.preventDefault();
        const { accepted, message } = splitUnsupportedUploadFiles(pastedFiles);
        if (message) {
          toast.error(message);
        }
        if (accepted.length > 0) {
          attachments.add(accepted);
        }
        return;
      }

      const text = event.clipboardData.getData("text/plain");
      if (!text) {
        return;
      }

      event.preventDefault();
      if (insertPlainTextAtSelection(event.currentTarget, text)) {
        updateInlineSkillTextInput(event.currentTarget);
      }
    },
    [attachments, updateInlineSkillTextInput],
  );

  const handleInlineSkillKeyDown = useCallback(
    (event: KeyboardEvent<HTMLSpanElement>) => {
      // The catalog can be reopened from here, so its navigation keys must win
      // over Enter-to-submit. Skip it mid-composition, where Enter belongs to
      // the IME candidate rather than the list.
      if (!isIMEComposing(event, inlineSkillComposingRef.current)) {
        handleSkillSuggestionKeyDown(event);
        if (event.defaultPrevented) {
          return;
        }
      }

      handleSelectedSlashSkillKeyDown(event);
      if (event.defaultPrevented) {
        return;
      }

      if (event.key !== "Enter") {
        return;
      }

      if (isIMEComposing(event, inlineSkillComposingRef.current)) {
        return;
      }

      event.preventDefault();

      if (event.shiftKey) {
        if (insertPlainTextAtSelection(event.currentTarget, "\n")) {
          updateInlineSkillTextInput(event.currentTarget);
        }
        return;
      }

      event.currentTarget.closest("form")?.requestSubmit();
    },
    [
      handleSelectedSlashSkillKeyDown,
      handleSkillSuggestionKeyDown,
      updateInlineSkillTextInput,
    ],
  );

  const clearSelectedSlashSkill = useCallback(() => {
    setSelectedSlashSkill(null);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
  }, []);

  return (
    <div
      ref={promptRootRef}
      className={cn(
        "relative flex min-w-0 flex-col",
        isWelcomeMode ? "gap-4" : "gap-2",
      )}
    >
      {showSkillSuggestions && (
        <div className="absolute right-0 bottom-full left-0 z-40 mb-2 px-1">
          <div
            aria-label="Skill suggestions"
            className="bg-popover/95 text-popover-foreground border-border max-h-72 overflow-y-auto rounded-xl border p-1 shadow-lg backdrop-blur-sm"
            role="listbox"
          >
            {skillSuggestions.map((suggestion, index) => {
              const selected = index === skillSuggestionIndex;
              return (
                <button
                  aria-selected={selected}
                  className={cn(
                    "flex min-h-12 w-full min-w-0 cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors",
                    selected
                      ? "bg-accent text-accent-foreground"
                      : "text-popover-foreground hover:bg-accent/70 hover:text-accent-foreground",
                  )}
                  key={`${suggestion.kind}:${suggestion.name}`}
                  onClick={() => applySkillSuggestion(suggestion)}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setSkillSuggestionIndex(index)}
                  role="option"
                  type="button"
                >
                  {suggestion.kind === "builtin" ? (
                    <TargetIcon className="text-muted-foreground size-4 shrink-0" />
                  ) : (
                    <SparklesIcon className="text-muted-foreground size-4 shrink-0" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      /{suggestion.name}
                    </span>
                    {suggestion.description && (
                      <span className="text-muted-foreground block truncate text-xs">
                        {suggestion.description}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
      <PromptInput
        className={cn(
          "bg-background/85 relative z-10 rounded-2xl backdrop-blur-sm transition-all duration-300 ease-out *:data-[slot='input-group']:rounded-2xl",
          className,
        )}
        disabled={composerLocked}
        globalDrop
        multiple
        onSubmit={handleSubmit}
        {...props}
      >
        {extraHeader && (
          <div className="absolute top-0 right-0 left-0 z-10">
            <div className="absolute right-0 bottom-0 left-0 flex items-center justify-center">
              {extraHeader}
            </div>
          </div>
        )}
        <PromptInputHeader className="flex-wrap px-3 pt-3 pb-0 empty:hidden">
          {activeSkillName && (
            <button
              type="button"
              onClick={onClearActiveSkill}
              className="border-primary/20 bg-primary/10 text-primary mr-2 inline-flex h-6 max-w-full items-center gap-1 rounded-md border px-1.5 font-mono text-xs leading-none font-medium"
              title={t.leadAgent.clearSkill}
              data-testid="lead-agent-active-skill"
            >
              <BookOpenIcon className="size-3" />
              <span className="min-w-0 truncate">{activeSkillName}</span>
              <XIcon className="text-primary/70 size-2.5 shrink-0" />
            </button>
          )}
          <PromptInputAttachments className="contents p-0">
            {(attachment) => (
              <div className="max-w-60">
                <PromptInputAttachment data={attachment} />
              </div>
            )}
          </PromptInputAttachments>
        </PromptInputHeader>
        <div className="min-h-16 w-full min-w-0 px-3 py-3">
          {selectedSlashSkill ? (
            <div
              className="max-h-48 min-h-6 w-full min-w-0 cursor-text overflow-y-auto text-base leading-6 break-all whitespace-pre-wrap md:text-sm"
              onClick={(event) => {
                if (event.target === event.currentTarget) {
                  focusContentEditableEnd(inlineSkillTextRef.current);
                }
              }}
            >
              <SlashSkillChip
                name={selectedSlashSkill.name}
                className="mr-2 max-w-[min(11rem,45%)] align-top"
                onRemove={clearSelectedSlashSkill}
              />
              <span
                aria-label={t.inputBox.placeholder}
                aria-multiline="true"
                contentEditable={!composerLocked}
                data-empty={textInput.value.length === 0}
                data-placeholder={t.inputBox.placeholder}
                data-slot="input-group-control"
                onBlur={() => setTextareaFocused(false)}
                onCompositionEnd={() => {
                  inlineSkillComposingRef.current = false;
                }}
                onCompositionStart={() => {
                  inlineSkillComposingRef.current = true;
                }}
                onFocus={() => setTextareaFocused(true)}
                onInput={handleInlineSkillInput}
                onKeyDown={handleInlineSkillKeyDown}
                onPaste={handleInlineSkillPaste}
                aria-placeholder={t.inputBox.placeholder}
                ref={inlineSkillTextRef}
                role="textbox"
                suppressContentEditableWarning
                className={cn(
                  "outline-none",
                  "before:text-muted-foreground before:pointer-events-none",
                  "data-[empty=true]:before:content-[attr(data-placeholder)]",
                  composerLocked && "cursor-not-allowed opacity-50",
                )}
                tabIndex={composerLocked ? -1 : 0}
              />
            </div>
          ) : (
            <PromptInputTextarea
              className="min-h-6! w-full min-w-0 p-0! leading-6!"
              disabled={composerLocked}
              placeholder={t.inputBox.placeholder}
              autoFocus={autoFocus}
              defaultValue={initialValue}
              onBlur={() => setTextareaFocused(false)}
              onChange={handlePromptTextareaChange}
              onFocus={() => setTextareaFocused(true)}
              onKeyDown={handlePromptTextareaKeyDown}
              ref={textareaRef}
            />
          )}
        </div>
        <PromptInputFooter className="flex flex-wrap gap-2 sm:flex-nowrap">
          <PromptInputTools className="min-w-0 flex-1 flex-wrap">
            {leadingActions}
            {/* TODO: Add more connectors here
          <PromptInputActionMenu>
            <PromptInputActionMenuTrigger className="px-2!" />
            <PromptInputActionMenuContent>
              <PromptInputActionAddAttachments
                label={t.inputBox.addAttachments}
              />
            </PromptInputActionMenuContent>
          </PromptInputActionMenu> */}
            <AddAttachmentsButton
              className="px-2!"
              disabled={composerLocked}
              uploadLimits={uploadLimits}
            />
            <VoiceInputButton
              disabled={composerLocked}
              listening={voiceListening}
              supported={voiceInputSupported}
              onToggle={toggleVoiceInput}
            />
          </PromptInputTools>
          <PromptInputTools className="min-w-0 justify-end">
            {goalObjectiveCounter && (
              <span
                aria-label={t.inputBox.goalLengthCounter
                  .replace("{length}", () =>
                    String(goalObjectiveCounter.length),
                  )
                  .replace("{max}", () => String(goalObjectiveCounter.max))}
                className={cn(
                  "shrink-0 text-xs tabular-nums",
                  goalObjectiveCounter.overLimit
                    ? "text-destructive font-medium"
                    : "text-muted-foreground",
                )}
                data-testid="goal-length-counter"
              >
                {goalObjectiveCounter.length}/{goalObjectiveCounter.max}
              </span>
            )}
            {availableProfiles.length > 0 ? (
              <ModelSelector
                open={modelDialogOpen}
                onOpenChange={setModelDialogOpen}
              >
                <ModelSelectorTrigger asChild>
                  <PromptInputButton
                    className="max-w-40 min-w-0 sm:max-w-56"
                    disabled={composerLocked}
                  >
                    <div className="flex min-w-0 flex-col items-start text-left">
                      <ModelSelectorName className="text-xs font-normal">
                        {selectedProfile?.display_name ??
                          selectedModel?.display_name}
                      </ModelSelectorName>
                      <span className="text-muted-foreground truncate text-[10px]">
                        {selectedProfile?.target.display_name ??
                          selectedProfile?.target.model}
                      </span>
                    </div>
                  </PromptInputButton>
                </ModelSelectorTrigger>
                <ModelSelectorContent>
                  <ModelSelectorInput placeholder={t.inputBox.searchModels} />
                  <ModelSelectorList>
                    {availableProfiles.map((profile) => (
                      <ModelSelectorItem
                        key={profile.id}
                        value={profile.id}
                        onSelect={() => handleProfileSelect(profile.id)}
                      >
                        <div className="flex min-w-0 flex-1 flex-col">
                          <ModelSelectorName>
                            {profile.display_name}
                          </ModelSelectorName>
                          <span className="text-muted-foreground truncate text-[10px]">
                            {profile.target.display_name ??
                              profile.target.model}
                          </span>
                        </div>
                        {profile.id === selectedProfile?.id ? (
                          <CheckIcon className="ml-auto size-4" />
                        ) : (
                          <div className="ml-auto size-4" />
                        )}
                      </ModelSelectorItem>
                    ))}
                  </ModelSelectorList>
                </ModelSelectorContent>
              </ModelSelector>
            ) : (
              <PromptInputButton
                className="max-w-40 min-w-0 sm:max-w-56"
                disabled
              >
                <ModelSelectorName className="text-xs font-normal">
                  {selectedModel?.display_name}
                </ModelSelectorName>
              </PromptInputButton>
            )}
            <PromptInputSubmit
              className="rounded-full"
              disabled={composerLocked}
              variant="outline"
              status={status}
              onClick={(e) => {
                if (status === "streaming") {
                  e.preventDefault();
                  handleStopStreaming();
                }
              }}
            />
          </PromptInputTools>
        </PromptInputFooter>
      </PromptInput>
      {!isWelcomeMode && (
        <div className="bg-background absolute right-0 -bottom-[17px] left-0 z-0 h-4"></div>
      )}

      <p
        className={cn(
          "text-muted-foreground/67 z-10 px-4 text-center text-xs leading-4",
          !isWelcomeMode && "absolute top-full right-0 left-0",
        )}
      >
        {t.inputBox.disclaimer}
      </p>
    </div>
  );
}

function VoiceInputButton({
  disabled,
  listening,
  supported,
  onToggle,
}: {
  disabled?: boolean;
  listening: boolean;
  supported: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  const tooltipContent = !supported
    ? t.inputBox.voiceInputUnsupported
    : listening
      ? t.inputBox.voiceInputListening
      : t.inputBox.voiceInputStart;
  const label = listening
    ? t.inputBox.voiceInputStopLabel
    : t.inputBox.voiceInputStartLabel;

  return (
    <Tooltip content={<span className="block max-w-72">{tooltipContent}</span>}>
      <PromptInputButton
        aria-label={label}
        aria-pressed={listening}
        className={cn(
          "px-2!",
          listening && "text-primary bg-primary/10 hover:bg-primary/15",
        )}
        data-testid="voice-input-button"
        disabled={(disabled ?? false) || !supported}
        onClick={onToggle}
      >
        {listening ? (
          <SquareIcon className="size-3 fill-current" />
        ) : (
          <MicIcon className="size-3" />
        )}
      </PromptInputButton>
    </Tooltip>
  );
}

function AddAttachmentsButton({
  className,
  disabled,
  uploadLimits,
}: {
  className?: string;
  disabled?: boolean;
  uploadLimits?: UploadLimits;
}) {
  const { t } = useI18n();
  const attachments = usePromptInputAttachments();
  const tooltipContent = uploadLimits
    ? t.uploads.limitsHint(
        uploadLimits.max_files,
        formatUploadSize(uploadLimits.max_file_size),
        formatUploadSize(uploadLimits.max_total_size),
      )
    : t.inputBox.addAttachments;
  return (
    <Tooltip content={<span className="block max-w-80">{tooltipContent}</span>}>
      <PromptInputButton
        aria-label={t.inputBox.addAttachments}
        className={cn("px-2!", className)}
        data-testid="add-attachments-button"
        disabled={disabled}
        onClick={() => attachments.openFileDialog()}
      >
        <PaperclipIcon className="size-3" />
      </PromptInputButton>
    </Tooltip>
  );
}
