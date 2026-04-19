import path from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

interface ExtractedCommand {
  filePath: string;
  line: number;
  command: string;
}

interface ValidationIssue {
  filePath: string;
  line: number;
  command: string;
  reason: string;
}

const SHELL_FENCE_LANGUAGES = new Set(["bash", "sh", "shell"]);

const LOCAL_BIOFLOW_SUBCOMMANDS = new Set([
  "autopilot:run",
  "autopilot:validate-summary",
  "autopilot:check-policy",
  "autopilot:gate",
  "init",
  "validate",
  "run",
  "verify",
  "report",
  "tidy",
  "push",
  "pull",
  "ls-remote",
  "ls",
  "share",
  "mcp",
  "verify-remote",
  "profiles ls",
  "profiles get",
  "profiles put"
]);

const HOSTED_ONLY_BIOFLOW_SUBCOMMANDS = new Set(["auth:set-key", "auth:signup"]);

describe("docs command consistency", () => {
  it("keeps README/docs commands aligned with scripts and bioflow CLI subcommands", async () => {
    const scripts = await loadPackageScripts();
    const markdownFiles = await loadMarkdownFiles();
    const commands = await extractCommandsFromFiles(markdownFiles);
    const issues = validateCommands(commands, scripts);

    expect(issues, formatIssues(issues)).toEqual([]);
  }, 20_000);
});

async function loadPackageScripts(): Promise<Set<string>> {
  const packageJsonPath = path.resolve("package.json");
  const raw = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const scripts = raw && typeof raw === "object" && raw.scripts && typeof raw.scripts === "object" ? raw.scripts : {};
  return new Set(Object.keys(scripts));
}

async function loadMarkdownFiles(): Promise<string[]> {
  const docsDir = path.resolve("docs");
  const entries = await readdir(docsDir, { withFileTypes: true });
  const docFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => path.join(docsDir, entry.name))
    .sort((a, b) => a.localeCompare(b));
  return [path.resolve("README.md"), ...docFiles];
}

async function extractCommandsFromFiles(filePaths: string[]): Promise<ExtractedCommand[]> {
  const out: ExtractedCommand[] = [];
  for (const filePath of filePaths) {
    const raw = await readFile(filePath, "utf8");
    out.push(...extractCommandsFromMarkdown(filePath, raw));
  }
  return out;
}

function extractCommandsFromMarkdown(filePath: string, markdown: string): ExtractedCommand[] {
  const lines = markdown.split("\n");
  let inFence = false;
  let captureFence = false;
  let block: Array<{ line: number; text: string }> = [];
  const commands: ExtractedCommand[] = [];

  for (let index = 0; index < lines.length; index++) {
    const lineNo = index + 1;
    const text = lines[index] ?? "";

    if (!inFence) {
      const open = text.match(/^```(.*)$/);
      if (!open) continue;
      inFence = true;
      const info = open[1]?.trim().toLowerCase() ?? "";
      const language = info.split(/\s+/)[0] ?? "";
      captureFence = SHELL_FENCE_LANGUAGES.has(language);
      block = [];
      continue;
    }

    if (/^```/.test(text)) {
      if (captureFence) commands.push(...normalizeBlockCommands(filePath, block));
      inFence = false;
      captureFence = false;
      block = [];
      continue;
    }

    if (captureFence) {
      block.push({ line: lineNo, text });
    }
  }

  if (inFence && captureFence && block.length > 0) {
    commands.push(...normalizeBlockCommands(filePath, block));
  }

  return commands;
}

function normalizeBlockCommands(
  filePath: string,
  lines: Array<{ line: number; text: string }>
): ExtractedCommand[] {
  const out: ExtractedCommand[] = [];
  let current = "";
  let startLine = 0;

  const flush = () => {
    if (!current) return;
    const normalized = normalizeCommand(current);
    if (normalized) out.push({ filePath, line: startLine, command: normalized });
    current = "";
    startLine = 0;
  };

  for (const entry of lines) {
    const trimmed = entry.text.trim();
    if (!trimmed) {
      flush();
      continue;
    }

    if (!current) startLine = entry.line;
    current = current ? `${current} ${trimmed}` : trimmed;

    if (/\\+$/.test(trimmed)) {
      current = current.replace(/\\+$/, "").trimEnd();
      continue;
    }

    flush();
  }

  flush();
  return out;
}

function normalizeCommand(command: string): string | null {
  let normalized = command.trim();
  if (!normalized || normalized.startsWith("#")) return null;

  normalized = normalized.replace(/^\$\s+/, "");
  normalized = normalized.replace(/\s+#.*$/, "").trim();
  if (!normalized) return null;

  normalized = stripLeadingEnvAssignments(normalized);
  return normalized || null;
}

function stripLeadingEnvAssignments(command: string): string {
  let value = command.trim();
  for (;;) {
    const match = value.match(/^([A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+))\s+/);
    if (!match) break;
    value = value.slice(match[0].length).trimStart();
  }
  return value.trim();
}

function validateCommands(commands: ExtractedCommand[], scripts: Set<string>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const command of commands) {
    if (command.command.startsWith("npm run ")) {
      validateNpmRunCommand(command, scripts, issues);
      continue;
    }

    if (command.command.startsWith("bioflow ")) {
      const detail = validateBioflowSubcommand(command.command.slice("bioflow ".length));
      if (detail) {
        issues.push({ ...command, reason: detail });
      }
    }
  }

  return issues;
}

function validateNpmRunCommand(
  command: ExtractedCommand,
  scripts: Set<string>,
  issues: ValidationIssue[]
): void {
  const match = command.command.match(/^npm\s+run\s+([^\s]+)(?:\s+(.*))?$/);
  if (!match) {
    issues.push({ ...command, reason: "malformed npm run command" });
    return;
  }

  const script = match[1] ?? "";
  const remainder = (match[2] ?? "").trim();
  if (!scripts.has(script)) {
    issues.push({ ...command, reason: `unknown npm script: ${script}` });
    return;
  }

  if (script !== "bioflow") return;

  const cliArgs = remainder.startsWith("--") ? remainder.replace(/^--\s*/, "") : remainder;
  const detail = validateBioflowSubcommand(cliArgs);
  if (detail) {
    issues.push({ ...command, reason: detail });
  }
}

function validateBioflowSubcommand(rawArgs: string): string | null {
  const args = rawArgs.trim();
  if (!args) return "missing bioflow subcommand";

  const parts = args.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "missing bioflow subcommand";

  const first = parts[0] ?? "";
  const candidate =
    first === "profiles"
      ? parts.length >= 2
        ? `profiles ${parts[1]}`
        : "profiles"
      : first;

  if (LOCAL_BIOFLOW_SUBCOMMANDS.has(candidate)) return null;
  if (HOSTED_ONLY_BIOFLOW_SUBCOMMANDS.has(candidate)) return null;
  return `unknown bioflow subcommand: ${candidate}`;
}

function formatIssues(issues: ValidationIssue[]): string {
  if (issues.length === 0) return "no issues";
  return [
    "command validation failures:",
    ...issues.map(
      (issue) =>
        `- ${path.relative(process.cwd(), issue.filePath)}:${issue.line} \`${issue.command}\` -> ${issue.reason}`
    )
  ].join("\n");
}
