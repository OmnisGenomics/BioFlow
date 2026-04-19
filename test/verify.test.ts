import { describe, expect, it } from "vitest";
import path from "node:path";
import { rm, writeFile, readFile } from "node:fs/promises";
import { LocalArtifactStore } from "../src/core/artifact-store.js";
import type { Workflow } from "../src/core/types.js";
import { runWorkflow } from "../src/core/engine.js";
import { verifyRun } from "../src/core/verify.js";
import { LocalCAS } from "../src/core/cas.js";

describe("verifyRun", () => {
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
