# Workflow spec (MVP)

Workflows are defined as YAML/JSON documents validated by `src/core/schema.ts`.

## Top-level fields

- `id` (string): stable identifier
- `version` (string): semver-like `x.y.z`
- `seed` (string, optional): makes node outputs deterministic
- `compliance` (`Research` | `GLP` | `GMP`, optional): metadata only in this repo
- `nodes` (array): typed nodes
- `edges` (array): DAG edges `from -> to`

## Node kinds

- `trigger.manual`: pass-through entrypoint; emits the run inputs
- `transform.score`: deterministic scoring step; emits `<nodeId>.score.json`
- `report.aggregate`: deterministic aggregation step; emits `<nodeId>.report.json`
- `action.connector`: invoke a connector from the registry

## `action.connector` config

```yaml
config:
  connector: eln_sim        # string, required
  operation: writeback      # string, optional
  params:                   # object, optional
    destination: demo
```

Connectors return artifacts, cost, and optional notes.

## Example

See `examples/example.workflow.yaml`.
For a full deterministic evidence flow (clean + score + aggregate + simulated writeback), see `examples/killer.workflow.yaml` with input `examples/synthetic/sample-sheet.messy.csv`.
Method details and expected artifacts are documented in `docs/KILLER_EXAMPLE.md`.
