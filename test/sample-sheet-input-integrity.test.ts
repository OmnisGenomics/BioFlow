import { describe, expect, it } from "vitest";
import { cleanSampleSheetText } from "../src/clean/sample-sheet.js";
import { sampleSheetV1Profile } from "../src/clean/profiles/sample-sheet-v1.js";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { bioflowCommand } from "../scripts/lib/process-command.js";
import { verifyRun } from "../src/core/verify.js";

describe("sample-sheet input integrity", () => {
  it.each([
    ["simple CSV", "Sample_ID,Index\nalpha,ACGT,unmapped metadata\n"],
    ["tab-separated input", "Sample_ID\tIndex\nalpha\tACGT\tunmapped metadata\n"],
    ["Illumina section", "[Header]\nIEMFileVersion,4\n[Data]\nSample_ID,Index\nalpha,ACGT,unmapped metadata\n"]
  ])("rejects extra fields in %s instead of discarding them", (_name, input) => {
    expect(() => cleanSampleSheetText(input, sampleSheetV1Profile))
      .toThrow("Row 1: Expected at most 2 fields, got 3");
  });

  it.each([
    ["simple CSV", "Sample_ID,Index,Note\nalpha,ACGT,valid\nbeta,TGCA,\"unfinished\n"],
    ["Illumina section", "[Data]\nSample_ID,Index,Note\nalpha,ACGT,valid\nbeta,TGCA,\"unfinished\n"]
  ])("rejects an unterminated quote in %s instead of dropping the last row", (_name, input) => {
    expect(() => cleanSampleSheetText(input, sampleSheetV1Profile))
      .toThrow("Unterminated quoted field");
  });

  it("preserves valid quoted delimiters, escaped quotes, and multiline metadata", () => {
    const input = 'Sample_ID,Index,Note\nalpha,ACGT,"first, line\nsecond ""quoted"" line"\n';
    const result = cleanSampleSheetText(input, sampleSheetV1Profile);
    expect(result.cleanedDataCsv).toBe(
      'Sample_ID,Index,Note\r\nALPHA,ACGT,"first, line\nsecond ""quoted"" line"\r\n'
    );
    expect(cleanSampleSheetText(result.cleanedDataCsv, sampleSheetV1Profile).cleanedDataCsv)
      .toBe(result.cleanedDataCsv);
  });

  it("continues to accept omitted trailing optional fields", () => {
    const result = cleanSampleSheetText("Sample_ID,Index,Note\nalpha,ACGT\n", sampleSheetV1Profile);
    expect(result.cleanedDataCsv).toBe("Sample_ID,Index,Note\r\nALPHA,ACGT,\r\n");
  });

  it.each([
    ["extra fields", "Sample_ID,Index\nalpha,ACGT,metadata\n", "Expected at most 2 fields"],
    ["unterminated quote", "Sample_ID,Index,Note\nalpha,ACGT,valid\nbeta,TGCA,\"unfinished\n", "Unterminated quoted field"],
    ["invalid UTF-8", Buffer.concat([Buffer.from("Sample_ID,Index,Note\nalpha,ACGT,"), Buffer.from([0xff]), Buffer.from("\n")]), "must be valid UTF-8"]
  ])("tidy exits unsuccessfully for %s and retains verifiable failure evidence", async (_name, input, error) => {
    const workspace = await mkdtemp(path.resolve(".bioflow_tidy_input_"));
    try {
      const inputPath = path.join(workspace, "input.csv");
      const baseDir = path.join(workspace, "store");
      const outDir = path.join(workspace, "cleaned");
      await writeFile(inputPath, input);
      const result = spawnSync(...bioflowCommand([
        "tidy", inputPath, "--profile", "sample-sheet-v1", "--out", outDir
      ]), { encoding: "utf8", env: { ...process.env, BIOFLOW_BASE_DIR: baseDir } });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("-> failed");
      expect(result.stderr).toContain(error);
      await expect(readdir(outDir)).rejects.toMatchObject({ code: "ENOENT" });
      const [runId] = await readdir(path.join(baseDir, "runs"));
      const record = JSON.parse(await readFile(path.join(baseDir, "runs", runId!, "execution.json"), "utf8"));
      expect(record.execution.status).toBe("failed");
      expect(record.execution.outputs).toEqual([]);
      expect(await verifyRun({ baseDir, runId: runId! })).toMatchObject({ valid: true });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 20_000);
});
