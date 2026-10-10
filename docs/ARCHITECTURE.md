# Architecture

BioFlow executes local workflows and stores their inputs, outputs, and execution records.

- Connectors implement operations such as sample-sheet cleanup and simulated service responses.
- The workflow runner executes a directed acyclic graph of typed nodes.
- Artifact storage saves file contents by hash. Manifests and audit entries record what happened during each run.

## Repo layers

- `src/core/*`: schema, hashing, audit chain, local runner.
- `src/core/connectors/*`: connector contract + default simulated connectors.
- `src/cli/*`: validation + local execution.
- `.bioflow/objects/*`: content-addressed objects (dedupe + integrity).
- `.bioflow/runs/*`: run manifests + execution records.

## Reproducible outputs and execution records

- Each run computes `workflowDigest = sha256(stableStringify(workflow))`.
- Every audit entry is chained: `hash = sha256({at, actor, action, details, prevHash})`.
- Node outputs are written to a content-addressed store (`sha256:<hash>`).
- Node output *content* is seed-based and deterministic; wall-clock timestamps are kept in the audit log instead.

## Verification

`bioflow verify <runId>` checks:

- Nonempty audit chain integrity and expected execution/snapshot/node events, checked against the execution record and stored workflow (also when replay is disabled)
- CAS object integrity (re-hash on read)
- Deterministic replay output digests match recorded outputs

Completed runs require evidence for every workflow node and a final `execution_completed` event. Failed runs require a final `node_failed` event; the current runner does not emit `execution_completed` for failures. These local consistency checks detect missing or inconsistent evidence but do not authenticate provenance: someone able to rewrite all evidence can recompute an unkeyed hash chain.

## Connector interface

Connectors receive an operation's inputs and return artifacts and status:

- Input: normalized event payload + prior artifacts + connection config.
- Output: new artifacts + audit entries + structured status.

The current examples use simulated service connectors. Real integrations need their own implementation and validation.
