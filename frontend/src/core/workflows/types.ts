/**
 * Workflow domain types — mirror of the backend WorkflowDefinition schema.
 *
 * Source of truth: `backend/packages/harness/deerflow/workflow/schema.py`
 * (Pydantic v2) plus the API row shape produced by
 * `backend/packages/harness/deerflow/persistence/workflow_definitions/sql.py::_row_to_dict`.
 *
 * Keep the string enum values in lockstep with the backend StrEnum members;
 * `tests/unit/core/workflows/types.test.ts` pins them by literal assertion.
 */

export const PORT_TYPES = [
  "data",
  "file",
  "bool",
  "enum",
  "number",
  "array",
  "record",
] as const;
export type PortType = (typeof PORT_TYPES)[number];

export const NODE_TYPES = [
  // Flow control
  "flow:start",
  "flow:end",
  "flow:if",
  "flow:switch",
  "flow:loop",
  "flow:parallel",
  "flow:wait",
  "flow:try",
  "flow:handoff",
  // Data transformation
  "data:assign",
  "data:convert",
  "data:asset",
  "data:shared",
  "data:knowledge",
  "data:file",
  "data:json",
  "data:regex",
  // External tools
  "tool:bash",
  "tool:http",
  "tool:notify",
  "tool:log",
  "tool:invoke",
  // AI
  "ai:llm_agent",
  "ai:capability_group",
  "ai:prompt_preview",
  // Local professional software
  "app:launch",
  "app:script",
  "app:wait",
  "app:collect",
  // Human interaction
  "human:task",
  "human:review",
  // Composition
  "nested:subworkflow",
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

/** A typed input or output port on a workflow node. */
export type Port = {
  name: string;
  type: PortType;
  required?: boolean;
  description?: string | null;
};

/** A single node in a workflow graph. */
export type Node = {
  id: string;
  type: NodeType;
  inputs: Port[];
  outputs: Port[];
  params: Record<string, unknown>;
  capability_groups?: string[];
  agent_name?: string | null;
};

/** A directed edge connecting two node ports. Deliberately has no id field. */
export type Edge = {
  source: string;
  source_port: string;
  target: string;
  target_port: string;
  condition?: string | null;
};

/**
 * Workflow-level metadata.
 *
 * The backend Pydantic model forbids extra fields, but the API layer treats
 * metadata as a free dict — the D1 canvas state lives at `metadata.canvas`,
 * so the frontend allows an index signature.
 */
export type WorkflowMetadata = {
  resolved_groups?: string[] | null;
  created_at?: string | null;
  updated_at?: string | null;
  pending_review_nodes?: string[] | null;
  /** Frozen reproducibility snapshot (§5.6): capability groups + model + sampling. */
  lockfile?: Record<string, unknown> | null;
  [key: string]: unknown;
};

/**
 * D1 canvas state stored under `metadata.canvas` — node positions keyed by
 * node id. The backend treats metadata as opaque, so the UI reads this shape
 * back with a cast when rendering the editor.
 */
export type CanvasMetadata = {
  positions?: Record<string, { x: number; y: number }>;
  labels?: Record<string, string>;
  sizes?: Record<string, { width: number; height: number }>;
};

/** Top-level workflow definition — the serialisable root document. */
export type WorkflowDefinition = {
  id: string;
  name: string;
  version: string;
  nodes: Node[];
  edges: Edge[];
  metadata: WorkflowMetadata;
};

/**
 * A persisted workflow row returned by the Gateway CRUD endpoints.
 *
 * Shape matches `WorkflowDefinitionRepository._row_to_dict`: every DB column,
 * with `metadata` mapped from the ORM `def_metadata` attribute and
 * `created_at` / `updated_at` / `resolved_at` coerced to ISO strings.
 */
export type WorkflowRecord = {
  id: string;
  user_id: string;
  name: string;
  folder_id?: string | null;
  schema_version: number;
  definition: WorkflowDefinition;
  metadata: Record<string, unknown>;
  version: string;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
};
