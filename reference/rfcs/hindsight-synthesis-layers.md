---
artifact: Hindsight primitive fit — use the synthesis layers the memory job demands
serves: remember-across-sessions
advances-outcome: standing-team
relates: jobs/run-a-fleet-of-specialists.md, jobs/feel-like-a-colleague.md
status: mostly shipped (rev. 2026-07-06); phases 1 + 2 + 4 + 6a + 6b live, 3 shipped-as-nudge+verifier, 5 shipped first slice — status record + remaining tail
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

**This document has since become a status record, and most of it has now
shipped.** As of 2026-07-06: Phase 1 shipped (observations are now recalled),
Phase 2 shipped (#2855 threaded `reflect_mission` / `observations_mission` /
per-bank `disposition` through the full cascade into scaffold + reconcile),
Phase 4 shipped its sparse chat-legible surface (#2858 — the 📌/✂️ tool-observation
lines, with the #2872 consolidation-webhook 🧠 side present in code but dormant
pending an engine that emits the webhook), Phase 3 shipped as a deterministic
nudge + verifier (#2864/#2873 — regex-detect → nudge → one bounded verifier
block; the *model* still authors the directive), Phase 5 shipped its first
slices (#2874/#2875 declarative + agent-proposes→operator-confirms, #2883 the
default-on `mental-model-curator` skill fleet-wide), Phase 6a shipped (recall
is gated on trivial turns), and Phase 6b shipped (retain is now a chunked
window instead of re-consolidating the whole transcript every turn — #2830,
rolled fleet-wide in v0.17.5). Per-speaker / shared-bank recall landed as an
adjacent feature. Several premises the original proposal rested on have also
*moved*: per-agent user-profile mental models were retired (#2447), so the
"one auto-seeded model everywhere" gap the RFC described no longer exists. The
analysis and phased structure below are preserved; each phase now carries an
explicit **SHIPPED / PARTIAL / NOT-STARTED** marker, and the evidence
section keeps the original 2026-06-18 snapshot with a "Status as of
2026-07-06" correction under each bullet.

This remains a design record. It does not change a job spec or an invariant;
it argues for using capability we already pay for, within the lines.

## Per-phase status at a glance (2026-07-06)

| Phase | Status | One-line |
|---|---|---|
| 1. Consume observations | **SHIPPED** (#2425/#2427) | `recallTypes` now includes `observation` |
| 2. Per-agent missions/disposition | **SHIPPED** (#2855) | `retain_mission`/`bank_mission` + `reflect_mission`/`observations_mission`/per-bank `disposition` now threaded through the cascade into scaffold + reconcile; `PROFILE_MEMORY_DEFAULTS` differentiate specialists on a zero-YAML install |
| 3. Directives ("corrections stick") | **SHIPPED as nudge+verifier** (#2864/#2873) | deterministic regex-detect → Stage B nudge → one bounded Stage C verifier block; the *model* still authors the `create_directive` call (not a hook-side write) |
| 4. Chat-legible memory (sparse) | **SHIPPED** (#2858) | 📌 remembered / ✂️ forgot from deterministic tool-observation; the 🧠 consolidation-webhook side (#2872) is present in code but **dormant** — the pinned image emits no `consolidation.completed` webhook and it is OFF by default |
| 5. Curated mental models per specialist | **SHIPPED first slice** (#2874/#2875/#2883) | declarative `memory.mental_models[]` + agent-proposes→operator-confirms `mental_model_propose` card + default-on `mental-model-curator` skill; autonomous creation still explicitly out |
| 6a. Gate recall on trivial turns | **SHIPPED** | `recallSkipTrivial=true` + `_is_trivial_stateless()` guard |
| 6b. Right-size retain cadence | **SHIPPED** (#2830/#2831), cadence now **3/1** (#2950) | chunked windowed retain — vendor `retain.py` patched (`select_retain_window()`) to decouple window-slicing from the `>1` throttle so it works at any `retainEveryNTurns >= 1`; live default is now `retainEveryNTurns=3`, `retainOverlapTurns=1` (#2950). Per-fire consolidation input measured **flat** at ~0.6–8k tok vs full-session's linear growth to ~141k tok — **21–38× per-fire, ≈25× cumulative** reduction on real transcripts (#2847); metered LiteLLM spend still pending (#2847) |

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
  - **Status as of 2026-07-06 — SHIPPED (#2855).** A generic
    `DEFAULT_RETAIN_MISSION` is seeded at scaffold (`src/memory/hindsight.ts`,
    applied in `scaffold.ts` as `seededRetainMission`), and #2855 then made the
    remaining knobs first-class: `retain_mission` / `bank_mission` /
    `reflect_mission` / `observations_mission` / per-bank `disposition` all
    live in `AgentMemorySchema` (`src/config/schema.ts`, ~L333-L464), cascade
    through `src/config/merge.ts` with per-key `disposition` inheritance, and
    are applied in BOTH the scaffold and reconcile bank-update paths via
    `resolveBankMissionExtras` + `updateBankMissions` (`scaffold.ts` ~L4390,
    `src/memory/hindsight.ts`). `disposition` is no longer uniformly
    `{empathy:3, literalism:3, skepticism:3}`: built-in `PROFILE_MEMORY_DEFAULTS`
    differentiate the specialists on a zero-YAML install (health-coach leans
    empathy-high; coding / executive-assistant lean skeptical + literal), and
    operator config overrides per key. The mechanism is general — the named
    banks (`assistant`, `lawgpt`, `ziggy`) are just the first adopters, not a
    hard-coded list. Operator-config-driven (no-self-escalation clean).

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
| **Mental models** | remember ("ask what it believes about you → legible answer"); colleague (continuity) | auto-seeding **retired** (#2447); now **declarative + agent-proposes→confirms** (Phase 5, #2874/#2875) + default-on `mental-model-curator` skill (#2883) | first slice shipped — operator-curated / proposed, never silent self-write |
| **Observations** | remember ("curated, by relevance, not grab-bag"; inspectable) | **now recalled** (Phase 1) | **consumed** — the wasted-spend gap is closed |
| **Directives** | colleague + remember ("rules set once stay respected"; "correction sticks") | model instruction + **deterministic regex nudge + one bounded verifier block** (Phase 3, #2864/#2873) | shipped as nudge+verifier — model still authors the write; not a hook-side write |
| **reflect** | remember ("what do you know about me") | explicit asks only | underleveraged as a recall path |
| **Bank missions + disposition** | fleet-of-specialists ("persona without own memory is cosplay") | retain/bank/reflect/observations missions + per-bank disposition all wired (#2855); `PROFILE_MEMORY_DEFAULTS` differentiate specialists | **shipped** specialization lever |
| **recall** (raw) | remember (necessary) | core path, now three-tier | keep — grab-bag tier, but denser with observations |
| Entity graph / links / cooccurrences | improves recall relevance (plumbing) | auto-built | keep as infra; not a vision lever |
| Webhooks (`consolidation.completed`) | could make memory chat-legible (the 🧠 update side) | consumer shipped (#2872) but **dormant** — pinned image emits no such webhook, OFF by default | Phase 4 update-side lever, awaiting the engine webhook |
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
2. **Invisible recall injection vs "honest, legible recall."** *Substantially
   addressed by Phase 4 (#2858), on the store/correct side.* The
   `<hindsight_memories>` recall block is still hidden `additionalContext`, but
   the *store/correct* side is now legible: a genuine `create_directive` fires
   a terse `📌 remembered: "…"` line and an `invalidate_memory` / demote fires
   `✂️ forgot: …`, both in the originating chat/topic
   (`telegram-plugin/memory-legibility.ts`, default-on). The transient
   `📚 recalling memories` spinner (`recall.py`, #303) still signals *that*
   recall ran. The remaining gap is the *update* side — the background
   consolidation engine distilling new durable observations — whose
   `🧠 updated what I know about Y` consumer exists
   (`telegram-plugin/consolidation-legibility.ts`, #2872) but stays dormant:
   the pinned image emits no `consolidation.completed` webhook and the surface
   is OFF by default (`SWITCHROOM_CONSOLIDATION_LEGIBILITY=1` to opt in).
3. **Auto-creating mental models vs `on-leash` / `no-self-escalation`.**
   *Resolved, and now re-armed the invariant-clean way.* The blind auto-seeding
   path was removed in #2447, so no agent enriches its own model structure
   unprompted. Phase 5's first slice (#2874/#2875) then re-introduced curation
   *without* crossing the tension: models are either operator-declared in
   `switchroom.yaml` or agent-**proposed** through the `mental_model_propose`
   approve/deny card (agent can never self-approve; hostd is the sole config
   writer). The default-on `mental-model-curator` skill (#2883) proposes, never
   silently creates. Autonomous creation stays explicitly out of scope.
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

**Phase 3 — Directives as the "corrections stick" path. — SHIPPED as
nudge+verifier (#2864/#2873).** The intent is to route user-stated
preferences/rules into `create_directive` (user-authored, verbatim,
chat-legible) rather than hoping recall re-surfaces them. Beyond the baseline
model instruction in `profiles/default/CLAUDE.md.hbs`, two deterministic hooks
now backstop it — but note the honest shape: this is **regex-detect → nudge →
one bounded verifier block, and the model still writes the directive** (no
hook-side write):
- **Stage B nudge** (`vendor/hindsight-memory/scripts/recall.py`,
  UserPromptSubmit): regex-detects correction / standing-rule-shaped inbound
  ("always/never …", "from now on …", "stop doing …", a stated preference,
  "that's wrong, it's …") and appends a terse advisory to the turn's
  `additionalContext` telling the model to persist the rule with
  `create_directive` **if it IS durable** — the model does the judgment
  in-session.
- **Stage C verifier** (`vendor/hindsight-memory/scripts/directive_verify.py`,
  Stop): after the turn, re-checks the human turn against a high-precision
  durable-rule regex and, if the model recorded no `create_directive` call,
  blocks the stop **once** to re-prompt capture (closes the "model ignored the
  nudge" gap). The single-block guard prevents a re-prompt loop.

Both are pure detection — no model callsite, no silent hook-side write. The
whole capture path is opt-out per-agent via `memory.directive_capture_nudge`
(schema default **true**; `src/config/schema.ts` ~L468), exported to the hooks
as `HINDSIGHT_DIRECTIVE_CAPTURE_NUDGE`, which disables **both** stages. The
reliability gap Stage A measured (~55% miss rate on durable corrections) is
what these close; the residual work is dedup (a restated rule can still
re-nudge / re-block — tracked as Fix 6.2) and optionally splitting the nudge
from the block behind a separate `directive_capture_verify` knob.

**Phase 4 — Make memory chat-legible (sparse, not per-turn). — SHIPPED
(store/correct side, #2858); update side dormant (#2872).** The goal is a
terse "remembered: X" / "updated what I know about Y" line so recall and
consolidation stop being invisible, closing tensions (1) and (2). The
**store/correct side is live**: `telegram-plugin/memory-legibility.ts` watches
the main-agent turn stream (deterministic tool-call observation, no model call,
no polling) and surfaces exactly two lines — `📌 remembered: "<directive>"` on
a `create_directive`, and `✂️ forgot: <reason>` on an `invalidate_memory` or a
demote-tagged `update_memory`. It is **sparse and material-only** by
construction: an ordinary `recall` / `reflect` / benign `update_memory` returns
null from the classifier, so no line fires — honoring the job's "regurgitating
old facts unprompted" anti-pattern. Default-on, opt-out via
`SWITCHROOM_MEMORY_LEGIBILITY=0`. The transient `📚 recalling memories` spinner
(`recall.py`, #303) still shows *that* recall ran.

The **update side** — the background consolidation engine distilling new
durable observations, surfaced as `🧠 updated what I know about Y` — has its
consumer shipped in code (`telegram-plugin/consolidation-legibility.ts` +
`src/web/webhook-gateway-record.ts`, #2872) but stays **deliberately dormant**:
it depends on a `consolidation.completed` webhook the pinned hindsight image
(v0.8.4) does not emit, and it is OFF by default
(`SWITCHROOM_CONSOLIDATION_LEGIBILITY=1` to opt in). Its schema must be pinned
with upstream before it is enabled fleet-wide.

**Phase 5 — Curated mental models per specialist. — SHIPPED first slice
(#2874/#2875/#2883).** The original gap was framed as "one auto-seeded model
everywhere → curate more selectively." That framing was superseded: #2447
*removed* per-agent user-profile auto-seeding, and profile knowledge moved into
dedicated profile banks (`ken-profile`, `lisa-profile`) reached via per-speaker
routing (see Developments above). Phase 5 re-armed curation the invariant-clean
way — see the companion note
[`hindsight-phase5-mental-model-curation.md`](hindsight-phase5-mental-model-curation.md).
Two slices shipped:
- **Declarative (#2874).** `memory.mental_models[]` (`{ name, source_query,
  refresh_after_consolidation?, max_tokens? }`, per-agent tier only, with a
  duplicate-name guard) is ensured create-if-absent by exact name on both
  scaffold and reconcile via `ensureDeclaredMentalModels`
  (`src/memory/hindsight.ts`, wired `scaffold.ts` ~L4428) — best-effort, 5s
  per-model timeout, never blocks. Zero declarations = zero models
  (byte-for-byte the post-#2447 behaviour); there is no default model.
- **Agent-proposes → operator-confirms (#2875).** The
  `mental_model_propose(chat_id, name, source_query, …)` gateway MCP tool
  mirrors the `vault_request_access` shape: it posts a `[✅ Approve] [🚫 Deny]`
  card, and on approval the gateway appends the model to the agent's
  `memory.mental_models[]` through hostd's `config_propose_edit` apply+reconcile
  (hostd is the sole config writer). The agent can never self-approve; the
  non-admin self-scope gate is widened by exactly one narrow rule (append to
  its OWN `memory.mental_models[]`).
- **Curator skill (#2883).** A **default-on, fleet-wide**
  `mental-model-curator` skill (`skills/mental-model-curator/`, injected via
  `src/memory/scaffold-integration.ts`) directs the agent to survey its OWN
  bank and **propose** well-earned models through the card — never bulk-create.

Autonomous creation stays deliberately **out** (tension 3). Curate
**selectively**: a model set to `refresh_after_consolidation` (off by default)
adds bounded (~2048 token) post-consolidation refresh spend and can hit the
reflect wall-timeout, so more refresh-enabled models is more invisible
background cost. Their upside is real on the *explicit* reflect path (fresh
models let reflect short-circuit the lower tiers → faster); they do not speed
the hot recall path. Deferred: proposals from a scheduled reflection (cron),
and any fleet-wide default model.

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
  fleet-wide in v0.17.5; cadence made operator-configurable at default
  `3/1` in #2950.** `retainEveryNTurns` (scaffold override; vendor default is
  10) is now **3** with `retainOverlapTurns=1` on the live fleet — every 3rd
  turn triggers background consolidation. (It shipped in #2830 at `1`; #2950
  moved the default to `3/1`. Older text in this RFC citing `retainEveryNTurns=1`
  predates #2950.) Under the previous `full-session` retain mode this was
  confirmed live as the
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
     `jtbd-memory-survives-restart-dm` UAT breaks if short-session retain
     stops firing. Windowing does not weaken this: the chunked window always
     extends to the end of the transcript, so the just-completed turn (whose
     Stop hook is firing) is always inside the window. At the current `3/1`
     cadence, retain fires every 3rd turn (not every turn — the RFC's earlier
     "every turn fires at n=1" wording predates #2950); the window
     `max(retain_every_n, 1) + overlap = 4` human turns still always contains
     the firing turn. This invariant was verified deterministically in #2847
     by replaying the production `select_retain_window()` over every N=3 fire
     of two real long transcripts: **54/54 fires included the just-completed
     human turn — 0 misses.** A pre-merge adversarial review caught the
     one way this could have silently lost memory — the window must count
     **human turns only** (tool_result messages are not turns; counting them
     could push the human's fact outside the window). `select_retain_window()`
     slices by human-turn boundary accordingly. The SessionEnd `force=True`
     retain still exists as the belt-and-suspenders flush.
  Net: 6b was the biggest token lever and it has shipped — a decoupling vendor
  patch plus the chunked scaffold override, with the short-session restart
  guarantee kept intact. **Realized savings (measured in #2847, deterministic
  replay of the production window selector on real transcripts):** per-fire
  consolidation input is **flat** at ~0.6–8k tok regardless of session length,
  vs full-session's linear growth to ~141k tok/fire on a 116-turn session —
  **21–38× per-fire, and 25× cumulative** (3.23M → 129k tok over that session's
  38 fires). Metered LiteLLM spend is not yet cleanly attributable (LiteLLM
  metering and 6b both landed 2026-07-05 so there is no pre-6b baseline, and
  consolidation re-homed from Claude sonnet onto `gpt-oss-20b` ~2026-07-08),
  but consolidation traffic is tag-isolable (`request_tags` includes
  `service:hindsight` + the `claude-cli` agent-SDK UA) so a settled metered
  figure is a 24–48h accumulation away; tracked in #2847.

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
- **Background (invisible).** Every retain triggers consolidation on the
  subscription the operator never sees; `retainEveryNTurns=3` (post-#2950; was
  `1`) makes that every 3rd turn. This was the largest *uncounted* subscription
  draw — under `full-session` retain it was essentially **100% of an agent's
  model spend** (order ~1M consolidation tokens/day/agent), and the engine room
  of invariant tension (1). **Phase 6b (#2830, live in v0.17.5) addresses it in
  code:** chunked windowed retain re-consolidates only the recent window per
  fire instead of the whole growing transcript. **Measured in #2847** (production
  window selector replayed on real transcripts): per-fire consolidation input is
  **flat** (~0.6–8k tok) instead of growing linearly (to ~141k tok/fire on a
  116-turn session) — **21–38× per-fire, ≈25× cumulative** reduction; the N=3
  cadence cuts the number of fires a further 3× vs the original N=1. A metered
  per-agent tokens/day figure via LiteLLM is still pending (no pre-6b baseline —
  metering + 6b co-landed 2026-07-05 — and consolidation re-homed to `gpt-oss-20b`
  ~2026-07-08; the `service:hindsight` request-tag is the clean-attribution
  handle, ~24–48h of accumulation away). Tracked in #2847.
  Mental-model refreshes (when refresh-enabled) would add to it, but
  auto-seeding was retired so none are wired today.

Per-phase scorecard against the three axes (status-annotated):

| Phase | Status | UX | Speed | Tokens |
|---|---|---|---|---|
| 1. Consume observations | SHIPPED | curated, not grab-bag | bounded (+1 arm; rerank capped at 300) | denser → ≤ same; no model call |
| 2. Per-agent missions/disposition | SHIPPED (#2855) | specialized recall + voice | neutral (shapes extraction) | slight win — less noise stored |
| 3. Directives ("corrections stick") | SHIPPED as nudge+verifier (#2864/#2873) | strong — deterministic nudge + one bounded re-prompt | negligible (regex detection, no model call) | tiny — advisory text only when a rule is detected |
| 4. Chat-legible (sparse) | SHIPPED store/correct (#2858); update side dormant (#2872) | legible **and** sparse (material-only classifier) | negligible | minor output tokens on genuine store/correct |
| 5. Curated mental models | SHIPPED first slice (#2874/#2875/#2883) | + faster *reflect*; operator-curated / proposed | neutral on hot path | background refresh spend only if refresh-enabled (off by default) |
| 6a. Gate recall on trivial turns | SHIPPED | trivial turns feel instant | **win** — skips ~1–2s arm | **win** — drops ~1024 tok on trivial turns |
| 6b. Right-size retain cadence | SHIPPED (#2830); cadence 3/1 (#2950) | unchanged | unchanged | **win — measured** (#2847): flat per-fire (~0.6–8k tok) vs linear (→~141k); **21–38× per-fire, ≈25× cumulative**; metered spend pending |

Net read: **Phases 1, 2, 4, 6a, and 6b have shipped, and 3 + 5 shipped their
first substantive slices.** 1 and 6a moved recall from the job's *bad* column
toward its *good* column at near-zero (1) or negative (6a) cost; 6b (#2830)
took on the biggest token lever — the every-turn `full-session`
reconsolidation draw — with a vendor patch that decouples chunked
window-slicing from the throttle (the config flip alone was never enough), and
its realized savings are pending measurement (#2847). **Phase 2** (#2855) is
fully in — all mission knobs + per-bank disposition cascade into scaffold and
reconcile. **Phase 3** (#2864/#2873) shipped as a deterministic nudge + one
bounded verifier block (not a guaranteed hook-side write — the model still
authors the directive; dedup is the residual gap). **Phase 4** (#2858) shipped
the sparse store/correct legibility surface; its consolidation-webhook update
side (#2872) is present but dormant. **Phase 5** (#2874/#2875/#2883) shipped
declarative models + agent-proposes→operator-confirms + the default-on
`mental-model-curator` skill; autonomous creation stays out. The remaining tail
is measurement (#2847), directive dedup (Fix 6.2), and the dormant
consolidation webhook (pending upstream schema pin).

## Verdict check (the four-part rule)

- **Advances an outcome?** Yes, `standing-team`, via the core memory job and
  the specialist job. Phases 1, 2, 4, 6a already moved recall + storage toward
  the "good" column (curated observations in, specialized banks, chat-legible
  store/correct, trivial-turn cost out).
- **Satisfies the job spec?** Shipped work moved recall from the job's *bad*
  column (grab-bag/raw) toward its *good* column
  (curated/legible/by-relevance): observations are consumed, corrections are
  nudged+verified into directives (Phase 3), stores/corrects are chat-legible
  (Phase 4), and specialists carry curated models (Phase 5). Residual gaps:
  directive dedup, the dormant consolidation-webhook update line, and measured
  token savings.
- **Passes the three principle checks?** Defaults: shipped phases are config
  defaults, no operator assembly (directive-capture nudge, memory legibility,
  and the curator skill are all default-on/opt-out). Docs: behavior improved
  with the new legibility lines documented in the operator runbook. Consistency:
  same vault/config cascade; mental-model writes go through the same hostd
  config-writer leash. Speed/tokens: net-positive or measured (see *Speed &
  token budget*).
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
