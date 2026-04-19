import path from "node:path";
import { rm, readFile } from "node:fs/promises";
import { LocalArtifactStore } from "../src/core/artifact-store.js";
import { createRunId } from "../src/core/run-id.js";
import { runWorkflow } from "../src/core/engine.js";
import { verifyRun } from "../src/core/verify.js";
import { LocalCAS } from "../src/core/cas.js";
import type { Workflow } from "../src/core/types.js";
import { sampleSheetV1Profile } from "../src/clean/profiles/sample-sheet-v1.js";

async function main(): Promise<void> {
  const baseDir = path.resolve(".bioflow_demo_tidy");
  await rm(baseDir, { recursive: true, force: true });
  const store = new LocalArtifactStore(baseDir);
  const runId = createRunId();

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
    compliance: "Research",
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

  const res = await runWorkflow({ workflow, store, inputs: [input], runId, actor: "demo" });
  console.log(`runId=${runId} status=${res.execution.status}`);
  console.log(`outputs=${res.execution.outputs.map((a) => `${a.name}:${a.uri}`).join(" ")}`);

  const cas = new LocalCAS(baseDir);
  const data = res.execution.outputs.find((a) => a.name.endsWith(".data.csv"));
  if (data) {
    const csv = await readFile(cas.objectPath(data.sha256), "utf8");
    console.log("data.csv:");
    console.log(csv.trimEnd());
  }

  const verified = await verifyRun({ baseDir, runId });
  console.log(`verify=${verified.valid ? "OK" : "FAIL"}`);
  if (!verified.valid) verified.errors.forEach((e) => console.log(`- ${e}`));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});

