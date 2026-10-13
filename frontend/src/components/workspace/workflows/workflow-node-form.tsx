"use client";

import { useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
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
import { useI18n } from "@/core/i18n/hooks";
import type { RFNode } from "@/core/workflows/canvas/mapping";
import {
  applyNodeFormValues,
  parseNodeFormValues,
  validateNodeForm,
  type NodeFormValues,
} from "@/core/workflows/canvas/node-form";
import type { WorkflowNode } from "@/core/workflows/canvas/types";
import {
  useAgentOptions,
  useSkillOptions,
  useWorkflowTemplateOptions,
} from "@/core/workflows/canvas/use-node-form-options";

/** Sentinel select values for the agent picker (real names are used verbatim). */
const AGENT_NONE_VALUE = "__none__";
const AGENT_CUSTOM_VALUE = "__custom__";
const CUSTOM_AGENT_LABEL = "Custom agent...";
const NO_SKILLS_LABEL = "No skills available";

/** Sentinel select value meaning "this subworkflow port is not mapped". */
const UNMAPPED_VALUE = "__unmapped__";

type WorkflowNodeFormProps = {
  node: RFNode;
  readonly: boolean;
  onChange: (next: WorkflowNode) => void;
};

/**
 * Typed edit form for workflow nodes. Renders a dedicated form for
 * `ai:llm_agent` and `nested:subworkflow`; every other node type returns null
 * so the properties panel keeps its generic key/value editor.
 *
 * Commits are local-draft + commit-on-blur/select, matching the properties
 * panel: edits update local state immediately and `onChange` fires with a new
 * immutable `WorkflowNode` produced by `applyNodeFormValues`. Saving stays the
 * toolbar's job — this form never calls the API directly.
 */
export function WorkflowNodeForm({
  node,
  readonly,
  onChange,
}: WorkflowNodeFormProps) {
  const workflow = node.data?.workflow;
  if (!workflow) {
    return null;
  }
  if (workflow.type === "ai:llm_agent") {
    return <AiAgentForm node={node} readonly={readonly} onChange={onChange} />;
  }
  if (workflow.type === "nested:subworkflow") {
    return (
      <SubworkflowForm node={node} readonly={readonly} onChange={onChange} />
    );
  }
  if (workflow.type.startsWith("app:")) {
    return <AppForm node={node} readonly={readonly} onChange={onChange} />;
  }
  return null;
}

function AiAgentForm({ node, readonly, onChange }: WorkflowNodeFormProps) {
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
  const skillQuery = useSkillOptions();
  const skills = skillQuery.data ?? [];
  const selectedSkills = values.capability_groups ?? [];

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
          // Backend unavailable — skip the existence hint.
        });
    }
  };

  const handleToggleSkill = (skill: string) => {
    const nextSkills = selectedSkills.includes(skill)
      ? selectedSkills.filter((item) => item !== skill)
      : [...selectedSkills, skill];
    const next = { ...values, capability_groups: nextSkills };
    setValues(next);
    commit(next);
  };

  return (
    <div className="flex flex-col gap-3 border-b pb-4">
      <div className="text-xs font-medium">{labels.ai.title}</div>

      <div className="flex flex-col gap-1">
        <label
          htmlFor={`${node.id}-instruction`}
          className="text-xs font-medium"
        >
          {labels.ai.instructionLabel}
        </label>
        <Textarea
          id={`${node.id}-instruction`}
          value={values.instruction ?? ""}
          disabled={readonly}
          placeholder={labels.ai.instructionPlaceholder}
          aria-invalid={errors.instruction ? true : undefined}
          onChange={(event) =>
            setValues((current) => ({
              ...current,
              instruction: event.target.value,
            }))
          }
          onBlur={() => commit(values)}
          className="min-h-20 text-xs"
        />
        {errors.instruction && (
          <p className="text-destructive text-xs" role="alert">
            {labels.validation.instructionRequired}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium">
          {labels.ai.continuePromptLabel}
        </span>
        <p className="text-muted-foreground text-[11px]">
          {labels.ai.continuePromptHint}
        </p>
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium">{labels.ai.agentLabel}</label>
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
          {labels.ai.capabilityGroupsLabel}
        </label>
        {selectedSkills.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {selectedSkills.map((skill) => (
              <Badge key={skill} variant="secondary">
                {skill}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  disabled={readonly}
                  onClick={() => handleToggleSkill(skill)}
                  aria-label={`Remove skill ${skill}`}
                  className="size-3.5 rounded-full"
                >
                  ×
                </Button>
              </Badge>
            ))}
          </div>
        )}
        {skills.length > 0 ? (
          <div className="flex flex-col gap-1">
            {skills.map((skill) => (
              <label key={skill} className="flex items-center gap-1.5 text-xs">
                <input
                  type="checkbox"
                  checked={selectedSkills.includes(skill)}
                  disabled={readonly}
                  onChange={() => handleToggleSkill(skill)}
                  aria-label={`Add skill ${skill}`}
                />
                {skill}
              </label>
            ))}
          </div>
        ) : (
          <p className="text-muted-foreground text-xs">{NO_SKILLS_LABEL}</p>
        )}
      </div>
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
    <div className="flex flex-col gap-3 border-b pb-4">
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

function SubworkflowForm({ node, readonly, onChange }: WorkflowNodeFormProps) {
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

  const templateQuery = useWorkflowTemplateOptions(node.id);
  const templates = templateQuery.data ?? [];

  const errors = validateNodeForm(values, workflow);

  const selectedTemplate = templates.find(
    (template) => template.id === values.template_id,
  );
  const startOutputPorts = selectedTemplate?.startOutputPorts ?? [];
  const endOutputPorts = selectedTemplate?.endOutputPorts ?? [];
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

  return (
    <div className="flex flex-col gap-3 border-b pb-4">
      <div className="text-xs font-medium">{labels.subworkflow.title}</div>

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

      {values.version && (
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium">
            {labels.subworkflow.versionLabel}
          </span>
          <span className="text-muted-foreground font-mono text-xs">
            {values.version}
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
