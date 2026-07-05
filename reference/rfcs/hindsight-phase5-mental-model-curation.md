---
artifact: Phase 5 design note — curated per-specialist mental models
serves: remember-across-sessions
advances-outcome: standing-team
relates: rfcs/hindsight-synthesis-layers.md, jobs/run-a-fleet-of-specialists.md
status: accepted-design + first-slice (2026-07-06)
---

# Phase 5 — curated per-specialist mental models (design + first slice)

Companion to [`hindsight-synthesis-layers.md`](./hindsight-synthesis-layers.md)
Phase 5. That RFC named this phase as the least-defined and deliberately
*not autonomous*. This note pins the design so we don't re-make the
mistake that got the previous per-agent-model behaviour removed, and
records the first slice actually shipped.

## The failure we must not repeat (why #2447 removed auto-seeding)

Before #2447, `scaffoldAgent` / `reconcileAgent` called
`ensureUserProfileMentalModel` on **every apply/restart for every
agent**, and a Stop hook refreshed it on every stop. That was **blind
seeding of one fixed model** (`user-profile`, source_query "what do we
know about the user?") into every bank whether or not the agent had the
content to back it. Three concrete harms:

1. **Empty/failed models injected every turn.** A freshly-seeded model
   over a thin bank synthesizes to noise (or fails), and `doctor`
   flagged them.
2. **Source-of-truth collision.** The per-agent `user-profile` model
   duplicated — and could contradict — the dedicated **profile banks**
   (`users.*.profile_bank`, recalled via `additional_banks` /
   `sender_banks`) that are the curated answer to "who is the user."
   A stale per-agent copy produced the "Rex" wrong-dog answer.
3. **Silent self-enriching structure.** An agent growing its own memory
   scaffolding unprompted brushes `on-leash` / `no-self-escalation`
   (RFC tension 3).

#2447's fix was correct: **retire the auto-wiring**, let profile banks
own identity, keep `ensureUserProfileMentalModel` dormant for the
operator-triggered dashboard path only.

## The design — declarative, operator-curated, opt-in per model

The RFC's invariant-clean shape for Phase 5 is *"operator-curated, or
agent-proposes → operator-confirms in chat, never a silent self-write."*
This note implements the **operator-curated declarative** half — the
safest first slice — and leaves agent-proposes-→-confirms as a later
increment.

The design turns "which mental models this specialist carries" into
**explicit config the operator declares**, then makes scaffold/reconcile
*ensure* exactly that set. It avoids each #2447 harm by construction:

| #2447 harm | How the declarative design avoids it |
|---|---|
| Blind seeding for every agent | **Nothing is created unless declared.** Zero declarations = zero models — byte-for-byte the post-#2447 behaviour. There is no default model. |
| Empty/noisy model injected | The operator only declares a model when the specialist's bank earns it (a coach's plan state, a lawyer's open matters). It is a deliberate curation act, not an automatic one. |
| Identity source-of-truth collision | **No fixed identity model is reintroduced.** "Who the user is" stays with profile banks. The schema doc and this note explicitly steer operators away from re-declaring a `user-profile`-shaped model; per-specialist models answer *domain* questions, not *identity* questions. |
| Silent self-escalation | The declaration lives in `switchroom.yaml`, which **only the operator edits** (agents cannot self-grant — `reference/vision.md` outcome 2). The agent never creates a model on its own initiative. |
| Fleet-wide over-seeding via defaults | The field is accepted at the **per-agent tier only** — intentionally *not* at `defaults`/profile — so a model can never be pushed across the whole fleet in one line. Each specialist opts in on its own. |

### Refresh is opt-in, off by default

`refresh_after_consolidation` defaults **off**. Per the RFC, a
refresh-enabled model adds bounded (~2048 tok) but *invisible*
post-consolidation model-spend and can hit the reflect wall-timeout.
Static curated models (refresh off) still serve the explicit `reflect`
path — they let reflect short-circuit the lower tiers — without the
background cost. Operators turn refresh on per model, deliberately.

### Idempotent ensure, best-effort, non-blocking

Each declared model is ensured create-if-absent by **exact name**
(substring matching false-positives across sibling models — the bug
fixed in the list step). The ensure runs inside the existing
`bankOpsChain` after the bank + missions, is wrapped best-effort with a
5s per-model timeout, and never blocks or fails scaffold/reconcile if
Hindsight is slow or down. It runs on **both** scaffold and reconcile
because a *declared* model is the desired steady state — adding a
declaration lands it on the next apply/restart. (This is safe precisely
because the set is operator-authored: unlike #2447, reconcile is not
recreating something the operator wanted gone.)

## First slice shipped (this PR)

- **Config:** `memory.mental_models[]` — `{ name, source_query,
  refresh_after_consolidation?, max_tokens? }`, per-agent only, with a
  duplicate-name guard.
- **Engine:** generalized `ensureMentalModel(apiUrl, bankId, spec)` (the
  old `ensureUserProfileMentalModel` is now a thin dormant wrapper over
  it) + `ensureDeclaredMentalModels(...)` which iterates the declared set
  and returns per-model outcomes for legible logging.
- **Wiring:** scaffold + reconcile ensure the declared set (best-effort,
  non-blocking), logging one `✓`/`⚠` line per model.
- **Tests:** generalized create payload shape, idempotency, exact-name
  match, the no-blind-seeding guard (undefined/empty → zero fetches), and
  the schema surface incl. duplicate/empty/invalid rejection.

## Deliberately out of scope (follow-ups)

- **Agent-proposes → operator-confirms in chat.** The other half of the
  RFC's invariant-clean shape: an agent surfaces "I'd pin a model for X —
  approve?" and the operator taps. Higher value, more surface (an
  approval-card flow), so it is a separate increment on top of this
  declarative base.
- **Autonomous creation.** Explicitly never (RFC non-goal + tension 3).
- **Chat-legible "model refreshed" line.** Belongs with Phase 4's sparse
  legibility work, not here.

## The open product decision

**Should there be ANY curated default model, or is per-agent-only
opt-in the final answer?** This slice ships zero defaults on purpose.
The alternative — a small, safe, *domain-neutral* default (not identity)
that most specialists benefit from — was rejected here because any
fleet-wide default re-creates the "seeded whether earned or not" shape
that #2447 removed. If the fleet later shows a genuinely universal model
worth defaulting, revisit with the agent-proposes-→-confirms flow rather
than a silent default. Flagged for the operator, not decided.
