# BioFlow

BioFlow is a command-line tool for cleaning sample sheets, running local workflows, and checking their outputs. It saves original inputs, output files, and execution records so runs can be inspected and verified offline.

The code is licensed under Apache 2.0. Sample workflows use synthetic inputs and simulated service connectors. The local sample-sheet cleanup command works without a hosted service.

See [license and repository scope](docs/OPEN_CORE.md) for the distinction between these local tools and the hosted service.

## Quickstart

```bash
corepack pnpm install --frozen-lockfile --ignore-scripts
npm run build
npm run check:ci
```

Run the workflow demo and check the documented commands:

```bash
npm run demo:workflow:ci
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

Verify a run's audit entries, stored file hashes, and replayed outputs:

```bash
npm run bioflow -- verify <runId>
```

Generate a Markdown report summarizing the software checks:

```bash
npm run bioflow -- report <runId> --format markdown --out ./reports
```

Note: new runs use UUID run IDs for compatibility with remote sync.

## Sample-sheet workflow example

This example cleans a synthetic sample sheet, runs simulated scoring and electronic lab notebook writeback steps, verifies the stored files, and generates a report:

```bash
npm run demo:workflow
```

See [workflow steps and expected files](docs/SAMPLE_SHEET_EXAMPLE.md). The scoring and writeback steps are software demonstrations; they do not perform scientific analysis or write to a real service.

Run the example steps separately:

```bash
npm run bioflow -- validate ./examples/killer.workflow.yaml
npm run bioflow -- run ./examples/killer.workflow.yaml --input ./examples/synthetic/sample-sheet.messy.csv
npm run bioflow -- verify <runId>
npm run bioflow -- report <runId> --format markdown --out ./reports
```

## Clean a sample sheet

Check the file and review proposed corrections before writing any output:

```bash
npm run bioflow -- validate-sample-sheet ./SampleSheet.csv
npm run bioflow -- preview-sample-sheet ./SampleSheet.csv
# For the complete proposed file and a machine-readable review:
npm run bioflow -- preview-sample-sheet ./SampleSheet.csv --json
```

These commands are read-only and use the built-in `sample-sheet-v1` profile. Validation reports whether cleanup accepts the input and whether it would change it. Preview shows header and cell changes, warnings, and a review hash. Invalid files produce an error instead of partial proposed output.

Preview displays up to 1,000 cell changes and warns when the list is capped. JSON includes the complete proposed file in `cleanedText`, which should be reviewed before accepting a large cleanup.

To accept a reviewed preview, pass its hash to cleanup:

```bash
npm run bioflow -- tidy ./SampleSheet.csv --accept-preview <previewSha256> --out ./cleaned/run-001
```

Cleanup refuses the hash if the input, profile, or proposed output has changed. It uses the reviewed input bytes for the accepted run. Running `tidy` without this option retains its existing direct-cleanup behavior.

Normalize sample IDs, indexes, and lane values while retaining other metadata:

```bash
npm run bioflow -- tidy ./SampleSheet.csv --profile sample-sheet-v1 --out ./cleaned/run-001
# then verify locally
npm run bioflow -- verify <runId>
```

Outputs include a cleaned CSV, a data-only CSV, an ID mapping JSON, and a report JSON (all content-addressed under `.bioflow/objects/...`).

Cleanup rejects unterminated quoted fields and rows with more fields than the header, so malformed input cannot silently lose rows or metadata. Omitted trailing optional fields remain supported.

For local deployment, supported inputs, limits, backup/restore, and failure handling, see [the local sample-sheet CLI guide](docs/LOCAL_SAMPLE_SHEET.md). Successful cleanup verifies evidence before exporting; existing run IDs and export files are never overwritten by `tidy`.

Sample IDs are normalized and allocated deterministically in row order. Final IDs are unique, including when a generated suffix collides with another row's ID. Duplicates use `_001`, `_002`, etc., shortening the base to respect the profile's `maxLen` (32 by default). If the suffix and at least one base character cannot fit, cleaning fails explicitly instead of exceeding the limit.

Files and execution records are stored under `.bioflow/`:

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

The MCP server provides repository search, access to stored run records, and tools for validating, running, verifying, and reporting on workflows. It also exposes remote run and profile commands when configured with a compatible service.
Set `BIOFLOW_MCP_REPO_ROOT` if you want to point it at a different checkout.
Remote tools use the same `BIOFLOW_REMOTE_*` defaults and saved CLI config as the main CLI, and each call can override `remoteUrl`, `token`, and `orgId`.
You can also bind the whole stdio session once by sending `bioflow.remoteUrl`, `bioflow.token`, and `bioflow.orgId` in the MCP `initialize` request.
See `docs/MCP.md` for the current scope and `docs/MCP_CLIENTS.md` for launch/auth examples.

## Notes

- Repo norms live in `instructions.md`.
- Workflow examples use synthetic inputs and simulated service connectors. Sample-sheet cleanup is a local file operation.
- Verification checks consistency, not who created the evidence. Generated reports do not establish regulatory qualification.
- Hosted service documentation is in [OmnisGenomics/BioFlow-Cloud](https://github.com/OmnisGenomics/BioFlow-Cloud).

## Contributing

See `CONTRIBUTING.md` for the public-core contribution workflow. Contributions are accepted under the repository's Apache 2.0 license.
