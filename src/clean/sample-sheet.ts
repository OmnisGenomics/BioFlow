import { z } from "zod";

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

  return {
    kind: parsed.kind,
    cleanedText,
    cleanedDataCsv,
    outputColumns,
    idMappings,
    warnings
  };
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
    }
  | {
      kind: "simple";
      header: string[];
      dataRows: Record<string, string>[];
    };

function parseSampleSheet(text: string): ParsedSampleSheet {
  const lines = text.split("\n").map((l) => l.replace(/\s+$/, "")); // trim trailing whitespace
  const dataIdx = lines.findIndex((l) => /^\s*\[data\]\s*$/i.test(l));
  if (dataIdx !== -1) {
    const preludeLines = lines.slice(0, dataIdx + 1).filter((l) => l !== undefined);
    const { headerLineIdx, endIdx } = findDataTableBounds(lines, dataIdx + 1);
    const tableLines = lines.slice(headerLineIdx, endIdx).filter((l) => l.trim().length > 0);
    if (tableLines.length === 0) throw new Error("SampleSheet [Data] section is missing a header row");

    const delimiter = detectDelimiter(tableLines[0]!);
    const table = parseDelimited(tableLines.join("\n") + "\n", delimiter);
    const { header, dataRows } = tableToRecords(table);
    const suffixLines = lines.slice(endIdx).filter((l) => l !== undefined);

    return { kind: "illumina", preludeLines, suffixLines, header, dataRows };
  }

  // Simple delimited file with a header row.
  const delimiter = detectDelimiter(lines[0] ?? "");
  const table = parseDelimited(text + (text.endsWith("\n") ? "" : "\n"), delimiter);
  const { header, dataRows } = tableToRecords(table);
  return { kind: "simple", header, dataRows };
}

function findDataTableBounds(
  lines: string[],
  startIdx: number
): { headerLineIdx: number; endIdx: number } {
  let headerLineIdx = -1;
  for (let i = startIdx; i < lines.length; i++) {
    const l = lines[i] ?? "";
    if (l.trim().length === 0) continue;
    if (/^\s*\[[^\]]+\]\s*$/.test(l)) continue;
    headerLineIdx = i;
    break;
  }
  if (headerLineIdx === -1) {
    throw new Error("SampleSheet [Data] section is empty");
  }

  let endIdx = lines.length;
  for (let i = headerLineIdx + 1; i < lines.length; i++) {
    const l = lines[i] ?? "";
    if (/^\s*\[[^\]]+\]\s*$/.test(l)) {
      endIdx = i;
      break;
    }
  }

  return { headerLineIdx, endIdx };
}

function detectDelimiter(line: string): "," | "\t" {
  const commas = (line.match(/,/g) ?? []).length;
  const tabs = (line.match(/\t/g) ?? []).length;
  return tabs > commas ? "\t" : ",";
}

function parseDelimited(text: string, delimiter: "," | "\t"): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

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
        continue;
      }
      field += ch;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }

    if (ch === delimiter) {
      row.push(field);
      field = "";
      continue;
    }

    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }

    // Ignore stray \r (should be normalized away, but be defensive).
    if (ch === "\r") continue;

    field += ch;
  }

  // Trim trailing empty rows caused by final newline.
  while (rows.length > 0) {
    const last = rows[rows.length - 1]!;
    const allEmpty = last.every((c) => c.length === 0);
    if (allEmpty) rows.pop();
    else break;
  }

  return rows;
}

function tableToRecords(table: string[][]): { header: string[]; dataRows: Record<string, string>[] } {
  const rawHeader = table[0] ?? [];
  if (rawHeader.length === 0) throw new Error("Missing header row");

  const header = rawHeader.map((h) => canonicalizeColumnName(h));
  const headerSet = new Set(header);
  if (headerSet.size !== header.length) {
    throw new Error(`Duplicate columns after normalization: ${header.join(", ")}`);
  }

  const dataRows: Record<string, string>[] = [];
  for (let r = 1; r < table.length; r++) {
    const row = table[r]!;
    const allEmpty = row.every((c) => String(c ?? "").trim().length === 0);
    if (allEmpty) continue;
    const obj: Record<string, string> = {};
    for (let c = 0; c < header.length; c++) {
      const key = header[c]!;
      obj[key] = String(row[c] ?? "").trim();
    }
    dataRows.push(obj);
  }

  return { header, dataRows };
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
  let hasLane = false;
  let hasIndex2 = false;

  const cleanedRows = rows.map((row, idx) => {
    const rawSampleId = row["Sample_ID"] ?? "";
    if (rawSampleId.trim().length === 0) throw new Error(`Row ${idx + 1}: Sample_ID is required`);

    const normalizedSampleId = normalizeSampleId(rawSampleId, profile.rules.sampleId.maxLen);
    const base = normalizedSampleId; // prior to dedupe suffix
    const seen = counts.get(base) ?? 0;
    const finalSampleId =
      seen === 0 ? base : dedupeSampleId(base, seen, profile.rules.sampleId.maxLen);
    counts.set(base, seen + 1);

    idMappings.push({
      row: idx + 1,
      original: rawSampleId,
      normalized: base,
      final: finalSampleId
    });

    const { i7, i5 } = normalizeIndex(row["Index"] ?? "", row["Index2"]);
    if (i5) hasIndex2 = true;
    const laneRaw = row["Lane"];
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
  const prefixMax = Math.max(1, maxLen - suffix.length);
  const prefix = base.length > prefixMax ? base.slice(0, prefixMax) : base;
  return `${prefix}${suffix}`;
}

function normalizeIndex(index: string, index2?: string | undefined): { i7: string; i5?: string | undefined } {
  const raw = String(index ?? "").trim();
  if (raw.length === 0) throw new Error("Index is required");

  let i7 = raw;
  let i5 = index2 ? String(index2).trim() : undefined;

  if (!i5) {
    const split = splitDualIndex(raw);
    if (split) {
      i7 = split.i7;
      i5 = split.i5;
    }
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
      if (!Number.isInteger(start) || !Number.isInteger(end)) {
        throw new Error(`Row ${rowNumber}: Invalid lane range: ${part}`);
      }
      const a = Math.min(start, end);
      const b = Math.max(start, end);
      for (let i = a; i <= b; i++) lanes.push(i);
      continue;
    }
    const single = /^\d+$/.test(part) ? Number(part) : NaN;
    if (!Number.isInteger(single)) {
      throw new Error(`Row ${rowNumber}: Invalid lane: ${part}`);
    }
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
  for (const l of dataLines) {
    if (l.length === 0) continue;
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

