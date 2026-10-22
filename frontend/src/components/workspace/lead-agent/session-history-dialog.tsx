"use client";

import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useI18n } from "@/core/i18n/hooks";
import { useInfiniteThreads } from "@/core/threads/hooks";
import { buildThreadListModel } from "@/core/threads/thread-list-model";
import type { AgentThread } from "@/core/threads/types";
import { titleOfThread } from "@/core/threads/utils";
import { formatTimeAgo } from "@/core/utils/datetime";

import { useLeadAgent } from "./lead-agent-context";

function isLeadAgentThread(thread: AgentThread) {
  return !thread.context?.agent_name && !thread.metadata?.agent_name;
}

export function SessionHistoryDialog() {
  const { t } = useI18n();
  const { threadId, historyOpen, closeHistory, openThread } = useLeadAgent();
  const [search, setSearch] = useState("");
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } =
    useInfiniteThreads();

  const threads = useMemo(() => {
    const model = buildThreadListModel(data?.pages ?? []);
    const query = search.trim().toLowerCase();
    return model.threads.filter((thread) => {
      if (!isLeadAgentThread(thread)) {
        return false;
      }
      return (
        query.length === 0 ||
        titleOfThread(thread).toLowerCase().includes(query)
      );
    });
  }, [data?.pages, search]);

  return (
    <Dialog
      open={historyOpen}
      onOpenChange={(open) => {
        if (!open) {
          closeHistory();
        }
      }}
    >
      <DialogContent className="max-h-[70vh] gap-3 sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t.leadAgent.history}</DialogTitle>
          <DialogDescription className="sr-only">
            {t.leadAgent.title}
          </DialogDescription>
        </DialogHeader>
        <Input
          type="search"
          value={search}
          placeholder={t.chats.searchChats}
          onChange={(event) => setSearch(event.target.value)}
          autoFocus
          data-testid="lead-agent-history-search"
        />
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-1 pr-2">
            {isLoading ? (
              <p className="text-muted-foreground p-3 text-sm">
                {t.common.loading}
              </p>
            ) : threads.length === 0 ? (
              <p className="text-muted-foreground p-3 text-sm">
                {t.leadAgent.emptyHistory}
              </p>
            ) : (
              threads.map((thread) => (
                <button
                  key={thread.thread_id}
                  type="button"
                  className="hover:bg-accent focus-visible:bg-accent flex w-full flex-col items-start gap-1 rounded-md border-b px-3 py-2 text-left outline-none"
                  data-active={thread.thread_id === threadId}
                  data-testid="lead-agent-history-item"
                  onClick={() => openThread(thread.thread_id)}
                >
                  <span className="w-full truncate text-sm">
                    {titleOfThread(thread)}
                  </span>
                  {thread.updated_at && (
                    <span className="text-muted-foreground text-xs">
                      {formatTimeAgo(thread.updated_at)}
                    </span>
                  )}
                </button>
              ))
            )}
            {hasNextPage && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="m-2"
                disabled={isFetchingNextPage}
                onClick={() => void fetchNextPage()}
              >
                {isFetchingNextPage
                  ? t.chats.loadingMore
                  : t.chats.loadOlderChats}
              </Button>
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
