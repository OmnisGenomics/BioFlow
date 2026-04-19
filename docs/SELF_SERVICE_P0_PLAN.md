# Self-Service P0 Plan (2026-02-09 to 2026-02-20)

## Goal

Make BioFlow easy to adopt without founder intervention:

- A new user can sign up, get a trial, obtain credentials, run a deterministic flow, verify it, and share it in less than 15 minutes.
- The flow is reproducible and validated by automated tests in CI.

## Scope

In scope (P0):

- CLI distribution that matches onboarding docs.
- Self-serve org provisioning.
- End-to-end billing lifecycle surfaces.
- First-run onboarding flow and status visibility.
- Seats and entitlement enforcement for paid plans.

Out of scope (this two-week window):

- New workflow connector families.
- UI redesign.
- Multi-region deployment.

## Workstreams

### P0-1: CLI Distribution

Problem:

- Onboarding references `npm install -g @bioflow/cli`, but this repo is currently private and not published as that package.

Deliverables:

- Publishable CLI package layout (`packages/cli` or equivalent) with `bioflow` binary.
- Release workflow for versioned publish from tags.
- Updated onboarding docs with a verified install command.

Acceptance tests:

- Add `test/packaged-cli.test.ts`:
  - Build/pack CLI.
  - Install in a clean temp directory.
  - Assert `bioflow --help` exits `0`.
- Keep existing command consistency checks green:
  - `npm run test -- test/docs-commands.test.ts`

Validation strategy:

- Run `npm run check` plus the new packaged CLI test in CI.

### P0-2: Self-Serve Signup and Org Provisioning

Problem:

- Org creation + first key are admin-driven (`admin:create-org-key` / `admin:provision:prod`), not user-driven.

Deliverables:

- `POST /api/v1/self-serve/signup`:
  - Create org.
  - Initialize plan state (`team` trial or explicit configured default).
  - Issue first API key (one-time reveal).
- Idempotency support for signup requests.
- Basic abuse controls (rate limit + audit events).
- Migration for trial metadata if needed (for example `trial_ends_at`).

Acceptance tests:

- Add `test/service-self-serve-signup.test.ts`:
  - `201` on first signup.
  - `409` on slug collision.
  - Idempotent replay returns same org identity.
- Add `test/service-self-serve-trial.test.ts`:
  - Trial status transitions are deterministic and enforced.

Validation strategy:

- `npm run test -- test/service-self-serve-signup.test.ts test/service-self-serve-trial.test.ts`
- `npm run test:rls`

### P0-3: Billing Lifecycle Self-Service

Problem:

- Checkout exists, but self-serve billing lifecycle needs full user-facing operations and test coverage.

Deliverables:

- Keep `POST /api/v1/billing/checkout` as entrypoint.
- Add `POST /api/v1/billing/portal` for subscription management.
- Webhook handling coverage for:
  - `checkout.session.completed`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`
- Clear org billing state in `GET /api/v1/org/me`.

Acceptance tests:

- Add `test/service-billing-portal.test.ts`.
- Add `test/service-billing-webhooks.test.ts` with idempotency assertions.
- Extend plan-gate tests for `active`, `trialing`, `past_due`, `cancelled`.

Validation strategy:

- `npm run test -- test/service-billing-portal.test.ts test/service-billing-webhooks.test.ts`
- `BIOFLOW_RUN_SERVICE_INTEGRATION=1 npm run test -- test/service-hosted-beta-ready.test.ts test/service-metrics.test.ts`

### P0-4: First-Run Onboarding Flow

Problem:

- Current quickstart expects manual environment setup and multiple context switches.

Deliverables:

- Add `GET /api/v1/onboarding/checklist` for deterministic activation state:
  - org created
  - billing configured
  - first run created
  - first run verified
  - first run shared
- Add a scripted smoke path (`scripts/self-serve-smoke.ts`) that runs:
  - tidy
  - verify
  - push
  - verify-remote
- Update hosted quickstart docs to the shortest validated sequence.

Acceptance tests:

- Add `test/service-onboarding-checklist.test.ts`.
- Add `test/self-serve-smoke.test.ts` (or CI script assertion) for the scripted path.
- Keep demo signal green:
  - `npm run demo:killer:ci`

Validation strategy:

- `npm run demo:sample-sheet:service`
- `npm run test -- test/service-onboarding-checklist.test.ts`

### P0-5: Seats and Entitlements Enforcement

Problem:

- Seat limits exist in data model but enforcement is incomplete for self-serve operation.

Deliverables:

- Deterministic seat accounting policy.
- Enforce limits on key issuance and any user-like principals.
- Add self-serve key management endpoints (create/list/revoke) under plan constraints.
- Return stable API errors for entitlement failures.

Acceptance tests:

- Add `test/service-seats-enforcement.test.ts`:
  - deny allocation above `seats_limit`.
  - allow allocation after revoke/free.
- Add `test/service-entitlements.test.ts`:
  - free vs team vs enterprise gating checks.

Validation strategy:

- `npm run test -- test/service-seats-enforcement.test.ts test/service-entitlements.test.ts`

## Two-Week Execution Schedule

Week 1:

- Monday, February 9, 2026:
  - finalize API/schema contracts for signup, portal, onboarding checklist, seats.
  - create migrations and test stubs.
- Tuesday, February 10, 2026:
  - implement self-serve signup endpoint + idempotency + tests.
- Wednesday, February 11, 2026:
  - implement billing portal route + webhook test matrix.
- Thursday, February 12, 2026:
  - implement seat enforcement + key management APIs + tests.
- Friday, February 13, 2026:
  - integrate onboarding checklist + smoke script + docs updates.

Week 2:

- Monday, February 16, 2026:
  - implement publishable CLI packaging and install verification test.
- Tuesday, February 17, 2026:
  - wire onboarding to CLI/docs flow and remove manual-only setup steps.
- Wednesday, February 18, 2026:
  - full CI and integration hardening pass; fix gaps.
- Thursday, February 19, 2026:
  - run staged dogfood with two external trial users; collect friction logs.
- Friday, February 20, 2026:
  - go/no-go review for self-serve beta launch.

## Release Gates (Must Pass)

- `npm run check`
- `npm run check:ci`
- `BIOFLOW_RUN_SERVICE_INTEGRATION=1 npm run test -- test/service-hosted-beta-ready.test.ts test/service-metrics.test.ts`
- `npm run test:rls`
- `npm run demo:killer:ci`
- `npm run demo:sample-sheet:service`

## Success Metrics

- Median time from signup to first successful `verify-remote --deep`: under 15 minutes.
- At least 80% of new users complete onboarding without human support.
- Plan-gated endpoints return correct, deterministic errors for non-entitled users.
- Zero P0 security regressions in auth, tenancy, and billing webhook handling.
