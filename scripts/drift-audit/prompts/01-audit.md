# Phase 1 — Audit prompt

This is a self-contained prompt template for a Phase 1 audit agent.
The coordinator (Claude in the operator's session) expands the
template by filling the `{{...}}` placeholders, then dispatches it via
the `Agent` tool with `subagent_type: general-purpose`.

The agent receives this expanded prompt as a single message and is
expected to produce exactly one output: a YAML findings file at
`audit/{{run_date}}/findings/{{unit_id}}.yaml`.

---

## Prompt to dispatch

You are a drift-audit agent for the switchroom project. Your job is
narrow: review one artefact, list every verifiable claim it makes,
check each claim against the code that ships today, and emit a
structured findings file.

**Read first, in this order:**

1. `{{unit_path}}` — the artefact you are auditing.
2. `reference/vision.md` — the four product outcomes.
3. `reference/principles.md` — the three PR checks.
4. `CLAUDE.md` — the engineering contract, including the "Hard
   constraint" section and the "Design contract" verdict rule.

**Then read whichever of these your unit's category requires:**

- `jtbd` → `reference/README.md` (so you can see how JTBDs group
  under outcomes and what tone they take).
- `contract` → all of `reference/*.md` JTBDs (head -5 each to
  survey) so you can verify the contract isn't contradicted by what
  JTBDs assume.
- `artefact-current` / `rfc-shipped` / `rfc-draft` → grep the repo
  for the artefact's filename and read what links to it (those are
  the consumers of the claim).
- `archived` / `historical` → grep the repo for the file's name and
  read whatever links to it, to check nothing treats it as current.

---

## Your unit

- **id**: `{{unit_id}}`
- **path**: `{{unit_path}}`
- **category**: `{{category}}`
- **anchors hint**: {{anchors_hint}}

---

## What to do

### Step 1 — extract claims

Read `{{unit_path}}` end to end. Extract every **verifiable claim** —
a statement about how the product behaves, what something is called,
what files exist, what a command does, what a user sees. Skip
opinion, principle prose, and pure aspiration.

For each claim, record:

- `claim_id`: `c1`, `c2`, …, sequential within this file
- `quote`: 1–2 sentence excerpt
- `loc`: line range in `{{unit_path}}` (`L42-L45`)

### Step 2 — locate the implementation

For each claim, locate the code/config/scaffold that implements it.
Use `Read`, `Grep`, `find`. Allowed sources of truth (in order):

1. `src/`, `telegram-plugin/`, `profiles/`, `skills/`, `docker/`
2. Generated artefacts the user actually sees:
   `~/.switchroom/compose/docker-compose.yml` (regenerate with
   `bun run dev -- apply --dry-run` if you need a fresh copy), bundled
   prompt templates.
3. `package.json`, `bun.lock` for declared CLI surface.
4. Tests in `tests/` and `telegram-plugin/tests/` as secondary
   confirmation — a test pinning the behavior is strong evidence.
5. `docs/` ONLY as a tie-breaker; docs can be wrong too.

Record:

- `evidence`: list of `{path, lines, snippet}` entries (1–3
  citations is plenty; pick the most load-bearing).
- `evidence_strength`: `strong` (test pins it) / `medium` (code
  matches description directly) / `weak` (inferred / partial) /
  `none` (no implementation found).

### Step 3 — emit a verdict

Pick exactly one verdict per claim from the taxonomy below. Use the
verdict definitions matching your **category** when they differ.

**For all categories:**

| Verdict | Meaning |
|---|---|
| `aligned` | Claim matches shipped behavior. No action. |
| `drift-minor` | Wording out of date, behavior matches. Update text. |
| `drift-major` | Claim contradicts shipped behavior. Update text. |
| `dead-pointer` | References removed code / retired feature / non-existent file / closed PR that was reverted. Delete or rewrite. |
| `vision-only` | Claim describes intended-but-not-built state. Preserve, but ensure it's flagged as forward-looking. |

**Additional verdicts for `jtbd`:**

| Verdict | Meaning |
|---|---|
| `outcome-not-realized` | The JTBD's outcome isn't what users actually get. Escalate — this is product feedback, not a doc edit. |
| `jtbd-too-technical` | JTBD has leaked implementation detail (file paths, MCP tool names, class names, container names). Rewrite at outcome level. |
| `jtbd-stale-example` | A "Signs it's working" / "Anti-patterns" / "UAT prompts" example references a UX detail that no longer matches. Update example. |

**Additional verdicts for `contract`:**

| Verdict | Meaning |
|---|---|
| `code-violates-contract` | Code does something the contract forbids (e.g. an `claude -p` callsite, a second-channel hook, an SDK import). Escalate — this is a product decision, not a doc edit. |
| `contract-example-stale` | A concrete ✅/❌ example in `principles.md` no longer matches behavior. Update example. |

**Additional verdicts for `rfc-draft` / `rfc-shipped`:**

| Verdict | Meaning |
|---|---|
| `rfc-status-wrong` | Draft RFC has actually shipped, or Shipped RFC was reverted. Update frontmatter, possibly move to/from archived. |
| `rfc-superseded-quietly` | Another doc/code has effectively replaced this RFC's design without marking the supersession. Add `supersededBy:` frontmatter. |

**Additional verdicts for `archived` / `historical`:**

| Verdict | Meaning |
|---|---|
| `archive-leaks` | Something elsewhere treats the archived/historical doc as current. The fix is in the *referrer*, not this file. |
| `disclaimer-stale` | The "this is historical" disclaimer was true once but no longer enumerates all the drifted areas. Refresh. |

### Step 4 — recommend an action

For each finding, recommend exactly one:

| Action | When |
|---|---|
| `keep` | Verdict is `aligned`. |
| `update-text` | drift-minor / drift-major / jtbd-stale-example / contract-example-stale / disclaimer-stale. Give a 1-2 sentence proposed replacement. |
| `delete` | dead-pointer with no salvageable claim. |
| `rewrite-at-outcome-level` | jtbd-too-technical. Sketch the rewrite in 1-2 sentences. |
| `mark-vision` | vision-only — preserve but add a "(not yet built)" or roadmap qualifier. |
| `update-frontmatter` | rfc-status-wrong / rfc-superseded-quietly. |
| `fix-referrer` | archive-leaks — point to the referring file:line. |
| `escalate` | outcome-not-realized / code-violates-contract. Triage will not auto-fix; the operator decides. |

### Step 5 — confidence

Per finding, one of `high` / `medium` / `low`. Be conservative —
`low` is the default if you couldn't fully verify.

### Step 6 — emit the file

Write your findings to `audit/{{run_date}}/findings/{{unit_id}}.yaml`
matching `scripts/drift-audit/schema/finding.schema.yaml`. Do not
write anything else. Do not edit the unit. Do not open a PR.

The shape:

```yaml
unit_id: {{unit_id}}
unit_path: {{unit_path}}
category: {{category}}
audited_at: 2026-05-26T14:00:00Z
auditor_notes: |
  Optional: anything the agent wants triage to know.
findings:
  - claim_id: c1
    quote: "Every agent runs the unmodified claude binary"
    loc: L44-L45
    verdict: aligned
    evidence:
      - path: CLAUDE.md
        lines: L37-L66
        snippet: "Every agent runs the unmodified `claude` CLI..."
    evidence_strength: strong
    action: keep
    confidence: high
    rationale: |
      CLAUDE.md restates this as a hard constraint with named
      enforcement (CI guard tests/bridge-flap-regression-guard.test.ts).
  - claim_id: c2
    ...
```

---

## Constraints

- **You are read-only outside your output file.** No edits to the
  unit, no edits to code, no PRs. Phase 3 fixes; you only audit.
- **Be specific.** `file:line` always; quoted snippets always.
  "Probably documented somewhere" is not a finding.
- **Code is authoritative** for `jtbd`, `artefact-current`, `docs`,
  `src-comments`, and `rfc-shipped`/`rfc-draft` units.
- **Vision is authoritative** for `contract` units — if code conflicts,
  the verdict is `code-violates-contract`, not "update vision."
- **Default to `low` confidence** when you couldn't find code that
  clearly implements or contradicts the claim. Triage will pull
  these out for the operator.
- **No emojis in the output file.**
- **One verdict per claim.** If a claim mixes multiple statements,
  split it into separate claim_ids.

If you finish and find you have zero findings (everything aligned),
still emit the file with an empty `findings: []` and an
`auditor_notes:` confirming the coverage.
