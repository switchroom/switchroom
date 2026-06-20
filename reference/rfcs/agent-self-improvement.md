# RFC: Agents that improve themselves, on the leash

Status: Draft
Author: Ken (via Clerk pair-design)
Date: 2026-06-20
Serves: [`get-better-the-longer-they-run.md`](../jobs/get-better-the-longer-they-run.md) → outcome `standing-team`
Kill-clause: `hold-the-leash` invariants `no-self-escalation`, `on-leash`
Builds on: `skill-authoring-native.md` (implemented), `agent-managed-skills.md`

> A ship-coupled RFC against the Job Spec. The Job Spec is the durable home
> of the job; this is one effort against it. Solution shape, not solution.

## TL;DR

1. **The job:** when an agent learns a better way, make it stick reliably
   without re-teaching, and without skill/cron sprawl.
2. **Success:** corrections stop recurring; small skill fixes self-apply
   invisibly and reversibly; new skills/crons always come to the operator as
   a one-tap suggestion.
3. **Biggest constraint:** ships opt-out (no flag, no phases), costs
   ~nothing on idle turns (gate-first), and never auto-creates a cron/new
   skill or any irreversible change.

## The Job

> **When** an agent is corrected or finds a path it will reuse, **the
> operator wants** that lesson to bind on every future run, **so they can**
> stop re-teaching the fleet without it sprawling skills and crons.

Durable home: [Job Spec](../jobs/get-better-the-longer-they-run.md). Serves
`standing-team`; governed by `hold-the-leash`.

## How Users Fail Today

1. **The directive that never binds** — operator gives an "always do X"
   rule; it lands as a Hindsight directive, which only steers `reflect` and
   never fires inside the cron/skill where the action runs. Operator
   re-corrects or hand-edits the cron. *Evidence:* 2026-06-20, the
   email-dedup rule had to be moved into both email crons by hand.
2. **Sprawl fear blocks codification** — a behaviour should be codified, but
   with no bounded path the agent (or operator) avoids it for fear of
   skill/cron sprawl; the mistake recurs.
3. **All-or-nothing autonomy** — the only options are "do nothing" or "let
   it write skills/crons freely"; the safe-but-useless default wins.

## User Success / Failure Modes

**Success:** repeat-correction rate → ~0; agent-authored small fixes land
without operator action; operator describes the fleet as "it learns," not "I
keep re-teaching it"; fewer interventions per agent-week.

**Failure to watch:**
- *Soft:* improves but costs more than it saves (review not gate-first).
- *Silent:* a learned "fix" quietly degrades behaviour (no eval gate).
- *Adoption:* operators disable it (suggestion fatigue / sprawl).

## Guardrails

- **Opt-out, never opt-in or flagged.** Ships on by default for all agents;
  rollback is per-agent disable.
- **Determinism-first.** Route every rule to the strongest binding layer its
  decidability allows: hook/schema > skill/cron prompt > agent-guidance
  (`CLAUDE.md`/`SOUL.md`) > Hindsight directive (reflect-only, last resort).
  Prefer a skill/cron/hook over guidance whenever a rule belongs to one
  surface; reserve guidance for genuinely cross-cutting behaviour, or it all
  drifts into `CLAUDE.md` and nothing binds hard.
- **Smart defaults, opt-in complexity.** Default is do-nothing or a tiny safe
  edit; anything heavier is the operator's call.
- **On-leash / no-self-escalation (invariants, kill-clause).** No autonomous
  cron creation, new-skill creation, cross-agent change, or irreversible
  change. Secrets via vault only. Every autonomous change reversible +
  audited.
- **Performance.** Idle turns incur ~no extra tokens/latency (gate-first;
  review forked/async, off the user's reply path).

**Out of scope:** fine-tuning; fleet-wide autonomous promotion without human
review; the domain skills themselves (consumers, not part of this).

## Solution Space

### Two detection modes — separate reviews

The job has two distinct triggers, and they run as **separate review passes**,
not one:

1. **Correction gate — reactive, per-turn, deterministic.** At turn end a cheap
   signal check asks "was a lesson forced this turn?" (an operator correction, a
   repeated manual fix, a directive that didn't bind). It fires the forked
   review only on a hit; idle turns cost ~nothing. This is the "correct once,
   never again" path.
2. **Recurring-work review — proactive, periodic, cadenced.** On a low cadence
   (not per-turn) a separate pass runs `reflect` over the agent's own Hindsight
   experience memories — "what multi-step thing have I repeated by hand that no
   skill/cron covers?" A genuine, deduplicated hit (≈3–5×, checked against
   existing skills/crons, prefer-extend-over-create) becomes a **T3 proposal**
   for a new skill or cron — never an auto-create. This is the "finds a path it
   will reuse" path.

Same router and same guardrails downstream; different triggers and cadences
upstream. Keeping them separate is what stops the proactive scan from taxing
every turn.

**MUST:**
- Classify each candidate change by blast radius, graduated autonomy:
  - **T0 Nothing** (most turns; cadence-gated so the review rarely runs).
  - **T1 Auto, silent** — only a small, reversible, eval-passing edit to a
    skill the agent already owns. Native `Write`/`Edit` into the agent's
    skills dir (per `skill-authoring-native`); validator hook + git =
    audit/rollback.
  - **T2 Propose, one-tap** — medium / shared-skill changes, **and any edit to
    the agent's own guidance (`CLAUDE.md` / `SOUL.md`)** — because guidance
    affects *every* turn, even a small guidance edit is proposed, never silent.
    Surfaced as a pending suggestion (Telegram one-tap; backing store = Linear
    issue or a small per-agent queue file).
  - **T3 Ask explicitly** — new cron, new skill, cross-agent, or
    irreversible: operator decides. Fleet-wide sharing = reviewed PR
    (bundled-default opt-out / `skills:` cascade), per the existing decision.
- Be **gate-first**: a cheap per-turn triage decides whether the expensive
  review runs at all.
- Run the review **forked, async, restricted toolset** (memory + skill
  tools only).
- Gate every apply (incl. T1) behind a **per-skill eval** before it lands.

**MUST NOT:** run a full review every turn; auto-create crons/new skills;
apply irreversible/cross-agent changes; surface low-value suggestions; hide
changes.

**Free to vary:** triage signal (deterministic vs tiny model call); cadence
/ threshold / diff-size / queue-cap values; the T2/T3 pending surface
backing.

## Per-skill eval (reuses `skill-creator`)

No new eval engine. Each skill carries `evals/evals.json` (a few test-case
prompts). A **grader subagent** (`agents/grader.md`, runnable on a cheap
model — this is the "small model call") checks assertions → pass/fail +
evidence; `scripts/aggregate_benchmark.py` gives pass-rate + variance (mean ±
stddev) vs baseline. **An edit lands only if its evals pass and don't
regress baseline.** New skills ship a starter `evals.json` at creation.
Objective checks = scripted assertions; subjective = the LLM-judge grader.

## Promotion store (simple + reliable: there isn't one)

switchroom already decided this in `skill-authoring-native` (implemented):
the runtime `skill_publish` broker was removed because **PR review is the
stronger and simpler gate** for code every agent runs. So:

- **Own-skill edit (T1):** native `Write`/`Edit` into the agent's skills
  dir; the existing non-blocking validator hook + git history are the audit
  and rollback. No store.
- **Fleet-wide (T3):** a reviewed PR (bundled-default opt-out / `skills:`
  cascade). Git + PR is the store.
- **Only new state:** a tiny per-agent pending-suggestions surface for the
  T2/T3 one-tap proposals (Linear issue or a small queue file), not a new
  broker.

Net: git + PR + the validator hook that already exists.

## Evidence

- Internal: the email-dedup directive that wouldn't bind (2026-06-20).
- OpenClaw (`github.com/openclaw/openclaw`): Skill Workshop proposal
  lifecycle, approval-on, hash-bind, rollback. Considered; superseded for our
  case by the PR-as-gate decision already in `skill-authoring-native`.
- Hermes (`github.com/NousResearch/hermes-agent` + `…-self-evolution`):
  forked post-turn `background_review` (restricted toolset, cadence-gated)
  and GEPA trace-driven eval — the patterns behind the forked review and the
  per-skill eval gate.

## Bets & Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Review runs too often → cost tax | Med | High | Gate-first triage; cadence cap; forked/async |
| Suggestion fatigue | Med | High | High surface bar; default silence; measure ignore-rate |
| Skill/cron sprawl | Med | High | T3 gating; prefer-update-over-create; dedup check; eval gate |
| Bad auto-edit lands | Low | High | Eval gate on every apply; git rollback; audit |

## Rollout

**All agents, opt-out, no phases, no flag.** On by default; rollback is
per-agent disable. Conservatism comes from the tiers, not a staged audience.

**Both detection modes ship**, but the correction gate (per-turn, deterministic)
lands first and proves the loop; the recurring-work review (periodic, cadenced)
follows as the second pass. Targets covered at rollout: own skills (T1 auto /
T2 propose), agent guidance (T2 propose), crons and new skills (T3,
propose-only). Guidance, cron, and new-skill changes are never auto-applied.

**Instrumentation before merge:**
- [ ] tokens-on-review vs repeat-corrections-avoided
- [ ] suggestion accept/ignore rate; pending-queue depth (split by target:
      skill / guidance / cron / new-skill)
- [ ] recurring-work review: proposals raised vs accepted; duplicate-proposal rate
- [ ] alert: idle-turn cost crosses threshold; bad-apply / rollback fires

## Open Questions

- [x] Gate-first triage: **deterministic signals** for the correction gate
      (decided 2026-06-20); a small-model escalation is a later option, not the
      first slice.
- [ ] Starting defaults: correction-gate threshold (2 vs 3), diff-size cap,
      max pending/auto-applies per day, **recurring-work review cadence** (every
      ~N turns vs weekly) and its repeat bar (3 vs 5) — tuned by measuring on
      `clerk` first.
- [x] T2/T3 pending surface: **per-agent JSON-lines queue file** for the first
      slice (decided 2026-06-20); Telegram one-tap surfacing layered on next.

## Related

- [Job Spec](../jobs/get-better-the-longer-they-run.md)
- [`skill-authoring-native.md`](./skill-authoring-native.md) — the authoring + PR-sharing base
- [`agent-managed-skills.md`](./agent-managed-skills.md)
- [product-spec.md](../product-spec.md) — outcome `standing-team`
- [principles.md](../principles.md), [invariants.md](../invariants.md)

**Last Updated:** 2026-06-20
