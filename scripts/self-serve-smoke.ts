import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { sha256Json } from "../src/core/hash.js";
import { stableStringify } from "../src/core/stable-json.js";

interface SmokeOptions {
  remoteUrl: string;
  slug: string;
  orgName: string;
  idempotencyKey: string;
  keyMode: "live" | "test";
  configPath?: string | undefined;
  outPath?: string | undefined;
  persistAuth: boolean;
  json: boolean;
}

interface SignupCommandSuccess {
  ok: true;
  replayed: boolean;
  org: {
    id: string;
    name: string;
    slug: string;
    plan: "team" | "enterprise";
    planStatus: "active" | "trialing" | "past_due" | "cancelled" | string;
    currentPeriodEnd: string | null;
  };
  apiKey: string | null;
  remoteUrl: string;
}

interface SignupCommandError {
  ok: false;
  error: string;
  message: string;
}

type SignupCommandResponse = SignupCommandSuccess | SignupCommandError;

interface ChecklistResponse {
  progress: {
    completed: number;
    total: number;
  };
  nextAction: string | null;
  firstRunId: string | null;
  checklist: Array<{
    id: string;
    completed: boolean;
  }>;
}

interface SmokeSummary {
  schemaVersion: "self-serve-autopilot.v1";
  startedAt: string;
  completedAt: string;
  durationMs: number;
  summarySha256: string;
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

async function main(): Promise<void> {
  const options = parseSmokeArgs(process.argv.slice(2));
  if (!options) {
    printUsage();
    process.exitCode = 2;
    return;
  }

  let tempConfigDir: string | null = null;
  let configPath = options.configPath;
  const startedAtMs = Date.now();
  const startedAtIso = new Date(startedAtMs).toISOString();
  if (!options.persistAuth && !configPath) {
    tempConfigDir = await mkdtemp(path.resolve(".bioflow_smoke_cli_config_"));
    configPath = path.join(tempConfigDir, "config.json");
  }

  try {
    const signupArgs = [
      "auth:signup",
      "--name",
      options.orgName,
      "--slug",
      options.slug,
      "--plan",
      "team",
      "--key-mode",
      options.keyMode,
      "--idempotency-key",
      options.idempotencyKey,
      "--remote-url",
      options.remoteUrl,
      "--json"
    ];
    if (configPath) signupArgs.push("--config-path", configPath);

    const signupRaw = await runCommand(
      "bioflow",
      signupArgs,
      mergeEnv({
        BIOFLOW_REMOTE_URL: options.remoteUrl
      }, configPath)
    );
    const signup = parseSignupCommandOutput(signupRaw.output);
    if (!signup.ok) {
      throw new Error(`Self-serve signup failed: ${signup.error} ${signup.message}`);
    }

    const apiKey = signup.apiKey;
    if (!apiKey) {
      throw new Error("Self-serve signup did not return a one-time API key.");
    }

    const initial = await getJson<ChecklistResponse>(
      new URL("/api/v1/onboarding/checklist", ensureTrailingSlash(options.remoteUrl)).toString(),
      { authorization: `Bearer ${apiKey}` }
    );
    assertChecklistFlag(initial, "org_created", true);

    const demo = await runCommand("demo:sample-sheet:service", [], {
      ...mergeEnv(
        {
          BIOFLOW_REMOTE_URL: options.remoteUrl,
          BIOFLOW_REMOTE_TOKEN: apiKey
        },
        configPath
      )
    });
    const runId = parseRunId(demo.output);

    await runCommand("bioflow", ["share", runId, "--visibility", "org"], {
      ...mergeEnv(
        {
          BIOFLOW_REMOTE_URL: options.remoteUrl,
          BIOFLOW_REMOTE_TOKEN: apiKey
        },
        configPath
      )
    });

    const final = await getJson<ChecklistResponse>(
      new URL("/api/v1/onboarding/checklist", ensureTrailingSlash(options.remoteUrl)).toString(),
      { authorization: `Bearer ${apiKey}` }
    );
    assertChecklistFlag(final, "first_run_created", true);
    assertChecklistFlag(final, "first_run_verified", true);
    assertChecklistFlag(final, "first_run_shared", true);

    const completedAtMs = Date.now();
    const completedAtIso = new Date(completedAtMs).toISOString();
    const summaryWithoutDigest = {
      schemaVersion: "self-serve-autopilot.v1" as const,
      startedAt: startedAtIso,
      completedAt: completedAtIso,
      durationMs: Math.max(0, completedAtMs - startedAtMs),
      remoteUrl: options.remoteUrl,
      orgId: signup.org.id,
      orgSlug: signup.org.slug,
      runId,
      progress: {
        completed: final.progress.completed,
        total: final.progress.total
      },
      nextAction: final.nextAction,
      checklist: final.checklist,
      status: "completed",
      configPath: configPath ?? null,
      persistedAuth: options.persistAuth || !!options.configPath
    };
    const summary: SmokeSummary = {
      ...summaryWithoutDigest,
      summarySha256: sha256Json(summaryWithoutDigest)
    };

    if (options.outPath) {
      await writeSummaryArtifact(options.outPath, summary);
    }

    if (options.json) {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    } else {
      console.log(`smoke.remote_url=${summary.remoteUrl}`);
      console.log(`smoke.org_id=${summary.orgId}`);
      console.log(`smoke.org_slug=${summary.orgSlug}`);
      console.log(`smoke.run_id=${summary.runId}`);
      console.log(`smoke.progress=${summary.progress.completed}/${summary.progress.total}`);
      console.log(`smoke.next_action=${summary.nextAction ?? "none"}`);
      if (summary.configPath) console.log(`smoke.config_path=${summary.configPath}`);
      if (options.outPath) console.log(`smoke.out_path=${options.outPath}`);
      console.log(`smoke.summary_sha256=${summary.summarySha256}`);
      console.log(`smoke.persisted_auth=${summary.persistedAuth ? "true" : "false"}`);
      console.log("smoke.status=completed");
    }
  } finally {
    if (tempConfigDir) {
      await rm(tempConfigDir, { recursive: true, force: true });
    }
  }
}

function parseSmokeArgs(argv: string[]): SmokeOptions | null {
  const defaultRemoteUrl = process.env.BIOFLOW_REMOTE_URL ?? "http://localhost:8080";
  const defaultOutPath = process.env.BIOFLOW_SELF_SERVE_SMOKE_OUT;
  let remoteUrl = defaultRemoteUrl;
  let slug: string | undefined;
  let orgName: string | undefined;
  let idempotencyKey: string | undefined;
  let keyMode: "live" | "test" = "test";
  let configPath: string | undefined;
  let outPath = defaultOutPath;
  let persistAuth = false;
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg === "--help" || arg === "-h") return null;
    if (arg === "--remote-url") {
      const v = argv[i + 1];
      if (!v) return null;
      remoteUrl = v;
      i++;
      continue;
    }
    if (arg === "--slug") {
      const v = argv[i + 1];
      if (!v) return null;
      slug = v;
      i++;
      continue;
    }
    if (arg === "--name") {
      const v = argv[i + 1];
      if (!v) return null;
      orgName = v;
      i++;
      continue;
    }
    if (arg === "--idempotency-key") {
      const v = argv[i + 1];
      if (!v) return null;
      idempotencyKey = v;
      i++;
      continue;
    }
    if (arg === "--key-mode") {
      const v = argv[i + 1];
      if (!v) return null;
      if (v !== "live" && v !== "test") return null;
      keyMode = v;
      i++;
      continue;
    }
    if (arg === "--config-path") {
      const v = argv[i + 1];
      if (!v) return null;
      configPath = v;
      i++;
      continue;
    }
    if (arg === "--out") {
      const v = argv[i + 1];
      if (!v) return null;
      outPath = v;
      i++;
      continue;
    }
    if (arg === "--persist-auth") {
      persistAuth = true;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    return null;
  }

  const resolvedSlug =
    slug ??
    `selfserve-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${Math.random().toString(16).slice(2, 8)}`;
  return {
    remoteUrl,
    slug: resolvedSlug,
    orgName: orgName ?? `Self-Serve ${resolvedSlug}`,
    idempotencyKey: idempotencyKey ?? `smoke-${randomUUID()}`,
    keyMode,
    configPath,
    outPath: outPath ? path.resolve(outPath) : undefined,
    persistAuth,
    json
  };
}

function printUsage(): void {
  console.error(`Usage:
  npm run demo:self-serve:smoke -- [--remote-url <url>] [--name <org name>] [--slug <slug>] [--idempotency-key <key>] [--key-mode live|test] [--config-path <path>] [--out <path>] [--persist-auth] [--json]

Env defaults:
  BIOFLOW_REMOTE_URL=<url>
  BIOFLOW_SELF_SERVE_SMOKE_OUT=<path>
`);
}

function mergeEnv(values: Record<string, string>, configPath?: string): Record<string, string> {
  return configPath ? { ...values, BIOFLOW_CONFIG_PATH: configPath } : values;
}

async function writeSummaryArtifact(outPath: string, summary: SmokeSummary): Promise<void> {
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, `${stableStringify(summary)}\n`, "utf8");
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

function parseRunId(output: string): string {
  const match = output.match(/^runId=([A-Za-z0-9-]{36})$/m);
  if (!match?.[1]) {
    throw new Error(
      ["Unable to parse runId from demo output.", "--- begin output ---", output.trimEnd(), "--- end output ---"].join(
        "\n"
      )
    );
  }
  return match[1];
}

function assertChecklistFlag(checklist: ChecklistResponse, id: string, expected: boolean): void {
  const item = checklist.checklist.find((entry) => entry.id === id);
  if (!item) throw new Error(`Checklist item missing: ${id}`);
  if (item.completed !== expected) {
    throw new Error(`Checklist item ${id} expected ${String(expected)} but got ${String(item.completed)}`);
  }
}

async function getJson<T>(url: string, headers: Record<string, string>): Promise<T> {
  const res = await fetch(url, {
    method: "GET",
    headers
  });
  const text = await safeReadText(res);
  if (!res.ok) {
    throw new Error(`GET ${url} failed: ${res.status}\n${text}`);
  }
  return JSON.parse(text) as T;
}

function parseSignupCommandOutput(output: string): SignupCommandResponse {
  const text = output.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error(
      ["Unable to parse auth:signup --json output.", "--- begin output ---", output.trimEnd(), "--- end output ---"].join(
        "\n"
      )
    );
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid auth:signup --json output shape.");
  }
  const asRecord = parsed as Record<string, unknown>;
  if (asRecord.ok === true) {
    return parsed as SignupCommandSuccess;
  }
  if (asRecord.ok === false) {
    return parsed as SignupCommandError;
  }
  throw new Error("Invalid auth:signup --json output: missing ok field.");
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "<unreadable>";
  }
}

async function runCommand(
  script: string,
  args: string[],
  extraEnv: Record<string, string>
): Promise<{ output: string }> {
  return new Promise((resolve, reject) => {
    const commandArgs =
      script === "bioflow"
        ? ["run", "-s", script, "--", ...args]
        : ["run", "-s", script, ...args];
    const child = spawn("npm", commandArgs, {
      env: { ...process.env, ...extraEnv },
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
              `Command failed: npm ${commandArgs.join(" ")} (exit=${String(code)})`,
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

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
