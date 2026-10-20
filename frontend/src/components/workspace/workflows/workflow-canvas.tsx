"use client";

import {
  addEdge,
  ConnectionMode,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type IsValidConnection,
  type NodeChange,
  type NodeMouseHandler,
  type NodeTypes,
  type OnEdgesChange,
  type OnEdgesDelete,
  type OnNodeDrag,
  type OnNodesChange,
  type OnNodesDelete,
  type OnSelectionChangeFunc,
} from "@xyflow/react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { toast } from "sonner";

import { Canvas } from "@/components/ai-elements/canvas";
import { useI18n } from "@/core/i18n/hooks";
import {
  copySelection,
  pasteClipboard,
  type WorkflowClipboard,
} from "@/core/workflows/canvas/clipboard";
import {
  makeEdgeId,
  type RFEdge,
  type RFNode,
} from "@/core/workflows/canvas/mapping";
import { getDefaultNode } from "@/core/workflows/canvas/node-catalog";
import {
  REASON_PORT_NOT_FOUND,
  REASON_PORT_TYPE_MISMATCH,
  REASON_SELF_CONNECTION,
  validateConnection,
  type ConnectionCandidate,
} from "@/core/workflows/canvas/validation";
import { NODE_TYPES, type NodeType } from "@/core/workflows/types";

import {
  WorkflowContextMenu,
  type WorkflowContextMenuState,
} from "./workflow-context-menu";
import { useWorkflowEditor } from "./workflow-editor-context";
import { WorkflowNode } from "./workflow-node";
import { WorkflowNodeCatalogDialog } from "./workflow-node-catalog-dialog";

/** Every catalog node type renders through the same custom node component. */
const nodeTypes: NodeTypes = Object.fromEntries(
  NODE_TYPES.map((type) => [type, WorkflowNode]),
);

type CatalogState = {
  open: boolean;
  position: { x: number; y: number };
};

function reasonToMessage(
  reason: string,
  t: ReturnType<typeof useI18n>["t"],
): string {
  switch (reason) {
    case REASON_SELF_CONNECTION:
      return t.workflows.errors.selfConnection;
    case REASON_PORT_NOT_FOUND:
      return t.workflows.errors.missingPort;
    case REASON_PORT_TYPE_MISMATCH:
      return t.workflows.errors.portTypeMismatch;
    default:
      return reason;
  }
}

function CanvasInner() {
  const { t } = useI18n();
  const { screenToFlowPosition } = useReactFlow();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const {
    nodes,
    edges,
    setNodes,
    setEdges,
    onNodesChange,
    onEdgesChange,
    updatePositions,
    prunePositions,
    selectedNode,
    selectNode,
    errors,
    markDirty,
    readonly,
  } = useWorkflowEditor();
  const [catalog, setCatalog] = useState<CatalogState>({
    open: false,
    position: { x: 0, y: 0 },
  });
  const [contextMenu, setContextMenu] =
    useState<WorkflowContextMenuState | null>(null);
  const [clipboard, setClipboard] = useState<WorkflowClipboard | null>(null);

  // The ai-elements `Canvas` wrapper is not generic, so React Flow callbacks
  // are typed against the base Node/Edge. Narrowing to the workflow node shape
  // (`data.workflow`) happens at the handler boundary.
  const nodesChangeAdapter: OnNodesChange = useCallback(
    (changes) => {
      onNodesChange(changes as NodeChange<RFNode>[]);
    },
    [onNodesChange],
  );

  const edgesChangeAdapter: OnEdgesChange = useCallback(
    (changes) => {
      onEdgesChange(changes as EdgeChange<RFEdge>[]);
    },
    [onEdgesChange],
  );

  const handleConnect = useCallback(
    (connection: Connection) => {
      const result = validateConnection(connection, nodes);
      if (!result.ok) {
        toast.error(reasonToMessage(result.reason, t));
        return;
      }
      const edge: RFEdge = {
        id: makeEdgeId(
          connection.source,
          connection.sourceHandle ?? "",
          connection.target,
          connection.targetHandle ?? "",
        ),
        source: connection.source,
        sourceHandle: connection.sourceHandle,
        target: connection.target,
        targetHandle: connection.targetHandle,
        data: {},
      };
      setEdges((current) => addEdge(edge, current));
      markDirty();
    },
    [markDirty, nodes, setEdges, t],
  );

  // D5: same-type port validation. React Flow consults this while dragging a
  // connection and rejects incompatible targets live.
  const isValidConnection: IsValidConnection = useCallback(
    (edge) => {
      const candidate: ConnectionCandidate = {
        source: edge.source,
        sourceHandle: edge.sourceHandle,
        target: edge.target,
        targetHandle: edge.targetHandle,
      };
      return validateConnection(candidate, nodes).ok;
    },
    [nodes],
  );

  const handleCreateNode = useCallback(
    (type: NodeType) => {
      const workflowNode = getDefaultNode(type);
      const newNode: RFNode = {
        id: workflowNode.id,
        type: workflowNode.type,
        position: catalog.position,
        data: { workflow: workflowNode },
      };
      setNodes((current) => current.concat(newNode));
      setCatalog((current) => ({ ...current, open: false }));
      selectNode(newNode.id);
      markDirty();
    },
    [catalog.position, markDirty, selectNode, setNodes],
  );

  const handlePaneClick = useCallback(() => {
    setContextMenu(null);
  }, []);

  // Double-clicking empty canvas space opens the catalog at that point. This
  // is a native pane listener rather than `onPaneClick`: React Flow's click
  // callback does not preserve the browser's double-click detail reliably, and
  // its own zoom-on-double-click is disabled by the Canvas wrapper.
  useEffect(() => {
    const root = wrapperRef.current;
    if (!root) {
      return;
    }

    const handleDoubleClick = (event: Event) => {
      if (readonly) {
        return;
      }
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      if (
        target.closest(
          ".react-flow__node, .react-flow__edge, .react-flow__handle, .react-flow__panel, .react-flow__controls",
        )
      ) {
        return;
      }
      if (
        !target.closest(".react-flow__pane") &&
        !target.closest(".react-flow__background")
      ) {
        return;
      }
      const mouse = event as MouseEvent;
      setCatalog({
        open: true,
        position: screenToFlowPosition({
          x: mouse.clientX,
          y: mouse.clientY,
        }),
      });
    };

    root.addEventListener("dblclick", handleDoubleClick);
    return () => root.removeEventListener("dblclick", handleDoubleClick);
  }, [readonly, screenToFlowPosition]);

  const menuSelectionIds = useCallback((): string[] => {
    if (!contextMenu?.nodeId) {
      return [];
    }
    const target = nodes.find((node) => node.id === contextMenu.nodeId);
    if (!target) {
      return [];
    }
    if (!target.selected) {
      return [target.id];
    }
    return nodes.filter((node) => node.selected).map((node) => node.id);
  }, [contextMenu, nodes]);

  const handleCopy = useCallback(() => {
    const payload = copySelection(nodes, edges, menuSelectionIds());
    if (payload) {
      setClipboard(payload);
    }
    setContextMenu(null);
  }, [edges, menuSelectionIds, nodes]);

  const handleCut = useCallback(() => {
    const ids = menuSelectionIds();
    const payload = copySelection(nodes, edges, ids);
    if (!payload) {
      setContextMenu(null);
      return;
    }
    const removed = new Set(ids);
    setClipboard(payload);
    setNodes((current) => current.filter((node) => !removed.has(node.id)));
    setEdges((current) =>
      current.filter(
        (edge) => !removed.has(edge.source) && !removed.has(edge.target),
      ),
    );
    prunePositions(removed);
    if (selectedNode != null && removed.has(selectedNode.id)) {
      selectNode(null);
    }
    markDirty();
    setContextMenu(null);
  }, [
    edges,
    markDirty,
    menuSelectionIds,
    nodes,
    prunePositions,
    selectNode,
    selectedNode,
    setEdges,
    setNodes,
  ]);

  const handlePaste = useCallback(() => {
    if (!contextMenu || !clipboard) {
      return;
    }
    const contextNode =
      contextMenu.nodeId != null
        ? nodes.find((node) => node.id === contextMenu.nodeId)
        : undefined;
    const position = contextNode
      ? {
          x: contextNode.position.x + 32,
          y: contextNode.position.y + 32,
        }
      : screenToFlowPosition({
          x: contextMenu.x,
          y: contextMenu.y,
        });
    const pasted = pasteClipboard(
      clipboard,
      position,
      nodes.map((node) => node.id),
    );
    setNodes((current) => [
      ...current.map((node) => ({ ...node, selected: false })),
      ...pasted.nodes,
    ]);
    setEdges((current) => [...current, ...pasted.edges]);
    selectNode(pasted.nodes[0]?.id ?? null);
    markDirty();
    setContextMenu(null);
  }, [
    clipboard,
    contextMenu,
    markDirty,
    nodes,
    screenToFlowPosition,
    selectNode,
    setEdges,
    setNodes,
  ]);

  const handleNodeContextMenu: NodeMouseHandler = useCallback(
    (event, node) => {
      event.preventDefault();
      if (readonly) {
        return;
      }
      setContextMenu({
        x: event.clientX,
        y: event.clientY,
        nodeId: node.id,
      });
    },
    [readonly],
  );

  const handlePaneContextMenu = useCallback(
    (event: ReactMouseEvent | MouseEvent) => {
      event.preventDefault();
      if (readonly) {
        return;
      }
      setContextMenu({
        x: event.clientX,
        y: event.clientY,
        nodeId: null,
      });
    },
    [readonly],
  );

  // Position changes already flow into `nodes` through `onNodesChange`; this
  // keeps the save-time baseline snapshot in sync as well.
  const handleNodeDragStop: OnNodeDrag = useCallback(
    (_event, node) => {
      const rfNode = node as RFNode;
      updatePositions({
        [rfNode.id]: { x: rfNode.position.x, y: rfNode.position.y },
      });
      markDirty();
    },
    [markDirty, updatePositions],
  );

  const handleNodesDelete: OnNodesDelete = useCallback(
    (deleted) => {
      if (deleted.length === 0) {
        return;
      }
      const deletedIds = new Set(deleted.map((node) => node.id));
      setEdges((current) =>
        current.filter(
          (edge) =>
            !deletedIds.has(edge.source) && !deletedIds.has(edge.target),
        ),
      );
      // D1: prune the canvas positions of the deleted nodes so a later save
      // does not persist ghost keys under metadata.canvas.positions.
      prunePositions(deletedIds);
      if (selectedNode != null && deletedIds.has(selectedNode.id)) {
        selectNode(null);
      }
      markDirty();
    },
    [markDirty, prunePositions, selectNode, selectedNode, setEdges],
  );

  const handleEdgesDelete: OnEdgesDelete = useCallback(() => {
    markDirty();
  }, [markDirty]);

  const handleSelectionChange: OnSelectionChangeFunc = useCallback(
    ({ nodes: selected }) => {
      selectNode(selected[0]?.id ?? null);
    },
    [selectNode],
  );

  // Errors already light up individual nodes through the custom node
  // component; this set is used by the E2E data attributes on the pane.
  const nodeIdsWithErrors = useMemo(
    () =>
      new Set(
        errors
          .filter((error) => error.type === "node" && error.id != null)
          .map((error) => error.id!),
      ),
    [errors],
  );

  return (
    <div ref={wrapperRef} className="min-h-0 min-w-0 flex-1">
      {/* Middle-button drag pans; left drag remains box selection. */}
      <Canvas
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={nodesChangeAdapter}
        onEdgesChange={edgesChangeAdapter}
        onConnect={handleConnect}
        isValidConnection={isValidConnection}
        onNodeDragStop={handleNodeDragStop}
        onNodesDelete={handleNodesDelete}
        onEdgesDelete={handleEdgesDelete}
        onSelectionChange={handleSelectionChange}
        onNodeContextMenu={handleNodeContextMenu}
        onPaneContextMenu={handlePaneContextMenu}
        onPaneClick={handlePaneClick}
        connectionMode={ConnectionMode.Strict}
        panOnDrag={[1]}
        nodesDraggable={!readonly}
        nodesConnectable={!readonly}
        elementsSelectable={!readonly}
        edgesReconnectable={!readonly}
        deleteKeyCode={readonly ? null : ["Backspace", "Delete"]}
        snapToGrid
        snapGrid={[16, 16]}
        className="h-full w-full"
        data-error-node-count={nodeIdsWithErrors.size}
      />
      <WorkflowNodeCatalogDialog
        open={catalog.open}
        onOpenChange={(open) => setCatalog((current) => ({ ...current, open }))}
        onSelect={handleCreateNode}
      />
      {contextMenu && (
        <WorkflowContextMenu
          state={contextMenu}
          canPaste={clipboard != null}
          onCopy={handleCopy}
          onCut={handleCut}
          onPaste={handlePaste}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}

/**
 * The canvas itself. Wrapped in `ReactFlowProvider` so `useReactFlow`
 * (`screenToFlowPosition`) works inside the catalog and paste handlers.
 */
export function WorkflowCanvas() {
  return (
    <ReactFlowProvider>
      <CanvasInner />
    </ReactFlowProvider>
  );
}
