import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";

export interface RemoteAuth {
  token?: string | undefined;
  orgId?: string | undefined;
}

export interface RemoteConfig {
  baseUrl: string;
  auth: RemoteAuth;
  /**
   * Per-request timeout in milliseconds.
   */
  timeoutMs?: number | undefined;
  /**
   * Number of retries after the initial attempt.
   */
  maxRetries?: number | undefined;
  /**
   * Base retry delay in milliseconds (exponential backoff, no jitter).
   */
  retryBaseDelayMs?: number | undefined;
  /**
   * Max retry delay cap in milliseconds.
   */
  retryMaxDelayMs?: number | undefined;
}

export interface UploadObjectResult {
  uri: string;
  sha256: string;
  bytes: number;
}

export class RemoteHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string
  ) {
    super(message);
    this.name = "RemoteHttpError";
  }
}

export class RemoteNetworkError extends Error {
  constructor(
    message: string,
    public readonly reason: "timeout" | "network",
    public readonly attempts: number
  ) {
    super(message);
    this.name = "RemoteNetworkError";
  }
}

interface FetchPolicy {
  retryable: boolean;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 200;
const DEFAULT_RETRY_MAX_DELAY_MS = 2_000;
const MAX_RETRY_AFTER_MS = 30_000;

export class BioFlowRemote {
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;

  constructor(private readonly config: RemoteConfig) {
    this.timeoutMs = normalizeInt(config.timeoutMs, DEFAULT_TIMEOUT_MS, 1, 120_000);
    this.maxRetries = normalizeInt(config.maxRetries, DEFAULT_MAX_RETRIES, 0, 8);
    this.retryBaseDelayMs = normalizeInt(config.retryBaseDelayMs, DEFAULT_RETRY_BASE_DELAY_MS, 1, 10_000);
    this.retryMaxDelayMs = normalizeInt(config.retryMaxDelayMs, DEFAULT_RETRY_MAX_DELAY_MS, 1, 120_000);
  }

  async headObject(sha256: string): Promise<boolean> {
    const res = await this.fetch(`/api/v1/objects/${sha256}`, { method: "HEAD" }, { retryable: true });
    if (res.status === 200) return true;
    if (res.status === 404) return false;
    throw await this.httpError("HEAD", `/api/v1/objects/${sha256}`, res);
  }

  async uploadObjectFromPath(filePath: string): Promise<UploadObjectResult> {
    const res = await this.fetchWithBuilder(
      "/api/v1/objects",
      () => {
        const stream = createReadStream(filePath);
        return {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: Readable.toWeb(stream) as unknown as BodyInit,
          duplex: "half"
        };
      },
      { retryable: true }
    );
    if (!res.ok) throw await this.httpError("POST", "/api/v1/objects", res);
    return (await res.json()) as UploadObjectResult;
  }

  async downloadObject(sha256: string): Promise<NodeJS.ReadableStream> {
    const res = await this.fetch(`/api/v1/objects/${sha256}`, { method: "GET" }, { retryable: true });
    if (res.status === 404) {
      throw new RemoteHttpError(`Object not found: ${sha256}`, 404, await safeReadText(res));
    }
    if (!res.ok) throw await this.httpError("GET", `/api/v1/objects/${sha256}`, res);
    if (!res.body) throw new Error("Response body is empty");
    return Readable.fromWeb(res.body as unknown as NodeWebReadableStream);
  }

  async getRunSync(runId: string): Promise<unknown> {
    const res = await this.fetch(`/api/v1/runs/${runId}/sync`, { method: "GET" }, { retryable: true });
    if (!res.ok) throw await this.httpError("GET", `/api/v1/runs/${runId}/sync`, res);
    return (await res.json()) as unknown;
  }

  async postRunSync(runId: string, body: unknown): Promise<unknown> {
    const res = await this.fetch(
      `/api/v1/runs/${runId}/sync`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      },
      { retryable: true }
    );
    if (!res.ok) throw await this.httpError("POST", `/api/v1/runs/${runId}/sync`, res);
    return (await res.json()) as unknown;
  }

  async listRuns(params: {
    limit?: number | undefined;
    cursor?: string | undefined;
    profileId?: string | undefined;
    tags?: string | undefined;
    visibility?: "private" | "org" | "public" | undefined;
  } = {}): Promise<unknown> {
    const q = new URLSearchParams();
    if (params.limit) q.set("limit", String(params.limit));
    if (params.cursor) q.set("cursor", params.cursor);
    if (params.profileId) q.set("profileId", params.profileId);
    if (params.tags) q.set("tags", params.tags);
    if (params.visibility) q.set("visibility", params.visibility);
    const qs = q.toString();
    const res = await this.fetch(`/api/v1/runs${qs ? `?${qs}` : ""}`, { method: "GET" }, { retryable: true });
    if (!res.ok) throw await this.httpError("GET", "/api/v1/runs", res);
    return (await res.json()) as unknown;
  }

  async shareRun(runId: string, visibility: "private" | "org" | "public" = "org"): Promise<unknown> {
    const res = await this.fetch(
      `/api/v1/runs/${runId}/share`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ visibility })
      },
      { retryable: true }
    );
    if (!res.ok) throw await this.httpError("POST", `/api/v1/runs/${runId}/share`, res);
    return (await res.json()) as unknown;
  }

  async listProfiles(params: { limit?: number | undefined } = {}): Promise<unknown> {
    const q = new URLSearchParams();
    if (params.limit) q.set("limit", String(params.limit));
    const qs = q.toString();
    const res = await this.fetch(`/api/v1/profiles${qs ? `?${qs}` : ""}`, { method: "GET" }, { retryable: true });
    if (!res.ok) throw await this.httpError("GET", "/api/v1/profiles", res);
    return (await res.json()) as unknown;
  }

  async getProfile(name: string): Promise<unknown> {
    const res = await this.fetch(
      `/api/v1/profiles/${encodeURIComponent(name)}`,
      { method: "GET" },
      { retryable: true }
    );
    if (!res.ok) throw await this.httpError("GET", `/api/v1/profiles/${name}`, res);
    return (await res.json()) as unknown;
  }

  async upsertProfile(name: string, profile: unknown): Promise<unknown> {
    const res = await this.fetch(
      `/api/v1/profiles`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, profile })
      },
      { retryable: true }
    );
    if (!res.ok) throw await this.httpError("POST", "/api/v1/profiles", res);
    return (await res.json()) as unknown;
  }

  async verifyRun(runId: string, params: { deep?: boolean | undefined } = {}): Promise<unknown> {
    const deep = params.deep ? "1" : "0";
    const res = await this.fetch(`/api/v1/runs/${runId}/verify?deep=${deep}`, { method: "GET" }, { retryable: true });
    if (!res.ok) throw await this.httpError("GET", `/api/v1/runs/${runId}/verify`, res);
    return (await res.json()) as unknown;
  }

  private async fetch(path: string, init: RequestInit, policy: FetchPolicy): Promise<Response> {
    return this.fetchWithBuilder(path, () => init, policy);
  }

  private async fetchWithBuilder(path: string, buildInit: () => RequestInit, policy: FetchPolicy): Promise<Response> {
    const headers: Record<string, string> = {};
    const url = new URL(path, ensureTrailingSlash(this.config.baseUrl)).toString();
    if (this.config.auth.token) headers["authorization"] = `Bearer ${this.config.auth.token}`;
    if (this.config.auth.orgId) headers["x-org-id"] = this.config.auth.orgId;

    const maxAttempts = this.maxRetries + 1;
    let method = "GET";
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let timedOut = false;
      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, this.timeoutMs);

      try {
        const init = buildInit();
        method = normalizeMethod(init.method);
        const mergedHeaders = { ...(init.headers as Record<string, string> | undefined), ...headers };
        const res = await fetch(url, { ...init, headers: mergedHeaders, signal: controller.signal });

        if (!policy.retryable || !isRetryableStatusCode(res.status) || attempt >= maxAttempts) {
          return res;
        }

        await drainResponse(res);
        await sleepMs(
          computeRetryDelayMs({
            attempt,
            baseDelayMs: this.retryBaseDelayMs,
            maxDelayMs: this.retryMaxDelayMs,
            retryAfter: res.headers.get("retry-after")
          })
        );
      } catch (err) {
        const isNetworkErr = timedOut || isRetryableNetworkError(err);
        const canRetry = policy.retryable && isNetworkErr && attempt < maxAttempts;
        if (!canRetry) {
          if (isNetworkErr) {
            throw new RemoteNetworkError(
              `${method} ${path} failed after ${String(attempt)} attempt(s): ${timedOut ? "timeout" : errorMessage(err)}`,
              timedOut ? "timeout" : "network",
              attempt
            );
          }
          throw err;
        }

        await sleepMs(
          computeRetryDelayMs({
            attempt,
            baseDelayMs: this.retryBaseDelayMs,
            maxDelayMs: this.retryMaxDelayMs,
            retryAfter: null
          })
        );
      } finally {
        clearTimeout(timeoutHandle);
      }
    }

    throw new RemoteNetworkError(`${method} ${path} failed after retries`, "network", maxAttempts);
  }

  private async httpError(method: string, path: string, res: Response): Promise<RemoteHttpError> {
    const body = await safeReadText(res);
    return new RemoteHttpError(`${method} ${path} failed: ${res.status}`, res.status, body);
  }
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "<unreadable>";
  }
}

function normalizeMethod(method: string | undefined): string {
  const trimmed = method?.trim().toUpperCase();
  return trimmed && trimmed.length > 0 ? trimmed : "GET";
}

function normalizeInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value == null || !Number.isFinite(value)) return fallback;
  const n = Math.trunc(value);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function isRetryableStatusCode(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function isRetryableNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "AbortError") return true;
  // Node fetch network failures typically surface as TypeError("fetch failed").
  return err instanceof TypeError;
}

function computeRetryDelayMs(params: {
  attempt: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryAfter: string | null;
}): number {
  const retryAfterMs = parseRetryAfterMs(params.retryAfter);
  if (retryAfterMs != null) {
    return Math.max(1, Math.min(params.maxDelayMs, retryAfterMs, MAX_RETRY_AFTER_MS));
  }
  const backoff = params.baseDelayMs * 2 ** Math.max(0, params.attempt - 1);
  return Math.max(1, Math.min(params.maxDelayMs, backoff));
}

function parseRetryAfterMs(value: string | null): number | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (/^[0-9]+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds)) return null;
    return Math.max(0, Math.ceil(seconds * 1000));
  }
  const atMs = Date.parse(trimmed);
  if (!Number.isFinite(atMs)) return null;
  return Math.max(0, Math.ceil(atMs - Date.now()));
}

async function drainResponse(res: Response): Promise<void> {
  try {
    await res.arrayBuffer();
  } catch {
    // Ignore response drain errors during retry.
  }
}

async function sleepMs(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
