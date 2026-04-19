import type { SampleSheetProfile } from "../sample-sheet.js";

export const sampleSheetV1Profile: SampleSheetProfile = {
  id: "sample-sheet-v1",
  version: "1.0.0",
  name: "Standard Sample Sheet",
  rules: {
    sampleId: { maxLen: 32 },
    index: { allowDual: true },
    lane: { allowMissing: true }
  }
};

