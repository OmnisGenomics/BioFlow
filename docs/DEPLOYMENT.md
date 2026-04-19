# Deployment (hosted beta)

This document is for operating the **managed BioFlow service boundary** (API + worker) in a containerized environment.

## Build

```bash
docker build -t bioflow:beta .
```

## Runtime dependencies

- Postgres 16+ (required)
- Temporal (required when `BIOFLOW_RUNNER_MODE=temporal`)
- Redis (recommended; required for multi-replica rate limiting)
- Persistent volume for `BIOFLOW_SERVICE_DATA_DIR` (service CAS + run metadata)

## Required environment

- `NODE_ENV=production`
- `BIOFLOW_DATABASE_URL=postgres://...`
- Auth (pick one):
  - `BIOFLOW_API_KEY_PEPPER=...` (recommended) or
  - `BIOFLOW_JWT_SECRET=...`
- `BIOFLOW_DEV_ALLOW_ORG_HEADER=false`
  - The API **exits on startup** if this is `true` in production.

## Recommended environment

- CORS allowlist:
  - `BIOFLOW_ALLOWED_ORIGINS=https://bioflow.io,https://app.bioflow.io`
- Proxy awareness (set when behind a load balancer / reverse proxy):
  - `BIOFLOW_TRUST_PROXY=true`
- Redis (shared rate limiting):
  - `BIOFLOW_REDIS_URL=redis://redis:6379`
- Per-org HTTP rate limiting:
  - `BIOFLOW_HTTP_RATE_LIMIT_POINTS=100`
  - `BIOFLOW_HTTP_RATE_LIMIT_DURATION_SECONDS=60`
  - `BIOFLOW_HTTP_RATE_LIMIT_BLOCK_SECONDS=900`
- Expensive operation caps (per process):
  - `BIOFLOW_DEEP_VERIFY_MAX_CONCURRENCY=3`
  - `BIOFLOW_DEEP_VERIFY_MAX_QUEUE=100`
- Metrics (Prometheus):
  - `BIOFLOW_METRICS_ENABLED=true`
  - `BIOFLOW_METRICS_BEARER_TOKEN=...` (recommended in non-local deployments)
- CAS quotas / disk guard:
  - `BIOFLOW_CAS_MAX_OBJECT_BYTES=1073741824` (1GiB)
  - `BIOFLOW_TENANT_CAS_MAX_BYTES=10737418240` (10GiB default per org)
  - `BIOFLOW_CAS_MIN_FREE_BYTES=2147483648` (keep 2GiB free)

## Run (API)

The container image defaults to `BIOFLOW_RUNNER_MODE=inline` for a single-process deployment. If you are running Temporal, override `BIOFLOW_RUNNER_MODE=temporal` and run a worker process/container.

```bash
docker run --rm \
  -p 8080:8080 \
  -e NODE_ENV=production \
  -e BIOFLOW_DATABASE_URL=postgres://... \
  -e BIOFLOW_API_KEY_PEPPER=... \
  -e BIOFLOW_ALLOWED_ORIGINS=https://bioflow.io \
  -e BIOFLOW_TRUST_PROXY=true \
  -e BIOFLOW_REDIS_URL=redis://... \
  -e BIOFLOW_SERVICE_DATA_DIR=/data \
  -v /var/lib/bioflow:/data \
  bioflow:beta
```

## Run (worker)

Run the worker as a separate process/container when using Temporal:

```bash
docker run --rm \
  -e NODE_ENV=production \
  -e BIOFLOW_DATABASE_URL=postgres://... \
  -e BIOFLOW_API_KEY_PEPPER=... \
  -e BIOFLOW_REDIS_URL=redis://... \
  -e BIOFLOW_SERVICE_DATA_DIR=/data \
  -v /var/lib/bioflow:/data \
  bioflow:beta npm run start:worker
```

## Database migrations

Apply SQL migrations from `db/migrations/` as part of deploy. The production container includes a compiled migrator:

```bash
npm run db:migrate:prod
```

Example (one-off migration job):

```bash
docker run --rm \
  -e BIOFLOW_DATABASE_URL=postgres://... \
  bioflow:beta npm run db:migrate:prod
```

## Provision an org + API key (internal)

The production container includes a compiled provisioning tool for creating an org and issuing API keys.

Create a new org + initial key:

```bash
docker run --rm \
  -e BIOFLOW_DATABASE_URL=postgres://... \
  -e BIOFLOW_API_KEY_PEPPER=... \
  bioflow:beta npm run admin:provision:prod -- org:create --name "Acme Sequencing" --slug acme-seq --plan team --cas-bytes-limit 10737418240
```

Rotate keys (create a new key for an existing org):

```bash
docker run --rm \
  -e BIOFLOW_DATABASE_URL=postgres://... \
  -e BIOFLOW_API_KEY_PEPPER=... \
  bioflow:beta npm run admin:provision:prod -- key:create --org-id <orgId> --key-name "Rotation 2026-02"
```

Revoke a key:

```bash
docker run --rm \
  -e BIOFLOW_DATABASE_URL=postgres://... \
  bioflow:beta npm run admin:provision:prod -- key:revoke --api-key-id <apiKeyId>
```

## Health / readiness

- `GET /healthz`: liveness (always `{ ok: true }` if the process is up)
- `GET /readyz`: readiness (checks Postgres and `BIOFLOW_SERVICE_DATA_DIR` writability)

## Backup model (operator contract)

- Postgres: use managed backups + WAL/PITR where available.
- `BIOFLOW_SERVICE_DATA_DIR`: snapshot the volume regularly (CAS objects + run manifests + execution records).

The verification and sync surfaces assume both Postgres metadata *and* CAS objects are available.

## CAS garbage collection (internal)

CAS objects are content-addressed and written as immutable blobs. Disk reclamation is an explicit operator
action (e.g. after aborted uploads, crashes leaving `tmp/` files behind, or deleting old runs out of band).

The production image includes a compiled GC tool that:

- prunes stale `tmp/cas_*` files
- deletes orphaned **tracked** CAS objects (not referenced by any `runs/*/manifest.json`) and updates Postgres
  accounting (`tenant_objects` + `orgs.cas_bytes_used`)
- optionally prunes orphaned **untracked** CAS objects on disk (`--prune-untracked`)

Dry-run (recommended):

```bash
docker run --rm \
  -e BIOFLOW_DATABASE_URL=postgres://... \
  -e BIOFLOW_SERVICE_DATA_DIR=/data \
  -v /var/lib/bioflow:/data \
  bioflow:beta npm run admin:gc:prod -- --org-id <orgId> --min-age-seconds 86400
```

Apply deletions:

```bash
docker run --rm \
  -e BIOFLOW_DATABASE_URL=postgres://... \
  -e BIOFLOW_SERVICE_DATA_DIR=/data \
  -v /var/lib/bioflow:/data \
  bioflow:beta npm run admin:gc:prod -- --org-id <orgId> --min-age-seconds 86400 --apply
```

Multi-tenant cleanup (disk-derived tenant list):

```bash
bioflow:beta npm run admin:gc:prod -- --all-tenants --min-age-seconds 86400 --apply
```
