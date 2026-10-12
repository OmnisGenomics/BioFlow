import { describe, expect, it } from "vitest";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { bioflowCommand } from "../scripts/lib/process-command.js";
import { previewSampleSheet } from "../src/clean/review.js";
import { sampleSheetV1Profile } from "../src/clean/profiles/sample-sheet-v1.js";
import { sha256Hex, sha256Json } from "../src/core/hash.js";
import { verifyRun } from "../src/core/verify.js";
import { RunManifestStore } from "../src/core/run-manifest.js";

const sheets = [
  '\uFEFF[Header]\r\nVersion,4\r\n[Data]\r\nSample Id,Index,Index2,Lanes,Note\r\nalpha-1,acgt+tgca,tgca,"3,2,2","first, line\r\nsecond ""quoted"""\r\nalpha 1,ttaa,,1,other\r\n[Settings]\r\nKey,Value\r\n\r\n',
  'Sample Id\tIndex\tLanes\tNote\nalpha-1\tacgt\t2-1\t"first\tvalue"\nalpha 1\tttaa\t1\tother\n'
];

async function workspace(text = sheets[0]!) {
  const root = await mkdtemp(path.resolve(".bioflow_recovery_"));
  const input = path.join(root, "input.csv");
  const base = path.join(root, "store");
  await writeFile(input, text);
  const env = { ...process.env, BIOFLOW_BASE_DIR: base, BIOFLOW_CONFIG_PATH: path.join(root, "config.json") };
  const run = (args: string[], fault?: { target: string; mode: "throw" | "pause" }) => {
    const [command, args0] = bioflowCommand(args);
    const extra = fault ? ["--import", new URL("./fixtures/recovery-write-fault.mjs", import.meta.url).href] : [];
    return spawnSync(command, [...extra, ...args0], { cwd: root, encoding: "utf8", timeout: 15_000,
      env: { ...env, ...(fault ? { BIOFLOW_TEST_WRITE_TARGET: fault.target, BIOFLOW_TEST_WRITE_MARKER: path.join(root, "paused"), BIOFLOW_TEST_WRITE_MODE: fault.mode } : {}) } });
  };
  const tidy = (id: string, out: string, hash: string) => ["tidy", input, "--run-id", id, "--out", out, "--accept-preview", hash];
  const preview = () => {
    const result = run(["preview-sample-sheet", input, "--json"]);
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout) as ReturnType<typeof previewSampleSheet>;
  };
  return { root, input, base, env, run, tidy, preview };
}

async function terminateAtWrite(w: Awaited<ReturnType<typeof workspace>>, args: string[], target: string) {
  const [command, argv] = bioflowCommand(args);
  const marker = path.join(w.root, "paused");
  const child = spawn(command, ["--import", new URL("./fixtures/recovery-write-fault.mjs", import.meta.url).href, ...argv], {
    cwd: w.root, stdio: "ignore", env: { ...w.env, BIOFLOW_TEST_WRITE_TARGET: target, BIOFLOW_TEST_WRITE_MARKER: marker, BIOFLOW_TEST_WRITE_MODE: "pause" }
  });
  const closed = new Promise<void>((resolve, reject) => { child.once("close", () => resolve()); child.once("error", reject); });
  try {
    const deadline = Date.now() + 10_000;
    let paused = false;
    while (Date.now() < deadline) {
      try { await readFile(marker); paused = true; break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (child.exitCode !== null) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(paused, "child must reach the injected partial-write checkpoint").toBe(true);
  } finally {
    child.kill("SIGKILL");
    await closed;
  }
}

describe("sample-sheet workflow recovery", () => {
  it.each(sheets)("validates, accepts, exports and replays synthetic messy sheet %# without overwrites", async text => {
    const w = await workspace(text);
    try {
      const original = await readFile(w.input);
      const validation = w.run(["validate-sample-sheet", w.input, "--json"]);
      expect(validation.status, validation.stderr).toBe(0);
      expect(JSON.parse(validation.stdout)).toMatchObject({ valid: true, needsChanges: true, rowCount: 2 });
      const preview = w.preview();
      expect(await readdir(w.root)).toEqual(["input.csv"]);
      const out = path.join(w.root, "out");
      const args = w.tidy("reviewed", out, preview.previewSha256);
      const accepted = w.run(args);
      expect(accepted.status, accepted.stderr).toBe(0);
      const exported = await readFile(path.join(out, "tidy.sample-sheet-v1.clean.csv"));
      expect(exported.toString()).toBe(preview.cleanedText);
      expect(sha256Hex(exported)).toBe(preview.outputSha256);
      expect((await verifyRun({ baseDir: w.base, runId: "reviewed" })).valid).toBe(true);
      const manifestPath = path.join(w.base, "runs", "reviewed", "manifest.json");
      const manifest = await readFile(manifestPath);
      expect(w.run(args).stderr).toContain("Run ID already exists");
      expect(await readFile(manifestPath)).toEqual(manifest);
      const collision = w.run(w.tidy("destination-collision", out, preview.previewSha256));
      expect(collision.status).toBe(1);
      expect(collision.stderr).toContain("Refusing to overwrite export");
      expect(await readFile(path.join(out, "tidy.sample-sheet-v1.clean.csv"))).toEqual(exported);
      const fresh = path.join(w.root, "fresh-out");
      expect(w.run(w.tidy("fresh", fresh, preview.previewSha256)).status).toBe(0);
      expect(await readFile(path.join(fresh, "tidy.sample-sheet-v1.clean.csv"))).toEqual(exported);
      expect(await readFile(w.input)).toEqual(original);
    } finally { await rm(w.root, { recursive: true, force: true }); }
  }, 20_000);

  it.each(["input", "profile", "output"])("rejects stale %s review hashes before creating state", async kind => {
    const w = await workspace();
    try {
      let preview = w.preview();
      let hash = preview.previewSha256;
      if (kind === "input") await writeFile(w.input, sheets[0]!.replace("other", "edited metadata"));
      if (kind === "profile") {
        const profile = structuredClone(sampleSheetV1Profile);
        profile.rules.sampleId.maxLen = 31;
        preview = previewSampleSheet(await readFile(w.input), profile);
        hash = preview.previewSha256;
      }
      if (kind === "output") {
        const { previewSha256: _ignored, ...review } = preview;
        const cleanedText = review.cleanedText + "changed output\r\n";
        hash = sha256Json({ ...review, cleanedText, outputSha256: sha256Hex(cleanedText) });
      }
      const result = w.run(w.tidy("stale", path.join(w.root, "out"), hash));
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Preview no longer matches");
      expect(await readdir(w.root)).toEqual(["input.csv"]);
    } finally { await rm(w.root, { recursive: true, force: true }); }
  });

  it("rolls back newly created exports on an ordinary partial-write failure", async () => {
    const w = await workspace();
    try {
      const out = path.join(w.root, "out");
      await mkdir(out);
      await writeFile(path.join(out, "unrelated.txt"), "preserve");
      const preview = w.preview();
      const result = w.run(w.tidy("failed-export", out, preview.previewSha256), {
        target: path.join(out, "tidy.sample-sheet-v1.data.csv"), mode: "throw"
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Injected recovery write failure");
      expect(await readdir(out)).toEqual(["unrelated.txt"]);
      expect(await readFile(path.join(out, "unrelated.txt"), "utf8")).toBe("preserve");
      expect((await verifyRun({ baseDir: w.base, runId: "failed-export" })).valid).toBe(true);
      expect(w.run(w.tidy("retry", out, preview.previewSha256)).status).toBe(0);
    } finally { await rm(w.root, { recursive: true, force: true }); }
  });

  it("preserves a terminated partial export and recovers with a fresh destination/run ID", async () => {
    const w = await workspace();
    try {
      const preview = w.preview();
      const out = path.join(w.root, "out");
      const target = path.join(out, "tidy.sample-sheet-v1.clean.csv");
      await terminateAtWrite(w, w.tidy("terminated-export", out, preview.previewSha256), target);
      const partial = await readFile(target);
      expect(partial.length).toBe(8);
      expect(sha256Hex(partial)).not.toBe(preview.outputSha256);
      expect((await verifyRun({ baseDir: w.base, runId: "terminated-export" })).valid).toBe(true);
      const retry = w.run(w.tidy("same-destination", out, preview.previewSha256));
      expect(retry.status).toBe(1);
      expect(retry.stderr).toContain("Refusing to overwrite export");
      expect(await readFile(target)).toEqual(partial);
      const fresh = path.join(w.root, "fresh");
      expect(w.run(w.tidy("fresh", fresh, preview.previewSha256)).status).toBe(0);
      expect(sha256Hex(await readFile(path.join(fresh, path.basename(target))))).toBe(preview.outputSha256);
    } finally { await rm(w.root, { recursive: true, force: true }); }
  }, 20_000);

  it("retains incomplete claimed run state after termination during manifest staging", async () => {
    const w = await workspace();
    try {
      const preview = w.preview();
      const out = path.join(w.root, "out");
      const staging = path.join(w.base, "runs", "interrupted", "manifest.json.tmp");
      await terminateAtWrite(w, w.tidy("interrupted", out, preview.previewSha256), staging);
      const partial = await readFile(staging);
      expect(partial.length).toBe(8);
      expect((await verifyRun({ baseDir: w.base, runId: "interrupted" })).valid).toBe(false);
      expect(w.run(w.tidy("interrupted", out, preview.previewSha256)).stderr).toContain("Run ID already exists");
      expect(await readFile(staging)).toEqual(partial);
      await expect(readdir(out)).rejects.toMatchObject({ code: "ENOENT" });
      expect(w.run(w.tidy("recovered", out, preview.previewSha256)).status).toBe(0);
      expect((await verifyRun({ baseDir: w.base, runId: "recovered" })).valid).toBe(true);
      expect(await readFile(staging)).toEqual(partial);
    } finally { await rm(w.root, { recursive: true, force: true }); }
  }, 20_000);

  it.each(['{"manifestVersion":', '{}'])("does not replace existing unreadable manifest %s", async corrupt => {
    const w = await workspace();
    try {
      const store = new RunManifestStore(w.base);
      await store.initRun("damaged");
      const manifest = store.manifestPath("damaged");
      await writeFile(manifest, corrupt);
      await expect(store.initRun("damaged")).rejects.toThrow();
      expect(await readFile(manifest, "utf8")).toBe(corrupt);
    } finally { await rm(w.root, { recursive: true, force: true }); }
  });
});
