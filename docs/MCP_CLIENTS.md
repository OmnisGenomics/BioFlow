# MCP Client and Operator Examples

BioFlow's MCP server runs over stdio. Treat it like a local adapter: launch it from the repository you want to inspect, and pass remote auth defaults only when you want remote tools to talk to the hosted service.

## Launch

From the BioFlow checkout:

```bash
npm run mcp
```

Or through the main CLI:

```bash
npm run bioflow -- mcp
```

Or, after installing the package:

```bash
bioflow-mcp
```

If you want the server to inspect a different checkout, set the repo root explicitly:

```bash
BIOFLOW_MCP_REPO_ROOT=/path/to/BioFlow npm run mcp
```

## Remote Auth

Remote tools use the same defaults as the CLI. You can set them before launch:

```bash
BIOFLOW_REMOTE_URL=https://bioflow.example
BIOFLOW_REMOTE_TOKEN=bf_test_...
BIOFLOW_REMOTE_ORG_ID=11111111-1111-4111-8111-111111111111
npm run mcp
```

If your client sends the MCP `initialize` request itself, it can bind the session once for the whole process:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2024-11-05",
    "bioflow": {
      "remoteUrl": "https://bioflow.example",
      "token": "bf_test_...",
      "orgId": "11111111-1111-4111-8111-111111111111"
    }
  }
}
```

## Generic Client Config

Any MCP client that launches a stdio subprocess can use the same shape:

```json
{
  "mcpServers": {
    "bioflow": {
      "command": "npm",
      "args": ["run", "mcp"],
      "env": {
        "BIOFLOW_MCP_REPO_ROOT": "/path/to/BioFlow",
        "BIOFLOW_REMOTE_URL": "https://bioflow.example",
        "BIOFLOW_REMOTE_TOKEN": "bf_test_...",
        "BIOFLOW_REMOTE_ORG_ID": "11111111-1111-4111-8111-111111111111"
      }
    }
  }
}
```

## What The Server Exposes

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

## Operator Notes

- Repository paths are repo-relative.
- Local run artifacts default to `.bioflow/` under the repository root.
- `bioflow://resource/mcp/session` shows the bound principal and audit chain.
- `bioflow://resource/remote/run/<runId>/sync` is available when the session is bound to a remote org.
- If you only want local repo intelligence, leave the remote auth env unset.
