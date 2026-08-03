// Zod schemas：fromJSON 边界校验，字段与 types.ts 契约对齐。
import { z } from "zod";
import type { Node, Workflow } from "./types.js";

const variablePathRegex = /^[^:]+:.+/; // 格式 "scope:key"

export const portSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(["string", "number", "boolean", "any"]),
  direction: z.enum(["in", "out"]),
  binding: z
    .string()
    .regex(variablePathRegex, 'binding 必须是 "scope:key" 格式')
    .exactOptional(),
});

// node ↔ workflow 循环引用：显式标注类型（含子字段），z.lazy 惰性求值解运行时循环。
export const nodeSchema: z.ZodType<Node> = z.object({
  id: z.string(),
  type: z.string(),
  name: z.string(),
  params: z.record(z.string(), z.unknown()),
  inputs: z.array(portSchema),
  outputs: z.array(portSchema),
  position: z.object({ x: z.number(), y: z.number() }).exactOptional(),
  // 惰性引用 workflowSchema，解 node ↔ workflow 循环引用。
  subworkflow: z.lazy(() => workflowSchema).exactOptional(),
});

export const edgeSchema = z.object({
  id: z.string(),
  sourceNodeId: z.string(),
  sourcePortId: z.string(),
  targetNodeId: z.string(),
  targetPortId: z.string(),
});

export const workflowSchema: z.ZodType<Workflow> = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  nodes: z.array(nodeSchema),
  edges: z.array(edgeSchema),
  globalVariables: z.record(z.string(), z.unknown()).exactOptional(),
  draftOf: z.string().exactOptional(),
});

export type WorkflowJSON = z.infer<typeof workflowSchema>;
