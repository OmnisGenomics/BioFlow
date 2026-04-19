import { describe, expect, it } from "vitest";
import path from "node:path";
import { rm, readFile } from "node:fs/promises";
import { LocalArtifactStore } from "../src/core/artifact-store.js";
import { runWorkflow } from "../src/core/engine.js";
import { LocalCAS } from "../src/core/cas.js";
import { verifyRun } from "../src/core/verify.js";
import type { Workflow } from "../src/core/types.js";
import { sampleSheetV1Profile } from "../src/clean/profiles/sample-sheet-v1.js";

describe("clean_csv: sample-sheet-v1", () => {
  it("normalizes Sample_ID, Index, and Lane deterministically", async () => {
    const baseDir = path.resolve(".bioflow_clean_samplesheet_test");
    await rm(baseDir, { recursive: true, force: true });
    const store = new LocalArtifactStore(baseDir);
    const runId = crypto.randomUUID();

    const inputText = [
      "[Header]",
      "IEMFileVersion,4",
      "",
      "[Data]",
      "Sample_ID,Index,Lane",
      "sample 1,acgt,1-3",
      'sample 1,acgt+tgca,"3,2,1"'
    ].join("\n");

    const input = await store.putBytes({
      runId,
      name: "SampleSheet.csv",
      bytes: new TextEncoder().encode(inputText),
      mediaType: "text/csv",
      kind: "input"
    });

    const workflow: Workflow = {
      id: "tidy.sample-sheet-v1",
      version: "0.1.0",
      seed: "seed",
      nodes: [
        { id: "start", kind: "trigger.manual" },
        {
          id: "tidy",
          kind: "action.connector",
          config: {
            connector: "clean_csv",
            operation: "sample-sheet-v1",
            params: { profile: sampleSheetV1Profile }
          }
        }
      ],
      edges: [{ from: "start", to: "tidy" }]
    };

    const res = await runWorkflow({ workflow, store, inputs: [input], runId, actor: "test" });
    expect(res.execution.status).toBe("completed");

    const dataOut = res.execution.outputs.find((a) => a.name === "tidy.sample-sheet-v1.data.csv");
    expect(dataOut?.sha256).toMatch(/^[a-f0-9]{64}$/);

    const cas = new LocalCAS(baseDir);
    const dataCsv = await readFile(cas.objectPath(dataOut!.sha256), "utf8");

    const expected = [
      "Sample_ID,Index,Index2,Index_Dual,Lane",
      // Lane contains commas -> quoted
      'SAMPLE_1,ACGT,,,"1,2,3"',
      'SAMPLE_1_001,ACGT,TGCA,ACGT+TGCA,"1,2,3"'
    ].join("\r\n");
    expect(dataCsv).toBe(expected + "\r\n");

    const verified = await verifyRun({ baseDir, runId });
    expect(verified.valid).toBe(true);
  }, 20_000);

  it("is idempotent on already-clean data", async () => {
    const baseDir = path.resolve(".bioflow_clean_samplesheet_test2");
    await rm(baseDir, { recursive: true, force: true });
    const store = new LocalArtifactStore(baseDir);

    const cleanData = [
      "Sample_ID,Index,Index2,Index_Dual,Lane",
      'SAMPLE_1,ACGT,,,"1,2,3"',
      'SAMPLE_1_001,ACGT,TGCA,ACGT+TGCA,"1,2,3"'
    ].join("\r\n");

    const run1 = crypto.randomUUID();
    const input1 = await store.putBytes({
      runId: run1,
      name: "data.csv",
      bytes: new TextEncoder().encode(cleanData + "\r\n"),
      kind: "input"
    });

    const workflow: Workflow = {
      id: "tidy.sample-sheet-v1",
      version: "0.1.0",
      seed: "seed",
      nodes: [
        { id: "start", kind: "trigger.manual" },
        {
          id: "tidy",
          kind: "action.connector",
          config: {
            connector: "clean_csv",
            operation: "sample-sheet-v1",
            params: { profile: sampleSheetV1Profile }
          }
        }
      ],
      edges: [{ from: "start", to: "tidy" }]
    };

    const r1 = await runWorkflow({ workflow, store, inputs: [input1], runId: run1, actor: "test" });
    const out1 = r1.execution.outputs.find((a) => a.name === "tidy.sample-sheet-v1.data.csv")!;

    const run2 = crypto.randomUUID();
    const input2 = await store.putBytes({
      runId: run2,
      name: "data.csv",
      bytes: new TextEncoder().encode(cleanData + "\r\n"),
      kind: "input"
    });
    const r2 = await runWorkflow({ workflow, store, inputs: [input2], runId: run2, actor: "test" });
    const out2 = r2.execution.outputs.find((a) => a.name === "tidy.sample-sheet-v1.data.csv")!;

    expect(out1.sha256).toBe(out2.sha256);
  }, 20_000);
});
