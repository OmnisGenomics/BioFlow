# Security & compliance notes (software-only)

This project is designed around **traceability and isolation** as first-class primitives.

## Tamper-evident audit

- Audit entries are append-only and chained via SHA-256 hashes.
- A verifier can recompute and detect mutation.
- Run verification also requires the expected lifecycle events and checks their details against the execution record and stored workflow. An empty or truncated audit is invalid, even if the remaining chain hashes correctly.
- These are integrity and consistency checks, not authenticated provenance. SHA-256 chains alone cannot establish who created evidence or prevent someone with write access from replacing the evidence and recomputing its hashes.

## Tenant isolation (target state)

- Strong namespace separation per tenant for metadata and artifacts.
- Customer-managed keys (envelope encryption) for secrets and object storage.

## Deterministic replay

- Runs record workflow digest + runtime info to support replay/verification.
- Node execution in this repo is seeded and deterministic by construction.

