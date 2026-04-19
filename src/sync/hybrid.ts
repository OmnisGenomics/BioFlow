import path from "node:path";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { LocalCAS } from "../core/cas.js";
import { sha256Json } from "../core/hash.js";
import { ExecutionRecordSchema, type ExecutionRecord } from "../core/execution-record.js";
import { RunManifestSchema, type RunManifestV1 } from "../core/run-manifest.js";
import type { BioFlowRemote } from "./remote.js";

export interface LocalRunBundle {
  manifest: RunManifestV1;
  executionRecord: ExecutionRecord;
}

export interface PushRunParams {
  baseDir: string;
  runId: string;
  remote: BioFlowRemote;
  concurrency?: number | undefined;
  dryRun?: boolean | undefined;
  profileId?: string | undefined;
  tags?: string[] | undefined;
  visibility?: "private" | "org" | "public" | undefined;
}

export interface PushRunResult {
  uploaded: number;
  skipped: number;
  remoteResponse?: unknown;
}

export async function pushRunToRemote(params: PushRunParams): Promise<PushRunResult> {
  const concurrency = clampInt(params.concurrency ?? 4, 1, 16);
  const bundle = await loadLocalRunBundle(params.baseDir, params.runId);
  const hashes = collectManifestObjectHashes(bundle.manifest);

  const cas = new LocalCAS(params.baseDir);
  let uploaded = 0;
  let skipped = 0;

  const toUpload: string[] = [];
  for (const hash of hashes) {
    const exists = await params.remote.headObject(hash);
    if (exists) skipped++;
    else toUpload.push(hash);
  }

  if (!params.dryRun) {
    await mapLimit(toUpload, concurrency, async (hash) => {
      const objPath = cas.objectPath(hash);
      await stat(objPath);
      const res = await params.remote.uploadObjectFromPath(objPath);
      if (res.sha256 !== hash) {
        throw new Error(`Remote stored object under different hash: expected ${hash}, got ${res.sha256}`);
      }
      uploaded++;
    });
  }

  const remoteResponse = params.dryRun
    ? undefined
    : await params.remote.postRunSync(params.runId, {
        manifest: bundle.manifest,
        executionRecord: bundle.executionRecord,
        profileId: params.profileId,
        tags: params.tags,
        visibility: params.visibility
      });

  return { uploaded, skipped, remoteResponse };
}

export interface PullRunParams {
  baseDir: string;
  runId: string;
  remote: BioFlowRemote;
  concurrency?: number | undefined;
  force?: boolean | undefined;
}

export interface PullRunResult {
  downloaded: number;
  skipped: number;
}

export async function pullRunFromRemote(params: PullRunParams): Promise<PullRunResult> {
  const concurrency = clampInt(params.concurrency ?? 4, 1, 16);
  const raw = await params.remote.getRunSync(params.runId);

  const obj = raw as Record<string, unknown>;
  const manifest = RunManifestSchema.parse(obj.manifest);
  const executionRecord = ExecutionRecordSchema.parse(obj.executionRecord);

  await ensureNoConflict({
    baseDir: params.baseDir,
    runId: params.runId,
    manifest,
    force: params.force ?? false
  });

  const cas = new LocalCAS(params.baseDir);
  const hashes = collectManifestObjectHashes(manifest);

  let downloaded = 0;
  let skipped = 0;

  await mapLimit(hashes, concurrency, async (hash) => {
    const objPath = cas.objectPath(hash);
    try {
      await stat(objPath);
      skipped++;
      return;
    } catch {
      // fall through
    }
    const stream = await params.remote.downloadObject(hash);
    const put = await cas.putStream(stream);
    if (put.hash !== hash) {
      throw new Error(`Downloaded object hash mismatch: expected ${hash}, got ${put.hash}`);
    }
    downloaded++;
  });

  const runDir = path.join(params.baseDir, "runs", params.runId);
  await mkdir(runDir, { recursive: true });
  await atomicWriteJson(path.join(runDir, "manifest.json"), manifest);
  await atomicWriteJson(path.join(runDir, "execution.json"), executionRecord);

  return { downloaded, skipped };
}

export async function loadLocalRunBundle(baseDir: string, runId: string): Promise<LocalRunBundle> {
  const runDir = path.join(baseDir, "runs", runId);
  const manifestPath = path.join(runDir, "manifest.json");
  const execPath = path.join(runDir, "execution.json");

  const manifestRaw = JSON.parse(await readFile(manifestPath, "utf8"));
  const execRaw = JSON.parse(await readFile(execPath, "utf8"));
  return {
    manifest: RunManifestSchema.parse(manifestRaw),
    executionRecord: ExecutionRecordSchema.parse(execRaw)
  };
}

export function collectManifestObjectHashes(manifest: RunManifestV1): string[] {
  const hashes = new Set<string>();
  for (const artifact of Object.values(manifest.artifacts)) {
    hashes.add(artifact.sha256);
  }
  return Array.from(hashes).sort();
}

async function ensureNoConflict(params: {
  baseDir: string;
  runId: string;
  manifest: RunManifestV1;
  force: boolean;
}): Promise<void> {
  const runDir = path.join(params.baseDir, "runs", params.runId);
  const manifestPath = path.join(runDir, "manifest.json");

  try {
    const localRaw = JSON.parse(await readFile(manifestPath, "utf8"));
    const local = RunManifestSchema.parse(localRaw);
    const localDigest = sha256Json(local);
    const remoteDigest = sha256Json(params.manifest);
    if (localDigest !== remoteDigest && !params.force) {
      throw new Error(
        `Local run ${params.runId} differs from remote. Re-run with --force to overwrite metadata.`
      );
    }
  } catch (err) {
    // If the file doesn't exist, no conflict.
    if (err instanceof Error && "code" in err && (err as { code?: unknown }).code === "ENOENT") {
      return;
    }
    // If the file exists but is invalid, be conservative unless forced.
    if (!params.force) throw err;
  }
}

async function atomicWriteJson(outPath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(outPath), { recursive: true });
  const tmpPath = `${outPath}.tmp`;
  await writeFile(tmpPath, JSON.stringify(value, null, 2) + "\n");
  await rename(tmpPath, outPath);
}

async function mapLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>
): Promise<void> {
  if (items.length === 0) return;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async (_zero, workerId) => {
    for (let i = workerId; i < items.length; i += limit) {
      await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}
