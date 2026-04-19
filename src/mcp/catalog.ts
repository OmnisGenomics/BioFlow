import path from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";
import { LocalCAS } from "../core/cas.js";
import { RunManifestSchema } from "../core/run-manifest.js";
import { fileUriToRepoPath, isSearchableTextFile, normalizeRepoRelativePath, pathToFileUri, pathToWikiUri, readTextIfExists, resolveRepoPath } from "./fs.js";

export interface ResourceDescriptor {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

export interface SearchHit {
  resourceUri: string;
  relativePath: string;
  line: number;
  snippet: string;
}

export interface WikiInventory {
  files: number;
  components: number;
  workflows: number;
}

export interface RepositoryIndex {
  repoRoot: string;
  packageJson: {
    name?: string;
    version?: string;
    description?: string;
    private?: boolean;
    scripts?: Record<string, string>;
  };
  topLevelDirectories: string[];
  workflowScripts: string[];
  wikiInventory: WikiInventory | null;
  resources: ResourceDescriptor[];
  searchablePaths: string[];
}

const TOP_DOC_PATHS = [
  "README.md",
  "package.json",
  "docs/ARCHITECTURE.md",
  "docs/AUTOPILOT_GATE_RUNBOOK.md",
  "docs/BIOFLOW_HOSTED_BETA_VALIDATION_BUNDLE.md",
  "docs/DEPLOYMENT.md",
  "docs/HOSTED_BETA_QUICKSTART.md",
  "docs/MCP.md",
  "docs/ROADMAP.md",
  "docs/SECURITY.md",
  "docs/SERVICE.md",
  "docs/SELF_SERVICE_P0_PLAN.md",
  "docs/WORKFLOW_SPEC.md",
  "src/cli/main.ts",
  "src/core/engine.ts",
  "src/core/validate.ts",
  "src/core/verify.ts",
  "src/service/api/server.ts",
  "src/service/config.ts",
  "src/sync/remote.ts"
];

export async function buildRepositoryIndex(repoRoot: string): Promise<RepositoryIndex> {
  const packageJson = await readJsonFile<RepositoryIndex["packageJson"]>(path.join(repoRoot, "package.json"));
  const workflowScripts = Object.keys(packageJson.scripts ?? {});
  const topLevelDirectories = await readTopLevelDirectories(repoRoot);
  const wikiInventory = await readWikiInventory(repoRoot);
  const resources = await buildResourceCatalog(repoRoot);
  const searchablePaths = await collectSearchablePaths(repoRoot);

  return {
    repoRoot,
    packageJson,
    topLevelDirectories,
    workflowScripts,
    wikiInventory,
    resources,
    searchablePaths
  };
}

export async function listRepositoryResources(repoRoot: string, index?: RepositoryIndex): Promise<ResourceDescriptor[]> {
  const resolvedIndex = index ?? (await buildRepositoryIndex(repoRoot));
  const resources = [...resolvedIndex.resources];
  resources.push(...(await collectRunResources(repoRoot)));
  return dedupeResources(resources);
}

export async function readResource(repoRoot: string, uri: string, index?: RepositoryIndex): Promise<{ mimeType: string; text: string }> {
  const generated = await readGeneratedResource(repoRoot, uri, index);
  if (generated) return generated;

  const repoRelativePath = fileUriToRepoPath(uri);
  if (!repoRelativePath) {
    throw new Error(`Unsupported resource URI: ${uri}`);
  }

  const absolutePath = resolveRepoPath(repoRoot, repoRelativePath);
  const text = await readFile(absolutePath, "utf8");
  return {
    mimeType: mimeTypeForPath(repoRelativePath),
    text
  };
}

export async function searchRepository(
  repoRoot: string,
  index: RepositoryIndex,
  query: string,
  scope: "all" | "docs" | "wiki" = "all",
  limit = 8
): Promise<SearchHit[]> {
  const terms = normalizeQueryTerms(query);
  if (terms.length === 0) return [];

  const searchablePaths = filterSearchablePaths(index.searchablePaths, scope);
  const hits: SearchHit[] = [];

  for (const relativePath of searchablePaths) {
    if (hits.length >= limit) break;
    const absolutePath = resolveRepoPath(repoRoot, relativePath);
    const text = await readFile(absolutePath, "utf8");
    const lines = text.split(/\r?\n/);
    const matchIndex = findFirstMatchingLine(lines, terms);
    if (matchIndex < 0) continue;

    hits.push({
      resourceUri: relativePath.startsWith("docs/wiki/")
        ? pathToWikiUri(relativePath)
        : pathToFileUri(relativePath),
      relativePath,
      line: matchIndex + 1,
      snippet: buildSnippet(lines, matchIndex, terms)
    });
  }

  return hits;
}

export function renderRepoSummary(index: RepositoryIndex, resources: ResourceDescriptor[] = index.resources): string {
  const packageName = index.packageJson.name ?? "@bioflow/cli";
  const version = index.packageJson.version ?? "0.0.1";
  const description = index.packageJson.description ?? "BioFlow repository";
  const wikiInventory = index.wikiInventory
    ? `${index.wikiInventory.files} files, ${index.wikiInventory.components} components, ${index.wikiInventory.workflows} workflows`
    : "wiki inventory unavailable";
  const workflowSamples = index.workflowScripts.slice(0, 8).map((script) => `\`${script}\``).join(", ");
  const resourceSamples = resources.slice(0, 8).map((resource) => `\`${resource.uri}\``).join(", ");

  return [
    "# BioFlow MCP",
    "",
    `Package: \`${packageName}\` v${version}`,
    `Description: ${description}`,
    `Top-level directories: ${index.topLevelDirectories.map((dir) => `\`${dir}\``).join(", ")}`,
    `Wiki inventory: ${wikiInventory}`,
    `Workflow scripts: ${workflowSamples || "none detected"}`,
    `Suggested resources: ${resourceSamples || "none"}`,
    "",
    "Start with `bioflow://resource/repo-summary`, `bioflow://wiki/index`, `bioflow://wiki/workflows`, `docs/ROADMAP.md`, and `README.md`."
  ].join("\n");
}

export function renderWorkflowInventory(index: RepositoryIndex): string {
  const lines = ["# Workflow Inventory", ""];
  lines.push(`Detected ${index.workflowScripts.length} package scripts.`);
  lines.push("");
  for (const script of index.workflowScripts) {
    lines.push(`- \`${script}\``);
  }
  lines.push("");
  lines.push("Primary operational docs:");
  lines.push("- `bioflow://wiki/workflows`");
  lines.push("- `docs/ROADMAP.md`");
  lines.push("- `docs/SERVICE.md`");
  lines.push("- `docs/HOSTED_BETA_QUICKSTART.md`");
  return lines.join("\n");
}

async function buildResourceCatalog(repoRoot: string): Promise<ResourceDescriptor[]> {
  const resources: ResourceDescriptor[] = [
    {
      uri: "bioflow://resource/repo-summary",
      name: "Repository Summary",
      description: "Generated overview of the repository, workflows, and wiki context.",
      mimeType: "text/markdown"
    },
    {
      uri: "bioflow://resource/workflow-inventory",
      name: "Workflow Inventory",
      description: "Generated inventory of package scripts and operational surfaces.",
      mimeType: "text/markdown"
    }
  ];

  for (const relativePath of TOP_DOC_PATHS) {
    const absolutePath = path.join(repoRoot, relativePath);
    if (!(await exists(absolutePath))) continue;
    resources.push({
      uri: relativePath.startsWith("docs/wiki/")
        ? pathToWikiUri(relativePath)
        : pathToFileUri(relativePath),
      name: resourceNameFromPath(relativePath),
      description: resourceDescriptionFromPath(relativePath),
      mimeType: mimeTypeForPath(relativePath)
    });
  }

  for await (const relativePath of collectMarkdownWikiPaths(repoRoot)) {
    resources.push({
      uri: pathToWikiUri(relativePath),
      name: resourceNameFromPath(relativePath),
      description: "Generated wiki page.",
      mimeType: "text/markdown"
    });
  }

  return dedupeResources(resources);
}

async function* collectMarkdownWikiPaths(repoRoot: string): AsyncGenerator<string> {
  const wikiRoot = path.join(repoRoot, "docs", "wiki");
  if (!(await exists(wikiRoot))) return;
  yield* collectMarkdownPathsRecursive(wikiRoot, "docs/wiki");
}

async function* collectMarkdownPathsRecursive(absoluteDir: string, repoRelativeDir: string): AsyncGenerator<string> {
  const entries = await readdir(absoluteDir, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = path.join(absoluteDir, entry.name);
    const relativePath = path.posix.join(repoRelativeDir, entry.name);
    if (entry.isDirectory()) {
      yield* collectMarkdownPathsRecursive(absolutePath, relativePath);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) {
      yield relativePath.replace(/\\/g, "/");
    }
  }
}

async function readWikiInventory(repoRoot: string): Promise<WikiInventory | null> {
  const text = readTextIfExists(path.join(repoRoot, "docs", "wiki", "index.md"));
  if (!text) return null;
  const match = text.match(/Inventory:\s*(\d+)\s+files,\s*(\d+)\s+components,\s*(\d+)\s+workflows/i);
  if (!match) return null;
  const [, files, components, workflows] = match;
  return {
    files: Number(files),
    components: Number(components),
    workflows: Number(workflows)
  };
}

async function readGeneratedResource(
  repoRoot: string,
  uri: string,
  index?: RepositoryIndex
): Promise<{ mimeType: string; text: string } | null> {
  if (uri === "bioflow://resource/repo-summary") {
    const resolvedIndex = index ?? (await buildRepositoryIndex(repoRoot));
    return { mimeType: "text/markdown", text: renderRepoSummary(resolvedIndex) };
  }

  if (uri === "bioflow://resource/workflow-inventory") {
    const resolvedIndex = index ?? (await buildRepositoryIndex(repoRoot));
    return { mimeType: "text/markdown", text: renderWorkflowInventory(resolvedIndex) };
  }

  const runResource = parseRunResourceUri(uri);
  if (runResource) {
    return readRunResource(repoRoot, runResource.runId, runResource.kind);
  }

  return null;
}

type RunResourceKind = "manifest" | "execution" | "report";

interface ParsedRunResourceUri {
  runId: string;
  kind: RunResourceKind;
}

async function collectRunResources(repoRoot: string): Promise<ResourceDescriptor[]> {
  const runRoot = resolveRepoPath(repoRoot, path.posix.join(".bioflow", "runs"));
  if (!(await exists(runRoot))) return [];

  const entries = await readdir(runRoot, { withFileTypes: true });
  const resources: ResourceDescriptor[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runId = entry.name;
    const runDir = path.join(runRoot, runId);
    const manifestPath = path.join(runDir, "manifest.json");
    const executionPath = path.join(runDir, "execution.json");

    if (await exists(manifestPath)) {
      resources.push(runResourceDescriptor(runId, "manifest"));
    }

    if (await exists(executionPath)) {
      resources.push(runResourceDescriptor(runId, "execution"));
    }

    if (await manifestHasReportArtifact(manifestPath)) {
      resources.push(runResourceDescriptor(runId, "report"));
    }
  }

  return resources;
}

function runResourceDescriptor(runId: string, kind: RunResourceKind): ResourceDescriptor {
  return {
    uri: pathToRunResourceUri(runId, kind),
    name: runResourceName(runId, kind),
    description: runResourceDescription(kind),
    mimeType: runResourceMimeType(kind)
  };
}

function pathToRunResourceUri(runId: string, kind: RunResourceKind): string {
  return `bioflow://resource/run/${encodeURIComponent(runId)}/${kind}`;
}

function runResourceName(runId: string, kind: RunResourceKind): string {
  return `Run ${runId} ${kind[0]!.toUpperCase()}${kind.slice(1)}`;
}

function runResourceDescription(kind: RunResourceKind): string {
  switch (kind) {
    case "manifest":
      return "Run manifest JSON stored under .bioflow/runs/<runId>/manifest.json.";
    case "execution":
      return "Execution record JSON stored under .bioflow/runs/<runId>/execution.json.";
    case "report":
      return "Deterministic report artifact recorded for the run.";
  }
}

function runResourceMimeType(kind: RunResourceKind): string {
  switch (kind) {
    case "manifest":
    case "execution":
      return "application/json";
    case "report":
      return "text/markdown";
  }
}

function parseRunResourceUri(uri: string): ParsedRunResourceUri | null {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== "bioflow:" || parsed.hostname !== "resource") return null;
    const segments = parsed.pathname
      .replace(/^\/+/, "")
      .split("/")
      .map((segment) => decodeURIComponent(segment))
      .filter(Boolean);

    if (segments.length !== 3) return null;
    if (segments[0] !== "run") return null;

    const runId = segments[1]!;
    const kind = segments[2] as RunResourceKind;
    if (!isRunResourceKind(kind)) return null;
    return { runId, kind };
  } catch {
    return null;
  }
}

function isRunResourceKind(value: string): value is RunResourceKind {
  return value === "manifest" || value === "execution" || value === "report";
}

async function readRunResource(
  repoRoot: string,
  runId: string,
  kind: RunResourceKind
): Promise<{ mimeType: string; text: string }> {
  const baseDir = resolveRepoPath(repoRoot, ".bioflow");
  const runDir = path.join(baseDir, "runs", runId);

  switch (kind) {
    case "manifest": {
      const text = await readFile(path.join(runDir, "manifest.json"), "utf8");
      return { mimeType: "application/json", text };
    }
    case "execution": {
      const text = await readFile(path.join(runDir, "execution.json"), "utf8");
      return { mimeType: "application/json", text };
    }
    case "report": {
      const manifestPath = path.join(runDir, "manifest.json");
      const manifest = RunManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
      const report = manifest.artifacts["gxp-report.md"];
      if (!report) {
        throw new Error(`Run ${runId} does not contain a gxp-report.md artifact`);
      }

      const cas = new LocalCAS(baseDir);
      const text = await readFile(cas.objectPath(report.sha256), "utf8");
      return { mimeType: report.mediaType ?? "text/markdown", text };
    }
  }
}

async function manifestHasReportArtifact(manifestPath: string): Promise<boolean> {
  try {
    const manifest = RunManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
    return Boolean(manifest.artifacts["gxp-report.md"]);
  } catch {
    return false;
  }
}

async function collectSearchablePaths(repoRoot: string): Promise<string[]> {
  const roots = [
    "README.md",
    "package.json",
    "docs",
    "src",
    "test",
    "scripts",
    "examples",
    "db"
  ];
  const out = new Set<string>();

  for (const root of roots) {
    const absolute = path.join(repoRoot, root);
    if (!(await exists(absolute))) continue;
    const stats = await stat(absolute);
    if (stats.isFile()) {
      if (isSearchableTextFile(root)) out.add(normalizeRepoRelativePath(root));
      continue;
    }
    if (stats.isDirectory()) {
      for await (const relativePath of walkSearchableFiles(absolute, root)) {
        out.add(relativePath);
      }
    }
  }

  return [...out].sort((a, b) => a.localeCompare(b));
}

async function readTopLevelDirectories(repoRoot: string): Promise<string[]> {
  const entries = await readdir(repoRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "dist" && entry.name !== "node_modules")
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

async function* walkSearchableFiles(absoluteDir: string, repoRelativeDir: string): AsyncGenerator<string> {
  const entries = await readdir(absoluteDir, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = path.join(absoluteDir, entry.name);
    const relativePath = normalizeRepoRelativePath(path.posix.join(repoRelativeDir, entry.name));
    if (shouldSkipPath(relativePath, entry.isDirectory())) continue;

    if (entry.isDirectory()) {
      yield* walkSearchableFiles(absolutePath, relativePath);
      continue;
    }

    if (entry.isFile() && isSearchableTextFile(relativePath)) {
      const stats = await stat(absolutePath);
      if (stats.size <= 1_500_000) {
        yield relativePath;
      }
    }
  }
}

function shouldSkipPath(relativePath: string, isDirectory: boolean): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  if (normalized.startsWith(".git/") || normalized === ".git") return true;
  if (normalized.startsWith("node_modules/") || normalized === "node_modules") return true;
  if (normalized.startsWith("dist/") || normalized === "dist") return true;
  if (normalized.startsWith(".bioflow/") || normalized === ".bioflow") return true;
  if (normalized.startsWith(".cache/") || normalized === ".cache") return true;
  if (isDirectory && normalized === "tmp") return true;
  return false;
}

function filterSearchablePaths(paths: string[], scope: "all" | "docs" | "wiki"): string[] {
  switch (scope) {
    case "wiki":
      return paths.filter((path) => path.startsWith("docs/wiki/"));
    case "docs":
      return paths.filter((path) => path === "README.md" || path === "package.json" || path.startsWith("docs/"));
    case "all":
      return paths;
  }
}

function dedupeResources(resources: ResourceDescriptor[]): ResourceDescriptor[] {
  const seen = new Set<string>();
  const out: ResourceDescriptor[] = [];
  for (const resource of resources) {
    if (seen.has(resource.uri)) continue;
    seen.add(resource.uri);
    out.push(resource);
  }
  return out.sort((a, b) => a.uri.localeCompare(b.uri));
}

function resourceNameFromPath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/");
  if (normalized === "README.md") return "README";
  if (normalized === "package.json") return "package.json";
  const base = path.basename(normalized, path.extname(normalized));
  return base
    .replace(/^component-/, "component ")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function resourceDescriptionFromPath(relativePath: string): string {
  if (relativePath.startsWith("docs/wiki/")) return "Generated wiki page.";
  if (relativePath.startsWith("docs/")) return "Repository documentation.";
  if (relativePath.startsWith("src/")) return "Repository source file.";
  if (relativePath === "README.md") return "Repository overview.";
  if (relativePath === "package.json") return "Package manifest and workflow scripts.";
  return "Repository file.";
}

function mimeTypeForPath(relativePath: string): string {
  if (relativePath.endsWith(".md")) return "text/markdown";
  if (relativePath.endsWith(".json")) return "application/json";
  if (relativePath.endsWith(".yaml") || relativePath.endsWith(".yml")) return "text/yaml";
  if (relativePath.endsWith(".ts") || relativePath.endsWith(".js")) return "text/plain";
  return "text/plain";
}

function normalizeQueryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);
}

function findFirstMatchingLine(lines: string[], terms: string[]): number {
  for (let index = 0; index < lines.length; index++) {
    const normalized = lines[index]?.toLowerCase() ?? "";
    if (terms.every((term) => normalized.includes(term))) {
      return index;
    }
  }
  return -1;
}

function buildSnippet(lines: string[], matchIndex: number, terms: string[]): string {
  const before = Math.max(0, matchIndex - 1);
  const after = Math.min(lines.length - 1, matchIndex + 1);
  const windowLines = lines.slice(before, after + 1);
  const highlighted = windowLines
    .map((line, offset) => {
      const lineNumber = before + offset + 1;
      return `${lineNumber}: ${truncateLine(line.trim(), terms)}`;
    })
    .join("\n");
  return highlighted;
}

function truncateLine(value: string, terms: string[]): string {
  const max = 220;
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw) as T;
}
