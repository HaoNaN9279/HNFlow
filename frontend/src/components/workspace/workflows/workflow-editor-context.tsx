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
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";

import {
  definitionToFlow,
  type PositionsMap,
  type RFEdge,
  type RFNode,
} from "@/core/workflows/canvas/mapping";
import type { WorkflowValidationError } from "@/core/workflows/errors";
import type { WorkflowDefinition, WorkflowRecord } from "@/core/workflows/types";

/**
 * Shared editor state for the workflow canvas page.
 *
 * Nodes/edges are React Flow state (`useNodesState`/`useEdgesState`) so the
 * canvas can feed its `onNodesChange`/`onEdgesChange` straight through, while
 * selection, validation errors, the dirty flag and the readonly mode live in
 * plain state. The provider is mounted once per workflow record in
 * `[id]/page.tsx`; the canvas, palette, toolbar and properties panel all read
 * from it.
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
  deleteNode: (nodeId: string) => void;
};

const WorkflowEditorContext =
  createContext<WorkflowEditorContextValue | null>(null);

export function useWorkflowEditor(): WorkflowEditorContextValue {
  const value = useContext(WorkflowEditorContext);
  if (!value) {
    throw new Error(
      "useWorkflowEditor must be used within a WorkflowEditorProvider",
    );
  }
  return value;
}

/** Node/edge changes that mutate the document (selection/dimensions do not). */
const MODIFYING_NODE_CHANGE_TYPES = new Set(["add", "remove", "replace", "position"]);
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
      if (changes.some((change) => MODIFYING_NODE_CHANGE_TYPES.has(change.type))) {
        markDirty();
      }
    },
    [baseOnNodesChange, markDirty],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange<RFEdge>[]) => {
      baseOnEdgesChange(changes);
      if (changes.some((change) => MODIFYING_EDGE_CHANGE_TYPES.has(change.type))) {
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

  const deleteNode = useCallback(
    (nodeId: string) => {
      setNodes((current) => current.filter((node) => node.id !== nodeId));
      setEdges((current) =>
        current.filter((edge) => edge.source !== nodeId && edge.target !== nodeId),
      );
      prunePositions([nodeId]);
      setSelectedNodeId((current) => (current === nodeId ? null : current));
      markDirty();
    },
    [markDirty, prunePositions, setEdges, setNodes],
  );

  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedNodeId) ?? null,
    [nodes, selectedNodeId],
  );

  const value = useMemo<WorkflowEditorContextValue>(
    () => ({
      workflowId: record.id,
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
      deleteNode,
    }),
    [
      record.id,
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
      deleteNode,
    ],
  );

  return (
    <WorkflowEditorContext.Provider value={value}>
      {children}
    </WorkflowEditorContext.Provider>
  );
}
