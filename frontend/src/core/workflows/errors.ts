/**
 * Workflow validation error parsing.
 *
 * The Gateway returns 422 responses with `detail: { errors: string[] }`.
 * The strings come from two producers:
 *
 * - `backend/app/gateway/routers/workflow_routes.py::_format_validation_errors`
 *   (Pydantic v2 structure errors), shaped
 *   `"定义结构非法: <loc> — <msg>"` where `<loc>` is a dotted path like
 *   `nodes.3.inputs.0.type`.
 * - `backend/packages/harness/deerflow/workflow/workflow_io.py::validate_definition`
 *   (graph-structure errors), shaped `"edge[3]: ..."` or `"node 'A': ..."`.
 *
 * This module normalises both into structured entries so the UI can surface
 * per-node / per-edge messages. It never throws — unrecognised strings
 * degrade to `type: "unknown"`.
 */

export type WorkflowValidationError = {
  type: "node" | "edge" | "unknown";
  id?: string;
  message: string;
};

/** Raised by the workflows API when the backend answers 422 with an `errors` list. */
export class WorkflowValidationErrors extends Error {
  constructor(
    message: string,
    public readonly errors: WorkflowValidationError[],
  ) {
    super(message);
    this.name = "WorkflowValidationErrors";
  }
}

const EDGE_ERROR_PATTERN = /^edge\[(\d+)\]:\s*(.*)$/s;
const NODE_ERROR_PATTERN = /^node\s+'([^']+)':\s*(.*)$/s;
const STRUCTURAL_PREFIX = "定义结构非法: ";
const STRUCTURAL_SEPARATOR = "—";

function parseStructuralError(message: string): WorkflowValidationError {
  const body = message.slice(STRUCTURAL_PREFIX.length);
  const separatorIndex = body.indexOf(STRUCTURAL_SEPARATOR);
  const loc = (
    separatorIndex >= 0 ? body.slice(0, separatorIndex) : body
  ).trim();
  const parts = loc.split(".");
  for (let i = 0; i < parts.length - 1; i++) {
    const next = parts[i + 1];
    if (
      (parts[i] === "nodes" || parts[i] === "edges") &&
      next !== undefined &&
      /^\d+$/.test(next)
    ) {
      return {
        type: parts[i] === "nodes" ? "node" : "edge",
        id: next,
        message,
      };
    }
  }
  return { type: "unknown", message };
}

function parseWorkflowValidationError(
  message: string,
): WorkflowValidationError {
  const edgeMatch = EDGE_ERROR_PATTERN.exec(message);
  if (edgeMatch) {
    return { type: "edge", id: edgeMatch[1], message };
  }

  const nodeMatch = NODE_ERROR_PATTERN.exec(message);
  if (nodeMatch) {
    return { type: "node", id: nodeMatch[1], message };
  }

  if (message.startsWith(STRUCTURAL_PREFIX)) {
    return parseStructuralError(message);
  }

  return { type: "unknown", message };
}

/**
 * Parse the backend 422 `detail.errors` array into structured entries.
 *
 * Accepts `unknown` so API callers can feed an untyped response body without
 * pre-validating. Non-array input yields an empty array; non-string entries
 * are skipped. Never throws.
 */
export function parseWorkflowValidationErrors(
  detail: unknown,
): WorkflowValidationError[] {
  if (!Array.isArray(detail)) {
    return [];
  }
  const errors: WorkflowValidationError[] = [];
  for (const item of detail) {
    if (typeof item === "string") {
      errors.push(parseWorkflowValidationError(item));
    }
  }
  return errors;
}
