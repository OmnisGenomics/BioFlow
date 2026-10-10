import { describe, expect, it } from "vitest";
import { cleanSampleSheetText } from "../src/clean/sample-sheet.js";
import { sampleSheetV1Profile } from "../src/clean/profiles/sample-sheet-v1.js";

function clean(ids: string[], maxLen = 32) {
  return cleanSampleSheetText(
    ["Sample_ID,Index", ...ids.map((id) => `${id},ACGT`)].join("\n"),
    { ...sampleSheetV1Profile, rules: { ...sampleSheetV1Profile.rules, sampleId: { maxLen } } }
  );
}

describe("sample ID allocation", () => {
  it.each([
    [["A", "A", "A_001"], ["A", "A_001", "A_001_001"]],
    [["A", "A_001", "A"], ["A", "A_001", "A_002"]],
    [["a!", "A", "A_001", "A"], ["A", "A_001", "A_001_001", "A_002"]]
  ])("reserves final IDs in row order for %j", (ids, expected) => {
    const result = clean(ids);
    expect(result.idMappings.map((row) => row.final)).toEqual(expected);
    expect(new Set(result.idMappings.map((row) => row.final)).size).toBe(ids.length);
    expect(cleanSampleSheetText(result.cleanedText, sampleSheetV1Profile).cleanedText)
      .toBe(result.cleanedText);
    expect(clean(ids)).toEqual(result);
  });

  it("resolves suffix collisions between different truncated bases", () => {
    const result = clean(["ABCDE", "ABCDE", "ABXYZ", "ABXYZ"], 5);
    expect(result.idMappings.map((row) => row.final)).toEqual(["ABCDE", "A_001", "ABXYZ", "A_002"]);
    expect(result.idMappings.every((row) => row.final.length <= 5)).toBe(true);
  });

  it("keeps the default length limit while deduplicating long IDs", () => {
    const result = clean(["A".repeat(40), "A".repeat(40), "A".repeat(28) + "_001"]);
    expect(result.idMappings.map((row) => row.final)).toEqual([
      "A".repeat(32), "A".repeat(28) + "_001", "A".repeat(28) + "_002"
    ]);
    expect(result.idMappings.every((row) => row.final.length <= 32)).toBe(true);
  });

  it("supports suffixes beyond 999 without collisions", () => {
    const result = clean(Array.from({ length: 1002 }, () => "A"), 6);
    const ids = result.idMappings.map((row) => row.final);
    expect(ids[1000]).toBe("A_1000");
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.length <= 6)).toBe(true);
  });

  it("fails clearly when a suffix cannot fit rather than exceeding maxLen", () => {
    expect(clean(["A", "B"], 1).idMappings.map((row) => row.final)).toEqual(["A", "B"]);
    expect(() => clean(["A", "A"], 4)).toThrow(/unique Sample_ID.*maxLen/);
    expect(() => clean(Array.from({ length: 1001 }, () => "A"), 5))
      .toThrow(/unique Sample_ID.*maxLen/);
  });
});
