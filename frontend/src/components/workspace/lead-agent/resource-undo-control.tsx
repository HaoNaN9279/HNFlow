"use client";

import { HistoryIcon, Loader2Icon, Undo2Icon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tooltip } from "@/components/workspace/tooltip";
import { useI18n } from "@/core/i18n/hooks";
import {
  useUndoWorkspaceResourceChanges,
  useWorkspaceResourceChanges,
  type WorkspaceResourceChange,
} from "@/core/workspace-resources";

function actionLabel(change: WorkspaceResourceChange): string {
  const kind = change.resource_kind.replaceAll("_", " ");
  return `${change.action.replaceAll("_", " ")} ${kind}`;
}

export function ResourceUndoControl({
  threadId,
  disabled,
}: {
  threadId: string;
  disabled?: boolean;
}) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const { data, isLoading } = useWorkspaceResourceChanges(threadId, {
    enabled: !disabled,
  });
  const undo = useUndoWorkspaceResourceChanges(threadId);
  const undoable = data?.undoable;
  const hasHistory = (data?.changes.length ?? 0) > 0;
  const canUndo = Boolean(undoable && undoable.count > 0);

  const handleUndo = async () => {
    try {
      const result = await undo.mutateAsync(undefined);
      toast.success(t.leadAgent.undoSuccess(result.count));
      setOpen(false);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t.leadAgent.undoConflict,
      );
    }
  };

  return (
    <>
      <Tooltip
        content={canUndo ? t.leadAgent.undo : t.leadAgent.undoUnavailable}
      >
        <button
          type="button"
          aria-label={t.leadAgent.undo}
          disabled={disabled === true || (!canUndo && !hasHistory) || isLoading}
          onClick={() => setOpen(true)}
          className="text-muted-foreground hover:text-foreground hover:bg-accent inline-flex size-7 items-center justify-center rounded-md transition-colors disabled:pointer-events-none disabled:opacity-40"
          data-testid="lead-agent-undo"
        >
          {isLoading ? (
            <Loader2Icon className="size-4 animate-spin" />
          ) : (
            <Undo2Icon className="size-4" />
          )}
        </button>
      </Tooltip>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <HistoryIcon className="size-4" />
              {t.leadAgent.undoConfirmTitle}
            </DialogTitle>
            <DialogDescription>
              {t.leadAgent.changeHistoryDescription}
            </DialogDescription>
          </DialogHeader>

          {canUndo && undoable ? (
            <p className="text-muted-foreground text-sm">
              {t.leadAgent.undoConfirmDescription(undoable.count)}
            </p>
          ) : null}

          <div className="max-h-72 overflow-y-auto rounded-md border">
            {hasHistory ? (
              data?.changes.map((change) => (
                <div
                  key={change.id}
                  className="flex items-start justify-between gap-3 border-b px-3 py-2 last:border-b-0"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {change.name}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      {actionLabel(change)}
                    </p>
                  </div>
                  <div className="shrink-0 text-right text-xs">
                    <span
                      className={
                        change.status === "undone"
                          ? "text-muted-foreground"
                          : "text-emerald-600 dark:text-emerald-400"
                      }
                    >
                      {change.status === "undone"
                        ? t.leadAgent.changeUndone
                        : t.leadAgent.changeApplied}
                    </span>
                    <p className="text-muted-foreground mt-0.5">
                      {new Date(change.created_at).toLocaleString(locale)}
                    </p>
                  </div>
                </div>
              ))
            ) : (
              <p className="text-muted-foreground px-3 py-4 text-sm">
                {t.leadAgent.changeHistoryEmpty}
              </p>
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
            >
              {t.common.cancel}
            </Button>
            <Button
              type="button"
              disabled={!canUndo || undo.isPending}
              onClick={() => void handleUndo()}
            >
              {undo.isPending && (
                <Loader2Icon className="mr-2 size-4 animate-spin" />
              )}
              {t.leadAgent.undoAction}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
