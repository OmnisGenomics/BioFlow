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

- Audit chain integrity
- CAS object integrity (re-hash on read)
- Deterministic replay output digests match recorded outputs

## Connector boundary (future)

Treat connectors as pure-ish functions:

- Input: normalized event payload + prior artifacts + connection config.
- Output: new artifacts + audit entries + structured status.

This makes it easy to swap local simulated connectors for real implementations without changing workflow contracts.
