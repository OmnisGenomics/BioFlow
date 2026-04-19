import { z } from "zod";
import { SchemaSemverSchema, isSchemaMajorCompatible } from "./versioning.js";

export const EXECUTION_RECORD_SCHEMA_ID = "bioflow.execution-record";
export const EXECUTION_RECORD_SCHEMA_SEMVER = "1.0.0" as const;
SchemaSemverSchema.parse(EXECUTION_RECORD_SCHEMA_SEMVER);

const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);

export const ExecutionArtifactSchemaV1 = z.object({
  name: z.string().min(1),
  uri: z.string().min(1),
  sha256: sha256Hex,
  bytes: z.number().int().nonnegative(),
  mediaType: z.string().optional(),
  kind: z.string().optional(),
  createdAt: z.string().min(1)
});

export const ExecutionAuditEntrySchemaV1 = z.object({
  at: z.string().min(1),
  actor: z.string().min(1),
  action: z.string().min(1),
  details: z.record(z.string(), z.unknown()),
  prevHash: sha256Hex.nullable(),
  hash: sha256Hex
});

export const ExecutionSchemaV1 = z.object({
  workflowId: z.string().min(1),
  workflowVersion: z.string().min(1),
  workflowDigest: sha256Hex,
  runId: z.string().min(1),
  status: z.enum(["pending", "running", "paused", "completed", "failed"]),
  startedAt: z.string().min(1),
  endedAt: z.string().min(1).optional(),
  inputs: z.array(ExecutionArtifactSchemaV1),
  outputs: z.array(ExecutionArtifactSchemaV1),
  auditLog: z.array(ExecutionAuditEntrySchemaV1),
  costUSD: z.number(),
  runtime: z.object({
    nodeVersion: z.string().min(1),
    platform: z.string().min(1),
    arch: z.string().min(1)
  })
});

export const NodeRunSchemaV1 = z.object({
  nodeId: z.string().min(1),
  kind: z.string().min(1),
  status: z.enum(["ok", "skipped", "failed"]),
  startedAt: z.string().min(1),
  endedAt: z.string().min(1),
  inputs: z.array(ExecutionArtifactSchemaV1),
  outputs: z.array(ExecutionArtifactSchemaV1),
  costUSD: z.number(),
  notes: z.string().optional(),
  error: z.string().optional()
});

export const ExecutionRecordSchemaV1 = z.object({
  execution: ExecutionSchemaV1,
  nodeRuns: z.array(NodeRunSchemaV1)
});

export type ExecutionRecordV1 = z.infer<typeof ExecutionRecordSchemaV1>;

export function isExecutionRecordSchemaVersionCompatible(version: string): boolean {
  return isSchemaMajorCompatible(EXECUTION_RECORD_SCHEMA_SEMVER, version);
}
