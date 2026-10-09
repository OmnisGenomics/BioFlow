import path from "node:path";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const repoRoot = new URL("../../", import.meta.url);
type Command = [executable: string, args: string[]];

// Pass argv directly to Node: no npm batch shim, PATH lookup, or shell quoting.
export function sourceCommand(script: string, args: string[] = []): Command {
  return [process.execPath, ["--import", pathToFileURL(require.resolve("tsx")).href,
    fileURLToPath(new URL(script, repoRoot)), ...args]];
}

export function bioflowCommand(args: string[]): Command {
  return sourceCommand("src/cli/main.ts", args);
}

export function nodeCommand(script: string, args: string[]): Command {
  return [process.execPath, [script, ...args]];
}

interface NpmLocation {
  npmExecPath?: string | undefined;
  execPath?: string | undefined;
}

export function resolveNpmCli(options: NpmLocation = {}): string {
  const execPath = options.execPath ?? process.execPath;
  const npmExecPath = options.npmExecPath ?? process.env.npm_execpath;
  const candidates = [
    ...(npmExecPath && path.isAbsolute(npmExecPath) && path.basename(npmExecPath) === "npm-cli.js"
      ? [npmExecPath] : []),
    path.join(path.dirname(execPath), "node_modules/npm/bin/npm-cli.js"),
    path.resolve(path.dirname(execPath), "../lib/node_modules/npm/bin/npm-cli.js")
  ];
  const cli = candidates.find((candidate) => existsSync(candidate));
  if (!cli) throw new Error("Cannot locate npm-cli.js; run through npm or use a Node installation containing npm");
  return cli;
}

export function npmCommand(args: string[], options: NpmLocation = {}): Command {
  return nodeCommand(resolveNpmCli(options), args);
}
