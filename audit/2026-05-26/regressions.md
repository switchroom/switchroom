# Re-verify report — audit/2026-05-26/

Generated: 2026-05-28T00:00:00Z

## Summary

- Fix-batches in this run: 11 doc fix-batches + 5 code escalations (E1-E5)
- Fix-batches merged: 16 / 16
- Units re-audited: 16 (11 doc units + 5 code escalation units)
- Findings resolved: 56 / 56 originally-non-aligned findings
- Findings persistent: 0
- Findings new: 1 (stale JSDoc comment; not a live callsite)

## Fix-batches that did not merge

None. All 11 doc fix-batches and all 5 code escalation PRs merged to main
at commit 3e706833. No unmerged batches to log.

## Persistent drift

None. Every originally-non-aligned finding confirmed aligned in the merged
codebase.

## New drift

- `misc-jtbd-small-drift-fixes:new-1` — `src/web/webhook-handler.ts:L93` — drift-minor

  The JSDoc comment inside the `WebhookHandlerOpts` type reads:
  "matching ones spawn one-shot `claude -p` turns." The implementation
  (`webhook-dispatch.ts`) has correctly used `inject_inbound` since PR #1620
  and explicitly documents that `claude -p` is forbidden. The JSDoc comment
  was never updated to match.

  - Likely source: pre-existing miss — the comment predates the inject_inbound
    migration and was not in scope for the fix batches (which targeted reference
    docs, not implementation JSDoc).
  - Action: add to next run's manifest as a `src-comments` unit, or inline-fix
    in the next touched PR. Proposed replacement: "matching ones deliver a
    synthesized turn to the agent via `inject_inbound` IPC."
  - Risk: low. The comment is in a type definition struct and has no runtime
    effect. It is not a live callsite. The bridge-flap regression guard
    (which strips comments before scanning) does not flag it. However, it
    is misleading to any developer reading the type definition.

## Coverage notes

**Escalations E6-E10 not re-audited.** This re-verify pass covered only the
code escalations that had merged PRs (E1-E5). The remaining escalations in
`audit/2026-05-26/escalations.md` were not assigned fix PRs in this pilot run:

- **E6** (silence-poke success rate: 0-7% vs >80% JTBD target) — no code
  change dispatched. Remains outcome-not-realized for
  `jtbd-know-what-my-agent-is-doing:c12`. Operator decision required.
- **E7** (migrate-schema.ts not wired into production) — no code change
  dispatched. Low-confidence finding; wiring status unverified. Action:
  add to next run's manifest for deeper investigation.
- **E8** (dead-zone recovery: vision-only) — no code change dispatched.
  `jtbd-talk-to-agents-from-anywhere:c10` was addressed in the JTBD doc
  with a vision-only marker (resolved), but the product gap remains.
- **E9** (historical-prd manifest unit) — resolved via the manifest-hygiene
  fix-batch; confirmed aligned.
- **E10** (doc-level escalations from misc-jtbd batch that were outcome-not-realized
  for give-each-agent c1-c4) — resolved by E2 code fix; confirmed aligned.

**Two minor stale JSDoc items observed but not in original findings:**

1. `src/web/webhook-handler.ts:L93` — documented above as new drift.
2. `audit/2026-05-26/rfc-sub-agent-visibility.yaml` body still references
   `progress-card-driver.ts` in two historical-context sections (L261, L307,
   L314) that were intentionally preserved as archaeology. These are inside
   explicitly-labeled historical/diagnosis sections and do not mislead current
   readers. No action needed.

**All 14 JTBD units, both RFC units, both artefact units, and all historical
units in the pilot manifest have at least one verified pass.** The pilot
confirmed the workflow is sound: 56 non-aligned findings were produced in
Phase 1, all 56 were addressed in Phase 2-3, and all 56 are confirmed aligned
in Phase 4 with one minor new finding introduced by the migration.
