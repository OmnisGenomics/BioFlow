import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { loadCliConfig, resolveRemoteDefaults, saveCliConfig } from "../src/cli/config.js";

describe("cli config", () => {
  it("saves and loads auth config from BIOFLOW_CONFIG_PATH", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "bioflow-cli-config-save-"));
    const configPath = path.join(tempDir, "config.json");
    const env = { BIOFLOW_CONFIG_PATH: configPath } as NodeJS.ProcessEnv;

    try {
      const written = saveCliConfig(
        {
          remote: {
            url: "https://api.example",
            token: "bf_live_token_example",
            orgId: "00000000-0000-0000-0000-000000000123"
          }
        },
        env
      );
      expect(written).toBe(configPath);

      const loaded = loadCliConfig(env);
      expect(loaded).toEqual({
        remote: {
          url: "https://api.example",
          token: "bf_live_token_example",
          orgId: "00000000-0000-0000-0000-000000000123"
        }
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("uses config defaults for remote resolution when env is unset", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "bioflow-cli-config-defaults-"));
    const configPath = path.join(tempDir, "config.json");
    const env = { BIOFLOW_CONFIG_PATH: configPath } as NodeJS.ProcessEnv;

    try {
      saveCliConfig(
        {
          remote: {
            url: "https://beta.example",
            token: "bf_test_token_example",
            orgId: "00000000-0000-0000-0000-000000000456"
          }
        },
        env
      );

      const resolved = resolveRemoteDefaults(env);
      expect(resolved).toEqual({
        url: "https://beta.example",
        token: "bf_test_token_example",
        orgId: "00000000-0000-0000-0000-000000000456"
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("prefers env values over stored config", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "bioflow-cli-config-env-"));
    const configPath = path.join(tempDir, "config.json");
    const env = {
      BIOFLOW_CONFIG_PATH: configPath,
      BIOFLOW_REMOTE_URL: "https://override.example",
      BIOFLOW_REMOTE_TOKEN: "bf_live_override_token",
      BIOFLOW_REMOTE_ORG_ID: "00000000-0000-0000-0000-000000000789"
    } as NodeJS.ProcessEnv;

    try {
      saveCliConfig(
        {
          remote: {
            url: "https://stored.example",
            token: "bf_test_stored_token",
            orgId: "00000000-0000-0000-0000-000000000111"
          }
        },
        env
      );

      const resolved = resolveRemoteDefaults(env);
      expect(resolved).toEqual({
        url: "https://override.example",
        token: "bf_live_override_token",
        orgId: "00000000-0000-0000-0000-000000000789"
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("tolerates invalid config json and falls back to localhost", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "bioflow-cli-config-invalid-"));
    const configPath = path.join(tempDir, "config.json");
    const env = { BIOFLOW_CONFIG_PATH: configPath } as NodeJS.ProcessEnv;

    try {
      await writeFile(configPath, "{ this-is-not-json", "utf8");
      expect(loadCliConfig(env)).toEqual({ remote: {} });
      expect(resolveRemoteDefaults(env)).toEqual({
        url: "http://localhost:8080",
        token: undefined,
        orgId: undefined
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
