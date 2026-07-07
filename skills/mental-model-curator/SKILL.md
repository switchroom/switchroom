---
name: mental-model-curator
description: >
  Review the agent's OWN Hindsight memory bank with the most capable model and
  PROPOSE well-formed mental models ("knowledge models") to the operator via the
  approve/deny proposal card, instead of blindly creating them. Use to curate,
  seed, or audit the standing models the agent maintains over its specialty.
  Triggers on phrasings like: "curate mental models", "propose knowledge models",
  "review my memory bank", "what standing models should I have", "bootstrap
  mental models", "suggest mental models from my bank", "audit my mental models",
  "what recurring questions do I keep re-deriving", and typos like "propose
  knowlege models". Do NOT use for storing a single fact/preference/decision —
  that is retain, not a mental model. Do NOT use for identity or "who is the
  user" — that lives in profile banks, so never propose an identity model here
  (the operator's review of the card, not any code guard, is the only gate — so
  it's on you to honor).
  Even when the operator directly asks you to CREATE one specific named model
  whose shape you know, PROPOSE it through the approve/deny card — never call
  create_mental_model directly (it is not pre-approved; the propose card is the
  only sanctioned write path, Fix 1.2 / #2903).
allowed-tools: mcp__hindsight__list_banks mcp__hindsight__get_bank_stats mcp__hindsight__list_mental_models mcp__hindsight__get_mental_model mcp__hindsight__reflect mcp__hindsight__recall mcp__switchroom-telegram__mental_model_propose
---

# mental-model-curator — Propose standing knowledge models from your own bank

A **mental model** in Hindsight is a pre-computed semantic summary backed by
reflection over the memory bank — a standing answer to a recurring DOMAIN
question the agent keeps re-deriving (e.g. a coach's "current training plan,
recent sessions, and open adjustments"). This skill's job is to use your most
capable model to survey your OWN bank and PROPOSE a few well-earned models to
the operator through the approve/deny card — never to bulk-create noise.

You cannot self-approve. Every proposal renders a card the operator taps. Your
job is to make each proposal so obviously right that a glance is enough.

## Why propose instead of create

You do NOT have direct `create_mental_model` access — it is deliberately not
pre-approved (Fix 1.2 / #2903). Every mental-model write routes through
`mcp__switchroom-telegram__mental_model_propose`, because a
standing model is a persistent, always-in-context artifact with real cost
(recall/reflect spend, and — if `refresh_after_consolidation` is on — invisible
post-consolidation spend). A human should decide which of those the agent runs.
Bulk self-creation is how banks fill with overlapping, stale, or wrong-fact
models. Propose the few that are earned; let the operator ratify.

## Modes

- **Propose mode (default):** run the full workflow and fire proposal cards, one
  at a time, up to the rate limit.
- **Dry-run / preview mode:** when the user says "preview", "dry run", "just
  show me the candidates", "what would you propose", or you're testing against an
  unfamiliar bank — run steps 1–4, then OUTPUT the ranked candidate list as text
  (name + source_query + one-line reason) and STOP. Do NOT call
  `mental_model_propose` in this mode. This is the safe way to run against any
  bank.

## Workflow

### 1. Identify the bank and check it's worth analyzing

Resolve the session's bank (`mcp__hindsight__list_banks`, or the bank bound to
this agent's session). Then pull `mcp__hindsight__get_bank_stats`.

If the bank is **empty or thin**, STOP and report "not enough content to
synthesize models yet — the bank needs more accumulated memories before standing
models are meaningful." Synthesizing over an empty or thin bank produces
confident noise: models with no grounding that read as authoritative. A handful
of memories is not a domain. Do not propose against a thin bank, even in dry-run.

### 2. Read what already exists (dedupe)

Call `mcp__hindsight__list_mental_models`, and `get_mental_model` on each to read
its `source_query`. Build a dedupe set of the questions already covered.

The propose flow hard-rejects an EXACT-name duplicate before a card posts, but
that is not enough — a near-duplicate under a fresh name is still waste. You must
**semantically** dedupe: if a candidate's source_query asks substantially the
same thing as an existing model (even reworded), drop it. Only propose genuinely
new coverage.

### 3. Survey recurring themes

Use `mcp__hindsight__reflect` and `mcp__hindsight__recall` to find the DOMAIN
questions this agent keeps re-deriving — the standing state of its specialty.
Good prompts: "What questions do I repeatedly answer from scratch?", "What are
the recurring themes in this bank?", "What standing state would I want summarized
before every relevant turn?" Cluster the answers into candidate standing
questions. Each cluster must be backed by memories the bank ACTUALLY holds — if
you can't point to the underlying content, it's not a candidate.

### 4. Frame each candidate correctly

- **`source_query` must be a DOMAIN question**, never an identity / "who is the
  user" question. Identity lives in dedicated profile banks; never propose an
  identity-based model — the operator, not the platform, is the only gate, so
  this is on you to honor (one previously caused a wrong-fact contradiction bug).
  If a candidate is really "facts about the user", discard it.
- **`refresh_after_consolidation` defaults OFF.** Only set it true when the model
  genuinely tracks fast-moving state that must be current the moment memory
  consolidates. It adds invisible post-consolidation spend and timeout risk, so
  the default answer is off.
- **Keep models tight.** recall/reflect tiers cap around ~1024 tokens; a model
  that tries to summarize everything summarizes nothing. Set a modest `max_tokens`
  if the default would overrun. Narrow, answerable source_queries beat broad ones.
- **Few models per bank.** Each must be earned by content the bank holds. Quality
  over quantity — a bank with three sharp models beats one with ten vague ones.

### 5. Propose within limits

Rank the surviving candidates by how much re-derivation they save and how well
the bank supports them. Propose only the **top few**.

**HARD LIMIT: 5 proposal cards per hour per agent (sliding window).** Batch and
prioritize — never fire one card per cluster. If you have more than 5 worthwhile
candidates, propose the best 5 and mention the rest in text for a later pass.

Propose **one at a time**:

```
mcp__switchroom-telegram__mental_model_propose(
  chat_id=<the current chat_id>,
  name=<slug>,
  source_query=<the domain question>,
  reason=<CRISP one line — the operator sees this on the card and denies vague ones>,
  ...  # refresh_after_consolidation / max_tokens only when justified above
)
```

The `reason` is load-bearing: it's the one line the operator reads before
tapping. "Tracks the athlete's current plan + open adjustments so I stop
rebuilding it each session" earns a tap; "useful model" gets denied.

After firing a card, **END THE TURN CLEANLY.** The flow resumes on its own via a
synthetic inbound (`mental_model_proposal_applied` / `mental_model_proposal_denied`)
when the operator taps. Do not loop, do not poll, do not fire the next card in the
same turn. You cannot self-approve — that's by design.

### 6. Scheduled-sweep note (future extension)

Unattended cron proposing is **NOT supported today.** `mental_model_propose`
needs a live turn with an operator present to tap the card — firing cards into an
empty topic at 3am is useless and noisy. If invoked from a scheduled sweep,
**STAGE** the ranked candidates (retain them, or hold them) and surface them on
the next interactive turn instead of firing cards unattended. Treat live-turn,
operator-present proposing as the only supported path for now.

## Anti-patterns

- ❌ Proposing against an empty or thin bank — synthesizes to noise.
- ❌ An identity / "who is the user" source_query — forbidden; profile banks own that.
- ❌ Ten near-duplicate models under different names — semantically dedupe first.
- ❌ Firing a card per cluster — respect the 5/hour limit; propose the top few.
- ❌ `refresh_after_consolidation: true` by default — it's an invisible cost; leave it off unless the model tracks fast-moving state.
- ❌ A vague `reason` — the operator denies it and you've burned a slot.
- ❌ Looping/polling after a proposal — end the turn; the resume inbound wakes you.

## Output

In propose mode: a short line naming what you proposed and that the operator's
tap will resume the flow. In dry-run mode: the ranked candidate list (name +
source_query + reason) and nothing fired.
