"use client";

import { ChevronRightIcon, RefreshCwIcon } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useI18n } from "@/core/i18n/hooks";
import {
  previewWorkflowPrompt,
  type WorkflowPromptComponent,
  type WorkflowPromptPreview,
} from "@/core/workflows/api";

import { useWorkflowEditor } from "./workflow-editor-context";

type PromptLabels = ReturnType<
  typeof useI18n
>["t"]["workflows"]["properties"]["ai"]["promptComposition"];

type AiPromptCompositionProps = {
  nodeId: string;
  active: boolean;
  readonly: boolean;
};

function sourceTitle(
  labels: PromptLabels,
  component: WorkflowPromptComponent,
): string {
  const label = component.label?.trim();
  if (label) {
    return label;
  }
  return (
    labels.sources[component.key as keyof PromptLabels["sources"]] ??
    component.key
  );
}

function stateLabel(labels: PromptLabels, state: string): string | null {
  if (state === "runtime") {
    return labels.states.runtime;
  }
  if (state === "dropped") {
    return labels.states.dropped;
  }
  if (state === "truncated") {
    return labels.states.truncated;
  }
  return null;
}

export function AiPromptComposition({
  nodeId,
  active,
  readonly,
}: AiPromptCompositionProps) {
  const { t } = useI18n();
  const labels = t.workflows.properties.ai.promptComposition;
  const { workflowId, currentDefinition } = useWorkflowEditor();
  const searchParams = useSearchParams();
  const projectId = searchParams?.get("project") ?? undefined;
  const [preview, setPreview] = useState<WorkflowPromptPreview | null>(null);
  const [selected, setSelected] = useState<WorkflowPromptComponent | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const definitionSignature = JSON.stringify({
    nodes: currentDefinition().nodes,
    edges: currentDefinition().edges,
  });

  useEffect(() => {
    if (!active) {
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError(null);
      previewWorkflowPrompt(workflowId, {
        node_id: nodeId,
        definition: currentDefinition(),
        project_id: projectId,
      })
        .then((result) => {
          if (!cancelled) {
            setPreview(result);
          }
        })
        .catch((previewError: unknown) => {
          if (!cancelled) {
            setPreview(null);
            setError(
              previewError instanceof Error
                ? previewError.message
                : String(previewError),
            );
          }
        })
        .finally(() => {
          if (!cancelled) {
            setLoading(false);
          }
        });
    }, 300);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // `definitionSignature` is the stable summary; the callback itself changes
    // with every editor render and is intentionally not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, workflowId, nodeId, definitionSignature, reloadToken]);

  const sources = preview?.components ?? [];

  return (
    <div className="flex flex-col gap-3" data-testid="ai-prompt-composition">
      <div className="flex flex-col gap-1">
        <div className="text-xs font-medium">{labels.title}</div>
        <p className="text-muted-foreground text-[11px]">{labels.hint}</p>
      </div>

      {loading && !preview ? (
        <p className="text-muted-foreground text-xs">{labels.loading}</p>
      ) : error ? (
        <div className="border-destructive/40 bg-destructive/5 flex items-start justify-between gap-2 rounded border p-2">
          <p className="text-destructive text-xs">
            {labels.loadFailed}: {error}
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={readonly}
            onClick={() => setReloadToken((token) => token + 1)}
          >
            <RefreshCwIcon className="size-3" />
            {labels.retry}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {sources.map((component) => {
            const state = stateLabel(labels, component.state);
            return (
              <button
                key={component.key}
                type="button"
                className="bg-card hover:bg-accent/40 flex min-w-0 flex-col gap-1 rounded border p-2 text-left transition-colors"
                onClick={() => setSelected(component)}
                data-testid={`prompt-source-${component.key}`}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="text-xs font-medium">
                    {sourceTitle(labels, component)}
                  </span>
                  <Badge variant="outline" className="text-[10px]">
                    {labels.sections[component.section]}
                  </Badge>
                  {state && (
                    <Badge variant="secondary" className="text-[10px]">
                      {state}
                    </Badge>
                  )}
                  <span className="text-muted-foreground ml-auto shrink-0 text-[10px]">
                    {labels.tokens.replace(
                      "{count}",
                      String(component.estimated_tokens),
                    )}
                  </span>
                  <ChevronRightIcon className="text-muted-foreground size-3.5" />
                </span>
                <span className="text-muted-foreground truncate font-mono text-[10px]">
                  {component.source}
                </span>
                <span className="text-muted-foreground line-clamp-2 text-[11px]">
                  {component.summary}
                </span>
              </button>
            );
          })}
        </div>
      )}

      <Dialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) {
            setSelected(null);
          }
        }}
      >
        <DialogContent className="max-h-[80vh] max-w-3xl overflow-hidden">
          {selected && (
            <>
              <DialogHeader>
                <DialogTitle>{sourceTitle(labels, selected)}</DialogTitle>
                <DialogDescription className="font-mono text-[11px] break-all">
                  {selected.source} 璺?{labels.sections[selected.section]}
                </DialogDescription>
              </DialogHeader>
              <div className="flex items-center gap-1.5">
                <Badge variant="outline" className="text-[10px]">
                  {labels.tokens.replace(
                    "{count}",
                    String(selected.estimated_tokens),
                  )}
                </Badge>
                {stateLabel(labels, selected.state) && (
                  <Badge variant="secondary" className="text-[10px]">
                    {stateLabel(labels, selected.state)}
                  </Badge>
                )}
              </div>
              {selected.content ? (
                <pre
                  className="bg-muted/50 min-h-0 flex-1 overflow-auto rounded p-3 font-mono text-xs break-words whitespace-pre-wrap"
                  data-testid="prompt-source-content"
                >
                  {selected.content}
                </pre>
              ) : (
                <p className="text-muted-foreground rounded border border-dashed p-4 text-xs">
                  {labels.runtimeUnavailable}
                </p>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
