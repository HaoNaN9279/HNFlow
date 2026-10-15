import type { NodeCategory, NodeType, Port, WorkflowNode } from "./types";

/**
 * Node palette catalogue — every workflow node type with its default
 * ports and params. Defaults align with the backend executors
 * (`deerflow.workflow.executors.*`) and the compiler's port expectations.
 */
export type NodeCatalogEntry = {
  type: NodeType;
  label: string;
  category: NodeCategory;
  defaultInputs: Port[];
  defaultOutputs: Port[];
  defaultParams?: Record<string, unknown>;
  description: string;
};

/** Palette category groups, in render order for the material panel. */
export const NODE_CATEGORIES = [
  { id: "flow", label: "Flow" },
  { id: "data", label: "Data" },
  { id: "tool", label: "Tools" },
  { id: "ai", label: "AI" },
  { id: "app", label: "App" },
  { id: "human", label: "Human" },
  { id: "subworkflow", label: "Subworkflow" },
] as const satisfies readonly { id: NodeCategory; label: string }[];

export const NODE_CATALOG = [
  {
    type: "flow:start",
    label: "Start",
    category: "flow",
    defaultInputs: [],
    defaultOutputs: [{ name: "out", type: "data", required: true }],
    description: "Workflow entry point — fires once with no inputs.",
  },
  {
    type: "flow:end",
    label: "End",
    category: "flow",
    defaultInputs: [{ name: "in", type: "data", required: true }],
    defaultOutputs: [],
    description: "Workflow terminal node — collects the final result.",
  },
  {
    type: "flow:if",
    label: "If",
    category: "flow",
    defaultInputs: [{ name: "in", type: "data", required: true }],
    defaultOutputs: [
      { name: "true", type: "bool", required: true },
      { name: "false", type: "bool", required: true },
    ],
    description: "Conditional branch — routes to true/false by truthiness.",
  },
  {
    type: "flow:switch",
    label: "Switch",
    category: "flow",
    defaultInputs: [{ name: "in", type: "data", required: true }],
    defaultOutputs: [],
    defaultParams: { cases: [] },
    description: "Multi-case switch — branch ports are defined per case.",
  },
  {
    type: "flow:loop",
    label: "Loop",
    category: "flow",
    defaultInputs: [{ name: "in", type: "data", required: true }],
    defaultOutputs: [
      { name: "iteration", type: "data", required: true },
      { name: "out", type: "data", required: true },
      { name: "results", type: "array", required: false },
      { name: "last", type: "data", required: false },
    ],
    description:
      "Repeated execution — emits the iteration counter, the collected per-round results, and the last one.",
  },
  {
    type: "flow:try",
    label: "Try",
    category: "flow",
    defaultInputs: [{ name: "in", type: "data", required: true }],
    defaultOutputs: [
      { name: "out", type: "data", required: false },
      { name: "error", type: "bool", required: false },
      { name: "error_message", type: "data", required: false },
      { name: "error_type", type: "data", required: false },
    ],
    description:
      "Protected sub-workflow (try/catch) — a body failure is reported on error ports instead of aborting the run.",
  },
  {
    type: "flow:parallel",
    label: "Parallel",
    category: "flow",
    defaultInputs: [{ name: "in", type: "data", required: true }],
    defaultOutputs: [{ name: "out", type: "data", required: true }],
    description: "Fan-out / fan-in pass-through for parallel branches.",
  },
  {
    type: "flow:wait",
    label: "Wait",
    category: "flow",
    defaultInputs: [{ name: "in", type: "data", required: true }],
    defaultOutputs: [{ name: "out", type: "data", required: true }],
    defaultParams: { duration: 0 },
    description: "Sleep for a duration (seconds), then pass the value through.",
  },
  {
    type: "data:assign",
    label: "Assign",
    category: "data",
    defaultInputs: [{ name: "in", type: "data", required: true }],
    defaultOutputs: [{ name: "out", type: "data", required: true }],
    defaultParams: { value: null },
    description: "Static value assignment or input pass-through.",
  },
  {
    type: "data:convert",
    label: "Convert",
    category: "data",
    defaultInputs: [{ name: "in", type: "data", required: true }],
    defaultOutputs: [{ name: "out", type: "data", required: true }],
    defaultParams: { to: "string" },
    description: "Type conversion (bool/int/float/string).",
  },
  {
    type: "data:asset",
    label: "Asset",
    category: "data",
    defaultInputs: [{ name: "in", type: "data", required: false }],
    defaultOutputs: [
      { name: "out", type: "data", required: true },
      { name: "asset", type: "data", required: false },
      { name: "assets", type: "array", required: false },
    ],
    defaultParams: { operation: "inspect", path: "", hash: true },
    description:
      "Inspect / import / export / convert a file as an asset (host ↔ sandbox).",
  },
  {
    type: "data:shared",
    label: "Shared",
    category: "data",
    defaultInputs: [{ name: "in", type: "data", required: false }],
    defaultOutputs: [{ name: "out", type: "data", required: false }],
    defaultParams: { operation: "read", name: "" },
    description:
      "Read / write / append a workflow-level shared variable (blackboard).",
  },
  {
    type: "data:knowledge",
    label: "Knowledge",
    category: "data",
    defaultInputs: [{ name: "in", type: "data", required: false }],
    defaultOutputs: [
      { name: "out", type: "data", required: true },
      { name: "records", type: "array", required: false },
    ],
    defaultParams: { operation: "retrieve", collection: "", top_k: 5 },
    description:
      "Ingest or retrieve local knowledge with citations (RAG).",
  },
  {
    type: "data:file",
    label: "File",
    category: "data",
    defaultInputs: [{ name: "in", type: "file", required: true }],
    defaultOutputs: [{ name: "out", type: "file", required: true }],
    defaultParams: { operation: "read", path: "" },
    description: "Read or write a file through the sandbox.",
  },
  {
    type: "data:json",
    label: "JSON",
    category: "data",
    defaultInputs: [{ name: "in", type: "data", required: true }],
    defaultOutputs: [{ name: "out", type: "data", required: true }],
    defaultParams: { operation: "stringify" },
    description: "JSON stringify or parse.",
  },
  {
    type: "data:regex",
    label: "Regex",
    category: "data",
    defaultInputs: [{ name: "in", type: "data", required: true }],
    defaultOutputs: [{ name: "out", type: "data", required: true }],
    defaultParams: { pattern: "" },
    description: "Regular-expression match against the input.",
  },
  {
    type: "tool:bash",
    label: "Bash",
    category: "tool",
    defaultInputs: [{ name: "in", type: "data", required: true }],
    defaultOutputs: [{ name: "out", type: "data", required: true }],
    defaultParams: { command: "" },
    description: "Execute a shell command inside the sandbox.",
  },
  {
    type: "tool:http",
    label: "HTTP",
    category: "tool",
    defaultInputs: [{ name: "in", type: "data", required: true }],
    defaultOutputs: [{ name: "out", type: "data", required: true }],
    defaultParams: { url: "" },
    description: "Perform an HTTP request.",
  },
  {
    type: "tool:notify",
    label: "Notify",
    category: "tool",
    defaultInputs: [{ name: "in", type: "data", required: true }],
    defaultOutputs: [{ name: "out", type: "data", required: true }],
    description: "Emit a local user-facing notification for long-running runs.",
  },
  {
    type: "tool:log",
    label: "Log",
    category: "tool",
    defaultInputs: [{ name: "in", type: "data", required: true }],
    defaultOutputs: [{ name: "out", type: "data", required: true }],
    defaultParams: { message: "" },
    description: "Log a message and pass the input through.",
  },
  {
    type: "ai:llm_agent",
    label: "LLM Agent",
    category: "ai",
    defaultInputs: [
      { name: "in", type: "data", required: true },
      {
        name: "template_prompt",
        type: "data",
        required: false,
        description:
          "Template prompt (reset mode — full re-run from a template)",
      },
      {
        name: "continue_prompt",
        type: "data",
        required: false,
        description: "Continue this node's session with a new prompt",
      },
    ],
    defaultOutputs: [{ name: "out", type: "data", required: true }],
    defaultParams: { instruction: "" },
    description: "Run a one-shot sub-agent from an instruction template.",
  },
  {
    type: "human:task",
    label: "Human Task",
    category: "human",
    defaultInputs: [{ name: "in", type: "data", required: true }],
    defaultOutputs: [{ name: "out", type: "data", required: true }],
    defaultParams: { description: "" },
    description: "Suspend the workflow for a human approval/input.",
  },
  {
    type: "app:launch",
    label: "App Launch",
    category: "app",
    defaultInputs: [{ name: "in", type: "data", required: true }],
    defaultOutputs: [
      { name: "session", type: "data", required: true },
      { name: "out", type: "data", required: true },
    ],
    defaultParams: { app: "", mode: "launch" },
    description:
      "Launch or attach a local application instance and emit its session handle.",
  },
  {
    type: "app:script",
    label: "App Script",
    category: "app",
    defaultInputs: [
      { name: "session", type: "data", required: true },
      { name: "in", type: "data", required: true },
    ],
    defaultOutputs: [
      { name: "session", type: "data", required: true },
      { name: "out", type: "data", required: true },
    ],
    defaultParams: { app: "", script: "" },
    description: "Run a script command in a local application session.",
  },
  {
    type: "app:wait",
    label: "App Wait",
    category: "app",
    defaultInputs: [
      { name: "session", type: "data", required: true },
      { name: "in", type: "data", required: true },
    ],
    defaultOutputs: [
      { name: "session", type: "data", required: true },
      { name: "out", type: "data", required: true },
    ],
    defaultParams: { app: "", for: "idle" },
    description: "Wait for an in-application task (render / compile / idle).",
  },
  {
    type: "app:collect",
    label: "App Collect",
    category: "app",
    defaultInputs: [
      { name: "session", type: "data", required: true },
      { name: "in", type: "data", required: true },
    ],
    defaultOutputs: [
      { name: "session", type: "data", required: true },
      { name: "out", type: "file", required: true },
      { name: "assets", type: "array", required: false },
    ],
    defaultParams: { app: "" },
    description: "Collect files produced by a local application session.",
  },
  {
    type: "nested:subworkflow",
    label: "Subworkflow",
    category: "subworkflow",
    defaultInputs: [{ name: "in", type: "data", required: true }],
    defaultOutputs: [{ name: "out", type: "data", required: true }],
    defaultParams: { subworkflow: { type: "template", template_id: "" } },
    description:
      "Nested workflow reference — compiled subgraph or runtime delegation.",
  },
] as const satisfies readonly NodeCatalogEntry[];

/** Generate a `n_<8-hex>` node id, matching the mapping layer's id format. */
export function makeNodeId(): string {
  return `n_${globalThis.crypto.randomUUID().slice(0, 8)}`;
}

export function getNodeCatalog(): NodeCatalogEntry[] {
  return [...NODE_CATALOG];
}

export function getNodeCatalogEntry(
  type: NodeType,
): NodeCatalogEntry | undefined {
  return NODE_CATALOG.find((entry) => entry.type === type);
}

/**
 * Build a fresh default node for the given type with unique id, deep-copied
 * ports and params. Every call returns an independent object graph.
 */
export function getDefaultNode(type: NodeType): WorkflowNode {
  const entry = getNodeCatalogEntry(type);
  if (!entry) {
    throw new Error(`Unknown workflow node type: ${type}`);
  }
  return {
    id: makeNodeId(),
    type,
    inputs: entry.defaultInputs.map((port) => ({ ...port })),
    outputs: entry.defaultOutputs.map((port) => ({ ...port })),
    params: entry.defaultParams ? structuredClone(entry.defaultParams) : {},
    capability_groups: [],
    agent_name: null,
  };
}
