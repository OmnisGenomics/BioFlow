# BioFlow pitch (technical + execution)

BioFlow is an Apache 2.0 open-core workflow runtime for life-science software stacks: **content-addressed artifacts + tamper-evident audit + deterministic verification**.

The wedge is intentionally narrow: fix the “sample sheet crisis” first (messy metadata that breaks pipelines days later), then expand into composable, verifiable workflows.

## Problem

Teams move critical metadata and artifacts via brittle scripts and emailed spreadsheets. Common failure modes:

- Inconsistent IDs and headers (spaces, case, duplicates)
- Late pipeline failures caused by metadata drift
- No trustworthy provenance (“what ran, with which inputs, on which machine?”)
- Weak auditability when collaborating across teams/CROs

## Solution

BioFlow treats runs as **verifiable bundles**:

- **CAS (content-addressed storage):** all bytes live at `sha256:<hash>`; manifests reference hashes.
- **Audit chain:** append-only entries chained via SHA-256 to detect mutation.
- **Deterministic replay:** `bioflow verify <runId>` recomputes the chain, re-hashes artifacts, and replays deterministically to compare digests.

On top of the open core, the commercial service boundary adds:

- **Team Sync:** push/pull/share runs inside an org + run registry filters.
- **Org profile registry:** share deterministic cleaning profiles across a team.
- **API-key auth + Stripe billing gate:** stateless, rotatable keys; plan-gated endpoints.
- **Enterprise:** deterministic GxP-style validation reports (Markdown, content-addressed) generated from existing manifests/audit.

## Why now

Artifact volume and pipeline complexity keep rising, while orgs need fewer bespoke scripts and more standardized, verifiable execution primitives—especially for cross-team collaboration and regulated environments.

## What’s shipped in this repo (MVP)

This repo contains an end-to-end, simulation-first implementation (deterministic transforms + synthetic fixtures) that already supports:

- Workflow contracts (schema + validation)
- CAS artifacts under `.bioflow/objects/*`
- Run manifests + execution records under `.bioflow/runs/*`
- Audit-chain integrity + deterministic replay verification
- `bioflow tidy` (Profile 1: Sample Sheet) + Team Sync push/pull
- Service boundary scaffolding (API + worker + Postgres RLS) with billing gate
- Enterprise report renderer (Markdown)

## What’s next (service extension)

- Replace simulated connectors with real integrations behind the connector contract (record/replay friendly).
- Expand cleaning profiles beyond sample sheets (only after the paid Team Sync loop is proven).
