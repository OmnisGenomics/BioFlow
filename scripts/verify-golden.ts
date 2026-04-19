import path from "node:path";
import { readFile } from "node:fs/promises";
import { verifyRun } from "../src/core/verify.js";
import { RunManifestSchema } from "../src/core/run-manifest.js";
import { ExecutionRecordSchema } from "../src/core/execution-record.js";

const fixtureDir = path.resolve("test/fixtures/golden-run-v1");
const runId = "golden-v1";

async function main(): Promise<void> {
  const manifestRaw = JSON.parse(
    await readFile(path.join(fixtureDir, "runs", runId, "manifest.json"), "utf8")
  );
  const executionRaw = JSON.parse(
    await readFile(path.join(fixtureDir, "runs", runId, "execution.json"), "utf8")
  );

  RunManifestSchema.parse(manifestRaw);
  ExecutionRecordSchema.parse(executionRaw);

  const verified = await verifyRun({ baseDir: fixtureDir, runId });
  if (!verified.valid) {
    throw new Error(`Golden fixture verify failed: ${verified.errors.join("; ")}`);
  }

  console.log(`Golden fixture verified: ${fixtureDir} (${runId})`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
