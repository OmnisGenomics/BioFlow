import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

describe("cli auth:set-key", () => {
  it("writes token and remote defaults into config file", async () => {
    const repoRoot = path.resolve(".");
    const tempDir = await mkdtemp(path.join(tmpdir(), "bioflow-cli-auth-set-key-"));
    const configPath = path.join(tempDir, "config.json");

    try {
      const result = spawnSync(
        npmCmd,
        [
          "run",
          "bioflow",
          "--",
          "auth:set-key",
          "bf_live_1234567890abcdef1234567890abcdef",
          "--remote-url",
          "https://api.example",
          "--org-id",
          "00000000-0000-0000-0000-000000000999"
        ],
        {
          cwd: repoRoot,
          env: { ...process.env, BIOFLOW_CONFIG_PATH: configPath },
          encoding: "utf8"
        }
      );

      expect(result.status, result.stderr).toBe(0);
      const raw = await readFile(configPath, "utf8");
      const parsed = JSON.parse(raw) as { remote?: { token?: string; url?: string; orgId?: string } };
      expect(parsed).toMatchObject({
        remote: {
          token: "bf_live_1234567890abcdef1234567890abcdef",
          url: "https://api.example",
          orgId: "00000000-0000-0000-0000-000000000999"
        }
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("supports --config-path for isolated automation config", async () => {
    const repoRoot = path.resolve(".");
    const tempDir = await mkdtemp(path.join(tmpdir(), "bioflow-cli-auth-set-key-flag-"));
    const configPath = path.join(tempDir, "automation.json");

    try {
      const result = spawnSync(
        npmCmd,
        [
          "run",
          "bioflow",
          "--",
          "auth:set-key",
          "bf_test_abcdefabcdefabcdefabcdefabcdef",
          "--remote-url",
          "https://api.automation.example",
          "--org-id",
          "00000000-0000-0000-0000-000000000999",
          "--config-path",
          configPath
        ],
        {
          cwd: repoRoot,
          env: process.env,
          encoding: "utf8"
        }
      );

      expect(result.status, result.stderr).toBe(0);
      const raw = await readFile(configPath, "utf8");
      const parsed = JSON.parse(raw) as { remote?: { token?: string; url?: string; orgId?: string } };
      expect(parsed).toMatchObject({
        remote: {
          token: "bf_test_abcdefabcdefabcdefabcdefabcdef",
          url: "https://api.automation.example",
          orgId: "00000000-0000-0000-0000-000000000999"
        }
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 60_000);
});
