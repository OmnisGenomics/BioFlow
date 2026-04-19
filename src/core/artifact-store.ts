import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { LocalCAS, sha256Uri } from "./cas.js";
import type { Artifact } from "./types.js";
import { RunManifestStore, type RunMetadata } from "./run-manifest.js";
import { stableStringify } from "./stable-json.js";

export interface PutBytesParams {
  runId: string;
  name: string;
  bytes: Uint8Array;
  mediaType?: string;
  kind?: string;
}

export interface PutJsonParams {
  runId: string;
  name: string;
  value: unknown;
  kind?: string;
}

export interface ArtifactStore {
  baseDir(): string;
  initRun(runId: string, meta?: RunMetadata): Promise<void>;
  recordArtifact(runId: string, artifact: Artifact): Promise<void>;
  putBytes(params: PutBytesParams): Promise<Artifact>;
  putJson(params: PutJsonParams): Promise<Artifact>;
  importFile(runId: string, filePath: string): Promise<Artifact>;
}

export class LocalArtifactStore implements ArtifactStore {
  private readonly cas: LocalCAS;
  private readonly manifests: RunManifestStore;

  constructor(private readonly rootDir: string) {
    this.cas = new LocalCAS(rootDir);
    this.manifests = new RunManifestStore(rootDir);
  }

  baseDir(): string {
    return this.rootDir;
  }

  async initRun(runId: string, meta: RunMetadata = {}): Promise<void> {
    await mkdir(path.join(this.rootDir, "runs", runId), { recursive: true });
    await this.manifests.initRun(runId, meta);
  }

  async recordArtifact(runId: string, artifact: Artifact): Promise<void> {
    await this.initRun(runId);
    await this.manifests.recordArtifact(runId, artifact);
  }

  async putBytes(params: PutBytesParams): Promise<Artifact> {
    await this.initRun(params.runId);
    const { hash } = await this.cas.putBytes(params.bytes);
    const artifact: Artifact = {
      name: params.name,
      uri: sha256Uri(hash),
      sha256: hash,
      bytes: params.bytes.byteLength,
      mediaType: params.mediaType,
      kind: params.kind,
      createdAt: new Date().toISOString()
    };
    await this.recordArtifact(params.runId, artifact);
    return artifact;
  }

  async putJson(params: PutJsonParams): Promise<Artifact> {
    const json = stableStringify(params.value) + "\n";
    return this.putBytes({
      runId: params.runId,
      name: params.name,
      bytes: new TextEncoder().encode(json),
      mediaType: "application/json",
      kind: params.kind ?? "json"
    });
  }

  async importFile(runId: string, filePath: string): Promise<Artifact> {
    const info = await stat(filePath);
    const name = path.basename(filePath);
    await this.initRun(runId);
    const { hash, bytes } = await this.cas.putFile(filePath);
    const artifact: Artifact = {
      name,
      uri: sha256Uri(hash),
      sha256: hash,
      bytes,
      mediaType: guessMediaType(name),
      kind: "input",
      createdAt: new Date().toISOString()
    };
    // keep original byte size as seen on disk for transparency
    const normalized = { ...artifact, bytes: info.size };
    await this.recordArtifact(runId, normalized);
    return normalized;
  }
}

function guessMediaType(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "application/yaml";
  if (lower.endsWith(".txt") || lower.endsWith(".log") || lower.endsWith(".md"))
    return "text/plain";
  if (lower.endsWith(".csv")) return "text/csv";
  return "application/octet-stream";
}
