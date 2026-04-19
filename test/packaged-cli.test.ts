import path from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createMockHostedSelfServeServer } from "./helpers/mock-hosted-self-serve.js";

const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
const runPackagedCliTest = process.env.BIOFLOW_RUN_PACKAGED_CLI_TEST === "1";

interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runCommand(args: string[], cwd: string, timeoutMs = 120_000): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(npmCmd, args, {
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

    const build = await runCommand(["run", "build"], repoRoot);
    expect(build.status, build.stderr).toBe(0);

    const pack = await runCommand(["pack", "--json"], repoRoot);
    expect(pack.status, pack.stderr).toBe(0);
    const packed = JSON.parse(pack.stdout.trim()) as Array<{ filename?: string }>;
    const tarballName = packed[0]?.filename;
    expect(typeof tarballName).toBe("string");
    const tarballPath = path.resolve(repoRoot, String(tarballName));

    const tempDir = await mkdtemp(path.join(tmpdir(), "bioflow-packaged-cli-"));
    try {
      const init = await runCommand(["init", "-y"], tempDir);
      expect(init.status, init.stderr).toBe(0);

      const install = await runCommand(
        ["install", "--no-audit", "--no-fund", "--ignore-scripts", "--omit=dev", "--prefer-offline", tarballPath],
        tempDir,
        600_000
      );
      expect(install.status, install.stderr).toBe(0);

      const help = await runCommand(["exec", "--yes", "--", "bioflow", "--help"], tempDir);
      expect(help.status, help.stderr).toBe(0);
      expect(help.stdout).toContain("Usage:");

      const autopilotHelp = await runCommand(["exec", "--yes", "--", "bioflow", "autopilot:run", "--help"], tempDir);
      expect(autopilotHelp.status, autopilotHelp.stderr).toBe(2);
      expect(autopilotHelp.stdout).toContain("bioflow autopilot:run");

      const mockHosted = await createMockHostedSelfServeServer();
      try {
        const slug = `packaged-autopilot-${Date.now()}`;
        const configPath = path.join(tempDir, ".bioflow-ci", "config.json");
        const outPath = path.join(tempDir, "autopilot-summary.json");

        const autopilotRun = await runCommand(
          [
            "exec",
            "--yes",
            "--",
            "bioflow",
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

        const gate = await runCommand(["exec", "--yes", "--", "bioflow", "autopilot:gate", outPath, "--json"], tempDir);
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
