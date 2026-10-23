"use client";

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { checkAgentName } from "@/core/agents/api";
import { useCapabilityGroups } from "@/core/capability-groups/hooks";
import { useI18n } from "@/core/i18n/hooks";
import { useModelProfiles } from "@/core/model-profiles/hooks";
import { previewWorkflowPrompt } from "@/core/workflows/api";
import type { RFNode } from "@/core/workflows/canvas/mapping";
import {
  applyNodeFormValues,
  parseNodeFormValues,
  validateNodeForm,
  type NodeFormValues,
} from "@/core/workflows/canvas/node-form";
import { readSubworkflowSource } from "@/core/workflows/canvas/subworkflow";
import type { WorkflowNode } from "@/core/workflows/canvas/types";
import {
  useAgentOptions,
  useWorkflowTemplateOptions,
} from "@/core/workflows/canvas/use-node-form-options";
import type { WorkflowDefinition } from "@/core/workflows/types";

import { useOpenSubworkflow } from "./use-open-subworkflow";
import { AiPromptComposition } from "./workflow-ai-prompt-composition";
import { useWorkflowEditor } from "./workflow-editor-context";
import { WorkflowNodeParams } from "./workflow-node-params";
import { WorkflowSchemaForm } from "./workflow-schema-form";

/** Sentinel select values for the agent picker (real names are used verbatim). */
const AGENT_NONE_VALUE = "__none__";
const AGENT_CUSTOM_VALUE = "__custom__";
const CUSTOM_AGENT_LABEL = "Custom agent...";
const MODEL_PROFILE_NONE_VALUE = "__none__";
const MODEL_PROFILE_MISSING_VALUE = "__missing__";
const PROMPT_PREVIEW_NONE_VALUE = "__none__";

/** Sentinel select value meaning "this subworkflow port is not mapped". */
const UNMAPPED_VALUE = "__unmapped__";

type WorkflowNodeFormNode = Pick<RFNode, "id" | "data">;

type WorkflowNodeFormProps = {
  node: WorkflowNodeFormNode;
  readonly: boolean;
  active?: boolean;
  onChange: (next: WorkflowNode) => void;
};

/**
 * Typed edit form for workflow nodes. Dedicated forms cover the AI agent,
 * prompt preview, subworkflow and app families; every type then gets the fixed
 * schema-driven params editor. The canvas renders this for every card; only the
 * selected card sets `active`, so prompt-preview work stays scoped to it.
 *
 * Commits are local-draft + commit-on-blur/select; `onChange` fires with a new
 * immutable `WorkflowNode` produced by `applyNodeFormValues`. Saving stays the
 * toolbar's job — this form never calls the API directly.
 */
export function WorkflowNodeForm({
  node,
  readonly,
  active,
  onChange,
}: WorkflowNodeFormProps) {
  const workflow = node.data?.workflow;
  if (!workflow) {
    return null;
  }
  if (workflow.type === "data:schema") {
    return (
      <WorkflowSchemaForm node={node} readonly={readonly} onChange={onChange} />
    );
  }
  if (workflow.type === "ai:llm_agent") {
    return (
      <div className="flex flex-col gap-3">
        <AiAgentForm
          node={node}
          readonly={readonly}
          active={active}
          onChange={onChange}
        />
        <WorkflowNodeParams
          workflow={workflow}
          readonly={readonly}
          onChange={onChange}
        />
      </div>
    );
  }
  if (workflow.type === "ai:capability_group") {
    return (
      <div className="flex flex-col gap-3">
        <CapabilityGroupSelectorForm
          node={node}
          readonly={readonly}
          onChange={onChange}
        />
        <WorkflowNodeParams
          workflow={workflow}
          readonly={readonly}
          onChange={onChange}
        />
      </div>
    );
  }
  if (workflow.type === "ai:prompt_preview") {
    return (
      <div className="flex flex-col gap-3">
        <PromptPreviewForm
          node={node}
          readonly={readonly}
          onChange={onChange}
        />
        <WorkflowNodeParams
          workflow={workflow}
          readonly={readonly}
          onChange={onChange}
        />
      </div>
    );
  }
  if (workflow.type === "nested:subworkflow") {
    return (
      <div className="flex flex-col gap-3">
        <SubworkflowForm node={node} readonly={readonly} onChange={onChange} />
        <WorkflowNodeParams
          workflow={workflow}
          readonly={readonly}
          onChange={onChange}
        />
      </div>
    );
  }
  if (workflow.type.startsWith("app:")) {
    return (
      <div className="flex flex-col gap-3">
        <AppForm node={node} readonly={readonly} onChange={onChange} />
        <WorkflowNodeParams
          workflow={workflow}
          readonly={readonly}
          onChange={onChange}
        />
      </div>
    );
  }
  return (
    <WorkflowNodeParams
      workflow={workflow}
      readonly={readonly}
      onChange={onChange}
    />
  );
}

function AiAgentForm({
  node,
  readonly,
  onChange,
  active,
}: WorkflowNodeFormProps) {
  const { t } = useI18n();
  const labels = t.workflows.properties;
  const workflow = node.data.workflow;
  const [values, setValues] = useState<NodeFormValues>(() =>
    parseNodeFormValues(workflow),
  );
  const [customAgentOpen, setCustomAgentOpen] = useState(false);
  const [agentWarning, setAgentWarning] = useState(false);
  const checkSeqRef = useRef(0);

  // Re-seed the draft only when the selected node changes so in-progress
  // edits survive parent re-renders (including background refetches).
  useEffect(() => {
    setValues(parseNodeFormValues(node.data.workflow));
    setCustomAgentOpen(false);
    setAgentWarning(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id]);

  const agentQuery = useAgentOptions();
  const agentNames = (agentQuery.data ?? []).map((agent) => agent.name);
  const profilesQuery = useModelProfiles();
  const profiles = profilesQuery.data ?? [];

  const errors = validateNodeForm(values);

  const commit = (next: NodeFormValues) => {
    onChange(applyNodeFormValues(node.data.workflow, next));
  };

  const customAgentActive =
    customAgentOpen ||
    (values.agent_name !== "" && !agentNames.includes(values.agent_name ?? ""));

  const agentSelectValue = customAgentActive
    ? AGENT_CUSTOM_VALUE
    : values.agent_name && agentNames.includes(values.agent_name)
      ? values.agent_name
      : AGENT_NONE_VALUE;

  const handleAgentSelect = (value: string) => {
    if (value === AGENT_CUSTOM_VALUE) {
      setCustomAgentOpen(true);
      return;
    }
    setCustomAgentOpen(false);
    setAgentWarning(false);
    const next = {
      ...values,
      agent_name: value === AGENT_NONE_VALUE ? "" : value,
    };
    setValues(next);
    commit(next);
  };

  const handleModelProfileSelect = (value: string) => {
    const next = {
      ...values,
      model_profile: value === MODEL_PROFILE_NONE_VALUE ? "" : value,
    };
    setValues(next);
    commit(next);
  };

  const handleAgentBlur = () => {
    const name = (values.agent_name ?? "").trim();
    const next = { ...values, agent_name: name };
    setValues(next);
    commit(next);
    setCustomAgentOpen(false);
    if (name && !agentNames.includes(name)) {
      const seq = ++checkSeqRef.current;
      setAgentWarning(false);
      checkAgentName(name)
        .then((result) => {
          if (seq === checkSeqRef.current) {
            setAgentWarning(result.available);
          }
        })
        .catch(() => {
          // Backend unavailable —skip the existence hint.
        });
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <details className="rounded border" open>
        <summary className="text-muted-foreground cursor-pointer px-2 py-1.5 text-xs font-medium">
          {labels.ai.configTitle}
        </summary>
        <div className="flex flex-col gap-3 p-2">
          <div className="text-xs font-medium">{labels.ai.title}</div>

          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium">
              {labels.ai.continuePromptLabel}
            </span>
            <p className="text-muted-foreground text-[11px]">
              {labels.ai.continuePromptHint}
            </p>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium">
              {labels.ai.agentLabel}
            </label>
            {customAgentActive ? (
              <Input
                value={values.agent_name ?? ""}
                disabled={readonly}
                aria-label="Custom agent name"
                aria-invalid={errors.agent_name ? true : undefined}
                onChange={(event) =>
                  setValues((current) => ({
                    ...current,
                    agent_name: event.target.value,
                  }))
                }
                onBlur={handleAgentBlur}
                className="h-7 text-xs"
              />
            ) : (
              <Select
                value={agentSelectValue}
                disabled={readonly}
                onValueChange={handleAgentSelect}
              >
                <SelectTrigger
                  aria-label={labels.ai.agentLabel}
                  className="h-7 text-xs"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={AGENT_NONE_VALUE}>
                    {labels.ai.agentNoneOption}
                  </SelectItem>
                  {agentNames.map((name) => (
                    <SelectItem key={name} value={name}>
                      {name}
                    </SelectItem>
                  ))}
                  <SelectItem value={AGENT_CUSTOM_VALUE}>
                    {CUSTOM_AGENT_LABEL}
                  </SelectItem>
                </SelectContent>
              </Select>
            )}
            <p className="text-muted-foreground text-[11px]">
              {labels.ai.agentHint}
            </p>
            {errors.agent_name && (
              <p className="text-destructive text-xs" role="alert">
                {labels.validation.invalidAgentName}
              </p>
            )}
            {agentWarning && (
              <p className="text-xs text-amber-600" role="alert">
                {labels.validation.agentNotFoundWarning}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium">
              {labels.ai.modelProfileLabel}
            </label>
            <Select
              value={
                values.model_profile
                  ? profiles.some(
                      (profile) => profile.id === values.model_profile,
                    )
                    ? values.model_profile
                    : MODEL_PROFILE_MISSING_VALUE
                  : MODEL_PROFILE_NONE_VALUE
              }
              disabled={readonly}
              onValueChange={handleModelProfileSelect}
            >
              <SelectTrigger
                aria-label={labels.ai.modelProfileLabel}
                className="h-7 text-xs"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={MODEL_PROFILE_NONE_VALUE}>
                  {labels.ai.modelProfileNoneOption}
                </SelectItem>
                {values.model_profile &&
                  !profiles.some(
                    (profile) => profile.id === values.model_profile,
                  ) && (
                    <SelectItem value={MODEL_PROFILE_MISSING_VALUE}>
                      {labels.ai.modelProfileMissing}
                    </SelectItem>
                  )}
                {profiles.map((profile) => (
                  <SelectItem
                    key={profile.id}
                    value={profile.id}
                    disabled={!profile.enabled}
                  >
                    {profile.display_name}
                    {profile.enabled ? "" : ` (${t.modelProfiles.disabled})`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-[11px]">
              {labels.ai.modelProfileHint}
            </p>
          </div>
        </div>
      </details>

      <AiPromptComposition
        nodeId={node.id}
        active={active === true}
        readonly={readonly}
      />
    </div>
  );
}

function CapabilityGroupSelectorForm({
  node,
  readonly,
  onChange,
}: WorkflowNodeFormProps) {
  const { t } = useI18n();
  const labels = t.workflows.properties;
  const workflow = node.data.workflow;
  const [values, setValues] = useState<NodeFormValues>(() =>
    parseNodeFormValues(workflow),
  );
  const groupsQuery = useCapabilityGroups();

  useEffect(() => {
    setValues(parseNodeFormValues(node.data.workflow));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id]);

  const selected = new Set(values.groups ?? []);
  const toggle = (guid: string) => {
    const nextGroups = selected.has(guid)
      ? (values.groups ?? []).filter((item) => item !== guid)
      : [...(values.groups ?? []), guid];
    const next = { ...values, groups: nextGroups };
    setValues(next);
    onChange(applyNodeFormValues(node.data.workflow, next));
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="text-xs font-medium">{labels.capabilityGroup.title}</div>
      <div className="text-muted-foreground text-[11px]">
        {labels.capabilityGroup.groupLabel}
      </div>
      {groupsQuery.isPending ? (
        <div className="text-muted-foreground text-xs">Loading...</div>
      ) : groupsQuery.isError ? (
        <div className="text-destructive text-xs">
          {groupsQuery.error.message}
        </div>
      ) : groupsQuery.data.length === 0 ? (
        <div className="text-muted-foreground text-xs">
          {labels.capabilityGroup.noGroups}
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {groupsQuery.data.map((group) => (
            <label
              key={group.guid}
              className="flex cursor-pointer items-start gap-2 rounded border px-2 py-1.5 text-xs"
            >
              <input
                type="checkbox"
                className="mt-0.5"
                checked={selected.has(group.guid)}
                disabled={readonly}
                onChange={() => toggle(group.guid)}
                aria-label={`${group.name} ${group.version}`}
              />
              <span className="min-w-0">
                <span className="font-medium">{group.name}</span>
                <span className="text-muted-foreground ml-1 font-mono">
                  v{group.version}
                </span>
                {group.description && (
                  <span className="text-muted-foreground block truncate">
                    {group.description}
                  </span>
                )}
              </span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function PromptPreviewForm({
  node,
  readonly,
  onChange,
}: WorkflowNodeFormProps) {
  const { t } = useI18n();
  const labels = t.workflows.properties;
  const workflow = node.data.workflow;
  const { workflowId, nodes, currentDefinition } = useWorkflowEditor();
  const [values, setValues] = useState<NodeFormValues>(() =>
    parseNodeFormValues(workflow),
  );
  const [preview, setPreview] = useState<string | null>(null);
  const [omitted, setOmitted] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setValues(parseNodeFormValues(node.data.workflow));
    setPreview(null);
    setOmitted([]);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id]);

  const aiNodes = nodes
    .map((item) => item.data?.workflow)
    .filter((item): item is WorkflowNode => item?.type === "ai:llm_agent");
  const selected = values.agent_node ?? "";
  const selectValue = selected || PROMPT_PREVIEW_NONE_VALUE;

  const commit = (next: NodeFormValues) => {
    setValues(next);
    onChange(applyNodeFormValues(node.data.workflow, next));
  };

  const runPreview = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await previewWorkflowPrompt(workflowId, {
        node_id: node.id,
        definition: currentDefinition(),
      });
      setPreview(result.prompt);
      setOmitted(result.omitted_runtime_blocks);
    } catch (previewError) {
      setError(
        previewError instanceof Error
          ? previewError.message
          : String(previewError),
      );
      setPreview(null);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="text-xs font-medium">
        {labels.capabilityGroup.promptPreviewTitle}
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium">
          {labels.capabilityGroup.promptPreviewAgent}
        </label>
        <Select
          value={selectValue}
          disabled={readonly}
          onValueChange={(value) =>
            commit({
              ...values,
              agent_node: value === PROMPT_PREVIEW_NONE_VALUE ? "" : value,
            })
          }
        >
          <SelectTrigger
            aria-label={labels.capabilityGroup.promptPreviewAgent}
            className="h-7 text-xs"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={PROMPT_PREVIEW_NONE_VALUE}>
              {labels.capabilityGroup.promptPreviewAgentPlaceholder}
            </SelectItem>
            {aiNodes.map((aiNode) => (
              <SelectItem key={aiNode.id} value={aiNode.id}>
                {aiNode.id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Button
        type="button"
        size="sm"
        disabled={readonly || loading}
        onClick={() => void runPreview()}
      >
        {loading
          ? labels.capabilityGroup.previewing
          : labels.capabilityGroup.previewButton}
      </Button>
      {error && (
        <p className="text-destructive text-xs" role="alert">
          {labels.capabilityGroup.previewFailed}: {error}
        </p>
      )}
      {preview !== null && (
        <div className="flex flex-col gap-1">
          {omitted.length > 0 && (
            <p className="text-muted-foreground text-[11px]">
              {labels.capabilityGroup.runtimeOmitted}
            </p>
          )}
          <pre className="bg-muted/50 max-h-72 overflow-auto rounded p-2 font-mono text-[10px] break-words whitespace-pre-wrap">
            {preview || labels.capabilityGroup.previewEmpty}
          </pre>
        </div>
      )}
    </div>
  );
}

function AppForm({ node, readonly, onChange }: WorkflowNodeFormProps) {
  const { t } = useI18n();
  const labels = t.workflows.properties;
  const workflow = node.data.workflow;
  const [values, setValues] = useState<NodeFormValues>(() =>
    parseNodeFormValues(workflow),
  );

  useEffect(() => {
    setValues(parseNodeFormValues(node.data.workflow));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id]);

  const errors = validateNodeForm(values);
  const commit = (next: NodeFormValues) => {
    onChange(applyNodeFormValues(node.data.workflow, next));
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="text-xs font-medium">{labels.app.title}</div>

      <div className="flex flex-col gap-1">
        <label htmlFor={`${node.id}-app`} className="text-xs font-medium">
          {labels.app.appLabel}
        </label>
        <Input
          id={`${node.id}-app`}
          value={values.app ?? ""}
          disabled={readonly}
          placeholder={labels.app.appPlaceholder}
          aria-invalid={errors.app ? true : undefined}
          onChange={(event) =>
            setValues((current) => ({ ...current, app: event.target.value }))
          }
          onBlur={() => commit(values)}
          className="h-7 text-xs"
        />
        {errors.app && (
          <p className="text-destructive text-xs" role="alert">
            {labels.validation.appRequired}
          </p>
        )}
      </div>

      {workflow.type === "app:script" && (
        <div className="flex flex-col gap-1">
          <label htmlFor={`${node.id}-script`} className="text-xs font-medium">
            {labels.app.scriptLabel}
          </label>
          <Textarea
            id={`${node.id}-script`}
            value={values.script ?? ""}
            disabled={readonly}
            placeholder={labels.app.scriptPlaceholder}
            onChange={(event) =>
              setValues((current) => ({
                ...current,
                script: event.target.value,
              }))
            }
            onBlur={() => commit(values)}
            className="min-h-16 text-xs"
          />
          <p className="text-muted-foreground text-[11px]">
            {labels.app.scriptHint}
          </p>
        </div>
      )}
    </div>
  );
}

function definitionPorts(
  definition: WorkflowDefinition,
  type: "flow:start" | "flow:end",
) {
  return (
    definition.nodes.find((item) => item.type === type)?.outputs ?? []
  ).map(({ name, type: portType }) => ({ name, type: portType }));
}

function SubworkflowForm({ node, readonly, onChange }: WorkflowNodeFormProps) {
  const { t } = useI18n();
  const labels = t.workflows.properties;
  const workflow = node.data.workflow;
  const source = readSubworkflowSource(workflow.params);
  const openSubworkflow = useOpenSubworkflow();
  const [values, setValues] = useState<NodeFormValues>(() =>
    parseNodeFormValues(workflow),
  );

  useEffect(() => {
    setValues(parseNodeFormValues(node.data.workflow));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id]);

  const templateQuery = useWorkflowTemplateOptions(node.id);
  const templates = templateQuery.data ?? [];

  const errors = validateNodeForm(values, workflow);

  const selectedTemplate = templates.find(
    (template) => template.id === values.template_id,
  );
  const localDefinition = source?.kind === "inline" ? source.definition : null;
  const startOutputPorts = localDefinition
    ? definitionPorts(localDefinition, "flow:start")
    : (selectedTemplate?.startOutputPorts ?? []);
  const endOutputPorts = localDefinition
    ? definitionPorts(localDefinition, "flow:end")
    : (selectedTemplate?.endOutputPorts ?? []);
  const mapping = values.mapping ?? { inputs: {}, outputs: {} };
  const showMappingSection =
    startOutputPorts.length > 0 || endOutputPorts.length > 0;

  const commit = (next: NodeFormValues) => {
    onChange(applyNodeFormValues(node.data.workflow, next));
  };

  const handleTemplateSelect = (id: string) => {
    const option = templates.find((template) => template.id === id);
    const next = {
      ...values,
      template_id: id,
      version: option?.version ?? values.version,
    };
    setValues(next);
    commit(next);
  };

  /**
   * Wire one child port to a parent port (or clear it with `UNMAPPED_VALUE`).
   * Iteration is child-first on both sides to mirror the backend wire format
   * (`mapping.inputs` / `mapping.outputs` are keyed by child port name): the
   * fixed row label is the child start/end output port and the select offers
   * the parent's declared input/output ports.
   */
  const handleMappingChange = (
    kind: "inputs" | "outputs",
    childPort: string,
    value: string,
  ) => {
    const current = values.mapping ?? { inputs: {}, outputs: {} };
    const side = { ...current[kind] };
    if (value === UNMAPPED_VALUE) {
      delete side[childPort];
    } else {
      side[childPort] = value;
    }
    const nextMapping = { ...current, [kind]: side };
    const next: NodeFormValues = {
      ...values,
      mapping:
        Object.keys(nextMapping.inputs).length > 0 ||
        Object.keys(nextMapping.outputs).length > 0
          ? nextMapping
          : undefined,
    };
    setValues(next);
    commit(next);
  };

  const displayVersion =
    source?.kind === "inline" ? source.sourceVersion : values.version;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-medium">{labels.subworkflow.title}</div>
        <span
          className="text-muted-foreground text-[11px]"
          data-testid="workflow-subworkflow-save-mode"
        >
          {labels.subworkflow.saveModeLabel}:{" "}
          {source?.kind === "inline"
            ? labels.subworkflow.saveModeLocal
            : labels.subworkflow.saveModeGlobal}
        </span>
      </div>

      {source && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => openSubworkflow(workflow)}
          data-testid="workflow-open-subworkflow"
        >
          {labels.subworkflow.openButton}
        </Button>
      )}

      {localDefinition ? (
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium">
            {labels.subworkflow.localSnapshotLabel}
          </span>
          <span className="text-muted-foreground font-mono text-xs">
            {source?.kind === "inline"
              ? (source.sourceTemplateId ?? localDefinition.id)
              : localDefinition.id}
          </span>
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium">
            {labels.subworkflow.templateLabel}
          </label>
          {templates.length > 0 ? (
            <Select
              value={
                templates.some((template) => template.id === values.template_id)
                  ? values.template_id
                  : undefined
              }
              disabled={readonly}
              onValueChange={handleTemplateSelect}
            >
              <SelectTrigger
                aria-label={labels.subworkflow.templateLabel}
                className="h-7 text-xs"
              >
                <SelectValue
                  placeholder={labels.subworkflow.templatePlaceholder}
                />
              </SelectTrigger>
              <SelectContent>
                {templates.map((template) => (
                  <SelectItem key={template.id} value={template.id}>
                    {template.name} ({template.version})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <p className="text-muted-foreground text-xs">
              {labels.subworkflow.noTemplates}
            </p>
          )}
          {errors.template_id && (
            <p className="text-destructive text-xs" role="alert">
              {labels.validation.templateRequired}
            </p>
          )}
        </div>
      )}

      {displayVersion && (
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium">
            {labels.subworkflow.versionLabel}
          </span>
          <span className="text-muted-foreground font-mono text-xs">
            {displayVersion}
          </span>
        </div>
      )}

      {showMappingSection && (
        <div className="flex flex-col gap-3">
          <div className="text-xs font-medium">
            {labels.subworkflow.mappingTitle}
          </div>

          {startOutputPorts.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium">
                {labels.subworkflow.inputMappingLabel}
              </span>
              {startOutputPorts.map((port) => (
                <div key={port.name} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">
                    {port.name}
                  </span>
                  <Select
                    value={mapping.inputs[port.name] ?? UNMAPPED_VALUE}
                    disabled={readonly}
                    onValueChange={(value) =>
                      handleMappingChange("inputs", port.name, value)
                    }
                  >
                    <SelectTrigger
                      aria-label={`${labels.subworkflow.inputMappingLabel}: ${port.name}`}
                      className="h-7 w-40 shrink-0 text-xs"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={UNMAPPED_VALUE}>
                        {labels.subworkflow.unmappedPlaceholder}
                      </SelectItem>
                      {workflow.inputs.map((parentPort) => (
                        <SelectItem
                          key={parentPort.name}
                          value={parentPort.name}
                        >
                          {parentPort.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
          )}

          {endOutputPorts.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium">
                {labels.subworkflow.outputMappingLabel}
              </span>
              {endOutputPorts.map((port) => (
                <div key={port.name} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">
                    {port.name}
                  </span>
                  <Select
                    value={mapping.outputs[port.name] ?? UNMAPPED_VALUE}
                    disabled={readonly}
                    onValueChange={(value) =>
                      handleMappingChange("outputs", port.name, value)
                    }
                  >
                    <SelectTrigger
                      aria-label={`${labels.subworkflow.outputMappingLabel}: ${port.name}`}
                      className="h-7 w-40 shrink-0 text-xs"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={UNMAPPED_VALUE}>
                        {labels.subworkflow.unmappedPlaceholder}
                      </SelectItem>
                      {workflow.outputs.map((parentPort) => (
                        <SelectItem
                          key={parentPort.name}
                          value={parentPort.name}
                        >
                          {parentPort.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
          )}

          {errors["mapping.outputs"] && (
            <p className="text-destructive text-xs" role="alert">
              {labels.validation.mappingInvalid}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
