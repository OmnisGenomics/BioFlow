# Outreach Template (Hosted Beta)

Subject: Deterministic sample-sheet cleanup + replayable verification

I am running a hosted BioFlow beta for deterministic workflow evidence.

If you send one messy sample sheet or metadata CSV, I will return:

- a deterministic cleaned bundle
- a Markdown validation report
- a run ID you can verify remotely with deep checks

Hosted endpoint: `https://bioflow-beta.fly.dev`

Quick trial path:

```bash
export BIOFLOW_REMOTE_URL=https://bioflow-beta.fly.dev
export BIOFLOW_REMOTE_TOKEN=bf_live_REPLACE_ME
npm run demo:sample-sheet:service
npm run bioflow -- verify-remote <runId> --deep
```

Docs:

- Hosted quickstart: `docs/HOSTED_BETA_QUICKSTART.md`
- Release summary: `docs/RELEASE_0_0_2.md`
- Validation bundle: `docs/BIOFLOW_HOSTED_BETA_VALIDATION_BUNDLE.md`
