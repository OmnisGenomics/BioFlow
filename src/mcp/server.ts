import { z } from "zod";
import path from "node:path";
import type { Artifact } from "../core/types.js";
import type { JsonRpcId, JsonRpcRequest, JsonRpcResponse, ResourceContent, ToolResult } from "./types.js";
import {
  buildRepositoryIndex,
  listRepositoryResources,
  readResource,
  renderRepoSummary,
  searchRepository,
  type RepositoryIndex,
  type SearchHit
} from "./catalog.js";
import { resolveRepoPath } from "./fs.js";
import { readWorkflowFile } from "../cli/io.js";
import { LocalArtifactStore } from "../core/artifact-store.js";
import { assertValidWorkflow, validateWorkflow } from "../core/validate.js";
import { runWorkflow } from "../core/engine.js";
import { verifyRun } from "../core/verify.js";
import { createRunId } from "../core/run-id.js";
import { generateGxpReport } from "../gxp/report.js";
import { pushRunToRemote, pullRunFromRemote } from "../sync/hybrid.js";
import { BioFlowRemote } from "../sync/remote.js";
import { MCP_SESSION_RESOURCE_URI, McpSession, type McpInvocationContext } from "./session.js";

const InitializeBioFlowSchema = z.object({
  remoteUrl: z.string().min(1).optional(),
  token: z.string().min(1).optional(),
  orgId: z.string().min(1).optional()
});

const InitializeRequestSchema = z.object({
  protocolVersion: z.string().min(1).optional(),
  capabilities: z.object({}).passthrough().optional(),
  clientInfo: z
    .object({
      name: z.string().min(1).optional(),
      version: z.string().min(1).optional()
    })
    .optional(),
  bioflow: InitializeBioFlowSchema.optional()
});

const ToolsListRequestSchema = z
  .object({
    cursor: z.string().min(1).optional()
  })
  .default({});

const ResourcesListRequestSchema = z
  .object({
    cursor: z.string().min(1).optional()
  })
  .default({});

const ReadResourceRequestSchema = z.object({
  uri: z.string().min(1)
});

const SearchToolArgsSchema = z.object({
  query: z.string().min(1),
  scope: z.enum(["all", "docs", "wiki"]).default("all"),
  limit: z.coerce.number().int().positive().max(20).default(8)
});

const WorkflowValidateArgsSchema = z.object({
  workflowPath: z.string().min(1)
});

const WorkflowRunArgsSchema = z.object({
  workflowPath: z.string().min(1),
  inputPaths: z.array(z.string().min(1)).default([]),
  baseDir: z.string().min(1).default(".bioflow"),
  runId: z.string().min(1).optional()
});

const VerifyRunArgsSchema = z.object({
  runId: z.string().min(1),
  baseDir: z.string().min(1).default(".bioflow"),
  replay: z.boolean().default(true)
});

const GenerateReportArgsSchema = z.object({
  runId: z.string().min(1),
  baseDir: z.string().min(1).default(".bioflow"),
  outDir: z.string().min(1).optional(),
  replay: z.boolean().default(true)
});

const RemoteConnectionArgsSchema = z.object({
  remoteUrl: z.string().min(1).optional(),
  token: z.string().min(1).optional(),
  orgId: z.string().min(1).optional()
});

const RemoteRunPushArgsSchema = RemoteConnectionArgsSchema.extend({
  runId: z.string().min(1),
  baseDir: z.string().min(1).default(".bioflow"),
  concurrency: z.coerce.number().int().positive().max(16).default(4),
  dryRun: z.boolean().default(false),
  profileId: z.string().min(1).optional(),
  tags: z.array(z.string().min(1)).default([]),
  visibility: z.enum(["private", "org", "public"]).default("org")
});

const RemoteRunPullArgsSchema = RemoteConnectionArgsSchema.extend({
  runId: z.string().min(1),
  baseDir: z.string().min(1).default(".bioflow"),
  concurrency: z.coerce.number().int().positive().max(16).default(4),
  force: z.boolean().default(false)
});

const RemoteRunVerifyArgsSchema = RemoteConnectionArgsSchema.extend({
  runId: z.string().min(1),
  deep: z.boolean().default(false)
});

const RemoteRunShareArgsSchema = RemoteConnectionArgsSchema.extend({
  runId: z.string().min(1),
  visibility: z.enum(["private", "org", "public"]).default("org")
});

const RemoteRunsListArgsSchema = RemoteConnectionArgsSchema.extend({
  limit: z.coerce.number().int().positive().max(100).default(20),
  cursor: z.string().min(1).optional(),
  profileId: z.string().min(1).optional(),
  tags: z.array(z.string().min(1)).default([]),
  visibility: z.enum(["private", "org", "public"]).optional()
});

const RemoteProfilesListArgsSchema = RemoteConnectionArgsSchema.extend({
  limit: z.coerce.number().int().positive().max(100).default(20)
});

const RemoteProfileGetArgsSchema = RemoteConnectionArgsSchema.extend({
  name: z.string().min(1)
});

const RemoteProfilePutArgsSchema = RemoteConnectionArgsSchema.extend({
  name: z.string().min(1),
  profile: z.unknown()
});

const RemoteRunSummarySchema = z
  .object({
    id: z.string().min(1)
  })
  .passthrough();

const RemoteRunsListResponseSchema = z
  .object({
    runs: z.array(RemoteRunSummarySchema).default([])
  })
  .passthrough();

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2024-11-05"] as const;

const REMOTE_CONNECTION_SCHEMA_PROPERTIES = {
  remoteUrl: { type: "string", minLength: 1 },
  token: { type: "string", minLength: 1 },
  orgId: { type: "string", minLength: 1 }
} as const;

interface ToolDefinition<TInput> {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  parse(input: unknown): TInput;
  run(input: TInput): Promise<ToolResult>;
}

interface ResourceLookup {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

export interface BioFlowMcpServerOptions {
  repoRoot: string;
}

export class BioFlowMcpServer {
  private readonly index: RepositoryIndex;
  private readonly tools = new Map<string, ToolDefinition<any>>();
  private readonly resources = new Map<string, ResourceLookup>();
  private readonly session: McpSession;

  private constructor(
    private readonly repoRoot: string,
    index: RepositoryIndex,
    session: McpSession
  ) {
    this.index = index;
    this.session = session;
    this.registerResources();
    this.registerTools();
  }

  static async create(options: BioFlowMcpServerOptions): Promise<BioFlowMcpServer> {
    const index = await buildRepositoryIndex(options.repoRoot);
    const session = await McpSession.create(options.repoRoot);
    return new BioFlowMcpServer(options.repoRoot, index, session);
  }

  async handleMessage(message: unknown): Promise<JsonRpcResponse | null> {
    if (!isJsonRpcRequest(message)) {
      return createErrorResponse(null, -32600, "Invalid request");
    }

    if (message.method === "notifications/initialized") {
      return null;
    }

    if (message.id === undefined) {
      return null;
    }

    switch (message.method) {
      case "initialize":
        return this.handleInitialize(message.id, message.params);
      case "ping":
        return maybeSuccess(message.id, {});
      case "tools/list":
        return this.handleToolsList(message.id, message.params);
      case "tools/call":
        return this.handleToolCall(message.id, message.params);
      case "resources/list":
        return this.handleResourcesList(message.id, message.params);
      case "resources/read":
        return this.handleResourceRead(message.id, message.params);
      case "workflow/validate":
        return this.handleWorkflowValidate(message.id, message.params);
      case "workflow/run":
        return this.handleWorkflowRun(message.id, message.params);
      case "run/verify":
        return this.handleRunVerify(message.id, message.params);
      case "report/generate":
        return this.handleReportGenerate(message.id, message.params);
      default:
        return createErrorResponse(message.id ?? null, -32601, `Method not found: ${message.method}`);
    }
  }

  private async handleInitialize(id: JsonRpcId, params: unknown): Promise<JsonRpcResponse> {
    const parsed = InitializeRequestSchema.safeParse(params ?? {});
    if (!parsed.success) {
      return createErrorResponse(id, -32602, "Invalid params", parsed.error.flatten());
    }

    if (parsed.data.bioflow) {
      await this.session.rebind(parsed.data.bioflow);
    }

    const protocolVersion = negotiateProtocolVersion(parsed.data.protocolVersion);
    return maybeSuccess(id, {
      protocolVersion,
      serverInfo: {
        name: "bioflow-mcp",
        version: this.index.packageJson.version ?? "0.0.1"
      },
      capabilities: {
        tools: {},
        resources: {}
      },
      bioflow: {
        sessionPrincipal: this.session.principal,
        authMode: this.session.defaultAuth.authMode,
        orgId: this.session.defaultAuth.orgId ?? null,
        remoteUrl: this.session.defaultAuth.remoteUrl,
        sessionAuditResource: MCP_SESSION_RESOURCE_URI
      },
      instructions:
        "Use `repo.summary` first, then `repo.search` or the wiki/doc resources. Workflow actions are repo-local, accept repo-relative paths, and cover validate, run, verify, and report. Remote sync/profile tools use `BIOFLOW_REMOTE_*` defaults or per-call overrides, and initialize may supply a `bioflow` object to bind the session principal. Run artifacts are exposed under `bioflow://resource/run/<runId>/manifest`, `bioflow://resource/run/<runId>/execution`, and `bioflow://resource/run/<runId>/report`. Remote durable sync bundles are exposed as `bioflow://resource/remote/run/<runId>/sync` when the session is bound to a remote org."
      });
  }

  private handleToolsList(id: JsonRpcId, params: unknown): JsonRpcResponse {
    const parsed = ToolsListRequestSchema.safeParse(params ?? {});
    if (!parsed.success) {
      return createErrorResponse(id, -32602, "Invalid params", parsed.error.flatten());
    }

    return maybeSuccess(id, {
      tools: [...this.tools.values()].map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema
      }))
    });
  }

  private async handleToolCall(id: JsonRpcId, params: unknown): Promise<JsonRpcResponse> {
    const parsed = z
      .object({
        name: z.string().min(1),
        arguments: z.unknown().optional()
      })
      .safeParse(params ?? {});

    if (!parsed.success) {
      return createErrorResponse(id, -32602, "Invalid params", parsed.error.flatten());
    }

    const tool = this.tools.get(parsed.data.name);
    if (!tool) {
      return createErrorResponse(id, -32602, `Unknown tool: ${parsed.data.name}`);
    }

    try {
      const input = tool.parse(parsed.data.arguments);
      const result = await tool.run(input);
      return maybeSuccess(id, result);
    } catch (error) {
      return createErrorResponse(
        id,
        -32603,
        error instanceof Error ? error.message : "Tool execution failed",
        error instanceof Error ? { stack: error.stack } : undefined
      );
    }
  }

  private async handleResourcesList(id: JsonRpcId, params: unknown): Promise<JsonRpcResponse> {
    const parsed = ResourcesListRequestSchema.safeParse(params ?? {});
    if (!parsed.success) {
      return createErrorResponse(id, -32602, "Invalid params", parsed.error.flatten());
    }

    return maybeSuccess(id, {
      resources: [
        ...(await listRepositoryResources(this.repoRoot, this.index)),
        this.sessionResourceDescriptor(),
        ...(await this.collectRemoteRunResources())
      ]
    });
  }

  private async handleResourceRead(id: JsonRpcId, params: unknown): Promise<JsonRpcResponse> {
    const parsed = ReadResourceRequestSchema.safeParse(params ?? {});
    if (!parsed.success) {
      return createErrorResponse(id, -32602, "Invalid params", parsed.error.flatten());
    }

    try {
      if (parsed.data.uri === MCP_SESSION_RESOURCE_URI) {
        return maybeSuccess(id, {
          contents: [
            {
              uri: parsed.data.uri,
              mimeType: "application/json",
              text: JSON.stringify(this.session.snapshotView, null, 2)
            } satisfies ResourceContent
          ]
        });
      }

      const remoteRunSync = parseRemoteRunSyncResourceUri(parsed.data.uri);
      if (remoteRunSync) {
        const content = await readRemoteRunSyncResource(remoteRunSync.runId, this.session.resolveInvocation());
        return maybeSuccess(id, {
          contents: [
            {
              uri: parsed.data.uri,
              mimeType: "application/json",
              text: content.text
            } satisfies ResourceContent
          ]
        });
      }

      const content = await readResource(this.repoRoot, parsed.data.uri, this.index);
      const descriptor = this.resources.get(parsed.data.uri);
      const mimeType = descriptor?.mimeType ?? content.mimeType;
      return maybeSuccess(id, {
        contents: [
          {
            uri: parsed.data.uri,
            mimeType,
            text: content.text
          } satisfies ResourceContent
        ]
      });
    } catch (error) {
      return createErrorResponse(
        id,
        -32602,
        error instanceof Error ? error.message : "Resource read failed",
        error instanceof Error ? { stack: error.stack } : undefined
      );
    }
  }

  private async handleWorkflowValidate(id: JsonRpcId, params: unknown): Promise<JsonRpcResponse> {
    const parsed = WorkflowValidateArgsSchema.safeParse(params ?? {});
    if (!parsed.success) {
      return createErrorResponse(id, -32602, "Invalid params", parsed.error.flatten());
    }

    try {
      return maybeSuccess(id, await performWorkflowValidate(this.repoRoot, parsed.data.workflowPath));
    } catch (error) {
      return createErrorResponse(
        id,
        -32603,
        error instanceof Error ? error.message : "Workflow validation failed",
        error instanceof Error ? { stack: error.stack } : undefined
      );
    }
  }

  private async handleWorkflowRun(id: JsonRpcId, params: unknown): Promise<JsonRpcResponse> {
    const parsed = WorkflowRunArgsSchema.safeParse(params ?? {});
    if (!parsed.success) {
      return createErrorResponse(id, -32602, "Invalid params", parsed.error.flatten());
    }

    try {
      return maybeSuccess(id, await performWorkflowRun(this.repoRoot, parsed.data));
    } catch (error) {
      return createErrorResponse(
        id,
        -32603,
        error instanceof Error ? error.message : "Workflow run failed",
        error instanceof Error ? { stack: error.stack } : undefined
      );
    }
  }

  private async handleRunVerify(id: JsonRpcId, params: unknown): Promise<JsonRpcResponse> {
    const parsed = VerifyRunArgsSchema.safeParse(params ?? {});
    if (!parsed.success) {
      return createErrorResponse(id, -32602, "Invalid params", parsed.error.flatten());
    }

    try {
      return maybeSuccess(id, await performRunVerify(this.repoRoot, parsed.data));
    } catch (error) {
      return createErrorResponse(
        id,
        -32603,
        error instanceof Error ? error.message : "Run verification failed",
        error instanceof Error ? { stack: error.stack } : undefined
      );
    }
  }

  private async handleReportGenerate(id: JsonRpcId, params: unknown): Promise<JsonRpcResponse> {
    const parsed = GenerateReportArgsSchema.safeParse(params ?? {});
    if (!parsed.success) {
      return createErrorResponse(id, -32602, "Invalid params", parsed.error.flatten());
    }

    try {
      return maybeSuccess(id, await performReportGenerate(this.repoRoot, parsed.data));
    } catch (error) {
      return createErrorResponse(
        id,
        -32603,
        error instanceof Error ? error.message : "Report generation failed",
        error instanceof Error ? { stack: error.stack } : undefined
      );
    }
  }

  private registerResources(): void {
    for (const resource of this.index.resources) {
      this.resources.set(resource.uri, resource);
    }
    this.resources.set(MCP_SESSION_RESOURCE_URI, this.sessionResourceDescriptor());
  }

  private registerTools(): void {
    this.tools.set("repo.summary", {
      name: "repo.summary",
      title: "Repository Summary",
      description: "Summarize the BioFlow repo using the generated wiki, roadmap, and workflow inventory.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false
      },
      parse: (input: unknown) => {
        if (input === undefined || input === null) return undefined;
        const parsed = z.object({}).strict().safeParse(input);
        if (!parsed.success) {
          throw new Error("repo.summary does not accept arguments");
        }
        return undefined;
      },
      run: async () => {
        const resources = await listRepositoryResources(this.repoRoot, this.index);
        const text = renderRepoSummary(this.index, resources);
        return {
          content: [{ type: "text", text }],
          structuredContent: {
            name: this.index.packageJson.name ?? "@bioflow/cli",
            version: this.index.packageJson.version ?? "0.0.1",
            topLevelDirectories: this.index.topLevelDirectories,
            workflowScripts: this.index.workflowScripts,
            wikiInventory: this.index.wikiInventory,
            resources: resources.slice(0, 16)
          }
        };
      }
    });

    this.tools.set("repo.search", {
      name: "repo.search",
      title: "Repository Search",
      description: "Search repo documentation and source for a phrase or set of terms.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1 },
          scope: { type: "string", enum: ["all", "docs", "wiki"] },
          limit: { type: "integer", minimum: 1, maximum: 20, default: 8 }
        },
        required: ["query"],
        additionalProperties: false
      },
      parse: (input: unknown) => SearchToolArgsSchema.parse(input ?? {}),
      run: async (input) => {
        const hits = await searchRepository(this.repoRoot, this.index, input.query, input.scope, input.limit);
        return {
          content: [{ type: "text", text: renderSearchResults(input.query, input.scope, hits) }],
          structuredContent: {
            query: input.query,
            scope: input.scope,
            limit: input.limit,
            hits
          }
        };
      }
    });

    this.tools.set("workflow.validate", {
      name: "workflow.validate",
      title: "Validate Workflow",
      description: "Validate a workflow definition from the repository.",
      inputSchema: {
        type: "object",
        properties: {
          workflowPath: { type: "string", minLength: 1 }
        },
        required: ["workflowPath"],
        additionalProperties: false
      },
      parse: (input: unknown) => WorkflowValidateArgsSchema.parse(input ?? {}),
      run: async (input) => performWorkflowValidate(this.repoRoot, input.workflowPath)
    });

    this.tools.set("workflow.run", {
      name: "workflow.run",
      title: "Run Workflow",
      description: "Run a repository workflow against local input files.",
      inputSchema: {
        type: "object",
        properties: {
          workflowPath: { type: "string", minLength: 1 },
          inputPaths: {
            type: "array",
            items: { type: "string", minLength: 1 }
          },
          baseDir: { type: "string", minLength: 1 },
          runId: { type: "string", minLength: 1 }
        },
        required: ["workflowPath"],
        additionalProperties: false
      },
      parse: (input: unknown) => WorkflowRunArgsSchema.parse(input ?? {}),
      run: async (input) =>
        this.withSessionMutation(
          "workflow.run",
          this.session.defaultAuth.principal,
          {
            workflowPath: input.workflowPath,
            baseDir: input.baseDir,
            runId: input.runId ?? null,
            inputCount: input.inputPaths.length
          },
          () => performWorkflowRun(this.repoRoot, input, this.session.defaultAuth.principal)
        )
    });

    this.tools.set("run.verify", {
      name: "run.verify",
      title: "Verify Run",
      description: "Verify a local run manifest, audit chain, and replay integrity.",
      inputSchema: {
        type: "object",
        properties: {
          runId: { type: "string", minLength: 1 },
          baseDir: { type: "string", minLength: 1 },
          replay: { type: "boolean" }
        },
        required: ["runId"],
        additionalProperties: false
      },
      parse: (input: unknown) => VerifyRunArgsSchema.parse(input ?? {}),
      run: async (input) => performRunVerify(this.repoRoot, input)
    });

    this.tools.set("report.generate", {
      name: "report.generate",
      title: "Generate Report",
      description: "Generate a deterministic GxP-style report for a local run.",
      inputSchema: {
        type: "object",
        properties: {
          runId: { type: "string", minLength: 1 },
          baseDir: { type: "string", minLength: 1 },
          outDir: { type: "string", minLength: 1 },
          replay: { type: "boolean" }
        },
        required: ["runId"],
        additionalProperties: false
      },
      parse: (input: unknown) => GenerateReportArgsSchema.parse(input ?? {}),
      run: async (input) =>
        this.withSessionMutation(
          "report.generate",
          this.session.defaultAuth.principal,
          {
            runId: input.runId,
            baseDir: input.baseDir,
            outDir: input.outDir ?? null,
            replay: input.replay
          },
          () => performReportGenerate(this.repoRoot, input)
        )
    });

    this.tools.set("remote.push", {
      name: "remote.push",
      title: "Push Run",
      description: "Upload a local run bundle to the configured remote service.",
      inputSchema: remoteConnectionInputSchema(
        {
          runId: { type: "string", minLength: 1 },
          baseDir: { type: "string", minLength: 1, default: ".bioflow" },
          concurrency: { type: "integer", minimum: 1, maximum: 16, default: 4 },
          dryRun: { type: "boolean", default: false },
          profileId: { type: "string", minLength: 1 },
          tags: {
            type: "array",
            items: { type: "string", minLength: 1 },
            default: []
          },
          visibility: { type: "string", enum: ["private", "org", "public"], default: "org" }
        },
        ["runId"]
      ),
      parse: (input: unknown) => RemoteRunPushArgsSchema.parse(input ?? {}),
      run: async (input) => {
        const invocation = this.session.resolveInvocation(input);
        return this.withSessionMutation(
          "remote.push",
          invocation.principal,
          {
            runId: input.runId,
            baseDir: input.baseDir,
            dryRun: input.dryRun,
            visibility: input.visibility,
            profileId: input.profileId ?? null,
            tags: input.tags
          },
          () => performRemotePush(this.repoRoot, input, invocation),
          invocation
        );
      }
    });

    this.tools.set("remote.pull", {
      name: "remote.pull",
      title: "Pull Run",
      description: "Download a remote run bundle into the local CAS and run store.",
      inputSchema: remoteConnectionInputSchema(
        {
          runId: { type: "string", minLength: 1 },
          baseDir: { type: "string", minLength: 1, default: ".bioflow" },
          concurrency: { type: "integer", minimum: 1, maximum: 16, default: 4 },
          force: { type: "boolean", default: false }
        },
        ["runId"]
      ),
      parse: (input: unknown) => RemoteRunPullArgsSchema.parse(input ?? {}),
      run: async (input) => {
        const invocation = this.session.resolveInvocation(input);
        return this.withSessionMutation(
          "remote.pull",
          invocation.principal,
          {
            runId: input.runId,
            baseDir: input.baseDir,
            force: input.force
          },
          () => performRemotePull(this.repoRoot, input, invocation),
          invocation
        );
      }
    });

    this.tools.set("remote.verify", {
      name: "remote.verify",
      title: "Verify Remote Run",
      description: "Verify a run directly through the remote service.",
      inputSchema: remoteConnectionInputSchema(
        {
          runId: { type: "string", minLength: 1 },
          deep: { type: "boolean", default: false }
        },
        ["runId"]
      ),
      parse: (input: unknown) => RemoteRunVerifyArgsSchema.parse(input ?? {}),
      run: async (input) => performRemoteVerify(input, this.session.resolveInvocation(input))
    });

    this.tools.set("remote.share", {
      name: "remote.share",
      title: "Share Run",
      description: "Update a remote run's visibility.",
      inputSchema: remoteConnectionInputSchema(
        {
          runId: { type: "string", minLength: 1 },
          visibility: { type: "string", enum: ["private", "org", "public"], default: "org" }
        },
        ["runId"]
      ),
      parse: (input: unknown) => RemoteRunShareArgsSchema.parse(input ?? {}),
      run: async (input) => {
        const invocation = this.session.resolveInvocation(input);
        return this.withSessionMutation(
          "remote.share",
          invocation.principal,
          {
            runId: input.runId,
            visibility: input.visibility
          },
          () => performRemoteShare(input, invocation),
          invocation
        );
      }
    });

    this.tools.set("remote.ls", {
      name: "remote.ls",
      title: "List Remote Runs",
      description: "List remote runs for the configured org.",
      inputSchema: remoteConnectionInputSchema(
        {
          limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
          cursor: { type: "string", minLength: 1 },
          profileId: { type: "string", minLength: 1 },
          tags: {
            type: "array",
            items: { type: "string", minLength: 1 },
            default: []
          },
          visibility: { type: "string", enum: ["private", "org", "public"] }
        },
        []
      ),
      parse: (input: unknown) => RemoteRunsListArgsSchema.parse(input ?? {}),
      run: async (input) => performRemoteListRuns(input, this.session.resolveInvocation(input))
    });

    this.tools.set("remote.profiles.list", {
      name: "remote.profiles.list",
      title: "List Remote Profiles",
      description: "List org-scoped workflow profiles from the remote service.",
      inputSchema: remoteConnectionInputSchema(
        {
          limit: { type: "integer", minimum: 1, maximum: 100, default: 20 }
        },
        []
      ),
      parse: (input: unknown) => RemoteProfilesListArgsSchema.parse(input ?? {}),
      run: async (input) => performRemoteListProfiles(input, this.session.resolveInvocation(input))
    });

    this.tools.set("remote.profiles.get", {
      name: "remote.profiles.get",
      title: "Get Remote Profile",
      description: "Fetch a single org-scoped workflow profile by name.",
      inputSchema: remoteConnectionInputSchema(
        {
          name: { type: "string", minLength: 1 }
        },
        ["name"]
      ),
      parse: (input: unknown) => RemoteProfileGetArgsSchema.parse(input ?? {}),
      run: async (input) => performRemoteGetProfile(input, this.session.resolveInvocation(input))
    });

    this.tools.set("remote.profiles.put", {
      name: "remote.profiles.put",
      title: "Store Remote Profile",
      description: "Create or update an org-scoped workflow profile.",
      inputSchema: remoteConnectionInputSchema(
        {
          name: { type: "string", minLength: 1 },
          profile: {
            type: "object",
            additionalProperties: true
          }
        },
        ["name", "profile"]
      ),
      parse: (input: unknown) => RemoteProfilePutArgsSchema.parse(input ?? {}),
      run: async (input) => {
        const invocation = this.session.resolveInvocation(input);
        return this.withSessionMutation(
          "remote.profiles.put",
          invocation.principal,
          {
            name: input.name,
            orgId: invocation.orgId ?? null
          },
          () => performRemotePutProfile(input, invocation),
          invocation
        );
      }
    });
  }

  private async collectRemoteRunResources(): Promise<ResourceLookup[]> {
    const invocation = this.session.resolveInvocation();
    if (invocation.authMode === "unbound") return [];

    try {
      const remote = createRemoteClient(invocation);
      const result = await remote.listRuns({ limit: 20 });
      const parsed = RemoteRunsListResponseSchema.safeParse(result);
      if (!parsed.success) return [];

      return parsed.data.runs.map((run) => remoteRunSyncResourceDescriptor(run.id));
    } catch {
      return [];
    }
  }

  private sessionResourceDescriptor(): ResourceLookup {
    return {
      uri: MCP_SESSION_RESOURCE_URI,
      name: "MCP Session Audit",
      description: "Current MCP session binding and chained audit log.",
      mimeType: "application/json"
    };
  }

  private async withSessionMutation<T>(
    action: string,
    actor: string,
    details: Record<string, unknown>,
    fn: () => Promise<T>,
    invocation?: McpInvocationContext
  ): Promise<T> {
    try {
      const result = await fn();
      await this.session.recordAction(`${action}.success`, details, actor, invocation);
      return result;
    } catch (error) {
      await this.session.recordAction(
        `${action}.failure`,
        {
          ...details,
          error: error instanceof Error ? error.message : String(error)
        },
        actor,
        invocation
      );
      throw error;
    }
  }
}

export async function createBioFlowMcpServer(options: BioFlowMcpServerOptions): Promise<BioFlowMcpServer> {
  return BioFlowMcpServer.create(options);
}

function renderSearchResults(query: string, scope: "all" | "docs" | "wiki", hits: SearchHit[]): string {
  if (hits.length === 0) {
    return [`# Search Results`, "", `No matches found for \`${query}\` in scope \`${scope}\`.`].join("\n");
  }

  const lines = [`# Search Results`, "", `Query: \`${query}\``, `Scope: \`${scope}\``, ""];
  for (const hit of hits) {
    lines.push(`- \`${hit.relativePath}\` (line ${hit.line})`);
    lines.push(`  - ${hit.snippet.replace(/\n/g, "\n    ")}`);
  }
  return lines.join("\n");
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { jsonrpc?: unknown }).jsonrpc === "2.0" &&
    typeof (value as { method?: unknown }).method === "string"
  );
}

function maybeSuccess<T>(id: JsonRpcId, result: T): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    result
  };
}

function createErrorResponse(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      data
    }
  };
}

function resolveRepoToolPath(repoRoot: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) {
    throw new Error(`MCP tool paths must be repo-relative: ${relativePath}`);
  }
  return resolveRepoPath(repoRoot, relativePath);
}

async function performWorkflowValidate(repoRoot: string, workflowPath: string): Promise<ToolResult> {
  const absoluteWorkflowPath = resolveRepoToolPath(repoRoot, workflowPath);
  const workflowInput = await readWorkflowFile(absoluteWorkflowPath);
  const result = validateWorkflow(workflowInput);
  return {
    content: [{ type: "text", text: renderWorkflowValidateResult(workflowPath, result) }],
    structuredContent: {
      workflowPath,
      ok: result.ok,
      issues: result.issues,
      workflow: result.workflow ?? null
    }
  };
}

async function performWorkflowRun(
  repoRoot: string,
  input: z.infer<typeof WorkflowRunArgsSchema>,
  actor = "mcp"
): Promise<ToolResult> {
  const absoluteWorkflowPath = resolveRepoToolPath(repoRoot, input.workflowPath);
  const workflowInput = await readWorkflowFile(absoluteWorkflowPath);
  const workflow = assertValidWorkflow(workflowInput);
  const baseDir = resolveRepoToolPath(repoRoot, input.baseDir);
  const store = new LocalArtifactStore(baseDir);
  const runId = input.runId ?? createRunId();
  const inputs: Artifact[] = [];

  for (const inputPath of input.inputPaths) {
    const absoluteInputPath = resolveRepoToolPath(repoRoot, inputPath);
    inputs.push(await store.importFile(runId, absoluteInputPath));
  }

  const result = await runWorkflow({
    workflow,
    store,
    inputs,
    actor,
    runId
  });

  return {
    content: [{ type: "text", text: renderWorkflowRunResult(input.workflowPath, result.execution.runId, result.execution.status, result.execution.outputs) }],
    structuredContent: {
      workflowPath: input.workflowPath,
      baseDir: input.baseDir,
      runId: result.execution.runId,
      status: result.execution.status,
      executionPath: result.executionPath ?? null,
      outputs: result.execution.outputs,
      nodeRuns: result.nodeRuns
    }
  };
}

async function performRunVerify(repoRoot: string, input: z.infer<typeof VerifyRunArgsSchema>): Promise<ToolResult> {
  const baseDir = resolveRepoToolPath(repoRoot, input.baseDir);
  const result = await verifyRun({ baseDir, runId: input.runId, replay: input.replay });
  return {
    content: [{ type: "text", text: renderVerifyResult(input.runId, result) }],
    structuredContent: {
      runId: input.runId,
      baseDir: input.baseDir,
      valid: result.valid,
      errors: result.errors
    }
  };
}

async function performReportGenerate(repoRoot: string, input: z.infer<typeof GenerateReportArgsSchema>): Promise<ToolResult> {
  const baseDir = resolveRepoToolPath(repoRoot, input.baseDir);
  const outDir = input.outDir ? resolveRepoToolPath(repoRoot, input.outDir) : undefined;
  const result = await generateGxpReport({
    baseDir,
    runId: input.runId,
    outDir,
    replay: input.replay
  });

  return {
    content: [
      {
        type: "text",
        text: renderReportResult(input.runId, result.outputPath ?? null, result.artifact.sha256, result.reportDigest)
      }
    ],
    structuredContent: {
      runId: input.runId,
      baseDir: input.baseDir,
      outputPath: result.outputPath ?? null,
      artifact: result.artifact,
      reportDigest: result.reportDigest
    }
  };
}

async function performRemotePush(
  repoRoot: string,
  input: z.infer<typeof RemoteRunPushArgsSchema>,
  invocation: McpInvocationContext
): Promise<ToolResult> {
  const remote = createRemoteClient(invocation);
  const baseDir = resolveRepoToolPath(repoRoot, input.baseDir);
  const result = await pushRunToRemote({
    baseDir,
    runId: input.runId,
    remote,
    concurrency: input.concurrency,
    dryRun: input.dryRun,
    profileId: input.profileId,
    tags: input.tags,
    visibility: input.visibility
  });

  return {
    content: [
      {
        type: "text",
        text: renderRemoteSummary("Remote Push", [
          `Run ID: \`${input.runId}\``,
          `Base dir: \`${input.baseDir}\``,
          `Dry run: \`${String(input.dryRun)}\``,
          `Uploaded: \`${String(result.uploaded)}\``,
          `Skipped: \`${String(result.skipped)}\``
        ], result.remoteResponse)
      }
    ],
    structuredContent: {
      runId: input.runId,
      baseDir: input.baseDir,
      dryRun: input.dryRun,
      uploaded: result.uploaded,
      skipped: result.skipped,
      remoteResponse: result.remoteResponse ?? null
    }
  };
}

async function performRemotePull(
  repoRoot: string,
  input: z.infer<typeof RemoteRunPullArgsSchema>,
  invocation: McpInvocationContext
): Promise<ToolResult> {
  const remote = createRemoteClient(invocation);
  const baseDir = resolveRepoToolPath(repoRoot, input.baseDir);
  const result = await pullRunFromRemote({
    baseDir,
    runId: input.runId,
    remote,
    concurrency: input.concurrency,
    force: input.force
  });

  return {
    content: [
      {
        type: "text",
        text: renderRemoteSummary("Remote Pull", [
          `Run ID: \`${input.runId}\``,
          `Base dir: \`${input.baseDir}\``,
          `Downloaded: \`${String(result.downloaded)}\``,
          `Skipped: \`${String(result.skipped)}\``
        ])
      }
    ],
    structuredContent: {
      runId: input.runId,
      baseDir: input.baseDir,
      downloaded: result.downloaded,
      skipped: result.skipped
    }
  };
}

async function performRemoteVerify(
  input: z.infer<typeof RemoteRunVerifyArgsSchema>,
  invocation: McpInvocationContext
): Promise<ToolResult> {
  const remote = createRemoteClient(invocation);
  const result = await remote.verifyRun(input.runId, { deep: input.deep });
  return {
    content: [
      {
        type: "text",
        text: renderRemoteSummary("Remote Verify", [`Run ID: \`${input.runId}\``, `Deep: \`${String(input.deep)}\``], result)
      }
    ],
    structuredContent: {
      runId: input.runId,
      deep: input.deep,
      response: result
    }
  };
}

async function performRemoteShare(
  input: z.infer<typeof RemoteRunShareArgsSchema>,
  invocation: McpInvocationContext
): Promise<ToolResult> {
  const remote = createRemoteClient(invocation);
  const result = await remote.shareRun(input.runId, input.visibility);
  return {
    content: [
      {
        type: "text",
        text: renderRemoteSummary("Remote Share", [
          `Run ID: \`${input.runId}\``,
          `Visibility: \`${input.visibility}\``
        ], result)
      }
    ],
    structuredContent: {
      runId: input.runId,
      visibility: input.visibility,
      response: result
    }
  };
}

async function performRemoteListRuns(
  input: z.infer<typeof RemoteRunsListArgsSchema>,
  invocation: McpInvocationContext
): Promise<ToolResult> {
  const remote = createRemoteClient(invocation);
  const result = await remote.listRuns({
    limit: input.limit,
    cursor: input.cursor,
    profileId: input.profileId,
    tags: input.tags.length ? input.tags.join(",") : undefined,
    visibility: input.visibility
  });
  return {
    content: [
      {
        type: "text",
        text: renderRemoteSummary("Remote Runs", [`Limit: \`${String(input.limit)}\``], result)
      }
    ],
    structuredContent: {
      limit: input.limit,
      cursor: input.cursor ?? null,
      profileId: input.profileId ?? null,
      tags: input.tags,
      visibility: input.visibility ?? null,
      response: result
    }
  };
}

async function performRemoteListProfiles(
  input: z.infer<typeof RemoteProfilesListArgsSchema>,
  invocation: McpInvocationContext
): Promise<ToolResult> {
  const remote = createRemoteClient(invocation);
  const result = await remote.listProfiles({ limit: input.limit });
  return {
    content: [
      {
        type: "text",
        text: renderRemoteSummary("Remote Profiles", [`Limit: \`${String(input.limit)}\``], result)
      }
    ],
    structuredContent: {
      limit: input.limit,
      response: result
    }
  };
}

async function performRemoteGetProfile(
  input: z.infer<typeof RemoteProfileGetArgsSchema>,
  invocation: McpInvocationContext
): Promise<ToolResult> {
  const remote = createRemoteClient(invocation);
  const result = await remote.getProfile(input.name);
  return {
    content: [
      {
        type: "text",
        text: renderRemoteSummary("Remote Profile", [`Name: \`${input.name}\``], result)
      }
    ],
    structuredContent: {
      name: input.name,
      response: result
    }
  };
}

async function performRemotePutProfile(
  input: z.infer<typeof RemoteProfilePutArgsSchema>,
  invocation: McpInvocationContext
): Promise<ToolResult> {
  const remote = createRemoteClient(invocation);
  const result = await remote.upsertProfile(input.name, input.profile);
  return {
    content: [
      {
        type: "text",
        text: renderRemoteSummary("Remote Profile Stored", [`Name: \`${input.name}\``], result)
      }
    ],
    structuredContent: {
      name: input.name,
      response: result
    }
  };
}

function renderWorkflowValidateResult(workflowPath: string, result: ReturnType<typeof validateWorkflow>): string {
  if (result.ok) {
    return [`# Workflow Validation`, "", `OK: \`${workflowPath}\``, `Issues: none`].join("\n");
  }

  const lines = [`# Workflow Validation`, "", `FAIL: \`${workflowPath}\``, "", "Issues:"];
  for (const issue of result.issues) {
    lines.push(`- ${issue.path}: ${issue.message}`);
  }
  return lines.join("\n");
}

function renderWorkflowRunResult(
  workflowPath: string,
  runId: string,
  status: string,
  outputs: Artifact[]
): string {
  const outputLines = outputs.length
    ? outputs.map((artifact) => `- ${artifact.name}: ${artifact.sha256}`)
    : ["- none"];
  return [
    "# Workflow Run",
    "",
    `Workflow: \`${workflowPath}\``,
    `Run ID: \`${runId}\``,
    `Status: \`${status}\``,
    "",
    "Outputs:",
    ...outputLines
  ].join("\n");
}

function renderVerifyResult(runId: string, result: { valid: boolean; errors: string[] }): string {
  if (result.valid) {
    return [`# Run Verification`, "", `OK: \`${runId}\``, "Errors: none"].join("\n");
  }

  const lines = [`# Run Verification`, "", `FAIL: \`${runId}\``, "", "Errors:"];
  for (const error of result.errors) {
    lines.push(`- ${error}`);
  }
  return lines.join("\n");
}

function renderReportResult(runId: string, outputPath: string | null, artifactSha256: string, reportDigest: string): string {
  const lines = [`# Report Generation`, "", `Run ID: \`${runId}\``, `Report digest: \`${reportDigest}\``, `Artifact sha256: \`${artifactSha256}\``];
  if (outputPath) {
    lines.push(`Output path: \`${outputPath}\``);
  }
  return lines.join("\n");
}

function renderRemoteSummary(title: string, lines: string[], payload?: unknown): string {
  const out = [`# ${title}`, "", ...lines];
  if (payload !== undefined) {
    out.push("", "Response:", JSON.stringify(payload, null, 2));
  }
  return out.join("\n");
}

function remoteRunSyncResourceDescriptor(runId: string): ResourceLookup {
  return {
    uri: pathToRemoteRunSyncResourceUri(runId),
    name: `Remote Run ${runId} Sync`,
    description: "Durable remote sync payload with manifest and execution record.",
    mimeType: "application/json"
  };
}

function pathToRemoteRunSyncResourceUri(runId: string): string {
  return `bioflow://resource/remote/run/${encodeURIComponent(runId)}/sync`;
}

function parseRemoteRunSyncResourceUri(uri: string): { runId: string } | null {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== "bioflow:" || parsed.hostname !== "resource") return null;
    const segments = parsed.pathname
      .replace(/^\/+/, "")
      .split("/")
      .map((segment) => decodeURIComponent(segment))
      .filter(Boolean);

    if (segments.length !== 4) return null;
    if (segments[0] !== "remote" || segments[1] !== "run" || segments[3] !== "sync") return null;

    const runId = segments[2]!;
    if (!runId.length) return null;
    return { runId };
  } catch {
    return null;
  }
}

async function readRemoteRunSyncResource(
  runId: string,
  invocation: McpInvocationContext
): Promise<{ mimeType: string; text: string }> {
  if (invocation.authMode === "unbound") {
    throw new Error("Remote sync resources require a bound MCP session");
  }

  const remote = createRemoteClient(invocation);
  const payload = await remote.getRunSync(runId);
  return {
    mimeType: "application/json",
    text: JSON.stringify(payload, null, 2)
  };
}

function createRemoteClient(input: McpInvocationContext): BioFlowRemote {
  return new BioFlowRemote({
    baseUrl: input.remoteUrl,
    auth: {
      token: input.token,
      orgId: input.orgId
    }
  });
}

function remoteConnectionInputSchema(extraProperties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      ...REMOTE_CONNECTION_SCHEMA_PROPERTIES,
      ...extraProperties
    },
    required,
    additionalProperties: false
  };
}

function negotiateProtocolVersion(requested?: string): string {
  if (requested && SUPPORTED_PROTOCOL_VERSIONS.includes(requested as (typeof SUPPORTED_PROTOCOL_VERSIONS)[number])) {
    return requested;
  }

  return SUPPORTED_PROTOCOL_VERSIONS[0];
}
