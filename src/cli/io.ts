import { readFile } from "node:fs/promises";
import YAML from "yaml";

export async function readWorkflowFile(filePath: string): Promise<unknown> {
  const raw = await readFile(filePath, "utf8");
  if (filePath.endsWith(".yaml") || filePath.endsWith(".yml")) return YAML.parse(raw);
  return JSON.parse(raw);
}

