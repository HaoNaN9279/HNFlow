/**
 * Shared Drag & Drop contract between the palette (producer) and the canvas
 * (consumer). The palette stores the node type under this MIME-ish key, the
 * canvas reads it back on drop.
 */
export const WORKFLOW_NODE_DRAG_DATA_TYPE = "application/hnflow-node-type";
