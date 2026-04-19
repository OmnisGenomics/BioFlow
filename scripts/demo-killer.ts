import path from "node:path";
import { readFile, rm } from "node:fs/promises";
import YAML from "yaml";
import { LocalArtifactStore } from "../src/core/artifact-store.js";
import { runWorkflow } from "../src/core/engine.js";
import { verifyRun } from "../src/core/verify.js";
import { assertValidWorkflow } from "../src/core/validate.js";
import { generateGxpReport } from "../src/gxp/report.js";

const baseDir = path.resolve(".bioflow_demo_killer");
const workflowPath = path.resolve("examples/killer.workflow.yaml");
const inputPath = path.resolve("examples/synthetic/sample-sheet.messy.csv");
const runId = "killer-demo-v1";

async function main(): Promise<void> {
  await rm(baseDir, { recursive: true, force: true });

  const workflow = assertValidWorkflow(YAML.parse(await readFile(workflowPath, "utf8")));
  const store = new LocalArtifactStore(baseDir);
  const input = await store.importFile(runId, inputPath);

  const run = await runWorkflow({ workflow, store, inputs: [input], runId, actor: "demo:killer" });
  if (run.execution.status !== "completed") {
    throw new Error(`Expected completed run; got ${run.execution.status}`);
  }

  const verified = await verifyRun({ baseDir, runId });
  if (!verified.valid) {
    throw new Error(`Verification failed: ${verified.errors.join("; ")}`);
  }

  const report = await generateGxpReport({
    baseDir,
    runId,
    format: "markdown",
    replay: true,
    outDir: path.join(baseDir, "reports")
  });

  console.log(`runId=${runId}`);
  console.log(`execution=${run.execution.status}`);
  console.log(`verify=OK`);
  console.log(`report.sha256=${report.artifact.sha256}`);
  if (report.outputPath) console.log(`report.path=${report.outputPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
