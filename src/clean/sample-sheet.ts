import { z } from "zod";

export const MAX_SAMPLE_SHEET_BYTES = 10 * 1024 * 1024;
const MAX_COLUMNS = 256;
const MAX_TABLE_ROWS = 100_001; // header plus 100,000 records
const MAX_EXPANDED_LANES = 10_000;

const IupacDnaSchema = z
  .string()
  .min(1)
  .regex(/^[ACGTRYSWKMBDHVN]+$/, "Expected IUPAC DNA codes (ACGTRYSWKMBDHVN)");

export const SampleSheetProfileSchema = z.object({
  id: z.literal("sample-sheet-v1"),
  version: z.string().min(1),
  name: z.string().min(1),
  rules: z.object({
    sampleId: z.object({
      maxLen: z.number().int().positive().default(32)
    }),
    index: z.object({
      allowDual: z.boolean().default(true)
    }),
    lane: z.object({
      allowMissing: z.boolean().default(true)
    })
  })
});

export type SampleSheetProfile = z.infer<typeof SampleSheetProfileSchema>;

export interface SampleIdMappingRow {
  row: number; // 1-based
  original: string;
  normalized: string;
  final: string;
}

export interface CleanSampleSheetResult {
  kind: "illumina" | "simple";
  cleanedText: string;
  cleanedDataCsv: string;
  outputColumns: string[];
  idMappings: SampleIdMappingRow[];
  warnings: string[];
}

export function cleanSampleSheetText(input: string, profile: SampleSheetProfile): CleanSampleSheetResult {
  return processSampleSheetText(input, profile).cleaned;
}

export function reviewSampleSheetText(input: string, profile: SampleSheetProfile, maxChanges = 1_000): {
  cleaned: CleanSampleSheetResult;
  inputColumns: string[];
  changes: Array<{ row: number; column: string; before: string | null; after: string | null }>;
  changeCount: number;
} {
  if (!Number.isSafeInteger(maxChanges) || maxChanges < 0 || maxChanges > 1_000) throw new Error("Detailed change limit must be between 0 and 1,000");
  const { cleaned, parsed, rows } = processSampleSheetText(input, profile);
  const changes: Array<{ row: number; column: string; before: string | null; after: string | null }> = [];
  let changeCount = 0;
  const columns = [...new Set([...parsed.header, ...cleaned.outputColumns])];
  const inputIndexes = new Map(parsed.header.map((column, index) => [column, index]));
  const outputColumns = new Set(cleaned.outputColumns);
  rows.forEach((row, index) => {
    for (const column of columns) {
      const inputIndex = inputIndexes.get(column);
      const before = inputIndex === undefined ? null : parsed.rawDataRows[index]![inputIndex] ?? "";
      const after = outputColumns.has(column) ? row[column] ?? "" : null;
      // Empty added/removed cells are represented by the header change.
      if (before !== after && !(before === null && after === "") && !(before === "" && after === null)) {
        changeCount++;
        if (changes.length < maxChanges) changes.push({ row: index + 1, column, before, after });
      }
    }
  });
  return { cleaned, inputColumns: parsed.rawHeader, changes, changeCount };
}

function processSampleSheetText(input: string, profile: SampleSheetProfile): {
  cleaned: CleanSampleSheetResult;
  parsed: ParsedSampleSheet;
  rows: Record<string, string>[];
} {
  if (Buffer.byteLength(input, "utf8") > MAX_SAMPLE_SHEET_BYTES) {
    throw new Error("Sample sheet exceeds the 10 MiB input limit");
  }
  const normalized = normalizeText(input);
  const parsed = parseSampleSheet(normalized);

  const warnings: string[] = [];
  const { rows, idMappings, hasLane, hasIndex2 } = cleanDataRows(parsed.dataRows, warnings, profile);

  const outputColumns = buildOutputColumns(parsed.header, { hasLane, hasIndex2 });
  const cleanedDataCsv = formatCsv({
    header: outputColumns,
    rows: rows.map((r) => outputColumns.map((c) => r[c] ?? "")),
    delimiter: ","
  });

  const cleanedText =
    parsed.kind === "illumina"
      ? formatIlluminaSampleSheet({
          preludeLines: parsed.preludeLines,
          cleanedDataCsv,
          suffixLines: parsed.suffixLines
        })
      : cleanedDataCsv;

  return { parsed, rows, cleaned: {
    kind: parsed.kind,
    cleanedText,
    cleanedDataCsv,
    outputColumns,
    idMappings,
    warnings
  } };
}

function normalizeText(input: string): string {
  // Strip UTF-8 BOM if present, normalize newlines to LF.
  const text = input.startsWith("\uFEFF") ? input.slice(1) : input;
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

type ParsedSampleSheet =
  | {
      kind: "illumina";
      preludeLines: string[];
      suffixLines: string[];
      header: string[];
      dataRows: Record<string, string>[];
      rawHeader: string[];
      rawDataRows: string[][];
    }
  | {
      kind: "simple";
      header: string[];
      dataRows: Record<string, string>[];
      rawHeader: string[];
      rawDataRows: string[][];
    };

function parseSampleSheet(text: string): ParsedSampleSheet {
  const lines = text.split("\n");
  // A final newline terminates the last line; its split sentinel is not an
  // additional blank suffix line. Keep any preceding intentional blank lines.
  if (lines[lines.length - 1] === "") lines.pop();
  // A section-looking line within a quoted field is metadata, not a boundary.
  const firstLine = lines.find((line) => line.trim().length > 0) ?? "";
  const sectioned = /^\s*\[[^\]]+\]\s*$/.test(firstLine);
  const dataIdx = sectioned ? lines.findIndex((l) => /^\s*\[data\]\s*$/i.test(l)) : -1;
  if (sectioned && dataIdx === -1) throw new Error("SampleSheet is missing a [Data] section");
  if (dataIdx !== -1) {
    const preludeLines = lines.slice(0, dataIdx + 1).filter((l) => l !== undefined);
    const { headerLineIdx, endIdx } = findDataTableBounds(lines, dataIdx + 1);
    const tableLines = lines.slice(headerLineIdx, endIdx);
    if (tableLines.length === 0) throw new Error("SampleSheet [Data] section is missing a header row");

    const delimiter = detectDelimiter(tableLines[0]!);
    const table = parseDelimited(tableLines.join("\n") + "\n", delimiter);
    const records = tableToRecords(table);
    const suffixLines = lines.slice(endIdx).filter((l) => l !== undefined);
    let suffixInQuotes = false;
    for (const line of suffixLines) {
      if (!suffixInQuotes && /^\s*\[data\]\s*$/i.test(line)) {
        throw new Error("SampleSheet contains multiple [Data] sections");
      }
      suffixInQuotes = quoteStateAfter(line, suffixInQuotes);
    }

    return { kind: "illumina", preludeLines, suffixLines, ...records };
  }

  // Simple delimited file with a header row.
  const delimiter = detectDelimiter(lines[0] ?? "");
  const table = parseDelimited(text + (text.endsWith("\n") ? "" : "\n"), delimiter);
  return { kind: "simple", ...tableToRecords(table) };
}

function findDataTableBounds(
  lines: string[],
  startIdx: number
): { headerLineIdx: number; endIdx: number } {
  let headerLineIdx = -1;
  for (let i = startIdx; i < lines.length; i++) {
    const l = lines[i] ?? "";
    if (l.trim().length === 0) continue;
    if (/^\s*\[[^\]]+\]\s*$/.test(l)) {
      throw new Error("SampleSheet [Data] section is missing a header row");
    }
    headerLineIdx = i;
    break;
  }
  if (headerLineIdx === -1) {
    throw new Error("SampleSheet [Data] section is empty");
  }

  let endIdx = lines.length;
  let inQuotes = false;
  inQuotes = quoteStateAfter(lines[headerLineIdx] ?? "", inQuotes);
  for (let i = headerLineIdx + 1; i < lines.length; i++) {
    const l = lines[i] ?? "";
    if (!inQuotes && /^\s*\[[^\]]+\]\s*$/.test(l)) {
      endIdx = i;
      break;
    }
    inQuotes = quoteStateAfter(l, inQuotes);
  }

  return { headerLineIdx, endIdx };
}

function detectDelimiter(line: string): "," | "\t" {
  let commas = 0;
  let tabs = 0;
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') {
      if (inQuotes && line[i + 1] === '"') { i++; continue; }
      inQuotes = !inQuotes;
    } else if (!inQuotes) {
      if (line[i] === ",") commas++;
      if (line[i] === "\t") tabs++;
    }
  }
  return tabs > commas ? "\t" : ",";
}

function quoteStateAfter(line: string, inQuotes: boolean): boolean {
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== '"') continue;
    if (inQuotes && line[i + 1] === '"') { i++; continue; }
    inQuotes = !inQuotes;
  }
  return inQuotes;
}

function parseDelimited(text: string, delimiter: "," | "\t"): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let quoteClosed = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        const next = text[i + 1];
        if (next === '"') {
          field += '"';
          i++;
          continue;
        }
        inQuotes = false;
        quoteClosed = true;
        continue;
      }
      field += ch;
      continue;
    }

    if (ch === '"') {
      if (quoteClosed || field.trim().length > 0) {
        throw new Error(`Record ${rows.length + 1}: Unexpected quote in unquoted field`);
      }
      field = "";
      inQuotes = true;
      continue;
    }

    if (ch === delimiter) {
      row.push(field);
      if (row.length >= MAX_COLUMNS) throw new Error("Sample sheet exceeds the 256 columns limit");
      field = "";
      quoteClosed = false;
      continue;
    }

    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      if (rows.length > MAX_TABLE_ROWS) throw new Error("Sample sheet exceeds the 100,000 records limit");
      row = [];
      field = "";
      quoteClosed = false;
      continue;
    }

    // Ignore stray \r (should be normalized away, but be defensive).
    if (ch === "\r") continue;

    if (quoteClosed) {
      if (ch === " " || ch === "\t") continue;
      throw new Error(`Record ${rows.length + 1}: Unexpected character after closing quote`);
    }

    field += ch;
  }

  if (inQuotes) throw new Error("Unterminated quoted field in sample sheet");

  // Trim trailing empty rows caused by final newline.
  while (rows.length > 0) {
    const last = rows[rows.length - 1]!;
    const allEmpty = last.every((c) => c.length === 0);
    if (allEmpty) rows.pop();
    else break;
  }

  return rows;
}

function tableToRecords(table: string[][]): { header: string[]; dataRows: Record<string, string>[]; rawHeader: string[]; rawDataRows: string[][] } {
  const rawHeader = table[0] ?? [];
  if (rawHeader.length === 0) throw new Error("Missing header row");

  const header = rawHeader.map((h) => canonicalizeColumnName(h));
  const headerSet = new Set(header);
  if (headerSet.size !== header.length) {
    throw new Error(`Duplicate columns after normalization: ${header.join(", ")}`);
  }

  const dataRows: Record<string, string>[] = [];
  const rawDataRows: string[][] = [];
  for (let r = 1; r < table.length; r++) {
    const row = table[r]!;
    const allEmpty = row.every((c) => String(c ?? "").trim().length === 0);
    if (allEmpty) continue;
    if (row.length > header.length) {
      throw new Error(`Row ${r}: Expected at most ${header.length} fields, got ${row.length}`);
    }
    const obj: Record<string, string> = Object.create(null);
    for (let c = 0; c < header.length; c++) {
      const key = header[c]!;
      obj[key] = String(row[c] ?? "").trim();
    }
    dataRows.push(obj);
    rawDataRows.push(row);
  }

  return { header, dataRows, rawHeader, rawDataRows };
}

function canonicalizeColumnName(name: string): string {
  const trimmed = String(name ?? "").trim();
  const key = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (key === "sampleid" || key === "sample_id") return "Sample_ID";
  if (key === "index" || key === "i7index" || key === "i7indexid") return "Index";
  if (key === "index2" || key === "i5index" || key === "i5indexid") return "Index2";
  if (key === "lane" || key === "lanes") return "Lane";
  // Preserve unknown columns with a stable canonical form.
  // Normalize whitespace to underscores but keep the user's tokens.
  const stable = trimmed.replace(/\s+/g, "_");
  return stable.length ? stable : "Column";
}

function cleanDataRows(
  rows: Record<string, string>[],
  warnings: string[],
  profile: SampleSheetProfile
): { rows: Record<string, string>[]; idMappings: SampleIdMappingRow[]; hasLane: boolean; hasIndex2: boolean } {
  if (rows.length === 0) throw new Error("No data rows found");
  const required = ["Sample_ID", "Index"] as const;
  for (const col of required) {
    if (!(col in rows[0]!)) throw new Error(`Missing required column: ${col}`);
  }

  const idMappings: SampleIdMappingRow[] = [];
  const counts = new Map<string, number>();
  const usedIds = new Set<string>();
  let hasLane = false;
  let hasIndex2 = false;

  const cleanedRows = rows.map((row, idx) => {
    const rawSampleId = row["Sample_ID"] ?? "";
    if (rawSampleId.trim().length === 0) throw new Error(`Row ${idx + 1}: Sample_ID is required`);

    const normalizedSampleId = normalizeSampleId(rawSampleId, profile.rules.sampleId.maxLen);
    const base = normalizedSampleId; // prior to dedupe suffix
    let seen = counts.get(base) ?? 0;
    let finalSampleId = seen === 0 ? base : dedupeSampleId(base, seen, profile.rules.sampleId.maxLen);
    // Normalized bases and generated suffixes share the same ID namespace.
    // Reserve every final ID, including candidates produced by truncation.
    while (usedIds.has(finalSampleId)) {
      seen++;
      finalSampleId = dedupeSampleId(base, seen, profile.rules.sampleId.maxLen);
    }
    counts.set(base, seen + 1);
    usedIds.add(finalSampleId);

    idMappings.push({
      row: idx + 1,
      original: rawSampleId,
      normalized: base,
      final: finalSampleId
    });

    const { i7, i5 } = normalizeIndex(row["Index"] ?? "", row["Index2"]);
    if (i5 && !profile.rules.index.allowDual) throw new Error(`Row ${idx + 1}: Dual indexes are not allowed`);
    const declaredDual = row["Index_Dual"]?.trim().toUpperCase();
    if (declaredDual && declaredDual !== (i5 ? `${i7}+${i5}` : "")) {
      throw new Error(`Row ${idx + 1}: Index_Dual does not match Index and Index2`);
    }
    if (i5) hasIndex2 = true;
    const laneRaw = row["Lane"];
    if (laneRaw === undefined && !profile.rules.lane.allowMissing) {
      throw new Error(`Row ${idx + 1}: Lane is required`);
    }
    if (laneRaw !== undefined) {
      hasLane = true;
    }

    const next: Record<string, string> = { ...row };
    next["Sample_ID"] = finalSampleId;
    next["Index"] = i7;
    if (i5) next["Index2"] = i5;
    if (profile.rules.index.allowDual && i5) next["Index_Dual"] = `${i7}+${i5}`;
    if (laneRaw !== undefined) next["Lane"] = normalizeLane(laneRaw, warnings, idx + 1, profile);
    return next;
  });

  return { rows: cleanedRows, idMappings, hasLane, hasIndex2 };
}

function normalizeSampleId(raw: string, maxLen: number): string {
  const trimmed = raw.trim().toUpperCase();
  const replaced = trimmed.replace(/[^A-Z0-9_]+/g, "_");
  const collapsed = replaced.replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  if (collapsed.length === 0) throw new Error("Sample_ID normalizes to empty");
  return collapsed.length > maxLen ? collapsed.slice(0, maxLen) : collapsed;
}

function dedupeSampleId(base: string, duplicateIndex: number, maxLen: number): string {
  const suffix = `_${String(duplicateIndex).padStart(3, "0")}`;
  const prefixMax = maxLen - suffix.length;
  if (prefixMax < 1) {
    throw new Error(`Cannot generate unique Sample_ID within maxLen ${maxLen}: suffix ${suffix} needs a prefix`);
  }
  const prefix = base.length > prefixMax ? base.slice(0, prefixMax) : base;
  return `${prefix}${suffix}`;
}

function normalizeIndex(index: string, index2?: string | undefined): { i7: string; i5?: string | undefined } {
  const raw = String(index ?? "").trim();
  if (raw.length === 0) throw new Error("Index is required");

  let i7 = raw;
  let i5 = index2 ? String(index2).trim() : undefined;

  const split = splitDualIndex(raw);
  if (split) {
    if (i5 && i5.toUpperCase() !== split.i5.toUpperCase()) throw new Error("Combined Index conflicts with Index2");
    i7 = split.i7;
    i5 = split.i5;
  }

  i7 = IupacDnaSchema.parse(i7.toUpperCase());
  if (i5) i5 = IupacDnaSchema.parse(i5.toUpperCase());

  return { i7, i5 };
}

function splitDualIndex(raw: string): { i7: string; i5: string } | null {
  const m = /^\s*([A-Za-z]+)\s*([+-])\s*([A-Za-z]+)\s*$/.exec(raw);
  if (!m) return null;
  return { i7: m[1]!, i5: m[3]! };
}

function normalizeLane(
  raw: string,
  warnings: string[],
  rowNumber: number,
  profile: SampleSheetProfile
): string {
  const trimmed = String(raw ?? "").trim();
  if (trimmed.length === 0) return profile.rules.lane.allowMissing ? "" : fail(`Row ${rowNumber}: Lane is required`);

  const parts = trimmed.split(/[,\s;]+/).map((p) => p.trim()).filter(Boolean);
  const lanes: number[] = [];
  for (const part of parts) {
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(part);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < 1) {
        throw new Error(`Row ${rowNumber}: Invalid lane range: ${part}`);
      }
      const a = Math.min(start, end);
      const b = Math.max(start, end);
      if (b - a + 1 > MAX_EXPANDED_LANES - lanes.length) {
        throw new Error(`Row ${rowNumber}: Lane expansion exceeds 10,000 entries`);
      }
      for (let i = a; i <= b; i++) lanes.push(i);
      continue;
    }
    const single = /^\d+$/.test(part) ? Number(part) : NaN;
    if (!Number.isSafeInteger(single) || single < 1) {
      throw new Error(`Row ${rowNumber}: Invalid lane: ${part}`);
    }
    if (lanes.length >= MAX_EXPANDED_LANES) throw new Error(`Row ${rowNumber}: Lane expansion exceeds 10,000 entries`);
    lanes.push(single);
  }

  const unique = Array.from(new Set(lanes)).sort((a, b) => a - b);
  if (unique.length !== lanes.length) {
    warnings.push(`Row ${rowNumber}: Lane list contained duplicates; normalized`);
  }
  return unique.join(",");
}

function buildOutputColumns(
  inputHeader: string[],
  flags: { hasLane: boolean; hasIndex2: boolean }
): string[] {
  const required = ["Sample_ID", "Index"];
  const optional: string[] = [];
  if (flags.hasIndex2) optional.push("Index2", "Index_Dual");
  if (flags.hasLane) optional.push("Lane");
  const extras = inputHeader.filter(
    (h) => !required.includes(h) && !optional.includes(h) && h !== "Index2" && h !== "Lane" && h !== "Index_Dual"
  );
  // Preserve input order for extras to reduce surprise.
  return [...required, ...optional, ...extras];
}

function formatIlluminaSampleSheet(params: {
  preludeLines: string[];
  cleanedDataCsv: string;
  suffixLines: string[];
}): string {
  const outLines: string[] = [];
  for (const l of params.preludeLines) outLines.push(l);
  // cleanedDataCsv already ends with newline(s); split and re-join as CRLF.
  const dataLines = params.cleanedDataCsv.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (dataLines[dataLines.length - 1] === "") dataLines.pop();
  for (const l of dataLines) {
    outLines.push(l);
  }
  for (const l of params.suffixLines) outLines.push(l);
  return outLines.join("\r\n") + "\r\n";
}

function formatCsv(params: {
  header: string[];
  rows: string[][];
  delimiter: "," | "\t";
}): string {
  const lines: string[] = [];
  lines.push(params.header.map((c) => csvEscape(String(c), params.delimiter)).join(params.delimiter));
  for (const row of params.rows) {
    lines.push(row.map((c) => csvEscape(String(c ?? ""), params.delimiter)).join(params.delimiter));
  }
  return lines.join("\r\n") + "\r\n";
}

function csvEscape(value: string, delimiter: "," | "\t"): string {
  const needsQuotes =
    value.includes('"') ||
    value.includes("\n") ||
    value.includes("\r") ||
    value.includes(delimiter) ||
    /^\s|\s$/.test(value);
  if (!needsQuotes) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

function fail(message: string): never {
  throw new Error(message);
}

