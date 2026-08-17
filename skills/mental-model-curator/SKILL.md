---
name: mental-model-curator
description: >
  Review the agent's OWN Hindsight memory bank with the most capable model and
  PROPOSE well-formed mental models ("knowledge models") to the operator via the
  approve/deny proposal card, instead of blindly creating them. Use to curate,
  seed, or audit the standing models the agent maintains over its specialty.
  Triggers on phrasings like: "curate mental models", "propose knowledge models",
  "review my memory bank", "what standing models should I have", "bootstrap
  mental models", "suggest mental models from my bank", "audit my mental models",
  "what recurring questions do I keep re-deriving", and typos like "propose
  knowlege models". ALSO owns the directive TRIAGE pass (Memory v2 M2) —
  triggers like "audit my directives", "triage my directives", "merge my
  directives", "retire stale directives", "my directives are overlapping", "too
  many active directives", "clean up my guardrails", and when switchroom doctor
  FLAGs a bank over the directive WARN/FAIL threshold. Do NOT use for storing a
  single fact/preference/decision —
  that is retain, not a mental model. Do NOT use for identity or "who is the
  user" — that lives in profile banks, so never propose an identity model here
  (the operator's review of the card, not any code guard, is the only gate — so
  it's on you to honor).
  Even when the operator directly asks you to CREATE one specific named model
  whose shape you know, PROPOSE it through the approve/deny card — never call
  create_mental_model directly (it is not pre-approved; the propose card is the
  only sanctioned write path, Fix 1.2 / #2903).
allowed-tools: mcp__hindsight__list_banks mcp__hindsight__get_bank_stats mcp__hindsight__list_mental_models mcp__hindsight__get_mental_model mcp__hindsight__list_directives mcp__hindsight__deactivate_directive mcp__hindsight__reactivate_directive mcp__hindsight__reflect mcp__hindsight__recall mcp__switchroom-telegram__mental_model_propose
---

# mental-model-curator — Propose standing knowledge models from your own bank

A **mental model** in Hindsight is a pre-computed semantic summary backed by
reflection over the memory bank — a standing answer to a recurring DOMAIN
question the agent keeps re-deriving (e.g. a coach's "current training plan,
recent sessions, and open adjustments"). This skill's job is to use your most
capable model to survey your OWN bank and PROPOSE a few well-earned models to
the operator through the approve/deny card — never to bulk-create noise.

You cannot self-approve. Every proposal renders a card the operator taps. Your
job is to make each proposal so obviously right that a glance is enough.

## Why propose instead of create

You do NOT have direct `create_mental_model` access — it is deliberately not
pre-approved (Fix 1.2 / #2903). Every mental-model write routes through
`mcp__switchroom-telegram__mental_model_propose`, because a
standing model is a persistent, always-in-context artifact with real cost
(recall/reflect spend, and — if `refresh_after_consolidation` is on — invisible
post-consolidation spend). A human should decide which of those the agent runs.
Bulk self-creation is how banks fill with overlapping, stale, or wrong-fact
models. Propose the few that are earned; let the operator ratify.

## Modes

- **Propose mode (default):** run the full workflow and fire proposal cards, one
  at a time, up to the rate limit.
- **Dry-run / preview mode:** when the user says "preview", "dry run", "just
  show me the candidates", "what would you propose", or you're testing against an
  unfamiliar bank — run steps 1–4, then OUTPUT the ranked candidate list as text
  (name + source_query + one-line reason) and STOP. Do NOT call
  `mental_model_propose` in this mode. This is the safe way to run against any
  bank.
- **Directive triage pass:** a separate job — see "Directive triage pass (Memory
  v2 M2)" below. It renders one consolidated card as text, then requires an
  explicit operator go-ahead before ANY deactivation executes — never enacts on
  the same turn the card is shown — and runs independently of the mental-model
  modes above.

## Workflow

### 1. Identify the bank and check it's worth analyzing

Resolve the session's bank (`mcp__hindsight__list_banks`, or the bank bound to
this agent's session). Then pull `mcp__hindsight__get_bank_stats`.

If the bank is **empty or thin**, STOP and report "not enough content to
synthesize models yet — the bank needs more accumulated memories before standing
models are meaningful." Synthesizing over an empty or thin bank produces
confident noise: models with no grounding that read as authoritative. A handful
of memories is not a domain. Do not propose against a thin bank, even in dry-run.

### 2. Read what already exists (dedupe)

Call `mcp__hindsight__list_mental_models`, and `get_mental_model` on each to read
its `source_query`. Build a dedupe set of the questions already covered.

The propose flow hard-rejects an EXACT-name duplicate before a card posts, but
that is not enough — a near-duplicate under a fresh name is still waste. You must
**semantically** dedupe: if a candidate's source_query asks substantially the
same thing as an existing model (even reworded), drop it. Only propose genuinely
new coverage.

### 3. Survey recurring themes

Use `mcp__hindsight__reflect` and `mcp__hindsight__recall` to find the DOMAIN
questions this agent keeps re-deriving — the standing state of its specialty.
Good prompts: "What questions do I repeatedly answer from scratch?", "What are
the recurring themes in this bank?", "What standing state would I want summarized
before every relevant turn?" Cluster the answers into candidate standing
questions. Each cluster must be backed by memories the bank ACTUALLY holds — if
you can't point to the underlying content, it's not a candidate.

### 4. Frame each candidate correctly

- **`source_query` must be a DOMAIN question**, never an identity / "who is the
  user" question. Identity lives in dedicated profile banks; never propose an
  identity-based model — the operator, not the platform, is the only gate, so
  this is on you to honor (one previously caused a wrong-fact contradiction bug).
  If a candidate is really "facts about the user", discard it.
- **`refresh_after_consolidation` defaults OFF.** Only set it true when the model
  genuinely tracks fast-moving state that must be current the moment memory
  consolidates. It adds invisible post-consolidation spend and timeout risk, so
  the default answer is off.
- **Keep models tight.** recall/reflect tiers cap around ~1024 tokens; a model
  that tries to summarize everything summarizes nothing. Set a modest `max_tokens`
  if the default would overrun. Narrow, answerable source_queries beat broad ones.
- **Few models per bank.** Each must be earned by content the bank holds. Quality
  over quantity — a bank with three sharp models beats one with ten vague ones.

### 5. Propose within limits

Rank the surviving candidates by how much re-derivation they save and how well
the bank supports them. Propose only the **top few**.

**HARD LIMIT: 5 proposal cards per hour per agent (sliding window).** Batch and
prioritize — never fire one card per cluster. If you have more than 5 worthwhile
candidates, propose the best 5 and mention the rest in text for a later pass.

Propose **one at a time**:

```
mcp__switchroom-telegram__mental_model_propose(
  chat_id=<the current chat_id>,
  name=<slug>,
  source_query=<the domain question>,
  reason=<CRISP one line — the operator sees this on the card and denies vague ones>,
  ...  # refresh_after_consolidation / max_tokens only when justified above
)
```

The `reason` is load-bearing: it's the one line the operator reads before
tapping. "Tracks the athlete's current plan + open adjustments so I stop
rebuilding it each session" earns a tap; "useful model" gets denied.

After firing a card, **END THE TURN CLEANLY.** The flow resumes on its own via a
synthetic inbound (`mental_model_proposal_applied` / `mental_model_proposal_denied`)
when the operator taps. Do not loop, do not poll, do not fire the next card in the
same turn. You cannot self-approve — that's by design.

### 6. Scheduled-sweep note (future extension)

Unattended cron proposing is **NOT supported today.** `mental_model_propose`
needs a live turn with an operator present to tap the card — firing cards into an
empty topic at 3am is useless and noisy. If invoked from a scheduled sweep,
**STAGE** the ranked candidates (retain them, or hold them) and surface them on
the next interactive turn instead of firing cards unattended. Treat live-turn,
operator-present proposing as the only supported path for now.

## Directive triage pass (Memory v2 M2)

A second, independent job of this skill: sort the bank's **active directives**
into E-45's five categories and clear the four heavy banks off the WARN line.
Directives are hard rules applied on every `reflect` — but the bank caps active
directives at **`MAX_DIRECTIVES=30`**. Past the cap, the lowest-priority
directives are **truncated** from the `<active_directives>` recall block and
never reach the agent (recorded as `directives_omitted` on the recall_log row
— the recall hook's stderr warning is swallowed by Claude Code, so don't look
there). Fleet doctor WARNs at >24 active and FAILs at >30 (`doctor-memory.ts`,
`DIRECTIVE_WARN_THRESHOLD`), and its fix text points here.

**Honest framing (do not oversell):** as of the M2 measurement pass, NOTHING is
currently being silently dropped fleet-wide — zero directives have ever been
retired, and `directives_omitted` has fired zero times. This is a **budget +
hygiene** pass, not a rescue from silent drops. Say it that way; overstating the
urgency is its own failure.

**The five categories every active directive sorts into (E-45):**

| Category | Meaning | What happens in THIS pass |
|---|---|---|
| `reflect-directive` | A genuine compliance guardrail (§4.2's designed role) | KEEP — no change |
| `rules-block` | A standing preference that belongs in the CLAUDE.md rules block (M1) | **STAGE ONLY — stays ACTIVE.** See the hard rule below. |
| `disposition` | Better expressed as `disposition_*` bank config (E-40) | Deactivate; note the config change separately for the operator — do NOT auto-apply it |
| `retire` | Superseded or mechanized — dead weight | Deactivate (record `superseded_by` when a winner exists) |
| `retain-as-memory` | A fact filed as a directive by mistake (category error) | Deactivate — verify the fact already exists as a memory in the bank BEFORE proposing this; don't assert it, check it |

**Retirement signals are deterministic and bounded (E-45).** A directive is
ONLY a retirement candidate when you can point to one of: (a) it is tagged
`superseded-by:<name>` (or you would tag it that way, naming the winner), or
(b) a mechanization reference (a named commit/PR/scaffold rule that now does
this automatically), or (c) a documented category error you can verify against
the bank's own memories/config. **Citation counts are NEVER a signal** (a rule
that works quietly gets zero citations). **Age alone is NEVER sufficient.** A
directive with none of these signals is `reflect-directive` — KEEP — by
default. Never propose retiring a directive because it "seems old" or "looks
unused."

### HARD RULE — never deactivate a `rules-block`-category directive in this pass

If a directive's behaviour is destined for the CLAUDE.md rules block (M1), its
migration happens at **M3 flip time**, when that surface goes live for this
agent — not now. M1 shipped dark (`memory.rules_block` off on every agent
today); deactivating a `rules-block`-category directive before that flip would
leave the agent with **neither** the directive (deactivated) **nor** the rule
(block not live) — a silent guardrail gap for however long the M2→M3 interval
runs. So: **for every directive you categorise `rules-block`, call
`list_directives` to confirm it, but do NOT call `deactivate_directive` on it
in this pass, ever** — only stage its text (mention it in the card as staged,
count it, and leave it exactly as-is) for the M3 flip to pick up later
(`rule add`, once `memory.rules_block` is on for this agent). This mirrors the
code-level refusal in `DirectiveAdmin` itself
(`src/memory/hindsight-directive-admin.ts` — `deactivate`/`deactivateById`/
`deactivateByIdWithTag` all refuse a directive carrying the persisted
rules-block marker tag, the one chokepoint every call path shares, including
this skill's own `deactivate_directive` calls) — you are the enforcement
point when running this pass interactively through the MCP tools directly, so
treat this instruction with the same weight as that code guard, not as an
optional style note.

### When to run it

- The operator asks (see the directive triggers in the description), OR
- switchroom doctor flags a bank at/over the directive WARN/FAIL threshold, OR
- you're already curating the bank and notice the directive set is bloated.

### Workflow

1. **List every directive, active and inactive context.** `mcp__hindsight__list_directives`
   (active only is fine for triage — inactive ones are already off). If the
   active count is comfortably under the WARN threshold (≤24) AND nothing reads
   stale/overlapping, STOP and report "directive set is healthy (N active) —
   nothing to triage." Don't manufacture churn.
2. **Classify every directive — no drops.** For each one, assign exactly one of
   the five categories above, with the deterministic signal that justifies it
   (or "no signal — KEEP" for the default case). Do this for the FULL set —
   the card is worthless if a directive silently doesn't appear on it.
3. **Render ONE consolidated card as text.** Two sections, KEEP/staged first,
   retirement candidates second — never interleaved, so a skim of "the bottom
   half" cannot land on a live guardrail:
   - **Keep / staged (N):** every `reflect-directive` and `rules-block` row,
     each showing priority + category + signal (or "no signal — default KEEP").
   - **Retirement candidates (N):** every `disposition` / `retire` /
     `retain-as-memory` row, each showing priority + category + the
     deterministic signal — never a bare category with no rationale.
   - The resulting active count vs `MAX_DIRECTIVES` if the retirements land.
4. **STOP. Get an explicit operator go-ahead before touching anything.** Do not
   deactivate on the same turn the card is shown. The card is the operator's
   one look before a batch of guardrails changes state.
5. **On go-ahead, retire ONE AT A TIME with a human tap PER retirement — never
   a single blanket go-ahead for the whole batch.** `deactivate_directive` is
   pre-approved fleet-wide (`scaffold.ts`'s 2026-07-29 amendment,
   `HINDSIGHT_MCP_TOOLS`) — unlike `delete_directive`, calling it does NOT
   raise a Telegram permission card by itself. That is exactly why this skill
   must supply the per-call gate `delete_directive`'s card would otherwise
   have given: present the NEXT retirement candidate (name, priority, signal,
   proposed `superseded_by`) on its own, then **STOP and end the turn** —
   do not proceed to it, and do not queue the next one, until the operator's
   reply for THIS ONE arrives. Only after an explicit per-row confirmation do
   you call `mcp__hindsight__deactivate_directive` for that single directive.
   Then present the next candidate the same way. A single "yes, go ahead" that
   covers the whole retirement list is NOT sufficient — that collapses back
   to the batch-level prose go-ahead this per-row loop exists to replace, and
   silently trades away the human tap `delete_directive`'s approval card used
   to guarantee for every one of these retirements (see PR #4760 review B2).
   Pass `superseded_by` when you named a winner. After the LAST retirement in
   the plan lands, `list_directives` again and report the new active count
   against `MAX_DIRECTIVES`, plus which directives moved where.
6. **Disposition rows are a note, not an auto-edit.** When you deactivate a
   `disposition`-category directive, separately flag to the operator which
   `disposition_*` bank config change it corresponds to — do NOT edit bank
   config yourself in this pass (E-40: audit before leaning on it).

### windows-boxes-class fixes (a drifted directive with a peer's superset text) — special-cased, rare

Do NOT attempt this as an ordinary retirement. If a directive on this bank has
drifted from a peer agent's superset/reconciled version of the "same" rule
(content differs but the two should say the same thing), that is NOT
expressible as a `content`-PATCH — the shim deliberately refuses to PATCH
directive `content` (`hindsight-directive-admin.ts` — a directive body is the
guardrail itself; there is no history table to recover a bad rewrite from).
It is also NOT safely expressible as plain `create_directive` +
`deactivate_directive` calls from this skill: once the new copy is created
carrying the SAME name, `deactivate_directive`'s name-resolution sees two
directives sharing that name and refuses as ambiguous. Use
`reconcileDirectiveSuperset` (`src/memory/directive-triage-executor.ts`) for
this instead — it resolves the old copy's id BEFORE creating the new one and
retires it by id, so the name collision never becomes an ambiguity error. This
is NOT a bare MCP tool call from this skill (no MCP tool exposes an
id-targeted deactivate) — it runs via
`switchroom memory directive reconcile <agent> <name> <content...>`
(`src/cli/memory-directive.ts`), an operator or repo-authorized CLI/script
invocation, not something this skill invokes autonomously. Flag any drift you
notice to the operator rather than improvising a fix.

### Directive-pass anti-patterns

- ❌ Deactivating a `rules-block`-category directive before M3 flips this
  agent — opens a guardrail gap; see the hard rule above.
- ❌ Retiring on age or citation count alone — E-45 refuses both as signals.
- ❌ Calling `deactivate_directive` in parallel / without awaiting each one —
  sequential only (tag-write race).
- ❌ Executing on the same turn the card is shown — the card review is the
  gate; always stop for an explicit go-ahead first.
- ❌ Treating one blanket "yes, go ahead" as clearance for the whole
  retirement list — `deactivate_directive` is pre-approved (no Telegram card
  per call), so this skill's own per-retirement stop-and-confirm loop IS the
  human tap; batching it away silently weakens the guardrail (review B2).
- ❌ Auto-editing bank config for a `disposition` row — flag it, don't apply it.
- ❌ Treating a drifted/superset-text directive as an ordinary retirement —
  see the windows-boxes-class section above.
- ❌ Manufacturing retirements on a healthy small set just to "tidy" — run the
  pass when it's earned (bloat, overlap, staleness, or a doctor flag), not
  reflexively.
- ❌ Leaving a live contradictory pair in place — surface it as the top
  retirement candidate; it's what makes `reflect` nondeterministic.

## Anti-patterns

- ❌ Proposing against an empty or thin bank — synthesizes to noise.
- ❌ An identity / "who is the user" source_query — forbidden; profile banks own that.
- ❌ Ten near-duplicate models under different names — semantically dedupe first.
- ❌ Firing a card per cluster — respect the 5/hour limit; propose the top few.
- ❌ `refresh_after_consolidation: true` by default — it's an invisible cost; leave it off unless the model tracks fast-moving state.
- ❌ A vague `reason` — the operator denies it and you've burned a slot.
- ❌ Looping/polling after a proposal — end the turn; the resume inbound wakes you.

## Output

In propose mode: a short line naming what you proposed and that the operator's
tap will resume the flow. In dry-run mode: the ranked candidate list (name +
source_query + reason) and nothing fired.
