# Changelog

## 0.0.4 — unpublished candidate

- Preserve terminal-newline stability in Illumina sample sheets with trailing sections. Repeated cleanup no longer adds a blank line, and otherwise normalized exports preview as unchanged. Intentional blank lines and quoted multiline data remain preserved. ([PR #16](https://github.com/OmnisGenomics/BioFlow/pull/16))
- Preserve malformed or unreadable run manifests. Initialization treats only `ENOENT` as missing, instead of silently replacing damaged evidence with an empty manifest. ([PR #17](https://github.com/OmnisGenomics/BioFlow/pull/17))
- Add synthetic workflow recovery tests covering stale reviews, retries, export collisions, ordinary partial-write errors and controlled process termination.

Affected v0.0.3 preview hashes must be regenerated. Historical runs affected by the newline correction retain their stored evidence but can fail output comparison when replayed with the corrected parser; keep the original package for historical replay. Verification of completed run evidence does not establish that an interrupted export bundle is complete. Use a fresh run ID and export destination for recovery. These checks do not establish power-loss durability or authenticated human approval.

The runtime dependencies remain pinned to `yaml` 2.8.3 and `zod` 4.3.6. No release, deployment, access or credential changes are included.

## 0.0.3 — 2026-10-10

Added read-only sample-sheet validation and correction previews, bounded preview details, and exact-content preview acceptance. See the [published v0.0.3 notes](https://github.com/OmnisGenomics/BioFlow/releases/tag/v0.0.3).
