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

## Second slice shipped (stacked PR — agent-proposes → human-approves)

The other half of the invariant-clean shape, stacked on this branch. An
agent surfaces a candidate model and the operator taps Approve; on approval
it becomes a first-class DECLARED model consumed by the exact ensure/reconcile
path above. Nothing bespoke — the approved proposal is just a new declaration.

- **Tool:** `mental_model_propose(chat_id, name, source_query, reason?,
  refresh_after_consolidation?, max_tokens?)` — a gateway MCP tool that
  mirrors the `vault_request_access` SHAPE (agent PROPOSES; the operator taps;
  the agent can never self-approve; the turn ends and resumes via a synthetic
  inbound). It renders a `[✅ Approve] [🚫 Deny]` card.
- **Approve → persist:** the gateway builds a unified diff APPENDING the model
  to `agents.<self>.memory.mental_models[]` and submits it through hostd's
  `config_propose_edit` apply+reconcile machinery (hostd is the sole config
  writer — the leash). A single-tap correlation (the same #1977 mechanism the
  "🔁 Always allow" flow uses) makes hostd auto-approve the edit WITHOUT a
  second card, since the operator already approved on the proposal card. The
  apply triggers reconcile, which runs `ensureDeclaredMentalModels` — so the
  model is ENSURED by the same path the declarative slice uses. On apply the
  agent is woken with `<channel source="mental_model_proposal_applied">`.
- **Deny → nothing:** no config read, no diff, no edit, no ensure; the agent
  is woken with `mental_model_proposal_denied`.
- **Guardrails:** propose-only (self-approve impossible — operator-only tap +
  the hostd approval gate); duplicate-name rejection against the agent's
  already-declared models (before a card is even posted); a per-agent
  rate-limit (≤5 cards/hour) plus hostd's own `config_edit_rate_per_hour`;
  nothing is created before the human taps Approve. The non-admin self-scope
  gate is widened by one narrow rule — a non-admin agent may append to its OWN
  `memory.mental_models[]` (in addition to its own `tools.allow`), so a forged
  proposal diff touching any other field/agent is still rejected.

## Deliberately out of scope (follow-ups)

- **Proposals from a scheduled reflection (cron), not just a live session.**
  This slice fires the proposal from a live turn (the agent has a `chat_id`).
  Whether a background reflection cron should be allowed to surface proposals
  is an open product decision (see below).
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

**Should a background reflection (cron) be allowed to PROPOSE, or only a
live session?** The second slice deliberately fires `mental_model_propose`
from a live turn (the agent has a `chat_id` and the operator is present to
tap). A scheduled reflection could ALSO notice a model worth pinning — but
firing an approval card into an empty topic at 3am is the vault flow's
"don't spam an empty topic" anti-pattern, and a non-interactive fire can't
end-turn-and-resume the same way. Options: (a) live-only (today); (b) let a
cron STAGE a proposal that is surfaced on the next interactive turn; (c) let
a cron post a card that simply waits for the operator whenever they next
look. Left to the operator — (a) is the safe default shipped.
