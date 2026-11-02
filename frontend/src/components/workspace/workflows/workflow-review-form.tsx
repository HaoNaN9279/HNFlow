"use client";

import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { useI18n } from "@/core/i18n/hooks";
import {
  submitHumanTask,
  type HumanTaskRecord,
} from "@/core/workflows/human-tasks";

const PREVIEW_LIMIT = 4000;

function formatInput(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    const text = JSON.stringify(value, null, 2);
    return text.length > PREVIEW_LIMIT
      ? `${text.slice(0, PREVIEW_LIMIT)}\n...`
      : text;
  } catch {
    return String(value);
  }
}

/**
 * Dedicated approve/reject card for a `human:review` task.
 *
 * The review has exactly two outcomes: approve continues the graph, reject
 * rewinds it to the configured LLM Agent target and carries the optional
 * continue prompt back.  There is deliberately no skip action — the backend
 * rejects it for review rows.
 */
export function WorkflowReviewForm({
  task,
  onResolved,
}: {
  task: HumanTaskRecord;
  onResolved?: () => void;
}) {
  const { t } = useI18n();
  const labels = t.workflows.run.review;
  const [decision, setDecision] = useState<boolean | null>(null);
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const review = task.review;
  const inputText = useMemo(
    () => (review === null ? "" : formatInput(review.input)),
    [review],
  );

  if (review === null) {
    return null;
  }

  const handleSubmit = async () => {
    if (decision === null) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await submitHumanTask(
        task.id,
        decision
          ? { decision: true }
          : { decision: false, feedback: feedback.trim() },
      );
      onResolved?.();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="border-muted flex flex-col gap-1.5 rounded border p-2"
      data-testid="workflow-review"
      data-task-id={task.id}
      data-task-node={task.nodeId}
      data-task-run={task.workflowRunId}
      data-task-visit={review.visit}
    >
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="truncate font-mono">{task.nodeId}</span>
        <span className="text-muted-foreground text-[11px]">
          {labels.title}
        </span>
      </div>
      <div className="text-muted-foreground flex flex-wrap gap-x-2 gap-y-0.5 text-[10px]">
        <span>{labels.runHint(task.workflowRunId)}</span>
        <span>{labels.attempt(review.visit)}</span>
        <span>{labels.previousRejections(review.previousRejections)}</span>
        {review.targetNodeId !== "" && (
          <span className="font-mono">
            {labels.target(review.targetNodeId)}
          </span>
        )}
      </div>
      {review.instructions !== "" && (
        <span className="text-[11px] break-words">{review.instructions}</span>
      )}
      <details className="text-[11px]">
        <summary className="text-muted-foreground cursor-pointer select-none">
          {labels.input}
        </summary>
        <pre className="bg-muted/50 mt-1 max-h-40 overflow-auto rounded p-1.5 text-[10px] whitespace-pre-wrap">
          {inputText}
        </pre>
      </details>

      <div className="flex gap-1.5">
        <Button
          type="button"
          size="sm"
          variant={decision === true ? "default" : "outline"}
          className="h-6 px-2 text-[11px]"
          disabled={busy}
          onClick={() => setDecision(true)}
          data-testid="workflow-review-approve"
        >
          {labels.approve}
        </Button>
        <Button
          type="button"
          size="sm"
          variant={decision === false ? "destructive" : "outline"}
          className="h-6 px-2 text-[11px]"
          disabled={busy}
          onClick={() => setDecision(false)}
          data-testid="workflow-review-reject"
        >
          {labels.reject}
        </Button>
      </div>

      {decision === false && (
        <label className="flex flex-col gap-0.5">
          <span className="text-[11px]">{labels.feedback}</span>
          <textarea
            className="border-input bg-background min-h-16 w-full rounded border p-1.5 text-[11px]"
            value={feedback}
            onChange={(event) => setFeedback(event.target.value)}
            placeholder={labels.feedbackHint}
            data-testid="workflow-review-feedback"
          />
          <span className="text-muted-foreground text-[10px]">
            {labels.feedbackHint}
          </span>
        </label>
      )}

      {error !== null && (
        <span
          className="text-destructive text-[11px] break-words"
          data-testid="workflow-review-error"
        >
          {error}
        </span>
      )}

      <Button
        type="button"
        size="sm"
        className="h-6 self-start px-2 text-[11px]"
        disabled={busy || decision === null}
        onClick={() => void handleSubmit()}
        data-testid="workflow-review-submit"
      >
        {busy ? labels.submitting : labels.submit}
      </Button>
    </div>
  );
}
