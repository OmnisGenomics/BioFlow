import { describe, expect, it } from "vitest";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { bioflowCommand } from "../scripts/lib/process-command.js";
import { sha256Hex } from "../src/core/hash.js";

async function workspace() {
  const root = await mkdtemp(path.resolve(".bioflow_review_cli_"));
  const input = path.join(root, "sample.csv");
  const bytes = Buffer.from('Sample_ID,Index,Note\nalpha-1,acgt,"quoted, metadata"\nalpha 1,TGCA,second\n');
  await writeFile(input, bytes);
  const run = (args: string[]) => spawnSync(...bioflowCommand(args), {
    cwd: root, encoding: "utf8", env: {...process.env, BIOFLOW_BASE_DIR: path.join(root, "store"), BIOFLOW_CONFIG_PATH: path.join(root, "config.json")}
  });
  return { root, input, bytes, run };
}

describe("read-only sample-sheet CLI review and acceptance", () => {
  it.each(["validate-sample-sheet", "preview-sample-sheet"])("%s leaves input, config and evidence untouched", async command => {
    const w = await workspace();
    try {
      const result = w.run([command, w.input, "--json"]);
      expect(result.status, result.stderr).toBe(0);
      const report = JSON.parse(result.stdout);
      expect(report.valid).toBe(true);
      expect(report.needsChanges).toBe(true);
      expect(report.rowCount).toBe(2);
      expect(await readFile(w.input)).toEqual(w.bytes);
      expect(await readdir(w.root)).toEqual(["sample.csv"]);
      if (command === "preview-sample-sheet") {
        expect(report.changes).toContainEqual({row: 2, column: "Sample_ID", before: "alpha 1", after: "ALPHA_1_001"});
        expect(report.previewSha256).toMatch(/^[a-f0-9]{64}$/);
      }
    } finally { await rm(w.root, {recursive: true, force: true}); }
  });

  it("writes exactly the reviewed output when the preview is accepted, then verifies the run", async () => {
    const w = await workspace();
    try {
      const preview = JSON.parse(w.run(["preview-sample-sheet", w.input, "--json"]).stdout);
      const out = path.join(w.root, "cleaned");
      const accepted = w.run(["tidy", w.input, "--accept-preview", preview.previewSha256, "--out", out]);
      expect(accepted.status, accepted.stderr).toBe(0);
      const bytes = await readFile(path.join(out, "tidy.sample-sheet-v1.clean.csv"));
      expect(bytes.toString()).toBe(preview.cleanedText);
      expect(sha256Hex(bytes)).toBe(preview.outputSha256);
      const runId = accepted.stdout.match(/Run ([\w-]+) -> completed/)?.[1];
      expect(runId).toBeTruthy();
      const verified = w.run(["verify", runId!]);
      expect(verified.status, verified.stderr).toBe(0);
      expect(await readFile(w.input)).toEqual(w.bytes);
    } finally { await rm(w.root, {recursive: true, force: true}); }
  }, 20_000);

  it("rejects changed input before creating a run or exports", async () => {
    const w = await workspace();
    try {
      const preview = JSON.parse(w.run(["preview-sample-sheet", w.input, "--json"]).stdout);
      await writeFile(w.input, 'Sample_ID,Index\nDIFFERENT,ACGT\n');
      const result = w.run(["tidy", w.input, "--accept-preview", preview.previewSha256, "--out", path.join(w.root, "cleaned")]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Preview no longer matches");
      expect(await readdir(w.root)).toEqual(["sample.csv"]);
    } finally { await rm(w.root, {recursive: true, force: true}); }
  });

  it.each(["validate-sample-sheet", "preview-sample-sheet"])("%s reports invalid input as JSON with no writes", async command => {
    const w = await workspace();
    try {
      await writeFile(w.input, 'Sample_ID,Index\nalpha,ACGT,extra\n');
      const result = w.run([command, w.input, "--json"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({valid: false, errors: [expect.stringContaining("Expected at most")]});
      expect(await readdir(w.root)).toEqual(["sample.csv"]);
    } finally { await rm(w.root, {recursive: true, force: true}); }
  });

  it("reports missing files, invalid UTF-8 and oversized files without creating state", async () => {
    const w = await workspace();
    try {
      expect(w.run(["validate-sample-sheet", path.join(w.root, "missing.csv"), "--json"]).status).toBe(1);
      await writeFile(w.input, Buffer.from([0xff]));
      expect(JSON.parse(w.run(["preview-sample-sheet", w.input, "--json"]).stdout).errors[0]).toContain("valid UTF-8");
      await writeFile(w.input, Buffer.alloc(10 * 1024 * 1024 + 1));
      expect(JSON.parse(w.run(["preview-sample-sheet", w.input, "--json"]).stdout).errors[0]).toContain("10 MiB");
      expect(await readdir(w.root)).toEqual(["sample.csv"]);
    } finally { await rm(w.root, {recursive: true, force: true}); }
  });

  it("escapes multiline and terminal control characters in human-readable cell changes", async () => {
    const w = await workspace();
    try {
      await writeFile(w.input, 'Sample_ID,Index,Note\nalpha,ACGT," \u001b[31mfirst\nsecond "\n');
      const result = w.run(["preview-sample-sheet", w.input]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('\\u001b[31mfirst\\nsecond');
      expect(result.stdout).not.toContain('\u001b');
      expect(result.stdout).toContain("--accept-preview");
    } finally { await rm(w.root, {recursive: true, force: true}); }
  });

  it("returns syntax status 2 for write flags, unknown profiles or invalid acceptance hashes", async () => {
    const w = await workspace();
    try {
      for (const args of [
        ["preview-sample-sheet", w.input, "--out", "writes"],
        ["validate-sample-sheet", w.input, "--profile", "remote"],
        ["tidy", w.input, "--accept-preview"],
        ["tidy", w.input, "--accept-preview", "not-a-hash"]
      ]) expect(w.run(args).status).toBe(2);
      expect(await readdir(w.root)).toEqual(["sample.csv"]);
    } finally { await rm(w.root, {recursive: true, force: true}); }
  });

  it("makes capped details explicit in human and JSON previews and retains the complete proposed file", async () => {
    const w = await workspace();
    try {
      const header = ['Sample_ID', 'Index', ...Array.from({length: 254}, (_, i) => `Note${i}`)].join(',');
      const rows = Array.from({length: 5}, (_, i) => [`ROW_${i}`, 'ACGT', ...Array(254).fill(' value ')].join(','));
      await writeFile(w.input, header + '\n' + rows.join('\n') + '\n');
      const human = w.run(['preview-sample-sheet', w.input]);
      expect(human.status, human.stderr).toBe(0);
      expect(human.stdout).toContain('Showing 1000 of 1270 cell changes');
      const json = JSON.parse(w.run(['preview-sample-sheet', w.input, '--json']).stdout);
      expect(json.changesTruncated).toBe(true);
      expect(json.changeCount).toBe(1270);
      expect(json.changes).toHaveLength(1000);
      expect(json.cleanedText.split('\r\n')[5]).toBe(['ROW_4', 'ACGT', ...Array(254).fill('value')].join(','));
      const validation = JSON.parse(w.run(['validate-sample-sheet', w.input, '--json']).stdout);
      expect(validation.changeCount).toBe(1270);
      expect(validation).not.toHaveProperty('changes');
      expect(await readdir(w.root)).toEqual(['sample.csv']);
    } finally { await rm(w.root, {recursive: true, force: true}); }
  });
});
