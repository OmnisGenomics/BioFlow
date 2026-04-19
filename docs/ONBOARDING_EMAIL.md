# Self-serve onboarding email (hosted service)

Subject: BioFlow self-serve quickstart (signup -> verify in minutes)

Hi <NAME>,

Your BioFlow hosted workspace is ready for self-serve signup.

- Hosted endpoint: `<REMOTE_URL>` (e.g. `https://bioflow-beta.fly.dev`)
- API docs / service notes: `<DOCS_URL>`

Quickstart (5 minutes):

```bash
# 1. Install CLI
npm install -g @bioflow/cli

# 2. One-command autopilot (signup -> run -> verify -> share; auth persisted by default)
npm run bioflow -- autopilot:run --remote-url <REMOTE_URL> --name "<ORG_NAME>" --slug <org-slug> --enforce-policy --out ./autopilot-run.json
npm run bioflow -- autopilot:gate ./autopilot-run.json --json

# 3. Or manual signup (creates org + returns key once; CLI stores auth config)
bioflow auth:signup --name "<ORG_NAME>" --slug <org-slug> --plan team --remote-url <REMOTE_URL>

# 4. Clean a messy sample sheet
bioflow tidy SampleSheet.csv --profile sample-sheet-v1 --out ./clean/

# 5. Verify determinism (cryptographic proof)
bioflow verify <runId>  # should pass

# 6. Push to team workspace (Team trial included)
bioflow push <runId>

# 7. Teammate pulls and extends
bioflow pull <runId>
```

Billing:
- Trial: Team features free for 30 days
- Then: $49/month (auto-billed to card on file)
- Manage subscription: Stripe checkout + billing portal endpoints

Support:
- Slack: `<SLACK_INVITE_URL>`
- Issues: `<ISSUES_URL>` (or reply here)

Next steps:
1) Try the tidy → verify → push flow above
2) Generate a GxP-style validation report: `bioflow report <runId> --format markdown`
3) Book an onboarding call (optional): `<CALENDLY_URL>`

The verification step proves your software artifacts haven't been tampered with — show it to your QA team.

— <FOUNDER_NAME>
