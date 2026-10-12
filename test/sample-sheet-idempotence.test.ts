import { describe, expect, it } from "vitest";
import { cleanSampleSheetText } from "../src/clean/sample-sheet.js";
import { previewSampleSheet, validateSampleSheet } from "../src/clean/review.js";
import { sampleSheetV1Profile } from "../src/clean/profiles/sample-sheet-v1.js";

describe("Illumina cleanup stability", () => {
  it.each(["\n", "\r\n"].flatMap(newline => [0, 1, 2, 3].map(terminators => ({ newline, terminators }))))(
    "does not accumulate trailing blank lines (newline=$newline, terminators=$terminators)", ({ newline, terminators }) => {
      const ending = newline.repeat(terminators);
      const input = '[Header]\nVersion,4\n[Data]\nSample_ID,Index,Note\nalpha,acgt,"first\n\n[Settings]\nlast"\n[Settings]\nKey,Value'
        .replace(/\n/g, newline) + ending;
      const cleaned = cleanSampleSheetText(input, sampleSheetV1Profile).cleanedText;
      const expectedEnding = ending.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n") || "\r\n";
      expect(cleaned.endsWith("Key,Value" + expectedEnding)).toBe(true);
      expect(cleaned).toContain('"first\r\n\r\n[Settings]\r\nlast"');
      let repeated = cleaned;
      for (let i = 0; i < 3; i++) {
        repeated = cleanSampleSheetText(repeated, sampleSheetV1Profile).cleanedText;
        expect(repeated).toBe(cleaned);
      }
      const preview = previewSampleSheet(Buffer.from(cleaned), sampleSheetV1Profile);
      expect(preview.needsChanges).toBe(false);
      expect(preview.inputSha256).toBe(preview.outputSha256);
      expect(preview.changes).toEqual([]);
      expect(previewSampleSheet(Buffer.from(preview.cleanedText), sampleSheetV1Profile).previewSha256)
        .toBe(preview.previewSha256);
      expect(validateSampleSheet(Buffer.from(cleaned), sampleSheetV1Profile).needsChanges).toBe(false);
    }
  );
});
