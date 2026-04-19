import { spawnSync } from "node:child_process";
import path from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

describe("cli autopilot:run", () => {
  it("prints help and exits with code 2 for --help", () => {
    const result = spawnSync(npmCmd, ["run", "-s", "bioflow", "--", "autopilot:run", "--help"], {
      cwd: path.resolve("."),
      env: process.env,
      encoding: "utf8"
    });

    expect(result.status).toBe(2);
    expect(result.stdout).toContain("bioflow autopilot:run");
    expect(result.stdout).toContain("--no-persist-auth");
  }, 20_000);

  it("prints help and exits with code 2 for invalid key mode", () => {
    const result = spawnSync(
      npmCmd,
      ["run", "-s", "bioflow", "--", "autopilot:run", "--key-mode", "invalid"],
      {
        cwd: path.resolve("."),
        env: process.env,
        encoding: "utf8"
      }
    );

    expect(result.status).toBe(2);
    expect(result.stdout).toContain("bioflow autopilot:run");
  }, 20_000);

  it("prints help and exits with code 2 when --out value is missing", () => {
    const result = spawnSync(npmCmd, ["run", "-s", "bioflow", "--", "autopilot:run", "--out"], {
      cwd: path.resolve("."),
      env: process.env,
      encoding: "utf8"
    });

    expect(result.status).toBe(2);
    expect(result.stdout).toContain("bioflow autopilot:run");
  }, 20_000);

  it("accepts --no-persist-auth and reaches runtime execution", () => {
    const result = spawnSync(
      npmCmd,
      [
        "run",
        "-s",
        "bioflow",
        "--",
        "autopilot:run",
        "--remote-url",
        "http://127.0.0.1:1",
        "--name",
        "No Persist",
        "--slug",
        "no-persist-auth",
        "--no-persist-auth",
        "--json"
      ],
      {
        cwd: path.resolve("."),
        env: process.env,
        encoding: "utf8"
      }
    );

    expect(result.status).toBe(1);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({ error: "autopilot_run_failed" });
  }, 20_000);

  it("applies BIOFLOW_AUTOPILOT_* env defaults for run metadata and output artifact path", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "bioflow-cli-autopilot-run-env-"));
    const outPath = path.join(tempDir, "autopilot-run.json");
    try {
      const result = spawnSync(npmCmd, ["run", "-s", "bioflow", "--", "autopilot:run", "--json"], {
        cwd: path.resolve("."),
        env: {
          ...process.env,
          BIOFLOW_REMOTE_URL: "http://127.0.0.1:1",
          BIOFLOW_AUTOPILOT_NAME: "Env Default Org",
          BIOFLOW_AUTOPILOT_SLUG: "env-default-org",
          BIOFLOW_AUTOPILOT_IDEMPOTENCY_KEY: "env-default-idempotency-key",
          BIOFLOW_AUTOPILOT_KEY_MODE: "test",
          BIOFLOW_AUTOPILOT_OUT: outPath
        },
        encoding: "utf8"
      });

      expect(result.status).toBe(1);
      const payload = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(payload).toMatchObject({
        error: "autopilot_run_failed",
        stage: "signup",
        artifactPath: path.resolve(outPath)
      });

      const failure = JSON.parse(readFileSync(outPath, "utf8")) as Record<string, unknown>;
      expect(failure).toMatchObject({
        schemaVersion: "self-serve-autopilot-error.v1",
        orgName: "Env Default Org",
        orgSlug: "env-default-org",
        stage: "signup"
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 20_000);
});
