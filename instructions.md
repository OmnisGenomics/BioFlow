# BioFlow Repo Norms

## Product intent

- BioFlow is a deterministic workflow execution and verification system.
- Prefer reproducibility and verifiability over convenience features.
- Treat artifacts as immutable, content-addressed evidence.

## Engineering rules

- Determinism by default:
  - Use seeded computation.
  - Use canonical JSON for hash-relevant payloads.
  - Avoid non-deterministic sources in artifact bytes.
- Keep core execution local-first and offline-capable.
- Keep interfaces typed and explicit; avoid hidden side effects.
- Prefer clear, testable code over clever abstractions.

## Safety scope (non-negotiable)

- This repository is simulation-only.
- Do not add wet-lab, in vivo, or clinical procedures or guidance.
- Keep outputs in software form: code, tests, configs, logs, manifests, reports.

## Validation expectations

- Every nontrivial change should include targeted tests.
- Verify integrity paths (`verify`, replay, CAS hash checks) after core changes.
- Keep CI checks deterministic and scriptable.
