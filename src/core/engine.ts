import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { sha256Json } from "./hash.js";
import { appendAudit } from "./audit.js";
import { createDeterministicRng } from "./rng.js";
import { createRunId } from "./run-id.js";
import { stableStringify } from "./stable-json.js";
import type { Artifact, Execution, NodeRun, Workflow, WorkflowNode } from "./types.js";
import type { ArtifactStore } from "./artifact-store.js";
import { createDefaultConnectors } from "./connectors/registry.js";
import type { ConnectorRegistry } from "./connectors/registry.js";

export interface RunParams {
  workflow: Workflow;
  store: ArtifactStore;
  inputs: Artifact[];
  actor?: string;
  runId?: string;
  connectors?: ConnectorRegistry;
  persistExecution?: boolean;
}

export interface RunResult {
  execution: Execution;
  nodeRuns: NodeRun[];
  executionPath?: string | undefined;
}

export async function runWorkflow(params: RunParams): Promise<RunResult> {
  const persistExecution = params.persistExecution ?? true;
  const runId = params.runId ?? createRunId();
  const actor = params.actor ?? "user";
  const connectors = params.connectors ?? createDefaultConnectors();

  const workflowDigest = sha256Json(params.workflow);
  await params.store.initRun(runId, {
    workflowId: params.workflow.id,
    workflowVersion: params.workflow.version,
    workflowDigest,
    seed: params.workflow.seed
  });
  const workflowBytes = new TextEncoder().encode(stableStringify(params.workflow));
  const workflowArtifact = await params.store.putBytes({
    runId,
    name: "__workflow.json",
    bytes: workflowBytes,
    mediaType: "application/json",
    kind: "workflow"
  });
  if (workflowArtifact.sha256 !== workflowDigest) {
    throw new Error(
      `Workflow digest mismatch: expected ${workflowDigest}, stored ${workflowArtifact.sha256}`
    );
  }
  const runtime = {
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch
  } as const;

  const auditLog: Execution["auditLog"] = [];
  appendAudit(auditLog, {
    actor,
    action: "execution_started",
    details: { runId, workflowId: params.workflow.id, workflowVersion: params.workflow.version }
  });
  appendAudit(auditLog, {
    actor: "system",
    action: "workflow_snapshot",
    details: { runId, workflowDigest, workflowArtifact: workflowArtifact.uri }
  });
  for (const input of params.inputs) {
    const normalized: Artifact = input.kind ? input : { ...input, kind: "input" };
    await params.store.recordArtifact(runId, normalized);
  }
  appendAudit(auditLog, {
    actor: "system",
    action: "inputs_snapshot",
    details: {
      runId,
      inputs: params.inputs.map((a) => ({ name: a.name, sha256: a.sha256, bytes: a.bytes }))
    }
  });

  const startedAt = new Date().toISOString();
  let costUSD = 0;

  const nodeRuns: NodeRun[] = [];
  const nodeOutputs = new Map<string, Artifact[]>();
  const order = topologicalOrder(params.workflow);

  for (const nodeId of order) {
    const node = params.workflow.nodes.find((n) => n.id === nodeId)!;
    const nodeStartedAt = new Date().toISOString();
    appendAudit(auditLog, {
      actor: "system",
      action: "node_started",
      details: { runId, nodeId: node.id, kind: node.kind }
    });

    const inputs = computeNodeInputs(params.workflow, node, params.inputs, nodeOutputs);
    const rngSeed = `${params.workflow.seed ?? "default"}:${params.workflow.id}:${node.id}`;
    const rng = createDeterministicRng(rngSeed);

    try {
      const { outputs, nodeCostUSD, notes } = await executeNode({
        runId,
        workflow: params.workflow,
        node,
        store: params.store,
        inputs,
        rng,
        connectors
      });
      nodeOutputs.set(node.id, outputs);
      costUSD += nodeCostUSD;

      appendAudit(auditLog, {
        actor: "system",
        action: "node_completed",
        details: {
          runId,
          nodeId: node.id,
          kind: node.kind,
          inputDigests: inputs.map((a) => a.sha256),
          outputDigests: outputs.map((a) => a.sha256),
          costUSD: nodeCostUSD
        }
      });

      nodeRuns.push({
        nodeId: node.id,
        kind: node.kind,
        status: "ok",
        startedAt: nodeStartedAt,
        endedAt: new Date().toISOString(),
        inputs,
        outputs,
        costUSD: nodeCostUSD,
        notes
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      appendAudit(auditLog, {
        actor: "system",
        action: "node_failed",
        details: { runId, nodeId: node.id, kind: node.kind, error: message }
      });
      nodeRuns.push({
        nodeId: node.id,
        kind: node.kind,
        status: "failed",
        startedAt: nodeStartedAt,
        endedAt: new Date().toISOString(),
        inputs,
        outputs: [],
        costUSD: 0,
        error: message
      });
      const execution = finalizeExecution({
        workflow: params.workflow,
        workflowDigest,
        runId,
        runtime,
        status: "failed",
        startedAt,
        endedAt: new Date().toISOString(),
        inputs: params.inputs,
        outputs: collectWorkflowOutputs(params.workflow, nodeOutputs),
        auditLog,
        costUSD
      });
      const executionPath = persistExecution
        ? await writeExecution(params.store.baseDir(), execution, nodeRuns)
        : undefined;
      return { execution, nodeRuns, executionPath };
    }
  }

  appendAudit(auditLog, {
    actor: "system",
    action: "execution_completed",
    details: { runId, costUSD }
  });

  const execution = finalizeExecution({
    workflow: params.workflow,
    workflowDigest,
    runId,
    runtime,
    status: "completed",
    startedAt,
    endedAt: new Date().toISOString(),
    inputs: params.inputs,
    outputs: collectWorkflowOutputs(params.workflow, nodeOutputs),
    auditLog,
    costUSD
  });

  const executionPath = persistExecution
    ? await writeExecution(params.store.baseDir(), execution, nodeRuns)
    : undefined;
  return { execution, nodeRuns, executionPath };
}

function finalizeExecution(params: {
  workflow: Workflow;
  workflowDigest: string;
  runId: string;
  runtime: Execution["runtime"];
  status: Execution["status"];
  startedAt: string;
  endedAt: string;
  inputs: Artifact[];
  outputs: Artifact[];
  auditLog: Execution["auditLog"];
  costUSD: number;
}): Execution {
  return {
    workflowId: params.workflow.id,
    workflowVersion: params.workflow.version,
    workflowDigest: params.workflowDigest,
    runId: params.runId,
    status: params.status,
    startedAt: params.startedAt,
    endedAt: params.endedAt,
    inputs: params.inputs,
    outputs: params.outputs,
    auditLog: params.auditLog,
    costUSD: round2(params.costUSD),
    runtime: params.runtime
  };
}

async function writeExecution(
  baseDir: string,
  execution: Execution,
  nodeRuns: NodeRun[]
): Promise<string> {
  const runDir = path.join(baseDir, "runs", execution.runId);
  await mkdir(runDir, { recursive: true });
  const outPath = path.join(runDir, "execution.json");
  await writeFile(outPath, JSON.stringify({ execution, nodeRuns }, null, 2) + "\n");
  return outPath;
}

function topologicalOrder(workflow: Workflow): string[] {
  const nodeIds = new Set(workflow.nodes.map((n) => n.id));
  const indegree = new Map<string, number>();
  for (const id of nodeIds) indegree.set(id, 0);
  for (const edge of workflow.edges) indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);

  const outgoing = new Map<string, string[]>();
  for (const edge of workflow.edges) {
    const list = outgoing.get(edge.from) ?? [];
    list.push(edge.to);
    outgoing.set(edge.from, list);
  }

  const queue: string[] = [];
  for (const [id, deg] of indegree.entries()) if (deg === 0) queue.push(id);

  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const to of outgoing.get(id) ?? []) {
      const next = (indegree.get(to) ?? 0) - 1;
      indegree.set(to, next);
      if (next === 0) queue.push(to);
    }
  }
  if (order.length !== nodeIds.size) {
    throw new Error("Workflow graph contains a cycle; cannot execute");
  }
  return order;
}

function computeNodeInputs(
  workflow: Workflow,
  node: WorkflowNode,
  rootInputs: Artifact[],
  nodeOutputs: Map<string, Artifact[]>
): Artifact[] {
  if (node.kind.startsWith("trigger.")) return rootInputs;

  const incoming = workflow.edges.filter((e) => e.to === node.id).map((e) => e.from);
  if (!incoming.length) return [];
  const out: Artifact[] = [];
  for (const from of incoming) {
    const artifacts = nodeOutputs.get(from) ?? [];
    out.push(...artifacts);
  }
  return out;
}

function collectWorkflowOutputs(workflow: Workflow, nodeOutputs: Map<string, Artifact[]>): Artifact[] {
  const outgoingCount = new Map<string, number>();
  for (const n of workflow.nodes) outgoingCount.set(n.id, 0);
  for (const e of workflow.edges) outgoingCount.set(e.from, (outgoingCount.get(e.from) ?? 0) + 1);

  const leaves = workflow.nodes.filter((n) => (outgoingCount.get(n.id) ?? 0) === 0);
  const outputs: Artifact[] = [];
  for (const leaf of leaves) outputs.push(...(nodeOutputs.get(leaf.id) ?? []));
  return outputs;
}

async function executeNode(params: {
  runId: string;
  workflow: Workflow;
  node: WorkflowNode;
  store: ArtifactStore;
  inputs: Artifact[];
  rng: ReturnType<typeof createDeterministicRng>;
  connectors: ConnectorRegistry;
}): Promise<{ outputs: Artifact[]; nodeCostUSD: number; notes?: string | undefined }> {
  const { node, inputs, rng, store, runId, connectors } = params;

  switch (node.kind) {
    case "trigger.manual": {
      return { outputs: inputs, nodeCostUSD: 0, notes: "Pass-through trigger" };
    }
    case "transform.score": {
      const score = {
        inputs: inputs.map((a) => ({ name: a.name, sha256: a.sha256, bytes: a.bytes })),
        metrics: {
          score: Math.round(rng.nextFloat() * 1000) / 10,
          sampleCount: inputs.length
        }
      };
      const artifact = await store.putJson({
        runId,
        name: `${node.id}.score.json`,
        value: score,
        kind: "score"
      });
      return { outputs: [artifact], nodeCostUSD: 0.01 };
    }
    case "report.aggregate": {
      const report = {
        summary: {
          artifactCount: inputs.length
        },
        inputs: inputs.map((a) => ({ name: a.name, sha256: a.sha256, kind: a.kind }))
      };
      const artifact = await store.putJson({
        runId,
        name: `${node.id}.report.json`,
        value: report,
        kind: "report"
      });
      return { outputs: [artifact], nodeCostUSD: 0.02 };
    }
    case "sink.eln_sim": {
      const connector = connectors["eln_sim"];
      if (!connector) throw new Error(`Missing connector: eln_sim`);
      const operation = "writeback";
      const params = { nodeId: node.id };
      const invocationId = sha256Json({
        runId,
        nodeId: node.id,
        connectorId: "eln_sim",
        operation,
        params,
        inputDigests: inputs.map((a) => a.sha256)
      });
      const result = await connector.invoke({
        runId,
        nodeId: node.id,
        operation,
        invocationId,
        params,
        inputs,
        store,
        rng
      });
      return { outputs: result.outputs, nodeCostUSD: result.costUSD, notes: result.notes };
    }
    case "action.connector": {
      const config = node.config ?? {};
      const connectorId = typeof config.connector === "string" ? config.connector : undefined;
      const operation = typeof config.operation === "string" ? config.operation : "invoke";
      const rawParams = isPlainObject(config.params) ? (config.params as Record<string, unknown>) : {};

      if (!connectorId) throw new Error(`action.connector requires config.connector (string)`);
      const connector = connectors[connectorId];
      if (!connector) throw new Error(`Unknown connector: ${connectorId}`);

      const invocationId = sha256Json({
        runId,
        nodeId: node.id,
        connectorId,
        operation,
        params: rawParams,
        inputDigests: inputs.map((a) => a.sha256)
      });

      const result = await connector.invoke({
        runId,
        nodeId: node.id,
        operation,
        invocationId,
        params: rawParams,
        inputs,
        store,
        rng
      });
      return { outputs: result.outputs, nodeCostUSD: result.costUSD, notes: result.notes };
    }
    default: {
      // Exhaustive check for NodeKind unions
      const kind: never = node.kind;
      throw new Error(`Unsupported node kind: ${kind}`);
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  return Object.getPrototypeOf(value) === Object.prototype;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
