# Phase 4 — Re-verify prompt

Self-contained prompt for the single re-verify agent. Dispatched
after Phase 3 PRs merge to `upstream/main` (or `origin/main` in
direct-origin setups). Confirms the drift the audit identified is
actually gone and surfaces anything that came back or was missed.

---

## Prompt to dispatch

You are the drift-audit re-verify agent. Phase 3 opened PRs for each
fix-batch and (some of them) merged. Your job is to re-audit the
units those PRs touched and confirm the originally-reported drift is
gone.

**Read first:**

- `scripts/drift-audit/README.md`.
- `scripts/drift-audit/prompts/01-audit.md` — your verdict taxonomy.
- `audit/{{run_date}}/findings/` — the original Phase 1 findings.
- `audit/{{run_date}}/fix-batches/` — what Phase 3 was asked to do.

---

## What to do

### Step 1 — sync to main

```
git fetch origin    # or `upstream` in fork-mode
git log origin/main --oneline --since="{{run_date}}" \
  --grep="drift-audit" | tee /tmp/drift-audit-merged.txt
```

This produces the list of drift-audit PRs that merged. Cross-
reference with `audit/{{run_date}}/fix-batches/` — any batch whose
PR did NOT merge gets logged in `regressions.md` as `pr-not-merged`.

For the rest: hard-reset a working tree to the merged main so your
file reads see the merged fixes.

### Step 2 — collect the unit list to re-audit

For each merged fix-batch, identify the units it touched (the
`unit_id` of every finding in the batch). De-duplicate. That's your
re-audit set.

### Step 3 — re-run Phase 1 on each unit

Use the Phase 1 prompt template at
`scripts/drift-audit/prompts/01-audit.md` as your audit logic. For
each unit in the re-audit set:

1. Read `audit/{{run_date}}/findings/<unit_id>.yaml` — the original
   findings.
2. Re-read the unit file at its current main state.
3. Re-do Step 1-5 of the Phase 1 prompt: extract claims, locate
   evidence, emit verdicts.
4. Write the new findings to
   `audit/{{run_date}}/reverify/<unit_id>.yaml` (same schema).

You can dispatch this as parallel sub-agents (same pattern as Phase
1) if the re-audit set is large. For ≤5 units, do them sequentially
in this agent.

### Step 4 — diff the runs

For each unit, compare original findings to reverify findings:

- **Resolved:** original verdict was non-`aligned`, reverify is
  `aligned`. Expected — the fix worked.
- **Persistent:** original verdict was non-`aligned`, reverify is
  still non-`aligned`. The fix didn't land or didn't address the
  drift. Flag.
- **New:** reverify has a finding the original didn't. Either the
  fix introduced new drift, or Phase 1 missed it the first time.
  Flag.

### Step 5 — emit `regressions.md`

`audit/{{run_date}}/regressions.md` is the only output. Shape:

```markdown
# Re-verify report — audit/{{run_date}}/

Generated: <ISO timestamp>

## Summary

- Fix-batches in this run: N
- Fix-batches merged: M
- Units re-audited: U
- Findings resolved: R / total_non_aligned_in_original
- Findings persistent: P
- Findings new: Q

## Fix-batches that did not merge

- `<batch-slug>.md` — PR #<n> — status (open / closed without merge / not opened)
  - Action: <re-open Phase 3 / drop / escalate>

## Persistent drift

- `<unit_id>:<claim_id>` — original verdict X, reverify verdict X
  - Original action: <action>
  - Apparent reason it didn't resolve: <one sentence>
  - Action: <re-batch in next run / escalate>

## New drift

- `<unit_id>:<new_claim_id>` — reverify verdict X
  - Likely source: <introduced by fix PR / pre-existing miss>
  - Action: <add to next run's manifest / fix inline>

## Coverage notes

- Anything else triage should see in the next run.
```

---

## Constraints

- **You are read-only outside `audit/{{run_date}}/reverify/` and
  `regressions.md`.** No edits to docs, no PRs.
- **Don't re-run for unmerged PRs.** Just log them — they're a
  separate problem (review backlog, not drift).
- **Use the same verdict taxonomy as Phase 1.** No new categories;
  triage already has the vocabulary it needs.
- **No emojis.**
