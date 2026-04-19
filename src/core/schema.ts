import { z } from "zod";
import type { NodeKind } from "./types.js";

const semverish = z
  .string()
  .min(1)
  .regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, "Expected semver-like x.y.z");

export const NodeKindSchema: z.ZodType<NodeKind> = z.enum([
  "trigger.manual",
  "transform.score",
  "report.aggregate",
  "action.connector",
  "sink.eln_sim"
]);

export const WorkflowNodeSchema = z.object({
  id: z.string().min(1),
  kind: NodeKindSchema,
  name: z.string().min(1).optional(),
  config: z.record(z.string(), z.unknown()).optional()
});

export const WorkflowEdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1)
});

export const WorkflowSchema = z.object({
  id: z.string().min(1),
  version: semverish,
  nodes: z.array(WorkflowNodeSchema).min(1),
  edges: z.array(WorkflowEdgeSchema),
  env: z.record(z.string(), z.string()).optional(),
  compliance: z.enum(["GLP", "GMP", "Research"]).optional(),
  seed: z.string().min(1).optional()
});

export type WorkflowInput = z.input<typeof WorkflowSchema>;
