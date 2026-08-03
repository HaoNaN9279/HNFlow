// Zod schemas：fromJSON 边界校验，字段与 types.ts 契约对齐。
import { z } from "zod";

const variablePathRegex = /^[^:]+:.+/; // 格式 "scope:key"

export const portSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(["string", "number", "boolean", "any"]),
  direction: z.enum(["in", "out"]),
  binding: z
    .string()
    .regex(variablePathRegex, 'binding 必须是 "scope:key" 格式')
    .optional(),
});

export const nodeSchema = z.object({
  id: z.string(),
  type: z.string(),
  name: z.string(),
  params: z.record(z.string(), z.unknown()),
  inputs: z.array(portSchema),
  outputs: z.array(portSchema),
  position: z.object({ x: z.number(), y: z.number() }).optional(),
});

export const edgeSchema = z.object({
  id: z.string(),
  sourceNodeId: z.string(),
  sourcePortId: z.string(),
  targetNodeId: z.string(),
  targetPortId: z.string(),
});

export const workflowSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  nodes: z.array(nodeSchema),
  edges: z.array(edgeSchema),
  globalVariables: z.record(z.string(), z.unknown()).optional(),
});

export type WorkflowJSON = z.infer<typeof workflowSchema>;
