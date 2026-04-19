# BioFlow 0.0.2 (Beta)

## What this release solves

- Deterministic workflow execution with replayable verification.
- Deep verification (`verify-remote --deep`) that recomputes CAS digests and replay outputs.
- Deterministic GxP-style report generation as a content-addressed artifact.
- A hosted-beta vertical slice for sample-sheet normalization (`sample-sheet-v1`).

## What is new in 0.0.2

- Canonical JSON bytes for `putJson` across local/service/hash-only artifact stores.
- Tightened object upload parser body limit in the service API.
- CI smoke assertions for `demo:killer` with explicit failure diagnostics.
- Docs command validator for `README.md` + `docs/*.md`.
- `check:ci` wrapper that reruns with verbose diagnostics on failure and enforces:
  - hosted-beta hardening tests (`test:service:integration`)
  - packaged CLI autopilot flow (`test:packaged-cli`)
- New sample-sheet hosted beta demo flows:
  - `npm run demo:sample-sheet:local`
  - `npm run demo:sample-sheet:service`
- Self-serve autopilot CI gate command:
  - `bioflow autopilot:gate <artifact.json> --json`
- `autopilot:run` now persists auth config by default (opt out with `--no-persist-auth`).

## CLI changelog

### Canonical CI decision command: `autopilot:gate`

Use one machine-readable command to make pass/fail rollout decisions from autopilot artifacts:

```bash
npm run bioflow -- autopilot:gate ./autopilot-run.json --json
```

`autopilot:gate` performs both checks in one step:

- artifact integrity verification (digest check)
- policy enforcement (duration, progress, persisted auth, checklist requirements)

Migration guidance:

- Preferred: `autopilot:gate`
- Legacy diagnostics (still supported): `autopilot:validate-summary` and `autopilot:check-policy`

## Try it in 3 commands

```bash
npm install
npm run demo:sample-sheet:local
npm run demo:killer:ci
```
