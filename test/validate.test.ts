import { describe, expect, it } from "vitest";
import { validateWorkflow } from "../src/core/validate.js";

describe("validateWorkflow", () => {
  it("rejects unknown node references", () => {
    const res = validateWorkflow({
      id: "w",
      version: "1.0.0",
      nodes: [{ id: "start", kind: "trigger.manual" }],
      edges: [{ from: "start", to: "missing" }]
    });
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => i.message.includes("Unknown node id"))).toBe(true);
  });

  it("rejects cycles", () => {
    const res = validateWorkflow({
      id: "w",
      version: "1.0.0",
      nodes: [
        { id: "a", kind: "trigger.manual" },
        { id: "b", kind: "transform.score" }
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "a" }
      ]
    });
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => i.message.includes("cycle"))).toBe(true);
  });
});

