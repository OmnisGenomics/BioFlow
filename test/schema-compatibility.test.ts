import { describe, expect, it } from "vitest";
import { RunManifestSchema } from "../src/core/run-manifest.js";
import { ExecutionRecordSchema } from "../src/core/execution-record.js";
import {
  RUN_MANIFEST_SCHEMA_SEMVER,
  isRunManifestSchemaVersionCompatible
} from "../src/schemas/manifest-v1.js";
import {
  EXECUTION_RECORD_SCHEMA_SEMVER,
  isExecutionRecordSchemaVersionCompatible
} from "../src/schemas/execution-v1.js";
import {
  GXP_REPORT_SCHEMA_SEMVER,
  GxpReportPayloadSchemaV1,
  isGxpReportSchemaVersionCompatible
} from "../src/schemas/report-v1.js";
import {
  assertSchemaMajorCompatible,
  isSchemaMajorCompatible,
  parseSchemaSemver
} from "../src/schemas/versioning.js";

const sha256 = "a".repeat(64);
const sha256b = "b".repeat(64);
const at = "2026-02-01T00:00:00.000Z";
const uri = `sha256:${sha256}`;

describe("schema semver compatibility", () => {
  it("parses strict x.y.z schema versions", () => {
    expect(parseSchemaSemver("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(() => parseSchemaSemver("1.2")).toThrow();
    expect(() => parseSchemaSemver("v1.2.3")).toThrow();
  });

  it("treats matching major versions as compatible", () => {
    expect(isSchemaMajorCompatible("1.0.0", "1.9.9")).toBe(true);
    expect(isSchemaMajorCompatible("1.0.0", "2.0.0")).toBe(false);
    expect(() => assertSchemaMajorCompatible("1.0.0", "2.0.0")).toThrow(
      /Incompatible schema major version/
    );
  });
});

describe("run manifest v1 contract", () => {
  it("parses canonical v1 manifests and rejects non-v1 manifestVersion", () => {
    const manifest = {
      manifestVersion: 1,
      runId: "run-1",
      createdAt: at,
      workflow: {
        id: "wf",
        version: "1.0.0",
        digest: sha256,
        seed: "seed"
      },
      artifacts: {
        "__workflow.json": {
          name: "__workflow.json",
          uri,
          sha256,
          bytes: 10,
          mediaType: "application/json",
          kind: "workflow",
          createdAt: at
        }
      },
      inputs: ["__workflow.json"]
    };
    expect(RunManifestSchema.parse(manifest)).toEqual(manifest);
    expect(() =>
      RunManifestSchema.parse({
        ...manifest,
        manifestVersion: 2
      })
    ).toThrow();
  });

  it("locks schema major compatibility to v1", () => {
    expect(RUN_MANIFEST_SCHEMA_SEMVER).toBe("1.0.0");
    expect(isRunManifestSchemaVersionCompatible("1.4.2")).toBe(true);
    expect(isRunManifestSchemaVersionCompatible("2.0.0")).toBe(false);
  });
});

describe("execution record v1 contract", () => {
  it("parses canonical v1 execution records", () => {
    const artifact = {
      name: "x.txt",
      uri,
      sha256,
      bytes: 1,
      mediaType: "text/plain",
      kind: "input",
      createdAt: at
    };
    const executionRecord = {
      execution: {
        workflowId: "wf",
        workflowVersion: "1.0.0",
        workflowDigest: sha256,
        runId: "run-1",
        status: "completed",
        startedAt: at,
        endedAt: at,
        inputs: [artifact],
        outputs: [artifact],
        auditLog: [
          {
            at,
            actor: "system",
            action: "execution_completed",
            details: { runId: "run-1" },
            prevHash: null,
            hash: sha256b
          }
        ],
        costUSD: 0,
        runtime: {
          nodeVersion: "v20.19.6",
          platform: "linux",
          arch: "x64"
        }
      },
      nodeRuns: [
        {
          nodeId: "score",
          kind: "transform.score",
          status: "ok",
          startedAt: at,
          endedAt: at,
          inputs: [artifact],
          outputs: [artifact],
          costUSD: 0.01,
          notes: "ok"
        }
      ]
    };
    expect(ExecutionRecordSchema.parse(executionRecord)).toEqual(executionRecord);
  });

  it("locks schema major compatibility to v1", () => {
    expect(EXECUTION_RECORD_SCHEMA_SEMVER).toBe("1.0.0");
    expect(isExecutionRecordSchemaVersionCompatible("1.3.0")).toBe(true);
    expect(isExecutionRecordSchemaVersionCompatible("2.0.0")).toBe(false);
  });
});

describe("gxp report payload v1 contract", () => {
  it("parses canonical v1 payloads and rejects version mismatches", () => {
    const payload = {
      reportVersion: "1.0.0",
      runId: "run-1",
      workflow: {
        id: "wf",
        version: "1.0.0",
        digest: sha256
      },
      organization: "local",
      generatedAt: at,
      installation: {
        environment: {
          executionMode: "local",
          deterministicSeed: "seed",
          casAddressing: "sha256-content"
        },
        runtime: {
          nodejs: "v20.19.6",
          platform: "linux",
          arch: "x64"
        },
        checksums: {
          workflowDefinition: sha256,
          workflowDigest: sha256,
          profileId: null,
          profileVersion: null,
          profileDigest: null
        }
      },
      operational: {
        auditIntegrity: true,
        replayIntegrity: true,
        replayErrors: [],
        steps: [
          {
            id: "STEP-001",
            nodeId: "score",
            kind: "transform.score",
            status: "ok",
            startedAt: at,
            endedAt: at,
            inputs: [{ name: "x.txt", sha256, bytes: 1 }],
            outputs: [{ name: "y.txt", sha256: sha256b, bytes: 2 }],
            costUSD: 0.01,
            error: null
          }
        ],
        summary: {
          totalSteps: 1,
          passed: 1,
          failed: 0,
          skipped: 0
        }
      },
      auditTrail: {
        chainHash: sha256b,
        entryCount: 1,
        firstEntryAt: at,
        lastEntryAt: at,
        integrityVerified: true,
        error: null
      },
      artifacts: {
        workflowSnapshot: {
          name: "__workflow.json",
          sha256,
          uri
        },
        inputs: [{ name: "x.txt", sha256, uri, bytes: 1 }],
        outputs: [{ name: "y.txt", sha256: sha256b, uri: `sha256:${sha256b}`, bytes: 2 }]
      }
    };
    expect(GxpReportPayloadSchemaV1.parse(payload)).toEqual(payload);
    expect(() =>
      GxpReportPayloadSchemaV1.parse({
        ...payload,
        reportVersion: "2.0.0"
      })
    ).toThrow();
  });

  it("locks schema major compatibility to v1", () => {
    expect(GXP_REPORT_SCHEMA_SEMVER).toBe("1.0.0");
    expect(isGxpReportSchemaVersionCompatible("1.7.1")).toBe(true);
    expect(isGxpReportSchemaVersionCompatible("2.0.0")).toBe(false);
  });
});
