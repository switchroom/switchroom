# Phase 2 — Triage prompt

Self-contained prompt for the single triage agent. Dispatched after
all Phase 1 findings are written. Reads the entire findings set and
produces the work packages Phase 3 will execute.

---

## Prompt to dispatch

You are the drift-audit triage agent. Phase 1 produced one YAML
findings file per audited unit at `audit/{{run_date}}/findings/`.
Your job is to read them all and produce:

1. `audit/{{run_date}}/summary.md` — human-readable overview.
2. `audit/{{run_date}}/fix-batches/<topic>.md` — Phase 3 work
   packages, one per logical group.
3. `audit/{{run_date}}/escalations.md` — findings the operator must
   decide on (cannot be auto-fixed).

**Read first:**

- `scripts/drift-audit/README.md` — workflow overview, fix posture.
- `scripts/drift-audit/manifest.yaml` — to map unit_id → category.
- All files under `audit/{{run_date}}/findings/`.

You may also `Read` any file mentioned in a finding's `evidence` to
sanity-check before grouping.

---

## What to produce

### 1. `summary.md`

A single markdown file. Sections:

- **Run header** — date, scope (e.g. "pilot: 23 reference/ units"),
  total findings, distribution by verdict.
- **By category** — for each category present in the manifest, a
  one-line count: `jtbd: 14 units, 195 findings (120 aligned, 40
  drift-minor, 20 drift-major, 5 escalate)`.
- **Top-5 hotspots** — units with the most non-`aligned` findings.
- **Recurring themes** — drift patterns you noticed across units
  (e.g. "five JTBDs still reference the retired pinned progress
  card"). Bullet list.
- **Coverage notes** — anything Phase 1 couldn't verify (units with
  many `low` confidence findings).

Keep it under ~200 lines. It's a triage summary, not a report.

### 2. `fix-batches/<topic>.md`

Group findings into work packages. **Each batch must be:**

- **Disjoint** in the files it edits — two batches must not both
  propose edits to the same file. Phase 3 runs in parallel; file
  conflicts break parallelism.
- **Coherent** — a maintainer reading the batch should see a single
  topic (e.g. "remove pinned-progress-card references from JTBDs and
  artefact docs").
- **Sized** to one PR — 1 to ~8 findings typically. Bigger batches
  fragment review; smaller batches fragment history.
- **Self-contained** — Phase 3 reads only the batch file, not the
  whole findings set. Include everything the fix agent needs:
  unit_id, claim_id, quote, loc, proposed action, rationale,
  evidence paths.

Naming: `<topic-kebab-case>.md`. Examples:
- `jtbd-remove-progress-card-references.md`
- `rfc-docker-promote-to-shipped.md`
- `prd-refresh-disclaimer.md`
- `vision-trim-unsubscribed-channels-list.md`

Batch file shape:

```markdown
# Fix batch: <one-line title>

**Scope:** which files are edited.
**Verdict pattern:** which Phase 1 verdicts dominate this batch.
**Estimated edits:** rough line count or "small/medium/large."

## Findings in this batch

### Finding 1 — <unit_id>:<claim_id>

- **File:** `reference/foo.md` L42-L45
- **Quote:** "the pinned progress card stays visible while the
  agent works"
- **Verdict:** drift-major
- **Proposed action:** update-text
- **Proposed text:** "the agent's reply streams in place while it
  works"
- **Evidence:** `telegram-plugin/stream-reply-handler.ts:L88-L120`
  (no card pin call); `CHANGELOG.md` notes #1122 retired the pinned
  card.
- **Rationale:** The pinned progress card was retired in #1122. The
  current mechanism is in-place reply streaming.

### Finding 2 — ...

## Out of scope for this batch

- Edits to `docs/telegram-plugin.md` that mention the card — those
  live in `docs-remove-progress-card-references.md` (separate batch
  to keep file sets disjoint).
```

### 3. `escalations.md`

Findings the operator must decide. These are:

- All findings with verdict `outcome-not-realized` or
  `code-violates-contract` — product decisions.
- All findings with `confidence: low` that triage couldn't elevate
  by re-reading the evidence.
- Conflicts between findings (two units make incompatible claims and
  the triage agent can't tell which is right).
- Findings where the proposed action would touch a "Don't touch"
  area listed in `CLAUDE.md` Safety rails.

For each: cite the finding (unit_id + claim_id), state the question
the operator must answer, and propose the two or three options.
Don't decide for them.

---

## Constraints

- **You are read-only outside your three output files.**
- **Do not edit findings files.** If a finding is wrong, note it in
  `escalations.md` and let Phase 4 (re-verify) catch up.
- **Disjoint file sets across batches.** Re-check before writing.
  Listing a file in two batches is a triage bug.
- **No emojis.**
- **Cite finding ids consistently:** `<unit_id>:<claim_id>` (e.g.
  `jtbd-know-what-my-agent-is-doing:c4`).
