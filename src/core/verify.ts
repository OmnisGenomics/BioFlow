import path from "node:path";
import { readFile } from "node:fs/promises";
import { verifyAuditChain } from "./audit.js";
import { LocalCAS, parseSha256Uri } from "./cas.js";
import { sha256FileHex } from "./hash.js";
import { RunManifestStore } from "./run-manifest.js";
import { ExecutionRecordSchema } from "./execution-record.js";
import { assertValidWorkflow } from "./validate.js";
import { runWorkflow } from "./engine.js";
import { HashOnlyArtifactStore } from "./hash-only-store.js";
import type { Artifact } from "./types.js";

export interface VerifyParams {
  baseDir: string; // typically ".bioflow"
  runId: string;
  replay?: boolean;
}

export interface VerifyResult {
  valid: boolean;
  errors: string[];
}

export async function verifyRun(params: VerifyParams): Promise<VerifyResult> {
  const errors: string[] = [];
  const replay = params.replay ?? true;

  const executionPath = path.join(params.baseDir, "runs", params.runId, "execution.json");
  let record;
  try {
    const raw = await readFile(executionPath, "utf8");
    record = ExecutionRecordSchema.parse(JSON.parse(raw));
  } catch (err) {
    return {
      valid: false,
      errors: [
        `Missing or invalid execution record at ${executionPath}`,
        err instanceof Error ? err.message : String(err)
      ]
    };
  }

  const auditCheck = verifyAuditChain(record.execution.auditLog);
  if (!auditCheck.ok) errors.push(auditCheck.error ?? "Audit chain verification failed");

  const manifests = new RunManifestStore(params.baseDir);
  let manifest;
  try {
    manifest = await manifests.load(params.runId);
  } catch (err) {
    errors.push("Missing or invalid manifest.json (legacy runs are not verifiable yet).");
    if (err instanceof Error) errors.push(err.message);
    return { valid: false, errors };
  }

  // CAS integrity checks (missing objects + hash mismatches)
  const cas = new LocalCAS(params.baseDir);
  for (const [name, artifact] of Object.entries(manifest.artifacts)) {
    const hash = parseSha256Uri(artifact.uri);
    if (hash !== artifact.sha256) {
      errors.push(`Artifact ${name} sha mismatch: uri=${artifact.uri} sha256=${artifact.sha256}`);
      continue;
    }
    const objPath = cas.objectPath(hash);
    try {
      const computed = await sha256FileHex(objPath);
      if (computed.hash !== hash) {
        errors.push(`CAS object hash mismatch for ${name}: expected ${hash}, got ${computed.hash}`);
      }
    } catch (err) {
      errors.push(`Missing CAS object for ${name}: ${hash}`);
      if (err instanceof Error) errors.push(err.message);
    }
  }

  const workflowArtifact = manifest.artifacts["__workflow.json"];
  if (!workflowArtifact) {
    errors.push('Missing "__workflow.json" in manifest.');
    return { valid: false, errors };
  }
  if (workflowArtifact.sha256 !== record.execution.workflowDigest) {
    errors.push(
      `Workflow digest mismatch: execution=${record.execution.workflowDigest} manifest=${workflowArtifact.sha256}`
    );
    return { valid: false, errors };
  }

  // Replay deterministically and compare output digests (names -> sha256).
  if (replay && errors.length === 0) {
    const workflowJson = await readCasJson(cas, workflowArtifact.sha256);
    const workflow = assertValidWorkflow(workflowJson);

    const inputArtifacts = manifest.inputs.map((n) => manifest.artifacts[n]).filter(Boolean);
    if (inputArtifacts.length !== manifest.inputs.length) {
      errors.push("Manifest inputs list references missing artifacts.");
      return { valid: false, errors };
    }

    const store = new HashOnlyArtifactStore(params.baseDir);
    const replayRes = await runWorkflow({
      workflow,
      store,
      inputs: inputArtifacts as Artifact[],
      actor: "verify",
      runId: params.runId,
      persistExecution: false
    });

    const expected = new Map(record.execution.outputs.map((a) => [a.name, a.sha256]));
    const actual = new Map(replayRes.execution.outputs.map((a) => [a.name, a.sha256]));

    for (const [name, sha] of expected.entries()) {
      if (!actual.has(name)) errors.push(`Replay missing output: ${name}`);
      else if (actual.get(name) !== sha)
        errors.push(`Output mismatch ${name}: expected ${sha}, got ${actual.get(name)}`);
    }
    for (const name of actual.keys()) {
      if (!expected.has(name)) errors.push(`Replay produced unexpected output: ${name}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

async function readCasJson(cas: LocalCAS, hash: string): Promise<unknown> {
  const objPath = cas.objectPath(hash);
  const raw = await readFile(objPath, "utf8");
  return JSON.parse(raw);
}
