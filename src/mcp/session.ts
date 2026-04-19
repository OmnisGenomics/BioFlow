import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { z } from "zod";
import { resolveRemoteDefaults } from "../cli/config.js";
import { appendAudit, verifyAuditChain } from "../core/audit.js";
import type { AuditEntry } from "../core/types.js";

export const MCP_SESSION_RESOURCE_URI = "bioflow://resource/mcp/session";
const SESSION_AUDIT_PATH = path.join(".bioflow", "mcp", "session-audit.json");

const SessionAuditEntrySchema = z.object({
  at: z.string().min(1),
  actor: z.string().min(1),
  action: z.string().min(1),
  details: z.record(z.string(), z.unknown()),
  prevHash: z.string().nullable(),
  hash: z.string().min(1)
});

const SessionAuthModeSchema = z.enum(["api-key", "jwt", "dev-header", "token", "unbound"]);

const StoredSessionStateSchema = z.object({
  version: z.literal(1),
  sessionId: z.string().min(1),
  repoRoot: z.string().min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  defaultAuth: z.object({
    remoteUrl: z.string().min(1),
    orgId: z.string().min(1).nullish(),
    tokenPresent: z.boolean(),
    authMode: SessionAuthModeSchema,
    principal: z.string().min(1)
  }),
  auditLog: z.array(SessionAuditEntrySchema)
});

export type McpAuthMode = z.infer<typeof SessionAuthModeSchema>;

export interface McpSessionOverrides {
  remoteUrl?: string | undefined;
  token?: string | undefined;
  orgId?: string | undefined;
}

export interface McpInvocationContext {
  remoteUrl: string;
  token?: string | undefined;
  orgId?: string | undefined;
  authMode: McpAuthMode;
  principal: string;
}

export interface McpSessionSnapshot {
  version: 1;
  sessionId: string;
  repoRoot: string;
  createdAt: string;
  updatedAt: string;
  defaultAuth: {
    remoteUrl: string;
    orgId: string | null;
    tokenPresent: boolean;
    authMode: McpAuthMode;
    principal: string;
  };
  auditLog: AuditEntry[];
}

export class McpSession {
  private constructor(
    private readonly statePath: string,
    private snapshot: McpSessionSnapshot,
    private currentAuth: McpInvocationContext
  ) {}

  static async create(repoRoot: string): Promise<McpSession> {
    const defaults = resolveRemoteDefaults();
    const statePath = path.join(repoRoot, SESSION_AUDIT_PATH);
    const snapshot = await loadSnapshot(repoRoot, statePath);
    const currentAuth = buildInvocationContext(defaults.url, defaults.token, defaults.orgId);
    const session = new McpSession(statePath, snapshot, currentAuth);
    await session.recordAction(
      "session.started",
      {
        processId: process.pid,
        nodeVersion: process.version
      },
      "system"
    );
    return session;
  }

  get principal(): string {
    return this.currentAuth.principal;
  }

  get defaultAuth(): McpInvocationContext {
    return this.currentAuth;
  }

  get auditPath(): string {
    return this.statePath;
  }

  get snapshotView(): McpSessionSnapshot {
    return {
      ...this.snapshot,
      defaultAuth: {
        ...this.snapshot.defaultAuth
      },
      auditLog: this.snapshot.auditLog.map((entry) => ({ ...entry }))
    };
  }

  resolveInvocation(overrides: McpSessionOverrides = {}): McpInvocationContext {
    return buildInvocationContext(
      overrides.remoteUrl ?? this.currentAuth.remoteUrl,
      overrides.token ?? this.currentAuth.token,
      overrides.orgId ?? this.currentAuth.orgId
    );
  }

  async rebind(overrides: McpSessionOverrides): Promise<void> {
    const next = this.resolveInvocation(overrides);
    if (sameInvocation(this.currentAuth, next)) return;

    const previous = this.currentAuth;
    this.currentAuth = next;
    this.snapshot.defaultAuth = summarizeInvocation(next);
    await this.recordAction(
      "session.bound",
      {
        previous: summarizeInvocation(previous),
        next: summarizeInvocation(next),
        overrides: {
          remoteUrl: overrides.remoteUrl ?? null,
          tokenPresent: overrides.token !== undefined,
          orgId: overrides.orgId ?? null
        }
      },
      "system",
      next
    );
  }

  async recordAction(
    action: string,
    details: Record<string, unknown>,
    actor = this.currentAuth.principal,
    invocation: McpInvocationContext = this.currentAuth
  ): Promise<void> {
    appendAudit(this.snapshot.auditLog, {
      actor,
      action,
      details: {
        sessionId: this.snapshot.sessionId,
        repoRoot: this.snapshot.repoRoot,
        remoteUrl: invocation.remoteUrl,
        orgId: invocation.orgId ?? null,
        authMode: invocation.authMode,
        principal: invocation.principal,
        tokenPresent: Boolean(invocation.token),
        ...details
      }
    });

    this.snapshot.updatedAt = new Date().toISOString();
    this.snapshot.defaultAuth = summarizeInvocation(this.currentAuth);
    await writeSnapshot(this.statePath, this.snapshot);
  }
}

function buildInvocationContext(
  remoteUrl: string,
  token?: string | undefined,
  orgId?: string | undefined
): McpInvocationContext {
  const normalizedOrgId = orgId?.trim().length ? orgId.trim().toLowerCase() : undefined;
  const authMode = classifyAuthMode(token, normalizedOrgId);
  return {
    remoteUrl,
    token,
    orgId: normalizedOrgId,
    authMode,
    principal: buildPrincipal(normalizedOrgId, authMode)
  };
}

function summarizeInvocation(invocation: McpInvocationContext): McpSessionSnapshot["defaultAuth"] {
  return {
    remoteUrl: invocation.remoteUrl,
    orgId: invocation.orgId ?? null,
    tokenPresent: Boolean(invocation.token),
    authMode: invocation.authMode,
    principal: invocation.principal
  };
}

function buildPrincipal(orgId: string | undefined, authMode: McpAuthMode): string {
  return `mcp:${orgId ?? "unbound"}:${authMode}`;
}

function classifyAuthMode(token: string | undefined, orgId: string | undefined): McpAuthMode {
  if (token) {
    if (token.startsWith("bf_live_") || token.startsWith("bf_test_")) return "api-key";
    if (token.split(".").length === 3) return "jwt";
    return "token";
  }

  if (orgId) {
    return "dev-header";
  }

  return "unbound";
}

function sameInvocation(left: McpInvocationContext, right: McpInvocationContext): boolean {
  return (
    left.remoteUrl === right.remoteUrl &&
    left.token === right.token &&
    left.orgId === right.orgId &&
    left.authMode === right.authMode &&
    left.principal === right.principal
  );
}

async function loadSnapshot(repoRoot: string, statePath: string): Promise<McpSessionSnapshot> {
  try {
    const raw = await readFile(statePath, "utf8");
    const parsed = StoredSessionStateSchema.parse(JSON.parse(raw));
    const auditCheck = verifyAuditChain(parsed.auditLog as AuditEntry[]);
    if (!auditCheck.ok) {
      throw new Error(auditCheck.error ?? "Invalid MCP session audit chain");
    }
    if (path.resolve(parsed.repoRoot) !== path.resolve(repoRoot)) {
      throw new Error(`MCP session audit file belongs to a different repository: ${parsed.repoRoot}`);
    }
    return {
      version: 1,
      sessionId: parsed.sessionId,
      repoRoot: parsed.repoRoot,
      createdAt: parsed.createdAt,
      updatedAt: parsed.updatedAt,
      defaultAuth: {
        remoteUrl: parsed.defaultAuth.remoteUrl,
        orgId: parsed.defaultAuth.orgId ?? null,
        tokenPresent: parsed.defaultAuth.tokenPresent,
        authMode: parsed.defaultAuth.authMode,
        principal: parsed.defaultAuth.principal
      },
      auditLog: parsed.auditLog.map((entry) => ({ ...entry }))
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as { code?: unknown }).code === "ENOENT") {
      const now = new Date().toISOString();
      const defaults = resolveRemoteDefaults();
      const current = buildInvocationContext(defaults.url, defaults.token, defaults.orgId);
      return {
        version: 1,
        sessionId: randomUUID(),
        repoRoot,
        createdAt: now,
        updatedAt: now,
        defaultAuth: summarizeInvocation(current),
        auditLog: []
      };
    }

    throw error;
  }
}

async function writeSnapshot(statePath: string, snapshot: McpSessionSnapshot): Promise<void> {
  await mkdir(path.dirname(statePath), { recursive: true });
  const serialized = JSON.stringify(snapshot, null, 2) + "\n";
  const tmpPath = `${statePath}.tmp`;
  await writeFile(tmpPath, serialized, "utf8");
  await rename(tmpPath, statePath);
}
