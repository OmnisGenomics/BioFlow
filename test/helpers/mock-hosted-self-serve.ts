import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface MockHostedSelfServeState {
  apiKey: string;
  orgId: string;
  orgSlug: string;
  orgName: string;
  firstRunId: string | null;
  hasRun: boolean;
  hasVerify: boolean;
  hasShare: boolean;
  objects: Set<string>;
}

export interface MockHostedSelfServeServer {
  baseUrl: string;
  state: MockHostedSelfServeState;
  close: () => Promise<void>;
}

export async function createMockHostedSelfServeServer(): Promise<MockHostedSelfServeServer> {
  const state: MockHostedSelfServeState = {
    apiKey: `bf_test_${randomUUID().replace(/-/g, "")}`,
    orgId: randomUUID(),
    orgSlug: "",
    orgName: "",
    firstRunId: null,
    hasRun: false,
    hasVerify: false,
    hasShare: false,
    objects: new Set<string>()
  };

  const server = createServer(async (req, res) => {
    try {
      await handleMockRequest(req, res, state);
    } catch (err) {
      sendJson(
        res,
        500,
        {
          error: "mock_server_error",
          message: err instanceof Error ? err.message : String(err)
        },
        req.method === "HEAD"
      );
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });

  const address = server.address() as AddressInfo | null;
  if (!address || typeof address === "string") {
    throw new Error("Failed to determine mock hosted server address");
  }

  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    state,
    close: async () =>
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      })
  };
}

async function handleMockRequest(
  req: IncomingMessage,
  res: ServerResponse,
  state: MockHostedSelfServeState
): Promise<void> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const pathname = url.pathname;
  const headRequest = method === "HEAD";

  if (method === "POST" && pathname === "/api/v1/self-serve/signup") {
    const payload = await readJsonBody(req);
    const slug = typeof payload.slug === "string" && payload.slug.length > 0 ? payload.slug : "demo-org";
    const name = typeof payload.name === "string" && payload.name.length > 0 ? payload.name : "Demo Org";
    state.orgSlug = slug;
    state.orgName = name;
    sendJson(
      res,
      201,
      {
        replayed: false,
        org: {
          id: state.orgId,
          name,
          slug,
          plan: "team",
          planStatus: "trialing",
          currentPeriodEnd: null
        },
        apiKeyId: randomUUID(),
        keyPrefix: state.apiKey.slice(0, 12),
        apiKey: state.apiKey
      },
      headRequest
    );
    return;
  }

  if (!isAuthorized(req, state)) {
    sendJson(
      res,
      401,
      {
        error: "unauthorized",
        message: "invalid bearer token"
      },
      headRequest
    );
    return;
  }

  if (method === "GET" && pathname === "/api/v1/onboarding/checklist") {
    const checklist = buildChecklist(state);
    sendJson(
      res,
      200,
      {
        progress: checklist.progress,
        nextAction: checklist.nextAction,
        firstRunId: state.firstRunId,
        checklist: checklist.items
      },
      headRequest
    );
    return;
  }

  const objectPath = pathname.match(/^\/api\/v1\/objects\/([a-f0-9]{64})$/);
  if (objectPath && method === "HEAD") {
    const exists = state.objects.has(objectPath[1]!);
    res.statusCode = exists ? 200 : 404;
    res.end();
    return;
  }

  if (method === "POST" && pathname === "/api/v1/objects") {
    const bytes = await readRawBody(req);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    state.objects.add(sha256);
    sendJson(
      res,
      200,
      {
        uri: `sha256:${sha256}`,
        sha256,
        bytes: bytes.length
      },
      headRequest
    );
    return;
  }

  const syncPath = pathname.match(/^\/api\/v1\/runs\/([A-Za-z0-9-]{36})\/sync$/);
  if (syncPath && method === "POST") {
    const payload = await readJsonBody(req);
    if (!payload.manifest || !payload.executionRecord) {
      sendJson(res, 400, { error: "invalid_sync_payload" }, headRequest);
      return;
    }
    state.firstRunId = syncPath[1]!;
    state.hasRun = true;
    sendJson(res, 200, { ok: true }, headRequest);
    return;
  }

  const verifyPath = pathname.match(/^\/api\/v1\/runs\/([A-Za-z0-9-]{36})\/verify$/);
  if (verifyPath && method === "GET") {
    const runId = verifyPath[1]!;
    const valid = state.hasRun && state.firstRunId === runId;
    if (valid) state.hasVerify = true;
    sendJson(res, 200, { valid, errors: valid ? [] : ["run_missing"] }, headRequest);
    return;
  }

  const sharePath = pathname.match(/^\/api\/v1\/runs\/([A-Za-z0-9-]{36})\/share$/);
  if (sharePath && method === "POST") {
    const runId = sharePath[1]!;
    if (state.firstRunId === runId) state.hasShare = true;
    sendJson(res, 200, { visibility: "org" }, headRequest);
    return;
  }

  sendJson(
    res,
    404,
    {
      error: "not_found",
      method,
      path: pathname
    },
    headRequest
  );
}

function isAuthorized(req: IncomingMessage, state: MockHostedSelfServeState): boolean {
  return req.headers.authorization === `Bearer ${state.apiKey}`;
}

function buildChecklist(state: MockHostedSelfServeState): {
  progress: { completed: number; total: number };
  nextAction: string | null;
  items: Array<{ id: string; completed: boolean }>;
} {
  const items = [
    { id: "org_created", completed: true },
    { id: "billing_configured", completed: false },
    { id: "first_run_created", completed: state.hasRun },
    { id: "first_run_verified", completed: state.hasVerify },
    { id: "first_run_shared", completed: state.hasShare }
  ];
  const completed = items.filter((item) => item.completed).length;
  const nextAction = items.find((item) => !item.completed)?.id ?? null;
  return {
    progress: {
      completed,
      total: items.length
    },
    nextAction,
    items
  };
}

async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    if (typeof chunk === "string") {
      chunks.push(Buffer.from(chunk));
    } else {
      chunks.push(chunk);
    }
  }
  return Buffer.concat(chunks);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readRawBody(req);
  if (raw.length === 0) return {};
  return JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
  headRequest: boolean
): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("content-length", Buffer.byteLength(payload));
  if (headRequest) {
    res.end();
    return;
  }
  res.end(payload);
}
