# Security & compliance notes (software-only)

This project is designed around **traceability and isolation** as first-class primitives.

## Tamper-evident audit

- Audit entries are append-only and chained via SHA-256 hashes.
- A verifier can recompute and detect mutation.

## Tenant isolation (target state)

- Strong namespace separation per tenant for metadata and artifacts.
- Customer-managed keys (envelope encryption) for secrets and object storage.

## Deterministic replay

- Runs record workflow digest + runtime info to support replay/verification.
- Node execution in this repo is seeded and deterministic by construction.

