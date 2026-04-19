import path from "node:path";
import { existsSync, readFileSync } from "node:fs";

export function resolveRepoRoot(startDir: string = process.cwd()): string {
  let current = path.resolve(startDir);

  for (;;) {
    if (isRepoRoot(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(startDir);
    current = parent;
  }
}

export function isRepoRoot(candidate: string): boolean {
  return existsSync(path.join(candidate, "package.json")) && existsSync(path.join(candidate, "docs", "wiki", "index.md"));
}

export function normalizeRepoRelativePath(value: string): string {
  const normalized = path.posix.normalize(value.replace(/\\/g, "/")).replace(/^\/+/, "");
  if (!normalized || normalized === "." || normalized.startsWith("..")) {
    throw new Error(`Invalid repo-relative path: ${value}`);
  }
  return normalized;
}

export function resolveRepoPath(repoRoot: string, relativePath: string): string {
  const normalized = normalizeRepoRelativePath(relativePath);
  const absolute = path.resolve(repoRoot, normalized);
  const relative = path.relative(repoRoot, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes repository root: ${relativePath}`);
  }
  return absolute;
}

export function pathToFileUri(relativePath: string): string {
  return `bioflow://file/${normalizeRepoRelativePath(relativePath)}`;
}

export function pathToWikiUri(relativePath: string): string {
  const normalized = normalizeRepoRelativePath(relativePath);
  const withoutPrefix = normalized.startsWith("docs/wiki/") ? normalized.slice("docs/wiki/".length) : normalized;
  const withoutExt = withoutPrefix.endsWith(".md") ? withoutPrefix.slice(0, -3) : withoutPrefix;
  return `bioflow://wiki/${withoutExt}`;
}

export function fileUriToRepoPath(uri: string): string | null {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== "bioflow:") return null;

    if (parsed.hostname === "file") {
      return normalizeRepoRelativePath(decodeURIComponent(parsed.pathname.replace(/^\/+/, "")));
    }

    if (parsed.hostname === "wiki") {
      const wikiPath = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
      return normalizeRepoRelativePath(path.posix.join("docs/wiki", `${wikiPath}.md`));
    }

    return null;
  } catch {
    return null;
  }
}

export function readTextIfExists(filePath: string): string | null {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

export function isSearchableTextFile(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  if (normalized === "package.json") return true;
  if (normalized.startsWith("docs/") || normalized.startsWith("src/") || normalized.startsWith("test/") || normalized.startsWith("scripts/") || normalized.startsWith("examples/")) {
    return [".md", ".ts", ".js", ".json", ".yaml", ".yml", ".sh", ".py", ".toml", ".txt"].some((ext) => normalized.endsWith(ext));
  }
  return false;
}

