import { describe, expect, it } from "vitest";
import { cleanSampleSheetText } from "../src/clean/sample-sheet.js";
import { sampleSheetV1Profile } from "../src/clean/profiles/sample-sheet-v1.js";

const clean = (input: string) => cleanSampleSheetText(input, sampleSheetV1Profile);

describe("local sample-sheet production hardening", () => {
  it.each([
    ['alpha,ACGT,unquoted"quote"', "Unexpected quote"],
    ['alpha,ACGT,"quoted"junk', "Unexpected character after closing quote"]
  ])("rejects invalid CSV quoting: %s", (row, message) => {
    expect(() => clean(`Sample_ID,Index,Note\n${row}\n`)).toThrow(message);
  });

  it("preserves blank lines and section-looking lines inside quoted Illumina metadata", () => {
    const input = '[Header]\nIEMFileVersion,4\n[Data]\nSample_ID,Index,Note\nalpha,ACGT,"first\n\n[Settings]\nlast"\n[Settings]\nsetting,value\n';
    const result = clean(input);
    expect(result.cleanedDataCsv).toContain('"first\n\n[Settings]\nlast"');
    expect(result.cleanedText).toContain('"first\r\n\r\n[Settings]\r\nlast"');
    expect(result.cleanedText).toContain('[Settings]\r\nsetting,value');
    expect(clean(result.cleanedText).cleanedDataCsv).toBe(result.cleanedDataCsv);
  });

  it("does not interpret a section-looking line in simple CSV metadata as an Illumina marker", () => {
    expect(clean('Sample_ID,Index,Note\nalpha,ACGT,"first\n[Data]\nlast"\n').kind).toBe("simple");
  });

  it("rejects a section boundary before the Illumina data header", () => {
    expect(() => clean('[Data]\n[Settings]\nSample_ID,Index\nalpha,ACGT\n')).toThrow("missing a header");
  });

  it("detects delimiters without counting commas inside quoted TSV headers", () => {
    expect(clean('Sample_ID\tIndex\t"Note, with, commas, here"\nalpha\tACGT\tmetadata\n').idMappings).toHaveLength(1);
  });

  it("preserves columns named __proto__ as ordinary metadata", () => {
    expect(clean('Sample_ID,Index,__proto__\nalpha,ACGT,metadata\n').cleanedDataCsv).toContain('ALPHA,ACGT,metadata');
  });

  it.each(["0", "9007199254740992", "1-10001", "1-9007199254740992"])("rejects invalid or unbounded lane expansion: %s", lane => {
    expect(() => clean(`Sample_ID,Index,Lane\nalpha,ACGT,${lane}\n`)).toThrow(/Invalid lane|Lane expansion/);
  });

  it("enforces allowMissing when the entire Lane column is absent", () => {
    const profile = structuredClone(sampleSheetV1Profile);
    profile.rules.lane.allowMissing = false;
    expect(() => cleanSampleSheetText('Sample_ID,Index\nalpha,ACGT\n', profile)).toThrow("Lane is required");
  });

  it("enforces allowDual for a supplied dual index", () => {
    const profile = structuredClone(sampleSheetV1Profile);
    profile.rules.index.allowDual = false;
    expect(() => cleanSampleSheetText('Sample_ID,Index\nalpha,ACGT+TGCA\n', profile)).toThrow("Dual indexes are not allowed");
  });

  it("accepts matching combined and separate dual indexes and rejects conflicts", () => {
    expect(clean('Sample_ID,Index,Index2\nalpha,acgt+tgca,TGCA\n').cleanedDataCsv).toContain('ALPHA,ACGT,TGCA,ACGT+TGCA');
    expect(() => clean('Sample_ID,Index,Index2\nalpha,ACGT+TGCA,TTAA\n')).toThrow("conflicts with Index2");
  });

  it("does not silently discard conflicting derived Index_Dual metadata", () => {
    expect(() => clean('Sample_ID,Index,Index_Dual\nalpha,ACGT,ACGT+TGCA\n')).toThrow("Index_Dual does not match");
  });

  it("rejects oversized input before parsing", () => {
    expect(() => clean('x'.repeat(10 * 1024 * 1024 + 1))).toThrow("10 MiB");
  });

  it("rejects too many columns", () => {
    expect(() => clean(Array.from({length: 257}, (_, i) => `Column${i}`).join(',') + '\n')).toThrow("256 columns");
  });

  it("rejects excessive record counts", () => {
    expect(() => clean('Sample_ID,Index\n' + 'alpha,ACGT\n'.repeat(100_001))).toThrow("100,000 records");
  });

  it("rejects multiple actual Data sections instead of leaving an uncleaned table in the output", () => {
    expect(() => clean('[Data]\nSample_ID,Index\nalpha,ACGT\n[Data]\nSample_ID,Index\nbeta,TGCA\n')).toThrow("multiple [Data] sections");
  });
});
