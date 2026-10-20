"use client";

import {
  useEdgesState,
  useNodesState,
  type EdgeChange,
  type NodeChange,
} from "@xyflow/react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { toast } from "sonner";

import { useI18n } from "@/core/i18n/hooks";
import {
  definitionToFlow,
  flowToDefinition,
  type PositionsMap,
  type RFEdge,
  type RFNode,
} from "@/core/workflows/canvas/mapping";
import type { WorkflowNode } from "@/core/workflows/canvas/types";
import type { WorkflowValidationError } from "@/core/workflows/errors";
import {
  createInitialRunState,
  workflowRunReducer,
  type WorkflowRunState,
} from "@/core/workflows/run-state";
import { cancelWorkflowRun, streamWorkflowRun } from "@/core/workflows/runs";
import type {
  WorkflowDefinition,
  WorkflowRecord,
} from "@/core/workflows/types";

/**
 * Shared editor state for the workflow canvas page.
 *
 * Nodes/edges are React Flow state (`useNodesState`/`useEdgesState`) so the
 * canvas can feed its `onNodesChange`/`onEdgesChange` straight through, while
 * selection, validation errors, the dirty flag and the readonly mode live in
 * plain state. The provider is mounted once per workflow record in
 * `[id]/page.tsx`; the canvas, toolbar and properties panel all read from it.
 */
type WorkflowEditorContextValue = {
  workflowId: string;
  definition: WorkflowDefinition;
  nodes: RFNode[];
  edges: RFEdge[];
  setNodes: Dispatch<SetStateAction<RFNode[]>>;
  setEdges: Dispatch<SetStateAction<RFEdge[]>>;
  onNodesChange: (changes: NodeChange<RFNode>[]) => void;
  onEdgesChange: (changes: EdgeChange<RFEdge>[]) => void;
  /** Canvas position snapshot used as the save-time baseline. */
  positions: PositionsMap;
  updatePositions: (next: PositionsMap) => void;
  /**
   * Remove canvas positions for deleted nodes so a save never persists
   * ghost keys under `metadata.canvas.positions`.
   */
  prunePositions: (nodeIds: Iterable<string>) => void;
  selectedNode: RFNode | null;
  selectNode: (id: string | null) => void;
  /** Backend 422 validation errors, surfaced by the toolbar error strip. */
  errors: WorkflowValidationError[];
  setErrors: (errors: WorkflowValidationError[]) => void;
  dirty: boolean;
  markDirty: () => void;
  markSaved: () => void;
  readonly: boolean;
  updateNodeParams: (nodeId: string, params: Record<string, unknown>) => void;
  /**
   * Replace a node's whole definition payload (top-level fields such as
   * `agent_name`/`capability_groups` plus `params`) — used by the typed node
   * forms where a params-only write would drop the top-level fields.
   */
  updateNode: (nodeId: string, next: WorkflowNode) => void;
  /** Current canvas as a definition (unsaved edits included). */
  currentDefinition: () => WorkflowDefinition;
  deleteNode: (nodeId: string) => void;
  /** Runtime run state for the current workflow (painted on the canvas). */
  runState: WorkflowRunState;
  isRunning: boolean;
  /**
   * Start a run of the saved definition. `debugStep` asks the engine to pause
   * before **every** node (§25 single-step), so the operator advances one node
   * per resume; the flag is run-level and never written into the definition.
   */
  startRun: (options?: { debugStep?: boolean }) => Promise<void>;
  cancelRun: () => Promise<void>;
  clearRun: () => void;
};

const WorkflowEditorContext = createContext<WorkflowEditorContextValue | null>(
  null,
);

export function useWorkflowEditor(): WorkflowEditorContextValue {
  const value = useContext(WorkflowEditorContext);
  if (!value) {
    throw new Error(
      "useWorkflowEditor must be used within a WorkflowEditorProvider",
    );
  }
  return value;
}

/** Run-control slice of the editor context, exposed to run-aware consumers. */
export function useWorkflowRun(): {
  runState: WorkflowRunState;
  isRunning: boolean;
  startRun: (options?: { debugStep?: boolean }) => Promise<void>;
  cancelRun: () => Promise<void>;
  clearRun: () => void;
} {
  const { runState, isRunning, startRun, cancelRun, clearRun } =
    useWorkflowEditor();
  return { runState, isRunning, startRun, cancelRun, clearRun };
}

/** Node/edge changes that mutate the document (selection/dimensions do not). */
const MODIFYING_NODE_CHANGE_TYPES = new Set([
  "add",
  "remove",
  "replace",
  "position",
]);
const MODIFYING_EDGE_CHANGE_TYPES = new Set(["add", "remove", "replace"]);

export function WorkflowEditorProvider({
  record,
  readonly = false,
  children,
}: {
  record: WorkflowRecord;
  readonly?: boolean;
  children: ReactNode;
}) {
  const [nodes, setNodes, baseOnNodesChange] = useNodesState<RFNode>([]);
  const [edges, setEdges, baseOnEdgesChange] = useEdgesState<RFEdge>([]);
  const [positions, setPositions] = useState<PositionsMap>({});
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [errors, setErrors] = useState<WorkflowValidationError[]>([]);
  const [dirty, setDirty] = useState(false);

  // Seed the canvas from the persisted definition exactly once. Later
  // background refetches of the same record must not wipe in-progress edits.
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current) {
      return;
    }
    seededRef.current = true;
    const flow = definitionToFlow(record.definition);
    setNodes(flow.nodes);
    setEdges(flow.edges);
    setPositions(flow.positions);
  }, [record.definition, setEdges, setNodes]);

  const markDirty = useCallback(() => {
    setDirty(true);
  }, []);
  const markSaved = useCallback(() => {
    setDirty(false);
  }, []);

  const onNodesChange = useCallback(
    (changes: NodeChange<RFNode>[]) => {
      baseOnNodesChange(changes);
      if (
        changes.some((change) => MODIFYING_NODE_CHANGE_TYPES.has(change.type))
      ) {
        markDirty();
      }
    },
    [baseOnNodesChange, markDirty],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange<RFEdge>[]) => {
      baseOnEdgesChange(changes);
      if (
        changes.some((change) => MODIFYING_EDGE_CHANGE_TYPES.has(change.type))
      ) {
        markDirty();
      }
    },
    [baseOnEdgesChange, markDirty],
  );

  const updatePositions = useCallback((next: PositionsMap) => {
    setPositions((current) => ({ ...current, ...next }));
  }, []);

  const prunePositions = useCallback((nodeIds: Iterable<string>) => {
    const removed = new Set(nodeIds);
    if (removed.size === 0) {
      return;
    }
    setPositions((current) => {
      const next = { ...current };
      for (const id of removed) {
        delete next[id];
      }
      return next;
    });
  }, []);

  const selectNode = useCallback((id: string | null) => {
    setSelectedNodeId(id);
  }, []);

  const updateNodeParams = useCallback(
    (nodeId: string, params: Record<string, unknown>) => {
      setNodes((current) =>
        current.map((node) =>
          node.id === nodeId && node.data?.workflow
            ? { ...node, data: { workflow: { ...node.data.workflow, params } } }
            : node,
        ),
      );
      markDirty();
    },
    [markDirty, setNodes],
  );

  const updateNode = useCallback(
    (nodeId: string, next: WorkflowNode) => {
      setNodes((current) =>
        current.map((node) =>
          node.id === nodeId ? { ...node, data: { workflow: next } } : node,
        ),
      );
      // Dynamic ports (capability merge) must not leave dangling edges behind.
      const outputPorts = new Set(next.outputs.map((port) => port.name));
      const inputPorts = new Set(next.inputs.map((port) => port.name));
      setEdges((current) =>
        current.filter((edge) => {
          if (
            edge.source === nodeId &&
            !outputPorts.has(edge.sourceHandle ?? "")
          ) {
            return false;
          }
          if (
            edge.target === nodeId &&
            !inputPorts.has(edge.targetHandle ?? "")
          ) {
            return false;
          }
          return true;
        }),
      );
      markDirty();
    },
    [markDirty, setEdges, setNodes],
  );

  const currentDefinition = useCallback(
    () =>
      flowToDefinition({ nodes, edges }, { def: record.definition, positions })
        .definition,
    [edges, nodes, positions, record.definition],
  );

  const deleteNode = useCallback(
    (nodeId: string) => {
      setNodes((current) => current.filter((node) => node.id !== nodeId));
      setEdges((current) =>
        current.filter(
          (edge) => edge.source !== nodeId && edge.target !== nodeId,
        ),
      );
      prunePositions([nodeId]);
      setSelectedNodeId((current) => (current === nodeId ? null : current));
      markDirty();
    },
    [markDirty, prunePositions, setEdges, setNodes],
  );

  // --- Runtime run state ---------------------------------------------------
  const workflowId = record.id;
  const { t } = useI18n();

  const [runState, dispatchRun] = useReducer(
    workflowRunReducer,
    undefined,
    createInitialRunState,
  );
  // runId must be readable synchronously from cancelRun (dispatch is async).
  const runIdRef = useRef<string | null>(null);
  // Guards against double-starts before the state update lands.
  const runActiveRef = useRef(false);
  // Set by a successful cancel; wins the terminal-status decision at stream end.
  const cancelledRef = useRef(false);

  const startRun = useCallback(
    async (options?: { debugStep?: boolean }) => {
      if (runActiveRef.current) {
        return;
      }
      runActiveRef.current = true;
      cancelledRef.current = false;
      runIdRef.current = null;
      // The run id is unknown until the stream's metadata frame arrives; the
      // reducer treats the empty placeholder as unset and lets metadata fill it.
      dispatchRun({ type: "run-started", runId: "" });
      let sawFailure = false;
      try {
        // A plain run sends no body at all; only the step control adds the
        // run-level debug flag.
        const stream = options?.debugStep
          ? streamWorkflowRun(workflowId, { debug_step: true })
          : streamWorkflowRun(workflowId);
        for await (const event of stream) {
          if (event.type === "metadata") {
            runIdRef.current = event.runId;
          } else if (event.type === "node-failed" || event.type === "error") {
            sawFailure = true;
          }
          dispatchRun({ type: "stream-event", event });
        }
        dispatchRun({
          type: "run-ended",
          finalStatus: cancelledRef.current
            ? "interrupted"
            : sawFailure
              ? "error"
              : "success",
        });
      } catch (error) {
        dispatchRun({
          type: "run-error",
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        runActiveRef.current = false;
      }
    },
    [workflowId],
  );

  const cancelRun = useCallback(async () => {
    const runId = runIdRef.current;
    if (!runId) {
      return;
    }
    try {
      await cancelWorkflowRun(workflowId, runId);
      cancelledRef.current = true;
    } catch {
      toast.error(t.workflows.run.cancelFailed);
    }
  }, [t, workflowId]);

  const clearRun = useCallback(() => {
    runIdRef.current = null;
    cancelledRef.current = false;
    runActiveRef.current = false;
    dispatchRun({ type: "reset" });
  }, []);

  const isRunning = runState.status === "running";

  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedNodeId) ?? null,
    [nodes, selectedNodeId],
  );

  const value = useMemo<WorkflowEditorContextValue>(
    () => ({
      workflowId,
      definition: record.definition,
      nodes,
      edges,
      setNodes,
      setEdges,
      onNodesChange,
      onEdgesChange,
      positions,
      updatePositions,
      prunePositions,
      selectedNode,
      selectNode,
      errors,
      setErrors,
      dirty,
      markDirty,
      markSaved,
      readonly,
      updateNodeParams,
      updateNode,
      currentDefinition,
      deleteNode,
      runState,
      isRunning,
      startRun,
      cancelRun,
      clearRun,
    }),
    [
      workflowId,
      record.definition,
      nodes,
      edges,
      setNodes,
      setEdges,
      onNodesChange,
      onEdgesChange,
      positions,
      updatePositions,
      prunePositions,
      selectedNode,
      selectNode,
      errors,
      setErrors,
      dirty,
      markDirty,
      markSaved,
      readonly,
      updateNodeParams,
      updateNode,
      currentDefinition,
      deleteNode,
      runState,
      isRunning,
      startRun,
      cancelRun,
      clearRun,
    ],
  );

  return (
    <WorkflowEditorContext.Provider value={value}>
      {children}
    </WorkflowEditorContext.Provider>
  );
}
