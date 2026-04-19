import type { Artifact } from "./types.js";
import type { ArtifactStore, PutBytesParams, PutJsonParams } from "./artifact-store.js";
import type { RunMetadata } from "./run-manifest.js";
import { sha256Hex } from "./hash.js";
import { sha256Uri } from "./cas.js";
import { stableStringify } from "./stable-json.js";

export class HashOnlyArtifactStore implements ArtifactStore {
  constructor(private readonly rootDir: string) {}

  baseDir(): string {
    return this.rootDir;
  }

  async initRun(_runId: string, _meta: RunMetadata = {}): Promise<void> {
    // no-op (verification should not mutate local state)
  }

  async recordArtifact(_runId: string, _artifact: Artifact): Promise<void> {
    // no-op
  }

  async putBytes(params: PutBytesParams): Promise<Artifact> {
    const hash = sha256Hex(params.bytes);
    return {
      name: params.name,
      uri: sha256Uri(hash),
      sha256: hash,
      bytes: params.bytes.byteLength,
      mediaType: params.mediaType,
      kind: params.kind,
      createdAt: new Date().toISOString()
    };
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

  async importFile(_runId: string, _filePath: string): Promise<Artifact> {
    throw new Error("HashOnlyArtifactStore does not support importFile()");
  }
}
