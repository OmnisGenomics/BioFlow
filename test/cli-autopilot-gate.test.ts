import path from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { sha256Json } from "../src/core/hash.js";

const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

interface CliRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

interface SummaryWithoutDigest {
  schemaVersion: "self-serve-autopilot.v1";
  startedAt: string;
  completedAt: string;
  durationMs: number;
  remoteUrl: string;
  orgId: string;
  orgSlug: string;
  runId: string;
  progress: {
    completed: number;
    total: number;
  };
  nextAction: string | null;
  checklist: Array<{
    id: string;
    completed: boolean;
  }>;
  status: "completed";
  configPath: string | null;
  persistedAuth: boolean;
}

interface SummaryWithDigest extends SummaryWithoutDigest {
  summarySha256: string;
}

interface FailureWithoutDigest {
  schemaVersion: "self-serve-autopilot-error.v1";
  startedAt: string;
  failedAt: string;
  remoteUrl: string;
  orgSlug: string;
  orgName: string;
  stage:
    | "signup"
    | "onboarding_initial"
    | "local_run"
    | "local_verify"
    | "remote_push"
    | "remote_verify"
    | "share"
    | "onboarding_final"
    | "policy_enforce";
  enforcePolicy: boolean;
  policy: {
    maxDurationMs: number;
    minProgressCompleted: number;
    minProgressRatio: number;
    requirePersistedAuth: boolean;
    requiredChecklistIds: string[];
  };
  message: string;
}

interface FailureWithDigest extends FailureWithoutDigest {
  errorSha256: string;
}

describe("cli autopilot:gate", () => {
  it("passes for valid summary artifact", async () => {
    const repoRoot = path.resolve(".");
    const tempDir = await mkdtemp(path.join(tmpdir(), "bioflow-cli-autopilot-gate-pass-"));
    const summaryPath = path.join(tempDir, "autopilot-run.json");
    try {
      const summary = makeSummary();
      await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

      const result = await runCli(["autopilot:gate", summaryPath, "--json"], repoRoot);
      expect(result.status, result.stderr).toBe(0);
      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(parsed).toMatchObject({
        ok: true,
        gate: "pass",
        filePath: path.resolve(summaryPath),
        schemaVersion: "self-serve-autopilot.v1",
        runId: summary.runId,
        orgId: summary.orgId,
        orgSlug: summary.orgSlug,
        summarySha256: summary.summarySha256,
        digestMatches: true
      });
      expect((parsed.violations as unknown[]) ?? []).toHaveLength(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("fails with autopilot_policy_failed when policy thresholds are not met", async () => {
    const repoRoot = path.resolve(".");
    const tempDir = await mkdtemp(path.join(tmpdir(), "bioflow-cli-autopilot-gate-policy-fail-"));
    const summaryPath = path.join(tempDir, "autopilot-run.json");
    try {
      const summary = makeSummary();
      await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

      const result = await runCli(["autopilot:gate", summaryPath, "--max-duration-ms", "1000", "--json"], repoRoot);
      expect(result.status).toBe(1);
      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(parsed).toMatchObject({
        ok: false,
        error: "autopilot_policy_failed",
        filePath: path.resolve(summaryPath),
        runId: summary.runId,
        summarySha256: summary.summarySha256
      });
      expect(JSON.stringify(parsed.violations ?? [])).toContain("durationMs");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("applies BIOFLOW_AUTOPILOT_* policy env defaults when flags are omitted", async () => {
    const repoRoot = path.resolve(".");
    const tempDir = await mkdtemp(path.join(tmpdir(), "bioflow-cli-autopilot-gate-env-policy-"));
    const summaryPath = path.join(tempDir, "autopilot-run.json");
    try {
      const summary = makeSummary();
      await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

      const result = await runCli(["autopilot:gate", summaryPath, "--json"], repoRoot, {
        BIOFLOW_AUTOPILOT_MAX_DURATION_MS: "1000"
      });
      expect(result.status).toBe(1);
      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(parsed).toMatchObject({
        ok: false,
        error: "autopilot_policy_failed",
        filePath: path.resolve(summaryPath),
        runId: summary.runId
      });
      expect(JSON.stringify(parsed.violations ?? [])).toContain("durationMs");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("uses BIOFLOW_AUTOPILOT_OUT when file arg is omitted", async () => {
    const repoRoot = path.resolve(".");
    const tempDir = await mkdtemp(path.join(tmpdir(), "bioflow-cli-autopilot-gate-env-default-"));
    const summaryPath = path.join(tempDir, "autopilot-run.json");
    try {
      const summary = makeSummary();
      await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

      const result = await runCli(["autopilot:gate", "--json"], repoRoot, {
        BIOFLOW_AUTOPILOT_OUT: summaryPath
      });
      expect(result.status, result.stderr).toBe(0);
      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(parsed).toMatchObject({
        ok: true,
        gate: "pass",
        filePath: path.resolve(summaryPath),
        runId: summary.runId,
        summarySha256: summary.summarySha256
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("fails with autopilot_run_failed for failure artifact", async () => {
    const repoRoot = path.resolve(".");
    const tempDir = await mkdtemp(path.join(tmpdir(), "bioflow-cli-autopilot-gate-failure-"));
    const artifactPath = path.join(tempDir, "autopilot-run.json");
    try {
      const failure = makeFailureArtifact();
      await writeFile(artifactPath, `${JSON.stringify(failure, null, 2)}\n`, "utf8");

      const result = await runCli(["autopilot:gate", artifactPath, "--json"], repoRoot);
      expect(result.status).toBe(1);
      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(parsed).toMatchObject({
        ok: false,
        error: "autopilot_run_failed",
        filePath: path.resolve(artifactPath),
        schemaVersion: "self-serve-autopilot-error.v1",
        stage: failure.stage,
        errorSha256: failure.errorSha256,
        digestMatches: true
      });
      expect(String(parsed.message ?? "")).toContain("Self-serve signup request failed");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("fails with digest_mismatch for tampered failure artifact", async () => {
    const repoRoot = path.resolve(".");
    const tempDir = await mkdtemp(path.join(tmpdir(), "bioflow-cli-autopilot-gate-failure-mismatch-"));
    const artifactPath = path.join(tempDir, "autopilot-run.json");
    try {
      const failure = makeFailureArtifact();
      const tampered = { ...failure, errorSha256: "0".repeat(64) };
      await writeFile(artifactPath, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");

      const result = await runCli(["autopilot:gate", artifactPath, "--json"], repoRoot);
      expect(result.status).toBe(1);
      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(parsed).toMatchObject({
        ok: false,
        error: "digest_mismatch",
        artifactKind: "failure",
        filePath: path.resolve(artifactPath),
        expectedSha256: "0".repeat(64)
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("fails with digest_mismatch for tampered summary artifact", async () => {
    const repoRoot = path.resolve(".");
    const tempDir = await mkdtemp(path.join(tmpdir(), "bioflow-cli-autopilot-gate-summary-mismatch-"));
    const summaryPath = path.join(tempDir, "autopilot-run.json");
    try {
      const summary = makeSummary();
      const tampered = { ...summary, summarySha256: "0".repeat(64) };
      await writeFile(summaryPath, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");

      const result = await runCli(["autopilot:gate", summaryPath, "--json"], repoRoot);
      expect(result.status).toBe(1);
      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(parsed).toMatchObject({
        ok: false,
        error: "digest_mismatch",
        artifactKind: "summary",
        filePath: path.resolve(summaryPath),
        expectedSha256: "0".repeat(64)
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 60_000);
});

function makeSummaryBase(): SummaryWithoutDigest {
  return {
    schemaVersion: "self-serve-autopilot.v1",
    startedAt: "2026-02-09T18:00:00.000Z",
    completedAt: "2026-02-09T18:00:05.000Z",
    durationMs: 5000,
    remoteUrl: "https://example.test",
    orgId: "11111111-1111-4111-8111-111111111111",
    orgSlug: "acme-autopilot",
    runId: "22222222-2222-4222-8222-222222222222",
    progress: {
      completed: 4,
      total: 5
    },
    nextAction: "billing_configured",
    checklist: [
      { id: "org_created", completed: true },
      { id: "billing_configured", completed: false },
      { id: "first_run_created", completed: true },
      { id: "first_run_verified", completed: true },
      { id: "first_run_shared", completed: true }
    ],
    status: "completed",
    configPath: ".bioflow-ci/config.json",
    persistedAuth: true
  };
}

function makeSummary(): SummaryWithDigest {
  const base = makeSummaryBase();
  return {
    ...base,
    summarySha256: sha256Json(base)
  };
}

function makeFailureArtifactBase(): FailureWithoutDigest {
  return {
    schemaVersion: "self-serve-autopilot-error.v1",
    startedAt: "2026-02-09T18:00:00.000Z",
    failedAt: "2026-02-09T18:00:01.000Z",
    remoteUrl: "https://example.test",
    orgSlug: "acme-autopilot",
    orgName: "Acme Autopilot",
    stage: "signup",
    enforcePolicy: true,
    policy: {
      maxDurationMs: 900000,
      minProgressCompleted: 4,
      minProgressRatio: 0.8,
      requirePersistedAuth: true,
      requiredChecklistIds: ["org_created", "first_run_created", "first_run_verified", "first_run_shared"]
    },
    message: "Self-serve signup request failed: connect ECONNREFUSED 127.0.0.1:1"
  };
}

function makeFailureArtifact(): FailureWithDigest {
  const base = makeFailureArtifactBase();
  return {
    ...base,
    errorSha256: sha256Json(base)
  };
}

async function runCli(
  args: string[],
  cwd: string,
  envOverrides: Record<string, string> = {}
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
