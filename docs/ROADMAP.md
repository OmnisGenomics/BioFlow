# Roadmap (execution-focused)

## MVP (this repo)

- Workflow spec (YAML/JSON) + validator
- Local runner with deterministic replay (seeded)
- Content-addressed object store (SHA-256) + tamper-evident audit chain
- `bioflow verify <runId>` (integrity + replay)
- Example workflow that produces synthetic reports and simulated writeback

## Next increments

- Connector SDK (TypeScript) with a strict contract: retry policy, rate limits, typed outputs
- Real webhook ingress (Fastify) producing normalized events
- Temporal-backed orchestration (durable long-running runs)
- UI: canvas builder + code escape hatch that compiles to the same workflow spec

## Commercial boundary

- Keep the local deterministic runner, CLI, MCP adapter, and verification/reporting surface in the Apache 2.0 open core.
- Keep hosted API/worker, billing, org provisioning, team sync, and enterprise reporting as the paid layer.
- Keep the commercial boundary clearly documented so contributors know what stays open and what does not.
