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
  type NodeTypes,
  type OnEdgesChange,
  type OnEdgesDelete,
  type OnNodeDrag,
  type OnNodesChange,
  type OnNodesDelete,
  type OnSelectionChangeFunc,
} from "@xyflow/react";
import { useCallback, useMemo, useRef, type DragEvent } from "react";
import { toast } from "sonner";

import { Canvas } from "@/components/ai-elements/canvas";
import { Controls } from "@/components/ai-elements/controls";
import { useI18n } from "@/core/i18n/hooks";
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

import { WORKFLOW_NODE_DRAG_DATA_TYPE } from "./workflow-dnd";
import { useWorkflowEditor } from "./workflow-editor-context";
import { WorkflowNode } from "./workflow-node";

/** Every catalog node type renders through the same custom node component. */
const nodeTypes: NodeTypes = Object.fromEntries(
  NODE_TYPES.map((type) => [type, WorkflowNode]),
);

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

  const handleDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }, []);

  // D6: native DnD from the palette. The drop coordinates are converted from
  // screen space into flow coordinates so the node lands under the cursor.
  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      const type = event.dataTransfer.getData(
        WORKFLOW_NODE_DRAG_DATA_TYPE,
      ) as NodeType;
      if (!(NODE_TYPES as readonly string[]).includes(type)) {
        return;
      }
      const workflowNode = getDefaultNode(type);
      const position = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });
      const newNode: RFNode = {
        id: workflowNode.id,
        type: workflowNode.type,
        position,
        data: { workflow: workflowNode },
      };
      setNodes((current) => current.concat(newNode));
      markDirty();
    },
    [markDirty, screenToFlowPosition, setNodes],
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
      <Canvas
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={nodesChangeAdapter}
        onEdgesChange={edgesChangeAdapter}
        onConnect={handleConnect}
        isValidConnection={isValidConnection}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onNodeDragStop={handleNodeDragStop}
        onNodesDelete={handleNodesDelete}
        onEdgesDelete={handleEdgesDelete}
        onSelectionChange={handleSelectionChange}
        connectionMode={ConnectionMode.Strict}
        nodesDraggable={!readonly}
        nodesConnectable={!readonly}
        elementsSelectable={!readonly}
        edgesReconnectable={!readonly}
        deleteKeyCode={readonly ? null : ["Backspace", "Delete"]}
        snapToGrid
        snapGrid={[16, 16]}
        className="h-full w-full"
        data-error-node-count={nodeIdsWithErrors.size}
      >
        <Controls />
      </Canvas>
    </div>
  );
}

/**
 * The canvas itself. Wrapped in `ReactFlowProvider` so `useReactFlow`
 * (`screenToFlowPosition`) works inside the drop handler.
 */
export function WorkflowCanvas() {
  return (
    <ReactFlowProvider>
      <CanvasInner />
    </ReactFlowProvider>
  );
}
