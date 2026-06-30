---
job: When my agent learns a better way to work, make the improvement stick reliably without me re-teaching it, and without it sprawling skills, crons, or its own guidance
outcome: Agents stop repeating corrected mistakes; small fixes to their own skills happen invisibly and reversibly; anything larger arrives as a one-tap suggestion
stakes: Get it wrong and we lose either way. Nothing improves (recurring corrections, trust leaks) or it runs away (token waste, unreviewable skill/cron sprawl, unsafe changes)
serves: standing-team
invariants: [no-self-escalation, on-leash]
---

# Job Spec: agents get better the longer they run

> The durable, per-job outcome contract. Read by a human (judging a change)
> and an agent (deciding what to do mid-task). Outcome-oriented, never
> tech-specific: the review loop, the tiers, the eval harness can all change
> underneath it while the job stays still.

## The job

When an agent is corrected, or finds a path it will reuse, the operator
wants that lesson to bind on every future run without re-teaching it, and
without the agent treating "I learned something" as licence to manufacture
skills and crons. The job is reliable, bounded self-improvement, not
autonomy. It ladders to `standing-team` (a team that knows you and gets
better); it is held inside the `hold-the-leash` invariants, so the agent
improves without ever roaming.

Builds on the implemented `skill-authoring-native` RFC (agents already author
their own skills via `skill-creator` + `Write`/`Edit`; fleet sharing is a
reviewed PR). This job adds *when* to do it and *how far* to go alone.

## Good / bad

**Good looks like**

- A correction given once never has to be given again.
- A small, safe fix to the agent's own existing skill just happens, silently
  and reversibly.
- A bigger change (a shared skill, or an edit to the agent's own guidance
  `CLAUDE.md`/`SOUL.md` that touches every turn) arrives as one one-tap
  suggestion.
- A new cron or new skill is always proposed, never self-served.
- Idle turns cost ~nothing; the operator never waits on the review.

**Bad looks like: never ship this**

- The same correction needed a second time.
- Skill or cron sprawl; duplicate skills; an unreviewable pile of proposals.
- A "want me to tweak this?" ping on turns that didn't warrant it.
- An agent silently standing up a cron or editing a shared skill.
- A turn that doubles in cost because a full review ran when nothing changed.

## Prove it

- **Correct-once × any agent** — *(coverage gap: no runnable scenario yet)*.
  *Watch:* a repeated correction triggers a bounded skill fix; the mistake
  does not recur. *Invariant:* reversible + audited.
- **Anti-sprawl × cron/skill creation** — *(coverage gap)*. *Watch:* agent
  proposes, never auto-creates, a cron/new skill. *Invariant:* on-leash
  (operator-gated).
- **Cost × idle turn** — *(coverage gap)*. *Watch:* a turn with no learning
  signal incurs ~no extra tokens/latency. *Invariant:* gate-first.

**Fuzz corpus:** vary correction-frequency × change-size × blast-radius ×
reversibility × eval-confidence; the invariants hold across the corpus, not
just the happy path.

## Verdict

- **Done when:** after a repeated correction an agent auto-applies a small,
  tested, reversible fix to its own skill (or proposes anything larger) with
  no operator re-teaching, and never auto-creates a cron/new skill or any
  irreversible/cross-agent change.

## Production-readiness

- *Change safety:* the agent edits its own state, so every auto-applied fix
  is reversible and audited. A self-improvement that can't be rolled back, or
  that lands without a trail, is a defect, not a feature with a rough edge.
- *Blast-radius gating:* the size of the change decides who approves it. A
  small fix to the agent's own skill self-serves; anything that touches every
  turn (`CLAUDE.md`/`SOUL.md`), crosses agents (a shared skill), or stands up
  a cron is operator-gated. The agent never widens its own reach under cover
  of "I learned something". The `no-self-escalation` and `on-leash`
  invariants hold here, not just on the happy path.
- *Learning integrity:* a bad lesson must not bind. A correction that turns
  into a regression is caught and reverted rather than compounding across
  runs, and the same correction never has to be given twice.
- *Cost bounding:* the review is gate-first. An idle turn with no learning
  signal incurs ~no extra tokens or latency, so the mechanism can run on
  every turn without the operator paying for it on turns that didn't change
  anything.

---

> **Implementation:** the how lives in `reference/rfcs/agent-self-improvement.md`
> (frontmatter `serves:` this job). That artifact churns; this Job Spec
> outlives it.
