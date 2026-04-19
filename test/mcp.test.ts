import path from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { appendAudit, verifyAuditChain } from "../src/core/audit.js";
import type { AuditEntry } from "../src/core/types.js";
import { createBioFlowMcpServer } from "../src/mcp/server.js";
import { encodeJsonRpcFrame, RpcFramer, serveStdio } from "../src/mcp/stdio.js";

async function createFixtureRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "bioflow-mcp-"));
  await mkdir(path.join(root, "docs", "wiki"), { recursive: true });
  await mkdir(path.join(root, "examples"), { recursive: true });
  await mkdir(path.join(root, "src", "cli"), { recursive: true });
  await mkdir(path.join(root, "src", "core"), { recursive: true });

  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify(
      {
        name: "@bioflow/cli",
        version: "9.9.9",
        description: "Fixture repository for MCP tests",
        scripts: {
          bioflow: "tsx src/cli/main.ts",
          mcp: "tsx src/mcp/main.ts"
        }
      },
      null,
      2
    )
  );

  await writeFile(
    path.join(root, "README.md"),
    [
      "# BioFlow Fixture",
      "",
      "This repository is used to exercise the MCP summary surface.",
      "It intentionally mentions workflows, documentation, and validation."
    ].join("\n")
  );

  await writeFile(
    path.join(root, "docs", "ROADMAP.md"),
    [
      "# Roadmap",
      "",
      "The roadmap covers workflow planning, repo search, and validation gates.",
      "This file exists so the MCP search tool has a stable docs hit."
    ].join("\n")
  );

  await writeFile(
    path.join(root, "docs", "wiki", "index.md"),
    [
      "# BioFlow Wiki",
      "",
      "Purpose: fixture data for the MCP test suite.",
      "Inventory: 12 files, 3 components, 4 workflows"
    ].join("\n")
  );

  await writeFile(
    path.join(root, "docs", "wiki", "workflows.md"),
    [
      "# Workflows",
      "",
      "Validation workflow inventory for the fixture repository.",
      "Search should be able to read this wiki page."
    ].join("\n")
  );

  await writeFile(
    path.join(root, "src", "cli", "main.ts"),
    [
      "export function main(): string {",
      "  return \"bioflow-cli\";",
      "}"
    ].join("\n")
  );

  await writeFile(
    path.join(root, "src", "core", "validate.ts"),
    [
      "export function validateMcpFixture(value: string): boolean {",
      "  return value.length > 0;",
      "}"
    ].join("\n")
  );

  await writeFile(
    path.join(root, "examples", "manual.workflow.yaml"),
    [
      "id: fixture.manual",
      "version: 0.1.0",
      "seed: fixture-seed",
      "nodes:",
      "  - id: start",
      "    kind: trigger.manual",
      "edges: []"
    ].join("\n")
  );

  return root;
}

function makeRemoteSyncBundle(runId: string): {
  run: Record<string, unknown>;
  manifest: Record<string, unknown>;
  executionRecord: Record<string, unknown>;
} {
  const now = "2026-04-19T00:00:00.000Z";
  const digest = "a".repeat(64);
  const auditLog: AuditEntry[] = [];
  appendAudit(auditLog, {
    actor: "api_key:remote",
    action: "run.completed",
    details: { runId }
  });

  return {
    run: {
      id: runId,
      workflow_name: "remote-sync-workflow",
      workflow_version: "1.0.0",
      status: "completed",
      visibility: "org"
    },
    manifest: {
      manifestVersion: 1,
      runId,
      createdAt: now,
      workflow: {
        id: "remote-sync-workflow",
        version: "1.0.0",
        digest,
        seed: "remote-seed"
      },
      artifacts: {
        "__workflow.json": {
          name: "__workflow.json",
          uri: `sha256:${digest}`,
          sha256: digest,
          bytes: 1,
          createdAt: now
        }
      },
      inputs: []
    },
    executionRecord: {
      execution: {
        workflowId: "remote-sync-workflow",
        workflowVersion: "1.0.0",
        workflowDigest: digest,
        runId,
        status: "completed",
        startedAt: now,
        endedAt: now,
        inputs: [],
        outputs: [],
        auditLog,
        costUSD: 0,
        runtime: {
          nodeVersion: "v22.0.0",
          platform: "linux",
          arch: "x64"
        }
      },
      nodeRuns: []
    }
  };
}

describe("BioFlow MCP", () => {
  it("serves initialize, resources, and wiki/source reads over stdio", async () => {
    const repoRoot = await createFixtureRepo();
    try {
      const server = await createBioFlowMcpServer({ repoRoot });
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const framer = new RpcFramer();
      const responses: Array<Record<string, unknown>> = [];

      stdout.on("data", (chunk: Buffer) => {
        for (const message of framer.push(chunk)) {
          responses.push(message as any);
        }
      });

      const transport = serveStdio(stdin, stdout, (message) => server.handleMessage(message));

      stdin.write(
        encodeJsonRpcFrame({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: { roots: { listChanged: true } },
            clientInfo: { name: "vitest", version: "1.0.0" }
          }
        })
      );
      stdin.write(
        encodeJsonRpcFrame({
          jsonrpc: "2.0",
          id: 2,
          method: "resources/list",
          params: {}
        })
      );
      stdin.write(
        encodeJsonRpcFrame({
          jsonrpc: "2.0",
          id: 3,
          method: "resources/read",
          params: { uri: "bioflow://wiki/index" }
        })
      );
      stdin.end(
        encodeJsonRpcFrame({
          jsonrpc: "2.0",
          id: 4,
          method: "resources/read",
          params: { uri: "bioflow://file/src/core/validate.ts" }
        })
      );

      await transport;

      const byId = new Map<number, Record<string, unknown>>();
      for (const response of responses) {
        const id = response.id;
        if (typeof id === "number") {
          byId.set(id, response);
        }
      }

      expect(byId.get(1)?.result).toMatchObject({
        protocolVersion: "2024-11-05",
        serverInfo: {
          name: "bioflow-mcp",
          version: "9.9.9"
        }
      });

      const resourceList = byId.get(2)?.result as { resources?: Array<{ uri?: string }> } | undefined;
      expect(resourceList?.resources?.map((resource) => resource.uri)).toEqual(
        expect.arrayContaining([
          "bioflow://resource/repo-summary",
          "bioflow://resource/workflow-inventory",
          "bioflow://resource/mcp/session",
          "bioflow://wiki/index",
          "bioflow://wiki/workflows",
          "bioflow://file/src/core/validate.ts"
        ])
      );

      const wikiRead = byId.get(3)?.result as { contents?: Array<{ text?: string }> } | undefined;
      expect(wikiRead?.contents?.[0]?.text).toContain("Inventory: 12 files, 3 components, 4 workflows");

      const sourceRead = byId.get(4)?.result as { contents?: Array<{ text?: string }> } | undefined;
      expect(sourceRead?.contents?.[0]?.text).toContain("validateMcpFixture");
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("summarizes and searches the repository", async () => {
    const repoRoot = await createFixtureRepo();
    try {
      const server = await createBioFlowMcpServer({ repoRoot });

      const summary = (await server.handleMessage({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "repo.summary",
          arguments: {}
        }
      })) as any;

      const search = (await server.handleMessage({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "repo.search",
          arguments: {
            query: "validate",
            scope: "all",
            limit: 5
          }
        }
      })) as any;

      const summaryResult = summary.result as {
        content?: Array<{ text?: string }>;
        structuredContent?: { resources?: Array<{ uri?: string }>; topLevelDirectories?: string[] };
      };
      expect(summaryResult.content?.[0]?.text).toContain("# BioFlow MCP");
      expect(summaryResult.structuredContent?.resources?.map((resource) => resource.uri)).toEqual(
        expect.arrayContaining(["bioflow://resource/repo-summary", "bioflow://resource/workflow-inventory"])
      );
      expect(summaryResult.structuredContent?.topLevelDirectories).toEqual(expect.arrayContaining(["docs", "src"]));

      const searchResult = search.result as {
        content?: Array<{ text?: string }>;
        structuredContent?: { hits?: Array<{ relativePath?: string; resourceUri?: string }> };
      };
      expect(searchResult.content?.[0]?.text).toContain("Search Results");
      expect(searchResult.structuredContent?.hits?.[0]?.relativePath).toBe("src/core/validate.ts");
      expect(searchResult.structuredContent?.hits?.[0]?.resourceUri).toBe("bioflow://file/src/core/validate.ts");
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("exposes workflow validate, run, verify, and report tools", async () => {
    const repoRoot = await createFixtureRepo();
    try {
      const server = await createBioFlowMcpServer({ repoRoot });
      const initialize = (await server.handleMessage({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          bioflow: {
            orgId: "11111111-1111-4111-8111-111111111111"
          }
        }
      })) as any;
      expect(initialize.result?.bioflow?.orgId).toBe("11111111-1111-4111-8111-111111111111");

      const toolList = (await server.handleMessage({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {}
      })) as any;
      const toolNames = (toolList.result as { tools?: Array<{ name?: string }> } | undefined)?.tools?.map((tool) => tool.name);
      expect(toolNames).toEqual(
        expect.arrayContaining([
          "repo.summary",
          "repo.search",
          "workflow.validate",
          "workflow.run",
          "run.verify",
          "report.generate",
          "remote.push",
          "remote.pull",
          "remote.verify",
          "remote.share",
          "remote.ls",
          "remote.profiles.list",
          "remote.profiles.get",
          "remote.profiles.put"
        ])
      );

      const validate = (await server.handleMessage({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "workflow.validate",
          arguments: {
            workflowPath: "examples/manual.workflow.yaml"
          }
        }
      })) as any;

      const validateResult = validate.result as {
        content?: Array<{ text?: string }>;
        structuredContent?: { ok?: boolean; issues?: Array<{ message?: string }> };
      };
      expect(validateResult.structuredContent?.ok).toBe(true);
      expect(validateResult.content?.[0]?.text).toContain("OK");

      const run = (await server.handleMessage({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "workflow.run",
          arguments: {
            workflowPath: "examples/manual.workflow.yaml",
            inputPaths: ["README.md"],
            baseDir: ".bioflow"
          }
        }
      })) as any;

      const runResult = run.result as {
        content?: Array<{ text?: string }>;
        structuredContent?: { runId?: string; status?: string; outputs?: Array<{ name?: string }> };
      };
      expect(runResult.structuredContent?.status).toBe("completed");
      expect(runResult.structuredContent?.outputs?.[0]?.name).toBe("README.md");
      expect(runResult.content?.[0]?.text).toContain("Workflow Run");

      const runId = runResult.structuredContent?.runId;
      if (typeof runId !== "string") {
        throw new Error("workflow.run did not return a runId");
      }

      const verify = (await server.handleMessage({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "run.verify",
          arguments: {
            runId,
            baseDir: ".bioflow"
          }
        }
      })) as any;

      const verifyResult = verify.result as {
        content?: Array<{ text?: string }>;
        structuredContent?: { valid?: boolean; errors?: string[] };
      };
      expect(verifyResult.structuredContent?.valid).toBe(true);
      expect(verifyResult.content?.[0]?.text).toContain("OK");

      const report = (await server.handleMessage({
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: {
          name: "report.generate",
          arguments: {
            runId,
            baseDir: ".bioflow",
            outDir: "reports"
          }
        }
      })) as any;

      const reportResult = report.result as {
        content?: Array<{ text?: string }>;
        structuredContent?: { artifact?: { sha256?: string }; outputPath?: string | null };
      };
      expect(reportResult.structuredContent?.artifact?.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(reportResult.structuredContent?.outputPath).toEqual(expect.stringContaining("reports"));
      expect(reportResult.content?.[0]?.text).toContain("Report Generation");

      const resources = (await server.handleMessage({
        jsonrpc: "2.0",
        id: 7,
        method: "resources/list",
        params: {}
      })) as any;
      const resourceUris = (resources.result as { resources?: Array<{ uri?: string }> } | undefined)?.resources?.map(
        (resource) => resource.uri
      );
      expect(resourceUris).toEqual(
        expect.arrayContaining([
          `bioflow://resource/run/${runId}/manifest`,
          `bioflow://resource/run/${runId}/execution`,
          `bioflow://resource/run/${runId}/report`
        ])
      );

      const manifestRead = (await server.handleMessage({
        jsonrpc: "2.0",
        id: 8,
        method: "resources/read",
        params: { uri: `bioflow://resource/run/${runId}/manifest` }
      })) as any;
      const manifestText = (manifestRead.result as { contents?: Array<{ text?: string }> } | undefined)?.contents?.[0]
        ?.text;
      expect(manifestText).toContain('"manifestVersion": 1');
      expect(manifestText).toContain(runId);

      const executionRead = (await server.handleMessage({
        jsonrpc: "2.0",
        id: 9,
        method: "resources/read",
        params: { uri: `bioflow://resource/run/${runId}/execution` }
      })) as any;
      const executionText = (executionRead.result as { contents?: Array<{ text?: string }> } | undefined)?.contents?.[0]
        ?.text;
      expect(executionText).toContain(`"runId": "${runId}"`);
      expect(executionText).toContain('"status": "completed"');

      const reportRead = (await server.handleMessage({
        jsonrpc: "2.0",
        id: 10,
        method: "resources/read",
        params: { uri: `bioflow://resource/run/${runId}/report` }
      })) as any;
      const reportText = (reportRead.result as { contents?: Array<{ text?: string }> } | undefined)?.contents?.[0]?.text;
      expect(reportText).toContain("# Validation Report");
      expect(reportText).toContain("Report digest");

      const sessionRead = (await server.handleMessage({
        jsonrpc: "2.0",
        id: 11,
        method: "resources/read",
        params: { uri: "bioflow://resource/mcp/session" }
      })) as any;
      const sessionText = (sessionRead.result as { contents?: Array<{ text?: string }> } | undefined)?.contents?.[0]
        ?.text;
      const sessionState = JSON.parse(sessionText ?? "{}") as {
        defaultAuth?: { orgId?: string; principal?: string };
        auditLog?: Array<{ action?: string }>;
      };
      expect(sessionState.defaultAuth?.orgId).toBe("11111111-1111-4111-8111-111111111111");
      expect(sessionState.defaultAuth?.principal).toContain("mcp:");
      expect(sessionState.auditLog?.map((entry) => entry.action)).toEqual(
        expect.arrayContaining([
          "session.started",
          "session.bound",
          "workflow.run.success",
          "report.generate.success"
        ])
      );
      expect(verifyAuditChain(sessionState.auditLog as never[]).ok).toBe(true);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("lists and reads remote sync resources from the bound session", async () => {
    const repoRoot = await createFixtureRepo();
    const originalFetch = globalThis.fetch;
    const remoteRunId = "22222222-2222-4222-8222-222222222222";
    const remoteSyncBundle = makeRemoteSyncBundle(remoteRunId);
    const requests: Array<{ url: string; headers: Record<string, string> }> = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const headers = Object.fromEntries(new Headers(request.headers).entries());
      requests.push({ url: request.url, headers });

      const url = new URL(request.url);
      if (url.pathname === "/api/v1/runs" && url.searchParams.get("limit") === "20") {
        return new Response(
          JSON.stringify({
            runs: [remoteSyncBundle.run],
            nextCursor: null
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      }

      if (url.pathname === `/api/v1/runs/${remoteRunId}/sync`) {
        return new Response(JSON.stringify(remoteSyncBundle), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }

      throw new Error(`Unexpected remote fetch: ${request.url}`);
    }) as typeof fetch;

    try {
      const server = await createBioFlowMcpServer({ repoRoot });
      const initialize = (await server.handleMessage({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          bioflow: {
            remoteUrl: "https://bioflow.example",
            token: "bf_test_remote",
            orgId: "22222222-2222-4222-8222-222222222221"
          }
        }
      })) as any;
      expect(initialize.result?.bioflow?.authMode).toBe("api-key");

      const resources = (await server.handleMessage({
        jsonrpc: "2.0",
        id: 2,
        method: "resources/list",
        params: {}
      })) as any;
      const resourceUris = (resources.result as { resources?: Array<{ uri?: string }> } | undefined)?.resources?.map(
        (resource) => resource.uri
      );
      expect(resourceUris).toEqual(
        expect.arrayContaining([`bioflow://resource/remote/run/${remoteRunId}/sync`])
      );

      const syncRead = (await server.handleMessage({
        jsonrpc: "2.0",
        id: 3,
        method: "resources/read",
        params: { uri: `bioflow://resource/remote/run/${remoteRunId}/sync` }
      })) as any;
      const syncText = (syncRead.result as { contents?: Array<{ text?: string }> } | undefined)?.contents?.[0]?.text;
      const syncState = JSON.parse(syncText ?? "{}") as {
        manifest?: { runId?: string };
        executionRecord?: { execution?: { runId?: string } };
      };
      expect(syncState.manifest?.runId).toBe(remoteRunId);
      expect(syncState.executionRecord?.execution?.runId).toBe(remoteRunId);

      expect(requests.some((request) => request.url.endsWith("/api/v1/runs?limit=20"))).toBe(true);
      expect(requests.some((request) => request.url.endsWith(`/api/v1/runs/${remoteRunId}/sync`))).toBe(true);

      const listRequest = requests.find((request) => request.url.endsWith("/api/v1/runs?limit=20"));
      expect(listRequest?.headers.authorization).toBe("Bearer bf_test_remote");
      expect(listRequest?.headers["x-org-id"]).toBe("22222222-2222-4222-8222-222222222221");
    } finally {
      globalThis.fetch = originalFetch;
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("ignores JSON-RPC notifications", async () => {
    const repoRoot = await createFixtureRepo();
    try {
      const server = await createBioFlowMcpServer({ repoRoot });
      expect(
        await server.handleMessage({
          jsonrpc: "2.0",
          method: "notifications/initialized"
        })
      ).toBeNull();

      expect(
        await server.handleMessage({
          jsonrpc: "2.0",
          method: "notifications/progress",
          params: { progress: 50 }
        })
      ).toBeNull();
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});
