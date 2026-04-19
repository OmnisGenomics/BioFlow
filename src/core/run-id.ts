import { randomUUID } from "node:crypto";

// Run IDs are expected to be stable across local <-> service sync boundaries.
// UUIDs are the simplest cross-system contract.
export function createRunId(_date?: Date): string {
  return randomUUID();
}
