# Local sample-sheet CLI operations

This guide covers the local `tidy`, `verify`, and `report` path. Hosted sync, real service connectors, and authenticated provenance are separate capabilities. The public workflow examples remain simulation-only.

## Runtime and installation

Use Node 22 or 24 for deployment. CI checks Linux on Node 20/22/24 and Windows on Node 22/24, including installing and exercising the packaged CLI without the source checkout. Install a versioned package tarball from a tested commit; retain the tarball and its SHA-256 alongside deployment records. Version 0.0.2 pins the two runtime dependencies to the versions in the repository lockfile.

Build and validate a checkout before packaging:

```bash
corepack pnpm install --frozen-lockfile --ignore-scripts
npm run build
npm run check:ci
npm run demo:killer:ci
npm run pack:cli
```

The generated package contains compiled CLI/MCP code and required profile assets. Installing the tarball requires access to the configured npm registry for its runtime dependencies; local execution with the built-in profile requires no hosted BioFlow service or credentials.

## Run, verify, and report

Choose a fresh export directory for each invocation:

```bash
bioflow tidy ./SampleSheet.csv --profile sample-sheet-v1 --base-dir ./evidence --out ./cleaned/run-001
bioflow verify <runId> --base-dir ./evidence
bioflow report <runId> --base-dir ./evidence --format markdown --out ./reports
```

`tidy` verifies the completed run's audit, artifact hashes, and deterministic replay before exporting. The process returns status 0 only if cleanup, verification, and any requested export succeed. Runtime/input/export failures return 1; invalid command syntax returns 2. A completed execution record can remain in the evidence store even if export fails; check the process status as well as the execution status.

`BIOFLOW_BASE_DIR` sets the default evidence directory for these three commands. An explicit `--base-dir` takes precedence. UUID run IDs are generated automatically. A supplied `--run-id` must be new, contain 1–128 letters/digits/underscores/hyphens, start with a letter or digit, and avoid Windows device names. An existing run directory is rejected, including failed or incomplete runs.

`tidy` refuses existing export targets, including symlinks, and uses exclusive file creation. A collision detected during preflight writes no export files; normal write failures roll back files created by that invocation. Export is not a transaction across process crashes. On interruption, inspect the export directory and use a fresh one for the retry. Original inputs and prior exports are never intentionally replaced. Do not share a writable export directory with other processes while cleanup is running.

## Input contract and limits

- UTF-8 CSV or TSV, optionally with a UTF-8 BOM. Convert other encodings explicitly; invalid UTF-8 is rejected.
- A simple header table, or a sectioned sample sheet containing exactly one `[Data]` table. Section-looking lines inside quoted metadata do not end the table. Prelude and suffix sections are retained.
- Required fields: `Sample_ID` and `Index`. Header aliases are normalized. Sample IDs are uppercased, punctuation normalized, length limited by the profile, and collisions resolved with recorded mappings. Unknown metadata columns are retained; surrounding cell whitespace is trimmed and header whitespace becomes underscores.
- Quoted commas/tabs, escaped quotes, and multiline metadata are supported. Unclosed quotes, quotes inside unquoted text, unexpected text after a closing quote, duplicate normalized columns, and surplus row fields are rejected. Omitted trailing optional fields remain allowed.
- Combined dual indexes and separate `Index2` values must agree when both are supplied. A nonempty derived `Index_Dual` must agree with the normalized index fields. Profile `allowDual` and `allowMissing` rules are enforced, including an entirely absent lane column.
- Lane values must be positive safe integers. Ranges are sorted and expanded, with at most 10,000 expanded entries per row before deduplication. This is a software processing bound, not an instrument compatibility guarantee.
- Maximum input: 10 MiB UTF-8 bytes. Maximum table: 100,000 records plus a header (blank logical records count toward the parsing limit). Maximum columns: 256. Larger inputs require a separately validated processing path.
- Input filenames reserved for workflow snapshots, reports, or the four generated `tidy.sample-sheet-v1.*` artifacts are rejected. Rename such an input before running cleanup.

Invalid encoding and malformed table failures inside the workflow retain verifiable failure evidence with no cleaned outputs. File preflight failures (missing/oversized file, unsafe/reused run ID) can fail before an execution record is created. An interrupted run may leave an incomplete directory: retain it for inspection and retry with a new ID.

## Evidence retention and restore

Retain the complete evidence directory: `objects/` plus `runs/<runId>/manifest.json` and `execution.json`. Exported CSVs alone are not sufficient for offline verification. Stop writers before taking a consistent backup; copy the whole evidence directory and record the package version/hash and runtime used.

Restore a backup into a separate directory and run `bioflow verify <runId> --base-dir <restored-directory>` before relying on it. Preserve the original package for historical replay: deterministic replay depends on the implementation as well as the stored workflow/profile. Upgrading the parser can change handling of formerly accepted malformed inputs, so verify representative archived runs before upgrading.

The local store retains original sample metadata and ID mappings. Apply filesystem permissions, retention rules, and backup protection appropriate to that data. Verification detects inconsistent evidence but an unkeyed hash chain does not authenticate the producer against someone who can rewrite the entire store. The GxP-style report records software checks; it is not a regulatory qualification.

## Deployment acceptance

Before using a new version, require passing CI for the target OS/runtime, the installed-package local cleanup/verify/report check, corruption rejection, and a representative de-identified sample-sheet comparison against expected outputs. Review ID mappings and warnings. This establishes the supported local software behavior; suitability for a particular downstream system must be checked independently.
