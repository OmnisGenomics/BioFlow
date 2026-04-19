import { z } from "zod";
import { SchemaSemverSchema, isSchemaMajorCompatible } from "./versioning.js";

export const RUN_MANIFEST_SCHEMA_ID = "bioflow.run-manifest";
export const RUN_MANIFEST_SCHEMA_SEMVER = "1.0.0" as const;
SchemaSemverSchema.parse(RUN_MANIFEST_SCHEMA_SEMVER);

const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);

export const ManifestArtifactSchemaV1 = z.object({
  name: z.string().min(1),
  uri: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  sha256: sha256Hex,
  bytes: z.number().int().nonnegative(),
  mediaType: z.string().optional(),
  kind: z.string().optional(),
  createdAt: z.string().min(1)
});

export const ManifestWorkflowMetaSchemaV1 = z
  .object({
    id: z.string().min(1).optional(),
    version: z.string().min(1).optional(),
    digest: sha256Hex.optional(),
    seed: z.string().min(1).optional()
  })
  .optional();

export const RunManifestSchemaV1 = z.object({
  manifestVersion: z.literal(1),
  runId: z.string().min(1),
  createdAt: z.string().min(1),
  workflow: ManifestWorkflowMetaSchemaV1,
  artifacts: z.record(z.string(), ManifestArtifactSchemaV1),
  inputs: z.array(z.string())
});

export type RunManifestV1 = z.infer<typeof RunManifestSchemaV1>;

export function isRunManifestSchemaVersionCompatible(version: string): boolean {
  return isSchemaMajorCompatible(RUN_MANIFEST_SCHEMA_SEMVER, version);
}
