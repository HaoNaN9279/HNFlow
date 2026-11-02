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
  flowToDefinition,
  sanitizeFlowNode,
  type PositionsMap,
  type RFEdge,
  type RFNode,
} from "@/core/workflows/canvas/mapping";
import { normalizeNodeDisplayName } from "@/core/workflows/canvas/node-catalog";
import type { WorkflowNode } from "@/core/workflows/canvas/types";
import {
  clearWorkflowDraft,
  readWorkflowDraft,
  writeWorkflowDraft,
} from "@/core/workflows/editor-session";
import { embeddedSessionKey } from "@/core/workflows/embedded-subworkflow";
import type { WorkflowValidationError } from "@/core/workflows/errors";
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
type EmbeddedEditorTarget = {
  rootId: string;
  path: string[];
};

type WorkflowEditorContextValue = {
  workflowId: string;
  definition: WorkflowDefinition;
  /**
   * Set when this editor is a local subworkflow snapshot resolved from a root
   * workflow. Saving writes back into the root workflow's draft, not an API
   * record, and standalone runs are disabled.
   */
  embedded: EmbeddedEditorTarget | null;
  saveEmbedded: (definition: WorkflowDefinition) => Promise<void>;
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
  /** Drop the unsaved draft (and its tab-scoped copy) without saving. */
  discardDraft: () => void;
  /** Synchronously persist the current draft before navigating away. */
  flushDraft: () => void;
  readonly: boolean;
  updateNodeParams: (nodeId: string, params: Record<string, unknown>) => void;
  /**
   * Replace a node's whole definition payload (top-level fields such as
   * `agent_name`/`capability_groups` plus `params`) — used by the typed node
   * forms where a params-only write would drop the top-level fields.
   */
  updateNode: (nodeId: string, next: WorkflowNode) => void;
  /**
   * Set the canvas-only instance label. Blank input or the fixed catalog name
   * clears the override so the card falls back to the node's default name.
   */
  updateNodeDisplayName: (nodeId: string, displayName: string) => void;
  /** Current canvas as a definition (unsaved edits included). */
  currentDefinition: () => WorkflowDefinition;
  deleteNode: (nodeId: string) => void;
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
  embedded,
  children,
}: {
  record: WorkflowRecord;
  readonly?: boolean;
  embedded?: {
    rootId: string;
    path: string[];
    save: (definition: WorkflowDefinition) => Promise<void>;
  };
  children: ReactNode;
}) {
  const [nodes, setNodes, baseOnNodesChange] = useNodesState<RFNode>([]);
  const [edges, setEdges, baseOnEdgesChange] = useEdgesState<RFEdge>([]);
  const [positions, setPositions] = useState<PositionsMap>({});
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [errors, setErrors] = useState<WorkflowValidationError[]>([]);
  const [dirty, setDirty] = useState(false);
  // Local snapshots share the root workflow's storage; their child draft gets
  // a synthetic key so it never collides with the persisted child's draft.
  const sessionKey = embedded
    ? embeddedSessionKey(embedded.rootId, embedded.path)
    : record.id;

  // Seed the canvas from the persisted definition exactly once. Later
  // background refetches of the same record must not wipe in-progress edits.
  // A dirty draft from this browser tab wins: it is what the user was editing
  // before switching tabs.
  const seededRef = useRef(false);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    if (seededRef.current) {
      return;
    }
    seededRef.current = true;
    const draft = readWorkflowDraft(sessionKey);
    if (draft?.dirty) {
      setNodes(draft.nodes.map(sanitizeFlowNode));
      setEdges(draft.edges);
      setPositions(draft.positions);
      setDirty(true);
      setHydrated(true);
      return;
    }
    const flow = definitionToFlow(record.definition);
    setNodes(flow.nodes);
    setEdges(flow.edges);
    setPositions(flow.positions);
    setHydrated(true);
  }, [record.definition, sessionKey, setEdges, setNodes]);

  // Mirror unsaved edits into sessionStorage so switching workspace tabs (which
  // unmounts the editor) does not lose them. Clean editors have no draft.
  // Writes are debounced because dragging a node re-renders on every frame.
  const pendingDraftRef = useRef<{
    nodes: RFNode[];
    edges: RFEdge[];
    positions: PositionsMap;
    dirty: boolean;
  } | null>(null);
  // Mirror the latest render synchronously: a navigation can unmount before
  // the debounce effect has armed `pendingDraftRef`, and losing that draft
  // would also make a freshly toggled local subworkflow unresolvable.
  const latestDraftRef = useRef<{
    nodes: RFNode[];
    edges: RFEdge[];
    positions: PositionsMap;
    dirty: boolean;
  } | null>(null);
  latestDraftRef.current =
    hydrated && dirty ? { nodes, edges, positions, dirty } : null;
  useEffect(() => {
    if (!hydrated) {
      return;
    }
    if (!dirty) {
      pendingDraftRef.current = null;
      clearWorkflowDraft(sessionKey);
      return;
    }
    const draft = { nodes, edges, positions, dirty };
    pendingDraftRef.current = draft;
    const timer = setTimeout(() => {
      writeWorkflowDraft(sessionKey, draft);
    }, 200);
    return () => clearTimeout(timer);
  }, [dirty, edges, hydrated, nodes, positions, sessionKey]);

  useEffect(() => {
    return () => {
      const draft = pendingDraftRef.current ?? latestDraftRef.current;
      if (draft) {
        writeWorkflowDraft(sessionKey, draft);
      }
    };
  }, [sessionKey]);

  const markDirty = useCallback(() => {
    setDirty(true);
  }, []);
  const markSaved = useCallback(() => {
    // Clear the pending write first: a save-then-leave unmount must not write
    // the stale dirty draft back after the server accepted it.
    pendingDraftRef.current = null;
    setDirty(false);
    clearWorkflowDraft(sessionKey);
  }, [sessionKey]);
  const discardDraft = useCallback(() => {
    pendingDraftRef.current = null;
    latestDraftRef.current = null;
    setDirty(false);
    clearWorkflowDraft(sessionKey);
  }, [sessionKey]);
  const flushDraft = useCallback(() => {
    const draft = latestDraftRef.current;
    if (draft) {
      writeWorkflowDraft(sessionKey, draft);
    }
  }, [sessionKey]);

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

  const updateNodeDisplayName = useCallback(
    (nodeId: string, displayName: string) => {
      const node = nodes.find((item) => item.id === nodeId);
      if (!node?.data?.workflow) {
        return;
      }
      const next = normalizeNodeDisplayName(
        node.data.workflow.type,
        displayName,
      );
      if (node.data.displayName === next) {
        return;
      }
      setNodes((current) =>
        current.map((item) => {
          if (item.id !== nodeId || !item.data?.workflow) {
            return item;
          }
          const data = { ...item.data };
          if (next) {
            data.displayName = next;
          } else {
            delete data.displayName;
          }
          return { ...item, data };
        }),
      );
      markDirty();
    },
    [markDirty, nodes, setNodes],
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

  const workflowId = record.id;

  const saveEmbedded = useCallback(
    async (next: WorkflowDefinition) => {
      if (!embedded) {
        throw new Error("saveEmbedded requires an embedded editor");
      }
      await embedded.save(next);
    },
    [embedded],
  );

  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedNodeId) ?? null,
    [nodes, selectedNodeId],
  );

  const value = useMemo<WorkflowEditorContextValue>(
    () => ({
      workflowId,
      definition: record.definition,
      embedded: embedded
        ? { rootId: embedded.rootId, path: embedded.path }
        : null,
      saveEmbedded,
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
      discardDraft,
      flushDraft,
      readonly,
      updateNodeParams,
      updateNode,
      updateNodeDisplayName,
      currentDefinition,
      deleteNode,
    }),
    [
      workflowId,
      record.definition,
      embedded,
      saveEmbedded,
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
      discardDraft,
      flushDraft,
      readonly,
      updateNodeParams,
      updateNode,
      updateNodeDisplayName,
      currentDefinition,
      deleteNode,
    ],
  );

  return (
    <WorkflowEditorContext.Provider value={value}>
      {children}
    </WorkflowEditorContext.Provider>
  );
}
