# BioFlow Hosted Beta Validation Bundle

## 1) What BioFlow hosted beta does

- Executes deterministic workflow runs.
- Stores workflow evidence as immutable, content-addressed artifacts (`sha256:<hash>`).
- Verifies integrity by replaying deterministic execution and comparing digests.
- Produces GxP-style Markdown validation reports as first-class artifacts.
- Supports team sync flows (`push`, `pull`, `verify-remote`) for shared run evidence.

## 2) What BioFlow hosted beta does not do

- No wet-lab execution guidance, no in vivo/clinical steps, no protocol automation.
- No cloud-only lock-in for verification: runs remain verifiable with persisted artifacts.
- No opaque optimizer path that bypasses manifest/audit evidence.

## 3) How verification works

- Workflow definition digest is pinned and checked during replay.
- CAS objects are rehashed and compared to manifest references.
- Audit chain integrity is validated.
- Replay output digests are compared against recorded run outputs.

## 4) Artifacts produced

- Run manifest: `runs/<runId>/manifest.json`
- Execution record: `runs/<runId>/execution.json`
- CAS objects: `objects/<shard>/<sha256>`
- Validation report: `<runId>-gxp-report.md`

## 5) Example hosted beta command flow

```bash
export BIOFLOW_REMOTE_URL=https://bioflow-beta.fly.dev
export BIOFLOW_REMOTE_TOKEN=bf_live_REPLACE_ME
npm run demo:sample-sheet:service
```

Expected outcome:

- deterministic tidy profile execution (`sample-sheet-v1`)
- local verify pass
- remote push/pull pass
- deep remote verify pass
- report artifact generated and content-addressed
