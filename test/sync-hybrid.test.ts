import { describe, expect, it } from "vitest";
import path from "node:path";
import { rm, readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { LocalArtifactStore } from "../src/core/artifact-store.js";
import { runWorkflow } from "../src/core/engine.js";
import type { Workflow } from "../src/core/types.js";
import { pushRunToRemote, pullRunFromRemote } from "../src/sync/hybrid.js";
import { sha256Hex } from "../src/core/hash.js";
import { verifyRun } from "../src/core/verify.js";

class InMemoryRemote {
  public readonly objects = new Map<string, Buffer>();
  public readonly runs = new Map<string, any>();

  async headObject(sha256: string): Promise<boolean> {
    return this.objects.has(sha256);
  }

  async uploadObjectFromPath(filePath: string): Promise<{ uri: string; sha256: string; bytes: number }> {
    const bytes = await readFile(filePath);
    const sha256 = sha256Hex(bytes);
    this.objects.set(sha256, bytes);
    return { uri: `sha256:${sha256}`, sha256, bytes: bytes.byteLength };
  }

  async downloadObject(sha256: string): Promise<NodeJS.ReadableStream> {
    const bytes = this.objects.get(sha256);
    if (!bytes) throw new Error(`Missing object: ${sha256}`);
    return Readable.from(bytes);
  }

  async postRunSync(runId: string, body: unknown): Promise<unknown> {
    this.runs.set(runId, body);
    return { ok: true };
  }

  async getRunSync(runId: string): Promise<unknown> {
    const body = this.runs.get(runId);
    if (!body) throw new Error(`Missing run: ${runId}`);
    return body;
  }
}

describe("hybrid sync", () => {
  it("push -> pull preserves verifiability", async () => {
    const srcDir = path.resolve(".bioflow_sync_src");
    const dstDir = path.resolve(".bioflow_sync_dst");
    await rm(srcDir, { recursive: true, force: true });
    await rm(dstDir, { recursive: true, force: true });

    const remote = new InMemoryRemote();

    const store = new LocalArtifactStore(srcDir);
    const runId = crypto.randomUUID();
    const workflow: Workflow = {
      id: "sync_test",
      version: "1.0.0",
      seed: "seed",
      nodes: [
        { id: "start", kind: "trigger.manual" },
        { id: "score", kind: "transform.score" }
      ],
      edges: [{ from: "start", to: "score" }]
    };

    const input = await store.putBytes({
      runId,
      name: "input.txt",
      bytes: new TextEncoder().encode("hello"),
      kind: "input"
    });
    await runWorkflow({ workflow, store, inputs: [input], runId, actor: "test" });

    const push = await pushRunToRemote({ baseDir: srcDir, runId, remote: remote as any, concurrency: 2 });
    expect(push.uploaded).toBeGreaterThan(0);

    const pull = await pullRunFromRemote({ baseDir: dstDir, runId, remote: remote as any, concurrency: 2 });
    expect(pull.downloaded).toBeGreaterThan(0);

    const verified = await verifyRun({ baseDir: dstDir, runId });
    expect(verified.valid).toBe(true);
  }, 20_000);
});

