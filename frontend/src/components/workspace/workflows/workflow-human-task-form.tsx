"use client";

import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { useI18n } from "@/core/i18n/hooks";
import {
  humanTaskFields,
  initialHumanTaskDrafts,
  serializeHumanTaskDrafts,
  skipHumanTask,
  submitHumanTask,
  type HumanTaskDraft,
  type HumanTaskField,
  type HumanTaskRecord,
} from "@/core/workflows/human-tasks";

import { WorkflowReviewForm } from "./workflow-review-form";

/**
 * Generic form for a pending human task.
 *
 * The fields are exactly what the row declares (`output_spec` + its
 * `validation_rules`), so the canvas asks for what the backend validator will
 * check and nothing else — the task row is the single source of truth, and a
 * canvas that invented a field could never submit it.
 *
 * A `human:review` row is rendered by the dedicated review card instead; its
 * two fixed outcomes and continue-prompt field are not a generic port form.
 * Submission is all-or-nothing; a local serialization error is shown before any
 * request is made, and a backend rejection (the row's own rules) is surfaced
 * verbatim.
 */
export function WorkflowHumanTaskForm({
  task,
  onResolved,
}: {
  task: HumanTaskRecord;
  onResolved?: () => void;
}) {
  const { t } = useI18n();
  const labels = t.workflows.run.humanTask;
  const fields = useMemo(() => humanTaskFields(task), [task]);
  const [drafts, setDrafts] = useState<Record<string, HumanTaskDraft>>(() =>
    initialHumanTaskDrafts(fields),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (task.review !== null) {
    return <WorkflowReviewForm task={task} onResolved={onResolved} />;
  }

  const setDraft = (name: string, value: HumanTaskDraft) => {
    setDrafts((current) => ({ ...current, [name]: value }));
  };

  const handleSubmit = async () => {
    const serialized = serializeHumanTaskDrafts(fields, drafts);
    if (!serialized.ok) {
      setError(serialized.error);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await submitHumanTask(task.id, serialized.values);
      onResolved?.();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  const handleSkip = async () => {
    setBusy(true);
    setError(null);
    try {
      await skipHumanTask(task.id);
      onResolved?.();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="border-muted flex flex-col gap-1.5 rounded border p-1.5"
      data-testid="workflow-human-task"
      data-task-id={task.id}
      data-task-kind={task.kind}
      data-task-node={task.nodeId}
      data-task-run={task.workflowRunId}
    >
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="truncate font-mono">{task.nodeId}</span>
        <span className="text-muted-foreground text-[11px]">{labels.task}</span>
      </div>
      <span
        className="text-muted-foreground truncate font-mono text-[10px]"
        title={task.workflowRunId}
      >
        {labels.runHint(task.workflowRunId)}
      </span>
      {task.description !== "" && (
        <span className="text-[11px] break-words">{task.description}</span>
      )}

      {fields.length === 0 ? (
        <span className="text-muted-foreground text-[11px]">
          {labels.noFields}
        </span>
      ) : (
        fields.map((field) => (
          <HumanTaskFieldInput
            key={field.name}
            field={field}
            draft={drafts[field.name] ?? null}
            onChange={(value) => setDraft(field.name, value)}
            labels={labels}
          />
        ))
      )}

      {error != null && (
        <span
          className="text-destructive text-[11px] break-words"
          data-testid="workflow-human-task-error"
        >
          {error}
        </span>
      )}

      <div className="flex gap-1.5">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-6 px-1.5 text-[11px]"
          disabled={busy}
          onClick={() => void handleSubmit()}
          data-testid="workflow-human-task-submit"
        >
          {labels.submit}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-6 px-1.5 text-[11px]"
          disabled={busy}
          title={labels.skipHint}
          onClick={() => void handleSkip()}
          data-testid="workflow-human-task-skip"
        >
          {labels.skip}
        </Button>
      </div>
    </div>
  );
}

/** One declared field, rendered by its declared type. */
function HumanTaskFieldInput({
  field,
  draft,
  onChange,
  labels,
}: {
  field: HumanTaskField;
  draft: HumanTaskDraft;
  onChange: (value: HumanTaskDraft) => void;
  labels: {
    required: string;
    optional: string;
    patternHint: string;
  };
}) {
  const hint = field.description !== "" ? field.description : null;
  const patternHint =
    field.pattern === null ? null : `${labels.patternHint} ${field.pattern}`;

  return (
    <label
      className="flex flex-col gap-0.5"
      data-testid="workflow-human-task-field"
      data-field-name={field.name}
      data-field-kind={field.kind}
    >
      <span className="flex items-center gap-1 text-[11px]">
        <span className="font-mono">{field.name}</span>
        <span className="text-muted-foreground text-[10px]">
          {field.required ? labels.required : labels.optional}
        </span>
      </span>

      {field.kind === "bool" ? (
        <span className="flex gap-1.5">
          {(field.options ?? []).map((option) => (
            <Button
              key={option.label}
              type="button"
              size="sm"
              variant={draft === option.value ? "default" : "outline"}
              className="h-6 px-1.5 text-[11px]"
              onClick={() => onChange(option.value as boolean)}
              data-testid="workflow-human-task-bool"
              data-field-value={option.label}
            >
              {option.label}
            </Button>
          ))}
        </span>
      ) : field.kind === "enum" ? (
        <select
          className="bg-muted rounded border p-1 font-mono text-[11px]"
          value={typeof draft === "string" ? draft : ""}
          onChange={(event) => onChange(event.target.value)}
          data-testid="workflow-human-task-select"
        >
          <option value="">—</option>
          {(field.options ?? []).map((option) => (
            <option key={option.label} value={option.label}>
              {option.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          type={field.kind === "number" ? "number" : "text"}
          className="bg-muted rounded border p-1 font-mono text-[11px]"
          value={typeof draft === "string" ? draft : ""}
          onChange={(event) => onChange(event.target.value)}
          data-testid="workflow-human-task-input"
        />
      )}

      {hint !== null && (
        <span className="text-muted-foreground text-[10px] break-words">
          {hint}
        </span>
      )}
      {patternHint !== null && (
        <span className="text-muted-foreground font-mono text-[10px]">
          {patternHint}
        </span>
      )}
    </label>
  );
}
