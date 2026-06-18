---
artefact: Shared user-identity profile across the fleet — evaluation + recommendation
serves: jobs/remember-across-sessions.md
relates: jobs/run-a-fleet-of-specialists.md, invariants.md
status: proposal (2026-06-19) — EVALUATION; recommends the light path, defers the heavy one
---

# A shared, operator-defined user identity across the fleet

## The ask

> Many agents' `user-profile` mental models aren't populated. Define a
> switchroom concept of a *user* — tied to a Telegram account as identity
> (e.g. Ken, Lisa for this install) — and let the operator declare things
> about that user that are shared across all agents, so every agent knows
> the same baseline consistently.

This doc evaluates whether that's a good idea and, if so, in what shape.
It is deliberately not a one-sided spec: the conclusion is that the
**goal is right and on-vision**, but the **mechanism the ask reaches for
(a shared memory bank + identity-keyed recall) is more machinery than
the core need requires** — a far lighter path already exists and should
ship first.

## Why the goal is right

It serves the vision's first outcome directly — *"a standing team that
knows you."* The relationship is supposed to compound; an agent that
makes you re-explain who you are each time is the goldfish the
[`remember-across-sessions`](../jobs/remember-across-sessions.md) job
exists to kill. Stable facts about the operator — timezone, family,
working style, hard preferences — *should* be consistent across every
specialist. Today they aren't: the seeded `user-profile` mental model is
synthesised **bottom-up** from each agent's own conversations, so a
low-traffic agent has a sparse or empty profile. Seeding it **top-down**
from operator-declared facts is the obvious fix and is squarely
on-vision.

## The line this must not cross

[`run-a-fleet-of-specialists`](../jobs/run-a-fleet-of-specialists.md)
makes memory **isolation** a hard requirement and names *"memory pooled
across the fleet so what you told one specialist leaks into another"* as
a top **bad**. `access-model` / `single-tenant` add that one operator
owns the box. So any "shared" memory has to thread two needles:

1. **Identity layer, not conversation layer.** A shared *who-you-are*
   baseline is fine; a shared *what-you-said-to-the-coding-agent* pool is
   exactly the cosplay the job forbids. The split only holds if the
   shared layer is **operator-authored stable facts** and never a sink
   that auto-retains conversational memory. That discipline is the whole
   ballgame — a shared bank that quietly accumulates is the failure mode.
2. **Known people, not co-operators.** Declaring *Lisa* as a person the
   agents know about is compatible with `single-tenant`. Letting Lisa
   *command or grant* is not — that's a multi-principal access change, a
   much larger and separate decision. This RFC scopes "user" to
   **identity + profile**, explicitly not control.

## Two designs

### B — Light: operator-authored profile, injected fleet-wide (recommended first)

switchroom **already** injects operator-authored, release-controlled
context into every agent: `renderFleetInvariants()` writes
`~/.switchroom/fleet/switchroom-invariants.md`, surfaced via Claude
Code's `--add-dir` (`src/agents/scaffold.ts:353`). And directives
already reach **every turn** (surfaced client-side in the recall hook,
`vendor/hindsight-memory/scripts/lib/directives.py`).

So the lightest version of the ask is: **an operator-authored
user-profile block, injected into every agent's always-on context** —
either a `user:` section in switchroom.yaml rendered into a fleet-level
profile file, or expressed as directives. No new memory infrastructure,
no new bank, no identity-keyed recall.

- **Invariants:** clean. It's static operator-authored text, not a
  pooled conversational bank — the isolation line is never approached.
  Chat-legible (the operator wrote it; the agent can recite it).
- **Cost:** a few hundred tokens of always-present context per turn.
  Negligible, and it's identity facts the agent would otherwise
  reconstruct from recall anyway.
- **Delivers:** every agent consistently knows the declared baseline,
  immediately, even on a brand-new or zero-traffic agent. This is ~80%
  of the stated value.
- **Limits:** static (every fact every turn — fine for a small stable
  profile, wasteful if it grows large); single-profile (no per-speaker
  switching); doesn't grow or self-correct.

### A — Heavy: shared hindsight bank + `recallAdditionalBanks` + identity keying

The recall hook already supports `recallAdditionalBanks` and the code
even names this use case — `recall.py:680`: *"Also recall from any
additional banks (e.g. shared user profile bank)."* The heavy design:
seed a shared per-user bank (`user-profile:ken`) top-down, wire every
agent's `recallAdditionalBanks` to include it, and **select the bank by
the inbound Telegram `user_id`** so the active speaker's profile
surfaces.

- **What it adds over B:** *semantic* recall (only profile facts relevant
  to the turn surface, not all of them), a profile that can **grow and be
  corrected** over time, and genuine **per-speaker** switching (Ken's
  profile when Ken talks, Lisa's when Lisa talks).
- **What it costs:** `recallAdditionalBanks` isn't wired through
  switchroom config today (`src/cli/memory.ts:31` is the only mention) —
  it needs config-cascade plumbing, bank seeding/maintenance, and
  inbound-`user_id`→bank selection. It adds a **second recall query every
  turn** (latency + tokens — the exact axis the Phase 1/6a work just
  optimised). And it re-opens the **isolation tension**: a shared bank is
  pooled memory, kept safe only by the discipline of never auto-retaining
  into it.
- **Single-tenant:** per-speaker keying only earns its complexity if Lisa
  *actually talks to the agents* and you want *her* profile to surface
  when *she* does. If the need is just "agents know my wife is Lisa,"
  that's one fact in **my** profile (design B) — no Lisa-identity bank
  required.

## Verdict — is this a good idea?

**The goal: yes. The heavy mechanism: not yet — and probably not for a
while.**

- **Ship B.** It delivers the core outcome ("every agent consistently
  knows the operator's declared baseline"), fixes the unpopulated-profile
  symptom directly (top-down seeding), is invariant-clean by
  construction, costs almost nothing, and reuses injection machinery that
  already exists. Most of what motivated the ask is satisfied here.
- **Defer A behind a proven need.** The shared-bank + identity-keyed
  design is justified only if (a) the profile grows large enough that
  injecting it whole every turn is wasteful, or (b) a *second human*
  genuinely converses with the fleet and you want per-speaker profiles.
  Both are speculative today. Until one is real, A is complexity +
  recall cost + a re-opened isolation tension bought for value B already
  provides.
- **Treat multi-user as its own decision.** "Known people" (profile only)
  is a small extension of B. "People who can drive agents" is a
  multi-principal change to the access model and `single-tenant` — out of
  scope here, and not to be smuggled in via a memory feature.

So: a good idea, reframed. Build the operator-authored shared profile
(B); don't build the shared-bank/identity machinery (A) until a concrete
need names itself.

## Verdict check (the four-part rule)

- **Advances an outcome?** Yes — `standing-team` / knows-you, via the
  core memory job.
- **Satisfies the job spec?** B makes every agent know the operator
  consistently (remember-across-sessions) without pooling conversational
  memory (run-a-fleet-of-specialists) — both honoured. A risks the
  second.
- **Principle checks?** B: defaults (operator declares once, works
  fleet-wide), docs (no new user concept beyond a yaml block),
  consistency (rides the existing fleet-context cascade). A would add a
  new memory surface + config + identity routing.
- **Crosses an invariant?** B: no. A: only if the shared bank ever
  auto-retains (isolation) or "user" creeps from identity into control
  (single-tenant) — both avoidable by construction, but they are live
  risks A must design against and B sidesteps.

## Recommended next step

If accepted: implement **B** as a thin slice — a `user:` block in
switchroom.yaml (free-form facts + a few optional structured fields)
rendered into the fleet-injected operator-profile context, default on.
Measure whether the unpopulated-profile complaint actually goes away.
Only open a follow-up for **A** if a real large-profile or genuine
second-speaker need materialises.

## Non-goals

- Not a shared *conversational* memory pool (isolation invariant).
- Not multi-principal control / a second operator (single-tenant).
- Not auto-retaining into any shared bank.
