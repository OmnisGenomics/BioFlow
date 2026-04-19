import { describe, expect, it } from "vitest";
import type { Connector, ConnectorContext, ConnectorResult } from "../src/core/connectors/connector.js";
import { withResilience } from "../src/core/connectors/middleware/resilience.js";
import { InMemoryIdempotencyStore } from "../src/core/connectors/middleware/idempotency.js";
import { ValidationError } from "../src/core/errors.js";
import { HashOnlyArtifactStore } from "../src/core/hash-only-store.js";
import { createDeterministicRng } from "../src/core/rng.js";

function makeCtx(overrides: Partial<ConnectorContext> = {}): ConnectorContext {
  return {
    runId: "run-1",
    nodeId: "node-1",
    operation: "op",
    invocationId: "a".repeat(64),
    params: {},
    inputs: [],
    store: new HashOnlyArtifactStore("."),
    rng: createDeterministicRng("seed"),
    ...overrides
  };
}

describe("connector resilience middleware", () => {
  it("retries transient failures and caches via idempotency key", async () => {
    let calls = 0;
    const base: Connector = {
      id: "mock",
      async invoke(_ctx: ConnectorContext): Promise<ConnectorResult> {
        calls++;
        if (calls === 1) throw new Error("transient");
        return { outputs: [], costUSD: 0 };
      }
    };

    const resilient = withResilience(
      base,
      {
        maxRetries: 3,
        baseDelayMs: 0,
        maxDelayMs: 0,
        timeoutMs: 1000,
        idempotencyTtlMs: 60_000
      },
      { idempotency: new InMemoryIdempotencyStore() }
    );

    const ctx = makeCtx();
    await resilient.invoke(ctx);
    await resilient.invoke(ctx);
    expect(calls).toBe(2); // 1 fail + 1 success, second call is cached
  });

  it("fails fast on non-retryable errors", async () => {
    let calls = 0;
    const base: Connector = {
      id: "mock",
      async invoke(_ctx: ConnectorContext): Promise<ConnectorResult> {
        calls++;
        throw new ValidationError("bad input");
      }
    };

    const resilient = withResilience(
      base,
      {
        maxRetries: 10,
        baseDelayMs: 0,
        maxDelayMs: 0,
        timeoutMs: 1000,
        idempotencyTtlMs: 60_000
      },
      { idempotency: new InMemoryIdempotencyStore() }
    );

    await expect(resilient.invoke(makeCtx())).rejects.toBeInstanceOf(ValidationError);
    expect(calls).toBe(1);
  });
});

