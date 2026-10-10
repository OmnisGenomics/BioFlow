import { describe, expect, it } from "vitest";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { bioflowCommand } from "../scripts/lib/process-command.js";
import { LocalCAS } from "../src/core/cas.js";

async function workspace() {
  const root = await mkdtemp(path.resolve(".bioflow_tidy_safety_"));
  const input = path.join(root, "input.csv");
  await writeFile(input, "Sample_ID,Index\nalpha,ACGT\n");
  const base = path.join(root, "store");
  const run = (args: string[]) => spawnSync(...bioflowCommand(["tidy", input, "--base-dir", base, ...args]), { encoding: "utf8" });
  return { root, input, base, run };
}

describe("local tidy evidence and export safety", () => {
  it.each(["../escape", "a/b", "a\\b", "..", "CON", "LPT1", "x".repeat(129)])("rejects unsafe run ID %s", async id => {
    const w = await workspace();
    try {
      const result = w.run(["--run-id", id]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Invalid run ID");
      await expect(readdir(path.join(w.base, "runs"))).rejects.toMatchObject({code: "ENOENT"});
    } finally { await rm(w.root, {recursive: true, force: true}); }
  });

  it("rejects a reused run ID without modifying the prior manifest or execution", async () => {
    const w = await workspace();
    try {
      expect(w.run(["--run-id", "preserved-run"]).status).toBe(0);
      const manifestPath = path.join(w.base, "runs", "preserved-run", "manifest.json");
      const executionPath = path.join(w.base, "runs", "preserved-run", "execution.json");
      const manifest = await readFile(manifestPath);
      const execution = await readFile(executionPath);
      await writeFile(w.input, "Sample_ID,Index\nbeta,TGCA\n");
      const result = w.run(["--run-id", "preserved-run"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Run ID already exists");
      expect(await readFile(manifestPath)).toEqual(manifest);
      expect(await readFile(executionPath)).toEqual(execution);
    } finally { await rm(w.root, {recursive: true, force: true}); }
  });

  it("rejects a colliding export without overwriting it or partially exporting the bundle", async () => {
    const w = await workspace();
    try {
      const out = path.join(w.root, "cleaned");
      await mkdir(out);
      const existing = path.join(out, "tidy.sample-sheet-v1.report.json");
      await writeFile(existing, "keep this file");
      const result = w.run(["--out", out]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Refusing to overwrite export");
      expect(await readFile(existing, "utf8")).toBe("keep this file");
      expect(await readdir(out)).toEqual(["tidy.sample-sheet-v1.report.json"]);
    } finally { await rm(w.root, {recursive: true, force: true}); }
  });

  it("rejects an oversized input before creating a run", async () => {
    const w = await workspace();
    try {
      await writeFile(w.input, Buffer.alloc(10 * 1024 * 1024 + 1, 65));
      const result = w.run([]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("10 MiB");
      await expect(readdir(path.join(w.base, "runs"))).rejects.toMatchObject({code: "ENOENT"});
    } finally { await rm(w.root, {recursive: true, force: true}); }
  });

  it("verifies a custom evidence directory by flag or environment and rejects unknown flags", async () => {
    const w = await workspace();
    try {
      expect(w.run(["--run-id", "custom-store"]).status).toBe(0);
      const explicit = spawnSync(...bioflowCommand(["verify", "custom-store", "--base-dir", w.base]), {encoding: "utf8"});
      expect(explicit.status, explicit.stderr).toBe(0);
      const fromEnv = spawnSync(...bioflowCommand(["verify", "custom-store"]), {encoding: "utf8", env: {...process.env, BIOFLOW_BASE_DIR: w.base}});
      expect(fromEnv.status, fromEnv.stderr).toBe(0);
      expect(spawnSync(...bioflowCommand(["verify", "custom-store", "--bogus"])).status).toBe(2);
    } finally { await rm(w.root, {recursive: true, force: true}); }
  });

  it("does not export evidence when an existing CAS object is corrupted", async () => {
    const w = await workspace();
    try {
      expect(w.run(["--run-id", "first"]).status).toBe(0);
      const manifest = JSON.parse(await readFile(path.join(w.base, "runs", "first", "manifest.json"), "utf8"));
      const cas = new LocalCAS(w.base);
      await writeFile(cas.objectPath(manifest.artifacts["tidy.sample-sheet-v1.data.csv"].sha256), "corrupted");
      const out = path.join(w.root, "cleaned");
      const result = w.run(["--out", out]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Tidy evidence verification failed");
      await expect(readdir(out)).rejects.toMatchObject({code: "ENOENT"});
    } finally { await rm(w.root, {recursive: true, force: true}); }
  });

  it("rejects reserved input filenames before evidence can be overwritten", async () => {
    const w = await workspace();
    try {
      const input = path.join(w.root, "__workflow.json");
      await writeFile(input, "Sample_ID,Index\nalpha,ACGT\n");
      const result = spawnSync(...bioflowCommand(["tidy", input, "--base-dir", w.base]), {encoding: "utf8"});
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Input filename is reserved");
      await expect(readdir(path.join(w.base, "runs"))).rejects.toMatchObject({code: "ENOENT"});
    } finally { await rm(w.root, {recursive: true, force: true}); }
  });
});
