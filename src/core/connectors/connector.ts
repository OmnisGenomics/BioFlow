import type { Artifact } from "../types.js";
import type { ArtifactStore } from "../artifact-store.js";
import type { DeterministicRng } from "../rng.js";

export interface ConnectorContext {
  runId: string;
  nodeId: string;
  operation: string;
  invocationId: string;
  params: Record<string, unknown>;
  inputs: Artifact[];
  store: ArtifactStore;
  rng: DeterministicRng;
}

export interface ConnectorResult {
  outputs: Artifact[];
  costUSD: number;
  notes?: string | undefined;
}

export interface Connector {
  id: string;
  invoke(ctx: ConnectorContext): Promise<ConnectorResult>;
}
