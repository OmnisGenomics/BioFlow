import path from "node:path";
import { readFile, rm } from "node:fs/promises";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { LocalArtifactStore } from "../src/core/artifact-store.js";
import { runWorkflow } from "../src/core/engine.js";
import { verifyRun } from "../src/core/verify.js";
import { assertValidWorkflow } from "../src/core/validate.js";
import { generateGxpReport } from "../src/gxp/report.js";
import { RunManifestStore } from "../src/core/run-manifest.js";
import { LocalCAS } from "../src/core/cas.js";

describe("killer example workflow", () => {
  it("runs, verifies, and reports deterministically", async () => {
    const baseDir = path.resolve(".bioflow_killer_example_test");
    const runId = "killer-example-v1";

    await rm(baseDir, { recursive: true, force: true });

    const workflowRaw = await readFile(path.resolve("examples/killer.workflow.yaml"), "utf8");
    const workflow = assertValidWorkflow(YAML.parse(workflowRaw));

    const store = new LocalArtifactStore(baseDir);
    const input = await store.importFile(runId, path.resolve("examples/synthetic/sample-sheet.messy.csv"));
    const run = await runWorkflow({ workflow, store, inputs: [input], runId, actor: "test" });

    expect(run.execution.status).toBe("completed");
    expect(run.execution.outputs.some((artifact) => artifact.name === "connector.eln_sim.ack.json")).toBe(true);

    const verify = await verifyRun({ baseDir, runId });
    expect(verify.valid).toBe(true);

    const report1 = await generateGxpReport({ baseDir, runId, format: "markdown", replay: true });
    const report2 = await generateGxpReport({ baseDir, runId, format: "markdown", replay: true });
    expect(report1.artifact.sha256).toBe(report2.artifact.sha256);
    expect(report1.reportDigest).toBe(report2.reportDigest);

    const manifest = await new RunManifestStore(baseDir).load(runId);
    expect(manifest.artifacts["clean.sample-sheet-v1.clean.csv"]).toBeDefined();
    expect(manifest.artifacts["clean.sample-sheet-v1.data.csv"]).toBeDefined();
    expect(manifest.artifacts["clean.sample-sheet-v1.idmap.json"]).toBeDefined();
    expect(manifest.artifacts["clean.sample-sheet-v1.report.json"]).toBeDefined();
    expect(manifest.artifacts["gxp-report.md"]?.sha256).toBe(report1.artifact.sha256);

    const cas = new LocalCAS(baseDir);
    const markdown = await readFile(cas.objectPath(report1.artifact.sha256), "utf8");
    expect(markdown).toContain("Replay integrity: **VERIFIED**");
    expect(markdown).toContain("Audit chain integrity: **VERIFIED**");
  }, 20_000);
});
