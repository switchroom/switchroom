# Probe: injection cadence — every-turn like Hermes/openclaw, or session-start-synthesis + pull?

Adversarial probe, 2026-08-16. Question: is design-v2's shape genuine engineering
or motivated reasoning against the operator's "be more like openclaw and hermes"
steer? All comparator claims re-verified at source; all "ours" claims verified
against the deployed plugin and live recall log, not the repo or the RFC ledger.

## 1. Ground truth, established live

### Ours (deployed, not vendored)

- Hook wiring: recall runs **synchronously on `UserPromptSubmit`** (no `async`
  flag, `timeout: 12`) — it blocks the reply path.
  `~/.switchroom/agents/klanker/.claude/plugins/hindsight-memory/hooks/hooks.json`.
- Deployed settings (`.../hindsight-memory/settings.json` + live env, both read
  this probe): `recallTypes = ["world","experience","observation"]`,
  `recallMaxMemories 16`, `recallMaxTokens 6144`,
  `recallParallelDeadlineSeconds 10`, `HINDSIGHT_RECALL_PARALLEL=true`,
  `HINDSIGHT_RECALL_PREFER_OBSERVATIONS=true`, `retainEveryNTurns 8`,
  `recallSkipTrivial true`. The task-brief's numbers check out.
- **Live latency refutes the design's "0.6–0.75s".** The live recall log
  (`.claude/plugins/data/hindsight-memory-inline/state/recall_log.jsonl`,
  5000 rows, 882 with `duration_ms`): **min 50ms, p50 1282ms, p90 5522ms,
  max 9162ms**. The five most recent turns: 1419/1301/1129/1132/1407ms.
  reference/rfcs/design-v2.md cites "0.6–0.75s" four times (lines 143, 170, 406, 810) —
  E-28's number describes the single-bank MCP recall tool, not the deployed
  3-bank-parallel hook that is actually on the reply path. The hot-path cost
  being argued about is ~2x understated at median and ~7x at p90.
- **Live quality confirms the grab-bag.** Last logged turn: 16 memories
  injected from `pre_cap_count: 152`, `injected_score_min: 0.0001`,
  `injected_score_median: 0.0243`, `min_score_applied: false`
  (`min_score_scope: "degraded"` — the 0.01 floor only applies in degraded
  mode). 2111/5000 rows are `capped: true`: the block fills all 16 slots
  whenever candidates exist, mostly with near-zero-relevance rows.

### Hermes (pin 460d345, `plugins/memory/hindsight/__init__.py`, fetched raw)

- `memory_mode` default `"hybrid"` (line 750, enum at 1184: hybrid/context/tools)
  — injection **and** tools, every turn.
- `recall_types` default `["observation"]` (857, 1710) — consolidated tier only,
  with a config note calling raw world/experience "the supporting evidence
  observations already summarize" (1193).
- `recall_max_tokens` default **4096** (848, 1704).
- `retain_every_n_turns` default **1** (824, 1199, gate at 2074).
- Injection is **off the reply path**: `queue_prefetch` recalls on a background
  thread for the *next* turn (1950–1976); `prefetch()` does a buffer read with a
  capped `join(timeout=3.0)` (1928–1937); `prefetch_waits_for_retain` default
  True gives read-after-write so turn N+1's injection sees turn N (835, 1201,
  1966–1968). `recall_sync` is the opt-in synchronous mode (1915–1925,
  referencing hermes-agent#5820). `_recall_disabled` gates on `tools` mode
  (1842–1844).

### openclaw (`@vectorize-io/hindsight-openclaw` dist/index.js@latest, unpkg,
fetched 2026-08-16; docs page hindsight.vectorize.io/sdks/integrations/openclaw)

- Recall is **awaited inside `before_prompt_build`** (`const response = await
  recallPromise;` inside the hook handler, then the `<hindsight_memories>`
  block is injected) — synchronous, on the reply path. Default
  `RECALL_TIMEOUT_MS = 10_000` (dist line 167), configurable `recallTimeoutMs`.
- Defaults per docs: `recallMaxTokens` **1024**, `recallTypes`
  **`["observation"]`** ("to avoid surfacing the same answer multiple times"),
  `recallTopK` unlimited, `retainEveryNTurns` **1**, `preferObservations`
  false. Trivia gates exist in source (`isEphemeralOperationalText` skip).
- The vendor's stated reason, verbatim from the docs page: "Traditional memory
  systems give agents a `search_memory` tool - but models don't use it
  consistently. Auto-recall solves this by injecting memories automatically
  before every turn."

## 2. Findings

### F1. The question as posed is already half-moot: design-v2's fleet default IS every-turn injection

Step 6a (reference/rfcs/design-v2.md:790–830) keeps per-turn injection as the fleet default —
hardened to the comparator shape (async off-reply-path prefetch, per-turn delta
retain with read-after-write ordering, observation-lean). `memory.injection:
hybrid-hardened` is the default tier value (reference/rfcs/design-v2.md:832–845). Only 6b
removes injection, per-agent, explicitly "gated on evidence we do not have"
(reference/rfcs/design-v2.md:868). So the operator's steer is substantially already conceded
in the spec. The residual dispute is (a) whether tools-only remains the framed
destination, and (b) Surface B's once-per-session cadence.

### F2. The comparators' choice is load-bearing and their reason applies to us

openclaw states the mechanism plainly (quote above): pull tools are not
reliably used. Hermes's hybrid default and its config prose say the same by
construction. This is not cargo cult — it is the exact failure mode design-v2
itself names as "pull-miss risk... real and accepted" (reference/rfcs/design-v2.md:450–458)
and mitigates only with an index block plus prompt guidance, i.e. the
model-dependent mechanism the fleet's own dev protocol says to avoid when a
deterministic one exists. Injection IS the deterministic mechanism for "memory
is present". The design's own honest position on the tools-only flip is "loses
tokens, gains trust, quality sign unknown" (reference/rfcs/design-v2.md:456–458) — that is not
a case, it is an absence of one.

### F3. What actually still holds the anti-injection position up, post-E-57

- **Token cost:** §6 (reference/rfcs/design-v2.md:915–981) honestly brackets the net as
  "roughly neutral to ~65% reduction" — and the solid, measured deletion is the
  *directive* block (~49M/30d), which is orthogonal to recall-injection cadence.
  The recall block's share is unmeasured (bounded ~27M) and survives 6a anyway.
  Cost does not decide the injection question. Weak.
- **Benchmark:** E-57 downgraded to noise (reference/rfcs/design-v2.md:1117–1137). Dead.
- **Grab-bag quality:** live-verified this probe (score min 0.0001, median
  0.0243, floor not applied, 42% of turns capped at 16). Real — but it is an
  indictment of *our block's tuning*, not of every-turn cadence: Hermes ships
  every-turn with observation-only + 4096 and openclaw with observation-only +
  1024 + trivia gates. The fix is a score floor / observation-lean / smaller
  cap, all available inside every-turn.
- **Inspectability (C-01):** genuinely ours, genuinely valid, and preserved by
  6a's visible degraded-notice anyway. Doesn't require removing injection.

Net: nothing that survives argues for *removing* every-turn injection; the
surviving arguments all argue for *hardening* it — which is what 6a does. The
design's own text reaches this conclusion; its framing ("per-turn pushed
fragment injection is removed regardless", reference/rfcs/design-v2.md:336; tools-only as the
6b destination) outruns its evidence.

### F4. Yes — ours is worse than theirs at the same job, and the distinction is load-bearing

Verified deltas of our deployed block vs both comparators:

| axis | ours (live) | Hermes | openclaw |
|---|---|---|---|
| placement | sync, blocks reply, p50 1.28s / p90 5.5s | background prefetch + 3s join, off reply path | sync in `before_prompt_build`, 10s cap |
| types | world+experience+observation | observation-only | observation-only |
| budget | 6144 tok / 16 memories | 4096 tok | 1024 tok |
| relevance floor | none applied (floor scoped to degraded) | server ranking, obs-only dedupe | obs-only dedupe, optional topK |
| retain cadence | every 8th turn | every turn + read-after-write | every turn |

"Our per-turn block is noisy and slow" generalised into "the shape is bad" is
exactly the blur the probe brief suspected — and rev 9's own correction
(reference/rfcs/design-v2.md:138–150) already partially concedes it (withdrew "our instance is
raw-fragment-defective", kept the timing/cadence residue). But note rev 9's
claim that our block "already injects the consolidated observation tier" is
only one-third true: we inject all three types at 6144 tokens with no floor,
which is materially noisier than either comparator's shipped shape.

**Factual error found:** reference/rfcs/design-v2.md:1146 claims "the variant both chat-domain
comparators actually ship — observation-only, **1024-token-capped**". Hermes's
default is **4096** (`__init__.py:848,1704`). Small, but it's the kind of
comparator misstatement this ledger was just burned by.

### F5. The strongest surviving attack: Surface B drops the benchmarked half of its own winning arm

§8.2a (reference/rfcs/design-v2.md:1163–1174) admits the E-79 winning arm "re-injected the
cached reflect synthesis **every turn**", and that once-per-session is a
post-benchmark refinement resting on the vendor's engineering judgment ("random
noise once the session drifts"), not measurement. So the design's headline
evidence (9/9, non-overlapping ranges) supports *every-turn injection of
synthesis*, and Surface B ships a weakened variant of it — once, from a cache
up to ~24h stale — while citing that benchmark as its foundation. Re-injecting
a cached mental model is a milliseconds-cheap read (E-52 per the design's own
citation); the token cost at ≤2048 tokens/turn is the only real price. This is
the one place where "motivated reasoning by the author" is a fair description:
the half of the winning pattern that was kept is the half that fit the
pull-shaped thesis.

## 3. Answers

1. **Is per-turn injection load-bearing for them?** Yes, for a stated,
   verified reason (models don't reliably pull) that applies to our fleet too.
   We are not actually the outlier at the spec level — 6a keeps every-turn as
   fleet default — but the document's rhetoric and the 6b "destination"
   framing are outliers relative to both comparators, the operator steer, and
   the design's own evidence table.
2. **What holds the anti-injection position up?** After E-57's collapse:
   inspectability (valid, but compatible with injection) and a cost case that
   §6 itself brackets as possibly neutral. The grab-bag argument attacks our
   tuning, not the cadence. Not enough to justify tools-only as a goal;
   exactly enough to justify 6a's hardening.
3. **Does our variant differ from theirs?** Materially, in their favor, on
   every measured axis (F4 table). "Ours is bad" ≠ "the shape is bad", and the
   live log proves ours-as-deployed is the noisy, slow variant.
4. **Recommendation:** **Converge on every-turn injection — adopt 6a as the
   end state, not a waypoint.** Concretely: (a) keep every-turn injection
   hardened per 6a (off reply path, per-turn delta retain, observation-lean or
   floor-gated, cap nearer 1024–4096 than 6144/16-no-floor); (b) demote 6b
   from "evidence-gated arm" to "rejected unless the harness run lands" —
   today it reads as the intended destination; (c) add per-turn (or per-N-turn)
   re-injection of the orientation synthesis to Surface B's options, since
   that — not once-per-session — is the actually-benchmarked winning
   configuration (F5); (d) fix the 0.6–0.75s and Hermes-1024 misstatements
   (F4); (e) apply a real score floor outside degraded mode (F1 live data).
   **What would change my mind / falsifying test:** the §5-6b ~$300 triplicate
   sde-bench matrix (tools-only vs hardened-injection vs vanilla, plus an arm
   shaped like our shipped config). If tools-only ≥ hardened injection on
   quality with non-overlapping ranges, flip 6b to the destination and this
   probe's verdict inverts. **Cheaper interim test (~$0):** A/B two live
   agents for a week — one 6a-hardened, one tools-only — scoring only the
   deterministic signal we already log ("you already told me" incidents +
   recall-tool invocation rate per turn); if the tools-only agent's
   spontaneous pull rate is high and misses are rare, the openclaw premise
   ("models don't pull") weakens for Claude-class models and 6b regains a case.

## Verdict

**Converge on every-turn injection (comparator-hardened, 6a shape) — the
design's evidence already forces this, and its remaining divergences
(tools-only as destination, once-per-session synthesis) are the motivated
residue, not engineering.** One-line reasoning: every argument that survived
E-57's collapse attacks our block's tuning or placement — both fixable inside
every-turn, both fixed by the comparators we were told to resemble — while the
design's own headline benchmark (E-79) rewarded every-turn re-injection of
synthesis, not once-per-session.
