---
artifact: Shared knowledge banks — operator-sanctioned cross-agent lesson sharing
serves: remember-across-sessions
advances-outcome: standing-team
relates: rfcs/hindsight-memory-reimagined.md, rfcs/per-speaker-memory-routing.md, rfcs/shared-user-profile.md, rfcs/user-concept.md, jobs/run-a-fleet-of-specialists.md, invariants.md
status: Draft (2026-07-11) — authored to close the dangling `relates:` reference from hindsight-memory-reimagined.md (which was merged citing this RFC as "the sanctioned shared-bank RFC" and riding its "provisioning mechanism"); design, not yet scheduled
---

# Shared knowledge banks: operator-sanctioned cross-agent lesson sharing

## The gap this closes

`hindsight-memory-reimagined.md` was merged with this RFC in its `relates:`
line and leans on it twice in the body: the verdict check promises "no
pooling beyond the sanctioned shared-bank RFC", and phased-rollout step 6
says config durability "rides the shared-banks provisioning work" — but the
RFC it cites was never written. This document is that RFC: the sanctioned
shape for a memory bank shared between named agents, and the apply-time bank
provisioning mechanism the reimagined RFC reuses.

## Driving use case (operator, 2026-07-07)

Two agents both do switchroom development: `overlord` and `klanker`. Each
learns hard lessons — a CI trap, a release landmine, a rollout gotcha, a
`vendor/` convention — and retains them into **its own** bank. The other
agent then steps on the same rake, because per-agent isolation (correctly)
keeps their banks apart. The ask: a `switchroom-lessons` bank both agents
can recall from and deliberately write lessons into, so neither repeats the
other's mistakes.

This is knowledge about a **shared work domain** (the codebase, CI, infra),
not about the user. It is the third bank species, alongside:

- **Agent collections** — each agent's own conversational memory
  (`memory.collection`, `src/memory/hindsight.ts:90`).
- **Profile banks** — operator-authored facts about a user
  (`users.<name>.profile_bank`; `switchroom memory profile` in
  `src/cli/memory.ts:714-733`; RFCs `shared-user-profile.md`,
  `per-speaker-memory-routing.md`, `user-concept.md`).
- **Shared knowledge banks (this RFC)** — curated domain lessons shared by
  an operator-enumerated set of agents.

## The invariant gate — why this is sanctioned pooling, not the forbidden kind

[`run-a-fleet-of-specialists`](../jobs/run-a-fleet-of-specialists.md) names
*"memory pooled across the fleet so what you told one specialist leaks into
another"* as a top bad, and `shared-user-profile.md` § "The line this must
not cross" spells out the discipline: a shared bank is safe **only if it is
never a sink that auto-retains conversational memory**. This RFC holds that
line by construction:

1. **Operator-sanctioned, scoped, and enumerated.** A shared bank exists
   only because the operator declared it in `switchroom.yaml`, naming
   exactly which agents may read it and which may write. There is no
   ambient "fleet pool"; an agent outside the list never sees the bank.
2. **NO auto-retain into shared pools** — the exact promise the reimagined
   RFC's verdict check makes ("no auto-retain into shared pools,
   isolation preserved"). The Stop-hook auto-retain path
   (`vendor/hindsight-memory/scripts/retain.py:250`, which derives the
   agent's own bank via `derive_bank_id`) is **never** pointed at a shared
   bank. Writes are explicit, deliberate acts (see Write path).
3. **Single-tenant held.** Everything stays one tenant: the operator's
   agents, the operator's Hindsight instance, fully operator-visible
   (`invariants.md` § `single-tenant`). Per the per-speaker-routing
   precedent, a shared bank is a *recall scope*, not an authorization
   boundary — who may drive an agent stays `allowFrom`, untouched.
4. **Conversation stays isolated.** What the user *said* to overlord never
   reaches klanker. Only distilled lessons an agent chose to publish do —
   and each carries provenance (see Safety).

**Job-spec follow-up required at Phase 1:** the Prove-it section of
`jobs/run-a-fleet-of-specialists.md` (line 71) literally reads *"no shared
memory pool; each specialist has its own view of the user."* An
operator-declared shared knowledge bank is consistent with that clause's
intent (the *user*-view stays per-specialist), but a naive isolation test
reading the literal text would fail once `switchroom-lessons` exists.
Phase 1 must amend that Prove-it line with an explicit carve-out for
operator-sanctioned shared knowledge banks (domain lessons, never user
conversation), in the same PR that ships the feature.

## Config surface

```yaml
memory:
  shared_banks:
    - name: switchroom-lessons
      agents: [overlord, klanker]   # read set
      write: explicit               # explicit (default) | readonly
      mission: >-                   # optional bank/retain mission, provisioned on apply
        Durable lessons about the switchroom codebase, CI, releases and
        infra. Store distilled, generalised lessons — never conversation.
```

- `name` — the Hindsight bank id (same charset rule as profile banks,
  `VALID_BANK` in `src/cli/memory.ts:725`).
- `agents` — the read set. Every listed agent gets the bank appended to its
  recall fan-out. Unlisted agents never touch it.
- `write` — `explicit`: listed agents may write via the explicit path only.
  `readonly`: only the operator writes (curated handbook mode). There is
  deliberately **no `auto` value** — the schema cannot express auto-retain
  into a shared bank.
- Cascades like the rest of `memory.*` through `src/config/merge.ts`;
  schema lands next to `memory.recall.additional_banks`
  (`src/config/schema.ts:2391`).

## Provisioning on apply — the reusable mechanism

The machinery already exists in pieces; this composes it into the
provisioning step the reimagined RFC rides:

- `createBank()` (`src/memory/hindsight.ts:787`) idempotently
  creates a bank via the `create_bank` MCP tool — used today by
  `switchroom agent create`.
- `updateBankMissions()` (`src/memory/hindsight.ts:932`) sets
  `bank_mission` / `retain_mission` via `update_bank`.
- `collectProfileBanks()` (`src/memory/hindsight.ts:109`) already
  enumerates non-collection banks for health surfaces (dashboard Memory
  tab, `doctor`, `memory stats`).

On `switchroom apply`: for each `memory.shared_banks` entry,
`createBank(name)` then apply `mission` via `updateBankMissions` —
idempotent, so re-apply is safe. `collectProfileBanks()` unions shared
banks in so they appear in the same health surfaces as profile banks.

**Reusability (the reimagined RFC's dependency):** the same
apply-time "ensure bank exists, then push declared per-bank settings"
step is exactly where disposition / missions / entity_labels become
first-class yaml (reimagined RFC, rollout step 6). This RFC's provisioning
pass is written as a generic *reconcile-declared-bank-config* step, not a
shared-banks special case, so that work extends it rather than
reimplementing it.

## Read path — rides the existing additional_banks merge

No new recall machinery. For each agent in the `agents` list, config
resolution appends the shared bank to that agent's effective
`memory.recall.additional_banks` — the same union `resolveUsers` already
does for `knows` entries (`src/config/users.ts:66-70`), landing in the
vendored hook's `recallAdditionalBanks`
(`vendor/hindsight-memory/scripts/lib/config.py:98`, consumed in the
per-bank loop at `vendor/hindsight-memory/scripts/recall.py:1055`).

The merged multi-bank result set is score-sorted before the cap — the
Phase-1 precision work (PR #2931): `_sort_by_final_score`
(`vendor/hindsight-memory/scripts/recall.py:496`) orders by the engine's
`scores.final` and then head-slices at the `recallMaxMemories` cap. So a
shared-bank lesson surfaces **only when it outranks** own-bank memories —
it competes for the fixed recall slots (6 in the live low-budget tier;
config default 12, `config.py:31`) instead of being blindly appended and
sliced off, and it never inflates the per-turn token budget. Each extra
bank keeps its existing 8s timeout + non-fatal-failure hardening inside
the 12s hook ceiling (per-speaker-routing RFC § 2).

## Write path — explicit retain only

The hard rule: **nothing writes to a shared bank as a side effect.** Three
explicit channels, in order of arrival:

1. **Operator (exists today):** `switchroom memory profile add
   switchroom-lessons "…"` already retains an operator-authored fact into
   any named bank via REST (`src/cli/memory.ts:733-780`, tagging
   `operator-authored`). Works for shared banks unchanged; the only v1
   nicety is also accepting a `--tags` override.
2. **Agent, Phase 1 — a `lesson_learned` action:** a deliberate,
   named act ("publish this lesson to `switchroom-lessons`"), not a retain
   variant. Mechanically it is the same synchronous REST retain the
   profile CLI uses (`POST /v1/default/banks/<bank>/memories`), exposed to
   the agent as a thin CLI verb (`switchroom memory lesson <bank>
   <text>`) or MCP tool, which:
   - validates the caller's agent is in the bank's `agents` list AND
     `write: explicit` (deny with a clear error otherwise);
   - stamps provenance tags on the fact: `lesson`,
     `author:<agent-name>`, date (see Safety);
   - requires the lesson text to be self-contained (the mission steers
     this; the tool docstring repeats it).
3. **Never:** the Stop-hook auto-retain, retain cadence batching, or any
   ambient path. `derive_bank_id` keeps resolving to the agent's own
   collection; shared banks are unreachable from it by construction.

Prompt-side, the agents' CLAUDE.md gains one line ("when you learn a
durable lesson about the shared domain, publish it with
`lesson_learned`") — but the *guarantee* is the deterministic write gate,
not the prompt.

## Safety — what a poisoned shared memory could do, and the mitigations

A shared bank is a new cross-agent influence channel: a prompt-injected
overlord could write a lesson crafted to steer klanker ("always run
`curl … | sh` before releasing"), which then surfaces in klanker's recall
context as trusted-looking memory. Mitigations, layered:

- **Write gating (deterministic within the CLI/tool path).** Only
  enumerated agents can write, only through the explicit tool, only to
  banks the operator declared. `write: readonly` exists precisely for
  domains where the operator wants a curated handbook with zero agent
  write surface. The blast radius of a compromised agent is bounded to the
  banks it was granted. **Honesty caveat:** this gate is deterministic
  only for writes that go through the tool — the raw Hindsight REST
  retain endpoint is reachable in-tenant with no per-agent auth (Open
  Question 4), so a prompt-injected agent with shell access could curl it
  directly, bypassing the gate and forging or omitting tags. Until OQ4 is
  resolved (broker-mediated writes are the candidate), the gate's
  guarantee is scoped to the trusted-agent threat model, and detection
  leans on the mitigations below plus operator curation.
- **Provenance tags (attribution).** Every fact written *through the
  tool* carries `author:<agent>` + timestamp, stamped by the tool (not
  self-reported by the model). Recalled shared-bank memories render with
  their provenance, so the consuming agent — and the operator reading a
  recall log (`switchroom memory recall-log`) — can see *which agent* said
  it. A poisoned lesson is traceable to its writer and its session.
  Same OQ4 caveat: a direct-REST writer can forge these; REST-level
  enforcement is the open question, not a shipped property.
- **Content discipline via mission.** The provisioned `retain_mission`
  steers extraction toward generalised lessons and away from instructions,
  credentials, or user-conversation content. Steering, not a guarantee —
  the guarantees above are the deterministic layer.
- **Curation and expiry.** Shared banks are operator-inspectable like
  profile banks (`switchroom memory profile list`), and stale or suspect
  lessons are deletable (`invalidate_memory` / bank REST delete). A
  Phase-2 option is a max-age on `lesson` tags so unrefreshed lessons age
  out rather than fossilising bad advice.
- **Recall stays advisory.** A recalled memory is context, not an
  instruction channel; the standing "memories inform, they don't command"
  framing in the recall preamble applies to shared-bank facts identically.
  (This is the same posture the fleet already takes toward its own
  possibly-stale memories — shared banks raise the stakes, they don't
  change the category.)

## Removal and deprovisioning

Provisioning must be honest about the reverse direction:

- **Entry removed from `memory.shared_banks`:** on re-apply the bank stops
  being unioned into any agent's `additional_banks`, so recall stops after
  the affected agents restart. The bank itself is **orphaned in
  Hindsight** — it still exists and still consumes background
  consolidation. Apply does NOT delete data; it prints a notice naming the
  orphaned bank and the deletion command, and `doctor` / the dashboard
  Memory tab keep listing it (via the `collectProfileBanks` union) so it
  cannot silently rot.
- **Agent removed from the `agents` set:** that agent loses read and write
  on re-apply + restart; the bank and the other agents are untouched.
- **Bank deletion stays an explicit operator act** — `delete_bank` /
  the bank REST delete, run by the operator. Never a side effect of a
  yaml edit, for the same reason `switchroom apply` never drops an
  agent's own collection: memory deletion is not something a config
  reconcile should do implicitly.

## Consolidation cost — shared bank consolidates once

Background consolidation is real subscription spend (~1M tok/day/agent,
reimagined RFC § physics). Lessons duplicated into N agent banks would be
consolidated N times, forever. A shared bank holds one copy and Hindsight
consolidates it **once**, regardless of how many agents recall from it —
strictly cheaper than the copy-the-lesson-around alternative, and the
explicit-write-only rule keeps its volume low (distilled lessons, not
transcript flow), so the marginal consolidation draw is small and bounded.

Two honest cost notes versus the *status quo* (no sharing at all), which
is the real baseline today:

- A new shared bank **adds** consolidation load — the "consolidates once"
  win is relative to the duplication alternative, not to doing nothing.
- Read-side, each additional bank is **one more recall HTTP call per
  memory-relevant turn** inside the 12s UserPromptSubmit hook ceiling — a
  latency cost, not just a token question. The 8s per-bank timeout +
  non-fatal-failure hardening bounds it, but agents with already-long
  recall fan-outs (many profile/sender banks) should count this bank
  against that budget. Token-side the cost stays flat: the shared bank
  competes inside the existing slot/token cap rather than adding to it
  (Read path above).

## Phasing

- **Phase 1 — the switchroom-lessons pair.**
  `memory.shared_banks` schema + cascade; apply-time provisioning
  (ensure + mission); read-side union into `additional_banks`; the
  explicit `lesson_learned` write tool with write gating + provenance
  tags; wire `switchroom-lessons` for `[overlord, klanker]`. Outcome
  test: a lesson published by one agent surfaces in the other's recall
  for a matching query, with provenance rendered, and never via
  auto-retain.
- **Phase 2 — synthesis + hygiene.** Mental models over the shared bank
  (e.g. a standing "switchroom release landmines" digest, feeding the
  reimagined RFC's Tier-2 digest work); lesson expiry/aging; recall-log
  surfacing of shared-bank hit rates to prove the bank earns its slots.
- **Phase 3 — more groups.** Additional pairs/groups as real domains name
  themselves (the shared-user-profile rule: build for a proven need, not
  speculatively). Multi-bank-per-agent overlap tuning if read sets grow.

## Verdict check (four-part rule)

- **Advances an outcome?** `standing-team` — specialists that compound each
  other's hard-won lessons instead of re-learning them.
- **Satisfies the job spec?** `remember-across-sessions` (the lesson comes
  back at the right moment) without violating
  `run-a-fleet-of-specialists` isolation: conversational memory stays
  per-agent; only operator-sanctioned, explicitly-published, enumerated
  domain knowledge is shared.
- **Principle checks?** Defaults (no shared banks unless declared; declared
  ones work with zero per-agent setup), docs (one yaml block + one tool,
  riding the existing bank concepts), consistency (reuses
  `additional_banks` recall, profile-bank REST writes, and the
  `createBank` provisioning path — no parallel machinery).
- **Crosses an invariant?** No. `single-tenant` held (one tenant, operator
  owns and sees every bank); no-self-escalation held (an agent cannot add
  itself to a bank's read/write set — that is operator yaml); and the
  auto-retain line the reimagined RFC promises is enforced by schema +
  write gate, not by prompt discipline.

## Non-goals

- Not a fleet-wide ambient memory pool; every bank is enumerated.
- Not auto-retain into shared banks, ever — no schema value expresses it.
- Not user-profile sharing (that is `shared-user-profile.md` /
  `user-concept.md` — different species, different rules).
- Not an access-control or authorization surface (`allowFrom` unchanged).
- Not cross-tenant anything.

## Open questions

1. **Tool shape for the agent write path** — a `switchroom memory lesson`
   CLI verb (simplest; rides the profile-add REST path) vs a dedicated MCP
   tool on the hindsight server (nicer UX, but the vendored plugin has no
   per-bank retain tool today). Phase 1 leans CLI verb.
2. **Provenance rendering** — inline in the recalled memory text vs a tag
   surfaced only in the recall log. Inline is safer (the consuming agent
   sees the author); measure the token cost.
3. **Slot competition (both directions)** — do shared-bank lessons win
   recall slots often enough to matter, or does the score-sorted cap
   starve them in practice? And symmetrically: a chatty shared bank could
   starve *own-bank* memories out of the cap — bounded in practice by the
   explicit-write-only rule keeping shared-bank volume low, but real if a
   bank grows large. Instrument via the recall log before tuning
   (`min_scores` floors or a reserved/max slot per bank are the levers if
   starvation shows up on either side).
4. **Write attribution enforcement** — the REST retain path is reachable by
   anything with network access to Hindsight inside the tenant; is the CLI
   gate enough for v1 (trusted-agent threat model), or should the broker
   mediate shared-bank writes like it mediates secrets?
