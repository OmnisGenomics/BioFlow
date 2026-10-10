import { open } from "node:fs/promises";
import { sha256Hex, sha256Json } from "../core/hash.js";
import { MAX_SAMPLE_SHEET_BYTES, reviewSampleSheetText, SampleSheetProfileSchema } from "./sample-sheet.js";

export async function readSampleSheetBytes(filePath: string): Promise<Buffer> {
  const file = await open(filePath, "r");
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error("Sample sheet input must be a regular file");
    if (info.size > MAX_SAMPLE_SHEET_BYTES) throw new Error("Sample sheet exceeds the 10 MiB input limit");
    const chunks: Buffer[] = [];
    for await (const chunk of file.createReadStream({ start: 0, end: MAX_SAMPLE_SHEET_BYTES, autoClose: false })) {
      chunks.push(Buffer.from(chunk));
    }
    const bytes = Buffer.concat(chunks);
    if (bytes.length > MAX_SAMPLE_SHEET_BYTES) throw new Error("Sample sheet exceeds the 10 MiB input limit");
    return bytes;
  } finally { await file.close(); }
}

export function previewSampleSheet(bytes: Uint8Array, profile: unknown) {
  if (bytes.byteLength > MAX_SAMPLE_SHEET_BYTES) throw new Error("Sample sheet exceeds the 10 MiB input limit");
  let text: string;
  try {
    // Retain the BOM for the before/after comparison; cleanup removes it.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error("Sample sheet must be valid UTF-8; convert the input encoding before cleanup");
  }
  const parsedProfile = SampleSheetProfileSchema.parse(profile);
  const result = reviewSampleSheetText(text, parsedProfile);
  const inputSha256 = sha256Hex(bytes);
  const outputSha256 = sha256Hex(new TextEncoder().encode(result.cleaned.cleanedText));
  const preview = {
    schemaVersion: "sample-sheet-preview.v1",
    valid: true as const,
    needsChanges: inputSha256 !== outputSha256,
    inputSha256,
    outputSha256,
    profile: { id: parsedProfile.id, version: parsedProfile.version, sha256: sha256Json(parsedProfile) },
    kind: result.cleaned.kind,
    rowCount: result.cleaned.idMappings.length,
    columns: { before: result.inputColumns, after: result.cleaned.outputColumns },
    changes: result.changes,
    warnings: result.cleaned.warnings,
    // Formatting changes can exist even when no cell values change.
    formatting: { utf8BomRemoved: text.startsWith("\uFEFF"), outputDelimiter: ",", outputRecordNewline: "CRLF" },
    cleanedText: result.cleaned.cleanedText
  };
  return { ...preview, previewSha256: sha256Json(preview) };
}
