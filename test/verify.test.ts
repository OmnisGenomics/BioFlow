import { describe, expect, it } from "vitest";
import path from "node:path";
import { rm, writeFile, readFile } from "node:fs/promises";
import { LocalArtifactStore } from "../src/core/artifact-store.js";
import type { Workflow } from "../src/core/types.js";
import { runWorkflow } from "../src/core/engine.js";
import { verifyRun } from "../src/core/verify.js";
import { LocalCAS } from "../src/core/cas.js";
import { appendAudit } from "../src/core/audit.js";
import type { ExecutionRecord } from "../src/core/execution-record.js";

const auditWorkflow: Workflow = {
  id: "audit-completeness", version: "1.0.0", seed: "seed",
  nodes: [{ id: "start", kind: "trigger.manual" }, { id: "score", kind: "transform.score" }],
  edges: [{ from: "start", to: "score" }]
};

function rechain(record: ExecutionRecord): void {
  const entries = record.execution.auditLog;
  record.execution.auditLog = [];
  for (const entry of entries) appendAudit(record.execution.auditLog, entry);
}

describe("verifyRun", () => {
  it.each([true, false])("rejects omitted independent nodes before a failure with replay=%s", async (replay) => {
    const baseDir = path.resolve(`.bioflow_verify_failed_prefix_${replay}`);
    await rm(baseDir, { recursive: true, force: true });
    const workflow: Workflow = { ...auditWorkflow,
      nodes: [{ id: "start", kind: "trigger.manual" },
        { id: "fail", kind: "action.connector", config: { connector: "missing" } },
        { id: "later", kind: "trigger.manual" }], edges: [] };
    const result = await runWorkflow({ workflow, store: new LocalArtifactStore(baseDir),
      inputs: [], runId: "failed-prefix" });
    expect(result.execution.status).toBe("failed");
    expect(result.nodeRuns.map((node) => node.nodeId)).toEqual(["start", "fail"]);
    expect((await verifyRun({ baseDir, runId: "failed-prefix", replay })).valid).toBe(true);
    const record = JSON.parse(await readFile(result.executionPath!, "utf8")) as ExecutionRecord;
    record.nodeRuns.shift();
    record.execution.auditLog = record.execution.auditLog.filter((entry) => entry.details.nodeId !== "start");
    rechain(record);
    await writeFile(result.executionPath!, JSON.stringify(record));
    const verified = await verifyRun({ baseDir, runId: "failed-prefix", replay });
    expect(verified.valid).toBe(false);
    expect(verified.errors.join("\n")).toMatch(/deterministic execution prefix/);
  });

  it("rejects a replay failure even when both runs have no outputs", async () => {
    const baseDir = path.resolve(".bioflow_verify_replay_status");
    await rm(baseDir, { recursive: true, force: true });
    const workflow: Workflow = { ...auditWorkflow,
      nodes: [{ id: "start", kind: "trigger.manual" },
        { id: "custom", kind: "action.connector", config: { connector: "custom" } }],
      edges: [{ from: "start", to: "custom" }] };
    const result = await runWorkflow({ workflow, store: new LocalArtifactStore(baseDir), inputs: [],
      runId: "replay-status", connectors: {
        custom: { id: "custom", async invoke() { return { outputs: [], costUSD: 0 }; } }
      } });
    expect(result.execution.status).toBe("completed");
    expect((await verifyRun({ baseDir, runId: "replay-status", replay: false })).valid).toBe(true);
    const verified = await verifyRun({ baseDir, runId: "replay-status" });
    expect(verified.valid).toBe(false);
    expect(verified.errors).toContain("Replay status mismatch: expected completed, got failed");
  });
  it.each([true, false])("rejects an empty audit log with replay=%s", async (replay) => {
    const baseDir = path.resolve(`.bioflow_verify_empty_${replay}`);
    await rm(baseDir, { recursive: true, force: true });
    const result = await runWorkflow({ workflow: auditWorkflow, store: new LocalArtifactStore(baseDir),
      inputs: [], runId: "empty" });
    const record = JSON.parse(await readFile(result.executionPath!, "utf8")) as ExecutionRecord;
    record.execution.auditLog = [];
    await writeFile(result.executionPath!, JSON.stringify(record));
    const verified = await verifyRun({ baseDir, runId: "empty", replay });
    expect(verified.valid).toBe(false);
    expect(verified.errors.join("\n")).toMatch(/Audit log is empty/);
  });

  it.each(["execution_started", "workflow_snapshot", "inputs_snapshot", "node_started",
    "node_completed", "execution_completed"])("rejects missing %s even with a recomputed chain", async (action) => {
    const baseDir = path.resolve(`.bioflow_verify_missing_${action}`);
    await rm(baseDir, { recursive: true, force: true });
    const result = await runWorkflow({ workflow: auditWorkflow, store: new LocalArtifactStore(baseDir),
      inputs: [], runId: "missing" });
    const record = JSON.parse(await readFile(result.executionPath!, "utf8")) as ExecutionRecord;
    const index = record.execution.auditLog.findIndex((entry) => entry.action === action);
    record.execution.auditLog.splice(index, 1);
    rechain(record);
    await writeFile(result.executionPath!, JSON.stringify(record));
    const verified = await verifyRun({ baseDir, runId: "missing", replay: false });
    expect(verified.valid).toBe(false);
    expect(verified.errors.join("\n")).toMatch(/Audit event/);
  });

  it.each(["runId", "workflowDigest", "nodeId", "outputDigests", "order", "extra", "nodeRuns", "costUSD"])(
    "rejects inconsistent %s with a valid chain", async (field) => {
      const baseDir = path.resolve(`.bioflow_verify_inconsistent_${field}`);
      await rm(baseDir, { recursive: true, force: true });
      const result = await runWorkflow({ workflow: auditWorkflow, store: new LocalArtifactStore(baseDir),
        inputs: [], runId: "inconsistent" });
      const record = JSON.parse(await readFile(result.executionPath!, "utf8")) as ExecutionRecord;
      const log = record.execution.auditLog;
      if (field === "runId") log[0]!.details.runId = "other";
      if (field === "workflowDigest") log[1]!.details.workflowDigest = "0".repeat(64);
      if (field === "nodeId") log[3]!.details.nodeId = "other";
      if (field === "outputDigests") log[6]!.details.outputDigests = [];
      if (field === "order") [log[1], log[2]] = [log[2]!, log[1]!];
      if (field === "extra") log.push(log[log.length - 1]!);
      if (field === "costUSD") delete log[log.length - 1]!.details.costUSD;
      if (field === "nodeRuns") {
        record.nodeRuns.pop();
        record.execution.auditLog = log.filter((entry) => entry.details.nodeId !== "score");
      }
      rechain(record);
      await writeFile(result.executionPath!, JSON.stringify(record));
      const verified = await verifyRun({ baseDir, runId: "inconsistent", replay: false });
      expect(verified.valid).toBe(false);
      expect(verified.errors.join("\n")).toMatch(/Audit event|Node run/);
    }
  );

  it("accepts a failed run ending with node_failed and rejects a truncated failure audit", async () => {
    const baseDir = path.resolve(".bioflow_verify_failed_audit");
    await rm(baseDir, { recursive: true, force: true });
    const workflow: Workflow = { ...auditWorkflow,
      nodes: [{ id: "start", kind: "trigger.manual" }, { id: "score", kind: "action.connector",
        config: { connector: "missing" } }] };
    const result = await runWorkflow({ workflow, store: new LocalArtifactStore(baseDir), inputs: [], runId: "failed" });
    expect(result.execution.status).toBe("failed");
    expect((await verifyRun({ baseDir, runId: "failed", replay: false })).valid).toBe(true);
    expect((await verifyRun({ baseDir, runId: "failed" })).valid).toBe(true);
    const record = JSON.parse(await readFile(result.executionPath!, "utf8")) as ExecutionRecord;
    const withoutError = structuredClone(record);
    delete withoutError.nodeRuns[withoutError.nodeRuns.length - 1]!.error;
    rechain(withoutError);
    await writeFile(result.executionPath!, JSON.stringify(withoutError));
    const missingError = await verifyRun({ baseDir, runId: "failed", replay: false });
    expect(missingError.valid).toBe(false);
    expect(missingError.errors.join("\n")).toMatch(/inconsistent error/);
    record.execution.auditLog.pop();
    await writeFile(result.executionPath!, JSON.stringify(record));
    const verified = await verifyRun({ baseDir, runId: "failed", replay: false });
    expect(verified.valid).toBe(false);
    expect(verified.errors.join("\n")).toMatch(/Audit event/);
  });
  it("passes for an untampered run and fails if audit is edited", async () => {
    const baseDir = path.resolve(".bioflow_verify_test");
    await rm(baseDir, { recursive: true, force: true });
    const store = new LocalArtifactStore(baseDir);

    const workflow: Workflow = {
      id: "v",
      version: "1.0.0",
      seed: "seed",
      nodes: [
        { id: "start", kind: "trigger.manual" },
        { id: "score", kind: "transform.score" },
        {
          id: "writeback",
          kind: "action.connector",
          config: { connector: "eln_sim", operation: "writeback", params: { destination: "x" } }
        }
      ],
      edges: [
        { from: "start", to: "score" },
        { from: "score", to: "writeback" }
      ]
    };

    const input = await store.putBytes({
      runId: "r1",
      name: "input.txt",
      bytes: new TextEncoder().encode("hello"),
      mediaType: "text/plain",
      kind: "input"
    });

    const runId = "r1";
    await runWorkflow({ workflow, store, inputs: [input], actor: "test", runId });

    const ok = await verifyRun({ baseDir, runId });
    expect(ok.valid).toBe(true);

    const execPath = path.join(baseDir, "runs", runId, "execution.json");
    const raw = JSON.parse(await readFile(execPath, "utf8"));
    raw.execution.auditLog[1].details.runId = "tampered";
    await writeFile(execPath, JSON.stringify(raw, null, 2) + "\n");

    const tampered = await verifyRun({ baseDir, runId });
    expect(tampered.valid).toBe(false);
    expect(tampered.errors.join("\n")).toMatch(/Audit hash mismatch|prevHash mismatch/);
  }, 20_000);

  it("fails if a CAS object is mutated", async () => {
    const baseDir = path.resolve(".bioflow_verify_test2");
    await rm(baseDir, { recursive: true, force: true });
    const store = new LocalArtifactStore(baseDir);

    const workflow: Workflow = {
      id: "v2",
      version: "1.0.0",
      seed: "seed",
      nodes: [{ id: "start", kind: "trigger.manual" }],
      edges: []
    };

    const runId = "r2";
    const input = await store.putBytes({
      runId,
      name: "input.txt",
      bytes: new TextEncoder().encode("hello"),
      mediaType: "text/plain",
      kind: "input"
    });
    await runWorkflow({ workflow, store, inputs: [input], actor: "test", runId });

    const cas = new LocalCAS(baseDir);
    const objPath = cas.objectPath(input.sha256);
    await writeFile(objPath, new TextEncoder().encode("corruption"));

    const res = await verifyRun({ baseDir, runId });
    expect(res.valid).toBe(false);
    expect(res.errors.join("\n")).toMatch(/CAS object hash mismatch|Missing CAS object/);
  }, 20_000);
});
