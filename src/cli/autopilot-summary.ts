import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { sha256Json } from "../core/hash.js";

const Sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);
const ChecklistItemSchema = z.object({
  id: z.string().min(1),
  completed: z.boolean()
});
const AutopilotPolicySchema = z.object({
  maxDurationMs: z.number().int().positive(),
  minProgressCompleted: z.number().int().nonnegative(),
  minProgressRatio: z.number().min(0).max(1),
  requirePersistedAuth: z.boolean(),
  requiredChecklistIds: z.array(z.string().min(1))
});
const AutopilotRunStageSchema = z.enum([
  "signup",
  "onboarding_initial",
  "local_run",
  "local_verify",
  "remote_push",
  "remote_verify",
  "share",
  "onboarding_final",
  "policy_enforce"
]);

export const AutopilotSummarySchema = z
  .object({
    schemaVersion: z.literal("self-serve-autopilot.v1"),
    startedAt: z.string().min(1),
    completedAt: z.string().min(1),
    durationMs: z.number().int().nonnegative(),
    remoteUrl: z.string().url(),
    orgId: z.string().uuid(),
    orgSlug: z.string().min(1),
    runId: z.string().uuid(),
    progress: z.object({
      completed: z.number().int().nonnegative(),
      total: z.number().int().positive()
    }),
    nextAction: z.string().min(1).nullable(),
    checklist: z.array(ChecklistItemSchema),
    status: z.literal("completed"),
    configPath: z.string().min(1).nullable(),
    persistedAuth: z.boolean(),
    summarySha256: Sha256HexSchema
  })
  .superRefine((value, ctx) => {
    if (value.progress.completed > value.progress.total) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["progress", "completed"],
        message: "progress.completed must be <= progress.total"
      });
    }
  });

export type AutopilotSummary = z.infer<typeof AutopilotSummarySchema>;
export type AutopilotRunStage = z.infer<typeof AutopilotRunStageSchema>;

export const AutopilotFailureArtifactSchema = z.object({
  schemaVersion: z.literal("self-serve-autopilot-error.v1"),
  startedAt: z.string().min(1),
  failedAt: z.string().min(1),
  remoteUrl: z.string().url(),
  orgSlug: z.string().min(1),
  orgName: z.string().min(1),
  stage: AutopilotRunStageSchema,
  enforcePolicy: z.boolean(),
  policy: AutopilotPolicySchema,
  message: z.string().min(1),
  errorSha256: Sha256HexSchema
});

export type AutopilotFailureArtifact = z.infer<typeof AutopilotFailureArtifactSchema>;

export interface AutopilotSummaryValidation {
  filePath: string;
  summary: AutopilotSummary;
  computedSha256: string;
  digestMatches: boolean;
}

export interface AutopilotFailureValidation {
  filePath: string;
  failure: AutopilotFailureArtifact;
  computedSha256: string;
  digestMatches: boolean;
}

export type AutopilotArtifactValidation =
  | ({
      kind: "summary";
    } & AutopilotSummaryValidation)
  | ({
      kind: "failure";
    } & AutopilotFailureValidation);

export interface AutopilotPolicyOptions {
  maxDurationMs: number;
  minProgressCompleted: number;
  minProgressRatio: number;
  requirePersistedAuth: boolean;
  requiredChecklistIds: string[];
}

export interface AutopilotPolicyResult {
  pass: boolean;
  violations: string[];
  observed: {
    durationMs: number;
    progressCompleted: number;
    progressTotal: number;
    progressRatio: number;
    persistedAuth: boolean;
    missingChecklistIds: string[];
    incompleteChecklistIds: string[];
  };
}

export const DEFAULT_AUTOPILOT_POLICY: AutopilotPolicyOptions = {
  maxDurationMs: 15 * 60 * 1000,
  minProgressCompleted: 4,
  minProgressRatio: 0.8,
  requirePersistedAuth: true,
  requiredChecklistIds: ["org_created", "first_run_created", "first_run_verified", "first_run_shared"]
};

export async function validateAutopilotSummaryFile(filePath: string): Promise<AutopilotSummaryValidation> {
  const validation = await validateAutopilotArtifactFile(filePath);
  if (validation.kind !== "summary") {
    throw new Error(
      `Expected self-serve summary artifact but got ${validation.failure.schemaVersion} at stage ${validation.failure.stage}`
    );
  }
  return validation;
}

export async function validateAutopilotFailureFile(filePath: string): Promise<AutopilotFailureValidation> {
  const validation = await validateAutopilotArtifactFile(filePath);
  if (validation.kind !== "failure") {
    throw new Error(`Expected self-serve failure artifact but got ${validation.summary.schemaVersion}`);
  }
  return validation;
}

export async function validateAutopilotArtifactFile(filePath: string): Promise<AutopilotArtifactValidation> {
  const resolvedPath = path.resolve(filePath);
  const raw = await readFile(resolvedPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid JSON in autopilot summary: ${message}`);
  }

  if (isFailureArtifact(parsed)) {
    const failure = AutopilotFailureArtifactSchema.parse(parsed);
    const computedSha256 = computeAutopilotFailureSha256(failure);
    return {
      kind: "failure",
      filePath: resolvedPath,
      failure,
      computedSha256,
      digestMatches: computedSha256 === failure.errorSha256
    };
  }

  const summary = AutopilotSummarySchema.parse(parsed);
  const computedSha256 = computeAutopilotSummarySha256(summary);
  return {
    kind: "summary",
    filePath: resolvedPath,
    summary,
    computedSha256,
    digestMatches: computedSha256 === summary.summarySha256
  };
}

export function computeAutopilotSummarySha256(summary: AutopilotSummary): string {
  const { summarySha256: _drop, ...withoutDigest } = summary;
  return sha256Json(withoutDigest);
}

export function computeAutopilotFailureSha256(failure: AutopilotFailureArtifact): string {
  const { errorSha256: _drop, ...withoutDigest } = failure;
  return sha256Json(withoutDigest);
}

export function evaluateAutopilotPolicy(
  summary: AutopilotSummary,
  policy: AutopilotPolicyOptions = DEFAULT_AUTOPILOT_POLICY
): AutopilotPolicyResult {
  const violations: string[] = [];
  const progressRatio = summary.progress.completed / summary.progress.total;
  const checklistIndex = new Map(summary.checklist.map((item) => [item.id, item.completed]));
  const missingChecklistIds = policy.requiredChecklistIds.filter((id) => !checklistIndex.has(id));
  const incompleteChecklistIds = policy.requiredChecklistIds.filter((id) => checklistIndex.get(id) === false);

  if (!Number.isFinite(policy.maxDurationMs) || policy.maxDurationMs <= 0) {
    throw new Error("Policy maxDurationMs must be a positive number");
  }
  if (!Number.isFinite(policy.minProgressCompleted) || policy.minProgressCompleted < 0) {
    throw new Error("Policy minProgressCompleted must be >= 0");
  }
  if (!Number.isFinite(policy.minProgressRatio) || policy.minProgressRatio < 0 || policy.minProgressRatio > 1) {
    throw new Error("Policy minProgressRatio must be between 0 and 1");
  }

  if (summary.durationMs > policy.maxDurationMs) {
    violations.push(`durationMs ${String(summary.durationMs)} exceeds maxDurationMs ${String(policy.maxDurationMs)}`);
  }
  if (summary.progress.completed < policy.minProgressCompleted) {
    violations.push(
      `progress.completed ${String(summary.progress.completed)} is below minProgressCompleted ${String(policy.minProgressCompleted)}`
    );
  }
  if (progressRatio < policy.minProgressRatio) {
    violations.push(
      `progress ratio ${progressRatio.toFixed(3)} is below minProgressRatio ${policy.minProgressRatio.toFixed(3)}`
    );
  }
  if (policy.requirePersistedAuth && !summary.persistedAuth) {
    violations.push("persistedAuth is false but requirePersistedAuth=true");
  }
  if (missingChecklistIds.length > 0) {
    violations.push(`missing required checklist ids: ${missingChecklistIds.join(", ")}`);
  }
  if (incompleteChecklistIds.length > 0) {
    violations.push(`incomplete required checklist ids: ${incompleteChecklistIds.join(", ")}`);
  }

  return {
    pass: violations.length === 0,
    violations,
    observed: {
      durationMs: summary.durationMs,
      progressCompleted: summary.progress.completed,
      progressTotal: summary.progress.total,
      progressRatio,
      persistedAuth: summary.persistedAuth,
      missingChecklistIds,
      incompleteChecklistIds
    }
  };
}

function isFailureArtifact(value: unknown): value is { schemaVersion: string } {
  if (!value || typeof value !== "object") return false;
  const schemaVersion = (value as { schemaVersion?: unknown }).schemaVersion;
  return schemaVersion === "self-serve-autopilot-error.v1";
}
