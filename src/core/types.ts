export type ComplianceMode = "GLP" | "GMP" | "Research";

export type ExecutionStatus =
  | "pending"
  | "running"
  | "paused"
  | "completed"
  | "failed";

export type NodeKind =
  | "trigger.manual"
  | "transform.score"
  | "report.aggregate"
  | "action.connector"
  | "sink.eln_sim";

export interface Workflow {
  id: string;
  version: string; // semver-ish (validated)
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  env?: Record<string, string> | undefined;
  compliance?: ComplianceMode | undefined;
  seed?: string | undefined; // deterministic runs
}

export interface WorkflowNode {
  id: string;
  kind: NodeKind;
  name?: string | undefined;
  config?: Record<string, unknown> | undefined;
}

export interface WorkflowEdge {
  from: string;
  to: string;
}

export interface Artifact {
  name: string;
  uri: string;
  sha256: string;
  bytes: number;
  mediaType?: string | undefined;
  kind?: string | undefined;
  createdAt: string; // ISO timestamp
}

export interface AuditEntry {
  at: string; // ISO timestamp
  actor: string;
  action: string;
  details: Record<string, unknown>;
  prevHash: string | null;
  hash: string;
}

export interface RuntimeInfo {
  nodeVersion: string;
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
}

export interface Execution {
  workflowId: string;
  workflowVersion: string;
  workflowDigest: string;
  runId: string;
  status: ExecutionStatus;
  startedAt: string;
  endedAt?: string | undefined;
  inputs: Artifact[];
  outputs: Artifact[];
  auditLog: AuditEntry[];
  costUSD: number;
  runtime: RuntimeInfo;
}

export interface NodeRun {
  nodeId: string;
  kind: NodeKind;
  status: "ok" | "skipped" | "failed";
  startedAt: string;
  endedAt: string;
  inputs: Artifact[];
  outputs: Artifact[];
  costUSD: number;
  notes?: string | undefined;
  error?: string | undefined;
}
