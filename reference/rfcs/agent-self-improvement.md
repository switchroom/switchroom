---
artifact: agents that improve themselves, on the leash
serves: get-better-the-longer-they-run
advances-outcome: standing-team
status: Draft — slices 1–2 implemented; eval gate built-but-dormant (amended 2026-08-05)
---

# RFC: Agents that improve themselves, on the leash

Status: Draft — correction gate, tier router, apply-guard, eval gate, pending queue, and weekly skill-synthesis cron are IMPLEMENTED (`src/self-improve/*`, `src/cli/self-improve-*`). The eval gate has never fired: zero `evals/evals.json` exist anywhere in the tree, so every T1 downgrades to T2 in practice. See §"Amendment: corrections as eval cases" below.
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
   experience memories: "what multi-step thing have I repeated by hand that no
   skill/cron covers?" A genuine, deduplicated hit (≈3–5×, checked against
   existing skills/crons, prefer-extend-over-create) becomes a **T3 proposal**
   for a new skill or cron, never an auto-create. This is the "finds a path it
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
    audit/rollback. **Silent T1 apply is additionally gated behind an
    operator-set live-flag (default OFF): until the operator flips
    `SWITCHROOM_SELF_IMPROVE_T1_LIVE=1` for an agent, a fully verified T1
    still lands as a T2 one-tap proposal. Building the eval corpus and
    enabling silent apply are two separately-gated steps — never one.**
  - **T2 Propose, one-tap** — medium / shared-skill changes, **and any edit to
    the agent's own guidance (`CLAUDE.md` / `SOUL.md`)** because guidance
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
model, this is the "small model call") checks assertions → pass/fail +
evidence; `scripts/aggregate_benchmark.py` gives pass-rate + variance (mean ±
stddev) vs baseline. **An edit lands only if its evals pass and don't
regress baseline.** New skills ship a starter `evals.json` at creation.
Objective checks = scripted assertions; subjective = the LLM-judge grader.
The gate's enforcement code shipped (`src/self-improve/eval-gate.ts`,
`src/self-improve/apply-guard.ts`) but the corpus did not: no skill in the
tree carries `evals/evals.json`, so the gate is dormant. The corpus is grown
from operator corrections — see §"Amendment: corrections as eval cases".
Note: `skills/skill-creator/scripts/run_eval.py` (trigger-eval) shells
`claude -p` and is OUT OF SCOPE for the self-improve loop (claude-native
constraint); the apply path uses only the grader subagent + 
`aggregate_benchmark.py` over `grading.json` files.

## Amendment: corrections as eval cases (2026-08-05)

### The gap this closes

Every mechanism above is built and live EXCEPT the thing that feeds it:
`skillHasEvals()` (`src/self-improve/eval-gate.ts:43-54`) is a hard
precondition on T1 auto-apply (`src/self-improve/apply-guard.ts:328-336`),
and zero `evals/evals.json` files exist in the tree. The gate has never had
anything to gate; every review-loop T1 downgrades to T2 today.

The fix is Hermes/GEPA-shaped: **every operator correction is a labeled
failure case with the fix attached** — exactly the held-out eval seed the
gate is starving for. The forked review turn, on an `operator-correction`
signal, also records the correction as an eval case (skill-creator
`evals/evals.json` schema, `skills/skill-creator/references/schemas.md`)
targeted at the skill whose behaviour was corrected; corrections with no
skill home accrue to a per-agent held-out set
(`<stateDir>/eval-cases.jsonl`).

### Design invariants (adversarial-review hardened — binding on every slice)

These six came out of a skeptical red-team pass; they are invariants, not
preferences. A slice that violates one does not ship.

1. **Eval-case writes are one-tap (T2), never silent.** A self-authored
   eval case is the key that later authorizes silent T1 edits — letting the
   agent mint keys silently is self-escalation (`apply-guard.ts:1-11`,
   kill-clause `no-self-escalation`). Mechanically: the PreToolUse
   apply-guard recognises any Write/Edit touching `evals/evals.json` under
   an own skill and BLOCKS it with a T2 downgrade; the sanctioned path is a
   propose-only CLI (`switchroom self-improve add-eval-case`) that raises a
   one-tap card carrying the full case JSON, and the case is appended by
   deterministic code only after the operator tap.

2. **Growing the corpus and going T1-live are decoupled.** The moment a
   skill gains `evals.json`, `decideApply()` would otherwise start silently
   allowing eval-passing edits (`apply-guard.ts:391-399`). Therefore silent
   allow is gated behind `SWITCHROOM_SELF_IMPROVE_T1_LIVE` (default OFF —
   unset/`0` means a fully verified T1 still downgrades to a T2 proposal
   with reason "T1-live not enabled"). The corpus slice's win is strictly
   restrictive: **the gate can now BLOCK a regression.** "The gate can
   APPLY silently" is a later, separately-reviewed, operator-flipped step —
   and flipping it additionally requires the eval-integrity manifest check
   (invariant 3) to be in place.

3. **Additive-only is enforced at a Bash-proof point — and its guarantee
   level is stated honestly.** The apply-guard hook fires only on
   Write/Edit/MultiEdit (`src/cli/self-improve-apply-guard-pretool.ts:59,105`);
   the review turn retains Bash, so hook-level "existing cases stay
   byte-identical" checks are best-effort, Write-path-only. The load-bearing
   enforcement is out-of-band: (a) an **eval-integrity manifest**
   (`<stateDir>/eval-case-manifest.json`) records the sha256 of each
   skill's `evals.json` at every operator-approved append, and the T1
   allow leg of `decideApply()` verifies the on-disk hash against the
   manifest — any out-of-band mutation (Bash, sed, anything) makes the
   skill T1-ineligible until re-approved; (b) the per-turn Stop hook
   compares every own-skill `evals.json` against its manifest snapshot,
   reverts unauthorized diffs from the snapshot copy, and enqueues a T2
   pending note surfacing the tamper. Residual honesty: the state dir
   lives in the agent's own home, so this is tamper-EVIDENT and
   self-healing, not a cryptographic boundary — the hard backstop is that
   silent apply defaults OFF (invariant 2) and only an operator can flip it.

4. **Deterministic PII/secret scan on every eval-case write.** An eval case
   needs the real failing prompt — exactly where PII lives — persisted to a
   durable file. A prompt clause (as in
   `reference/prompts/skill-synthesis-cron.md:61-69`) is necessary but not
   sufficient. A code scan (`src/self-improve/pii-scan.ts`: email / phone /
   key-shape / private-key-block / high-entropy patterns) runs at propose
   time (reject with a named reason) AND again at approved-apply time
   (fail closed). The scan can false-negative; it cannot be skipped.

5. **Integration tests never touch a live agent.** Acceptance tests run
   hook binaries and CLIs against an ephemeral fixture agent (temp HOME +
   temp state dir), or a throwaway container agent — never `clerk` or any
   production agent (the config comments naming `clerk` at
   `src/self-improve/config.ts:3,37` are tuning notes, not a test target).

6. **Create/update parity (Hermes-shaped).** Failure-driven synthesis emits
   either a skill-EDIT proposal or a NEW-skill proposal, so a recurring
   failure with no existing home skill can still bind. New-skill-from-
   failure reuses the existing `synthesized-personal-skill` T2 carve-out
   (`src/self-improve/types.ts:87-96`, `src/self-improve/tier-router.ts:63-80`)
   — one-tap into the agent's own reversible workspace, hard-T3 floors
   untouched.

### What each correction produces

On an `operator-correction` signal, the forked review's contract
(`buildReviewPrompt()`, `src/self-improve/review-prompt.ts`) gains a step:
propose an eval case capturing (prompt ≈ the situation that went wrong,
expectations ≈ the corrected behaviour), via `add-eval-case` — never via a
direct write. Cases are deduplicated by normalized-prompt fingerprint.
The per-turn Stop hook also stamps a `self-improve:correction` tag on the
turn's Hindsight retain, so the failure-synthesis pass can find correction
turns without re-mining raw transcripts.

### Slice plan (each a focused single-concern PR)

1. **Slice 1 — the eval-case sink.** CLI + guard + manifest + Stop-hook
   integrity check + PII scan + review-prompt step. Makes the dormant gate
   able to BLOCK. Does NOT flip T1-live.
2. **Slice 2 — measurement surface + parity plumbing.** The
   `switchroom self-improve bench <skill>` CLI, and store/type support for
   failure-origin edit-or-create proposals. (Score-carrying proposal cards —
   a `benchmark` field on proposals, advisory and rendered on the card — are
   deferred to a future, tracked feature; the dead field was dropped in
   #4425 item 1 as it was never written or rendered.)
3. **Slice 3 — net-growth cap.** Env-tunable per-edit growth budget in
   `decideApply()`; breach downgrades to T2. Purely restrictive.
4. **Slice 4 — failure synthesis.** `self-improve:correction` retain tag
   (4a), then the weekly failure-synthesis cron (4b) as a sibling of the
   #2670 skill-synthesis cron: cluster ≥2-session recurring failures from
   on-disk transcripts, emit ≤1 edit-or-create proposal + eval cases,
   never directive-first.

T1-live flip is NOT a slice — it is a separate operator decision after the
corpus has demonstrably blocked at least one bad edit in the wild.

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
  and GEPA trace-driven eval: the patterns behind the forked review and the
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
      ~N turns vs weekly) and its repeat bar (3 vs 5), tuned by measuring on
      `clerk` first.
- [x] T2/T3 pending surface: **per-agent JSON-lines queue file** for the first
      slice (decided 2026-06-20); Telegram one-tap surfacing layered on next.

## Related

- [Job Spec](../jobs/get-better-the-longer-they-run.md)
- [`skill-authoring-native.md`](./skill-authoring-native.md) — the authoring + PR-sharing base
- [`agent-managed-skills.md`](./agent-managed-skills.md)
- [product-spec.md](../product-spec.md) — outcome `standing-team`
- [principles.md](../principles.md), [invariants.md](../invariants.md)

**Last Updated:** 2026-08-05
