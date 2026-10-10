import assert from "node:assert/strict";
import { previewSampleSheet, validateSampleSheet } from "../../src/clean/review.js";
import { sampleSheetV1Profile } from "../../src/clean/profiles/sample-sheet-v1.js";

const rows = 8_000;
const header = ["Sample_ID", "Index", ...Array.from({ length: 254 }, (_, i) => `Note${i}`)].join(",");
const row = ["ROW", "ACGT", ...Array(254).fill(" x ")].join(",") + "\n";
const bytes = Buffer.from(header + "\n" + row.repeat(rows));
assert.ok(bytes.length < 10 * 1024 * 1024);
const validation = validateSampleSheet(bytes, sampleSheetV1Profile);
assert.equal(validation.changeCount, rows * 254 + rows - 1);
const preview = previewSampleSheet(bytes, sampleSheetV1Profile);
assert.equal(preview.changeCount, validation.changeCount);
assert.equal(preview.changes.length, 1_000);
assert.equal(preview.changesTruncated, true);
console.log(JSON.stringify({ inputBytes: bytes.length, rows, totalCellChanges: preview.changeCount, retainedChanges: preview.changes.length }));
