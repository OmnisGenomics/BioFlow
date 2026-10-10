# Security and verification

BioFlow stores original inputs, generated files, and execution records locally. Verification checks whether those records and files are consistent.

## Audit checks

- Audit entries are append-only and chained via SHA-256 hashes.
- A verifier can recompute and detect mutation.
- Run verification also requires the expected lifecycle events and checks their details against the execution record and stored workflow. An empty or truncated audit is invalid, even if the remaining chain hashes correctly.
- These are integrity and consistency checks, not authenticated provenance. SHA-256 chains alone cannot establish who created evidence or prevent someone with write access from replacing the evidence and recomputing its hashes.

## Local data and remote access

- Original metadata and ID mappings remain in the local store. Protect that directory and its backups with appropriate filesystem permissions.
- The CLI does not provide tenant isolation or encrypted storage. Remote access controls are enforced by the hosted service.
- Generated validation reports describe software checks; they do not establish regulatory compliance.

## Deterministic replay

- Runs record workflow digest + runtime info to support replay/verification.
- Node execution in this repo is seeded and deterministic by construction.

