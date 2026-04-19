# Hosted Beta Quickstart (Fly.io)

This guide deploys the BioFlow hosted beta to Fly with:

- `iad` as the primary region
- `10GB` persistent volume for `BIOFLOW_SERVICE_DATA_DIR`
- inline runner mode (single API container, no Temporal worker)

## 0) Prerequisites

- `flyctl` installed and authenticated (`fly auth login`)
- This repo checked out at the tag/commit you want to deploy
- A random 32+ character API key pepper and metrics bearer token

## 1) Create app + persistent volume

```bash
fly apps create bioflow-beta
fly volumes create bioflow_data --app bioflow-beta --region iad --size 10
```

## 2) Create Fly Postgres + attach

```bash
fly postgres create --name bioflow-beta-db --region iad --initial-cluster-size 1 --vm-size shared-cpu-1x --volume-size 10
fly postgres attach --app bioflow-beta bioflow-beta-db
```

`fly postgres attach` injects `DATABASE_URL` into the app. BioFlow accepts either
`BIOFLOW_DATABASE_URL` or `DATABASE_URL`.

## 3) Configure secrets

```bash
fly secrets set -a bioflow-beta \
  BIOFLOW_API_KEY_PEPPER=replace-with-32-plus-chars \
  BIOFLOW_METRICS_BEARER_TOKEN=replace-with-32-plus-chars
```

If you want to set an explicit DB variable (optional when `DATABASE_URL` exists):

```bash
fly secrets set -a bioflow-beta BIOFLOW_DATABASE_URL=postgres://...
```

## 4) Deploy (migrations run automatically)

The checked-in `fly.toml` includes:

- `release_command = "npm run db:migrate:prod"`
- health checks on `/healthz` and `/readyz`
- mount `/data` from the `bioflow_data` volume

Deploy:

```bash
fly deploy -a bioflow-beta
```

## 5) Verify health

```bash
fly status -a bioflow-beta
curl -fsS https://bioflow-beta.fly.dev/healthz
curl -fsS https://bioflow-beta.fly.dev/readyz
```

## 6) Self-serve signup (org + first API key)

One-command autopilot (signup -> run -> verify -> share; auth persisted by default):

```bash
export BIOFLOW_REMOTE_URL=https://bioflow-beta.fly.dev
npm run bioflow -- autopilot:run \
  --remote-url "$BIOFLOW_REMOTE_URL" \
  --name "Acme Sequencing" \
  --slug acme-seq \
  --enforce-policy \
  --out ./autopilot-run.json

# deterministic CI gate (integrity + policy)
npm run bioflow -- autopilot:gate ./autopilot-run.json --json
```

Manual signup path (if you want stepwise control): create the first org with CLI-assisted self-serve signup. This command calls
`POST /api/v1/self-serve/signup` and stores the one-time `apiKey` into local
CLI config:

```bash
export BIOFLOW_REMOTE_URL=https://bioflow-beta.fly.dev
npm run bioflow -- auth:signup \
  --name "Acme Sequencing" \
  --slug acme-seq \
  --plan team \
  --remote-url "$BIOFLOW_REMOTE_URL"
```

Automation tip: pin config writes to an isolated file:

```bash
npm run bioflow -- auth:signup \
  --name "Acme Sequencing" \
  --slug acme-seq \
  --plan team \
  --remote-url "$BIOFLOW_REMOTE_URL" \
  --config-path ./.bioflow-ci/config.json \
  --json
```

Validate auth with the saved CLI credentials:

```bash
npm run bioflow -- ls-remote --limit 1 --remote-url "$BIOFLOW_REMOTE_URL"
```

## 7) Run the hosted sample-sheet beta flow

From your local repo:

```bash
npm run demo:sample-sheet:service
```

Then deep-verify a run remotely:

```bash
npm run bioflow -- verify-remote <runId> --deep
```

## 8) Operational notes

- Keep one instance until you add Redis (`BIOFLOW_REDIS_URL`) for shared rate limits.
- Keep `BIOFLOW_DEV_ALLOW_ORG_HEADER=false` in production.
- Keep `/metrics` protected with `BIOFLOW_METRICS_BEARER_TOKEN`.
- Use Fly Postgres backups for DB and plan periodic exports of `/data`.
