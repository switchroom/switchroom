# Fix batch: correct reference/README.md index and CLAUDE.md JTBD count

**Scope:** `reference/README.md` and `CLAUDE.md`.
**Verdict pattern:** drift-minor (4), drift-major (1), archive-leaks (1).
**Estimated edits:** small (~10 lines).

## Findings in this batch

### Finding 1 -- contract-reference-readme:c4

- **File:** `reference/README.md` L21-L22
- **Quote:** "# Survey every job in one read:\nhead -5 reference/*.md"
- **Verdict:** drift-minor
- **Proposed action:** update-text
- **Proposed text:** Change the comment to: "# Survey every JTBD in one read (also prints headers for non-JTBD docs):" or add a grep filter: `head -5 reference/*.md | grep -E '^(==>|job:|outcome:|stakes:)'`
- **Evidence:** `reference/` now contains 22 .md files of which 8 are non-JTBD files without JTBD frontmatter. The command still works but produces noise headers.
- **Rationale:** The "Survey every job" comment implies all output lines are JTBD jobs, which is slightly misleading. Minor text improvement.

### Finding 2 -- contract-reference-readme:c5

- **File:** `reference/README.md` L25-L28
- **Quote:** "The body's Signs it's working, Anti-patterns, and UAT prompts sections are where the design teeth are"
- **Verdict:** drift-minor
- **Proposed action:** update-text
- **Proposed text:** Change to "Most JTBD bodies have Signs it's working, Anti-patterns, and UAT prompts sections" -- or add Anti-patterns and UAT prompts sections to `reference/idempotent-update-and-restart.md` to bring it into structural conformance with the other 13 JTBDs.
- **Evidence:** `reference/idempotent-update-and-restart.md` has "Signs it's working" and "Signs it's not" but no "Anti-patterns" or "UAT prompts" sections.
- **Rationale:** The README implies universal structure; 1 of 14 JTBDs lacks two of the three named sections.

### Finding 3 -- contract-reference-readme:c9

- **File:** `reference/README.md` L52
- **Quote:** "### Always available -- *there when you want it*"
- **Verdict:** drift-minor
- **Proposed action:** update-text
- **Proposed text:** "### Always available, in Telegram, done properly -- *there when you want it*" to match `reference/vision.md` L96 exactly. Low-priority cosmetic fix.
- **Evidence:** `reference/vision.md` L96 uses the full title including "in Telegram, done properly."
- **Rationale:** vision.md is authoritative for contract documents; README truncates.

### Finding 4 -- contract-reference-readme:c10

- **File:** `reference/README.md` L55
- **Quote:** "idempotent-update-and-restart.md -- update switchroom and trust everything's running the new version"
- **Verdict:** drift-minor
- **Proposed action:** update-text
- **Proposed text:** "idempotent-update-and-restart.md -- update switchroom and trust everything is actually running the new version, no manual checks"
- **Evidence:** `reference/idempotent-update-and-restart.md` L2 -- `job: update switchroom and trust that everything is actually running the new version, no manual checks`.
- **Rationale:** The README index description truncates and rephrases the job: field. Should match exactly.

### Finding 5 -- contract-reference-readme:c11

- **File:** `CLAUDE.md` L249
- **Quote:** "13 outcome-focused jobs grouped by outcome in reference/README.md."
- **Verdict:** drift-major
- **Proposed action:** update-text
- **Proposed text:** Change "13 outcome-focused jobs" to "14 outcome-focused jobs".
- **Evidence:** `reference/README.md` L34-L56 lists exactly 14 JTBD entries (5+4+2+3=14). All 14 corresponding .md files exist on disk.
- **Rationale:** CLAUDE.md references the README and gets the count wrong by one. The README is the authoritative index; it lists 14.

### Finding 6 -- historical-onboarding-gap-analysis:c2

- **File:** `reference/README.md` L60
- **Quote:** "onboarding-gap-analysis.md -- phased fix plan from a real onboarding session; tracks gaps as they close, not a durable JTBD."
- **Verdict:** archive-leaks
- **Proposed action:** fix-referrer
- **Proposed text:** `onboarding-gap-analysis.md` -- historical point-in-time gap analysis from a 2026-04-25 onboarding session; not a live tracker. Several gaps have shipped; read as motivation context, not current roadmap.
- **Evidence:** `reference/onboarding-gap-analysis.md` L3-L8 -- "no longer tracks closure" and "is stale."
- **Rationale:** The README description contradicts the document's own disclaimer. Readers expect to find a live tracker and find a stale snapshot instead.

## Out of scope for this batch

- Edits to `reference/principles.md` -- in `principles-stale-examples` batch.
- Edits to `docs/workspace-files.md` (other onboarding-gap-analysis referrers) -- in `docs-onboarding-referrer-fix` batch.
