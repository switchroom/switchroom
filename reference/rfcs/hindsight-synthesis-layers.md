---
artefact: Hindsight primitive fit — use the synthesis layers the memory job demands
serves: jobs/remember-across-sessions.md
relates: jobs/run-a-fleet-of-specialists.md, jobs/feel-like-a-colleague.md
status: proposal (2026-06-18, rev. speed/token budget) — analysis + phased plan, not yet scheduled
---

# Hindsight synthesis layers — what we run vs. what the job asks for

Switchroom runs the Hindsight memory engine but consumes only its
weakest layer. Hindsight ships four tiers of memory — raw facts,
**observations**, **directives**, **mental models** — and an agentic
**reflect** path built to prefer the top tiers. Switchroom uses it as a
*raw-fact store*: retain everything → recall raw `world`/`experience`
facts → inject them invisibly. That is close to the exact shape the
[`remember-across-sessions`](../jobs/remember-across-sessions.md) job
names as **bad** ("raw transcript dumping passed off as memory",
"grab-bag", "every memory equally weighted"). The synthesis tiers are
the job's **good** ("curated, semantic, retrieved by relevance",
"honest legible answer about what it believes and why"), and they're
already being generated on the subscription — just not consumed.

This is a design record + phased proposal. It does not change a job
spec or an invariant; it argues for using capability we already pay
for, within the lines.

## Evidence (live, 2026-06-18)

- **Observations are generated but not recalled.** 45,766 `observation`
  rows exist (deduped synthesis, each with `proof_count` +
  `source_memory_ids` provenance), produced automatically by the
  consolidation engine on every retain. Switchroom's auto-recall hook
  requests `types=["world","experience"]` only (vendored plugin default;
  `vendor/hindsight-memory/scripts/lib/config.py`), so the synthesized
  layer is excluded from what reaches the agent. We pay the
  consolidation cost and drop the output.
- **One mental model per agent.** Every agent bank has exactly the
  host-seeded `user-profile` model (`src/memory/hindsight.ts`
  `ensureUserProfileMentalModel`). Nothing creates more; the engine
  never auto-creates them (only `create_mental_model` does, an explicit
  call). The richer banks (clerk/`assistant`: 4 models; `lawgpt`: 7)
  were curated by hand, not grown.
- **Reflect prefers the tiers we don't feed it.** The reflect agent's
  forced tool order is `search_mental_models` → `search_observations`
  → `recall` (raw) (with `expand` available but not forced); on a
  non-high budget it short-circuits the lower tiers if the mental
  models come back fresh. Switchroom
  invokes reflect only on explicit "what do you know about me" asks,
  and feeds it mostly raw facts plus the one model.
- **Per-agent banks are isolated but not specialized.** Banks are keyed
  per agent (satisfies isolation), but each bank's `retain_mission` /
  `reflect_mission` / `disposition` (skepticism/literalism/empathy)
  appear generic rather than shaped per specialist.

## Supply side — the four tiers (what each is)

| Tier | What it is | Created by | Inspectable? |
|---|---|---|---|
| Raw facts (`world`/`experience`) | sentence-level extracted facts | retain → extraction LLM | yes |
| **Observations** | deduped synthesized statements over N facts, with `proof_count` + sources | consolidation engine (auto) | yes (provenance) |
| **Directives** | user-authored hard rules ("always…", "never…") | explicit `create_directive` | yes (verbatim) |
| **Mental models** | pinned, named, self-refreshing reflections answering a stored query | explicit `create_mental_model` | yes (named, legible) |

`reflect` is the agentic read path that synthesizes across all four;
`recall` is the raw read path. Banks carry three missions
(`retain_/reflect_/observations_mission`) + a `disposition` that shape
extraction, synthesis, and voice per bank.

## The fit map — primitive × job

| Primitive | Serves | Today | Verdict |
|---|---|---|---|
| **Mental models** | remember ("ask what it believes about you → legible answer"); colleague (continuity) | 1/agent, host-seeded | **Top opportunity** — the literal embodiment of the legible profile |
| **Observations** | remember ("curated, by relevance, not grab-bag"; inspectable) | generated, **not recalled** | **Wasted spend** — consume them |
| **Directives** | colleague + remember ("rules set once stay respected"; "correction sticks") | used lightly | **Most invariant-clean** primitive — lean in |
| **reflect** | remember ("what do you know about me") | explicit asks only | underleveraged as a recall path |
| **Bank missions + disposition** | fleet-of-specialists ("persona without own memory is cosplay") | generic | specialization lever, untouched |
| **recall** (raw) | remember (necessary) | core path | keep — but it is the grab-bag tier |
| Entity graph / links / cooccurrences | improves recall relevance (plumbing) | auto-built | keep as infra; not a vision lever |
| Webhooks (`consolidation.completed`) | could make memory chat-legible | unused | invariant-fix lever (below) |
| Transfer / audit-log / async-ops tools | marginal to the jobs | unused | leave |

## Where Hindsight would *not* help — invariant tensions

The synthesis tiers help, but some of Hindsight's always-on behavior
rubs against switchroom's lines. Name these honestly; the proposal is
shaped to stay clean of them.

1. **Silent background consolidation vs
   [`chat-is-the-single-source-of-truth`](../invariants.md) + `on-leash`.**
   The engine runs LLM consolidation/observation/graph-building the
   operator never triggered and never sees — "memory silently updating
   on patterns the user can't see" is the anti-pattern the job names.
   Bounded and inspectable in output, but it is background model-spend
   on the subscription the operator didn't initiate (also brushes
   [`crons-use-the-model-only-when-it-earns-it`](../jobs/crons-use-the-model-only-when-it-earns-it.md)).
2. **Invisible recall injection vs "honest, legible recall."** The
   `<hindsight_memories>` block is hidden `additionalContext`; the user
   never sees what was recalled or why, but the job wants recall
   legible/inspectable.
3. **Auto-creating mental models vs `on-leash` / `no-self-escalation`.**
   An agent enriching its own memory structure unprompted is borderline
   self-escalation. The invariant-clean shape is **operator-curated, or
   agent-proposes → operator-confirms, surfaced in chat** — never a
   silent self-write.
4. **No time-based decay is actually aligned.** Hindsight never forgets
   (recency is a soft ±10% weight); the job calls silent forgetting bad
   and wants *explicit* demote/correct — which exists (the
   `[demote-from-recall]` tag + `invalidate_memory`). Keep it.

`single-tenant` and `claude-native` are satisfied by construction
(per-agent embedded banks; the `claude-code` provider runs synthesis on
the subscription, no API path). No conflict.

## Proposal — phased, invariant-clean

Ordered by leverage-per-effort. Each phase is independently shippable
and crosses no invariant.

**Phase 1 — Consume what we already synthesize (cheapest, highest leverage).**
Add `observation` to the auto-recall `types`. Turns 45k of paid-for,
deduped, provenance-carrying observations from dead weight into the
"curated, by-relevance" recall the job demands. Pure consumption change
in the same `memory_units`/HNSW index — near-zero added recall latency,
and observations are *denser* (one synthesized statement replaces N raw
facts) so coverage improves inside the same 1024-token cap. **Do not**
route the hot recall path through `reflect` (an agentic ~5-iteration
loop, 300s ceiling) — that would blow warm TTFO (~1.7s) into seconds and
multiply per-turn tokens; reflect stays reserved for explicit
"what do you know about me" asks. See *Speed & token budget* below — this
phase may also let the recall budget drop `mid`→`low` (faster + cheaper).

**Phase 2 — Specialize each bank.** Set a per-agent `retain_mission` /
`reflect_mission` / `disposition` from the agent's profile (a coach
extracts/voices differently than a lawyer). Makes specialists'
memory *specialized*, not merely *isolated* — directly serves
fleet-of-specialists. Operator-config-driven (no-self-escalation clean).

**Phase 3 — Directives as the "corrections stick" path.** Route
user-stated preferences/rules into `create_directive` (user-authored,
verbatim, chat-legible) rather than hoping recall re-surfaces them. The
most invariant-aligned primitive for the job's "rules set once stay
respected / correction sticks" criteria.

**Phase 4 — Make memory chat-legible (sparse, not per-turn).** Surface a
terse "remembered: X" / "updated what I know about Y" line so recall and
consolidation stop being invisible — closing tension (1) and (2). **This
must be sparse and material-only**, never default-on-every-turn:
the job lists "regurgitating old facts unprompted just to prove it
remembered" as a top anti-pattern, so a per-turn legibility line would
*become* that anti-pattern. Surface only on a genuine store/correct, or
on request. The `consolidation.completed` webhook can drive the update
side without polling.

**Phase 5 — Curated mental models per specialist (selective).**
Operator-curated, or agent-proposes → operator-confirms in chat, for
specialists that earn a pinned model (the gap behind "Hindsight doesn't
create models as needed"). Deliberately *not* autonomous creation
(tension 3). Curate **selectively** — each model adds
post-consolidation refresh spend (bounded ~2048 tokens, but can hit the
300s reflect timeout, which we already see fail ~9×), so more models is
more invisible background cost. Their upside is real on the *explicit*
reflect path (fresh models let reflect short-circuit the lower tiers →
faster), but they do not speed the hot recall path.

**Phase 6 — Two near-free hot-path levers (UX + speed + tokens).** Not
synthesis-tier work, but the largest responsiveness/cost wins and they
cross no invariant:
- **Gate recall on need.** Recall fires on *every* turn — a trivial
  "what time is it" still pays a ~5s recall arm + up to 1024 injected
  tokens it never uses. Skipping recall for plausibly-stateless/trivial
  asks speeds exactly the warm-TTFO path the `jtbd-fast-trivial-dm` gate
  measures *and* saves tokens.
- **Right-size retain cadence.** `retainEveryNTurns=1` means every turn
  triggers background consolidation (sonnet) — the single largest
  *invisible* subscription draw, and the engine room of tension (1).
  Retaining every 2–3 turns roughly halves that spend. **Caveat:** the
  every-turn setting is deliberate (the restart-memory-loss UAT), so
  this is a real tradeoff to measure, not a free win — hence its own
  lever, gated on proving no memory-loss regression.

## Speed & token budget

The fit argument above is about *correctness*; this section weighs
*cost*. Two latency/token surfaces matter, and they pull in opposite
directions:

- **Foreground (per-turn).** The auto-recall hook runs on every
  `UserPromptSubmit` (budget `mid` ~5s, 12s timeout) and injects up to
  1024 tokens of context. This is on the critical path for warm TTFO
  (~1.7s baseline, gated by `jtbd-fast-trivial-dm`). Anything added here
  is felt directly.
- **Background (invisible).** Every retain triggers consolidation
  (sonnet) the operator never sees; `retainEveryNTurns=1` makes that
  per-turn. This is the largest *uncounted* subscription draw and the
  engine room of invariant tension (1). Mental-model refreshes add to it.

Per-phase scorecard against the three axes:

| Phase | UX | Speed | Tokens |
|---|---|---|---|
| 1. Consume observations | curated, not grab-bag | ~neutral (same index) | denser → ≤ same; may enable `mid`→`low` |
| 2. Per-agent missions/disposition | specialized recall | neutral (shapes extraction) | slight win — less noise stored |
| 3. Directives ("corrections stick") | strong | negligible | small fixed per-turn cost if always injected |
| 4. Chat-legible (sparse) | legible **iff** sparse | negligible | minor output tokens |
| 5. Curated mental models | + faster *reflect* | neutral on hot path | background refresh spend; timeout risk |
| 6a. Gate recall on need | trivial turns feel instant | **win** — skips ~5s arm | **win** — drops ~1024 tok on trivial turns |
| 6b. Right-size retain cadence | unchanged | unchanged | **win** — ~halves background consolidation |

Net read: **Phase 1(a), 2, 3, 6a** are positive-or-neutral on all three
axes (1(a) and 6a are close to free wins). **Phase 4** is UX-positive
only if kept sparse. **Phase 5** trades background tokens for
explicit-reflect speed — curate selectively. **Phase 6b** is the biggest
token lever but a measured tradeoff, not a free win.

## Verdict check (the four-part rule)

- **Advances an outcome?** Yes — `standing-team`, via the core memory
  job and the specialist job.
- **Satisfies the job spec?** Moves recall from the job's *bad* column
  (grab-bag/raw) toward its *good* column (curated/legible/by-relevance).
- **Passes the three principle checks?** Defaults: phases 1–3 and 6 are
  config defaults, no operator assembly. Docs: behavior improves without
  new user-facing concepts. Consistency: same vault/config cascade.
  Speed/tokens: net-positive or measured (see *Speed & token budget*).
- **Crosses an invariant?** No — each phase is shaped to avoid the
  tensions named above (no autonomous self-writes; legibility added, not
  removed).

## Non-goals

- Not adopting Hindsight's multi-tenant schemas, transfer/import, or
  webhook fan-out beyond the single legibility use.
- Not adding time-based decay (explicit demote is the correct model).
- Not enabling autonomous mental-model creation.
