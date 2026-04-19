# BioFlow (deterministic MVP scaffold)

BioFlow is an Apache 2.0 open-core workflow OS for life-science software stacks: connectors + deterministic orchestration + reproducible provenance.

This repo currently contains a **local runner** that simulates workflows end-to-end (schemas, hashing, audit chain, artifacts) so you can iterate on contracts and UX before wiring real external services.

Positioning, boundary, and Apache 2.0 core license intent: see [docs/OPEN_CORE.md](docs/OPEN_CORE.md).

## Quickstart

```bash
npm install
npm run check
npm run check:ci
```

Run the CI-enforced smoke and docs command checks locally:

```bash
npm run demo:killer:ci
npm run test -- test/docs-commands.test.ts
```

Create a sample workflow:

```bash
npm run bioflow -- init ./example.workflow.yaml
```

Validate and run it with synthetic inputs:

```bash
npm run bioflow -- validate ./example.workflow.yaml
npm run bioflow -- run ./example.workflow.yaml --input ./README.md
```

Or use the committed example:

```bash
npm run bioflow -- run ./examples/example.workflow.yaml --input ./README.md
```

Verify a run (audit chain + CAS integrity + deterministic replay):

```bash
npm run bioflow -- verify <runId>
```

Generate a deterministic GxP-style validation report (Markdown, content-addressed via CAS):

```bash
npm run bioflow -- report <runId> --format markdown --out ./reports
```

Note: new runs use UUID run IDs for compatibility with remote sync.

## Killer example (deterministic evidence path)

Run one command to execute the canonical deterministic path (normalize sample sheet -> score -> aggregate -> simulated ELN writeback), then verify and emit a deterministic Markdown report:

```bash
npm run demo:killer
```

Reference method and artifact contract: `docs/KILLER_EXAMPLE.md`.

Manual path using committed assets:

```bash
npm run bioflow -- validate ./examples/killer.workflow.yaml
npm run bioflow -- run ./examples/killer.workflow.yaml --input ./examples/synthetic/sample-sheet.messy.csv
npm run bioflow -- verify <runId>
npm run bioflow -- report <runId> --format markdown --out ./reports
```

## Clean CSV (Profile 1: Sample Sheet)

Normalize messy sample metadata into a deterministic, verifiable bundle:

```bash
npm run bioflow -- tidy ./SampleSheet.csv --profile sample-sheet-v1 --out ./cleaned
# then verify locally
npm run bioflow -- verify <runId>
```

Outputs include a cleaned CSV, a data-only CSV, an ID mapping JSON, and a report JSON (all content-addressed under `.bioflow/objects/...`).

Artifacts and execution records are written under `.bioflow/`:

- `.bioflow/objects/<shard>/<hash>`: content-addressed bytes (SHA-256)
- `.bioflow/runs/<runId>/manifest.json`: logical names → `sha256:<hash>`
- `.bioflow/runs/<runId>/execution.json`: execution + audit chain + outputs

## Remote Sync

With a compatible BioFlow Cloud endpoint, you can push/pull a completed local run (CAS objects + manifest + execution record):

```bash
export BIOFLOW_REMOTE_URL=http://localhost:8080
export BIOFLOW_REMOTE_ORG_ID=00000000-0000-0000-0000-000000000000

npm run bioflow -- push <runId>
npm run bioflow -- pull <runId>
npm run bioflow -- verify-remote <runId> --deep
npm run bioflow -- ls-remote --limit 20
```

If the API is configured with JWT auth, set `BIOFLOW_REMOTE_TOKEN` instead of `BIOFLOW_REMOTE_ORG_ID`.
If the API is configured with API key auth, set `BIOFLOW_REMOTE_TOKEN` to your `bf_live_...` key.

## Remote Profiles

```bash
npm run bioflow -- share <runId> --visibility org

npm run bioflow -- profiles put core-default ./profile.json
npm run bioflow -- profiles ls
npm run bioflow -- tidy ./SampleSheet.csv --profile core-default
```

## MCP server

Run the MCP server over stdio:

```bash
npm run mcp
# or
npm run bioflow -- mcp
# or, after install
bioflow-mcp
```

It exposes repository summary, repo search, docs/source resources, run manifest/execution/report resources, remote durable sync bundles when the session is bound to a remote org, the chained MCP session audit resource, remote run/profile sync tools, and local workflow validate/run/verify/report tools.
Set `BIOFLOW_MCP_REPO_ROOT` if you want to point it at a different checkout.
Remote tools use the same `BIOFLOW_REMOTE_*` defaults and saved CLI config as the main CLI, and each call can override `remoteUrl`, `token`, and `orgId`.
You can also bind the whole stdio session once by sending `bioflow.remoteUrl`, `bioflow.token`, and `bioflow.orgId` in the MCP `initialize` request.
See `docs/MCP.md` for the current scope and `docs/MCP_CLIENTS.md` for launch/auth examples.

## Notes

- Repo norms live in `instructions.md`.
- All examples and runtime behavior are **simulation-first** (deterministic, synthetic artifacts). Replace simulated connectors with real ones when you’re ready.
- Hosted control-plane docs and deployment notes live in [OmnisGenomics/BioFlow-Cloud](https://github.com/OmnisGenomics/BioFlow-Cloud).
