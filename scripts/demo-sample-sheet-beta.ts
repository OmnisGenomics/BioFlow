import { spawn } from "node:child_process";
import path from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { verifyRun } from "../src/core/verify.js";
import { generateGxpReport } from "../src/gxp/report.js";

type Mode = "local" | "service";

interface CommandResult {
  output: string;
}

async function main(): Promise<void> {
  const mode = parseMode(process.argv.slice(2));
  const workspaceDir = path.resolve(".bioflow_demo_sample_sheet");
  const localBaseDir = path.join(workspaceDir, "local");
  const pulledBaseDir = path.join(workspaceDir, "pulled");
  const reportDir = path.join(workspaceDir, "reports");
  const outputDir = path.join(workspaceDir, "cleaned");
  const inputPath = path.resolve("examples/synthetic/sample-sheet.messy.csv");

  await rm(workspaceDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await mkdir(reportDir, { recursive: true });

  const tidy = await runBioflowCommand({
    args: ["tidy", inputPath, "--profile", "sample-sheet-v1", "--out", outputDir],
    baseDir: localBaseDir,
    step: "local tidy"
  });
  const runId = parseRunId(tidy.output);

  await assertLocalVerify({ baseDir: localBaseDir, runId, step: "local verify" });
  const report = await generateGxpReport({
    baseDir: localBaseDir,
    runId,
    format: "markdown",
    outDir: reportDir,
    replay: true
  });

  console.log(`runId=${runId}`);
  console.log(`report.sha256=${report.artifact.sha256}`);
  console.log(`report.path=${report.outputPath ?? "(none)"}`);
  console.log("mode.local=completed");

  if (mode === "local") return;

  assertRemoteEnv();

  await runBioflowCommand({
    args: ["push", runId],
    baseDir: localBaseDir,
    step: "service push"
  });
  await runBioflowCommand({
    args: ["verify-remote", runId, "--deep"],
    baseDir: localBaseDir,
    step: "service verify-remote"
  });

  await runBioflowCommand({
    args: ["pull", runId, "--force"],
    baseDir: pulledBaseDir,
    step: "service pull"
  });
  await assertLocalVerify({ baseDir: pulledBaseDir, runId, step: "pulled verify" });

  console.log("mode.service=completed");
}

function parseMode(args: string[]): Mode {
  const modeIndex = args.findIndex((value) => value === "--mode");
  if (modeIndex === -1) return "local";
  const value = args[modeIndex + 1];
  if (value === "local" || value === "service") return value;
  throw new Error(`Invalid --mode value: ${String(value)} (expected local|service)`);
}

function parseRunId(output: string): string {
  const match = output.match(/^Run\s+([A-Za-z0-9-]+)\s+->\s+completed$/m);
  if (!match?.[1]) {
    throw new Error(
      ["Unable to parse runId from tidy output", "--- begin output ---", output.trimEnd(), "--- end output ---"].join(
        "\n"
      )
    );
  }
  return match[1];
}

function assertRemoteEnv(): void {
  const remoteUrl = process.env.BIOFLOW_REMOTE_URL;
  const hasToken = typeof process.env.BIOFLOW_REMOTE_TOKEN === "string" && process.env.BIOFLOW_REMOTE_TOKEN.length > 0;
  const hasOrgId = typeof process.env.BIOFLOW_REMOTE_ORG_ID === "string" && process.env.BIOFLOW_REMOTE_ORG_ID.length > 0;

  if (!remoteUrl) {
    throw new Error("BIOFLOW_REMOTE_URL is required for --mode service");
  }

  if (!hasToken && !hasOrgId) {
    throw new Error("Set BIOFLOW_REMOTE_TOKEN or BIOFLOW_REMOTE_ORG_ID for --mode service");
  }
}

async function runBioflowCommand(params: {
  args: string[];
  baseDir: string;
  step: string;
}): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("npm", ["run", "-s", "bioflow", "--", ...params.args], {
      env: { ...process.env, BIOFLOW_BASE_DIR: params.baseDir },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      const output = `${stdout}${stderr}`;
      if (code !== 0) {
        reject(
          new Error(
            [
              `Step failed: ${params.step} (exit=${String(code)})`,
              "--- begin output ---",
              output.trimEnd(),
              "--- end output ---"
            ].join("\n")
          )
        );
        return;
      }
      resolve({ output });
    });
  });
}

async function assertLocalVerify(params: { baseDir: string; runId: string; step: string }): Promise<void> {
  const result = await verifyRun({ baseDir: params.baseDir, runId: params.runId });
  if (result.valid) return;

  throw new Error(
    [
      `Step failed: ${params.step}`,
      ...result.errors.map((line) => `- ${line}`)
    ].join("\n")
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
