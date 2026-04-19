# Pricing (implemented)

BioFlow is intentionally Apache 2.0 open-core by default, with a free community tier and paid tiers that unlock Team Sync and Enterprise report rendering in the service boundary.

## Tiers

### Community — $0/month

Open-core local execution only:

- Deterministic `bioflow tidy` (Sample Sheet profile: `sample-sheet-v1`)
- Local CAS + audit chain + `bioflow verify`
- Local Markdown report generation (`bioflow report … --format markdown`)

### Team — $49/month

Collaboration + shared registry (service boundary):

- Team Sync: push/pull/share runs within an org
- Org run registry (filter by profile/tags/visibility)
- Org profile registry (share deterministic cleaning profiles)
- API key auth + Stripe billing gate

### Enterprise — $499/month

Compliance deliverables + stronger isolation patterns:

- Deterministic GxP-style validation reports via service endpoint (`POST /api/v1/runs/:id/report`)
- Tenant-scoped storage layout + Postgres RLS enforcement
- Priority onboarding/support for regulated environments

## Notes

- Billing is implemented via Stripe checkout + webhooks; plans are enforced by API middleware on gated endpoints.
- Seat limits exist in the data model; enforcement and admin UX can be added as customers request it.

## Usage add-ons (optional, future)

If/when metering becomes necessary:

- Per-GB processed for artifact movement/transform
- Per-minute accelerated compute (when enabled)
