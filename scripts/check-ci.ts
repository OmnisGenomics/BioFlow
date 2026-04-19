import { spawnSync } from "node:child_process";

const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

const timeoutSignatures = [
  /Test timed out in \d+ms/i,
  /Hook timed out in \d+ms/i,
  /close timed out after \d+ms/i
];

function run(args: string[], captureOutput = false): RunResult {
  const result = spawnSync(npmCmd, args, {
    stdio: captureOutput ? "pipe" : "inherit",
    encoding: "utf8"
  });
  return {
    status: typeof result.status === "number" ? result.status : 1,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : ""
  };
}

function isKnownTimeoutFlake(output: string): boolean {
  return timeoutSignatures.some((pattern) => pattern.test(output));
}

function main(): void {
  const checkResult = run(["run", "check"], true);
  if (checkResult.stdout) process.stdout.write(checkResult.stdout);
  if (checkResult.stderr) process.stderr.write(checkResult.stderr);
  if (checkResult.status !== 0) {
    const combinedOutput = `${checkResult.stdout}\n${checkResult.stderr}`;
    if (isKnownTimeoutFlake(combinedOutput)) {
      console.error("Known CI scheduler flake class: service integration under load");
    }

    console.error("check failed; rerunning diagnostics with verbose test reporter (will still fail)");
    run(["run", "typecheck"]);
    run(["run", "test", "--", "--reporter", "verbose"]);
    run(["run", "verify:golden"]);
    process.exitCode = 1;
    return;
  }

  const serviceIntegrationResult = run(["run", "test:service:integration"], true);
  if (serviceIntegrationResult.stdout) process.stdout.write(serviceIntegrationResult.stdout);
  if (serviceIntegrationResult.stderr) process.stderr.write(serviceIntegrationResult.stderr);
  if (serviceIntegrationResult.status !== 0) {
    console.error("test:service:integration failed");
    process.exitCode = 1;
    return;
  }

  const packagedCliResult = run(["run", "test:packaged-cli"], true);
  if (packagedCliResult.stdout) process.stdout.write(packagedCliResult.stdout);
  if (packagedCliResult.stderr) process.stderr.write(packagedCliResult.stderr);
  if (packagedCliResult.status !== 0) {
    console.error("test:packaged-cli failed");
    process.exitCode = 1;
  }
}

main();
