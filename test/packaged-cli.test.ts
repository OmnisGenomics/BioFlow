import { nodeCommand, npmCommand } from "../scripts/lib/process-command.js";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createMockHostedSelfServeServer } from "./helpers/mock-hosted-self-serve.js";

const runPackagedCliTest = process.env.BIOFLOW_RUN_PACKAGED_CLI_TEST === "1";

interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runNpm(args: string[], cwd: string, timeoutMs = 120_000): Promise<CommandResult> {
  return runCommand(npmCommand(args), cwd, timeoutMs);
}

function runPackagedCli(args: string[], cwd: string, timeoutMs = 120_000): Promise<CommandResult> {
  const packageRoot = path.join(cwd, "node_modules", "@bioflow", "cli");
  const manifest = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")) as {
    bin: { bioflow: string };
  };
  const cliPath = path.resolve(packageRoot, manifest.bin.bioflow);
  return runCommand(nodeCommand(cliPath, args), cwd, timeoutMs);
}

function runCommand(command: [string, string[]], cwd: string, timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(...command, {
      cwd,
      env: { ...process.env, CI: "1", npm_config_yes: "true" },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timeout);
      resolve({
        status: 1,
        stdout,
        stderr: `${stderr}\n${err instanceof Error ? err.message : String(err)}`
      });
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({
        status: typeof code === "number" ? code : 1,
        stdout,
        stderr: `${stderr}${timedOut ? "\ncommand timed out" : ""}`
      });
    });
  });
}

describe("packaged CLI", () => {
  const testCase = runPackagedCliTest ? it : it.skip;
  testCase("builds, packs, installs, and executes packaged autopilot flow", async () => {
    const repoRoot = path.resolve(".");

    const build = await runNpm(["run", "build"], repoRoot);
    expect(build.status, build.stderr).toBe(0);

    const pack = await runNpm(["pack", "--json"], repoRoot);
    expect(pack.status, pack.stderr).toBe(0);
    const packed = JSON.parse(pack.stdout.trim()) as Array<{ filename?: string }>;
    const tarballName = packed[0]?.filename;
    expect(typeof tarballName).toBe("string");
    const tarballPath = path.resolve(repoRoot, String(tarballName));

    const tempDir = await mkdtemp(path.join(tmpdir(), "bioflow-packaged-cli-"));
    try {
      const init = await runNpm(["init", "-y"], tempDir);
      expect(init.status, init.stderr).toBe(0);

      const install = await runNpm(
        ["install", "--no-audit", "--no-fund", "--ignore-scripts", "--omit=dev", "--prefer-offline", tarballPath],
        tempDir,
        600_000
      );
      expect(install.status, install.stderr).toBe(0);
      expect(await readFile(path.join(tempDir, "node_modules", "@bioflow", "cli", "docs", "LOCAL_SAMPLE_SHEET.md"), "utf8"))
        .toContain("Local sample-sheet CLI operations");

      const help = await runPackagedCli(["--help"], tempDir);
      expect(help.status, help.stderr).toBe(0);
      expect(help.stdout).toContain("Usage:");

      const autopilotHelp = await runPackagedCli(["autopilot:run", "--help"], tempDir);
      expect(autopilotHelp.status, autopilotHelp.stderr).toBe(2);
      expect(autopilotHelp.stdout).toContain("bioflow autopilot:run");

      // Exercise the installed local CLI without a source checkout or remote service.
      const samplePath = path.join(tempDir, "sample.csv");
      const localStore = path.join(tempDir, "local-store");
      const localOut = path.join(tempDir, "cleaned");
      await writeFile(samplePath, 'Sample_ID,Index,Note\nalpha-1,acgt,"quoted, metadata"\n');
      const validation = await runPackagedCli(["validate-sample-sheet", samplePath, "--json"], tempDir);
      expect(validation.status, validation.stderr).toBe(0);
      expect(JSON.parse(validation.stdout)).toMatchObject({valid: true, needsChanges: true});
      const previewResult = await runPackagedCli(["preview-sample-sheet", samplePath, "--json"], tempDir);
      expect(previewResult.status, previewResult.stderr).toBe(0);
      const preview = JSON.parse(previewResult.stdout);
      const tidy = await runPackagedCli(["tidy", samplePath, "--accept-preview", preview.previewSha256, "--base-dir", localStore, "--out", localOut], tempDir);
      expect(tidy.status, tidy.stderr).toBe(0);
      const localRunId = tidy.stdout.match(/Run ([\w-]+) -> completed/)?.[1];
      expect(localRunId).toBeTruthy();
      const verify = await runPackagedCli(["verify", localRunId!, "--base-dir", localStore], tempDir);
      expect(verify.status, verify.stderr).toBe(0);
      const report = await runPackagedCli(["report", localRunId!, "--base-dir", localStore, "--out", path.join(tempDir, "reports")], tempDir);
      expect(report.status, report.stderr).toBe(0);
      const csv = await readFile(path.join(localOut, "tidy.sample-sheet-v1.data.csv"), "utf8");
      expect(csv).toContain('ALPHA_1,ACGT,"quoted, metadata"');
      expect(csv).toBe(preview.cleanedText);
      const collision = await runPackagedCli(["tidy", samplePath, "--base-dir", localStore, "--out", localOut], tempDir);
      expect(collision.status).toBe(1);
      expect(collision.stderr).toContain("Refusing to overwrite export");
      expect(await readFile(path.join(localOut, "tidy.sample-sheet-v1.data.csv"), "utf8")).toBe(csv);
      await writeFile(samplePath, "Sample_ID,Index\nalpha,ACGT,extra\n");
      const invalidReview = await runPackagedCli(["validate-sample-sheet", samplePath, "--json"], tempDir);
      expect(invalidReview.status).toBe(1);
      expect(JSON.parse(invalidReview.stdout).valid).toBe(false);
      const rejected = await runPackagedCli(["tidy", samplePath, "--base-dir", localStore], tempDir);
      expect(rejected.status).toBe(1);
      expect(rejected.stderr).toContain("Expected at most 2 fields");

      const mockHosted = await createMockHostedSelfServeServer();
      try {
        const slug = `packaged-autopilot-${Date.now()}`;
        const configPath = path.join(tempDir, ".bioflow-ci", "config.json");
        const outPath = path.join(tempDir, "autopilot-summary.json");

        const autopilotRun = await runPackagedCli([
            "autopilot:run",
            "--remote-url",
            mockHosted.baseUrl,
            "--name",
            "Packaged Autopilot",
            "--slug",
            slug,
            "--config-path",
            configPath,
            "--out",
            outPath,
            "--enforce-policy"
          ],
          tempDir,
          300_000
        );
        expect(autopilotRun.status, `${autopilotRun.stdout}\n${autopilotRun.stderr}`).toBe(0);
        expect(autopilotRun.stdout).toContain("smoke.status=completed");
        expect(autopilotRun.stdout).toContain("smoke.policy_pass=true");

        const summaryRaw = await readFile(outPath, "utf8");
        const summary = JSON.parse(summaryRaw) as Record<string, unknown>;
        expect(summary.schemaVersion).toBe("self-serve-autopilot.v1");
        expect(summary.remoteUrl).toBe(mockHosted.baseUrl);
        expect(summary.orgSlug).toBe(slug);
        expect(summary.persistedAuth).toBe(true);
        expect(summary.configPath).toBe(path.resolve(configPath));
        expect(summary.nextAction).toBe("billing_configured");

        const gate = await runPackagedCli(["autopilot:gate", outPath, "--json"], tempDir);
        expect(gate.status, `${gate.stdout}\n${gate.stderr}`).toBe(0);
        expect(gate.stdout).toContain('"ok": true');
        expect(gate.stdout).toContain('"gate": "pass"');

        expect(mockHosted.state.hasRun).toBe(true);
        expect(mockHosted.state.hasVerify).toBe(true);
        expect(mockHosted.state.hasShare).toBe(true);
        expect(mockHosted.state.objects.size).toBeGreaterThan(0);
      } finally {
        await mockHosted.close();
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
      await rm(tarballPath, { force: true });
    }
  }, 240_000);
});
