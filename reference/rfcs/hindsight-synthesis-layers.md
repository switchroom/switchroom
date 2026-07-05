---
artifact: Hindsight primitive fit — use the synthesis layers the memory job demands
serves: remember-across-sessions
advances-outcome: standing-team
relates: jobs/run-a-fleet-of-specialists.md, jobs/feel-like-a-colleague.md
status: partially shipped (rev. 2026-07-05); phases 1 + 6a + 6b live, 2/3/5 open — status record + remaining work
---

# Hindsight synthesis layers — what we run vs. what the job asks for

Switchroom runs the Hindsight memory engine. This RFC opened (2026-06-18)
as a proposal arguing we consumed only its weakest layer. Hindsight ships
four tiers of memory (raw facts, **observations**, **directives**, **mental
models**) and an agentic **reflect** path built to prefer the top tiers. At
the time of writing, switchroom used it largely as a *raw-fact store*:
retain everything → recall raw `world`/`experience` facts → inject them
invisibly. That was close to the exact shape the
[`remember-across-sessions`](../jobs/remember-across-sessions.md) job names
as **bad** ("raw transcript dumping passed off as memory", "grab-bag",
"every memory equally weighted"). The synthesis tiers are the job's **good**
("curated, semantic, retrieved by relevance", "honest legible answer about
what it believes and why").

**This document has since become a status record.** Phase 1 shipped
(observations are now recalled), Phase 6a shipped (recall is gated on
trivial turns), Phase 6b shipped (retain is now a chunked window instead of
re-consolidating the whole transcript every turn — #2830, rolled fleet-wide
in v0.17.5), and per-speaker / shared-bank recall landed as an adjacent
feature. Several premises the original proposal rested on have also *moved*:
per-agent user-profile mental models were retired (#2447), so the "one
auto-seeded model everywhere" gap the RFC described no longer exists. The
analysis and phased structure below are preserved; each phase now carries an
explicit **SHIPPED / PARTIAL / NOT-STARTED** marker, and the evidence
section keeps the original 2026-06-18 snapshot with a "Status as of
2026-07-05" correction under each bullet.

This remains a design record. It does not change a job spec or an invariant;
it argues for using capability we already pay for, within the lines.

## Per-phase status at a glance (2026-07-05)

| Phase | Status | One-line |
|---|---|---|
| 1. Consume observations | **SHIPPED** (#2425/#2427) | `recallTypes` now includes `observation` |
| 2. Per-agent missions/disposition | **PARTIAL** | `retain_mission`/`bank_mission` configurable + generic default seeded + 3 banks specialized; `reflect_mission`/`observations_mission`/`disposition` unwired |
| 3. Directives ("corrections stick") | **PARTIAL / guidance-only** | wired as a model *instruction* in the profile; no deterministic hook routes corrections into `create_directive` |
| 4. Chat-legible memory (sparse) | **NOT-STARTED** | only a transient `📚 recalling memories` spinner exists (#303); no store/correct legibility line |
| 5. Curated mental models per specialist | **NOT-STARTED** as automation | and arguably *regressed* — user-profile auto-seeding was removed in #2447 |
| 6a. Gate recall on trivial turns | **SHIPPED** | `recallSkipTrivial=true` + `_is_trivial_stateless()` guard |
| 6b. Right-size retain cadence | **SHIPPED** (#2830/#2831) | chunked windowed retain at `retainEveryNTurns=1` — vendor `retain.py` patched (`select_retain_window()`) to decouple window-slicing from the `>1` throttle; savings not yet measured (#2847) |

## Evidence (original snapshot 2026-06-18, with 2026-07-05 corrections)

- **Observations were generated but not recalled.** *(Original, 2026-06-18)*
  45,766 `observation` rows existed (deduped synthesis, each with
  `proof_count` + `source_memory_ids` provenance), produced automatically by
  the consolidation engine on every retain. Switchroom's auto-recall hook
  requested `types=["world","experience"]` only (vendored plugin default;
  `vendor/hindsight-memory/scripts/lib/config.py`), so the synthesized layer
  was excluded from what reached the agent. We paid the consolidation cost
  and threw away the output.
  - **Status as of 2026-07-05 — SHIPPED / now recalled.** Phase 1 landed.
    `applyHindsightSettingsOverrides()` in `src/agents/scaffold.ts` sets
    `settings.recallTypes = ["world", "experience", "observation"]` (~L2513),
    so observations now reach the agent on every recall. The *vendor* default
    is still `["world","experience"]`
    (`vendor/hindsight-memory/scripts/lib/config.py:39`) — switchroom
    overrides it. The "wasted spend" framing for observations no longer
    applies; the synthesized tier is consumed.
  - **Status — the 45,766 number is a stale fleet-wide figure.** Live
    per-bank counts today: `assistant` ≈ 16,600 observations of ≈ 62,750
    facts; `test-harness` ≈ 1,411 of ≈ 5,904. Observations are a large,
    growing, and now-*consumed* tier, not a single fleet aggregate.

- **Auto-recall requested `types=[world,experience]` only.** *(Original)*
  The synthesized layer was excluded from recall.
  - **Status as of 2026-07-05 — CHANGED.** Effective recall types now
    include `observation` via the scaffold override above. The type list is
    an opt-out cascade through `memory.recall.types` (`src/config/schema.ts`,
    the `types` field ~L377): an operator can override per-agent or
    fleet-wide under defaults, but the shipped default is the three-tier
    list.

- **One mental model per agent.** *(Original, 2026-06-18)* Every agent bank
  had exactly the host-seeded `user-profile` model
  (`src/memory/hindsight.ts` `ensureUserProfileMentalModel`). Nothing created
  more; the engine never auto-creates them. The richer banks (`assistant`: 4
  models; `lawgpt`: 7) were curated by hand.
  - **Status as of 2026-07-05 — DISPROVEN on every limb.** Per-agent
    user-profile mental models were **retired in #2447**. `scaffold.ts`
    (~L4569-4572) now documents: "Per-agent user-profile mental models are
    retired — dedicated profile banks own that … No user-profile-refresh Stop
    hook wired." Live counts today: `carrie` = 0, `test-harness` = 0,
    `assistant` = 2 (topical: "Infrastructure Map", "Active Projects"),
    `lawgpt` = 5 (Goodfellow-case topical). **No bank carries a `user-profile`
    model.** `ensureUserProfileMentalModel()` still exists
    (`src/memory/hindsight.ts:354`) but its only caller is a web remediation
    endpoint (`src/web/memory-remediation.ts`) — it is no longer invoked by
    scaffold or any Stop hook. The premise "one model per agent, seeded" is
    now false in both directions: banks carry zero-to-several models, and none
    are the seeded profile model.

- **Reflect prefers the tiers we don't feed it.** *(Original)* The reflect
  agent's forced tool order is `search_mental_models` → `search_observations`
  → `recall` (raw) (with `expand` available but not forced); on a non-high
  budget it short-circuits the lower tiers if the mental models come back
  fresh.
  - **Status as of 2026-07-05 — UNVERIFIABLE from the repo.** This ordering
    is server-side behavior inside the v0.8.4 Hindsight image; it is not
    present in the vendored scripts under `vendor/hindsight-memory/scripts`.
    Treat it as an unverified server-side assertion, not a repo-checkable
    fact. Switchroom still invokes reflect only on explicit "what do you know
    about me" asks.

- **Per-agent banks are isolated but not specialized.** *(Original)* Banks
  are keyed per agent (satisfies isolation), but each bank's `retain_mission`
  / `reflect_mission` / `disposition` (skepticism/literalism/empathy)
  appeared generic rather than shaped per specialist.
  - **Status as of 2026-07-05 — PARTIAL / CHANGED.** A generic
    `DEFAULT_RETAIN_MISSION` is now seeded at scaffold
    (`src/memory/hindsight.ts:188`, applied in `scaffold.ts` ~L4304 as
    `seededRetainMission`), and per-agent `retain_mission` / `bank_mission`
    are first-class config (`src/config/schema.ts`, ~L333/L337). Live
    `bank_mission` is specialized on `assistant`, `lawgpt`, and `ziggy`;
    empty on `carrie`, `marko`, `reggie`, `test-harness`. `disposition` is
    uniformly `{empathy:3, literalism:3, skepticism:3}` across **all** banks.
    `reflect_mission`, `observations_mission`, and `disposition` are **not
    wired anywhere in `src/`**. So specialization is real but partial: the
    retain/bank mission levers exist and are used on a few banks; the rest of
    the mission/disposition surface is untouched.

## Supply side — the four tiers (what each is)

| Tier | What it is | Created by | Inspectable? |
|---|---|---|---|
| Raw facts (`world`/`experience`) | sentence-level extracted facts | retain → extraction LLM | yes |
| **Observations** | deduped synthesized statements over N facts, with `proof_count` + sources | consolidation engine (auto) | yes (provenance) |
| **Directives** | user-authored hard rules ("always…", "never…") | explicit `create_directive` | yes (verbatim) |
| **Mental models** | pinned, named, self-refreshing reflections answering a stored query | explicit `create_mental_model` | yes (named, legible) |

`reflect` is the agentic read path that synthesizes across all four;
`recall` is the raw read path (which, as of Phase 1, now returns the
`observation` tier alongside raw facts). Banks carry a `retain_mission` /
`bank_mission` (and, in the vendor engine, `reflect_/observations_mission` +
a `disposition`) that shape extraction, synthesis, and voice per bank —
though only the retain/bank mission fields are wired through switchroom
config today.

## The fit map — primitive × job

| Primitive | Serves | Today (2026-07-05) | Verdict |
|---|---|---|---|
| **Mental models** | remember ("ask what it believes about you → legible answer"); colleague (continuity) | auto-seeding **retired** (#2447); 0–several topical models, hand-curated | opportunity moved — profile knowledge now lives in dedicated profile banks, not a per-agent model |
| **Observations** | remember ("curated, by relevance, not grab-bag"; inspectable) | **now recalled** (Phase 1) | **consumed** — the wasted-spend gap is closed |
| **Directives** | colleague + remember ("rules set once stay respected"; "correction sticks") | model *instruction* only, no deterministic routing | still the most invariant-clean primitive — lean in |
| **reflect** | remember ("what do you know about me") | explicit asks only | underleveraged as a recall path |
| **Bank missions + disposition** | fleet-of-specialists ("persona without own memory is cosplay") | retain/bank mission wired + 3 banks specialized; disposition uniform | partial specialization lever |
| **recall** (raw) | remember (necessary) | core path, now three-tier | keep — grab-bag tier, but denser with observations |
| Entity graph / links / cooccurrences | improves recall relevance (plumbing) | auto-built | keep as infra; not a vision lever |
| Webhooks (`consolidation.completed`) | could make memory chat-legible | unused | invariant-fix lever (Phase 4, not started) |
| Transfer / audit-log / async-ops tools | marginal to the jobs | unused | leave |

## Where Hindsight would *not* help — invariant tensions

The synthesis tiers help, but some of Hindsight's always-on behavior rubs
against switchroom's lines. Status of each, updated for 2026-07-05:

1. **Silent background consolidation vs
   [`chat-is-the-single-source-of-truth`](../invariants.md) + `on-leash`.**
   *Mitigated by #2830; magnitude pending measurement.* The engine still runs
   LLM consolidation/observation/graph-building the operator never triggered
   and never sees, so the *legibility* tension persists (Phase 4 is the lever
   for that). But the *magnitude* — previously the largest invisible
   subscription draw, driven by `full-session` re-consolidation on every turn
   — is now addressed in code: Phase 6b (#2830) switched retain to a chunked
   window, so a fire consolidates only the recent window rather than the whole
   growing transcript. The realized savings are **not yet measured** (#2847).
   Whatever remains is still background model-spend the operator didn't
   initiate (also brushes
   [`crons-use-the-model-only-when-it-earns-it`](../jobs/crons-use-the-model-only-when-it-earns-it.md)).
2. **Invisible recall injection vs "honest, legible recall."** *Still open.*
   The `<hindsight_memories>` block is hidden `additionalContext`. Phase 4
   (chat-legible "remembered: X") has not started; the only surfaced signal
   is a transient `📚 recalling memories` spinner (`recall.py`, #303) that
   shows *that* recall ran, not *what* was recalled.
3. **Auto-creating mental models vs `on-leash` / `no-self-escalation`.**
   *Resolved / over-corrected.* The auto-seeding path was removed in #2447,
   so no agent enriches its own model structure unprompted. If anything the
   pendulum swung the other way: there is now *no* automated model curation
   at all (see Phase 5).
4. **No time-based decay is actually aligned.** *Confirmed live.* Hindsight
   never forgets (recency is a soft ±10% weight); the job calls silent
   forgetting bad and wants *explicit* demote/correct, which exists and is
   wired end-to-end: `[demote-from-recall]`-tagged memories are filtered at
   `vendor/hindsight-memory/scripts/recall.py` (~L917), the tag constant
   `DEMOTE_FROM_RECALL_TAG` lives at `src/memory/hindsight.ts:944`, the
   `switchroom memory demote` CLI is at `src/cli/memory.ts` (~L550), and
   `invalidate_memory` is used by `src/cli/vault-sweep.ts` (~L276). Keep it;
   the "no time-decay" verdict stands.

`single-tenant` and `claude-native` are satisfied by construction (per-agent
embedded banks; the `claude-code` provider runs synthesis on the
subscription, no API path). No conflict.

## Developments since 2026-06-18

Two things landed adjacent to this RFC that change its framing:

- **Per-speaker / shared-bank recall is SHIPPED and live** (RFC
  [`per-speaker-memory-routing.md`](per-speaker-memory-routing.md),
  #2441/#2442/#2444). `resolveUsers()` in `src/config/users.ts` resolves
  `users.*` / `serves` / `knows` into `sender_banks` (speaker routing) +
  `additional_banks` (subject knowledge); `scaffold.ts` (~L2529) writes
  `settings.recallAdditionalBanks`; the schema exposes `sender_banks` /
  `additional_banks` under `memory.recall` (`src/config/schema.ts`
  ~L387/L399). The `ken-profile` / `lisa-profile` banks are exactly what this
  reads. **This RFC must stop treating shared-bank recall as future work — it
  is deployed.** It is also why Phase 5's premise changed (below): profile
  knowledge moved out of per-agent mental models into dedicated profile banks
  with per-speaker routing.
- **The #2816 tag-filter port exists but is UNWIRED.** `recallTags`,
  `recallTagsMatch`, `recallTagGroups`, and `recallAdditionalBankFilters` are
  all read in the vendored `recall.py` (~L742-L745, tag-group logic through
  ~L879), landed 2026-07-05. But **no scaffold override sets any tag filter**
  — the config keys are absent, so the filters collapse to a no-op (empty
  filter = pass-through). This is a ready-made hook for future recall shaping
  (e.g. scoping additional-bank recall to specific tags), and it is
  **deliberately kept dormant** (decision, not oversight): tag-scoped recall is
  orthogonal to Phase 2's mission/disposition specialization and this RFC does
  not specify a per-bank tag taxonomy, so wiring a first-class
  `memory.recall.tags` surface now would be speculative generality. The
  intentional-dormancy is documented at the point of decision in
  `renderHindsightSettingsOverrides` (`src/agents/scaffold.ts`) with a
  `TODO(#2816)` naming exactly how to wire it (mirror the `recallTypes`
  cascade + `HINDSIGHT_RECALL_TAGS` start.sh export) if a future RFC calls for
  it. The env-var escape hatch (`HINDSIGHT_RECALL_TAGS` /
  `HINDSIGHT_RECALL_TAGS_MATCH` / `HINDSIGHT_RECALL_TAG_GROUPS` in
  `lib/config.py`) remains available to advanced operators in the meantime.

## Proposal — phased, with current status

Ordered by leverage-per-effort. Each phase is independently shippable and
crosses no invariant. Status markers reflect 2026-07-05.

**Phase 1 — Consume what we already synthesize. — SHIPPED (#2425/#2427).**
Added `observation` to the auto-recall `types`. Turns paid-for, deduped,
provenance-carrying observations from dead weight into the "curated,
by-relevance" recall the job demands. Pure consumption change (retrieval +
local rerank, no model call): it adds one per-fact-type retrieval arm, but
the cross-encoder rerank stays bounded by the 300-candidate cap, so the added
latency is *bounded*, not zero. And observations are *denser* (one
synthesized statement replaces N raw facts) so coverage improves inside the
same 1024-token cap. The hot recall path is deliberately **not** routed
through `reflect` (an agentic loop, ~5–10 iterations / 10 ceiling, 300s
wall-timeout): that would blow warm TTFO (~1.7s) into seconds and multiply
per-turn tokens. Reflect stays reserved for explicit "what do you know about
me" asks.

**Phase 2 — Specialize each bank. — SHIPPED (#2855).** Per-agent
`retain_mission` / `bank_mission` were made first-class config with a generic
`DEFAULT_RETAIN_MISSION` seeded at scaffold; #2855 then threaded the remaining
knobs — `reflect_mission`, `observations_mission`, and per-bank `disposition`
— through the full config cascade (`AgentMemorySchema` in
`src/config/schema.ts`, cascade merge in `src/config/merge.ts` with per-key
`disposition` inheritance) and into BOTH the scaffold and reconcile bank-update
paths in `src/agents/scaffold.ts` via `resolveBankMissionExtras` +
`updateBankMissions` (`src/memory/hindsight.ts`). `disposition` is no longer
uniform `{empathy:3, literalism:3, skepticism:3}`: built-in
`PROFILE_MEMORY_DEFAULTS` differentiate the specialists on a zero-YAML install
(a `health-coach` leans empathy-high, `coding`/`executive-assistant` lean
skeptical + literal), and operator config overrides per-key. The mechanism is
general — any bank can set these fields; the RFC's three named banks
(`assistant`, `lawgpt`, `ziggy`) are just the first adopters, not a hard-coded
list. Operator-config-driven (no-self-escalation clean).

**Phase 3 — Directives as the "corrections stick" path. — PARTIAL /
guidance-only.** The intent is to route user-stated preferences/rules into
`create_directive` (user-authored, verbatim, chat-legible) rather than hoping
recall re-surfaces them. Today this is wired only as a **model instruction**:
`profiles/default/CLAUDE.md.hbs` (~L53, with supporting guidance ~L61) tells
the agent to call `create_directive` when the user gives a correction or
"always do X" rule. There is **no deterministic hook** that detects a
correction and routes it into `create_directive` — it relies entirely on the
model choosing to call the tool. The invariant-alignment argument holds; the
reliability gap (guidance vs. guaranteed capture) is the remaining work.

**Phase 4 — Make memory chat-legible (sparse, not per-turn). —
NOT-STARTED.** The goal is a terse "remembered: X" / "updated what I know
about Y" line so recall and consolidation stop being invisible, closing
tensions (1) and (2). The **only** legibility surface shipped is a transient
`📚 recalling memories` spinner (`recall.py`, #303), which signals *that*
recall ran, not *what* was stored or corrected — it is not the store/correct
line this phase specifies. When built, this **must be sparse and
material-only**, never default-on-every-turn: the job lists "regurgitating
old facts unprompted just to prove it remembered" as a top anti-pattern, so a
per-turn legibility line would *become* that anti-pattern. Surface only on a
genuine store/correct, or on request. The `consolidation.completed` webhook
can drive the update side without polling.

**Phase 5 — Curated mental models per specialist. — NOT-STARTED as
automation (and arguably regressed).** The original gap was framed as "one
auto-seeded model everywhere → curate more selectively." That framing is now
**wrong**: #2447 *removed* per-agent user-profile auto-seeding, and profile
knowledge moved into dedicated profile banks (`ken-profile`, `lisa-profile`)
reached via per-speaker routing (see Developments above). So the real gap
today is **no automated per-specialist curation at all** — the few topical
models that exist (`assistant`: 2, `lawgpt`: 5) were hand-built. In that
sense the auto-seeding removal was a net simplification for the profile use
case but a *regression* for "the fleet grows its own pinned models." If
revived, this stays deliberately **not** autonomous creation (tension 3):
operator-curated, or agent-proposes → operator-confirms in chat. Curate
**selectively**: a model set to `refresh_after_consolidation` (off by
default) adds bounded (~2048 token) post-consolidation refresh spend and can
hit the 300s reflect wall-timeout (observed historically on this fleet), so
more refresh-enabled models is more invisible background cost. Their upside is
real on the *explicit* reflect path (fresh models let reflect short-circuit
the lower tiers → faster); they do not speed the hot recall path.

**Phase 6 — Two near-free hot-path levers (UX + speed + tokens).** Not
synthesis-tier work, but large responsiveness/cost wins that cross no
invariant.

- **6a — Gate recall on need. — SHIPPED.** Recall no longer fires on every
  substantive turn: `settings.recallSkipTrivial = true` (`scaffold.ts`
  ~L2521) plus the `_is_trivial_stateless()` guard
  (`vendor/hindsight-memory/scripts/recall.py:582`, invoked ~L664) skip
  plausibly-stateless/trivial asks ("what time is it", greetings), so those
  turns pay neither the ~1–2s recall arm (budget `low`) nor the up-to-1024
  injected tokens. This speeds the warm-TTFO path the `jtbd-fast-trivial-dm`
  gate measures *and* saves tokens. The guard is conservative by design (a
  false negative — gating a turn that *did* need memory would undercut the
  job's continuity criteria), which is why it targets only the clearly
  stateless class.

- **6b — Right-size retain cadence. — SHIPPED (#2830/#2831); rolled
  fleet-wide in v0.17.5.** `retainEveryNTurns=1` (scaffold override; vendor
  default is 10) means every turn triggers background consolidation (sonnet).
  Under the previous `full-session` retain mode this was confirmed live as the
  single largest *invisible* subscription draw (on the order of ~1M
  consolidation tokens/day/agent, ~100% of an agent's LLM spend) and the
  engine room of tension (1). The original RFC noted you could not simply
  raise N or flip retain modes to cut this — a vendor patch was required. That
  patch is exactly what #2830 landed. Three facts, stated plainly:
  1. **The cost premise was confirmed live** before the fix. Switchroom ran
     `full-session` retain mode, so each fire re-consolidated the whole
     accumulated transcript and per-fire cost grew with session length — the
     savings curve from windowing is real but non-linear.
  2. **"Chunked windowing WITH every-turn firing" required a vendor patch —
     now applied.** Upstream `retain.py` gated the chunked slice path on
     **both** `retain_mode == "chunked"` **and** `retain_every_n > 1`, so at
     `retainEveryNTurns=1` it fell through to full-session regardless of
     `retainMode`. #2830 extracted `select_retain_window()`
     (`vendor/hindsight-memory/scripts/retain.py:72`) to decouple the
     window-slice from the `>1` throttle — a chunked window of
     `max(retain_every_n, 1) + overlap_turns` is well-defined at
     `retain_every_n >= 1`, so chunked+every-turn now works. The
     switchroom-divergence is documented at the patch site (candidate to
     upstream to vectorize-io/hindsight); `scaffold.ts:2520` sets
     `retainMode="chunked"` and `tests/scaffold.recall-observations.test.ts`
     pins it, with a vendor unittest at
     `vendor/hindsight-memory/scripts/tests/test_retain_window.py`.
  3. **The short-session restart guarantee is preserved.** The
     `jtbd-memory-survives-restart-dm` UAT breaks if short-session (≤2-turn)
     retain stops firing — which is why scaffold keeps `retainEveryNTurns=1`.
     Windowing does not weaken this: the chunked window always extends to the
     end of the transcript, so the firing turn is always inside the window,
     and every turn fires at n=1. A pre-merge adversarial review caught the
     one way this could have silently lost memory — the window must count
     **human turns only** (tool_result messages are not turns; counting them
     could push the human's fact outside the window). `select_retain_window()`
     slices by human-turn boundary accordingly. The SessionEnd `force=True`
     retain still exists as the belt-and-suspenders flush.
  Net: 6b was the biggest token lever and it has shipped — a decoupling vendor
  patch plus the chunked scaffold override, with the short-session restart
  guarantee kept intact. The realized savings are **not yet measured**; that
  verification is tracked in #2847.

## Speed & token budget

The fit argument above is about *correctness*. This section weighs *cost*.
Two latency/token surfaces matter, and they pull in opposite directions:

- **Foreground (per-turn).** The auto-recall hook runs on every substantive
  `UserPromptSubmit` at budget **`low`** (~1–2s, vector retrieval + local
  rerank, **no model call**), with an 8s recall timeout inside the 12s hook
  ceiling, injecting up to 1024 tokens of context. It is on the critical path
  for warm TTFO (~1.7s baseline, gated by `jtbd-fast-trivial-dm`), so anything
  added here is felt directly, but it spends *no* model tokens. Phase 6a now
  removes this cost entirely on trivial turns. (`low` is operator-raisable to
  `mid` ~5s, which adds an LLM rerank pass; switchroom does not.)
- **Background (invisible).** Every retain triggers consolidation (sonnet, on
  the subscription) the operator never sees; `retainEveryNTurns=1` makes that
  per-turn. This was the largest *uncounted* subscription draw — under
  `full-session` retain it was essentially **100% of an agent's model spend**
  (order ~1M consolidation tokens/day/agent), and the engine room of invariant
  tension (1). **Phase 6b (#2830, live in v0.17.5) addresses it in code:**
  chunked windowed retain re-consolidates only the recent window per fire
  instead of the whole growing transcript, so per-fire consolidation input
  should be roughly flat over session length rather than growing linearly. The
  realized savings are **not yet measured** — that verification (per-agent
  consolidation spend via LiteLLM, flat-per-fire evidence) is tracked in
  #2847, and this section will carry the numbers once available.
  Mental-model refreshes (when refresh-enabled) would add to it, but
  auto-seeding was retired so none are wired today.

Per-phase scorecard against the three axes (status-annotated):

| Phase | Status | UX | Speed | Tokens |
|---|---|---|---|---|
| 1. Consume observations | SHIPPED | curated, not grab-bag | bounded (+1 arm; rerank capped at 300) | denser → ≤ same; no model call |
| 2. Per-agent missions/disposition | PARTIAL | specialized recall (3 banks) | neutral (shapes extraction) | slight win — less noise stored |
| 3. Directives ("corrections stick") | PARTIAL | strong when it fires | negligible | small fixed per-turn cost if always injected |
| 4. Chat-legible (sparse) | NOT-STARTED | legible **iff** sparse | negligible | minor output tokens |
| 5. Curated mental models | NOT-STARTED | + faster *reflect* | neutral on hot path | background refresh spend; timeout risk |
| 6a. Gate recall on trivial turns | SHIPPED | trivial turns feel instant | **win** — skips ~1–2s arm | **win** — drops ~1024 tok on trivial turns |
| 6b. Right-size retain cadence | SHIPPED (#2830) | unchanged | unchanged | **win — shipped**; chunked window, flat-per-fire; savings unmeasured (#2847) |

Net read: **Phases 1, 6a, and 6b have shipped.** 1 and 6a moved recall from
the job's *bad* column toward its *good* column at near-zero (1) or negative
(6a) cost; 6b (#2830) took on the biggest token lever — the every-turn
`full-session` reconsolidation draw — with a vendor patch that decouples
chunked window-slicing from the throttle (the config flip alone was never
enough), and its realized savings are pending measurement (#2847). **Phase 2**
is partially in (bank/retain missions). **Phase 3** exists as guidance but not
as a guaranteed path. **Phase 4** is untouched. **Phase 5** changed shape
entirely (profile knowledge moved to dedicated banks).

## Verdict check (the four-part rule)

- **Advances an outcome?** Yes, `standing-team`, via the core memory job and
  the specialist job. Phases 1 and 6a already moved recall toward the "good"
  column (curated observations in, trivial-turn cost out).
- **Satisfies the job spec?** Shipped work moved recall from the job's *bad*
  column (grab-bag/raw) toward its *good* column
  (curated/legible/by-relevance); the remaining open phases (3, 4) are where
  the "legible" and "corrections stick" criteria still have gaps.
- **Passes the three principle checks?** Defaults: shipped phases (1, 6a) are
  config defaults, no operator assembly. Docs: behavior improved without new
  user-facing concepts. Consistency: same vault/config cascade. Speed/tokens:
  net-positive or measured (see *Speed & token budget*).
- **Crosses an invariant?** No. Each phase is shaped to avoid the tensions
  named above (no autonomous self-writes; legibility added, not removed). The
  #2447 auto-seeding removal actively *resolved* tension (3).

## Non-goals

- Not adopting Hindsight's multi-tenant schemas, transfer/import, or webhook
  fan-out beyond the single legibility use.
- Not adding time-based decay (explicit demote is the correct model, and it
  is confirmed wired end-to-end).
- Not enabling autonomous mental-model creation (and note the fleet has moved
  *away* from even seeded auto-creation as of #2447).
