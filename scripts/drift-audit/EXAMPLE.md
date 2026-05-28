# Worked example: claim → finding → batch → fix

A single drift case followed end-to-end through the workflow. Use
this as the canonical shape new audit agents should produce.

The example is real (illustrative): the pinned progress card was
retired in #1122, but several JTBDs and the conversational-pacing
artefact may still describe it as the mechanism. This walks one such
claim through the four phases.

---

## Phase 0 — In the manifest

```yaml
- id: jtbd-know-what-my-agent-is-doing
  path: reference/know-what-my-agent-is-doing.md
  category: jtbd
  anchors_hint: |
    Plain-language state, never silent. ... Note: the pinned progress
    card was retired in #1122 — JTBD must not still describe it as
    the mechanism.
```

The `anchors_hint` is a Phase 1 nudge — not a comprehensive list of
what to check, just a starting point.

## Phase 1 — Audit finding

The Phase 1 agent reads
`reference/know-what-my-agent-is-doing.md` end-to-end and extracts
this claim (hypothetical line numbers):

> *"A pinned progress card stays at the top of the topic while the
> agent works, edited in place with the current step."* — L48-L50

The agent greps the telegram-plugin code, finds
`telegram-plugin/stream-reply-handler.ts` and
`telegram-plugin/card-format.ts`, and confirms:

1. There is no `pinChatMessage` call associated with progress.
2. `CHANGELOG.md` notes #1122 retired the pinned progress card.
3. The current mechanism is in-place reply streaming (the reply
   message itself is edited as the agent works).

The finding gets written to
`audit/2026-05-26/findings/jtbd-know-what-my-agent-is-doing.yaml`:

```yaml
unit_id: jtbd-know-what-my-agent-is-doing
unit_path: reference/know-what-my-agent-is-doing.md
category: jtbd
audited_at: 2026-05-26T14:00:00Z
auditor_notes: |
  Two findings — one drift-major on the progress card, one
  jtbd-stale-example on the "Signs it's working" bullet referencing
  it. Both point at the same underlying drift (retired feature).
findings:
  - claim_id: c1
    quote: |
      A pinned progress card stays at the top of the topic while the
      agent works, edited in place with the current step.
    loc: L48-L50
    verdict: drift-major
    evidence:
      - path: CHANGELOG.md
        lines: L412-L418
        snippet: |
          #1122 — Retire the pinned progress card. The mechanism is
          now in-place reply streaming...
      - path: telegram-plugin/stream-reply-handler.ts
        lines: L88-L120
        snippet: |
          // Edits the reply message in place; no pin call.
          await ctx.api.editMessageText(...)
      - path: telegram-plugin/card-format.ts
        lines: L1-L40
        snippet: |
          // Formats card content inline within the reply message;
          // no longer renders a separate pinned card.
    evidence_strength: strong
    action: update-text
    proposed_text: |
      The agent's reply updates in place while it works, with the
      current step visible. No pinned card; the chat IS the artifact.
    confidence: high
    rationale: |
      The pinned progress card was retired in #1122. The current
      mechanism is in-place reply streaming. This is also explicit
      in the "chat IS the artifact" sub-principle in
      reference/principles.md L187-L201, which now reads as the
      design intent the retirement realized.

  - claim_id: c2
    quote: |
      *Signs it's working:* The progress card shows "writing reply"
      then "sending" then disappears.
    loc: L72-L74
    verdict: jtbd-stale-example
    evidence:
      - path: CHANGELOG.md
        lines: L412-L418
    evidence_strength: strong
    action: update-text
    proposed_text: |
      *Signs it's working:* The agent's reply appears as a single
      message that updates in place — first a short preview, then
      the full answer. The pacing matches the user's energy.
    confidence: high
    rationale: |
      Same drift as c1 — the "Signs it's working" example was
      written against the retired card mechanism.
```

## Phase 2 — Triage groups it into a batch

Triage notices the same drift in `feel-like-a-colleague.md`,
`survive-reboots-and-real-life.md`, and
`conversational-pacing.md` — five findings across four files all
pointing at the retired card. It writes
`audit/2026-05-26/fix-batches/jtbd-remove-progress-card-references.md`:

```markdown
# Fix batch: remove pinned-progress-card references from JTBDs and artefact

**Scope:** reference/know-what-my-agent-is-doing.md,
reference/feel-like-a-colleague.md,
reference/survive-reboots-and-real-life.md,
reference/conversational-pacing.md

**Verdict pattern:** drift-major (3) + jtbd-stale-example (2). All
trace to PR #1122 retiring the pinned progress card; current
mechanism is in-place reply streaming.

**Estimated edits:** small (≤25 lines across 4 files).

## Findings in this batch

### Finding 1 — jtbd-know-what-my-agent-is-doing:c1
- **File:** `reference/know-what-my-agent-is-doing.md` L48-L50
- **Quote:** "A pinned progress card stays at the top..."
- **Verdict:** drift-major
- **Proposed action:** update-text
- **Proposed text:** "The agent's reply updates in place while it
  works, with the current step visible. No pinned card; the chat IS
  the artifact."
- **Evidence:** CHANGELOG.md L412-L418; stream-reply-handler.ts
  L88-L120; card-format.ts L1-L40.
- **Rationale:** Pinned card was retired in #1122.

### Finding 2 — jtbd-know-what-my-agent-is-doing:c2
... (same pattern)

### Finding 3 — jtbd-feel-like-a-colleague:c5
... (same pattern, different file)

## Out of scope for this batch

- `docs/telegram-plugin.md` references to the card — those live in
  the separate batch `docs-remove-progress-card-references.md` to
  keep file sets disjoint.
- `principles.md` "chat IS the artifact" sub-principle — already
  reflects the post-#1122 design correctly. No action.
```

## Phase 3 — Fix agent applies the batch

A Phase 3 agent receives the batch file, branches off
`origin/main` (or `upstream/main` in fork mode), applies each `Edit`
operation, and runs `tsc --noEmit` (clean because no `src/` edits).
It opens one PR titled "docs(drift-audit): remove pinned progress
card references from JTBDs" with the batch findings linked in the
body and the reviewer checkbox unchecked.

The operator (or a reviewer agent) reads the PR, APPROVEs, then the
operator enables auto-merge.

## Phase 4 — Re-verify

After the PR merges, Phase 4 re-runs Phase 1 on the four touched
units. For
`reference/know-what-my-agent-is-doing.md` the new findings file at
`audit/2026-05-26/reverify/jtbd-know-what-my-agent-is-doing.yaml`
shows c1 and c2 as `aligned`. Diff produces:

- **Resolved:** 5 findings (the original drift-major + stale-example
  set).
- **Persistent:** 0.
- **New:** 0.

No entry in `regressions.md` for this batch — the drift is gone.

---

## What "good" looks like

- Each phase's output is **self-contained** — the next phase doesn't
  need to re-read what came before, just the artefact in front of it.
- **Evidence is always `file:line` with a quoted snippet.** "Probably
  somewhere in `telegram-plugin/`" isn't a finding.
- **Proposed text is short and concrete.** A sentence or two. The
  fix agent adapts to surrounding prose.
- **Disjoint batches.** No two batches edit the same file. If you
  notice triage broke this rule, fix it before Phase 3 dispatches.
- **JTBDs stay user-facing.** The proposed text in this example
  describes what the user *sees* ("reply updates in place"), not
  what the code *does* ("`stream-reply-handler.ts` calls
  `editMessageText` in a loop").
