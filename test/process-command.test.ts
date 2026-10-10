import path from "node:path";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { bioflowCommand, npmCommand, resolveNpmCli, sourceCommand } from "../scripts/lib/process-command.js";

describe("shell-free process commands", () => {
  it("preserves source argv, env, cwd, Unicode and shell metacharacters without PATH", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "bioflow argv & spaces "));
    const args = ["two words", 'literal "quotes"', "λ日本語", "trailing\\", "", "%PATH%", "$HOME",
      "& echo injected > injected.txt", "$(echo injected)", "a;b", "line\nbreak"];
    try {
      const result = spawnSync(...sourceCommand("test/fixtures/process-argv.ts", args), {
        cwd, env: { ...process.env, PATH: "", Path: "", BIOFLOW_ARGV_TEST_MARKER: "literal env & λ" }, encoding: "utf8"
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ args, cwd, marker: "literal env & λ" });
      expect(existsSync(path.join(cwd, "injected.txt"))).toBe(false);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it("preserves the CLI's nonzero help status when spawned asynchronously", async () => {
    const result = await new Promise<{ status: number | null; stdout: string }>((resolve, reject) => {
      const child = spawn(...bioflowCommand(["autopilot:run", "--help"]), { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.resume();
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, stdout }));
    });
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("bioflow autopilot:run");
  });

  it("launches npm's JS entrypoint with literal argv from a path containing spaces and ampersands", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "bioflow npm & spaces "));
    const npmExecPath = path.join(cwd, "npm-cli.js");
    const args = ["two words", '"quoted"', "& echo injected > injected.txt", "%PATH%", "λ"];
    try {
      await writeFile(npmExecPath, "console.log(JSON.stringify(process.argv.slice(2)));\n");
      const result = spawnSync(...npmCommand(args, { npmExecPath }), { cwd, encoding: "utf8" });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(args);
      expect(existsSync(path.join(cwd, "injected.txt"))).toBe(false);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it.each(["node_modules/npm/bin/npm-cli.js", "../lib/node_modules/npm/bin/npm-cli.js"])(
    "finds the Node installation fallback %s and rejects batch shims", async (relative) => {
      const cwd = await mkdtemp(path.join(tmpdir(), "bioflow npm lookup "));
      const execPath = path.join(cwd, "bin", "node");
      const expected = path.resolve(path.dirname(execPath), relative);
      try {
        await mkdir(path.dirname(expected), { recursive: true });
        await writeFile(expected, "");
        expect(resolveNpmCli({ execPath, npmExecPath: path.join(cwd, "npm.cmd") })).toBe(expected);
      } finally { await rm(cwd, { recursive: true, force: true }); }
    }
  );

  it("fails clearly if npm is unavailable instead of starting a shell", () => {
    expect(() => resolveNpmCli({ execPath: path.join(tmpdir(), "missing-node", "node"), npmExecPath: "npm.cmd" }))
      .toThrow(/Cannot locate npm-cli.js/);
  });
});
