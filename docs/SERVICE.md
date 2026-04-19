# Service boundary (API + Temporal + Postgres)

This layer wraps the deterministic core with:

- workflow/run persistence (Postgres)
- distributed orchestration (Temporal)
- content-addressed artifact storage (`sha256:<hash>`) shared by API + worker
- per-org HTTP rate limiting (Redis-backed when `BIOFLOW_REDIS_URL` is set)
- CAS quota enforcement (per-tenant bytes accounting + disk free guard)

The core engine remains reusable in local mode.

## Local dev

1) Start dependencies:

```bash
docker compose up -d
```

This brings up Postgres, Temporal, and Redis (for shared rate limiting).

If you already have Postgres bound on host `5432`, create `docker-compose.override.yml` (see `docker-compose.override.yml.example`) to map the container to `5433`, then:

```bash
export BIOFLOW_DATABASE_URL=postgres://bioflow:bioflow@localhost:5433/bioflow
```

2) Configure env (copy from `.env.example`).

3) Apply DB migrations:

```bash
npm run db:migrate
```

4) Start worker + API (separate shells):

```bash
npm run service:worker
npm run service:api
```

## Minimal flow (dev)

- Auth:
  - Dev: send `x-org-id: <uuid>` (when `BIOFLOW_DEV_ALLOW_ORG_HEADER=true`)
  - API keys: send `Authorization: Bearer bf_live_...` (when `BIOFLOW_API_KEY_PEPPER` is set and keys exist)

- Health:
  - `GET /healthz` (liveness)
  - `GET /readyz` (readiness: DB + service data dir)

- Upload bytes into the service CAS:
  - `POST /api/v1/objects` with `Content-Type: application/octet-stream`
- Download bytes from the service CAS:
  - `GET /api/v1/objects/:sha256`
- Create workflow:
  - `POST /api/v1/workflows` (validates `definition` with the shared WorkflowSchema)
- Trigger run:
  - `POST /api/v1/workflows/:id/trigger`
- Verify run:
  - `GET /api/v1/runs/:id/verify` (add `?deep=1` for deterministic replay + CAS integrity)
- List runs:
  - `GET /api/v1/runs?limit=50&cursor=<created_at>,<uuid>&profileId=<id>&tags=a,b&visibility=org`

## Billing (Stripe)

- Self-serve org + first API key:
  - `POST /api/v1/self-serve/signup` (requires `Idempotency-Key` header)
- Create a checkout session (returns a hosted URL):
  - `POST /api/v1/billing/checkout` with `{ "plan": "team", "successUrl": "...", "cancelUrl": "..." }`
- Stripe webhook receiver (configure in Stripe dashboard):
  - `POST /webhooks/stripe` (raw JSON body; signature verified)

Self-serve signup (CLI convenience wrapper):

```bash
export BIOFLOW_REMOTE_URL=https://bioflow-beta.fly.dev
npm run bioflow -- auth:signup --name "Acme Lab" --slug acme-lab --plan team --remote-url "$BIOFLOW_REMOTE_URL"
```

Autopilot onboarding (signup -> run -> verify -> share; auth persisted by default):

```bash
export BIOFLOW_REMOTE_URL=https://bioflow-beta.fly.dev
npm run bioflow -- autopilot:run --remote-url "$BIOFLOW_REMOTE_URL" --name "Acme Lab" --slug acme-lab --enforce-policy --out ./autopilot-run.json
npm run bioflow -- autopilot:gate ./autopilot-run.json --json
```

Operator CI snippets (GitHub Actions, GitLab CI, Jenkins):
`docs/AUTOPILOT_GATE_RUNBOOK.md`

Admin bootstrap (local/dev fallback):

```bash
BIOFLOW_DATABASE_URL=postgres://bioflow:bioflow@localhost:5432/bioflow \\
BIOFLOW_API_KEY_PEPPER=replace-with-32+chars \\
npm run admin:create-org-key -- --name "Acme Lab" --slug acme-lab --plan team
```

In production containers (compiled; no `tsx`):

```bash
BIOFLOW_DATABASE_URL=postgres://... \\
BIOFLOW_API_KEY_PEPPER=replace-with-32+chars \\
npm run admin:provision:prod -- org:create --name "Acme Lab" --slug acme-lab --plan team
```

Inspect self-serve signup attempt artifacts (rate limits, replays, rejects):

```bash
BIOFLOW_DATABASE_URL=postgres://... \\
npm run admin:signup-attempts:prod -- signup-attempts:list --since-hours 24 --limit 200

BIOFLOW_DATABASE_URL=postgres://... \\
npm run admin:signup-attempts:prod -- signup-attempts:summary --since-hours 24 --org-limit 10
```

## Hybrid sync (local ↔ service)

Sync a completed local run into the service boundary:

- Push (objects first, then metadata):
  - `POST /api/v1/objects` (repeat until all referenced `sha256:<hash>` exist)
  - `POST /api/v1/runs/:id/sync` with `{ manifest, executionRecord }`

- Pull (metadata then objects):
  - `GET /api/v1/runs/:id/sync` → returns `{ manifest, executionRecord }`
  - `GET /api/v1/objects/:sha256` for missing objects

The CLI wires this up as `bioflow push` / `bioflow pull`.

## Team sync (org registry)

- Share a run within the org:
  - `POST /api/v1/runs/:id/share` with `{ "visibility": "org" }`
- Org profile registry:
  - `POST /api/v1/profiles` with `{ "name": "core-default", "profile": { ... } }`
  - `GET /api/v1/profiles`
  - `GET /api/v1/profiles/:name`

## Enterprise: validation report (render)

Generate a deterministic Markdown validation report for a run (stored as `gxp-report.md` in the run manifest):

- `POST /api/v1/runs/:id/report` with `{ "format": "markdown", "replay": true }`

This endpoint is gated to the `enterprise` plan.

## Tenancy note

Tenant isolation is enforced by Postgres RLS:

- The API/worker set `app.current_org_id` per transaction (see `src/service/db/tenant.ts`).
- RLS policies restrict `workflows`, `runs`, `audit_logs`, and `webhook_events`.

The service data directory is also tenant-scoped on disk:

- `BIOFLOW_SERVICE_DATA_DIR/tenants/<orgId>/objects/...`
- `BIOFLOW_SERVICE_DATA_DIR/tenants/<orgId>/runs/<runId>/{manifest.json,execution.json}`

Hardening options include Postgres RLS + separate deployment units for regulated customers.
