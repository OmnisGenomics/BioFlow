import { readFile } from "node:fs/promises";
import { TextDecoder } from "node:util";
import type { Connector, ConnectorContext, ConnectorResult } from "./connector.js";
import { LocalCAS } from "../cas.js";
import { stableStringify } from "../stable-json.js";
import {
  cleanSampleSheetText,
  SampleSheetProfileSchema,
  type SampleSheetProfile
} from "../../clean/sample-sheet.js";
import { sampleSheetV1Profile } from "../../clean/profiles/sample-sheet-v1.js";

type CleanOperation = "sample-sheet-v1";

export class CleanCsvConnector implements Connector {
  public readonly id = "clean_csv";

  async invoke(ctx: ConnectorContext): Promise<ConnectorResult> {
    const op = ctx.operation as CleanOperation;
    if (op !== "sample-sheet-v1") {
      throw new Error(`clean_csv: unsupported operation: ${ctx.operation}`);
    }

    if (ctx.inputs.length !== 1) {
      throw new Error(`clean_csv:${op} expects exactly 1 input artifact; got ${ctx.inputs.length}`);
    }
    const input = ctx.inputs[0]!;
    const cas = new LocalCAS(ctx.store.baseDir());
    const inputBytes = await readFile(cas.objectPath(input.sha256));
    const text = new TextDecoder("utf-8", { fatal: false }).decode(inputBytes);

    const profile = parseProfile(ctx.params.profile);
    const res = cleanSampleSheetText(text, profile);

    const prefix = `${ctx.nodeId}.sample-sheet-v1`;

    const cleaned = await ctx.store.putBytes({
      runId: ctx.runId,
      name: `${prefix}.clean.csv`,
      bytes: new TextEncoder().encode(res.cleanedText),
      mediaType: "text/csv",
      kind: "tidy"
    });

    const dataOnly = await ctx.store.putBytes({
      runId: ctx.runId,
      name: `${prefix}.data.csv`,
      bytes: new TextEncoder().encode(res.cleanedDataCsv),
      mediaType: "text/csv",
      kind: "tidy_data"
    });

    const idMap = await putStableJson(ctx, {
      name: `${prefix}.idmap.json`,
      value: {
        profile: { id: profile.id, version: profile.version },
        input: { sha256: input.sha256 },
        mappings: res.idMappings
      },
      kind: "idmap"
    });

    const report = await putStableJson(ctx, {
      name: `${prefix}.report.json`,
      value: {
        profile: { id: profile.id, version: profile.version },
        kind: res.kind,
        rowCount: res.idMappings.length,
        outputColumns: res.outputColumns,
        warnings: res.warnings
      },
      kind: "report"
    });

    return { outputs: [cleaned, dataOnly, idMap, report], costUSD: 0.0 };
  }
}

function parseProfile(value: unknown): SampleSheetProfile {
  if (value === undefined) return SampleSheetProfileSchema.parse(sampleSheetV1Profile);
  return SampleSheetProfileSchema.parse(value);
}

async function putStableJson(
  ctx: ConnectorContext,
  params: { name: string; value: unknown; kind: string }
) {
  const json = stableStringify(params.value) + "\n";
  return ctx.store.putBytes({
    runId: ctx.runId,
    name: params.name,
    bytes: new TextEncoder().encode(json),
    mediaType: "application/json",
    kind: params.kind
  });
}
