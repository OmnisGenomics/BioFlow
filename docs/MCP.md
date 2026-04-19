# BioFlow MCP

BioFlow now ships an MCP server for repo intelligence and a thin local workflow action slice.

## Start

```bash
npm run mcp
```

Or through the main CLI:

```bash
npm run bioflow -- mcp
```

Or run the packaged binary after install:

```bash
bioflow-mcp
```

Set `BIOFLOW_MCP_REPO_ROOT` if you need to point the server at a different checkout.

## Transport

- JSON-RPC 2.0 over stdio
- MCP protocol versions currently accepted: `2024-11-05`, `2025-06-18`, `2025-11-25`

## Path Rules

- Workflow and input paths are repo-relative.
- Local run artifacts default to `.bioflow/` under the repository root.
- Report output paths are also resolved relative to the repository root.

## Remote Config

- Remote tools use the same defaults as the CLI: `BIOFLOW_REMOTE_URL`, `BIOFLOW_REMOTE_TOKEN`, `BIOFLOW_REMOTE_ORG_ID`, and the saved CLI config file.
- Every remote tool also accepts `remoteUrl`, `token`, and `orgId` arguments to override those defaults for a single call.
- The MCP `initialize` request can also include a `bioflow` object with `remoteUrl`, `token`, and `orgId` to bind the session once for the whole stdio process.

## Session Audit

- The server records a chained session audit trail under `.bioflow/mcp/session-audit.json`.
- Read it through `bioflow://resource/mcp/session` to inspect the bound principal, auth mode, and mutating MCP tool history.

## Exposed Tools

- `repo.summary`
- `repo.search`
- `workflow.validate`
- `workflow.run`
- `run.verify`
- `report.generate`
- `remote.push`
- `remote.pull`
- `remote.verify`
- `remote.share`
- `remote.ls`
- `remote.profiles.list`
- `remote.profiles.get`
- `remote.profiles.put`

## Exposed Resources

- `bioflow://resource/repo-summary`
- `bioflow://resource/workflow-inventory`
- `bioflow://wiki/*` for generated wiki pages
- `bioflow://resource/run/<runId>/manifest`
- `bioflow://resource/run/<runId>/execution`
- `bioflow://resource/run/<runId>/report`
- `bioflow://resource/remote/run/<runId>/sync`
- `bioflow://resource/mcp/session`
- selected repository docs and source files surfaced as `bioflow://file/*`

## Current Scope

This slice can now:

- summarize the repository
- search docs and source
- read generated wiki pages and key source files
- inspect run manifests, execution records, and generated reports
- validate a repository workflow
- run a local workflow against repo-relative inputs
- verify a local run
- generate a deterministic report for a local run
- push, pull, verify, share, and list remote runs
- read and write org-scoped remote profiles
- inspect remote durable sync bundles through `bioflow://resource/remote/run/<runId>/sync` when the session is bound to a remote org
- bind the MCP session to org/auth defaults once through `initialize` or process env, and inspect the chained session audit resource

Tenant-scoped enforcement still lives at the remote service boundary.

## Remaining Steps To Make It Fully Viable

1. Publish Apache 2.0 for the open core and keep the contribution policy aligned with the commercial boundary.

Client launch examples and operator setup notes live in [docs/MCP_CLIENTS.md](docs/MCP_CLIENTS.md).

## Practical Rule

If a task can already be done safely by the local runner or the service API, the MCP layer should call those same paths. The MCP layer is an adapter, not a second implementation of BioFlow behavior.
