import type { Workflow } from "./types.js";
import { WorkflowSchema } from "./schema.js";

export interface ValidationIssue {
  path: string;
  message: string;
}

export function validateWorkflow(input: unknown): {
  ok: boolean;
  workflow?: Workflow;
  issues: ValidationIssue[];
} {
  const parsed = WorkflowSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message
      }))
    };
  }

  const workflow = parsed.data;
  const issues: ValidationIssue[] = [];

  const nodeIds = new Set(workflow.nodes.map((n) => n.id));
  if (nodeIds.size !== workflow.nodes.length) {
    issues.push({ path: "nodes", message: "Duplicate node ids are not allowed" });
  }

  for (const [idx, edge] of workflow.edges.entries()) {
    if (!nodeIds.has(edge.from)) {
      issues.push({ path: `edges.${idx}.from`, message: `Unknown node id: ${edge.from}` });
    }
    if (!nodeIds.has(edge.to)) {
      issues.push({ path: `edges.${idx}.to`, message: `Unknown node id: ${edge.to}` });
    }
    if (edge.from === edge.to) {
      issues.push({ path: `edges.${idx}`, message: "Self edges are not allowed" });
    }
  }

  // Basic DAG cycle detection via Kahn's algorithm.
  const indegree = new Map<string, number>();
  for (const id of nodeIds) indegree.set(id, 0);
  for (const edge of workflow.edges) indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  const queue: string[] = [];
  for (const [id, deg] of indegree.entries()) if (deg === 0) queue.push(id);
  const visited: string[] = [];
  const outgoing = new Map<string, string[]>();
  for (const edge of workflow.edges) {
    const arr = outgoing.get(edge.from) ?? [];
    arr.push(edge.to);
    outgoing.set(edge.from, arr);
  }

  while (queue.length) {
    const id = queue.shift()!;
    visited.push(id);
    for (const to of outgoing.get(id) ?? []) {
      const next = (indegree.get(to) ?? 0) - 1;
      indegree.set(to, next);
      if (next === 0) queue.push(to);
    }
  }
  if (visited.length !== nodeIds.size) {
    issues.push({ path: "edges", message: "Workflow graph contains a cycle" });
  }

  const triggerCount = workflow.nodes.filter((n) => n.kind.startsWith("trigger.")).length;
  if (triggerCount === 0) {
    issues.push({ path: "nodes", message: "At least one trigger node is required" });
  }

  return { ok: issues.length === 0, workflow, issues };
}

export function assertValidWorkflow(input: unknown): Workflow {
  const res = validateWorkflow(input);
  if (!res.ok || !res.workflow) {
    const lines = res.issues.map((i) => `- ${i.path}: ${i.message}`).join("\n");
    throw new Error(`Invalid workflow:\n${lines}`);
  }
  return res.workflow;
}

