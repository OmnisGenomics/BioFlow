#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import type { Readable, Writable } from "node:stream";
import { createBioFlowMcpServer } from "./server.js";
import { isRepoRoot, resolveRepoRoot } from "./fs.js";
import { serveStdio } from "./stdio.js";

export interface RunBioFlowMcpOptions {
  repoRoot?: string | undefined;
  stdin?: Readable | undefined;
  stdout?: Writable | undefined;
}

export async function runBioFlowMcp(options: RunBioFlowMcpOptions = {}): Promise<void> {
  const startDir = options.repoRoot ?? process.env.BIOFLOW_MCP_REPO_ROOT ?? process.cwd();
  const repoRoot = resolveRepoRoot(startDir);
  if (!isRepoRoot(repoRoot)) {
    throw new Error(`Unable to locate a BioFlow repository root from ${startDir}`);
  }

  const server = await createBioFlowMcpServer({ repoRoot });
  await serveStdio(options.stdin ?? process.stdin, options.stdout ?? process.stdout, (message) => server.handleMessage(message));
}

async function main(): Promise<void> {
  await runBioFlowMcp();
}

const isMainModule = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;

if (isMainModule) {
  void main().catch((error) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
