import type { ExecutionRecord } from "./execution-record.js";
import type { Workflow } from "./types.js";
import { sha256Json } from "./hash.js";

// Check evidence completeness and consistency; an unkeyed hash chain does not
// authenticate the actor or prevent someone from rewriting all local evidence.
export function verifyExecutionAudit(record: ExecutionRecord, workflow: Workflow): string[] {
  const { execution, nodeRuns } = record;
  const { runId } = execution;
  const errors: string[] = [];
  const nodes = new Map(workflow.nodes.map((node) => [node.id, node]));
  const visited = new Set<string>();
  for (const [index, nodeRun] of nodeRuns.entries()) {
    const node = nodes.get(nodeRun.nodeId);
    if (!node || node.kind !== nodeRun.kind || visited.has(nodeRun.nodeId)) {
      errors.push(`Node run ${index} does not match a unique workflow node`);
    }
    if (workflow.edges.some((edge) => edge.to === nodeRun.nodeId && !visited.has(edge.from))) {
      errors.push(`Node run ${index} precedes a workflow dependency`);
    }
    visited.add(nodeRun.nodeId);
    const expectedStatus = execution.status === "failed" && index === nodeRuns.length - 1 ? "failed" : "ok";
    if (nodeRun.status !== expectedStatus) errors.push(`Node run ${index} has inconsistent status`);
  }
  if (execution.status === "completed") {
    if (visited.size !== nodes.size) errors.push("Node run evidence is incomplete for a completed workflow");
  } else if (execution.status === "failed") {
    if (nodeRuns.length === 0) errors.push("Node run evidence is missing for a failed workflow");
  } else {
    errors.push(`Audit evidence is not finalized for execution status ${execution.status}`);
  }
  if (execution.workflowId !== workflow.id || execution.workflowVersion !== workflow.version) {
    errors.push("Audit workflow identity does not match the stored workflow");
  }

  const expected: { action: string; details: Record<string, unknown> }[] = [
    { action: "execution_started", details: { runId, workflowId: execution.workflowId,
      workflowVersion: execution.workflowVersion } },
    { action: "workflow_snapshot", details: { runId, workflowDigest: execution.workflowDigest,
      workflowArtifact: `sha256:${execution.workflowDigest}` } },
    { action: "inputs_snapshot", details: { runId,
      inputs: execution.inputs.map(({ name, sha256, bytes }) => ({ name, sha256, bytes })) } }
  ];
  for (const node of nodeRuns) {
    const details = { runId, nodeId: node.nodeId, kind: node.kind };
    expected.push({ action: "node_started", details });
    expected.push(node.status === "failed"
      ? { action: "node_failed", details: { ...details, error: node.error } }
      : { action: "node_completed", details: { ...details,
          inputDigests: node.inputs.map((artifact) => artifact.sha256),
          outputDigests: node.outputs.map((artifact) => artifact.sha256), costUSD: node.costUSD } });
  }
  if (execution.status === "completed") {
    expected.push({ action: "execution_completed", details: {
      runId, costUSD: nodeRuns.reduce((total, node) => total + node.costUSD, 0)
    } });
  }
  if (execution.auditLog.length !== expected.length) {
    errors.push(`Audit event count mismatch: expected ${expected.length}, got ${execution.auditLog.length}`);
  }
  for (const [index, event] of expected.entries()) {
    const actual = execution.auditLog[index];
    if (!actual || actual.action !== event.action) {
      errors.push(`Audit event ${index}: expected ${event.action}`);
      continue;
    }
    for (const [key, value] of Object.entries(event.details)) {
      if (value === undefined || actual.details[key] === undefined ||
          sha256Json(actual.details[key]) !== sha256Json(value)) {
        errors.push(`Audit event ${index} (${event.action}): inconsistent ${key}`);
      }
    }
  }
  return errors;
}
