# Autopilot Gate Runbook

This runbook defines the canonical CI contract for self-serve onboarding automation:

1. run `autopilot:run` and persist an artifact
2. evaluate that artifact with `autopilot:gate --json`

`autopilot:gate` is the single machine decision surface for rollout/pass-fail logic.

`autopilot:run` persists auth config by default; use `--no-persist-auth` only for explicit ephemeral runs.

## Contract

- Input artifact: `autopilot-run.json` (or any path you provide via `--out`)
- If `BIOFLOW_AUTOPILOT_OUT` is set, `autopilot:validate-summary`, `autopilot:check-policy`, and `autopilot:gate` can omit the positional artifact path.
- Decision command:

```bash
npm run bioflow -- autopilot:gate ./autopilot-run.json --json
```

- Exit codes:
  - `0`: gate pass
  - `1`: gate fail (`autopilot_run_failed`, `autopilot_policy_failed`, `digest_mismatch`, or `invalid_summary`)

## CI variables contract

Set these environment variables in your CI system. Only `BIOFLOW_REMOTE_URL` is required.

| Variable | Required | Default | Used by | Purpose |
| --- | --- | --- | --- | --- |
| `BIOFLOW_REMOTE_URL` | Yes | none | `autopilot:run` | Hosted API base URL for self-serve onboarding flow. |
| `BIOFLOW_AUTOPILOT_OUT` | No | `./autopilot-run.json` | `autopilot:run`, `autopilot:gate` | Artifact path written by run and read by gate. |
| `BIOFLOW_AUTOPILOT_NAME` | No | CLI default | `autopilot:run` | Org display name for signup. |
| `BIOFLOW_AUTOPILOT_SLUG` | No | CLI default (auto-generated) | `autopilot:run` | Org slug for signup. |
| `BIOFLOW_AUTOPILOT_IDEMPOTENCY_KEY` | No | CLI default (auto-generated) | `autopilot:run` | Idempotency key for signup retry safety. |
| `BIOFLOW_AUTOPILOT_KEY_MODE` | No | `test` | `autopilot:run` | API key mode (`test` or `live`). |
| `BIOFLOW_AUTOPILOT_MAX_DURATION_MS` | No | `900000` | `autopilot:gate` | Maximum allowed run duration. |
| `BIOFLOW_AUTOPILOT_MIN_PROGRESS_COMPLETED` | No | `4` | `autopilot:gate` | Minimum completed checklist count. |
| `BIOFLOW_AUTOPILOT_MIN_PROGRESS_RATIO` | No | `0.8` | `autopilot:gate` | Minimum completed/total checklist ratio. |
| `BIOFLOW_AUTOPILOT_REQUIRE_PERSISTED_AUTH` | No | `true` | `autopilot:gate` | Require persisted auth in summary. |
| `BIOFLOW_AUTOPILOT_REQUIRED_CHECKLIST_IDS` | No | `org_created,first_run_created,first_run_verified,first_run_shared` | `autopilot:gate` | Required checklist IDs for gate pass. |

CLI note: `autopilot:run` and `autopilot:gate` read the variables above directly. Shell wrappers can stay minimal.

Variable-driven shell pattern:

```bash
set -euo pipefail

: "${BIOFLOW_REMOTE_URL:?BIOFLOW_REMOTE_URL is required}"
AUTOPILOT_OUT="${BIOFLOW_AUTOPILOT_OUT:-./autopilot-run.json}"

npm run bioflow -- autopilot:run \
  --remote-url "$BIOFLOW_REMOTE_URL" \
  --enforce-policy \
  --out "$AUTOPILOT_OUT"

npm run bioflow -- autopilot:gate "$AUTOPILOT_OUT" \
  --json | tee ./autopilot-gate.json
```

## Minimal local smoke

```bash
export BIOFLOW_REMOTE_URL=https://bioflow-beta.fly.dev
npm run bioflow -- autopilot:run \
  --remote-url "$BIOFLOW_REMOTE_URL" \
  --enforce-policy \
  --out ./autopilot-run.json
npm run bioflow -- autopilot:gate ./autopilot-run.json --json
```

## GitHub Actions

```yaml
name: Self-Serve Gate

on:
  workflow_dispatch:

jobs:
  gate:
    runs-on: ubuntu-latest
    env:
      BIOFLOW_REMOTE_URL: ${{ secrets.BIOFLOW_REMOTE_URL }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: "npm"
      - run: npm ci
      - name: Run autopilot and gate
        run: |
          set -euo pipefail
          npm run bioflow -- autopilot:run \
            --remote-url "$BIOFLOW_REMOTE_URL" \
            --enforce-policy \
            --out ./autopilot-run.json
          npm run bioflow -- autopilot:gate ./autopilot-run.json --json | tee ./autopilot-gate.json
      - name: Upload autopilot artifacts
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: autopilot-gate-bundle
          path: |
            autopilot-run.json
            autopilot-gate.json
          if-no-files-found: warn
```

## GitLab CI

```yaml
stages:
  - gate

autopilot_gate:
  stage: gate
  image: node:20
  script:
    - npm ci
    - >
      npm run bioflow -- autopilot:run
      --remote-url "$BIOFLOW_REMOTE_URL"
      --enforce-policy
      --out ./autopilot-run.json
    - npm run bioflow -- autopilot:gate ./autopilot-run.json --json | tee ./autopilot-gate.json
  artifacts:
    when: always
    paths:
      - autopilot-run.json
      - autopilot-gate.json
```

## Jenkins (Declarative Pipeline)

```groovy
pipeline {
  agent any
  stages {
    stage('Install') {
      steps {
        sh 'npm ci'
      }
    }
    stage('Autopilot Gate') {
      environment {
        BIOFLOW_REMOTE_URL = credentials('bioflow-remote-url')
      }
      steps {
        sh '''
          set -euo pipefail
          npm run bioflow -- autopilot:run \
            --remote-url "$BIOFLOW_REMOTE_URL" \
            --enforce-policy \
            --out ./autopilot-run.json
          npm run bioflow -- autopilot:gate ./autopilot-run.json --json | tee ./autopilot-gate.json
        '''
      }
      post {
        always {
          archiveArtifacts artifacts: 'autopilot-run.json,autopilot-gate.json', fingerprint: true
        }
      }
    }
  }
}
```

## Failure triage

On non-zero exit, inspect:

- `autopilot-gate.json` (decision payload)
- `autopilot-run.json` (summary or failure artifact)

Optional diagnostics:

```bash
npm run bioflow -- autopilot:validate-summary ./autopilot-run.json --json
npm run bioflow -- autopilot:check-policy ./autopilot-run.json --json
```
