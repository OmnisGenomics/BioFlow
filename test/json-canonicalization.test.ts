import { describe, expect, it } from "vitest";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { LocalArtifactStore } from "../src/core/artifact-store.js";
import { HashOnlyArtifactStore } from "../src/core/hash-only-store.js";

describe("JSON canonicalization", () => {
  it("normalizes key order in LocalArtifactStore.putJson", async () => {
    const baseDir = await mkdtemp(path.join(tmpdir(), "bioflow-json-canonical-local-"));
    try {
      const store = new LocalArtifactStore(baseDir);
      const a = await store.putJson({
        runId: "canon-local",
        name: "a.json",
        value: buildValueOrderA()
      });
      const b = await store.putJson({
        runId: "canon-local",
        name: "b.json",
        value: buildValueOrderB()
      });
      expect(a.sha256).toBe(b.sha256);
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  it("normalizes key order in HashOnlyArtifactStore.putJson", async () => {
    const baseDir = await mkdtemp(path.join(tmpdir(), "bioflow-json-canonical-hash-"));
    try {
      const store = new HashOnlyArtifactStore(baseDir);
      const a = await store.putJson({
        runId: "canon-hash",
        name: "a.json",
        value: buildValueOrderA()
      });
      const b = await store.putJson({
        runId: "canon-hash",
        name: "b.json",
        value: buildValueOrderB()
      });
      expect(a.sha256).toBe(b.sha256);
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });
});

function buildValueOrderA(): unknown {
  const nested: Record<string, unknown> = {};
  nested.z = 3;
  nested.a = 1;

  const row: Record<string, unknown> = {};
  row.m = 2;
  row.n = 1;

  const root: Record<string, unknown> = {};
  root.beta = nested;
  root.alpha = [row];
  root.omega = true;
  return root;
}

function buildValueOrderB(): unknown {
  const nested: Record<string, unknown> = {};
  nested.a = 1;
  nested.z = 3;

  const row: Record<string, unknown> = {};
  row.n = 1;
  row.m = 2;

  const root: Record<string, unknown> = {};
  root.omega = true;
  root.alpha = [row];
  root.beta = nested;
  return root;
}
