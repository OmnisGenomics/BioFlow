import path from "node:path";
import { tmpdir } from "node:os";
import { createServer, IncomingMessage } from "node:http";
import { AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

interface CliRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

interface CapturedRequest {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

describe("cli auth:signup", () => {
  it("uses --config-path remote defaults when --remote-url is omitted", async () => {
    const repoRoot = path.resolve(".");
    const tempDir = await mkdtemp(path.join(tmpdir(), "bioflow-cli-auth-signup-config-path-"));
    const configPath = path.join(tempDir, "config.json");
    const requests: CapturedRequest[] = [];

    const server = createServer((req, res) => {
      readBody(req)
        .then((body) => {
          requests.push({
            method: req.method ?? "",
            url: req.url ?? "",
            headers: req.headers,
            body
          });
          res.statusCode = 201;
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              replayed: false,
              org: {
                id: "99999999-9999-4999-8999-999999999999",
                name: "Acme Deterministic",
                slug: "acme-deterministic",
                plan: "team",
                planStatus: "trialing",
                currentPeriodEnd: "2026-03-11T00:00:00.000Z"
              },
              apiKeyId: "98989898-9898-4989-8989-989898989898",
              keyPrefix: "bf_test_abcd",
              apiKey: "bf_test_1234567890abcdef1234567890abcdef"
            })
          );
        })
        .catch((err) => {
          res.statusCode = 500;
          res.end(String(err));
        });
    });
    await listen(server);
    const remoteUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await writeFile(configPath, JSON.stringify({ remote: { url: remoteUrl } }, null, 2), "utf8");

    try {
      const result = await runCli(
        [
          "auth:signup",
          "--name",
          "Acme Deterministic",
          "--slug",
          "acme-deterministic",
          "--idempotency-key",
          "signup-test-config-path-0001",
          "--config-path",
          configPath
        ],
        process.env,
        repoRoot
      );

      expect(result.status, result.stderr).toBe(0);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        method: "POST",
        url: "/api/v1/self-serve/signup"
      });
      const raw = await readFile(configPath, "utf8");
      const parsed = JSON.parse(raw) as { remote?: { url?: string; token?: string; orgId?: string } };
      expect(parsed).toMatchObject({
        remote: {
          url: remoteUrl,
          token: "bf_test_1234567890abcdef1234567890abcdef",
          orgId: "99999999-9999-4999-8999-999999999999"
        }
      });
    } finally {
      await closeServer(server);
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("emits machine-readable JSON on successful signup when --json is set", async () => {
    const repoRoot = path.resolve(".");
    const tempDir = await mkdtemp(path.join(tmpdir(), "bioflow-cli-auth-signup-json-"));
    const configPath = path.join(tempDir, "config.json");

    const server = createServer((req, res) => {
      readBody(req)
        .then(() => {
          res.statusCode = 201;
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              replayed: false,
              org: {
                id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                name: "Acme Deterministic",
                slug: "acme-deterministic",
                plan: "team",
                planStatus: "trialing",
                currentPeriodEnd: "2026-03-11T00:00:00.000Z"
              },
              apiKeyId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
              keyPrefix: "bf_live_abcd",
              apiKey: "bf_live_1234567890abcdef1234567890abcdef"
            })
          );
        })
        .catch((err) => {
          res.statusCode = 500;
          res.end(String(err));
        });
    });

    await listen(server);
    const remoteUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      const result = await runCli(
        [
          "auth:signup",
          "--name",
          "Acme Deterministic",
          "--slug",
          "acme-deterministic",
          "--remote-url",
          remoteUrl,
          "--idempotency-key",
          "signup-test-json-0001",
          "--json"
        ],
        { ...process.env, BIOFLOW_CONFIG_PATH: configPath },
        repoRoot
      );

      expect(result.status, result.stderr).toBe(0);
      const payload = parseJsonOutput(result.stdout) as Record<string, unknown>;
      expect(payload).toMatchObject({
        ok: true,
        replayed: false,
        org: {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          slug: "acme-deterministic",
          plan: "team",
          planStatus: "trialing"
        },
        keyPrefix: "bf_live_abcd",
        apiKey: "bf_live_1234567890abcdef1234567890abcdef",
        remoteUrl
      });
      expect(typeof payload.configPath).toBe("string");
    } finally {
      await closeServer(server);
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("emits machine-readable JSON error on non-2xx when --json is set", async () => {
    const repoRoot = path.resolve(".");
    const tempDir = await mkdtemp(path.join(tmpdir(), "bioflow-cli-auth-signup-json-error-"));
    const configPath = path.join(tempDir, "config.json");

    const server = createServer((req, res) => {
      readBody(req)
        .then(() => {
          res.statusCode = 409;
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              error: "slug_taken",
              message: "slug is already in use"
            })
          );
        })
        .catch((err) => {
          res.statusCode = 500;
          res.end(String(err));
        });
    });

    await listen(server);
    const remoteUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      const result = await runCli(
        [
          "auth:signup",
          "--name",
          "Acme Deterministic",
          "--slug",
          "acme-deterministic",
          "--remote-url",
          remoteUrl,
          "--idempotency-key",
          "signup-test-json-error-0001",
          "--json"
        ],
        { ...process.env, BIOFLOW_CONFIG_PATH: configPath },
        repoRoot
      );

      expect(result.status).toBe(1);
      const payload = parseJsonOutput(result.stdout) as Record<string, unknown>;
      expect(payload).toMatchObject({
        ok: false,
        status: 409,
        error: "slug_taken",
        remoteUrl
      });
      expect(String(payload.message ?? "")).toContain("Self-serve signup failed (409)");
    } finally {
      await closeServer(server);
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("creates org via self-serve endpoint and saves remote auth config", async () => {
    const repoRoot = path.resolve(".");
    const tempDir = await mkdtemp(path.join(tmpdir(), "bioflow-cli-auth-signup-"));
    const configPath = path.join(tempDir, "config.json");
    const requests: CapturedRequest[] = [];

    const server = createServer((req, res) => {
      readBody(req)
        .then((body) => {
          requests.push({
            method: req.method ?? "",
            url: req.url ?? "",
            headers: req.headers,
            body
          });

          res.statusCode = 201;
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              replayed: false,
              org: {
                id: "11111111-1111-4111-8111-111111111111",
                name: "Acme Deterministic",
                slug: "acme-deterministic",
                plan: "team",
                planStatus: "trialing",
                currentPeriodEnd: "2026-03-11T00:00:00.000Z"
              },
              apiKeyId: "22222222-2222-4222-8222-222222222222",
              keyPrefix: "bf_live_abcd",
              apiKey: "bf_live_1234567890abcdef1234567890abcdef"
            })
          );
        })
        .catch((err) => {
          res.statusCode = 500;
          res.end(String(err));
        });
    });

    await listen(server);
    const remoteUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      const result = await runCli(
        [
          "auth:signup",
          "--name",
          "Acme Deterministic",
          "--slug",
          "acme-deterministic",
          "--remote-url",
          remoteUrl,
          "--idempotency-key",
          "signup-test-0001"
        ],
        { ...process.env, BIOFLOW_CONFIG_PATH: configPath },
        repoRoot
      );

      expect(result.status, result.stderr).toBe(0);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        method: "POST",
        url: "/api/v1/self-serve/signup"
      });
      expect(requests[0]?.headers["idempotency-key"]).toBe("signup-test-0001");
      expect(JSON.parse(requests[0]?.body ?? "{}")).toMatchObject({
        name: "Acme Deterministic",
        slug: "acme-deterministic",
        plan: "team",
        keyMode: "live"
      });

      const raw = await readFile(configPath, "utf8");
      const parsed = JSON.parse(raw) as { remote?: { url?: string; token?: string; orgId?: string } };
      expect(parsed).toMatchObject({
        remote: {
          url: remoteUrl,
          token: "bf_live_1234567890abcdef1234567890abcdef",
          orgId: "11111111-1111-4111-8111-111111111111"
        }
      });
    } finally {
      await closeServer(server);
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("returns non-zero when signup is replayed and no API key is available", async () => {
    const repoRoot = path.resolve(".");
    const tempDir = await mkdtemp(path.join(tmpdir(), "bioflow-cli-auth-signup-replay-"));
    const configPath = path.join(tempDir, "config.json");

    const server = createServer((req, res) => {
      readBody(req)
        .then(() => {
          res.statusCode = 200;
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              replayed: true,
              org: {
                id: "33333333-3333-4333-8333-333333333333",
                name: "Acme Deterministic",
                slug: "acme-deterministic",
                plan: "team",
                planStatus: "trialing",
                currentPeriodEnd: "2026-03-11T00:00:00.000Z"
              },
              keyPrefix: "bf_live_abcd",
              apiKey: null
            })
          );
        })
        .catch((err) => {
          res.statusCode = 500;
          res.end(String(err));
        });
    });

    await listen(server);
    const remoteUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      const result = await runCli(
        [
          "auth:signup",
          "--name",
          "Acme Deterministic",
          "--slug",
          "acme-deterministic",
          "--remote-url",
          remoteUrl,
          "--idempotency-key",
          "signup-test-replay-0001"
        ],
        { ...process.env, BIOFLOW_CONFIG_PATH: configPath },
        repoRoot
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Self-serve signup replayed and API key is not available");
    } finally {
      await closeServer(server);
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 60_000);
});

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function listen(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

async function runCli(args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<CliRunResult> {
  return await new Promise<CliRunResult>((resolve, reject) => {
    const child = spawn(npmCmd, ["run", "-s", "bioflow", "--", ...args], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });

    child.once("error", reject);
    child.once("close", (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

function parseJsonOutput(output: string): unknown {
  const trimmed = output.trim();
  expect(trimmed.length).toBeGreaterThan(0);
  return JSON.parse(trimmed) as unknown;
}
