import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

describe("self-serve smoke script CLI", () => {
  it("prints usage and exits with code 2 for --help", () => {
    const result = spawnSync(npmCmd, ["run", "demo:self-serve:smoke", "--", "--help"], {
      cwd: path.resolve("."),
      env: process.env,
      encoding: "utf8"
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Usage:");
    expect(result.stderr).toContain("demo:self-serve:smoke");
    expect(result.stderr).toContain("--out <path>");
  }, 30_000);

  it("prints usage and exits with code 2 for invalid args", () => {
    const result = spawnSync(npmCmd, ["run", "demo:self-serve:smoke", "--", "--key-mode", "invalid"], {
      cwd: path.resolve("."),
      env: process.env,
      encoding: "utf8"
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Usage:");
  }, 30_000);

  it("prints usage and exits with code 2 for missing --out value", () => {
    const result = spawnSync(npmCmd, ["run", "demo:self-serve:smoke", "--", "--out"], {
      cwd: path.resolve("."),
      env: process.env,
      encoding: "utf8"
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Usage:");
    expect(result.stderr).toContain("--out <path>");
  }, 30_000);
});
