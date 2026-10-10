import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { nodeCommand } from "./lib/process-command.js";

const require = createRequire(import.meta.url);
const result = spawnSync(...nodeCommand(require.resolve("vitest/vitest.mjs"), [
  "run", "--pool=threads", "--poolOptions.threads.singleThread=true", "test/packaged-cli.test.ts"
]), { env: { ...process.env, BIOFLOW_RUN_PACKAGED_CLI_TEST: "1" }, stdio: "inherit" });
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
