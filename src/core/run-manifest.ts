import path from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import type { Artifact } from "./types.js";
import { RunManifestSchemaV1, type RunManifestV1 } from "../schemas/manifest-v1.js";

export const RunManifestSchema = RunManifestSchemaV1;
export type { RunManifestV1 };

export interface RunMetadata {
  workflowId?: string | undefined;
  workflowVersion?: string | undefined;
  workflowDigest?: string | undefined;
  seed?: string | undefined;
}

export class RunManifestStore {
  constructor(private readonly baseDir: string) {}

  manifestPath(runId: string): string {
    return path.join(this.baseDir, "runs", runId, "manifest.json");
  }

  async initRun(runId: string, meta: RunMetadata = {}): Promise<void> {
    const manifestPath = this.manifestPath(runId);
    await mkdir(path.dirname(manifestPath), { recursive: true });

    const existing = await this.tryLoad(runId);
    if (existing) {
      const updated = mergeMeta(existing, meta);
      if (updated) await this.write(runId, updated);
      return;
    }

    const manifest: RunManifestV1 = {
      manifestVersion: 1,
      runId,
      createdAt: new Date().toISOString(),
      workflow: metaToWorkflow(meta),
      artifacts: {},
      inputs: []
    };
    await this.write(runId, manifest);
  }

  async load(runId: string): Promise<RunManifestV1> {
    const manifestPath = this.manifestPath(runId);
    const raw = await readFile(manifestPath, "utf8");
    const parsed = RunManifestSchema.parse(JSON.parse(raw));
    return parsed;
  }

  async recordArtifact(runId: string, artifact: Artifact): Promise<void> {
    await this.initRun(runId);
    const manifest = await this.load(runId);

    const next: RunManifestV1 = {
      ...manifest,
      artifacts: {
        ...manifest.artifacts,
        [artifact.name]: artifact
      },
      inputs:
        artifact.kind === "input" && !manifest.inputs.includes(artifact.name)
          ? [...manifest.inputs, artifact.name]
          : manifest.inputs
    };

    await this.write(runId, next);
  }

  private async tryLoad(runId: string): Promise<RunManifestV1 | null> {
    try {
      return await this.load(runId);
    } catch {
      return null;
    }
  }

  private async write(runId: string, manifest: RunManifestV1): Promise<void> {
    const outPath = this.manifestPath(runId);
    await mkdir(path.dirname(outPath), { recursive: true });
    const tmpPath = `${outPath}.tmp`;
    await writeFile(tmpPath, JSON.stringify(manifest, null, 2) + "\n");
    await rename(tmpPath, outPath);
  }
}

function metaToWorkflow(meta: RunMetadata): RunManifestV1["workflow"] {
  if (!meta.workflowId && !meta.workflowVersion && !meta.workflowDigest && !meta.seed) return undefined;
  return {
    id: meta.workflowId,
    version: meta.workflowVersion,
    digest: meta.workflowDigest,
    seed: meta.seed
  };
}

function mergeMeta(manifest: RunManifestV1, meta: RunMetadata): RunManifestV1 | null {
  const existing = manifest.workflow ?? {};
  const merged = {
    id: existing.id ?? meta.workflowId,
    version: existing.version ?? meta.workflowVersion,
    digest: existing.digest ?? meta.workflowDigest,
    seed: existing.seed ?? meta.seed
  };

  const same =
    merged.id === existing.id &&
    merged.version === existing.version &&
    merged.digest === existing.digest &&
    merged.seed === existing.seed;

  if (same) return null;
  return { ...manifest, workflow: merged };
}
