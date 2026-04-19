import type { Connector, ConnectorContext, ConnectorResult } from "../connector.js";
import { sha256Hex } from "../../hash.js";
import {
  AuthenticationError,
  DeterminismError,
  RetryExhaustedError,
  TimeoutError,
  ValidationError
} from "../../errors.js";
import type { IdempotencyStore } from "./idempotency.js";
import type { RateLimiter } from "./rate-limit.js";

export interface ResilienceConfig {
  maxRetries: number; // number of retries after the first attempt
  baseDelayMs: number;
  maxDelayMs: number;
  timeoutMs: number;
  idempotencyTtlMs: number;
  rateLimitRps?: number | undefined;
  jitterWindowMs?: number | undefined; // deterministic jitter added to backoff
}

export function withResilience(
  base: Connector,
  config: ResilienceConfig,
  deps: { idempotency: IdempotencyStore; rateLimiter?: RateLimiter | undefined }
): Connector {
  if (config.maxRetries < 0) throw new Error("maxRetries must be >= 0");
  if (config.baseDelayMs < 0) throw new Error("baseDelayMs must be >= 0");
  if (config.maxDelayMs < 0) throw new Error("maxDelayMs must be >= 0");
  if (config.timeoutMs <= 0) throw new Error("timeoutMs must be > 0");
  if (config.idempotencyTtlMs <= 0) throw new Error("idempotencyTtlMs must be > 0");

  const limiterKey = base.id;
  const jitterWindowMs = config.jitterWindowMs ?? 0;

  return {
    id: `${base.id}`,
    async invoke(ctx: ConnectorContext): Promise<ConnectorResult> {
      const idempotencyKey = `${base.id}:${ctx.invocationId}`;
      const cached = await deps.idempotency.get(idempotencyKey);
      if (cached) return cached;

      let lastErr: unknown = undefined;
      const totalAttempts = config.maxRetries + 1;

      for (let attempt = 0; attempt < totalAttempts; attempt++) {
        try {
          if (deps.rateLimiter && config.rateLimitRps) {
            await deps.rateLimiter.acquire(limiterKey, config.rateLimitRps);
          }

          const result = await withTimeout(() => base.invoke(ctx), config.timeoutMs);
          await deps.idempotency.set(idempotencyKey, result, config.idempotencyTtlMs);
          return result;
        } catch (err) {
          lastErr = err;
          if (isNonRetryable(err)) throw err;
          if (attempt >= totalAttempts - 1) break;

          const baseDelay = Math.min(config.baseDelayMs * 2 ** attempt, config.maxDelayMs);
          const jitter = jitterWindowMs > 0 ? deterministicJitterMs(idempotencyKey, attempt, jitterWindowMs) : 0;
          await sleep(baseDelay + jitter);
        }
      }

      const message = lastErr instanceof Error ? lastErr.message : String(lastErr);
      throw new RetryExhaustedError(`Connector ${base.id} failed after ${totalAttempts} attempts: ${message}`);
    }
  };
}

function isNonRetryable(err: unknown): boolean {
  return (
    err instanceof ValidationError ||
    err instanceof DeterminismError ||
    err instanceof AuthenticationError
  );
}

function deterministicJitterMs(key: string, attempt: number, windowMs: number): number {
  const hex = sha256Hex(`${key}:${attempt}`).slice(0, 8);
  return Number.parseInt(hex, 16) % windowMs;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutId: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => reject(new TimeoutError(`Timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([fn(), timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
