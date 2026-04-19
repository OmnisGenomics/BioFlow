import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { BioFlowRemote, type RemoteConfig } from "../src/sync/remote.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function setFetchMock(fn: typeof fetch): void {
  globalThis.fetch = fn;
}

function makeRemote(overrides: Partial<RemoteConfig> = {}): BioFlowRemote {
  return new BioFlowRemote({
    baseUrl: "https://bioflow.example",
    auth: { token: "bf_test_token" },
    timeoutMs: 50,
    maxRetries: 2,
    retryBaseDelayMs: 1,
    retryMaxDelayMs: 5,
    ...overrides
  });
}

describe("remote retry and timeout behavior", () => {
  it("retries transient 503 responses and succeeds", async () => {
    let calls = 0;
    setFetchMock(async () => {
      calls++;
      if (calls === 1) return new Response("busy", { status: 503 });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });

    const remote = makeRemote();
    const res = await remote.getRunSync("run-1");
    expect(res).toEqual({ ok: true });
    expect(calls).toBe(2);
  }, 20_000);

  it("does not retry non-retryable 400 responses", async () => {
    let calls = 0;
    setFetchMock(async () => {
      calls++;
      return new Response(JSON.stringify({ error: "bad_request" }), {
        status: 400,
        headers: { "content-type": "application/json" }
      });
    });

    const remote = makeRemote();
    await expect(remote.getRunSync("run-2")).rejects.toMatchObject({
      name: "RemoteHttpError",
      status: 400
    });
    expect(calls).toBe(1);
  }, 20_000);

  it("times out and retries before failing with RemoteNetworkError", async () => {
    let calls = 0;
    setFetchMock((_url: RequestInfo | URL, init?: RequestInit) => {
      calls++;
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const onAbort = () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        };
        if (!signal) return;
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      });
    });

    const remote = makeRemote({
      timeoutMs: 5,
      maxRetries: 1,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 2
    });

    await expect(remote.headObject("abc123")).rejects.toMatchObject({
      name: "RemoteNetworkError",
      reason: "timeout",
      attempts: 2
    });
    expect(calls).toBe(2);
  }, 20_000);

  it("retries streamed object upload by rebuilding the request body", async () => {
    const tempDir = path.resolve(".bioflow_remote_retry_upload");
    await rm(tempDir, { recursive: true, force: true });
    await mkdir(tempDir, { recursive: true });
    const filePath = path.join(tempDir, "payload.bin");
    await writeFile(filePath, Buffer.from("hello"));

    let calls = 0;
    setFetchMock(async () => {
      calls++;
      if (calls === 1) throw new TypeError("fetch failed");
      return new Response(
        JSON.stringify({
          uri: `sha256:${"a".repeat(64)}`,
          sha256: "a".repeat(64),
          bytes: 5
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    });

    const remote = makeRemote({
      timeoutMs: 50,
      maxRetries: 1,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 2
    });
    try {
      const res = await remote.uploadObjectFromPath(filePath);
      expect(res.sha256).toBe("a".repeat(64));
      expect(res.bytes).toBe(5);
      expect(calls).toBe(2);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 20_000);
});
