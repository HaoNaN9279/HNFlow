/**
 * Canvas connection/workflow validation —frontend mirror of the backend
 * `deerflow.workflow.workflow_io.validate_definition` core checks.
 *
 * - `isPortCompatible` is strict same-type matching (the backend
 *   `ports_compatible` contract: data↔file↔bool↔enum never mix).
 * - `validateConnection` guards live canvas drag-connections.
 * - `validateWorkflow` validates a whole definition: exactly one start/end,
 *   every edge references existing nodes/ports, and connected port types
 *   match. Cycle detection is intentionally left to the backend (a frontend
 *   soft warning only); the compiler is the hard gate.
 *
 * Error `reason`/`code` values are i18n dictionary keys
 * (namespace `workflows.errors.*`).
 */

import type { PortType, WorkflowDefinition } from "@/core/workflows/types";

import type { RFNode } from "./mapping";

export { PORT_TYPES } from "@/core/workflows/types";

export const REASON_SELF_CONNECTION = "workflows.errors.selfConnection";
export const REASON_PORT_NOT_FOUND = "workflows.errors.portNotFound";
export const REASON_PORT_TYPE_MISMATCH = "workflows.errors.portTypeMismatch";

/** Strict same-type compatibility —mirrors the backend `ports_compatible`. */
export function isPortCompatible(src: PortType, dst: PortType): boolean {
  return src === dst;
}

/** A connection being attempted on the canvas (React Flow Connection shape). */
export type ConnectionCandidate = {
  source: string;
  sourceHandle: string | null | undefined;
  target: string;
  targetHandle: string | null | undefined;
};

export type ConnectionValidationResult =
  | { ok: true }
  | { ok: false; reason: string };

/** Validate a single canvas connection against the current node list. */
export function validateConnection(
  connection: ConnectionCandidate,
  nodes: RFNode[],
): ConnectionValidationResult {
  const { source, sourceHandle, target, targetHandle } = connection;

  if (source === target) {
    return { ok: false, reason: REASON_SELF_CONNECTION };
  }

  const sourceNode = nodes.find((n) => n.id === source);
  const targetNode = nodes.find((n) => n.id === target);
  const sourceWorkflow = sourceNode?.data?.workflow;
  const targetWorkflow = targetNode?.data?.workflow;
  if (!sourceWorkflow || !targetWorkflow) {
    return { ok: false, reason: REASON_PORT_NOT_FOUND };
  }

  const sourcePort = sourceWorkflow.outputs.find(
    (p) => p.name === sourceHandle,
  );
  const targetPort = targetWorkflow.inputs.find((p) => p.name === targetHandle);
  if (!sourcePort || !targetPort) {
    return { ok: false, reason: REASON_PORT_NOT_FOUND };
  }

  if (!isPortCompatible(sourcePort.type, targetPort.type)) {
    return { ok: false, reason: REASON_PORT_TYPE_MISMATCH };
  }

  return { ok: true };
}

/** A structural problem found in a workflow definition. */
export type WorkflowValidationError = {
  /** i18n dictionary key under `workflows.errors.*`. */
  code: string;
  /** Human-readable description (also used as the default UI text). */
  message: string;
  nodeId?: string;
  edgeIndex?: number;
};

const err = (
  code: string,
  message: string,
  extra?: { nodeId?: string; edgeIndex?: number },
): WorkflowValidationError => ({ code, message, ...extra });

/**
 * Validate the structural core of a definition.
 *
 * Mirrors the backend `validate_definition` checks: single start/end node,
 * edge references existing nodes and ports, and port type compatibility.
 * Cycle detection is backend-owned (a `flow:loop` may intentionally cycle).
 */
export function validateWorkflow(
  def: WorkflowDefinition,
): WorkflowValidationError[] {
  const errors: WorkflowValidationError[] = [];
  const nodeMap = new Map(def.nodes.map((n) => [n.id, n]));

  // ── Exactly one start / end, with the right edge directions ──────────────
  const startNodes = def.nodes.filter((n) => n.type === "flow:start");
  const endNodes = def.nodes.filter((n) => n.type === "flow:end");
  const incomingTargets = new Set(def.edges.map((e) => e.target));
  const outgoingSources = new Set(def.edges.map((e) => e.source));

  if (startNodes.length === 0) {
    errors.push(
      err(
        "workflows.errors.missingStartNode",
        "Workflow must contain exactly one flow:start node.",
      ),
    );
  } else if (startNodes.length > 1) {
    errors.push(
      err(
        "workflows.errors.multipleStartNodes",
        `Workflow contains ${startNodes.length} flow:start nodes; exactly one is required.`,
        {
          nodeId: startNodes[1]!.id,
        },
      ),
    );
  } else if (incomingTargets.has(startNodes[0]!.id)) {
    errors.push(
      err(
        "workflows.errors.startHasIncomingEdge",
        `flow:start node '${startNodes[0]!.id}' must not have incoming edges.`,
        {
          nodeId: startNodes[0]!.id,
        },
      ),
    );
  }

  if (endNodes.length === 0) {
    errors.push(
      err(
        "workflows.errors.missingEndNode",
        "Workflow must contain exactly one flow:end node.",
      ),
    );
  } else if (endNodes.length > 1) {
    errors.push(
      err(
        "workflows.errors.multipleEndNodes",
        `Workflow contains ${endNodes.length} flow:end nodes; exactly one is required.`,
        {
          nodeId: endNodes[1]!.id,
        },
      ),
    );
  } else if (outgoingSources.has(endNodes[0]!.id)) {
    errors.push(
      err(
        "workflows.errors.endHasOutgoingEdge",
        `flow:end node '${endNodes[0]!.id}' must not have outgoing edges.`,
        {
          nodeId: endNodes[0]!.id,
        },
      ),
    );
  }

  // ── Edge references and port type compatibility ─────────────────────────
  def.edges.forEach((edge, index) => {
    const src = nodeMap.get(edge.source);
    if (!src) {
      errors.push(
        err(
          "workflows.errors.edgeSourceNotFound",
          `Edge ${index} references unknown source node '${edge.source}'.`,
          { edgeIndex: index },
        ),
      );
      return;
    }
    const dst = nodeMap.get(edge.target);
    if (!dst) {
      errors.push(
        err(
          "workflows.errors.edgeTargetNotFound",
          `Edge ${index} references unknown target node '${edge.target}'.`,
          { edgeIndex: index },
        ),
      );
      return;
    }

    const srcPort = src.outputs.find((p) => p.name === edge.source_port);
    if (!srcPort) {
      errors.push(
        err(
          "workflows.errors.sourcePortNotFound",
          `Edge ${index} references unknown source port '${edge.source_port}' on '${edge.source}'.`,
          {
            edgeIndex: index,
          },
        ),
      );
    }
    const dstPort = dst.inputs.find((p) => p.name === edge.target_port);
    if (!dstPort) {
      errors.push(
        err(
          "workflows.errors.targetPortNotFound",
          `Edge ${index} references unknown target port '${edge.target_port}' on '${edge.target}'.`,
          {
            edgeIndex: index,
          },
        ),
      );
    }
    if (srcPort && dstPort && !isPortCompatible(srcPort.type, dstPort.type)) {
      errors.push(
        err(
          "workflows.errors.portTypeMismatch",
          `Edge ${index} connects incompatible port types ('${edge.source}.${edge.source_port}' is ${srcPort.type}, '${edge.target}.${edge.target_port}' is ${dstPort.type}).`,
          { edgeIndex: index },
        ),
      );
    }
  });

  return errors;
}
