import { describe, expect, it } from "vitest";
import path from "node:path";
import { rm, readFile, writeFile } from "node:fs/promises";
import { LocalArtifactStore } from "../src/core/artifact-store.js";
import type { Workflow } from "../src/core/types.js";
import { runWorkflow } from "../src/core/engine.js";
import { generateGxpReport } from "../src/gxp/report.js";
import { RunManifestStore } from "../src/core/run-manifest.js";
import { LocalCAS } from "../src/core/cas.js";

describe("gxp report", () => {
  it("is deterministic for the same run", async () => {
    const baseDir = path.resolve(".bioflow_gxp_report_test");
    await rm(baseDir, { recursive: true, force: true });
    const store = new LocalArtifactStore(baseDir);

    const workflow: Workflow = {
      id: "gxp",
      version: "1.0.0",
      seed: "seed",
      nodes: [{ id: "start", kind: "trigger.manual" }, { id: "score", kind: "transform.score" }],
      edges: [{ from: "start", to: "score" }]
    };

    const runId = "rpt1";
    const input = await store.putBytes({
      runId,
      name: "input.txt",
      bytes: new TextEncoder().encode("hello"),
      mediaType: "text/plain",
      kind: "input"
    });
    await runWorkflow({ workflow, store, inputs: [input], actor: "test", runId });

    const r1 = await generateGxpReport({ baseDir, runId, format: "markdown", replay: false });
    const r2 = await generateGxpReport({ baseDir, runId, format: "markdown", replay: false });
    expect(r1.artifact.sha256).toBe(r2.artifact.sha256);
    expect(r1.reportDigest).toBe(r2.reportDigest);

    const manifest = await new RunManifestStore(baseDir).load(runId);
    expect(manifest.artifacts["gxp-report.md"]?.sha256).toBe(r1.artifact.sha256);

    const cas = new LocalCAS(baseDir);
    const md = await readFile(cas.objectPath(r1.artifact.sha256), "utf8");
    expect(md).toMatch(/Installation Qualification/);
    expect(md).toMatch(/Audit chain integrity/);
  }, 20_000);

  it("marks audit chain failures", async () => {
    const baseDir = path.resolve(".bioflow_gxp_report_test2");
    await rm(baseDir, { recursive: true, force: true });
    const store = new LocalArtifactStore(baseDir);

    const workflow: Workflow = {
      id: "gxp2",
      version: "1.0.0",
      seed: "seed",
      nodes: [{ id: "start", kind: "trigger.manual" }],
      edges: []
    };

    const runId = "rpt2";
    const input = await store.putBytes({
      runId,
      name: "input.txt",
      bytes: new TextEncoder().encode("hello"),
      mediaType: "text/plain",
      kind: "input"
    });
    await runWorkflow({ workflow, store, inputs: [input], actor: "test", runId });

    const execPath = path.join(baseDir, "runs", runId, "execution.json");
    const raw = JSON.parse(await readFile(execPath, "utf8"));
    raw.execution.auditLog[0].details.runId = "tampered";
    await writeFile(execPath, JSON.stringify(raw, null, 2) + "\n");

    const res = await generateGxpReport({ baseDir, runId, format: "markdown", replay: false });
    const cas = new LocalCAS(baseDir);
    const md = await readFile(cas.objectPath(res.artifact.sha256), "utf8");
    expect(md).toContain("Audit chain integrity: **FAILED**");
  }, 20_000);
});
