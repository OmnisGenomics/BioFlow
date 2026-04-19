import type { AuditEntry } from "./types.js";
import { sha256Json } from "./hash.js";

export function appendAudit(
  auditLog: AuditEntry[],
  entry: Omit<AuditEntry, "at" | "prevHash" | "hash"> & { at?: string }
): AuditEntry {
  const at = entry.at ?? new Date().toISOString();
  const prevHash = auditLog.length ? auditLog[auditLog.length - 1]!.hash : null;
  const toHash = {
    at,
    actor: entry.actor,
    action: entry.action,
    details: entry.details,
    prevHash
  };
  const hash = sha256Json(toHash);
  const full: AuditEntry = { ...toHash, hash };
  auditLog.push(full);
  return full;
}

export function verifyAuditChain(auditLog: AuditEntry[]): { ok: boolean; error?: string } {
  let expectedPrev: string | null = null;
  for (let i = 0; i < auditLog.length; i++) {
    const entry = auditLog[i]!;
    if (entry.prevHash !== expectedPrev) {
      return {
        ok: false,
        error: `Audit prevHash mismatch at index ${i}: expected ${expectedPrev ?? "null"}`
      };
    }
    const recomputed = sha256Json({
      at: entry.at,
      actor: entry.actor,
      action: entry.action,
      details: entry.details,
      prevHash: entry.prevHash
    });
    if (entry.hash !== recomputed) {
      return { ok: false, error: `Audit hash mismatch at index ${i}` };
    }
    expectedPrev = entry.hash;
  }
  return { ok: true };
}

