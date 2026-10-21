"use client";

import { useEffect, useRef, useState } from "react";

import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/core/i18n/hooks";
import {
  getNodeParamFields,
  sanitizeNodeParams,
  type NodeParamField,
} from "@/core/workflows/canvas/node-property-schema";
import type { WorkflowNode } from "@/core/workflows/canvas/types";

type WorkflowNodeParamsProps = {
  workflow: WorkflowNode;
  readonly: boolean;
  onChange: (next: WorkflowNode) => void;
};

function stringValue(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function jsonValue(value: unknown): string {
  if (value === undefined) {
    return "";
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "";
  }
}

function defaultJsonValue(value: unknown): string {
  if (value === undefined) {
    return "";
  }
  return jsonValue(value);
}

/** Fixed, schema-driven parameter editor used by every node type. */
export function WorkflowNodeParams({
  workflow,
  readonly,
  onChange,
}: WorkflowNodeParamsProps) {
  const { t } = useI18n();
  const labels = t.workflows.properties;
  const fields = getNodeParamFields(workflow.type);

  const commit = (key: string, value: unknown) => {
    const params = sanitizeNodeParams(workflow.type, workflow.params);
    if (value === undefined) {
      delete params[key];
    } else {
      params[key] = value;
    }
    onChange({ ...workflow, params });
  };

  if (fields.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-2 border-t pt-2">
      <div className="text-muted-foreground text-[10px] font-medium uppercase">
        {labels.paramsTitle}
      </div>
      {fields.map((field) => (
        <NodeParamFieldControl
          key={field.key}
          field={field}
          value={workflow.params[field.key]}
          readonly={readonly}
          onCommit={(value) => commit(field.key, value)}
        />
      ))}
    </div>
  );
}

function NodeParamFieldControl({
  field,
  value,
  readonly,
  onCommit,
}: {
  field: NodeParamField;
  value: unknown;
  readonly: boolean;
  onCommit: (value: unknown) => void;
}) {
  const { t } = useI18n();
  const labels = t.workflows.properties;
  const label = labels.params.fields[field.labelKey] ?? field.labelKey;
  const helper = field.helperKey
    ? labels.params.fields[field.helperKey]
    : undefined;
  const [draft, setDraft] = useState(() =>
    field.kind === "json"
      ? defaultJsonValue(value === undefined ? field.defaultValue : value)
      : stringValue(value === undefined ? field.defaultValue : value),
  );
  const [error, setError] = useState(false);
  const focusedRef = useRef(false);

  useEffect(() => {
    if (focusedRef.current) {
      return;
    }
    setDraft(
      field.kind === "json"
        ? defaultJsonValue(value === undefined ? field.defaultValue : value)
        : stringValue(value === undefined ? field.defaultValue : value),
    );
    setError(false);
  }, [field.defaultValue, field.kind, value]);

  const commitText = () => {
    const trimmed = draft.trim();
    if (field.kind === "number") {
      if (trimmed === "") {
        setError(false);
        onCommit(undefined);
        return;
      }
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed)) {
        setError(true);
        return;
      }
      setError(false);
      onCommit(parsed);
      return;
    }
    if (field.kind === "json") {
      if (trimmed === "") {
        setError(false);
        onCommit(undefined);
        return;
      }
      try {
        setError(false);
        onCommit(JSON.parse(trimmed) as unknown);
      } catch {
        setError(true);
      }
      return;
    }
    setError(false);
    onCommit(trimmed === "" ? undefined : draft);
  };

  if (field.kind === "boolean") {
    const display =
      value === undefined ? field.defaultValue === true : value === true;
    return (
      <label className="flex items-start gap-2 text-xs">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={display}
          disabled={readonly}
          onChange={(event) =>
            onCommit(
              event.target.checked
                ? true
                : field.falseMode === "write"
                  ? false
                  : undefined,
            )
          }
          aria-label={label}
        />
        <span className="min-w-0">
          <span>{label}</span>
          {helper && (
            <span className="text-muted-foreground block text-[10px]">
              {helper}
            </span>
          )}
        </span>
      </label>
    );
  }

  if (field.kind === "select") {
    const current = stringValue(
      value === undefined ? field.defaultValue : value,
    );
    return (
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium">{label}</label>
        <select
          value={current}
          disabled={readonly}
          onChange={(event) =>
            onCommit(event.target.value === "" ? undefined : event.target.value)
          }
          aria-label={label}
          className="border-input bg-background h-7 w-full rounded border px-2 text-xs"
        >
          <option value="">—</option>
          {(field.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.labelKey
                ? (labels.params.fields[option.labelKey] ?? option.value)
                : option.value}
            </option>
          ))}
        </select>
        {helper && (
          <span className="text-muted-foreground text-[10px]">{helper}</span>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium">{label}</label>
      {field.kind === "textarea" ? (
        <Textarea
          value={draft}
          disabled={readonly}
          aria-label={label}
          aria-invalid={error ? true : undefined}
          onFocus={() => {
            focusedRef.current = true;
          }}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            focusedRef.current = false;
            commitText();
          }}
          className="min-h-16 font-mono text-[11px]"
        />
      ) : (
        <Input
          type={field.kind === "number" ? "number" : "text"}
          value={draft}
          disabled={readonly}
          aria-label={label}
          aria-invalid={error ? true : undefined}
          step={field.step}
          min={field.min}
          max={field.max}
          onFocus={() => {
            focusedRef.current = true;
          }}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            focusedRef.current = false;
            commitText();
          }}
          className="h-7 font-mono text-[11px]"
        />
      )}
      {error && (
        <span className="text-destructive text-[10px]" role="alert">
          {labels.params.invalidValue}
        </span>
      )}
      {helper && !error && (
        <span className="text-muted-foreground text-[10px]">{helper}</span>
      )}
    </div>
  );
}
