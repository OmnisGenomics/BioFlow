import { describe, expect, it } from "vitest";
import { appendAudit, verifyAuditChain } from "../src/core/audit.js";
import type { AuditEntry } from "../src/core/types.js";

describe("audit", () => {
  it("chains hashes deterministically", () => {
    const log: AuditEntry[] = [];
    appendAudit(log, { actor: "a", action: "x", details: { n: 1 }, at: "2026-02-04T00:00:00.000Z" });
    appendAudit(log, { actor: "b", action: "y", details: { n: 2 }, at: "2026-02-04T00:00:01.000Z" });
    const res = verifyAuditChain(log);
    expect(res.ok).toBe(true);

    const originalHash0 = log[0]!.hash;
    const originalHash1 = log[1]!.hash;
    expect(originalHash0).toMatch(/^[a-f0-9]{64}$/);
    expect(originalHash1).toMatch(/^[a-f0-9]{64}$/);
    expect(log[1]!.prevHash).toBe(originalHash0);
  });

  it("detects tampering", () => {
    const log: AuditEntry[] = [];
    appendAudit(log, { actor: "a", action: "x", details: { n: 1 }, at: "2026-02-04T00:00:00.000Z" });
    appendAudit(log, { actor: "b", action: "y", details: { n: 2 }, at: "2026-02-04T00:00:01.000Z" });
    log[1]!.details.n = 999;
    const res = verifyAuditChain(log);
    expect(res.ok).toBe(false);
  });
});
