// Test-only preload: inject faults at one exact path inside a test workspace.
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";

const target = process.env.BIOFLOW_TEST_WRITE_TARGET;
const marker = process.env.BIOFLOW_TEST_WRITE_MARKER;
const mode = process.env.BIOFLOW_TEST_WRITE_MODE;
if (!target || !marker || !path.isAbsolute(target) || !path.isAbsolute(marker)) {
  throw new Error("Recovery fault fixture requires absolute target and marker paths");
}
const originalWriteFile = fs.writeFile;
const originalOpen = fs.open;
async function fault() {
  if (mode === "throw") throw new Error("Injected recovery write failure");
  if (mode !== "pause") throw new Error("Unknown recovery fault mode");
  await originalWriteFile(marker, "paused after partial write");
  setInterval(() => {}, 1_000);
  await new Promise(() => {});
}
fs.writeFile = async function(file, data, ...args) {
  if (typeof file !== "string" || path.resolve(file) !== target) {
    return originalWriteFile(file, data, ...args);
  }
  await originalWriteFile(file, Buffer.from(data).subarray(0, 8), ...args);
  await fault();
};
fs.open = async function(file, ...args) {
  const handle = await originalOpen(file, ...args);
  if (typeof file === "string" && path.resolve(file) === target) {
    const write = handle.writeFile.bind(handle);
    handle.writeFile = async data => {
      await write(Buffer.from(data).subarray(0, 8));
      await fault();
    };
  }
  return handle;
};
syncBuiltinESMExports();
