---
job: surface the fleet's own recurring failures ranked by impact, so the operator spends attention only on the worst issues instead of auditing everything
outcome: The fleet detects, ranks, and tracks its own recurring failures against the jobs it is supposed to do. The operator sees the worst-affecting issues first — with frequency, evidence, and a GitHub issue for the work — and never has to hand-audit turns to find what is quietly breaking.
stakes: A standing fleet of always-on specialists fails silently. An agent writes answers as plain text and never calls the reply tool; the gateway's safety net delivers them 2-4 minutes late for weeks and no one notices. Without a way for the fleet to surface its own recurring failures, the operator either audits every turn by hand (impossible at fleet scale) or learns about the breakage from a principal complaining. Either way trust leaks a turn at a time, and the "always-on" promise quietly rots underneath.
serves: always-available
invariants: [chat-is-the-single-source-of-truth, no-self-escalation, on-leash, single-tenant]
---

# Job Spec: the fleet stays healthy

> The durable, per-job outcome contract. Read by a human (judging a change)
> and an agent (deciding what to do mid-task). Outcome-oriented, never
> tech-specific: the detector layers, the ledger shape, the priority
> formula can all change underneath it while the job stays still.

## The job

The fleet does 22 jobs (`reference/jobs/*.md`). Each is a JTBD an agent
can quietly fail at — a silent no-op, a late delivery, a duplicate send, a
missed trigger — in a way that never raises an error and so never reaches
the operator. The operator wants the fleet to **watch itself against those
jobs**, rank the recurring failures by how much they actually hurt, and put
the worst ones in front of the operator with the evidence attached and a
GitHub issue tracking the fix. The operator's scarce resource is attention;
this job spends it only on the issues with the largest blast radius.

It ladders to `always-available` (a fleet that stays up and *stays correct*,
not just alive), and it sits beside `see-my-whole-fleet-from-one-screen`
(that job is the operator's live glance across the fleet; this one is the
fleet's standing, ranked record of what is *recurringly broken*). It is held
inside `chat-is-the-single-source-of-truth` (the admin page is an operator
surface, not a parallel principal channel), `no-self-escalation` and
`on-leash` (the detection runs as operator-set schedules on an
operator-assigned agent, never a self-authored loop), and `single-tenant`
(it reads this one deployment's own state).

**Distinct from `get-better-the-longer-they-run.md`.** That job is
*agent-facing*: an agent codifies a lesson into its own skill so it stops
repeating a correction. This job is *operator-facing*: the fleet surfaces its
own recurring failures, ranked by impact, into an operator-visible tracker so
the operator decides what gets fixed. One improves an agent's own behaviour
silently; the other gives the operator a triage queue over the whole fleet.

## Good / bad

**Good looks like**

- A recurring failure (e.g. an agent never calling the reply tool, so the
  gateway delivers late) is detected from the fleet's own logs, without a
  principal reporting it and without the operator auditing turns.
- The operator opens one page and sees the 22 jobs ranked worst-first by a
  priority score that reflects real impact (how bad × how often × how many
  agents × how recently), not raw event counts.
- Each issue carries its evidence — the exact turns (by turn id) and log
  pointers — and links to a GitHub issue that tracks both the identification
  and the resolution.
- Detection is cheap: a nightly model-free sensor updates every job's counts
  at zero token cost; expensive deep reasoning runs only on the top one or
  two issues by score, on a budget.
- A fix is self-verifying: after it lands, the sensor's count for that issue
  drops (e.g. 282 → ~2) and the GitHub issue closes on the verified drop.

> [!CAUTION]
> The detection runs only as operator-set schedules on an operator-assigned
> owner agent, and its expensive layers are model-free-gated. An agent that
> stood up its own polling loop to "watch the fleet", or that ran an Opus
> deep-dive on every job every night, would break `on-leash` (a self-authored
> loop) and `crons-use-the-model-only-when-it-earns-it` (spending the model
> where a model-free filter would do). The admin page is an operator surface;
> it must never become a second principal channel or a parallel status mirror
> (`chat-is-the-single-source-of-truth`).

**Bad looks like: never ship this**

- A recurring failure only surfaces when a principal complains.
- The page ranks by raw event count, so a noisy-but-harmless signal buries a
  rare-but-severe one.
- An issue with no evidence — a number with no turn ids or log pointers, so
  the operator still has to go dig.
- Every job gets an Opus deep-dive every night (token burn) or the sensor
  itself needs a model to run (should be zero-token).
- A fixed issue stays "open" forever because nothing verifies the count drop
  and closes it.
- The detector opens a fresh duplicate GitHub issue for the same problem
  every night instead of updating the existing one.

## Prove it

- **Detect × silent-late-delivery** — *(validated end-to-end 2026-07,
  coverage gap: no runnable UAT yet)*. *Watch:* the model-free sensor flags
  agents that never call the reply tool (the represent-safety-net signature)
  and ranks the issue by impact; a deep-dive root-causes it from the
  transcript. *Invariant:* zero-token sensor, model-free-gated deep-dive.
- **Rank × severity-over-frequency** — *(coverage gap)*. *Watch:* a
  rare-but-severe issue outranks a frequent-but-cosmetic one because the
  priority score weights severity and reach, not just count. *Invariant:*
  the page reads the ledger; no principal channel.
- **Close × verified-count-drop** — *(coverage gap)*. *Watch:* after a fix,
  the sensor's count for the issue drops and its GitHub issue closes on the
  drop, not on a self-report. *Invariant:* hard-artifact evidence over
  self-report.

**Fuzz corpus:** vary failure-mode × frequency × agent-count × severity ×
recency; the ranking puts the highest-impact issue first across the corpus,
not just the happy path, and the sensor stays model-free across it.

## Verdict

- **Done when:** the fleet detects a recurring per-job failure from its own
  state at zero token cost, ranks it by real impact on an operator page with
  evidence attached, tracks identification and resolution in a GitHub issue,
  runs its expensive reasoning only on the top issues on a budget, and closes
  the issue on a verified count-drop — all as operator-set schedules on an
  operator-assigned agent, crossing no invariant.

## Production-readiness

- *Evidence integrity:* a flagged issue must carry hard artifacts (turn ids,
  log pointers) the operator can independently verify, not a model's
  self-report. A "detection" that can't be checked against the fleet's own
  logs is a guess, not a signal.
- *Cost bounding:* the sensor that touches all 22 jobs every night is
  model-free (zero tokens); the model spend is gated behind it and budgeted
  to the top one or two issues by score. The mechanism can run nightly on the
  whole fleet without the operator paying a reasoning turn per job — the same
  gate-first discipline as `crons-use-the-model-only-when-it-earns-it`.
- *Attribution:* the detection work runs on a named, operator-assigned owner
  agent so every scan and deep-dive is attributable and on-leash, never a
  self-authored loop on some arbitrary agent.
- *Self-verification:* a fix is proven by the fleet's own numbers. The issue
  closes when the sensor's count for it drops, so the tracker can't fill with
  stale "fixed" issues that never actually recovered.
- *Surface discipline:* the ranked view lives on the operator admin page, not
  in a principal's Telegram thread and not as a parallel pinned status mirror.
  It is operator tooling (like the fleet dashboard), so `telegram-and-buzz-only` and
  `chat-is-the-single-source-of-truth` hold.

## Related

- [`see-my-whole-fleet-from-one-screen`](see-my-whole-fleet-from-one-screen.md) --
  the operator surface the ranked health view lives beside.
- [`crons-use-the-model-only-when-it-earns-it`](crons-use-the-model-only-when-it-earns-it.md) --
  the gate-first cost discipline the nightly sensor inherits.
- [`know-what-my-agent-is-doing`](know-what-my-agent-is-doing.md) -- per-turn
  visibility; this job is its fleet-wide, over-time counterpart.

---

> **Implementation:** the how lives in `reference/rfcs/fleet-health.md`
> (frontmatter `serves:` this job). That artifact churns; this Job Spec
> outlives it.
