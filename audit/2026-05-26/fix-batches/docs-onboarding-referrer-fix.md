# Fix batch: fix live-tracker references to onboarding-gap-analysis.md in docs/workspace-files.md

**Scope:** `docs/workspace-files.md` only.
**Verdict pattern:** archive-leaks (2).
**Estimated edits:** small (~6 lines).

## Findings in this batch

### Finding 1 -- historical-onboarding-gap-analysis:c3

- **File:** `docs/workspace-files.md` L58-L61
- **Quote:** "The list is currently hardcoded in the switchroom binary. Adding a new stable file requires a code change + release. This is tracked for convergence (see gap analysis gap 4 and gap 8)."
- **Verdict:** archive-leaks
- **Proposed action:** fix-referrer
- **Proposed text:** Remove the "(see [gap analysis](../reference/onboarding-gap-analysis.md) gap 4 and gap 8)" link. If an active tracking location exists (issue or RFC), link that instead. The gap analysis is historical and does not track closure.
- **Evidence:** `reference/onboarding-gap-analysis.md` L3-L8 -- "no longer tracks closure"; `src/agents/workspace.ts` L94, L108 -- hardcoded arrays still present, confirming the gap is real but the tracker is dead.
- **Rationale:** docs/workspace-files.md links the gap analysis as the active tracking location. The link gives the reader a dead-end -- they follow it expecting to find current tracking and find a stale historical snapshot.

### Finding 2 -- historical-onboarding-gap-analysis:c4

- **File:** `docs/workspace-files.md` L199-L204 (Related section)
- **Quote:** "`reference/onboarding-gap-analysis.md` -- fixes planned for the mechanism-convergence gap"
- **Verdict:** archive-leaks
- **Proposed action:** fix-referrer
- **Proposed text:** Replace with: "`reference/onboarding-gap-analysis.md` -- historical motivation for the workspace loader convergence design (point-in-time, 2026-04-25; not a live roadmap)."
- **Evidence:** `reference/onboarding-gap-analysis.md` L3-L8 -- "not a live tracker"; the "Related" section entry says "fixes planned" (present-tense, implying active roadmap).
- **Rationale:** A reader following the Related link expecting planned fixes will find a stale snapshot. The description should signal the historical nature.

## Out of scope for this batch

- Edits to `reference/README.md` L60 (different description of the same file) -- in `reference-readme-index-corrections` batch.
- Edits to `reference/onboarding-gap-analysis.md` itself -- the file carries an accurate disclaimer; no changes needed there.
