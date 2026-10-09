# Architecture (simulation-first)

This repo is a **contract + runtime scaffold** for a workflow OS:

- **Connector mesh**: adapters that translate external events/API calls into normalized `Artifact` + `Event` bundles.
- **Workflow engine**: durable state transitions over a DAG of typed nodes with deterministic replay.
- **Execution runtime**: containerized tasks (later) that emit artifacts and append-only audit entries.

## Repo layers

- `src/core/*`: schema, hashing, audit chain, local runner.
- `src/core/connectors/*`: connector contract + default simulated connectors.
- `src/cli/*`: validation + local execution.
- `.bioflow/objects/*`: content-addressed objects (dedupe + integrity).
- `.bioflow/runs/*`: run manifests + execution records.

## Determinism & provenance

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

## Connector boundary (future)

Treat connectors as pure-ish functions:

- Input: normalized event payload + prior artifacts + connection config.
- Output: new artifacts + audit entries + structured status.

This makes it easy to swap local simulated connectors for real implementations without changing workflow contracts.
