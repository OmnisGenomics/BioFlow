import path from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createMockHostedSelfServeServer } from "./helpers/mock-hosted-self-serve.js";

const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

interface CliRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

describe("cli autopilot:run flow", () => {
  it("completes signup->run->verify->share against hosted API and emits valid summary", async () => {
    const repoRoot = path.resolve(".");
    const artifactPath = resolveOptionalPath(process.env.BIOFLOW_AUTOPILOT_FLOW_OUT);
    const startedAt = new Date().toISOString();
    const report: Record<string, unknown> = {
      schemaVersion: "cli-autopilot-run-flow-report.v1",
      startedAt,
      status: "running",
      summary: null,
      checks: {},
      observed: {}
    };
    const tempDir = await mkdtemp(path.join(tmpdir(), "bioflow-autopilot-flow-"));
    const mockHosted = await createMockHostedSelfServeServer();

    try {
      const outPath = path.join(tempDir, "autopilot-run.json");
      const configPath = path.join(tempDir, "config.json");
      const baseDir = path.join(tempDir, ".bioflow");
      const slug = `autopilot-flow-${Date.now()}`;

      const autopilot = await runCli(
        [
          "autopilot:run",
          "--remote-url",
          mockHosted.baseUrl,
          "--name",
          "Autopilot Flow",
          "--slug",
          slug,
          "--config-path",
          configPath,
          "--out",
          outPath,
          "--enforce-policy"
        ],
        {
          BIOFLOW_BASE_DIR: baseDir
        },
        repoRoot
      );
      expect(autopilot.status, `${autopilot.stdout}\n${autopilot.stderr}`).toBe(0);
      expect(autopilot.stdout).toContain("smoke.status=completed");
      expect(autopilot.stdout).toContain("smoke.policy_pass=true");
      report.autopilotStdout = autopilot.stdout;

      const summary = JSON.parse(await readFile(outPath, "utf8")) as Record<string, unknown>;
      expect(summary.schemaVersion).toBe("self-serve-autopilot.v1");
      expect(summary.remoteUrl).toBe(mockHosted.baseUrl);
      expect(summary.orgSlug).toBe(slug);
      expect(summary.persistedAuth).toBe(true);
      expect(summary.configPath).toBe(path.resolve(configPath));
      expect(summary.nextAction).toBe("billing_configured");
      report.summary = summary;

      const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
      const remote = (config.remote ?? {}) as Record<string, unknown>;
      expect(remote.url).toBe(mockHosted.baseUrl);
      expect(remote.orgId).toBe(summary.orgId);
      expect(typeof remote.token).toBe("string");
      expect(String(remote.token ?? "")).toMatch(/^bf_test_/);
      const token = String(remote.token ?? "");
      report.config = {
        remote: {
          url: remote.url,
          orgId: remote.orgId,
          tokenPrefix: token.slice(0, 12)
        }
      };

      const gate = await runCli(["autopilot:gate", outPath, "--json"], {}, repoRoot);
      expect(gate.status, `${gate.stdout}\n${gate.stderr}`).toBe(0);
      const gatePayload = JSON.parse(gate.stdout.trim()) as Record<string, unknown>;
      expect(gatePayload).toMatchObject({ ok: true, gate: "pass" });
      report.gate = gatePayload;

      expect(mockHosted.state.hasRun).toBe(true);
      expect(mockHosted.state.hasVerify).toBe(true);
      expect(mockHosted.state.hasShare).toBe(true);
      expect(mockHosted.state.objects.size).toBeGreaterThan(0);
      report.observed = {
        hasRun: mockHosted.state.hasRun,
        hasVerify: mockHosted.state.hasVerify,
        hasShare: mockHosted.state.hasShare,
        uploadedObjectCount: mockHosted.state.objects.size
      };
      report.status = "passed";
    } catch (err) {
      report.status = "failed";
      report.error = err instanceof Error ? err.stack ?? err.message : String(err);
      throw err;
    } finally {
      report.finishedAt = new Date().toISOString();
      if (artifactPath) await writeFlowArtifact(artifactPath, report);
      await mockHosted.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 120_000);

  it("fails with machine-readable output when enforce-policy thresholds are not met", async () => {
    const repoRoot = path.resolve(".");
    const tempDir = await mkdtemp(path.join(tmpdir(), "bioflow-autopilot-flow-fail-"));
    const mockHosted = await createMockHostedSelfServeServer();

    try {
      const outPath = path.join(tempDir, "autopilot-run.json");
      const configPath = path.join(tempDir, "config.json");
      const baseDir = path.join(tempDir, ".bioflow");
      const slug = `autopilot-flow-fail-${Date.now()}`;

      const result = await runCli(
        [
          "autopilot:run",
          "--remote-url",
          mockHosted.baseUrl,
          "--name",
          "Autopilot Flow Fail",
          "--slug",
          slug,
          "--config-path",
          configPath,
          "--out",
          outPath,
          "--enforce-policy",
          "--min-progress-completed",
          "5",
          "--json"
        ],
        {
          BIOFLOW_BASE_DIR: baseDir
        },
        repoRoot
      );

      expect(result.status).toBe(1);
      const payload = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
      expect(payload).toMatchObject({
        ok: false,
        error: "autopilot_policy_failed"
      });
      expect(Array.isArray(payload.violations)).toBe(true);
      expect(JSON.stringify(payload.violations ?? [])).toContain("minProgressCompleted");

      const summary = JSON.parse(await readFile(outPath, "utf8")) as Record<string, unknown>;
      expect(summary.schemaVersion).toBe("self-serve-autopilot.v1");
    } finally {
      await mockHosted.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 120_000);

  it("writes failure artifact when run fails before summary stage", async () => {
    const repoRoot = path.resolve(".");
    const tempDir = await mkdtemp(path.join(tmpdir(), "bioflow-autopilot-flow-network-fail-"));
    try {
      const outPath = path.join(tempDir, "autopilot-run.json");

      const result = await runCli(
        [
          "autopilot:run",
          "--remote-url",
          "http://127.0.0.1:1",
          "--name",
          "Autopilot Flow NetFail",
          "--slug",
          `autopilot-flow-netfail-${Date.now()}`,
          "--out",
          outPath,
          "--json"
        ],
        {},
        repoRoot
      );

      expect(result.status).toBe(1);
      const payload = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
      expect(payload).toMatchObject({
        ok: false,
        error: "autopilot_run_failed"
      });
      expect(String(payload.errorSha256 ?? "")).toMatch(/^[a-f0-9]{64}$/);

      const failureArtifact = JSON.parse(await readFile(outPath, "utf8")) as Record<string, unknown>;
      expect(failureArtifact).toMatchObject({
        schemaVersion: "self-serve-autopilot-error.v1",
        stage: "signup",
        errorSha256: payload.errorSha256
      });
      expect(String(failureArtifact.message ?? "")).toContain("Self-serve signup request failed");

      const gate = await runCli(["autopilot:gate", outPath, "--json"], {}, repoRoot);
      expect(gate.status).toBe(1);
      const gatePayload = JSON.parse(gate.stdout.trim()) as Record<string, unknown>;
      expect(gatePayload).toMatchObject({
        ok: false,
        error: "autopilot_run_failed",
        filePath: path.resolve(outPath),
        schemaVersion: "self-serve-autopilot-error.v1",
        stage: "signup",
        errorSha256: failureArtifact.errorSha256,
        digestMatches: true
      });
      expect(String(gatePayload.message ?? "")).toContain("Self-serve signup request failed");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 120_000);
});

function resolveOptionalPath(value: string | undefined): string | null {
  if (!value || value.trim().length === 0) return null;
  return path.resolve(value);
}

async function writeFlowArtifact(filePath: string, payload: Record<string, unknown>): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function runCli(
  args: string[],
  envOverrides: Record<string, string>,
  cwd: string
): Promise<CliRunResult> {
  return await new Promise<CliRunResult>((resolve, reject) => {
    const child = spawn(npmCmd, ["run", "-s", "bioflow", "--", ...args], {
      cwd,
      env: {
        ...process.env,
        ...envOverrides
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });

    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
}
