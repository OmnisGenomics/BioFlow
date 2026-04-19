import { describe, expect, it } from "vitest";
import path from "node:path";
import { rm } from "node:fs/promises";
import { LocalArtifactStore } from "../src/core/artifact-store.js";
import { runWorkflow } from "../src/core/engine.js";
import type { Workflow } from "../src/core/types.js";

describe("engine", () => {
  it("is deterministic given the same seed and inputs", async () => {
    const base = path.resolve(".bioflow_test");
    await rm(base, { recursive: true, force: true });
    const store = new LocalArtifactStore(base);

    const workflow: Workflow = {
      id: "t",
      version: "1.0.0",
      seed: "seed",
      nodes: [
        { id: "start", kind: "trigger.manual" },
        { id: "score", kind: "transform.score" },
        { id: "report", kind: "report.aggregate" },
        {
          id: "writeback",
          kind: "action.connector",
          config: { connector: "eln_sim", operation: "writeback", params: { destination: "x" } }
        }
      ],
      edges: [
        { from: "start", to: "score" },
        { from: "score", to: "report" },
        { from: "report", to: "writeback" }
      ]
    };

    const input = await store.putBytes({
      runId: "inputs",
      name: "a.txt",
      bytes: new TextEncoder().encode("hello")
    });

    const r1 = await runWorkflow({ workflow, store, inputs: [input], actor: "test", runId: "r1" });
    const r2 = await runWorkflow({ workflow, store, inputs: [input], actor: "test", runId: "r2" });

    expect(r1.execution.status).toBe("completed");
    expect(r2.execution.status).toBe("completed");
    expect(r1.execution.outputs[0]!.sha256).toBe(r2.execution.outputs[0]!.sha256);
  }, 20_000);
});
