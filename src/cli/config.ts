import path from "node:path";
import os from "node:os";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";

const CliRemoteConfigSchema = z.object({
  url: z.string().min(1).optional(),
  token: z.string().min(1).optional(),
  orgId: z.string().min(1).optional()
});

const CliConfigSchema = z.object({
  remote: CliRemoteConfigSchema.default({})
});

export type CliConfig = z.infer<typeof CliConfigSchema>;

export interface ResolvedRemoteDefaults {
  url: string;
  token?: string | undefined;
  orgId?: string | undefined;
}

export function resolveCliConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.BIOFLOW_CONFIG_PATH;
  if (fromEnv && fromEnv.trim().length > 0) return path.resolve(fromEnv);
  return path.resolve(os.homedir(), ".config", "bioflow", "config.json");
}

export function loadCliConfig(env: NodeJS.ProcessEnv = process.env): CliConfig {
  const filePath = resolveCliConfigPath(env);
  let parsedRaw: unknown;
  try {
    const raw = readFileSync(filePath, "utf8");
    parsedRaw = JSON.parse(raw) as unknown;
  } catch {
    return { remote: {} };
  }

  const parsed = CliConfigSchema.safeParse(parsedRaw);
  if (!parsed.success) return { remote: {} };
  return parsed.data;
}

export function saveCliConfig(config: CliConfig, env: NodeJS.ProcessEnv = process.env): string {
  const filePath = resolveCliConfigPath(env);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return filePath;
}

export function resolveRemoteDefaults(env: NodeJS.ProcessEnv = process.env): ResolvedRemoteDefaults {
  const config = loadCliConfig(env);
  return {
    url: env.BIOFLOW_REMOTE_URL ?? config.remote.url ?? "http://localhost:8080",
    token: env.BIOFLOW_REMOTE_TOKEN ?? config.remote.token,
    orgId: env.BIOFLOW_REMOTE_ORG_ID ?? config.remote.orgId
  };
}
