---
artifact: Re-imagined Hindsight memory — precision foundation + compressed situational digest
serves: remember-across-sessions
advances-outcome: standing-team
relates: rfcs/hindsight-synthesis-layers.md, rfcs/shared-knowledge-banks.md, rfcs/per-speaker-memory-routing.md, rfcs/shared-user-profile.md, jobs/run-a-fleet-of-specialists.md, invariants.md
status: Draft (2026-07-07) — DESIGN, adversarially reviewed x2 (first-pass findings folded in; second-pass open items in "Second adversarial pass" below); implementation PARKED pending engine-claim verification
supersedes: parts of hindsight-synthesis-layers.md (Phase 4 prohibition on proactive injection — revised here)
---

# Re-imagined Hindsight memory: right memories, right steer, min tokens

## Objective (operator, 2026-07-07)

> Best performance, accuracy, quality, token-optimised for higher accuracy,
> speed and token usage. Providing the right memories and the right steer is
> part of that. Re-imagine best practice; the existing RFC/guidance is
> amendable, not sacred.

A **joint** objective: raise accuracy AND cut tokens AND hold latency. The
through-line is **the right memories, not more memories** — precision, plus a
compressed orienting layer that costs no net tokens.

## The frame that makes it tractable: physics vs policy

Separate what cannot change from what the last RFC merely *chose*.

**Physics (immovable, design around it):**
- `reflect` is an agentic loop (up to 10 iterations, `agent.py:50`) — seconds,
  not milliseconds; recall is 50-500ms. (An earlier draft cited a 300s
  wall-timeout; that constant is not in `reflect/agent.py` — likely an
  HTTP-layer request timeout. The conclusion holds regardless: reflect is
  multi-iteration and belongs off the hot path.)
- Every injected token is paid on **every** turn.
- Background consolidation is real subscription spend (~1M tok/day/agent).
- Disposition affects **only `reflect`**, never `recall` (verified in engine).
- The 12s UserPromptSubmit hook ceiling is a real budget: the 2026-05-24 audit
  saw 17-26% of turns on heavy agents already breaching it. Anything added to
  the recall path (extra bank calls, an external reranker) spends from this.

**CORRECTION (adversarial review, 2026-07-07):** an earlier draft listed "the
API returns no similarity scores, so client-side sort is impossible" as
physics. **That is false.** `RecallResult.scores` carries a required `final`
(the rank value) plus `semantic`/`keyword` (`engine/response_models.py:175`,
`http.py:~3936`), and a `min_scores` request param exists. Scores ARE returned;
the vendored `lib/client.py` recall() simply never requests or reads them. So
"sort by relevance" is a **plumbing gap (policy), not physics** — and the
bank-starvation fix below is revised accordingly.

**Policy (the prior RFC's choices — we are free to overturn):**
- "Never inject mental models per turn" (`hindsight-synthesis-layers.md` Phase 4).
- "Never route the hot path through reflect."
- The 6-slot / 1024-token recall budget; retain-every-turn.

`hindsight-synthesis-layers` banned the proactive top layer because it feared
the "regurgitating old facts to prove I remembered" anti-pattern. That is a
**presentation** failure. You do not fix a presentation failure with a category
ban — you fix it with design. This RFC revises that prohibition.

## Current state (grounded in overlord's live config)

Used well: `recall` (4-strategy fusion) every turn; `observation` type recalled;
`recallMinOverlap=0.1` precision gate; directives (tag usage fixed 2026-07-07);
multi-bank fan-out; a real `retainMission`.

Dark — and it is the valuable half:
- **Precision:** `prefer_observations` off; **no external reranker** (slim image
  falls back to synthetic RRF scores — the single biggest retrieval-quality
  gap); no temporal anchoring (`query_timestamp`); tag matching is `any` only.
- **Synthesis:** `reflect` never in the loop; mental models created but **never
  surfaced**; no domain mental-model auto-refresh (retired #2447); entity graph
  fully dark.
- **Config durability:** disposition/missions/entity_labels not first-class in
  yaml (set out-of-band, non-reproducible).
- **QoL:** `invalidate_memory` (forget-that), bank export (backup) unused.

## The re-imagined stack

Three tiers. The foundation is precision (accuracy for free); the top is a
compressed orienting digest (accuracy at net-zero tokens); synthesis stays
on-demand (accuracy when the user is willing to pay for it).

### Tier 1 — Precision foundation (accuracy up, tokens flat/down)

All of Tier 1 except the `recallMinOverlap` confirm is a **code change** to the
vendored `lib/client.py` + `recall.py` (+ plugin redeploy) — not a settings.json
edit. "Free" in an earlier draft was wrong; these are cheap but real changes.

1. **Fix bank starvation — via scores, not interleave.** `recall.py` appends
   additional-bank results after own-bank then head-slices at the cap (6 live),
   silently dropping profile/shared/sender banks. Since scores ARE available
   (correction above), the fix is to **plumb `scores.final` through
   `client.recall()` and sort the merged set before the cap** (optionally push
   `min_scores` floors server-side). This strictly beats the round-robin /
   Jaccard-overlap workaround the first draft proposed, and subsumes the
   client-side overlap gate.
2. **`prefer_observations=true`** (code change: add the param to `client.py`
   recall + `recall.py`). Observations are deduped, denser statements;
   preferring them drops raw facts they supersede and backfills freed slots.
   More coverage inside the 6-slot / 1024-token budget. overlord's `recallTypes`
   already includes `observation`, so it bites. Bounded coverage-drop risk.
3. **Temporal anchoring** (`query_timestamp`) + **tag-scoping** (`tags_match`
   strict on labelled facts) — also `client.py` param additions. Time/topic
   precision.
4. **Reranker — see the invariant analysis below, NOT a casual "infra add".**
   The slim image has no local cross-encoder (RRF fallback). A reranker is the
   biggest precision lever, but an **external** one (Cohere/Jina) (a) adds a
   synchronous third-party round-trip to a recall path already breaching the
   12s ceiling 17-26% of turns, (b) ships memory text (**user PII**) off-box on
   every recall — a single-tenant / isolation-boundary crossing, and (c) is an
   off-subscription paid API in the hot path, brushing the subscription-honest
   invariant. **Prefer a local cross-encoder in a non-slim image**; only
   consider an external reranker behind explicit operator opt-in with the
   PII-egress tradeoff stated. This is an invariant decision, not a config knob.

### Tier 2 — Compressed situational digest (the revised top layer)

The re-imagined default: an agent **walks in oriented**. Implemented so it does
not violate the joint objective:

- **Compressed, not raw.** Inject a ~256-token situational digest (a mental
  model / observation summary), not scattered facts. One digest carries what
  several raw facts would, at higher signal-per-token.
- **Relevance-gated.** Only on memory-relevant turns — reuse the existing
  overlap / stateful-signal classifier (`recall.py:562-597`). Trivia turns get
  nothing.
- **Displacing, not additive — a design task, not "by construction."**
  *Correction (review):* the recall hook fetches **no mental models today** —
  the cap slices only `client.recall()` facts, and a digest comes from a
  separate call, so the plumbing currently supports ADD only. Net-token-neutral
  requires **net-new code** that fetches the digest AND subtracts its token cost
  from the recall budget, and even then a fixed digest displacing variable
  fact-slots is not token-exact. The goal is displacement; achieving it is
  explicit budget-accounting work, not a given.
- **Used, not recited.** Guideline in the preamble ("let it inform your answer,
  do not read it back"). This is the actual fix for the regurgitation
  anti-pattern — behavioural, not prohibitive.

This **revises `hindsight-synthesis-layers` Phase 4**: proactive orientation is
permitted and encouraged *when compressed, relevance-gated, displacing, and
used-not-recited*. The blanket "never default-on-every-turn" becomes "never
*raw* or *unconditional*; a gated compressed digest is the norm."

### Tier 3 — Synthesis on demand (accuracy when it's worth paying for)

- `reflect` stays **off the hot path** (physics: seconds, 300s timeout). It is
  the right tool ONLY for explicit synthesis asks ("what do you know about X",
  "summarise my week") where the user is waiting. Route those to
  `reflect(budget=mid)`; reserve `high` for true multi-hop.
- Mental-model **auto-refresh**: only for a small curated set, on a **sparse
  schedule** (not `refresh_after_consolidation`, which would fire per-retain and
  stack on the ~1M-tok/day background draw). Stable models refresh manually.

### Cross-cutting — retain-side and config durability

- **Retain cadence** 1→2 (*reduces* background consolidation spend — not
  necessarily "halves": consolidation cost scales with content volume/novelty,
  not retain-call count, so batching defers/dedups more than it halves; measure
  it). Doubles the restart memory-loss window (up to 2 unretained turns); gate
  on the restart-memory-loss UAT — measure, don't ship blind.
- **Retain mission tuned for salience+dedup** (keep-list AND ignore-list),
  fleet-wide. Concise mode. Better extraction = higher-signal recall within the
  6-slot cap. GIGO is the upstream precision lever.
- **Disposition + missions + entity_labels first-class in switchroom.yaml**,
  provisioned on apply (shares the mechanism from the shared-knowledge-banks
  RFC). Makes each agent's steer durable and reproducible across installs.

## Token / latency budget (why this nets out right)

- Tier 1 changes are retrieval-side: no added LLM tokens; `prefer_observations`
  and the starvation fix *improve* what fills the fixed budget.
- Tier 2 digest **displaces** fact-slots → net-zero token delta on gated turns,
  zero on non-gated turns.
- Tier 3 reflect is opt-in per explicit ask → bounded, user-initiated cost.
- Retain cadence 1→2 is a **net reduction** in the biggest background draw.

Expected direction: accuracy up (precision + orientation), tokens flat-to-down
(dedup + cadence), latency flat (no reflect on hot path).

## Measurement (prove it, don't assert it)

Every change ships behind a measurement, per the repo's outcome-UAT rule:
- Retrieval precision: a fixed query set, judge recalled-set relevance before/after
  (`prefer_observations`, reranker, starvation fix).
- Token accounting: per-turn recall tokens + daily background consolidation tokens
  before/after (cadence, digest displacement).
- Latency: warm-TTFO unaffected (guard: no reflect on hot path).
- Restart-memory-loss UAT gates the retain-cadence change.

## Phased rollout (cheapest joint-win first)

1. **Precision (code, cheap — only the `recallMinOverlap` confirm is truly free):**
   starvation fix (sort by `scores.final`) + `prefer_observations` +
   `query_timestamp`, all via `client.py`/`recall.py` plumbing + redeploy.
   Measure precision + tokens.
2. **Retain cadence 1→2** behind the restart UAT. Measure background tokens.
3. **Retain-mission precision tuning**, fleet-wide.
4. **Situational digest** (Tier 2) — the revised top layer, gated + displacing.
5. **External reranker** — infra add, ROI-measured.
6. **Config durability** (disposition/missions/entity_labels in yaml) — rides
   the shared-banks provisioning work.
7. **reflect explicit-ask path** + sparse mental-model refresh.

## Verdict check (four-part rule)

- **Advances an outcome?** `standing-team` — an agent that walks in oriented and
  remembers accurately, cheaply.
- **Satisfies the job spec?** `remember-across-sessions` without violating
  `run-a-fleet-of-specialists` isolation (digest is per-agent/own-bank; no
  pooling beyond the sanctioned shared-bank RFC).
- **Principle checks?** Defaults (better memory with no operator action on the
  free tiers), docs (revises one prohibition, adds config surface), consistency
  (rides existing recall/retain/provisioning cascades). Passes.
- **Crosses an invariant?** No — single-tenant held, no auto-retain into shared
  pools, isolation preserved.

## Non-goals

- Not reflect on the hot path (physics).
- Not raw/unconditional per-turn injection (the revised anti-pattern guard).
- Not client-side relevance sort (no scores exist).
- Not auto-refresh-on-consolidation as a default (quota).

## Open questions for review

- Reranker: which provider, and does the accuracy ROI justify an external API
  dependency in the memory hot path (latency + a new failure mode)?
- Digest source: a dedicated mental model per agent vs synthesising from the
  observation tier at recall time — which is cheaper/fresher?
- Retain cadence 1→2: what does the restart-memory-loss UAT actually show?
- Is displacing raw-fact slots with a digest ever *worse* (loses a specific fact
  the turn needed)? Gate/size tuning question.

## Status

Design draft, **adversarially reviewed (2026-07-07), findings folded in.**
Material corrections from review: (1) the "no scores → can't sort" physics claim
was false — scores are returned; starvation fix revised to sort by
`scores.final`. (2) Tier-1 `prefer_observations`/`query_timestamp`/starvation
are code changes, not "free." (3) Tier-2 displacement is a budget-accounting
build, not "by construction" (the hook fetches no mental models today).
(4) External reranker is an invariant decision (PII egress + 12s-ceiling latency
+ subscription-honest), not a config knob — prefer a local cross-encoder.
(5) "halves consolidation" softened to "reduces, measure." **Implementation
parked** pending operator go.

## Second adversarial pass (2026-07-07, two independent reviewers)

The first pass fixed the physics-level factual errors. A second independent
pass (code-grounding lens + invariant/cost lens) found the folded-in review
left five softer problems unresolved. These are revision items, not a redesign —
the direction holds — but they gate leaving "parked."

1. **The load-bearing "scores ARE returned" correction is unverifiable on-host
   and contradicts live code.** CONFIRMED that the vendored client never reads
   scores (`vendor/hindsight-memory/scripts/lib/client.py:96-118`,
   `content.py:202-214`). But the engine-side claim — `RecallResult.scores.final`
   at `engine/response_models.py:175` / `http.py:~3936` — cites files that **do
   not exist on this host** (only the client plugin is vendored, not the engine).
   Worse, it contradicts a live comment at `recall.py:344-345`: *"Hindsight's
   HTTP API does not return similarity scores"* — the reason the #475 Jaccard gate
   exists. **Action: verify against the running engine's OpenAPI/recall schema
   before building the starvation fix on sort-by-score.** Until then, downgrade
   from stated-fact to "believed true, engine source not vendored."
2. **Two unreconciled internal contradictions.** (a) Line 220 Non-goals still
   says "no scores exist" while the Physics correction says they do. (b) The
   budget section asserts the Tier-2 digest "displaces → net-zero tokens" as
   settled, while lines 130-133 concede displacement is unbuilt, needs net-new
   code, and is "not token-exact." The summary/budget sections are over-confident
   relative to the corrected body.
3. **The Phase-4 overturn targets the wrong mechanism.** `hindsight-synthesis-
   layers` Phase 4 prohibited **user-visible chat-legibility lines** ("remembered:
   X"), not invisible context injection (the recall hook already injects hidden
   `additionalContext` every turn). Tier-2's digest is hidden injection — a
   different category. The RFC overturns a ban that wasn't prohibiting what
   Tier-2 does. And the replacement guard ("used, not recited") is an unmeasured
   preamble guideline, absent from the measurement plan. Re-frame the overturn
   and add a regurgitation-rate measurement.
4. **External reranker: right conclusion, wrong invariant + invalid escape
   hatch.** The latency + PII-egress analysis is sound, but (a) it cites
   `subscription-honest`/`claude-native`, which governs Anthropic model calls — a
   Cohere/Jina reranker isn't an Anthropic call; the actually-load-bearing
   invariant is `single-tenant`'s per-user memory isolation (PII egress). (b)
   `invariants.md` says an invariant break is "out of scope, full stop" — so
   "external reranker behind operator opt-in" is not a valid escape hatch for an
   invariant question. Resolve it as yes/no, prefer the local cross-encoder, drop
   the opt-in framing.
5. **Assumed-real API params are unverifiable on-host.** `prefer_observations`,
   `query_timestamp`, `tags_match`, `min_scores` appear nowhere in the vendored
   client or any on-host schema. Confirm they're real server-side params before
   scoping them as "just add to client.py."

Also noted: the superseded RFC's legibility tension (invisible recall vs
inspectable recall) is silently dropped; Tier-2 pushes memory *further* out of
the user's view — acknowledge the regression. Retain-cadence 1→2 was judged
SOUND and honestly hedged by both passes.

**Net:** design instinct holds; before implementation, (i) verify the engine-side
scores/params claims against the real engine, (ii) reconcile the two internal
contradictions, (iii) re-target the Phase-4 argument and add a regurgitation
measurement, (iv) resolve the reranker as an invariant yes/no, not a knob.
