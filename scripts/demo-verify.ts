import path from "node:path";
import { rm, readFile, writeFile } from "node:fs/promises";
import YAML from "yaml";
import { LocalArtifactStore } from "../src/core/artifact-store.js";
import { createRunId } from "../src/core/run-id.js";
import { assertValidWorkflow } from "../src/core/validate.js";
import { runWorkflow } from "../src/core/engine.js";
import { verifyRun } from "../src/core/verify.js";

async function main(): Promise<void> {
  const baseDir = path.resolve(".bioflow_demo");
  await rm(baseDir, { recursive: true, force: true });

  const workflowPath = path.resolve("examples/example.workflow.yaml");
  const workflowRaw = await readFile(workflowPath, "utf8");
  const workflow = assertValidWorkflow(YAML.parse(workflowRaw));

  const store = new LocalArtifactStore(baseDir);
  const runId = createRunId();

  const input = await store.importFile(runId, path.resolve("README.md"));
  await runWorkflow({ workflow, store, inputs: [input], runId, actor: "demo" });

  const ok = await verifyRun({ baseDir, runId });
  console.log(`verify (expected OK): ${ok.valid ? "OK" : "FAIL"}`);
  if (!ok.valid) ok.errors.forEach((e) => console.log(`- ${e}`));

  // Tamper with the audit log (should be detected)
  const execPath = path.join(baseDir, "runs", runId, "execution.json");
  const exec = JSON.parse(await readFile(execPath, "utf8"));
  exec.execution.auditLog[1].details.runId = "tampered";
  await writeFile(execPath, JSON.stringify(exec, null, 2) + "\n");

  const bad = await verifyRun({ baseDir, runId });
  console.log(`verify after tamper (expected FAIL): ${bad.valid ? "OK" : "FAIL"}`);
  if (!bad.valid) bad.errors.forEach((e) => console.log(`- ${e}`));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});

