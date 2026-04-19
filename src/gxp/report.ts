import path from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { verifyAuditChain } from "../core/audit.js";
import { LocalCAS, sha256Uri } from "../core/cas.js";
import { sha256Json } from "../core/hash.js";
import { RunManifestSchema, RunManifestStore, type RunManifestV1 } from "../core/run-manifest.js";
import { ExecutionRecordSchema, type ExecutionRecord } from "../core/execution-record.js";
import { assertValidWorkflow } from "../core/validate.js";
import { verifyRun } from "../core/verify.js";
import type { Artifact } from "../core/types.js";
import {
  GXP_REPORT_SCHEMA_SEMVER,
  GxpReportPayloadSchemaV1,
  type GxpReportPayloadV1
} from "../schemas/report-v1.js";

export type GxpReportFormat = "markdown";

export interface GenerateGxpReportParams {
  baseDir: string;
  runId: string;
  format?: GxpReportFormat | undefined;
  replay?: boolean | undefined;
  orgName?: string | undefined;
  outDir?: string | undefined;
  /**
   * Optional hook to write the report bytes into CAS (e.g. service-side quota/accounting).
   * Defaults to `LocalCAS.putBytes`.
   */
  putCasBytes?: ((bytes: Uint8Array) => Promise<{ hash: string; bytes: number }>) | undefined;
}

export interface GenerateGxpReportResult {
  artifact: Artifact;
  reportDigest: string; // sha256 of canonical JSON report payload
  outputPath?: string | undefined;
}

/**
 * Deterministic report generation:
 * - output bytes depend only on run-local persisted artifacts (manifest + execution + workflow snapshot)
 * - no `Date.now()` / `new Date()` values are used
 */
export async function generateGxpReport(params: GenerateGxpReportParams): Promise<GenerateGxpReportResult> {
  const format = params.format ?? "markdown";
  if (format !== "markdown") throw new Error(`Unsupported report format: ${format}`);

  const runDir = path.join(params.baseDir, "runs", params.runId);
  const manifestPath = path.join(runDir, "manifest.json");
  const executionPath = path.join(runDir, "execution.json");

  const manifest = await loadManifest(manifestPath);
  const record = await loadExecutionRecord(executionPath);

  const auditCheck = verifyAuditChain(record.execution.auditLog);
  const deep = await verifyRun({ baseDir: params.baseDir, runId: params.runId, replay: params.replay ?? true });

  const workflowArtifact = manifest.artifacts["__workflow.json"];
  if (!workflowArtifact) throw new Error('Missing "__workflow.json" in manifest');

  const cas = new LocalCAS(params.baseDir);
  const workflowJson = JSON.parse(await readFile(cas.objectPath(workflowArtifact.sha256), "utf8"));
  const workflow = assertValidWorkflow(workflowJson);

  const profile = extractProfileFromWorkflow(workflowJson);
  const profileDigest = profile ? sha256Json(profile) : null;
  const profileId = typeof (profile as any)?.id === "string" ? String((profile as any).id) : null;
  const profileVersion =
    typeof (profile as any)?.version === "string" ? String((profile as any).version) : null;

  const generatedAt = record.execution.endedAt ?? record.execution.startedAt;
  const inputs = manifest.inputs
    .map((name) => manifest.artifacts[name])
    .filter(isDefined)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
  const outputs = record.execution.outputs
    .filter(isDefined)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));

  const lastAudit = record.execution.auditLog[record.execution.auditLog.length - 1];
  const firstAudit = record.execution.auditLog[0];

  const reportPayload = GxpReportPayloadSchemaV1.parse({
    reportVersion: GXP_REPORT_SCHEMA_SEMVER,
    runId: params.runId,
    workflow: {
      id: workflow.id,
      version: workflow.version,
      digest: record.execution.workflowDigest
    },
    organization: params.orgName ?? "local",
    generatedAt,
    installation: {
      environment: {
        executionMode: isServiceBaseDir(params.baseDir) ? "service" : "local",
        deterministicSeed: workflow.seed ?? null,
        casAddressing: "sha256-content" as const
      },
      runtime: {
        nodejs: record.execution.runtime.nodeVersion,
        platform: record.execution.runtime.platform,
        arch: record.execution.runtime.arch
      },
      checksums: {
        workflowDefinition: workflowArtifact.sha256,
        workflowDigest: record.execution.workflowDigest,
        profileId,
        profileVersion,
        profileDigest
      }
    },
    operational: {
      auditIntegrity: auditCheck.ok,
      replayIntegrity: deep.valid,
      replayErrors: deep.valid ? [] : deep.errors,
      steps: record.nodeRuns.map((nr, idx) => ({
        id: `STEP-${String(idx + 1).padStart(3, "0")}`,
        nodeId: nr.nodeId,
        kind: nr.kind,
        status: nr.status,
        startedAt: nr.startedAt,
        endedAt: nr.endedAt,
        inputs: nr.inputs.map((a) => ({ name: a.name, sha256: a.sha256, bytes: a.bytes })),
        outputs: nr.outputs.map((a) => ({ name: a.name, sha256: a.sha256, bytes: a.bytes })),
        costUSD: nr.costUSD,
        error: nr.error ?? null
      })),
      summary: {
        totalSteps: record.nodeRuns.length,
        passed: record.nodeRuns.filter((n) => n.status === "ok").length,
        failed: record.nodeRuns.filter((n) => n.status === "failed").length,
        skipped: record.nodeRuns.filter((n) => n.status === "skipped").length
      }
    },
    auditTrail: {
      chainHash: lastAudit?.hash ?? null,
      entryCount: record.execution.auditLog.length,
      firstEntryAt: firstAudit?.at ?? null,
      lastEntryAt: lastAudit?.at ?? null,
      integrityVerified: auditCheck.ok,
      error: auditCheck.ok ? null : auditCheck.error ?? "audit verification failed"
    },
    artifacts: {
      workflowSnapshot: { name: workflowArtifact.name, sha256: workflowArtifact.sha256, uri: workflowArtifact.uri },
      inputs: inputs.map((a) => ({ name: a.name, sha256: a.sha256, uri: a.uri, bytes: a.bytes })),
      outputs: outputs.map((a) => ({ name: a.name, sha256: a.sha256, uri: a.uri, bytes: a.bytes }))
    }
  });

  const reportDigest = sha256Json(reportPayload);
  const markdown = renderMarkdown({ reportPayload, reportDigest });
  const bytes = new TextEncoder().encode(markdown);
  const put = params.putCasBytes ? await params.putCasBytes(bytes) : await cas.putBytes(bytes);

  const reportArtifact: Artifact = {
    name: "gxp-report.md",
    uri: sha256Uri(put.hash),
    sha256: put.hash,
    bytes: put.bytes,
    mediaType: "text/markdown",
    kind: "report",
    createdAt: generatedAt
  };

  const manifests = new RunManifestStore(params.baseDir);
  await manifests.recordArtifact(params.runId, reportArtifact);

  let outputPath: string | undefined;
  if (params.outDir) {
    await mkdir(params.outDir, { recursive: true });
    outputPath = path.join(params.outDir, `${params.runId}-gxp-report.md`);
    await writeFile(outputPath, bytes);
  }

  return { artifact: reportArtifact, reportDigest, outputPath };
}

function isServiceBaseDir(baseDir: string): boolean {
  // Heuristic only; callers can override orgName/executionMode by passing stable data in the payload later.
  return baseDir.includes(`${path.sep}tenants${path.sep}`);
}

async function loadManifest(manifestPath: string): Promise<RunManifestV1> {
  const raw = await readFile(manifestPath, "utf8");
  return RunManifestSchema.parse(JSON.parse(raw));
}

async function loadExecutionRecord(executionPath: string): Promise<ExecutionRecord> {
  const raw = await readFile(executionPath, "utf8");
  return ExecutionRecordSchema.parse(JSON.parse(raw));
}

function extractProfileFromWorkflow(workflowJson: unknown): unknown | null {
  if (!workflowJson || typeof workflowJson !== "object") return null;
  const obj = workflowJson as Record<string, unknown>;
  const nodes = obj["nodes"];
  if (!Array.isArray(nodes)) return null;
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    const n = node as Record<string, unknown>;
    const config = n["config"];
    if (!config || typeof config !== "object") continue;
    const c = config as Record<string, unknown>;
    if (c["connector"] !== "clean_csv") continue;
    const params = c["params"];
    if (!params || typeof params !== "object") continue;
    const p = params as Record<string, unknown>;
    if (!("profile" in p)) continue;
    return p["profile"] ?? null;
  }
  return null;
}

function renderMarkdown(params: { reportPayload: GxpReportPayloadV1; reportDigest: string }): string {
  const payload = params.reportPayload;
  const lines: string[] = [];

  lines.push(`# Validation Report: ${String(payload.runId)}`);
  lines.push("");
  lines.push(`- Report schema: v${String(payload.reportVersion)}`);
  lines.push(`- Report digest (canonical JSON): \`${params.reportDigest}\``);
  lines.push(`- Workflow: \`${String(payload.workflow.id)}@${String(payload.workflow.version)}\``);
  lines.push(`- Workflow digest: \`${String(payload.workflow.digest)}\``);
  lines.push(`- Generated at: ${String(payload.generatedAt)}`);
  lines.push(`- Organization: ${String(payload.organization)}`);
  lines.push("");
  lines.push("---");
  lines.push("");

  lines.push("## 1. Installation Qualification (IQ)");
  lines.push("");
  lines.push("### 1.1 Runtime");
  lines.push("");
  lines.push(`- Node.js: ${String(payload.installation.runtime.nodejs)}`);
  lines.push(`- Platform: ${String(payload.installation.runtime.platform)} (${String(payload.installation.runtime.arch)})`);
  lines.push("");
  lines.push("### 1.2 Determinism + CAS");
  lines.push("");
  lines.push(`- Execution mode: ${String(payload.installation.environment.executionMode)}`);
  lines.push(`- Seed: ${payload.installation.environment.deterministicSeed ? `\`${String(payload.installation.environment.deterministicSeed)}\`` : "n/a"}`);
  lines.push(`- CAS addressing: ${String(payload.installation.environment.casAddressing)}`);
  lines.push("");
  lines.push("### 1.3 Checksums");
  lines.push("");
  lines.push(`- Workflow snapshot (__workflow.json): \`${String(payload.installation.checksums.workflowDefinition)}\``);
  lines.push(`- Workflow digest: \`${String(payload.installation.checksums.workflowDigest)}\``);
  if (payload.installation.checksums.profileDigest) {
    lines.push(`- Profile digest: \`${String(payload.installation.checksums.profileDigest)}\``);
    if (payload.installation.checksums.profileId || payload.installation.checksums.profileVersion) {
      lines.push(
        `  - Profile: \`${String(payload.installation.checksums.profileId ?? "unknown")}@${String(payload.installation.checksums.profileVersion ?? "unknown")}\``
      );
    }
  } else {
    lines.push(`- Profile digest: n/a`);
  }
  lines.push("");
  lines.push("---");
  lines.push("");

  lines.push("## 2. Operational Qualification (OQ)");
  lines.push("");
  lines.push("### 2.1 Summary");
  lines.push("");
  lines.push(`- Steps: ${String(payload.operational.summary.totalSteps)}`);
  lines.push(`- Passed: ${String(payload.operational.summary.passed)}`);
  lines.push(`- Failed: ${String(payload.operational.summary.failed)}`);
  lines.push(`- Skipped: ${String(payload.operational.summary.skipped)}`);
  lines.push("");
  lines.push("### 2.2 Integrity checks");
  lines.push("");
  lines.push(`- Audit chain integrity: ${payload.operational.auditIntegrity ? "**VERIFIED**" : "**FAILED**"}`);
  lines.push(`- Replay integrity: ${payload.operational.replayIntegrity ? "**VERIFIED**" : "**FAILED**"}`);
  if (Array.isArray(payload.operational.replayErrors) && payload.operational.replayErrors.length) {
    lines.push("");
    lines.push("Replay errors:");
    for (const e of payload.operational.replayErrors) lines.push(`- ${String(e)}`);
  }
  lines.push("");
  lines.push("### 2.3 Step-by-step");
  lines.push("");
  lines.push("| Step | Node | Kind | Status | Inputs | Outputs |");
  lines.push("|------|------|------|--------|--------|---------|");
  for (const step of payload.operational.steps) {
    const inputs = step.inputs.map((a) => `\`${String(a.sha256).slice(0, 8)}…\``).join(", ");
    const outputs = step.outputs.map((a) => `\`${String(a.sha256).slice(0, 8)}…\``).join(", ");
    lines.push(
      `| ${escapeMdCell(step.id)} | ${escapeMdCell(step.nodeId)} | ${escapeMdCell(step.kind)} | ${escapeMdCell(
        step.status
      )} | ${inputs || "n/a"} | ${outputs || "n/a"} |`
    );
  }
  lines.push("");
  lines.push("---");
  lines.push("");

  lines.push("## 3. Audit Trail Attestation");
  lines.push("");
  lines.push(`- Chain hash: ${payload.auditTrail.chainHash ? `\`${String(payload.auditTrail.chainHash)}\`` : "n/a"}`);
  lines.push(`- Entries: ${String(payload.auditTrail.entryCount)}`);
  lines.push(
    `- Time range: ${String(payload.auditTrail.firstEntryAt ?? "n/a")} → ${String(payload.auditTrail.lastEntryAt ?? "n/a")}`
  );
  lines.push(`- Integrity verified: ${payload.auditTrail.integrityVerified ? "**YES**" : "**NO**"}`);
  if (payload.auditTrail.error) lines.push(`- Error: ${String(payload.auditTrail.error)}`);
  lines.push("");
  lines.push("Verification command:");
  lines.push("");
  lines.push("```bash");
  lines.push(`bioflow verify ${String(payload.runId)}`);
  lines.push("```");
  lines.push("");
  lines.push("---");
  lines.push("");

  lines.push("## 4. Data Integrity");
  lines.push("");
  lines.push("### 4.1 Inputs");
  lines.push("");
  for (const a of payload.artifacts.inputs) {
    lines.push(`- ${String(a.name)}: \`${String(a.sha256)}\` (${String(a.bytes)} bytes)`);
  }
  lines.push("");
  lines.push("### 4.2 Outputs");
  lines.push("");
  for (const a of payload.artifacts.outputs) {
    lines.push(`- ${String(a.name)}: \`${String(a.sha256)}\` (${String(a.bytes)} bytes)`);
  }
  lines.push("");

  return lines.join("\n") + "\n";
}

function escapeMdCell(value: unknown): string {
  return String(value).replaceAll("|", "\\|");
}

function isDefined<T>(value: T | null | undefined): value is T {
  return value != null;
}
