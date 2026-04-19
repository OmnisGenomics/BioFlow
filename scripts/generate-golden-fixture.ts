import path from "node:path";
import { rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { LocalArtifactStore } from "../src/core/artifact-store.js";
import { runWorkflow } from "../src/core/engine.js";
import { verifyRun } from "../src/core/verify.js";
import { RunManifestSchema } from "../src/core/run-manifest.js";
import { ExecutionRecordSchema } from "../src/core/execution-record.js";
import {
  RUN_MANIFEST_SCHEMA_SEMVER,
  RUN_MANIFEST_SCHEMA_ID
} from "../src/schemas/manifest-v1.js";
import {
  EXECUTION_RECORD_SCHEMA_SEMVER,
  EXECUTION_RECORD_SCHEMA_ID
} from "../src/schemas/execution-v1.js";
import { GXP_REPORT_SCHEMA_ID, GXP_REPORT_SCHEMA_SEMVER } from "../src/schemas/report-v1.js";
import { sha256Json } from "../src/core/hash.js";

const runId = "golden-v1";
const fixtureDir = path.resolve("test/fixtures/golden-run-v1");

const workflow = {
  id: "golden.workflow",
  version: "1.0.0",
  seed: "golden-seed-v1",
  nodes: [
    { id: "start", kind: "trigger.manual" as const },
    { id: "score", kind: "transform.score" as const },
    { id: "report", kind: "report.aggregate" as const },
    {
      id: "writeback",
      kind: "action.connector" as const,
      config: { connector: "eln_sim", operation: "writeback", params: { destination: "golden" } }
    }
  ],
  edges: [
    { from: "start", to: "score" },
    { from: "score", to: "report" },
    { from: "report", to: "writeback" }
  ]
};

async function main(): Promise<void> {
  await rm(fixtureDir, { recursive: true, force: true });
  await mkdir(fixtureDir, { recursive: true });

  const store = new LocalArtifactStore(fixtureDir);
  const input = await store.putBytes({
    runId,
    name: "input.txt",
    bytes: new TextEncoder().encode("golden-input\n"),
    mediaType: "text/plain",
    kind: "input"
  });

  await runWorkflow({
    workflow,
    store,
    inputs: [input],
    actor: "golden",
    runId
  });

  const verify = await verifyRun({ baseDir: fixtureDir, runId });
  if (!verify.valid) {
    throw new Error(`Fixture failed verification: ${verify.errors.join("; ")}`);
  }

  const manifestRaw = JSON.parse(
    await readFile(path.join(fixtureDir, "runs", runId, "manifest.json"), "utf8")
  );
  const executionRaw = JSON.parse(
    await readFile(path.join(fixtureDir, "runs", runId, "execution.json"), "utf8")
  );
  const manifest = RunManifestSchema.parse(manifestRaw);
  const executionRecord = ExecutionRecordSchema.parse(executionRaw);

  const outputDigests = executionRecord.execution.outputs
    .map((artifact) => ({ name: artifact.name, sha256: artifact.sha256 }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const summary = {
    fixtureVersion: "1",
    runId,
    contracts: {
      manifest: { id: RUN_MANIFEST_SCHEMA_ID, semver: RUN_MANIFEST_SCHEMA_SEMVER },
      executionRecord: { id: EXECUTION_RECORD_SCHEMA_ID, semver: EXECUTION_RECORD_SCHEMA_SEMVER },
      gxpReport: { id: GXP_REPORT_SCHEMA_ID, semver: GXP_REPORT_SCHEMA_SEMVER }
    },
    workflowDigest: executionRecord.execution.workflowDigest,
    manifestDigest: sha256Json(manifest),
    outputDigests
  };

  await writeFile(
    path.join(fixtureDir, "fixture-summary.json"),
    JSON.stringify(summary, null, 2) + "\n",
    "utf8"
  );

  console.log(`Generated ${fixtureDir} (${runId})`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
