import { z } from "zod";
import { SchemaSemverSchema, isSchemaMajorCompatible } from "./versioning.js";

export const GXP_REPORT_SCHEMA_ID = "bioflow.gxp-report";
export const GXP_REPORT_SCHEMA_SEMVER = "1.0.0" as const;
SchemaSemverSchema.parse(GXP_REPORT_SCHEMA_SEMVER);

const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);
const sha256Uri = z.string().regex(/^sha256:[a-f0-9]{64}$/);

const ReportNodeArtifactSchemaV1 = z.object({
  name: z.string().min(1),
  sha256: sha256Hex,
  bytes: z.number().int().nonnegative()
});

const ReportManifestArtifactSchemaV1 = z.object({
  name: z.string().min(1),
  sha256: sha256Hex,
  uri: sha256Uri,
  bytes: z.number().int().nonnegative()
});

const ReportWorkflowSnapshotSchemaV1 = z.object({
  name: z.string().min(1),
  sha256: sha256Hex,
  uri: sha256Uri
});

export const GxpReportPayloadSchemaV1 = z.object({
  reportVersion: z.literal(GXP_REPORT_SCHEMA_SEMVER),
  runId: z.string().min(1),
  workflow: z.object({
    id: z.string().min(1),
    version: z.string().min(1),
    digest: sha256Hex
  }),
  organization: z.string().min(1),
  generatedAt: z.string().min(1),
  installation: z.object({
    environment: z.object({
      executionMode: z.enum(["service", "local"]),
      deterministicSeed: z.string().min(1).nullable(),
      casAddressing: z.literal("sha256-content")
    }),
    runtime: z.object({
      nodejs: z.string().min(1),
      platform: z.string().min(1),
      arch: z.string().min(1)
    }),
    checksums: z.object({
      workflowDefinition: sha256Hex,
      workflowDigest: sha256Hex,
      profileId: z.string().min(1).nullable(),
      profileVersion: z.string().min(1).nullable(),
      profileDigest: sha256Hex.nullable()
    })
  }),
  operational: z.object({
    auditIntegrity: z.boolean(),
    replayIntegrity: z.boolean(),
    replayErrors: z.array(z.string()),
    steps: z.array(
      z.object({
        id: z.string().min(1),
        nodeId: z.string().min(1),
        kind: z.string().min(1),
        status: z.enum(["ok", "skipped", "failed"]),
        startedAt: z.string().min(1),
        endedAt: z.string().min(1),
        inputs: z.array(ReportNodeArtifactSchemaV1),
        outputs: z.array(ReportNodeArtifactSchemaV1),
        costUSD: z.number(),
        error: z.string().nullable()
      })
    ),
    summary: z.object({
      totalSteps: z.number().int().nonnegative(),
      passed: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      skipped: z.number().int().nonnegative()
    })
  }),
  auditTrail: z.object({
    chainHash: sha256Hex.nullable(),
    entryCount: z.number().int().nonnegative(),
    firstEntryAt: z.string().min(1).nullable(),
    lastEntryAt: z.string().min(1).nullable(),
    integrityVerified: z.boolean(),
    error: z.string().nullable()
  }),
  artifacts: z.object({
    workflowSnapshot: ReportWorkflowSnapshotSchemaV1,
    inputs: z.array(ReportManifestArtifactSchemaV1),
    outputs: z.array(ReportManifestArtifactSchemaV1)
  })
});

export type GxpReportPayloadV1 = z.infer<typeof GxpReportPayloadSchemaV1>;

export function isGxpReportSchemaVersionCompatible(version: string): boolean {
  return isSchemaMajorCompatible(GXP_REPORT_SCHEMA_SEMVER, version);
}
