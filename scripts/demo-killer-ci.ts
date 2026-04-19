import { spawn } from "node:child_process";
import { access } from "node:fs/promises";

interface Assertion {
  name: string;
  pattern: RegExp;
}

const assertions: Assertion[] = [
  { name: "runId marker", pattern: /^runId=killer-demo-v1$/m },
  { name: "execution marker", pattern: /^execution=completed$/m },
  { name: "verify marker", pattern: /^verify=OK$/m },
  { name: "report hash marker", pattern: /^report\.sha256=[0-9a-f]{64}$/m },
  { name: "report path marker", pattern: /^report\.path=.+$/m }
];

async function main(): Promise<void> {
  const output = await runDemoKiller();
  const missing = assertions.filter((assertion) => !assertion.pattern.test(output));
  const reportPath = extractReportPath(output);

  if (missing.length > 0) {
    throw withCapturedOutput(output, `missing assertions: ${missing.map((item) => item.name).join(", ")}`);
  }

  if (!reportPath) {
    throw withCapturedOutput(output, "missing assertions: report path marker");
  }
  try {
    await access(reportPath);
  } catch {
    throw withCapturedOutput(output, `report path does not exist: ${reportPath}`);
  }

  console.log("OK: demo:killer smoke assertions passed");
}

async function runDemoKiller(): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("npm", ["run", "-s", "demo:killer"], {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      reject(error);
    });
    child.on("close", (code) => {
      const output = `${stdout}${stderr}`;
      if (code !== 0) {
        reject(
          new Error(
            [
              `demo:killer exited with code ${String(code)}`,
              "--- begin captured output ---",
              output.trimEnd(),
              "--- end captured output ---"
            ].join("\n")
          )
        );
        return;
      }
      resolve(output);
    });
  });
}

function extractReportPath(output: string): string | null {
  const match = output.match(/^report\.path=(.+)$/m);
  if (!match) return null;
  const path = match[1]?.trim() ?? "";
  return path.length > 0 ? path : null;
}

function withCapturedOutput(output: string, reason: string): Error {
  return new Error(
    [
      "demo:killer smoke assertion failed",
      reason,
      "--- begin captured output ---",
      output.trimEnd(),
      "--- end captured output ---"
    ].join("\n")
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
