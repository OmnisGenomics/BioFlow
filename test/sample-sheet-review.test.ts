import { describe, expect, it } from "vitest";
import { previewSampleSheet, validateSampleSheet } from "../src/clean/review.js";
import { reviewSampleSheetText } from "../src/clean/sample-sheet.js";
import { sampleSheetV1Profile } from "../src/clean/profiles/sample-sheet-v1.js";
import { sha256Hex } from "../src/core/hash.js";
import { spawnSync } from "node:child_process";
import { sourceCommand } from "../scripts/lib/process-command.js";

const preview = (text: string) => previewSampleSheet(Buffer.from(text), sampleSheetV1Profile);

describe("sample-sheet correction review", () => {
  it("shows exact header, normalization, duplicate-ID, derived-index and metadata changes", () => {
    const input = ' Sample Id ,i7 index,Lanes,Project Name\n sample-1 ,acgt+tgca,"3,2,2", project \n sample 1 ,ttaa,1,other\n';
    const result = preview(input);
    expect(result.columns).toEqual({before: [" Sample Id ", "i7 index", "Lanes", "Project Name"], after: ["Sample_ID", "Index", "Index2", "Index_Dual", "Lane", "Project_Name"]});
    expect(result.changes).toEqual(expect.arrayContaining([
      {row: 1, column: "Sample_ID", before: " sample-1 ", after: "SAMPLE_1"},
      {row: 2, column: "Sample_ID", before: " sample 1 ", after: "SAMPLE_1_001"},
      {row: 1, column: "Index", before: "acgt+tgca", after: "ACGT"},
      {row: 1, column: "Index2", before: null, after: "TGCA"},
      {row: 1, column: "Index_Dual", before: null, after: "ACGT+TGCA"},
      {row: 1, column: "Lane", before: "3,2,2", after: "2,3"},
      {row: 1, column: "Project_Name", before: " project ", after: "project"}
    ]));
    expect(result.cleanedText).toBe('Sample_ID,Index,Index2,Index_Dual,Lane,Project_Name\r\nSAMPLE_1,ACGT,TGCA,ACGT+TGCA,"2,3",project\r\nSAMPLE_1_001,TTAA,,,1,other\r\n');
    expect(result.outputSha256).toBe(sha256Hex(result.cleanedText));
    expect(result.inputSha256).toBe(sha256Hex(input));
    expect(result.warnings).toEqual(["Row 1: Lane list contained duplicates; normalized"]);
  });

  it("marks a canonical simple sheet unchanged", () => {
    const result = preview('Sample_ID,Index\r\nALPHA,ACGT\r\n');
    expect(result.needsChanges).toBe(false);
    expect(result.changes).toEqual([]);
    expect(result.inputSha256).toBe(result.outputSha256);
  });

  it("reports formatting-only TSV/BOM/newline changes without inventing cell changes", () => {
    const result = preview('\uFEFFSample_ID\tIndex\nALPHA\tACGT\n');
    expect(result.needsChanges).toBe(true);
    expect(result.changes).toEqual([]);
    expect(result.formatting.utf8BomRemoved).toBe(true);
    expect(result.cleanedText).toBe('Sample_ID,Index\r\nALPHA,ACGT\r\n');
  });

  it("preserves quoted multiline metadata and section-looking text", () => {
    const result = preview('[Header]\nVersion,4\n[Data]\nSample_ID,Index,Note\nalpha,ACGT,"first\n\n[Settings]\nlast"\n[Settings]\nsetting,value\n');
    expect(result.changes).toEqual([{row: 1, column: "Sample_ID", before: "alpha", after: "ALPHA"}]);
    expect(result.cleanedText).toContain('"first\r\n\r\n[Settings]\r\nlast"');
    expect(result.cleanedText).toContain('[Settings]\r\nsetting,value');
  });

  it("gives the same review hash for the same bytes and rules, and different hashes for changed metadata or rules", () => {
    const input = Buffer.from('Sample_ID,Index,Note\nalpha,ACGT,first\n');
    const result = previewSampleSheet(input, sampleSheetV1Profile);
    expect(previewSampleSheet(input, structuredClone(sampleSheetV1Profile)).previewSha256).toBe(result.previewSha256);
    expect(preview('Sample_ID,Index,Note\nalpha,ACGT,second\n').previewSha256).not.toBe(result.previewSha256);
    const profile = structuredClone(sampleSheetV1Profile);
    profile.rules.sampleId.maxLen = 31; // Even rules that leave these rows unchanged must be bound.
    expect(previewSampleSheet(input, profile).previewSha256).not.toBe(result.previewSha256);
  });

  it.each([
    ['Sample_ID,Index\nalpha,ACGT,extra\n', /Expected at most/],
    ['Sample_ID,Index,Note\nalpha,ACGT,"unfinished\n', /Unterminated/],
    ['Sample_ID,Index\nalpha,1234\n', /IUPAC/],
    ['Sample_ID,Index\n,ACGT\n', /Sample_ID is required/]
  ])("rejects invalid input instead of proposing partial output", (input, error) => {
    expect(() => preview(input)).toThrow(error);
  });

  it("rejects invalid UTF-8 and oversized inputs", () => {
    expect(() => previewSampleSheet(Buffer.from([0xff]), sampleSheetV1Profile)).toThrow("valid UTF-8");
    expect(() => previewSampleSheet(Buffer.alloc(10 * 1024 * 1024 + 1), sampleSheetV1Profile)).toThrow("10 MiB");
  });

  it("bounds details on a wide file while counting every change and preserving complete proposed output", () => {
    const header = ["Sample_ID", "Index", ...Array.from({length: 254}, (_, i) => `Note${i}`)].join(',');
    const row = (index: number) => [`ROW_${index}`, "ACGT", ...Array(254).fill(' value ')].join(',');
    const input = header + '\r\n' + Array.from({length: 20}, (_, i) => row(i)).join('\r\n') + '\r\n';
    const summary = reviewSampleSheetText(input, sampleSheetV1Profile, 0);
    expect(summary.changes).toEqual([]);
    expect(summary.changeCount).toBe(20 * 254);
    const validation = validateSampleSheet(Buffer.from(input), sampleSheetV1Profile);
    expect(validation.changeCount).toBe(20 * 254);
    expect(validation).not.toHaveProperty("changes");
    const result = preview(input);
    expect(result.changes).toHaveLength(1_000);
    expect(result.changeCount).toBe(20 * 254);
    expect(result.changesTruncated).toBe(true);
    expect(result.cleanedText.split('\r\n')[20]).toBe(['ROW_19', 'ACGT', ...Array(254).fill('value')].join(','));
    expect(result.outputSha256).toBe(sha256Hex(result.cleanedText));
  });

  it("handles an 8 MB, two-million-change review within a 512 MB Node heap", () => {
    const [command, args] = sourceCommand("test/fixtures/sample-sheet-review-limits.ts");
    const result = spawnSync(command, ["--max-old-space-size=512", ...args], { encoding: "utf8", timeout: 20_000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({rows: 8000, totalCellChanges: 2039999, retainedChanges: 1000});
  }, 25_000);
});
