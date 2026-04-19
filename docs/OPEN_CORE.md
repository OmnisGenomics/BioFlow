# Apache 2.0 Open-Core Positioning

BioFlow is better as an Apache 2.0 open-core product than as a pure open-source project.

The reason is simple: the local deterministic engine is useful on its own, but the hosted service is where teams pay for coordination, tenancy, billing, and compliance surfaces.

## What Stays In The Open Core

- Local workflow validation, replay, verification, and report generation
- The CLI entrypoint and packaged binary
- The MCP adapter and repo-intelligence surface
- Deterministic sample workflows, fixtures, and tests
- Core schemas, hashing, audit, and artifact handling

## What Belongs To The Commercial Layer

- Hosted API and worker processes
- Org provisioning and API-key flows
- Billing and entitlement enforcement
- Team sync, remote run registry, and profile registry
- Enterprise reporting and tenant-scoped operational controls

## Why This Is The Right Boundary

- It keeps the useful local tooling broad and easy to adopt.
- It preserves a clear upgrade path to hosted collaboration.
- It lets you sell on operational value instead of hiding the core mechanics.
- It keeps the codebase organized around one set of contracts instead of two diverging implementations.

## Repo Rules

- Keep the MCP layer thin and delegate to the same CLI/service paths the product already uses.
- Treat local workflows and hosted workflows as separate boundaries, not separate products.
- Keep external contributions aligned with `CONTRIBUTING.md` and `docs/CLA.md` so inbound licensing stays clean.
- Keep the public README and MCP docs aligned with the same boundary.

## Immediate Next Steps

1. Keep the public core buildable and testable from source.
2. Keep the CLA workflow visible in the public repo and out of runtime code.
3. Publish client launch examples and auth setup for the MCP server.
4. Keep hosted-only capabilities documented in BioFlow-Cloud.
