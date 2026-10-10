# License and repository scope

BioFlow's local tools are available under Apache 2.0. The hosted service is maintained separately in [BioFlow-Cloud](https://github.com/OmnisGenomics/BioFlow-Cloud).

This repository contains the CLI, local workflow runner, sample-sheet cleanup, verification, reports, and MCP server. It includes clients for remote operations but does not implement the hosted service.

## This repository

- Local workflow validation, replay, verification, and report generation
- The CLI entrypoint and packaged binary
- The MCP server, repository search, and run records
- Deterministic sample workflows, fixtures, and tests
- Core schemas, hashing, audit, and artifact handling

## Hosted service repository

- Hosted API and worker processes
- Org provisioning and API-key flows
- Billing and entitlement enforcement
- Team sync, remote run registry, and profile registry
- Service reporting and tenant access controls

## Contribution rules

- MCP tools should call the existing runner and service clients rather than duplicate their behavior.
- Keep local tools usable offline and document remote prerequisites explicitly.
- Keep external contributions aligned with `CONTRIBUTING.md` and the repository's Apache 2.0 license.
- Keep the public README and MCP docs aligned with the same boundary.

Keep hosted implementation changes and deployment documentation in BioFlow-Cloud.
