"use client";

import { PlusIcon, Trash2Icon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/core/i18n/hooks";
import {
  AI_SCHEMA_FIELD_TYPES,
  AI_SCHEMA_MAX_REPAIRS,
  COMMON_AI_SCHEMA_FIELDS,
  aiSchemaReferenceList,
  emptyAiSchema,
  newAiSchemaField,
  parseAiSchema,
  validateAiSchema,
  type AiSchema,
  type AiSchemaField,
  type AiSchemaFieldType,
} from "@/core/workflows/canvas/ai-schema";
import type { WorkflowNode } from "@/core/workflows/canvas/types";

import { useWorkflowEditor } from "./workflow-editor-context";

type WorkflowSchemaFormProps = {
  node: { id: string; data?: { workflow: WorkflowNode } };
  readonly: boolean;
  onChange: (next: WorkflowNode) => void;
};

export function WorkflowSchemaForm({
  node,
  readonly,
  onChange,
}: WorkflowSchemaFormProps) {
  const { t } = useI18n();
  const labels = t.workflows.properties.schema;
  const { currentDefinition } = useWorkflowEditor();
  const workflow = node.data?.workflow;
  const [schema, setSchema] = useState<AiSchema>(() =>
    workflow ? parseAiSchema(workflow.params.schema) : emptyAiSchema(),
  );

  useEffect(() => {
    if (workflow) {
      setSchema(parseAiSchema(workflow.params.schema));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id]);

  const errors = useMemo(() => validateAiSchema(schema), [schema]);
  const references = useMemo(() => aiSchemaReferenceList(schema), [schema]);
  const usage = useMemo(() => {
    if (!workflow) {
      return { input: [] as string[], output: [] as string[] };
    }
    const definition = currentDefinition();
    const input: string[] = [];
    const output: string[] = [];
    for (const edge of definition.edges) {
      if (edge.source !== node.id) {
        continue;
      }
      if (edge.target_port === "input_schema") {
        input.push(edge.target);
      }
      if (edge.target_port === "output_schema") {
        output.push(edge.target);
      }
    }
    return { input, output };
  }, [currentDefinition, node.id, workflow]);

  if (!workflow) {
    return null;
  }

  const commit = (next: AiSchema) => {
    setSchema(next);
    onChange({ ...workflow, params: { ...workflow.params, schema: next } });
  };

  const updateField = (index: number, patch: Partial<AiSchemaField>) => {
    commit({
      ...schema,
      custom_fields: schema.custom_fields.map((field, fieldIndex) =>
        fieldIndex === index ? { ...field, ...patch } : field,
      ),
    });
  };

  const removeField = (index: number) => {
    commit({
      ...schema,
      custom_fields: schema.custom_fields.filter(
        (_field, fieldIndex) => fieldIndex !== index,
      ),
    });
  };

  const addField = () => {
    commit({
      ...schema,
      custom_fields: [
        ...schema.custom_fields,
        newAiSchemaField(schema.custom_fields.length),
      ],
    });
  };

  return (
    <div className="flex flex-col gap-3" data-testid="workflow-schema-form">
      <div className="flex flex-col gap-1">
        <div className="text-xs font-medium">{labels.title}</div>
        <p className="text-muted-foreground text-[11px]">{labels.hint}</p>
      </div>

      <div className="flex flex-col gap-1.5 rounded border p-2">
        <div className="text-[11px] font-medium">{labels.commonTitle}</div>
        <div className="grid grid-cols-[minmax(0,7rem)_minmax(0,5rem)_4rem] gap-1 text-[10px]">
          {COMMON_AI_SCHEMA_FIELDS.map((field) => (
            <div key={field.name} className="contents">
              <code className="truncate font-mono">{field.name}</code>
              <span className="text-muted-foreground">{field.type}</span>
              <span className="text-muted-foreground">
                {field.required ? labels.required : labels.optional}
              </span>
            </div>
          ))}
        </div>
        <p className="text-muted-foreground text-[10px]">{labels.commonHint}</p>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <div className="text-[11px] font-medium">{labels.customTitle}</div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={readonly}
            onClick={addField}
            data-testid="workflow-schema-add-field"
          >
            <PlusIcon className="size-3" />
            {labels.addField}
          </Button>
        </div>

        {schema.custom_fields.length === 0 ? (
          <p className="text-muted-foreground rounded border border-dashed p-3 text-[11px]">
            {labels.noFields}
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {errors.size > 0 && (
              <p className="text-destructive text-[10px]" role="alert">
                {labels.invalid}
              </p>
            )}
            {schema.custom_fields.map((field, index) => {
              const fieldErrors = errors.get(index);
              return (
                <div
                  key={index}
                  className="flex flex-col gap-1.5 rounded border p-2"
                  data-testid={`workflow-schema-field-${index}`}
                >
                  <div className="grid grid-cols-[minmax(0,1fr)_6rem_auto_auto] items-center gap-1.5">
                    <Input
                      value={field.name}
                      disabled={readonly}
                      aria-label={labels.name}
                      aria-invalid={fieldErrors?.name ? true : undefined}
                      onChange={(event) =>
                        updateField(index, { name: event.target.value })
                      }
                      className="h-7 font-mono text-[11px]"
                    />
                    <select
                      value={field.type}
                      disabled={readonly}
                      aria-label={labels.type}
                      onChange={(event) =>
                        updateField(index, {
                          type: event.target.value as AiSchemaFieldType,
                          enum_values:
                            event.target.value === "enum"
                              ? field.enum_values
                              : [],
                        })
                      }
                      className="border-input bg-background h-7 rounded border px-2 text-[11px]"
                    >
                      {AI_SCHEMA_FIELD_TYPES.map((type) => (
                        <option key={type} value={type}>
                          {type}
                        </option>
                      ))}
                    </select>
                    <label className="flex items-center gap-1 text-[10px]">
                      <input
                        type="checkbox"
                        checked={field.required}
                        disabled={readonly}
                        onChange={(event) =>
                          updateField(index, {
                            required: event.target.checked,
                          })
                        }
                      />
                      {labels.required}
                    </label>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      disabled={readonly}
                      aria-label={labels.removeField}
                      title={labels.removeField}
                      onClick={() => removeField(index)}
                      data-testid={`workflow-schema-remove-field-${index}`}
                    >
                      <Trash2Icon className="size-3.5" />
                    </Button>
                  </div>
                  <Input
                    value={field.description}
                    disabled={readonly}
                    aria-label={labels.description}
                    onChange={(event) =>
                      updateField(index, { description: event.target.value })
                    }
                    placeholder={labels.descriptionPlaceholder}
                    className="h-7 text-[11px]"
                  />
                  {field.type === "enum" && (
                    <Input
                      value={field.enum_values.join(", ")}
                      disabled={readonly}
                      aria-label={labels.enumValues}
                      aria-invalid={fieldErrors?.enumValues ? true : undefined}
                      onChange={(event) =>
                        updateField(index, {
                          enum_values: event.target.value
                            .split(",")
                            .map((item) => item.trim())
                            .filter(Boolean),
                        })
                      }
                      placeholder={labels.enumValuesPlaceholder}
                      className="h-7 font-mono text-[11px]"
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 text-[11px]">
        <label htmlFor="schema-max-repairs">{labels.maxRepairs}</label>
        <Input
          id="schema-max-repairs"
          type="number"
          min={0}
          max={AI_SCHEMA_MAX_REPAIRS}
          value={schema.max_repairs}
          disabled={readonly}
          onChange={(event) => {
            const next = Number(event.target.value);
            commit({
              ...schema,
              max_repairs: Number.isFinite(next)
                ? Math.max(0, Math.min(AI_SCHEMA_MAX_REPAIRS, Math.round(next)))
                : 1,
            });
          }}
          className="h-7 w-16 text-[11px]"
        />
      </div>

      <div className="flex flex-col gap-1.5 rounded border p-2">
        <div className="text-[11px] font-medium">{labels.referencesTitle}</div>
        <p className="text-muted-foreground text-[10px]">
          {labels.referencesHint}
        </p>
        <div className="flex flex-wrap gap-1">
          {references.map((reference) => (
            <code
              key={reference}
              className="bg-muted rounded px-1 py-0.5 font-mono text-[10px]"
            >
              {reference}
            </code>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-1.5 rounded border p-2">
        <div className="text-[11px] font-medium">{labels.usageTitle}</div>
        <div className="text-muted-foreground text-[10px]">
          {labels.inputUsage}: {usage.input.join(", ") || labels.none}
        </div>
        <div className="text-muted-foreground text-[10px]">
          {labels.outputUsage}: {usage.output.join(", ") || labels.none}
        </div>
      </div>

      <details className="rounded border p-2">
        <summary className="cursor-pointer text-[11px] font-medium">
          {labels.rawJson}
        </summary>
        <pre className="bg-muted/50 mt-2 max-h-48 overflow-auto rounded p-2 font-mono text-[10px] whitespace-pre-wrap">
          {JSON.stringify(schema, null, 2)}
        </pre>
      </details>
    </div>
  );
}
