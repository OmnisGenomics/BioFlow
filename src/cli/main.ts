#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { LocalArtifactStore } from "../core/artifact-store.js";
import { runWorkflow } from "../core/engine.js";
import { createRunId } from "../core/run-id.js";
import { assertValidWorkflow, validateWorkflow } from "../core/validate.js";
import { readWorkflowFile } from "./io.js";
import { LocalCAS } from "../core/cas.js";
import { sha256Json } from "../core/hash.js";
import { stableStringify } from "../core/stable-json.js";
import { sampleSheetV1Profile } from "../clean/profiles/sample-sheet-v1.js";
import { loadCliConfig, resolveRemoteDefaults, saveCliConfig } from "./config.js";
import { runBioFlowMcp } from "../mcp/main.js";
import type { Workflow } from "../core/types.js";
import { z } from "zod";
import {
  computeAutopilotFailureSha256,
  type AutopilotRunStage,
  type AutopilotSummary,
  type AutopilotFailureArtifact,
  DEFAULT_AUTOPILOT_POLICY,
  evaluateAutopilotPolicy,
  validateAutopilotArtifactFile
} from "./autopilot-summary.js";

interface RemoteConfig {
  url: string;
  orgId?: string | undefined;
  token?: string | undefined;
}

const SignupPlanSchema = z.enum(["team", "enterprise"]);
const SignupKeyModeSchema = z.enum(["live", "test"]);

const SelfServeSignupSuccessSchema = z.object({
  replayed: z.boolean(),
  org: z.object({
    id: z.string().uuid(),
    name: z.string().min(1),
    slug: z.string().min(1),
    plan: SignupPlanSchema,
    planStatus: z.string().min(1),
    currentPeriodEnd: z.string().nullable().optional()
  }),
  apiKeyId: z.string().uuid().optional(),
  keyPrefix: z.string().min(1).optional(),
  apiKey: z.string().min(1).nullable()
});

const SelfServeSignupErrorSchema = z
  .object({
    error: z.string().min(1).optional(),
    message: z.string().min(1).optional()
  })
  .passthrough();

interface AuthSignupJsonSuccess {
  ok: true;
  replayed: boolean;
  org: {
    id: string;
    name: string;
    slug: string;
    plan: "team" | "enterprise";
    planStatus: string;
    currentPeriodEnd: string | null;
  };
  keyPrefix: string | null;
  apiKey: string | null;
  configPath: string;
  remoteUrl: string;
}

interface AuthSignupJsonError {
  ok: false;
  error: string;
  message: string;
  status?: number | undefined;
  replayed?: boolean | undefined;
  org?: {
    id: string;
    slug: string;
  } | undefined;
  remoteUrl?: string | undefined;
}

interface OnboardingChecklistResponse {
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

interface AutopilotSignupResult {
  orgId: string;
  orgSlug: string;
  token: string;
  configPath: string;
}

const AUTOPILOT_SAMPLE_SHEET = `[Header]
IEMFileVersion,4
Investigator Name,Demo Team

[Data]
Sample_ID,Index,Lane,Project Name
alpha-1,acgt,1,Proof Bundle
alpha 1,acgt+tgca,"3,2,1",Proof Bundle
beta#2,ttaa,4-2,Proof Bundle
`;

type Command =
  | { kind: "help" }
  | {
      kind: "auth-signup";
      name: string;
      slug: string;
      plan: "team" | "enterprise";
      keyMode: "live" | "test";
      keyName?: string | undefined;
      remoteUrl: string;
      idempotencyKey?: string | undefined;
      json: boolean;
      configPath?: string | undefined;
    }
  | { kind: "init"; outPath: string }
  | { kind: "validate"; workflowPath: string }
  | { kind: "run"; workflowPath: string; inputs: string[] }
  | { kind: "verify"; runId: string }
  | {
      kind: "report";
      runId: string;
      baseDir: string;
      format: "markdown";
      outDir?: string | undefined;
      replay: boolean;
    }
  | {
      kind: "tidy";
      inputPath: string;
      baseDir: string;
      outDir?: string | undefined;
      profileName: string;
      runId?: string | undefined;
      remote?: RemoteConfig | undefined;
    }
  | {
      kind: "push";
      runId: string;
      baseDir: string;
      remote: RemoteConfig;
      concurrency: number;
      dryRun: boolean;
      profileId?: string | undefined;
      tags?: string[] | undefined;
      visibility?: "private" | "org" | "public" | undefined;
    }
  | { kind: "pull"; runId: string; baseDir: string; remote: RemoteConfig; concurrency: number; force: boolean }
  | {
      kind: "ls-remote";
      remote: RemoteConfig;
      limit: number;
      cursor?: string | undefined;
      profileId?: string | undefined;
      tags?: string | undefined;
      visibility?: "private" | "org" | "public" | undefined;
    }
  | {
      kind: "share";
      runId: string;
      remote: RemoteConfig;
      visibility: "private" | "org" | "public";
    }
  | { kind: "profiles-ls"; remote: RemoteConfig; limit: number }
  | { kind: "profiles-get"; remote: RemoteConfig; name: string }
  | { kind: "profiles-put"; remote: RemoteConfig; name: string; filePath: string }
  | { kind: "mcp" }
  | { kind: "verify-remote"; runId: string; remote: RemoteConfig; deep: boolean }
  | {
      kind: "auth-set-key";
      token: string;
      remoteUrl?: string | undefined;
      orgId?: string | undefined;
      configPath?: string | undefined;
    }
  | {
      kind: "autopilot-run";
      remoteUrl: string;
      slug: string;
      orgName: string;
      idempotencyKey: string;
      keyMode: "live" | "test";
      configPath?: string | undefined;
      outPath?: string | undefined;
      persistAuth: boolean;
      enforcePolicy: boolean;
      maxDurationMs: number;
      minProgressCompleted: number;
      minProgressRatio: number;
      requirePersistedAuth: boolean;
      requiredChecklistIds: string[];
      json: boolean;
    }
  | {
      kind: "autopilot-validate-summary";
      filePath: string;
      json: boolean;
    }
  | {
      kind: "autopilot-check-policy";
      filePath: string;
      json: boolean;
      maxDurationMs: number;
      minProgressCompleted: number;
      minProgressRatio: number;
      requirePersistedAuth: boolean;
      requiredChecklistIds: string[];
    }
  | {
      kind: "autopilot-gate";
      filePath: string;
      json: boolean;
      maxDurationMs: number;
      minProgressCompleted: number;
      minProgressRatio: number;
      requirePersistedAuth: boolean;
      requiredChecklistIds: string[];
    };

async function main(): Promise<void> {
  const cmd = parseArgs(process.argv.slice(2));
  if (!cmd) {
    printHelp();
    process.exitCode = 2;
    return;
  }

  switch (cmd.kind) {
    case "help": {
      printHelp();
      return;
    }
    case "auth-signup": {
      await runAuthSignup(cmd);
      return;
    }
    case "auth-set-key": {
      const configEnv = withConfigPathEnv(cmd.configPath);
      const current = loadCliConfig(configEnv);
      const nextRemote = {
        ...current.remote,
        token: cmd.token,
        ...(cmd.remoteUrl ? { url: cmd.remoteUrl } : {}),
        ...(cmd.orgId ? { orgId: cmd.orgId } : {})
      };
      const configPath = saveCliConfig({ remote: nextRemote }, configEnv);
      console.log(`OK: saved auth config -> ${configPath}`);
      if (nextRemote.url) console.log(`Remote URL: ${nextRemote.url}`);
      if (nextRemote.orgId) console.log(`Org ID: ${nextRemote.orgId}`);
      return;
    }
    case "autopilot-run": {
      await runAutopilotRun(cmd);
      return;
    }
    case "autopilot-validate-summary": {
      await runAutopilotValidateSummary(cmd);
      return;
    }
    case "autopilot-check-policy": {
      await runAutopilotCheckPolicy(cmd);
      return;
    }
    case "autopilot-gate": {
      await runAutopilotGate(cmd);
      return;
    }
    case "init": {
      await mkdir(path.dirname(cmd.outPath), { recursive: true });
      const example = makeExampleWorkflow();
      const YAML = await import("yaml");
      const doc = YAML.stringify(example);
      await (await import("node:fs/promises")).writeFile(cmd.outPath, doc);
      console.log(`Wrote ${cmd.outPath}`);
      return;
    }
    case "validate": {
      const input = await readWorkflowFile(cmd.workflowPath);
      const res = validateWorkflow(input);
      if (!res.ok) {
        console.error(`Invalid: ${cmd.workflowPath}`);
        for (const issue of res.issues) console.error(`- ${issue.path}: ${issue.message}`);
        process.exitCode = 1;
        return;
      }
      console.log(`OK: ${cmd.workflowPath}`);
      return;
    }
    case "run": {
      const workflowInput = await readWorkflowFile(cmd.workflowPath);
      const workflow = assertValidWorkflow(workflowInput);

      const store = new LocalArtifactStore(path.resolve(".bioflow"));
      const runId = createRunId();
      const rootInputs = [];
      for (const filePath of cmd.inputs) {
        rootInputs.push(await store.importFile(runId, path.resolve(filePath)));
      }
      const { execution, executionPath } = await runWorkflow({
        workflow,
        store,
        inputs: rootInputs,
        actor: "cli",
        runId
      });

      console.log(`Run ${execution.runId} -> ${execution.status}`);
      console.log(`Execution record: ${executionPath ?? "(not written)"}`);
      console.log(`Outputs: ${execution.outputs.map((a) => a.uri).join(", ") || "(none)"}`);
      return;
    }
    case "verify": {
      const { verifyRun } = await import("../core/verify.js");
      const result = await verifyRun({ baseDir: path.resolve(".bioflow"), runId: cmd.runId });
      if (!result.valid) {
        console.error(`FAIL: ${cmd.runId}`);
        for (const line of result.errors) console.error(`- ${line}`);
        process.exitCode = 1;
        return;
      }
      console.log(`OK: ${cmd.runId}`);
      return;
    }
    case "report": {
      const { generateGxpReport } = await import("../gxp/report.js");
      const res = await generateGxpReport({
        baseDir: cmd.baseDir,
        runId: cmd.runId,
        format: cmd.format,
        outDir: cmd.outDir,
        replay: cmd.replay
      });
      console.log(`OK: report sha256:${res.artifact.sha256}`);
      console.log(`Report digest (canonical JSON): ${res.reportDigest}`);
      if (res.outputPath) console.log(`Wrote: ${res.outputPath}`);
      return;
    }
    case "tidy": {
      const baseDir = cmd.baseDir;
      const store = new LocalArtifactStore(baseDir);
      const runId = cmd.runId ?? createRunId();
      const input = await store.importFile(runId, path.resolve(cmd.inputPath));

      const profile =
        cmd.profileName === "sample-sheet-v1"
          ? sampleSheetV1Profile
          : await fetchOrgSampleSheetProfile(cmd.profileName, cmd.remote);

      const workflow = makeTidyWorkflow({ profile });
      const { execution, executionPath } = await runWorkflow({
        workflow,
        store,
        inputs: [input],
        actor: "cli",
        runId
      });

      console.log(`Run ${execution.runId} -> ${execution.status}`);
      console.log(`Execution record: ${executionPath ?? "(not written)"}`);
      console.log(`Outputs: ${execution.outputs.map((a) => a.uri).join(", ") || "(none)"}`);

      if (cmd.outDir) {
        await exportArtifacts({
          baseDir,
          outDir: cmd.outDir,
          artifacts: execution.outputs
        });
        console.log(`Exported outputs -> ${cmd.outDir}`);
      }

      return;
    }
    case "push": {
      const { BioFlowRemote, RemoteHttpError } = await import("../sync/remote.js");
      const { pushRunToRemote } = await import("../sync/hybrid.js");
      const remote = new BioFlowRemote({
        baseUrl: cmd.remote.url,
        auth: { token: cmd.remote.token, orgId: cmd.remote.orgId }
      });
      try {
        const res = await pushRunToRemote({
          baseDir: cmd.baseDir,
          runId: cmd.runId,
          remote,
          concurrency: cmd.concurrency,
          dryRun: cmd.dryRun,
          profileId: cmd.profileId,
          tags: cmd.tags,
          visibility: cmd.visibility
        });
        const prefix = cmd.dryRun ? "DRY RUN" : "OK";
        console.log(`${prefix}: pushed ${cmd.runId} (uploaded=${res.uploaded} skipped=${res.skipped})`);
        return;
      } catch (err) {
        if (err instanceof RemoteHttpError && (err.status === 402 || err.status === 403)) {
          const parsed = tryParseJson(err.body) as any;
          if (parsed?.error === "plan_upgrade_required") {
            console.error(
              `Plan upgrade required (current=${String(parsed.current_plan)} required=${String(parsed.required)})`
            );
            console.error(`Upgrade via: POST ${cmd.remote.url.replace(/\/+$/, "")}/api/v1/billing/checkout`);
            process.exitCode = 1;
            return;
          }
          if (parsed?.error === "payment_required") {
            console.error(`Payment required (status=${String(parsed.status)})`);
            process.exitCode = 1;
            return;
          }
        }
        throw err;
      }
    }
    case "pull": {
      const { BioFlowRemote } = await import("../sync/remote.js");
      const { pullRunFromRemote } = await import("../sync/hybrid.js");
      const remote = new BioFlowRemote({
        baseUrl: cmd.remote.url,
        auth: { token: cmd.remote.token, orgId: cmd.remote.orgId }
      });
      const res = await pullRunFromRemote({
        baseDir: cmd.baseDir,
        runId: cmd.runId,
        remote,
        concurrency: cmd.concurrency,
        force: cmd.force
      });
      console.log(`OK: pulled ${cmd.runId} (downloaded=${res.downloaded} skipped=${res.skipped})`);
      return;
    }
    case "ls-remote": {
      const { BioFlowRemote } = await import("../sync/remote.js");
      const remote = new BioFlowRemote({
        baseUrl: cmd.remote.url,
        auth: { token: cmd.remote.token, orgId: cmd.remote.orgId }
      });
      const res = (await remote.listRuns({
        limit: cmd.limit,
        cursor: cmd.cursor,
        profileId: cmd.profileId,
        tags: cmd.tags,
        visibility: cmd.visibility
      })) as any;
      const runs: any[] = Array.isArray(res?.runs) ? res.runs : [];
      for (const r of runs) {
        console.log(
          `${String(r.id ?? "")}\t${String(r.status ?? "")}\t${String(r.workflow_name ?? "")}@${String(
            r.workflow_version ?? ""
          )}\t${String(r.created_at ?? "")}`
        );
      }
      if (res?.nextCursor) console.log(`nextCursor=${String(res.nextCursor)}`);
      return;
    }
    case "share": {
      const { BioFlowRemote } = await import("../sync/remote.js");
      const remote = new BioFlowRemote({
        baseUrl: cmd.remote.url,
        auth: { token: cmd.remote.token, orgId: cmd.remote.orgId }
      });
      const res = (await remote.shareRun(cmd.runId, cmd.visibility)) as any;
      console.log(`OK: shared ${cmd.runId} visibility=${String(res?.visibility ?? cmd.visibility)}`);
      return;
    }
    case "profiles-ls": {
      const { BioFlowRemote } = await import("../sync/remote.js");
      const remote = new BioFlowRemote({
        baseUrl: cmd.remote.url,
        auth: { token: cmd.remote.token, orgId: cmd.remote.orgId }
      });
      const res = (await remote.listProfiles({ limit: cmd.limit })) as any;
      const profiles: any[] = Array.isArray(res?.profiles) ? res.profiles : [];
      for (const p of profiles) {
        console.log(`${String(p.name ?? "")}\t${String(p.created_at ?? "")}\t${String(p.id ?? "")}`);
      }
      return;
    }
    case "profiles-get": {
      const { BioFlowRemote } = await import("../sync/remote.js");
      const remote = new BioFlowRemote({
        baseUrl: cmd.remote.url,
        auth: { token: cmd.remote.token, orgId: cmd.remote.orgId }
      });
      const res = (await remote.getProfile(cmd.name)) as any;
      process.stdout.write(JSON.stringify(res, null, 2) + "\n");
      return;
    }
    case "profiles-put": {
      const { readFile } = await import("node:fs/promises");
      const { BioFlowRemote } = await import("../sync/remote.js");
      const remote = new BioFlowRemote({
        baseUrl: cmd.remote.url,
        auth: { token: cmd.remote.token, orgId: cmd.remote.orgId }
      });
      const raw = await readFile(path.resolve(cmd.filePath), "utf8");
      const profile = JSON.parse(raw) as unknown;
      const res = (await remote.upsertProfile(cmd.name, profile)) as any;
      console.log(`OK: profile ${cmd.name} id=${String(res?.id ?? "")}`);
      return;
    }
    case "mcp": {
      await runBioFlowMcp();
      return;
    }
    case "verify-remote": {
      const { BioFlowRemote } = await import("../sync/remote.js");
      const remote = new BioFlowRemote({
        baseUrl: cmd.remote.url,
        auth: { token: cmd.remote.token, orgId: cmd.remote.orgId }
      });
      const res = (await remote.verifyRun(cmd.runId, { deep: cmd.deep })) as any;
      const ok = !!res?.valid;
      if (!ok) {
        console.error(`FAIL: remote verify ${cmd.runId}`);
        if (res?.error) console.error(`- ${String(res.error)}`);
        if (Array.isArray(res?.errors)) for (const e of res.errors) console.error(`- ${String(e)}`);
        process.exitCode = 1;
        return;
      }
      console.log(`OK: remote verify ${cmd.runId}`);
      return;
    }
    default: {
      const never: never = cmd;
      throw new Error(`Unhandled command: ${JSON.stringify(never)}`);
    }
  }
}

function parseArgs(argv: string[]): Command | null {
  const [sub, ...rest] = argv;
  if (!sub) return null;

  if (sub === "help" || sub === "--help" || sub === "-h") {
    return { kind: "help" };
  }

  if (sub === "auth:signup") {
    const opts = parseAuthSignupOpts(rest);
    if (!opts) return null;
    return { kind: "auth-signup", ...opts };
  }

  if (sub === "auth:set-key") {
    const token = rest[0];
    if (!token) return null;
    const opts = parseAuthSetKeyOpts(rest.slice(1));
    if (!opts) return null;
    return { kind: "auth-set-key", token, ...opts };
  }

  if (sub === "autopilot:run") {
    const opts = parseAutopilotRunOpts(rest);
    if (!opts) return null;
    return { kind: "autopilot-run", ...opts };
  }

  if (sub === "autopilot:validate-summary") {
    const opts = parseAutopilotValidateSummaryOpts(rest);
    if (!opts) return null;
    return { kind: "autopilot-validate-summary", ...opts };
  }

  if (sub === "autopilot:check-policy") {
    const opts = parseAutopilotCheckPolicyOpts(rest);
    if (!opts) return null;
    return { kind: "autopilot-check-policy", ...opts };
  }

  if (sub === "autopilot:gate") {
    const opts = parseAutopilotGateOpts(rest);
    if (!opts) return null;
    return { kind: "autopilot-gate", ...opts };
  }

  if (sub === "init") {
    const outPath = rest[0];
    if (!outPath) return null;
    return { kind: "init", outPath };
  }

  if (sub === "validate") {
    const workflowPath = rest[0];
    if (!workflowPath) return null;
    return { kind: "validate", workflowPath };
  }

  if (sub === "run") {
    const workflowPath = rest[0];
    if (!workflowPath) return null;
    const inputs: string[] = [];
    for (let i = 1; i < rest.length; i++) {
      const arg = rest[i]!;
      if (arg === "--input") {
        const v = rest[i + 1];
        if (!v) return null;
        inputs.push(v);
        i++;
        continue;
      }
      return null;
    }
    return { kind: "run", workflowPath, inputs };
  }

  if (sub === "verify") {
    const runId = rest[0];
    if (!runId) return null;
    return { kind: "verify", runId };
  }

  if (sub === "report") {
    const runId = rest[0];
    if (!runId) return null;
    const opts = parseReportOpts(rest.slice(1));
    if (!opts) return null;
    return { kind: "report", runId, ...opts };
  }

  if (sub === "tidy") {
    const inputPath = rest[0];
    if (!inputPath) return null;
    const opts = parseTidyOpts(rest.slice(1));
    if (!opts) return null;
    return {
      kind: "tidy",
      inputPath,
      baseDir: opts.baseDir,
      outDir: opts.outDir,
      profileName: opts.profileName,
      runId: opts.runId,
      remote: opts.remote
    };
  }

  if (sub === "push") {
    const runId = rest[0];
    if (!runId) return null;
    const opts = parseSyncOpts(rest.slice(1));
    if (!opts) return null;
    return {
      kind: "push",
      runId,
      baseDir: opts.baseDir,
      remote: opts.remote,
      concurrency: opts.concurrency,
      dryRun: opts.dryRun,
      profileId: opts.profileId,
      tags: opts.tags,
      visibility: opts.visibility
    };
  }

  if (sub === "pull") {
    const runId = rest[0];
    if (!runId) return null;
    const opts = parseSyncOpts(rest.slice(1));
    if (!opts) return null;
    return {
      kind: "pull",
      runId,
      baseDir: opts.baseDir,
      remote: opts.remote,
      concurrency: opts.concurrency,
      force: opts.force
    };
  }

  if (sub === "ls-remote") {
    const opts = parseSyncOpts(rest);
    if (!opts) return null;
    return {
      kind: "ls-remote",
      remote: opts.remote,
      limit: opts.limit,
      cursor: opts.cursor,
      profileId: opts.profileId,
      tags: opts.tags ? opts.tags.join(",") : undefined,
      visibility: opts.visibility
    };
  }

  if (sub === "ls") {
    const opts = parseSyncOpts(rest);
    if (!opts) return null;
    return {
      kind: "ls-remote",
      remote: opts.remote,
      limit: opts.limit,
      cursor: opts.cursor,
      profileId: opts.profileId,
      tags: opts.tags ? opts.tags.join(",") : undefined,
      visibility: opts.visibility
    };
  }

  if (sub === "share") {
    const runId = rest[0];
    if (!runId) return null;
    const opts = parseSyncOpts(rest.slice(1));
    if (!opts) return null;
    return {
      kind: "share",
      runId,
      remote: opts.remote,
      visibility: opts.visibility ?? "org"
    };
  }

  if (sub === "profiles") {
    const action = rest[0];
    if (!action) return null;
    if (action === "ls") {
      const opts = parseSyncOpts(rest.slice(1));
      if (!opts) return null;
      return { kind: "profiles-ls", remote: opts.remote, limit: opts.limit };
    }
    if (action === "get") {
      const name = rest[1];
      if (!name) return null;
      const opts = parseSyncOpts(rest.slice(2));
      if (!opts) return null;
      return { kind: "profiles-get", remote: opts.remote, name };
    }
    if (action === "put") {
      const name = rest[1];
      const filePath = rest[2];
      if (!name || !filePath) return null;
      const opts = parseSyncOpts(rest.slice(3));
      if (!opts) return null;
      return { kind: "profiles-put", remote: opts.remote, name, filePath };
    }
    return null;
  }

  if (sub === "mcp") {
    return { kind: "mcp" };
  }

  if (sub === "verify-remote") {
    const runId = rest[0];
    if (!runId) return null;
    const opts = parseSyncOpts(rest.slice(1));
    if (!opts) return null;
    return { kind: "verify-remote", runId, remote: opts.remote, deep: opts.deep };
  }

  return null;
}

function printHelp(): void {
  console.log(`bioflow (local runner)

Usage:
  bioflow --help
  bioflow auth:signup --name <name> --slug <slug> [--plan team|enterprise] [--key-mode live|test] [--key-name <name>] [--remote-url <url>] [--idempotency-key <key>] [--json] [--config-path <path>]
  bioflow auth:set-key <bf_live_...|bf_test_...> [--remote-url <url>] [--org-id <uuid>] [--config-path <path>]
  bioflow autopilot:run [--remote-url <url>] [--name <org name>] [--slug <slug>] [--idempotency-key <key>] [--key-mode live|test] [--config-path <path>] [--out <path>] [--persist-auth|--no-persist-auth] [--enforce-policy] [--max-duration-ms <n>] [--min-progress-completed <n>] [--min-progress-ratio <0..1>] [--require-persisted-auth <true|false>] [--required-checklist-ids a,b,c] [--json]
  bioflow autopilot:validate-summary [file] [--json]
  bioflow autopilot:check-policy [file] [--max-duration-ms <n>] [--min-progress-completed <n>] [--min-progress-ratio <0..1>] [--require-persisted-auth <true|false>] [--required-checklist-ids a,b,c] [--json]
  bioflow autopilot:gate [file] [--max-duration-ms <n>] [--min-progress-completed <n>] [--min-progress-ratio <0..1>] [--require-persisted-auth <true|false>] [--required-checklist-ids a,b,c] [--json]
  bioflow init <out.yaml>
  bioflow validate <workflow.yaml|json>
  bioflow run <workflow.yaml|json> --input <path> [--input <path> ...]
  bioflow verify <runId>
  bioflow report <runId> [--format markdown] [--out <dir>] [--base-dir <dir>] [--no-replay]
  bioflow tidy <file> [--profile <name>] [--out <dir>] [--run-id <uuid>] [--remote-url <url>] [--org-id <uuid>] [--token <token>]
  bioflow push <runId> [--remote-url <url>] [--org-id <uuid>] [--token <token>] [--dry-run] [--profile-id <id>] [--tags a,b] [--visibility <v>]
  bioflow pull <runId> [--remote-url <url>] [--org-id <uuid>] [--token <token>] [--force]
  bioflow ls-remote [--remote-url <url>] [--org-id <uuid>] [--token <token>] [--limit <n>] [--cursor <c>] [--profile-id <id>] [--tags a,b] [--visibility <v>]
  bioflow ls [same as ls-remote]
  bioflow share <runId> [--visibility <private|org|public>] [--remote-url <url>] [--org-id <uuid>] [--token <token>]
  bioflow profiles ls [--remote-url <url>] [--org-id <uuid>] [--token <token>]
  bioflow profiles get <name> [--remote-url <url>] [--org-id <uuid>] [--token <token>]
  bioflow profiles put <name> <file.json> [--remote-url <url>] [--org-id <uuid>] [--token <token>]
  bioflow mcp
  bioflow verify-remote <runId> [--remote-url <url>] [--org-id <uuid>] [--token <token>] [--deep]
	`);
}

async function runAutopilotRun(
  cmd: Extract<Command, { kind: "autopilot-run" }>
): Promise<void> {
  let tempConfigDir: string | null = null;
  let tempInputDir: string | null = null;
  let configPath = cmd.configPath;
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  let stage: AutopilotRunStage = "signup";
  const policy = {
    maxDurationMs: cmd.maxDurationMs,
    minProgressCompleted: cmd.minProgressCompleted,
    minProgressRatio: cmd.minProgressRatio,
    requirePersistedAuth: cmd.requirePersistedAuth,
    requiredChecklistIds: cmd.requiredChecklistIds
  };

  if (!cmd.persistAuth && !configPath) {
    tempConfigDir = await mkdtemp(path.resolve(".bioflow_autopilot_cli_config_"));
    configPath = path.join(tempConfigDir, "config.json");
  }

  try {
    const signup = await runAutopilotSignup({
      remoteUrl: cmd.remoteUrl,
      name: cmd.orgName,
      slug: cmd.slug,
      keyMode: cmd.keyMode,
      idempotencyKey: cmd.idempotencyKey,
      configPath
    });

    stage = "onboarding_initial";
    const initial = await fetchOnboardingChecklist(cmd.remoteUrl, signup.token);
    assertChecklistFlag(initial, "org_created", true);

    stage = "local_run";
    tempInputDir = await mkdtemp(path.resolve(".bioflow_autopilot_input_"));
    const inputPath = path.join(tempInputDir, "sample-sheet.messy.csv");
    await writeFile(inputPath, AUTOPILOT_SAMPLE_SHEET, "utf8");

    const baseDir = path.resolve(process.env.BIOFLOW_BASE_DIR ?? ".bioflow");
    const store = new LocalArtifactStore(baseDir);
    const runId = createRunId();
    const input = await store.importFile(runId, inputPath);
    const workflow = makeTidyWorkflow({ profile: sampleSheetV1Profile });
    const { execution, executionPath } = await runWorkflow({
      workflow,
      store,
      inputs: [input],
      actor: "cli",
      runId
    });
    if (execution.status !== "completed") {
      throw new Error(`Autopilot tidy failed: run ${runId} status ${execution.status}`);
    }
    if (!executionPath) {
      throw new Error(`Autopilot tidy failed: run ${runId} execution record missing`);
    }

    stage = "local_verify";
    const { verifyRun } = await import("../core/verify.js");
    const localVerify = await verifyRun({ baseDir, runId });
    if (!localVerify.valid) {
      throw new Error(
        ["Autopilot local verify failed:", ...localVerify.errors.map((line) => `- ${line}`)].join("\n")
      );
    }

    const { BioFlowRemote } = await import("../sync/remote.js");
    const { pushRunToRemote } = await import("../sync/hybrid.js");
    const remote = new BioFlowRemote({
      baseUrl: cmd.remoteUrl,
      auth: { token: signup.token, orgId: signup.orgId }
    });
    stage = "remote_push";
    await pushRunToRemote({
      baseDir,
      runId,
      remote
    });

    stage = "remote_verify";
    const verifyRemoteResult = (await remote.verifyRun(runId, { deep: true })) as Record<string, unknown>;
    if (verifyRemoteResult.valid !== true) {
      const verifyErrors = Array.isArray(verifyRemoteResult.errors)
        ? verifyRemoteResult.errors.map((value) => String(value))
        : [];
      throw new Error(
        [
          "Autopilot remote verify failed.",
          ...(verifyRemoteResult.error ? [`- ${String(verifyRemoteResult.error)}`] : []),
          ...verifyErrors.map((line) => `- ${line}`)
        ].join("\n")
      );
    }

    stage = "share";
    await remote.shareRun(runId, "org");

    stage = "onboarding_final";
    const final = await fetchOnboardingChecklist(cmd.remoteUrl, signup.token);
    assertChecklistFlag(final, "first_run_created", true);
    assertChecklistFlag(final, "first_run_verified", true);
    assertChecklistFlag(final, "first_run_shared", true);

    const completedAtMs = Date.now();
    const completedAt = new Date(completedAtMs).toISOString();
    const summaryConfigPath = cmd.persistAuth || !!cmd.configPath ? signup.configPath : null;
    const summaryWithoutDigest: Omit<AutopilotSummary, "summarySha256"> = {
      schemaVersion: "self-serve-autopilot.v1",
      startedAt,
      completedAt,
      durationMs: Math.max(0, completedAtMs - startedAtMs),
      remoteUrl: cmd.remoteUrl,
      orgId: signup.orgId,
      orgSlug: signup.orgSlug,
      runId,
      progress: {
        completed: final.progress.completed,
        total: final.progress.total
      },
      nextAction: final.nextAction,
      checklist: final.checklist,
      status: "completed",
      configPath: summaryConfigPath,
      persistedAuth: cmd.persistAuth || !!cmd.configPath
    };
    const summary: AutopilotSummary = {
      ...summaryWithoutDigest,
      summarySha256: sha256Json(summaryWithoutDigest)
    };
    const policyResult = evaluateAutopilotPolicy(summary, policy);

    if (cmd.outPath) {
      await writeAutopilotSummaryArtifact(cmd.outPath, summary);
    }

    stage = "policy_enforce";
    if (cmd.enforcePolicy && !policyResult.pass) {
      if (cmd.json) {
        printJson({
          ok: false,
          error: "autopilot_policy_failed",
          message: "Autopilot policy gate failed.",
          summary,
          policy,
          observed: policyResult.observed,
          violations: policyResult.violations
        });
      } else {
        console.error("FAIL: autopilot policy gate failed");
        for (const violation of policyResult.violations) console.error(`- ${violation}`);
      }
      process.exitCode = 1;
      return;
    }

    if (cmd.json) {
      printJson(summary);
      return;
    }

    console.log(`smoke.remote_url=${summary.remoteUrl}`);
    console.log(`smoke.org_id=${summary.orgId}`);
    console.log(`smoke.org_slug=${summary.orgSlug}`);
    console.log(`smoke.run_id=${summary.runId}`);
    console.log(`smoke.progress=${summary.progress.completed}/${summary.progress.total}`);
    console.log(`smoke.next_action=${summary.nextAction ?? "none"}`);
    if (summary.configPath) console.log(`smoke.config_path=${summary.configPath}`);
    if (cmd.outPath) console.log(`smoke.out_path=${cmd.outPath}`);
    console.log(`smoke.summary_sha256=${summary.summarySha256}`);
    console.log(`smoke.persisted_auth=${summary.persistedAuth ? "true" : "false"}`);
    console.log(`smoke.policy_pass=${policyResult.pass ? "true" : "false"}`);
    if (!policyResult.pass) {
      for (const violation of policyResult.violations) {
        console.log(`smoke.policy_violation=${violation}`);
      }
    }
    console.log("smoke.status=completed");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    let failureArtifact: AutopilotFailureArtifact | null = null;
    if (cmd.outPath) {
      failureArtifact = await writeAutopilotFailureArtifact(cmd.outPath, {
        schemaVersion: "self-serve-autopilot-error.v1",
        startedAt,
        failedAt: new Date().toISOString(),
        remoteUrl: cmd.remoteUrl,
        orgSlug: cmd.slug,
        orgName: cmd.orgName,
        stage,
        enforcePolicy: cmd.enforcePolicy,
        policy,
        message
      });
    }
    if (cmd.json) {
      printJson({
        ok: false,
        error: "autopilot_run_failed",
        message,
        stage,
        artifactPath: cmd.outPath ? path.resolve(cmd.outPath) : null,
        errorSha256: failureArtifact?.errorSha256 ?? null
      });
      process.exitCode = 1;
      return;
    }
    throw err;
  } finally {
    if (tempInputDir) {
      await rm(tempInputDir, { recursive: true, force: true });
    }
    if (tempConfigDir) {
      await rm(tempConfigDir, { recursive: true, force: true });
    }
  }
}

async function runAutopilotValidateSummary(
  cmd: Extract<Command, { kind: "autopilot-validate-summary" }>
): Promise<void> {
  try {
    const validation = await validateAutopilotArtifactFile(cmd.filePath);
    if (validation.kind === "failure") {
      if (!validation.digestMatches) {
        const message = `Autopilot failure artifact digest mismatch: expected=${validation.failure.errorSha256} computed=${validation.computedSha256}`;
        if (cmd.json) {
          printJson({
            ok: false,
            error: "digest_mismatch",
            message,
            filePath: validation.filePath,
            expectedSha256: validation.failure.errorSha256,
            computedSha256: validation.computedSha256
          });
        } else {
          console.error(`FAIL: ${message}`);
        }
        process.exitCode = 1;
        return;
      }

      const message = `Autopilot run failed at stage ${validation.failure.stage}: ${validation.failure.message}`;
      if (cmd.json) {
        printJson({
          ok: false,
          error: "autopilot_run_failed",
          message,
          filePath: validation.filePath,
          schemaVersion: validation.failure.schemaVersion,
          stage: validation.failure.stage,
          errorSha256: validation.failure.errorSha256,
          computedSha256: validation.computedSha256,
          digestMatches: true
        });
      } else {
        console.error(`FAIL: ${message}`);
        console.error(`stage=${validation.failure.stage}`);
        console.error(`sha256=${validation.failure.errorSha256}`);
      }
      process.exitCode = 1;
      return;
    }

    if (!validation.digestMatches) {
      const message = `Autopilot summary digest mismatch: expected=${validation.summary.summarySha256} computed=${validation.computedSha256}`;
      if (cmd.json) {
        printJson({
          ok: false,
          error: "digest_mismatch",
          message,
          filePath: validation.filePath,
          expectedSha256: validation.summary.summarySha256,
          computedSha256: validation.computedSha256
        });
      } else {
        console.error(`FAIL: ${message}`);
      }
      process.exitCode = 1;
      return;
    }

    if (cmd.json) {
      printJson({
        ok: true,
        filePath: validation.filePath,
        schemaVersion: validation.summary.schemaVersion,
        runId: validation.summary.runId,
        orgId: validation.summary.orgId,
        orgSlug: validation.summary.orgSlug,
        summarySha256: validation.summary.summarySha256,
        computedSha256: validation.computedSha256,
        digestMatches: true
      });
      return;
    }

    console.log(`OK: autopilot summary valid -> ${validation.filePath}`);
    console.log(`schema=${validation.summary.schemaVersion} runId=${validation.summary.runId}`);
    console.log(`sha256=${validation.summary.summarySha256}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (cmd.json) {
      printJson({
        ok: false,
        error: "invalid_summary",
        message,
        filePath: path.resolve(cmd.filePath)
      });
    } else {
      console.error(`FAIL: ${message}`);
    }
    process.exitCode = 1;
  }
}

async function runAutopilotCheckPolicy(
  cmd: Extract<Command, { kind: "autopilot-check-policy" }>
): Promise<void> {
  try {
    const policy = resolveAutopilotPolicyFromCommand(cmd);
    const evaluation = await evaluateAutopilotPolicyArtifact(cmd.filePath, policy);

    if (evaluation.kind === "digest_mismatch") {
      const message = `Autopilot ${evaluation.artifactKind} artifact digest mismatch: expected=${evaluation.expectedSha256} computed=${evaluation.computedSha256}`;
      if (cmd.json) {
        printJson({
          pass: false,
          error: "digest_mismatch",
          message,
          filePath: evaluation.filePath,
          expectedSha256: evaluation.expectedSha256,
          computedSha256: evaluation.computedSha256
        });
      } else {
        console.error(`FAIL: ${message}`);
      }
      process.exitCode = 1;
      return;
    }

    if (evaluation.kind === "run_failed") {
      const message = `Autopilot run failed at stage ${evaluation.failure.stage}: ${evaluation.failure.message}`;
      if (cmd.json) {
        printJson({
          pass: false,
          error: "autopilot_run_failed",
          message,
          filePath: evaluation.filePath,
          schemaVersion: evaluation.failure.schemaVersion,
          stage: evaluation.failure.stage,
          errorSha256: evaluation.failure.errorSha256,
          computedSha256: evaluation.computedSha256,
          digestMatches: true
        });
      } else {
        console.error(`FAIL: ${message}`);
        console.error(`stage=${evaluation.failure.stage}`);
        console.error(`sha256=${evaluation.failure.errorSha256}`);
      }
      process.exitCode = 1;
      return;
    }

    if (cmd.json) {
      printJson({
        pass: evaluation.policyResult.pass,
        filePath: evaluation.filePath,
        policy: evaluation.policy,
        observed: evaluation.policyResult.observed,
        violations: evaluation.policyResult.violations,
        summarySha256: evaluation.summary.summarySha256
      });
    } else if (evaluation.policyResult.pass) {
      console.log(`OK: autopilot policy passed -> ${evaluation.filePath}`);
      console.log(
        `durationMs=${String(evaluation.policyResult.observed.durationMs)} progress=${String(evaluation.policyResult.observed.progressCompleted)}/${String(evaluation.policyResult.observed.progressTotal)} ratio=${evaluation.policyResult.observed.progressRatio.toFixed(3)}`
      );
      console.log(`sha256=${evaluation.summary.summarySha256}`);
    } else {
      console.error(`FAIL: autopilot policy failed -> ${evaluation.filePath}`);
      for (const violation of evaluation.policyResult.violations) console.error(`- ${violation}`);
      process.exitCode = 1;
      return;
    }

    if (!evaluation.policyResult.pass) process.exitCode = 1;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (cmd.json) {
      printJson({
        pass: false,
        error: "invalid_summary",
        message,
        filePath: path.resolve(cmd.filePath)
      });
    } else {
      console.error(`FAIL: ${message}`);
    }
    process.exitCode = 1;
  }
}

async function runAutopilotGate(
  cmd: Extract<Command, { kind: "autopilot-gate" }>
): Promise<void> {
  try {
    const policy = resolveAutopilotPolicyFromCommand(cmd);
    const evaluation = await evaluateAutopilotPolicyArtifact(cmd.filePath, policy);

    if (evaluation.kind === "digest_mismatch") {
      const message = `Autopilot ${evaluation.artifactKind} artifact digest mismatch: expected=${evaluation.expectedSha256} computed=${evaluation.computedSha256}`;
      if (cmd.json) {
        printJson({
          ok: false,
          error: "digest_mismatch",
          message,
          filePath: evaluation.filePath,
          artifactKind: evaluation.artifactKind,
          expectedSha256: evaluation.expectedSha256,
          computedSha256: evaluation.computedSha256
        });
      } else {
        console.error(`FAIL: ${message}`);
      }
      process.exitCode = 1;
      return;
    }

    if (evaluation.kind === "run_failed") {
      const message = `Autopilot run failed at stage ${evaluation.failure.stage}: ${evaluation.failure.message}`;
      if (cmd.json) {
        printJson({
          ok: false,
          error: "autopilot_run_failed",
          message,
          filePath: evaluation.filePath,
          schemaVersion: evaluation.failure.schemaVersion,
          stage: evaluation.failure.stage,
          errorSha256: evaluation.failure.errorSha256,
          computedSha256: evaluation.computedSha256,
          digestMatches: true
        });
      } else {
        console.error(`FAIL: ${message}`);
        console.error(`stage=${evaluation.failure.stage}`);
        console.error(`sha256=${evaluation.failure.errorSha256}`);
      }
      process.exitCode = 1;
      return;
    }

    if (!evaluation.policyResult.pass) {
      const message = "Autopilot policy gate failed.";
      if (cmd.json) {
        printJson({
          ok: false,
          error: "autopilot_policy_failed",
          message,
          filePath: evaluation.filePath,
          schemaVersion: evaluation.summary.schemaVersion,
          runId: evaluation.summary.runId,
          orgId: evaluation.summary.orgId,
          orgSlug: evaluation.summary.orgSlug,
          summarySha256: evaluation.summary.summarySha256,
          computedSha256: evaluation.computedSha256,
          digestMatches: true,
          policy: evaluation.policy,
          observed: evaluation.policyResult.observed,
          violations: evaluation.policyResult.violations
        });
      } else {
        console.error(`FAIL: ${message}`);
        console.error(`file=${evaluation.filePath}`);
        for (const violation of evaluation.policyResult.violations) console.error(`- ${violation}`);
      }
      process.exitCode = 1;
      return;
    }

    if (cmd.json) {
      printJson({
        ok: true,
        gate: "pass",
        filePath: evaluation.filePath,
        schemaVersion: evaluation.summary.schemaVersion,
        runId: evaluation.summary.runId,
        orgId: evaluation.summary.orgId,
        orgSlug: evaluation.summary.orgSlug,
        summarySha256: evaluation.summary.summarySha256,
        computedSha256: evaluation.computedSha256,
        digestMatches: true,
        policy: evaluation.policy,
        observed: evaluation.policyResult.observed,
        violations: evaluation.policyResult.violations
      });
      return;
    }

    console.log(`OK: autopilot gate passed -> ${evaluation.filePath}`);
    console.log(`runId=${evaluation.summary.runId} org=${evaluation.summary.orgSlug}`);
    console.log(
      `durationMs=${String(evaluation.policyResult.observed.durationMs)} progress=${String(evaluation.policyResult.observed.progressCompleted)}/${String(evaluation.policyResult.observed.progressTotal)} ratio=${evaluation.policyResult.observed.progressRatio.toFixed(3)}`
    );
    console.log(`sha256=${evaluation.summary.summarySha256}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (cmd.json) {
      printJson({
        ok: false,
        error: "invalid_summary",
        message,
        filePath: path.resolve(cmd.filePath)
      });
    } else {
      console.error(`FAIL: ${message}`);
    }
    process.exitCode = 1;
  }
}

interface AutopilotPolicyCommandOptions {
  maxDurationMs: number;
  minProgressCompleted: number;
  minProgressRatio: number;
  requirePersistedAuth: boolean;
  requiredChecklistIds: string[];
}

interface AutopilotPolicyCommandInput extends AutopilotPolicyCommandOptions {
  filePath: string;
}

type AutopilotPolicyEvaluation =
  | {
      kind: "digest_mismatch";
      artifactKind: "summary" | "failure";
      filePath: string;
      expectedSha256: string;
      computedSha256: string;
    }
  | {
      kind: "run_failed";
      filePath: string;
      failure: AutopilotFailureArtifact;
      computedSha256: string;
    }
  | {
      kind: "policy";
      filePath: string;
      summary: AutopilotSummary;
      computedSha256: string;
      policy: AutopilotPolicyCommandOptions;
      policyResult: ReturnType<typeof evaluateAutopilotPolicy>;
    };

function resolveAutopilotPolicyFromCommand(
  cmd: AutopilotPolicyCommandInput
): AutopilotPolicyCommandOptions {
  return {
    maxDurationMs: cmd.maxDurationMs,
    minProgressCompleted: cmd.minProgressCompleted,
    minProgressRatio: cmd.minProgressRatio,
    requirePersistedAuth: cmd.requirePersistedAuth,
    requiredChecklistIds: cmd.requiredChecklistIds
  };
}

async function evaluateAutopilotPolicyArtifact(
  filePath: string,
  policy: AutopilotPolicyCommandOptions
): Promise<AutopilotPolicyEvaluation> {
  const validation = await validateAutopilotArtifactFile(filePath);
  if (validation.kind === "failure") {
    if (!validation.digestMatches) {
      return {
        kind: "digest_mismatch",
        artifactKind: "failure",
        filePath: validation.filePath,
        expectedSha256: validation.failure.errorSha256,
        computedSha256: validation.computedSha256
      };
    }
    return {
      kind: "run_failed",
      filePath: validation.filePath,
      failure: validation.failure,
      computedSha256: validation.computedSha256
    };
  }

  if (!validation.digestMatches) {
    return {
      kind: "digest_mismatch",
      artifactKind: "summary",
      filePath: validation.filePath,
      expectedSha256: validation.summary.summarySha256,
      computedSha256: validation.computedSha256
    };
  }

  const policyResult = evaluateAutopilotPolicy(validation.summary, policy);
  return {
    kind: "policy",
    filePath: validation.filePath,
    summary: validation.summary,
    computedSha256: validation.computedSha256,
    policy,
    policyResult
  };
}

async function runAutopilotSignup(params: {
  remoteUrl: string;
  name: string;
  slug: string;
  keyMode: "live" | "test";
  idempotencyKey: string;
  configPath?: string | undefined;
}): Promise<AutopilotSignupResult> {
  const configEnv = withConfigPathEnv(params.configPath);
  const endpoint = `${params.remoteUrl.replace(/\/+$/, "")}/api/v1/self-serve/signup`;
  const payload = {
    name: params.name,
    slug: params.slug,
    plan: "team" as const,
    keyMode: params.keyMode
  };

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": params.idempotencyKey
      },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    throw new Error(`Self-serve signup request failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const raw = await response.text();
  const parsed = tryParseJson(raw);
  if (!response.ok) {
    throw new Error(formatSelfServeSignupError(response.status, parsed, raw));
  }

  const signupParsed = SelfServeSignupSuccessSchema.safeParse(parsed);
  if (!signupParsed.success) {
    throw new Error(`Self-serve signup response did not match expected schema: ${signupParsed.error.message}`);
  }

  const signup = signupParsed.data;
  const current = loadCliConfig(configEnv);
  const remoteDefaults = resolveRemoteDefaults(configEnv);
  const tokenToPersist = signup.apiKey ?? remoteDefaults.token;
  if (!tokenToPersist) {
    throw new Error(
      "Self-serve signup replayed and API key is not available (one-time reveal). Supply an existing key via auth:set-key."
    );
  }

  const nextRemote = {
    ...current.remote,
    url: params.remoteUrl,
    token: tokenToPersist,
    orgId: signup.org.id
  };
  const configPath = saveCliConfig({ remote: nextRemote }, configEnv);

  return {
    orgId: signup.org.id,
    orgSlug: signup.org.slug,
    token: tokenToPersist,
    configPath
  };
}

async function fetchOnboardingChecklist(
  remoteUrl: string,
  token: string
): Promise<OnboardingChecklistResponse> {
  const url = new URL("/api/v1/onboarding/checklist", ensureTrailingSlash(remoteUrl)).toString();
  const res = await fetch(url, {
    method: "GET",
    headers: {
      authorization: `Bearer ${token}`
    }
  });
  const text = await safeReadText(res);
  if (!res.ok) {
    throw new Error(`GET ${url} failed: ${res.status}\n${text}`);
  }
  return JSON.parse(text) as OnboardingChecklistResponse;
}

function assertChecklistFlag(checklist: OnboardingChecklistResponse, id: string, expected: boolean): void {
  const item = checklist.checklist.find((entry) => entry.id === id);
  if (!item) throw new Error(`Checklist item missing: ${id}`);
  if (item.completed !== expected) {
    throw new Error(`Checklist item ${id} expected ${String(expected)} but got ${String(item.completed)}`);
  }
}

async function writeAutopilotSummaryArtifact(outPath: string, summary: AutopilotSummary): Promise<void> {
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, `${stableStringify(summary)}\n`, "utf8");
}

async function writeAutopilotFailureArtifact(
  outPath: string,
  failure: Omit<AutopilotFailureArtifact, "errorSha256">
): Promise<AutopilotFailureArtifact> {
  const digestInput: AutopilotFailureArtifact = {
    ...failure,
    errorSha256: "0".repeat(64)
  };
  const artifact: AutopilotFailureArtifact = {
    ...failure,
    errorSha256: computeAutopilotFailureSha256(digestInput)
  };
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, `${stableStringify(artifact)}\n`, "utf8");
  return artifact;
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "<unreadable>";
  }
}

async function runAuthSignup(
  cmd: Extract<Command, { kind: "auth-signup" }>
): Promise<void> {
  const configEnv = withConfigPathEnv(cmd.configPath);
  const endpoint = `${cmd.remoteUrl.replace(/\/+$/, "")}/api/v1/self-serve/signup`;
  const idempotencyKey = cmd.idempotencyKey ?? makeSignupIdempotencyKey();
  const payload = {
    name: cmd.name,
    slug: cmd.slug,
    plan: cmd.plan,
    keyMode: cmd.keyMode,
    ...(cmd.keyName ? { keyName: cmd.keyName } : {})
  };

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey
      },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (cmd.json) {
      printJson({
        ok: false,
        error: "network_error",
        message: `Self-serve signup request failed: ${message}`,
        remoteUrl: cmd.remoteUrl
      } satisfies AuthSignupJsonError);
      process.exitCode = 1;
      return;
    }
    throw new Error(`Self-serve signup request failed: ${message}`);
  }

  const raw = await response.text();
  const parsed = tryParseJson(raw);
  if (!response.ok) {
    const formatted = formatSelfServeSignupError(response.status, parsed, raw);
    if (cmd.json) {
      const known = SelfServeSignupErrorSchema.safeParse(parsed);
      printJson({
        ok: false,
        status: response.status,
        error: known.success ? (known.data.error ?? "request_failed") : "request_failed",
        message: formatted,
        remoteUrl: cmd.remoteUrl
      } satisfies AuthSignupJsonError);
      process.exitCode = 1;
      return;
    }
    throw new Error(formatted);
  }

  const signupParsed = SelfServeSignupSuccessSchema.safeParse(parsed);
  if (!signupParsed.success) {
    if (cmd.json) {
      printJson({
        ok: false,
        error: "invalid_signup_response",
        message: `Self-serve signup response did not match expected schema: ${signupParsed.error.message}`,
        status: response.status,
        remoteUrl: cmd.remoteUrl
      } satisfies AuthSignupJsonError);
      process.exitCode = 1;
      return;
    }
    throw signupParsed.error;
  }
  const signup = signupParsed.data;
  const current = loadCliConfig(configEnv);
  const remoteDefaults = resolveRemoteDefaults(configEnv);
  const tokenToPersist = signup.apiKey ?? remoteDefaults.token;

  if (!tokenToPersist) {
    const message =
      "Self-serve signup replayed and API key is not available (one-time reveal). Supply an existing key via auth:set-key.";
    if (cmd.json) {
      printJson({
        ok: false,
        error: "api_key_unavailable",
        message,
        replayed: signup.replayed,
        org: {
          id: signup.org.id,
          slug: signup.org.slug
        },
        remoteUrl: cmd.remoteUrl
      } satisfies AuthSignupJsonError);
      process.exitCode = 1;
      return;
    }
    console.error(message);
    process.exitCode = 1;
    return;
  }

  const nextRemote = {
    ...current.remote,
    url: cmd.remoteUrl,
    token: tokenToPersist,
    orgId: signup.org.id
  };
  const configPath = saveCliConfig({ remote: nextRemote }, configEnv);

  const jsonPayload: AuthSignupJsonSuccess = {
    ok: true,
    replayed: signup.replayed,
    org: {
      id: signup.org.id,
      name: signup.org.name,
      slug: signup.org.slug,
      plan: signup.org.plan,
      planStatus: signup.org.planStatus,
      currentPeriodEnd: signup.org.currentPeriodEnd ?? null
    },
    keyPrefix: signup.keyPrefix ?? null,
    apiKey: signup.apiKey,
    configPath,
    remoteUrl: cmd.remoteUrl
  };
  if (cmd.json) {
    printJson(jsonPayload);
    return;
  }

  if (signup.replayed && signup.apiKey === null) {
    console.log(`OK: replayed signup for org ${signup.org.slug}; reused existing API key from config/env.`);
  } else {
    console.log(`OK: created org ${signup.org.slug} (${signup.org.id}) plan=${signup.org.plan}`);
  }
  if (signup.keyPrefix) console.log(`Key prefix: ${signup.keyPrefix}`);
  console.log(`Saved auth config -> ${configPath}`);
  console.log(`Remote URL: ${cmd.remoteUrl}`);
  console.log(`Org ID: ${signup.org.id}`);
}

function formatSelfServeSignupError(status: number, parsedBody: unknown, rawBody: string): string {
  const parsed = SelfServeSignupErrorSchema.safeParse(parsedBody);
  if (parsed.success) {
    const error = parsed.data.error ?? "request_failed";
    const message = parsed.data.message ?? "";
    return `Self-serve signup failed (${status}) ${error}${message ? `: ${message}` : ""}`;
  }
  const fallback = rawBody.trim();
  if (fallback.length === 0) {
    return `Self-serve signup failed (${status})`;
  }
  return `Self-serve signup failed (${status}) ${fallback}`;
}

function makeSignupIdempotencyKey(now = Date.now()): string {
  return `signup-${String(now)}-${randomUUID().replace(/-/g, "")}`;
}

function parseAuthSignupOpts(argv: string[]): {
  name: string;
  slug: string;
  plan: "team" | "enterprise";
  keyMode: "live" | "test";
  keyName?: string | undefined;
  remoteUrl: string;
  idempotencyKey?: string | undefined;
  json: boolean;
  configPath?: string | undefined;
} | null {
  let name: string | undefined;
  let slug: string | undefined;
  let plan: "team" | "enterprise" = "team";
  let keyMode: "live" | "test" = "live";
  let keyName: string | undefined;
  let remoteUrl: string | undefined;
  let idempotencyKey: string | undefined;
  let json = false;
  let configPath: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--name") {
      const v = argv[i + 1];
      if (!v) return null;
      name = v;
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
    if (arg === "--plan") {
      const v = argv[i + 1];
      if (!v) return null;
      const parsed = SignupPlanSchema.safeParse(v);
      if (!parsed.success) return null;
      plan = parsed.data;
      i++;
      continue;
    }
    if (arg === "--key-mode") {
      const v = argv[i + 1];
      if (!v) return null;
      const parsed = SignupKeyModeSchema.safeParse(v);
      if (!parsed.success) return null;
      keyMode = parsed.data;
      i++;
      continue;
    }
    if (arg === "--key-name") {
      const v = argv[i + 1];
      if (!v) return null;
      keyName = v;
      i++;
      continue;
    }
    if (arg === "--remote-url") {
      const v = argv[i + 1];
      if (!v) return null;
      remoteUrl = v;
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
    if (arg === "--config-path") {
      const v = argv[i + 1];
      if (!v) return null;
      configPath = v;
      i++;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    return null;
  }

  if (!name || !slug) return null;
  const configEnv = withConfigPathEnv(configPath);
  const resolvedRemoteUrl = remoteUrl ?? resolveRemoteDefaults(configEnv).url;
  return { name, slug, plan, keyMode, keyName, remoteUrl: resolvedRemoteUrl, idempotencyKey, json, configPath };
}

function makeExampleWorkflow(): unknown {
  return {
    id: "example.workflow",
    version: "0.1.0",
    compliance: "Research",
    seed: "demo-seed",
    nodes: [
      { id: "start", kind: "trigger.manual", name: "Start" },
      { id: "score", kind: "transform.score", name: "Score inputs" },
      { id: "report", kind: "report.aggregate", name: "Aggregate report" },
      {
        id: "writeback",
        kind: "action.connector",
        name: "Simulated writeback",
        config: { connector: "eln_sim", operation: "writeback", params: { destination: "demo" } }
      }
    ],
    edges: [
      { from: "start", to: "score" },
      { from: "score", to: "report" },
      { from: "report", to: "writeback" }
    ]
  };
}

function parseAuthSetKeyOpts(argv: string[]): {
  remoteUrl?: string | undefined;
  orgId?: string | undefined;
  configPath?: string | undefined;
} | null {
  let remoteUrl: string | undefined;
  let orgId: string | undefined;
  let configPath: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--remote-url") {
      const v = argv[i + 1];
      if (!v) return null;
      remoteUrl = v;
      i++;
      continue;
    }
    if (arg === "--org-id") {
      const v = argv[i + 1];
      if (!v) return null;
      orgId = v;
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
    return null;
  }

  return { remoteUrl, orgId, configPath };
}

function readOptionalEnv(name: string): string | undefined {
  const raw = process.env[name];
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  return value.length > 0 ? value : undefined;
}

function parseBooleanEnv(name: string): boolean | undefined | null {
  const value = readOptionalEnv(name);
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

function parseIntegerEnv(name: string, options: { min: number; max?: number | undefined }): number | undefined | null {
  const value = readOptionalEnv(name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const integer = Math.trunc(parsed);
  if (integer !== parsed) return null;
  if (integer < options.min) return null;
  if (typeof options.max === "number" && integer > options.max) return null;
  return integer;
}

function parseRatioEnv(name: string): number | undefined | null {
  const value = readOptionalEnv(name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  if (parsed < 0 || parsed > 1) return null;
  return parsed;
}

function parseAutopilotKeyModeEnv(name: string): "live" | "test" | undefined | null {
  const value = readOptionalEnv(name);
  if (value === undefined) return undefined;
  if (value === "live" || value === "test") return value;
  return null;
}

function parseChecklistIdsCsv(value: string): string[] {
  return value
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

function parseChecklistIdsEnv(name: string): string[] | undefined {
  const value = readOptionalEnv(name);
  if (value === undefined) return undefined;
  return parseChecklistIdsCsv(value);
}

function resolveAutopilotArtifactPathDefault(): string | undefined {
  return readOptionalEnv("BIOFLOW_AUTOPILOT_OUT") ?? readOptionalEnv("BIOFLOW_SELF_SERVE_SMOKE_OUT");
}

function parseAutopilotRunOpts(argv: string[]): {
  remoteUrl: string;
  slug: string;
  orgName: string;
  idempotencyKey: string;
  keyMode: "live" | "test";
  configPath?: string | undefined;
  outPath?: string | undefined;
  persistAuth: boolean;
  enforcePolicy: boolean;
  maxDurationMs: number;
  minProgressCompleted: number;
  minProgressRatio: number;
  requirePersistedAuth: boolean;
  requiredChecklistIds: string[];
  json: boolean;
} | null {
  const envKeyMode = parseAutopilotKeyModeEnv("BIOFLOW_AUTOPILOT_KEY_MODE");
  const envPersistAuth = parseBooleanEnv("BIOFLOW_AUTOPILOT_PERSIST_AUTH");
  const envEnforcePolicy = parseBooleanEnv("BIOFLOW_AUTOPILOT_ENFORCE_POLICY");
  const envMaxDurationMs = parseIntegerEnv("BIOFLOW_AUTOPILOT_MAX_DURATION_MS", { min: 1 });
  const envMinProgressCompleted = parseIntegerEnv("BIOFLOW_AUTOPILOT_MIN_PROGRESS_COMPLETED", { min: 0 });
  const envMinProgressRatio = parseRatioEnv("BIOFLOW_AUTOPILOT_MIN_PROGRESS_RATIO");
  const envRequirePersistedAuth = parseBooleanEnv("BIOFLOW_AUTOPILOT_REQUIRE_PERSISTED_AUTH");
  if (
    envKeyMode === null ||
    envPersistAuth === null ||
    envEnforcePolicy === null ||
    envMaxDurationMs === null ||
    envMinProgressCompleted === null ||
    envMinProgressRatio === null ||
    envRequirePersistedAuth === null
  ) {
    return null;
  }

  const defaultOutPath =
    readOptionalEnv("BIOFLOW_AUTOPILOT_OUT") ?? readOptionalEnv("BIOFLOW_SELF_SERVE_SMOKE_OUT");
  let remoteUrl: string | undefined;
  let slug: string | undefined = readOptionalEnv("BIOFLOW_AUTOPILOT_SLUG");
  let orgName: string | undefined = readOptionalEnv("BIOFLOW_AUTOPILOT_NAME");
  let idempotencyKey: string | undefined = readOptionalEnv("BIOFLOW_AUTOPILOT_IDEMPOTENCY_KEY");
  let keyMode: "live" | "test" = envKeyMode ?? "test";
  let configPath: string | undefined;
  let outPath = defaultOutPath;
  let persistAuth = envPersistAuth ?? true;
  let enforcePolicy = envEnforcePolicy ?? false;
  let maxDurationMs = envMaxDurationMs ?? DEFAULT_AUTOPILOT_POLICY.maxDurationMs;
  let minProgressCompleted = envMinProgressCompleted ?? DEFAULT_AUTOPILOT_POLICY.minProgressCompleted;
  let minProgressRatio = envMinProgressRatio ?? DEFAULT_AUTOPILOT_POLICY.minProgressRatio;
  let requirePersistedAuth = envRequirePersistedAuth ?? DEFAULT_AUTOPILOT_POLICY.requirePersistedAuth;
  let requiredChecklistIds =
    parseChecklistIdsEnv("BIOFLOW_AUTOPILOT_REQUIRED_CHECKLIST_IDS") ??
    [...DEFAULT_AUTOPILOT_POLICY.requiredChecklistIds];
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
    if (arg === "--no-persist-auth") {
      persistAuth = false;
      continue;
    }
    if (arg === "--enforce-policy") {
      enforcePolicy = true;
      continue;
    }
    if (arg === "--max-duration-ms") {
      const v = argv[i + 1];
      if (!v) return null;
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) return null;
      maxDurationMs = Math.trunc(n);
      i++;
      continue;
    }
    if (arg === "--min-progress-completed") {
      const v = argv[i + 1];
      if (!v) return null;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) return null;
      minProgressCompleted = Math.trunc(n);
      i++;
      continue;
    }
    if (arg === "--min-progress-ratio") {
      const v = argv[i + 1];
      if (!v) return null;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 1) return null;
      minProgressRatio = n;
      i++;
      continue;
    }
    if (arg === "--require-persisted-auth") {
      const v = argv[i + 1];
      if (!v) return null;
      if (v !== "true" && v !== "false") return null;
      requirePersistedAuth = v === "true";
      i++;
      continue;
    }
    if (arg === "--required-checklist-ids") {
      const v = argv[i + 1];
      if (!v) return null;
      requiredChecklistIds = parseChecklistIdsCsv(v);
      i++;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    return null;
  }

  const configEnv = withConfigPathEnv(configPath);
  const resolvedRemoteUrl = remoteUrl ?? resolveRemoteDefaults(configEnv).url;
  const resolvedSlug =
    slug ??
    `autopilot-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${randomUUID().replace(/-/g, "").slice(0, 8)}`;

  return {
    remoteUrl: resolvedRemoteUrl,
    slug: resolvedSlug,
    orgName: orgName ?? `Self-Serve ${resolvedSlug}`,
    idempotencyKey: idempotencyKey ?? `autopilot-${randomUUID()}`,
    keyMode,
    configPath,
    outPath: outPath ? path.resolve(outPath) : undefined,
    persistAuth,
    enforcePolicy,
    maxDurationMs,
    minProgressCompleted,
    minProgressRatio,
    requirePersistedAuth,
    requiredChecklistIds,
    json
  };
}

function parseAutopilotValidateSummaryOpts(argv: string[]): {
  filePath: string;
  json: boolean;
} | null {
  const first = argv[0];
  let filePath = first && !first.startsWith("--") ? first : resolveAutopilotArtifactPathDefault();
  if (!filePath) return null;
  let startIndex = first && !first.startsWith("--") ? 1 : 0;
  let json = false;
  for (let i = startIndex; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      json = true;
      continue;
    }
    return null;
  }
  return { filePath: path.resolve(filePath), json };
}

function parseAutopilotCheckPolicyOpts(argv: string[]): {
  filePath: string;
  json: boolean;
  maxDurationMs: number;
  minProgressCompleted: number;
  minProgressRatio: number;
  requirePersistedAuth: boolean;
  requiredChecklistIds: string[];
} | null {
  const first = argv[0];
  let filePath = first && !first.startsWith("--") ? first : resolveAutopilotArtifactPathDefault();
  if (!filePath) return null;
  let startIndex = first && !first.startsWith("--") ? 1 : 0;

  const envMaxDurationMs = parseIntegerEnv("BIOFLOW_AUTOPILOT_MAX_DURATION_MS", { min: 1 });
  const envMinProgressCompleted = parseIntegerEnv("BIOFLOW_AUTOPILOT_MIN_PROGRESS_COMPLETED", { min: 0 });
  const envMinProgressRatio = parseRatioEnv("BIOFLOW_AUTOPILOT_MIN_PROGRESS_RATIO");
  const envRequirePersistedAuth = parseBooleanEnv("BIOFLOW_AUTOPILOT_REQUIRE_PERSISTED_AUTH");
  if (
    envMaxDurationMs === null ||
    envMinProgressCompleted === null ||
    envMinProgressRatio === null ||
    envRequirePersistedAuth === null
  ) {
    return null;
  }

  let json = false;
  let maxDurationMs = envMaxDurationMs ?? DEFAULT_AUTOPILOT_POLICY.maxDurationMs;
  let minProgressCompleted = envMinProgressCompleted ?? DEFAULT_AUTOPILOT_POLICY.minProgressCompleted;
  let minProgressRatio = envMinProgressRatio ?? DEFAULT_AUTOPILOT_POLICY.minProgressRatio;
  let requirePersistedAuth = envRequirePersistedAuth ?? DEFAULT_AUTOPILOT_POLICY.requirePersistedAuth;
  let requiredChecklistIds =
    parseChecklistIdsEnv("BIOFLOW_AUTOPILOT_REQUIRED_CHECKLIST_IDS") ??
    [...DEFAULT_AUTOPILOT_POLICY.requiredChecklistIds];

  for (let i = startIndex; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--max-duration-ms") {
      const v = argv[i + 1];
      if (!v) return null;
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) return null;
      maxDurationMs = Math.trunc(n);
      i++;
      continue;
    }
    if (arg === "--min-progress-completed") {
      const v = argv[i + 1];
      if (!v) return null;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) return null;
      minProgressCompleted = Math.trunc(n);
      i++;
      continue;
    }
    if (arg === "--min-progress-ratio") {
      const v = argv[i + 1];
      if (!v) return null;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 1) return null;
      minProgressRatio = n;
      i++;
      continue;
    }
    if (arg === "--require-persisted-auth") {
      const v = argv[i + 1];
      if (!v) return null;
      if (v !== "true" && v !== "false") return null;
      requirePersistedAuth = v === "true";
      i++;
      continue;
    }
    if (arg === "--required-checklist-ids") {
      const v = argv[i + 1];
      if (!v) return null;
      requiredChecklistIds = parseChecklistIdsCsv(v);
      i++;
      continue;
    }
    return null;
  }

  return {
    filePath: path.resolve(filePath),
    json,
    maxDurationMs,
    minProgressCompleted,
    minProgressRatio,
    requirePersistedAuth,
    requiredChecklistIds
  };
}

function parseAutopilotGateOpts(argv: string[]): {
  filePath: string;
  json: boolean;
  maxDurationMs: number;
  minProgressCompleted: number;
  minProgressRatio: number;
  requirePersistedAuth: boolean;
  requiredChecklistIds: string[];
} | null {
  return parseAutopilotCheckPolicyOpts(argv);
}

function parseTidyOpts(argv: string[]): {
  baseDir: string;
  outDir?: string | undefined;
  profileName: string;
  runId?: string | undefined;
  remote?: RemoteConfig | undefined;
} | null {
  const remoteDefaults = resolveRemoteDefaults();
  const baseDirDefault = process.env.BIOFLOW_BASE_DIR ?? ".bioflow";
  const remoteUrlDefault = remoteDefaults.url;
  const tokenDefault = remoteDefaults.token;
  const orgIdDefault = remoteDefaults.orgId;

  let baseDir = baseDirDefault;
  let outDir: string | undefined;
  let profileName = "sample-sheet-v1";
  let runId: string | undefined;
  let remoteUrl = remoteUrlDefault;
  let token = tokenDefault;
  let orgId = orgIdDefault;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--base-dir") {
      const v = argv[i + 1];
      if (!v) return null;
      baseDir = v;
      i++;
      continue;
    }
    if (arg === "--out") {
      const v = argv[i + 1];
      if (!v) return null;
      outDir = v;
      i++;
      continue;
    }
    if (arg === "--profile") {
      const v = argv[i + 1];
      if (!v) return null;
      profileName = v;
      i++;
      continue;
    }
    if (arg === "--remote-url") {
      const v = argv[i + 1];
      if (!v) return null;
      remoteUrl = v;
      i++;
      continue;
    }
    if (arg === "--token") {
      const v = argv[i + 1];
      if (!v) return null;
      token = v;
      i++;
      continue;
    }
    if (arg === "--org-id") {
      const v = argv[i + 1];
      if (!v) return null;
      orgId = v;
      i++;
      continue;
    }
    if (arg === "--run-id") {
      const v = argv[i + 1];
      if (!v) return null;
      runId = v;
      i++;
      continue;
    }
    return null;
  }

  return {
    baseDir: path.resolve(baseDir),
    outDir: outDir ? path.resolve(outDir) : undefined,
    profileName,
    runId,
    remote: token || orgId ? { url: remoteUrl, token, orgId } : undefined
  };
}

function parseReportOpts(argv: string[]): {
  baseDir: string;
  format: "markdown";
  outDir?: string | undefined;
  replay: boolean;
} | null {
  const baseDirDefault = process.env.BIOFLOW_BASE_DIR ?? ".bioflow";
  let baseDir = baseDirDefault;
  let format: "markdown" = "markdown";
  let outDir: string | undefined;
  let replay = true;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--base-dir") {
      const v = argv[i + 1];
      if (!v) return null;
      baseDir = v;
      i++;
      continue;
    }
    if (arg === "--format") {
      const v = argv[i + 1];
      if (!v) return null;
      if (v !== "markdown") return null;
      format = "markdown";
      i++;
      continue;
    }
    if (arg === "--out") {
      const v = argv[i + 1];
      if (!v) return null;
      outDir = v;
      i++;
      continue;
    }
    if (arg === "--no-replay") {
      replay = false;
      continue;
    }
    return null;
  }

  return {
    baseDir: path.resolve(baseDir),
    format,
    outDir: outDir ? path.resolve(outDir) : undefined,
    replay
  };
}

function parseSyncOpts(argv: string[]): {
  baseDir: string;
  remote: RemoteConfig;
  concurrency: number;
  dryRun: boolean;
  force: boolean;
  limit: number;
  cursor?: string | undefined;
  deep: boolean;
  profileId?: string | undefined;
  tags?: string[] | undefined;
  visibility?: "private" | "org" | "public" | undefined;
} | null {
  const remoteDefaults = resolveRemoteDefaults();
  const baseDirDefault = process.env.BIOFLOW_BASE_DIR ?? ".bioflow";
  const remoteUrlDefault = remoteDefaults.url;
  const tokenDefault = remoteDefaults.token;
  const orgIdDefault = remoteDefaults.orgId;

  let baseDir = baseDirDefault;
  let remoteUrl = remoteUrlDefault;
  let token = tokenDefault;
  let orgId = orgIdDefault;
  let concurrency = 4;
  let dryRun = false;
  let force = false;
  let limit = 50;
  let cursor: string | undefined;
  let deep = false;
  let profileId: string | undefined;
  let tags: string[] | undefined;
  let visibility: "private" | "org" | "public" | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--base-dir") {
      const v = argv[i + 1];
      if (!v) return null;
      baseDir = v;
      i++;
      continue;
    }
    if (arg === "--remote-url") {
      const v = argv[i + 1];
      if (!v) return null;
      remoteUrl = v;
      i++;
      continue;
    }
    if (arg === "--token") {
      const v = argv[i + 1];
      if (!v) return null;
      token = v;
      i++;
      continue;
    }
    if (arg === "--org-id") {
      const v = argv[i + 1];
      if (!v) return null;
      orgId = v;
      i++;
      continue;
    }
    if (arg === "--concurrency") {
      const v = argv[i + 1];
      if (!v) return null;
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) return null;
      concurrency = Math.min(16, Math.max(1, Math.trunc(n)));
      i++;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg === "--limit") {
      const v = argv[i + 1];
      if (!v) return null;
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) return null;
      limit = Math.min(200, Math.max(1, Math.trunc(n)));
      i++;
      continue;
    }
    if (arg === "--cursor") {
      const v = argv[i + 1];
      if (!v) return null;
      cursor = v;
      i++;
      continue;
    }
    if (arg === "--profile-id") {
      const v = argv[i + 1];
      if (!v) return null;
      profileId = v;
      i++;
      continue;
    }
    if (arg === "--tags") {
      const v = argv[i + 1];
      if (!v) return null;
      tags = v
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
      i++;
      continue;
    }
    if (arg === "--visibility") {
      const v = argv[i + 1];
      if (!v) return null;
      if (v !== "private" && v !== "org" && v !== "public") return null;
      visibility = v;
      i++;
      continue;
    }
    if (arg === "--deep") {
      deep = true;
      continue;
    }
    return null;
  }

  if (!token && !orgId) return null;

  return {
    baseDir: path.resolve(baseDir),
    remote: { url: remoteUrl, token, orgId },
    concurrency,
    dryRun,
    force,
    limit,
    cursor,
    deep,
    profileId,
    tags,
    visibility
  };
}

function makeTidyWorkflow(params: { profile: unknown }): Workflow {
  return assertValidWorkflow({
    id: `tidy.sample-sheet-v1`,
    version: "0.1.0",
    compliance: "Research",
    seed: "tidy",
    nodes: [
      { id: "start", kind: "trigger.manual", name: "Start" },
      {
        id: "tidy",
        kind: "action.connector",
        name: "Tidy sample sheet",
        config: {
          connector: "clean_csv",
          operation: "sample-sheet-v1",
          params: { profile: params.profile }
        }
      }
    ],
    edges: [{ from: "start", to: "tidy" }]
  });
}

async function fetchOrgSampleSheetProfile(
  name: string,
  remoteConfig: RemoteConfig | undefined
): Promise<unknown> {
  if (!remoteConfig) {
    throw new Error(
      `Profile "${name}" not found locally; set BIOFLOW_REMOTE_URL and BIOFLOW_REMOTE_ORG_ID (or BIOFLOW_REMOTE_TOKEN) to fetch from the org registry.`
    );
  }
  const { BioFlowRemote } = await import("../sync/remote.js");
  const remote = new BioFlowRemote({
    baseUrl: remoteConfig.url,
    auth: { token: remoteConfig.token, orgId: remoteConfig.orgId }
  });
  const res = (await remote.getProfile(name)) as any;
  if (!res?.profile_json) {
    throw new Error(`Remote profile "${name}" response missing profile_json`);
  }
  return res.profile_json;
}

async function exportArtifacts(params: {
  baseDir: string;
  outDir: string;
  artifacts: Array<{ name: string; sha256: string }>;
}): Promise<void> {
  await mkdir(params.outDir, { recursive: true });
  const cas = new LocalCAS(params.baseDir);
  const fs = await import("node:fs/promises");

  for (const a of params.artifacts) {
    const safeName = path.basename(a.name).replace(/[^A-Za-z0-9._-]+/g, "_");
    const bytes = await fs.readFile(cas.objectPath(a.sha256));
    await writeFile(path.join(params.outDir, safeName), bytes);
  }
}

function tryParseJson(value: string): unknown | null {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function printJson(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function withConfigPathEnv(configPath?: string): NodeJS.ProcessEnv {
  if (!configPath) return process.env;
  return {
    ...process.env,
    BIOFLOW_CONFIG_PATH: configPath
  };
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
