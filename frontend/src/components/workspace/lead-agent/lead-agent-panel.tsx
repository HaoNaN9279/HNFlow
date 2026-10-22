"use client";

import { ChevronUpIcon, HistoryIcon, PlusIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/workspace/tooltip";
import { useI18n } from "@/core/i18n/hooks";
import { usePersistedBoolean } from "@/hooks/use-persisted-toggle";
import { useResizablePanel } from "@/hooks/use-resizable-panel";
import { cn } from "@/lib/utils";

import { useLeadAgent } from "./lead-agent-context";
import { LeadAgentConversation } from "./lead-agent-conversation";
import { LeadAgentProviders } from "./lead-agent-providers";
import { SessionHistoryDialog } from "./session-history-dialog";

export function LeadAgentPanel() {
  const { t } = useI18n();
  const { newConversation, openHistory } = useLeadAgent();
  const [collapsed, setCollapsed] = usePersistedBoolean(
    "deerflow.ui.lead-agent.collapsed",
    false,
  );
  const { size, handleProps } = useResizablePanel({
    storageKey: "deerflow.ui.lead-agent.height",
    defaultSize: 340,
    min: 200,
    max: 720,
    axis: "y",
  });

  return (
    <aside
      className="bg-background relative flex shrink-0 flex-col border-t"
      style={{ height: collapsed ? 44 : size }}
      data-testid="lead-agent-panel"
      data-collapsed={collapsed}
    >
      {!collapsed && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label={t.leadAgent.resize}
          tabIndex={0}
          className="hover:bg-primary/30 focus-visible:bg-primary/30 absolute inset-x-0 -top-1 z-20 h-2 cursor-row-resize touch-none focus-visible:outline-none"
          data-testid="lead-agent-resize"
          {...handleProps}
        />
      )}

      {collapsed && (
        <div className="flex h-11 shrink-0 items-center gap-1 px-2">
          <Tooltip content={t.leadAgent.history}>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t.leadAgent.history}
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
              onClick={newConversation}
              data-testid="lead-agent-new"
            >
              <PlusIcon className="size-4" />
            </Button>
          </Tooltip>
          <span className="text-muted-foreground min-w-0 flex-1 truncate px-1 text-xs">
            {t.leadAgent.title}
          </span>
          <Tooltip content={t.leadAgent.expand}>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t.leadAgent.expand}
              onClick={() => setCollapsed(false)}
              data-testid="lead-agent-expand"
            >
              <ChevronUpIcon className="size-4" />
            </Button>
          </Tooltip>
        </div>
      )}

      <div
        className={cn(
          "min-h-0 flex-1",
          collapsed ? "hidden" : "flex flex-col overflow-hidden",
        )}
      >
        <LeadAgentProviders>
          <LeadAgentConversation onCollapse={() => setCollapsed(true)} />
        </LeadAgentProviders>
      </div>

      <SessionHistoryDialog />
    </aside>
  );
}
