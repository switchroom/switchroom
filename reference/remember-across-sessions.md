---
job: remember across sessions without being re-told
outcome: The agent brings back relevant facts, preferences, decisions, and open threads from past conversations, in the right moment, without the user reminding it.
stakes: An agent with no memory is a stranger every time. The user stops sharing context because they're tired of repeating it. The relationship never compounds.
---

# The job

The user said something last Tuesday that matters today. They told the
agent months ago how they like things done. They started a thread that
never got closed. A goldfish agent forces the user to keep repeating all
of that, which means they stop trying. The job is to make the agent
remember in a way that helps, not in a way that's creepy or noisy.

Memory is not a chat log. Dumping the last thousand messages into the
prompt is neither remembering nor useful. Good memory is curated,
semantic, and retrieved by relevance. What the user said about their
schedule surfaces when the agent is planning their week, not when
they're writing code. The system decides what's worth keeping and
what's worth pulling back, and the bar for both is high.

Memory is also honest. When the agent recalls something, the user should
be able to see that it did, trust why, and correct it if it's wrong.
Memory the user can't inspect is memory the user won't trust.

## Signs it's working

- The agent brings back a detail from a past conversation at the right
  moment, without the user prompting for it.
- What comes back is relevant, not a grab-bag. If the agent recalls five
  things, four of them should be useful.
- The user can correct a stored fact, and the correction sticks. The
  agent doesn't reassert the old version later.
- Preferences and rules the user set once stay respected across sessions
  without re-stating.
- A restart, a compaction, or a new chat window doesn't reset the
  relationship. The agent picks up roughly where it was.
- The user can see what the agent believes about them and why. Nothing
  is hidden in a black box.
- Memory decays sensibly. Stale preferences don't haunt the user a year
  later.

## Anti-patterns: don't build this

- Raw transcript dumping as "memory." That's storage, not remembering.
- Regurgitating old facts unprompted, out of context, just to prove
  the agent remembered. That's noise.
- Silent forgetting. If an old rule stopped being applied, the user
  should be able to tell.
- Memory the user cannot inspect, correct, or delete.
- Per-session memory that resets every chat window. The user is not
  a different person every time.
- Conflating different users, different topics, or different specialists
  into one undifferentiated memory pool.
- Treating every retained memory as equally weighted. The agent needs
  a sense of what matters and what was small talk.

## UAT prompts

- **Return after a break.** Come back a week later and resume a thread.
  The agent should not need a re-briefing.
- **Preference stickiness.** State a preference once. Weeks later, in
  an unrelated context where that preference applies, the agent should
  honour it without being reminded.
- **Correction.** Tell the agent something it believes is wrong. Later,
  check it didn't revert.
- **Relevance test.** Ask something where two or three past conversations
  are relevant. What comes back should be useful, not exhaustive.
- **Inspection.** Ask the agent what it knows about a topic or about the
  user. The answer should be honest and legible.
- **Deletion.** Tell the agent to forget something. Confirm it's gone.
- **Cross-session continuity.** Close the session, restart it, pick up
  a live thread. It should still be alive, not reset.
