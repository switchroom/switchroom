# Fix batch: remove dead historical-prd unit from the drift-audit manifest

**Scope:** `scripts/drift-audit/manifest.yaml` and `scripts/drift-audit/README.md`.
**Verdict pattern:** dead-pointer (1).
**Estimated edits:** small (~8 lines deleted + 1 line updated).

## Findings in this batch

### Finding 1 -- historical-prd:c1

- **File:** `scripts/drift-audit/manifest.yaml` L228-L230; `scripts/drift-audit/README.md` L94
- **Quote:** `- id: historical-prd` / `path: reference/PRD.md` / `category: historical` (manifest); `reference/PRD.md` (README example row)
- **Verdict:** dead-pointer
- **Proposed action:** delete
- **Manifest edit:** Remove the entire `historical-prd` unit block (the `- id: historical-prd` entry and its `path:`, `category:`, and `anchors_hint:` fields) from `scripts/drift-audit/manifest.yaml`.
- **README edit:** In `scripts/drift-audit/README.md` L94, the table row for `historical` category cites "`reference/PRD.md`, `reference/onboarding-gap-analysis.md`" as examples. Remove `reference/PRD.md` from that example, leaving only `reference/onboarding-gap-analysis.md`.
- **Evidence:** `reference/PRD.md` does not exist on disk. Deleted in PR #534 (commit 8bdb86cb, "docs(design-contract): vision + principles + JTBD index, scrap PRD"). No other files in src/, docs/, or tests/ reference PRD.md as current spec.
- **Rationale:** The manifest points Phase 1 audit agents at a file that does not exist. Any future re-run of Phase 1 on this manifest would fail on historical-prd with "file not found." The unit is definitively dead and should be removed rather than annotated.

## Out of scope for this batch

- Edits to any other manifest units.
- Re-running Phase 1 to verify the updated manifest (Phase 4 responsibility).
