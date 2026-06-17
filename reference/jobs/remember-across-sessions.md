---
job: remember across sessions without being re-told
outcome: The agent brings back relevant facts, preferences, decisions, and open threads from past conversations, in the right moment, without the user reminding it.
stakes: An agent with no memory is a stranger every time. The user stops sharing context because they're tired of repeating it. The relationship never compounds.
serves: standing-team
invariants: [single-tenant]
---

# Job Spec: remember across sessions without being re-told

## The job

The user said something last Tuesday that matters today. They told the agent
months ago how they like things done. They started a thread that never got
closed. A goldfish agent forces the user to repeat all of it, so they stop
trying. The job is to make the agent remember in a way that helps — not in a
way that's creepy or noisy. Memory is not a chat log: dumping the last
thousand messages into the prompt is neither remembering nor useful. Good
memory is curated, semantic, and retrieved by relevance — the schedule note
surfaces when planning the week, not when writing code. Memory is also
honest: when the agent recalls something, the user can see that it did,
trust why, and correct it if it's wrong. Memory the user can't inspect is
memory the user won't trust.

## Good / bad

**Good looks like**

- The agent brings back a detail from a past conversation at the right
  moment, without being prompted for it.
- What comes back is relevant, not a grab-bag; most of what's recalled is
  useful.
- The user corrects a stored fact and the correction sticks; the agent
  doesn't reassert the old version later.
- Preferences and rules set once stay respected across sessions without
  re-stating.
- A restart, a compaction, or a new chat window doesn't reset the
  relationship; the agent picks up roughly where it was.
- The user can ask what the agent believes about them and why, and get an
  honest, legible answer.
- Each agent's memory is its own — different specialists, topics, and the
  single user are never conflated into one pool.

**Bad looks like — never ship this**

- Raw transcript dumping passed off as memory; that's storage, not
  remembering.
- Regurgitating old facts unprompted, out of context, just to prove it
  remembered.
- Silent forgetting: an old rule quietly stops being applied with no way
  for the user to tell.
- Memory the user cannot inspect, correct, or delete.
- Per-session memory that resets every chat window; the user is not a
  different person each time.
- Conflating different topics or different specialists into one
  undifferentiated memory pool.
- Treating every retained memory as equally weighted, with no sense of what
  mattered and what was small talk.

## Prove it

- **Survives restart (DM)** — `jtbd-memory-survives-restart-dm`. *Watch:* a
  fact stated before a restart is recalled after it, without re-telling.
  *Invariant:* a restart or new window never resets the relationship.
- **Honest, legible recall** — `tests/cli.memory.recall-log.test.ts`,
  `tests/memory.user-profile.test.ts`. *Watch:* the user can see what was
  recalled and why; the profile reflects what the agent believes.
  *Invariant:* nothing is recalled from a black box the user can't inspect.
- **Correction sticks / decays sensibly** — `tests/cli.memory.demote.test.ts`,
  `tests/memory.add-memory-tag.test.ts`. *Watch:* a corrected or demoted
  memory stops surfacing in recall. *Invariant:* a correction the user makes
  is honoured and not silently reverted.
- **Per-agent banks, no pooling** — `tests/memory.create-bank.test.ts`,
  `tests/memory.bank-missions.test.ts`. *Watch:* each specialist recalls
  only its own bank. *Invariant:* topics and specialists are never conflated
  into one memory pool (`single-tenant`).
- **Relevant, not exhaustive recall (DM)** — *(coverage gap: no runnable
  scenario yet)*. *Watch:* a query touching several past threads brings back
  the few useful ones, not a grab-bag. *Invariant:* recall is ranked by
  relevance, not dumped.

**Fuzz corpus:** vary elapsed time × topic overlap × correction-then-recall
× restart/compaction × number of competing memories; relevance, honesty,
correction-stickiness, and per-bank isolation hold across all.

## Verdict

- **Done when:** the agent brings back the right context at the right moment
  without being re-told, the user can inspect and correct what it believes,
  and a restart never resets the relationship — proven by the scenarios
  above.

## Production-readiness

- *Durability:* recalled context survives restart, compaction, and new chat
  windows.
- *Inspectability:* every recall is attributable; the user can see, correct,
  and demote what the agent stores.
