# Killer Example: Deterministic Evidence Bundle

This document defines the canonical deterministic example for BioFlow.

Goal:
- Execute a deterministic workflow from a synthetic messy CSV.
- Verify run integrity offline.
- Generate a deterministic Markdown validation report.

## Assets

- Workflow: `examples/killer.workflow.yaml`
- Input: `examples/synthetic/sample-sheet.messy.csv`
- One-command demo: `npm run demo:killer`

## Workflow Contract

The workflow is intentionally linear and deterministic:

1. `trigger.manual` (`start`)
2. `action.connector` (`clean`, connector=`clean_csv`, operation=`sample-sheet-v1`)
3. `transform.score` (`score`)
4. `report.aggregate` (`aggregate`)
5. `action.connector` (`writeback`, connector=`eln_sim`, operation=`writeback`)

Determinism anchor:
- Workflow seed is fixed (`killer-seed-v1`).
- Input fixture is versioned in git.
- Connectors are simulation-only and side-effect free in this repository.

## Reproducible Procedure

Manual sequence:

```bash
npm run bioflow -- validate ./examples/killer.workflow.yaml
npm run bioflow -- run ./examples/killer.workflow.yaml --input ./examples/synthetic/sample-sheet.messy.csv
npm run bioflow -- verify <runId>
npm run bioflow -- report <runId> --format markdown --out ./reports
```

Single-command sequence:

```bash
npm run demo:killer
```

Expected terminal signals from the single-command sequence:
- `execution=completed`
- `verify=OK`
- `report.sha256=<hex>`

## Evidence Expectations

After a successful run + report generation, the run manifest must contain:

- `clean.sample-sheet-v1.clean.csv`
- `clean.sample-sheet-v1.data.csv`
- `clean.sample-sheet-v1.idmap.json`
- `clean.sample-sheet-v1.report.json`
- `connector.eln_sim.ack.json`
- `gxp-report.md`

All artifacts are content-addressed (`sha256:<hash>`) and verifiable offline with `bioflow verify`.

## Validation Strategy

CI and local checks should prove three properties:

1. Schema validity: workflow parses and validates.
2. Runtime determinism: run completes with stable artifact contract.
3. Evidence integrity: offline verify passes and report generation is deterministic.

Current enforcement:
- `test/killer-example.test.ts` executes run -> verify -> report and asserts contract outputs.
- CI includes `npm run demo:killer` as a smoke step.
