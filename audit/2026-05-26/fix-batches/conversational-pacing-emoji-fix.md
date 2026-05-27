# Fix batch: correct the wrong emoji sequence in conversational-pacing.md and the agent prompt template

**Scope:** `reference/conversational-pacing.md` and `profiles/_shared/telegram-style.md.hbs`.
**Verdict pattern:** drift-major (1), drift-minor (2).
**Estimated edits:** small (~6 lines across 2 files).

## Findings in this batch

### Finding 1 -- artefact-conversational-pacing:c1

- **File:** `reference/conversational-pacing.md` L28; also `profiles/_shared/telegram-style.md.hbs` L20
- **Quote:** "The -> -> -> status reaction on the user's inbound message and a continuous `typing...` chat-action held for the whole turn"
- **Verdict:** drift-major
- **Proposed action:** update-text
- **Proposed text:** Replace `->->->` with `->->->` in the artefact table (L28). Same replacement needed in `profiles/_shared/telegram-style.md.hbs` L20.
- **Evidence:** `telegram-plugin/status-reactions.ts` L71 -- explicitly states " is reserved for genuine 5xx server errors (operator-events.ts). It reads as 'on fire / broken' -- keep it out of normal active-work states." `REACTION_VARIANTS.tool = ['', '', '']` -- the working-state emoji is , not .
- **Rationale:** The wrong emoji sequence appears in both the design artefact and the agent prompt template that teaches this to the model. The model is being instructed with incorrect information about its own reaction lifecycle. This is the highest-priority fix in the batch.

### Finding 2 -- artefact-conversational-pacing:c2

- **File:** `reference/conversational-pacing.md` L28 (Ambient layer pointer in Three Layers table)
- **Quote:** "`telegram-plugin/status-reactions.ts` + `gateway.ts:startTypingLoop` (started at turn-start, stopped by `purgeReactionTracking`)"
- **Verdict:** drift-minor
- **Proposed action:** update-text
- **Proposed text:** Change `gateway.ts:startTypingLoop` to `gateway.ts:startTurnTypingLoop`. The turn-level typing loop (started at turn-start, stopped by `purgeReactionTracking`) is `startTurnTypingLoop` using a dedicated `turnTypingIntervals` map. `startTypingLoop` is a different function (reply-handler typing wrapper).
- **Evidence:** `telegram-plugin/gateway/gateway.ts` L1936-L1960 -- documents the deliberate separation; L8734-L8743 -- `startTurnTypingLoop(chat_id)` is the turn-start callsite.
- **Rationale:** Naming the wrong function in the pointer sends developers to look at the wrong code path.

### Finding 3 -- artefact-conversational-pacing:c6

- **File:** `reference/conversational-pacing.md` L80-L81 (state struct listing)
- **Quote:** "State per-turn: `{ turnStartedAt, lastOutboundAt, pokesFired, pokeArmed, ackPokeFired, subagentDispatchActive, lastThinkingAt, fallbackFired, lastPokeFiredAt }`"
- **Verdict:** drift-minor
- **Proposed action:** update-text
- **Proposed text:** Add `inFlightTools` to the state struct listing: `{ turnStartedAt, lastOutboundAt, pokesFired, pokeArmed, ackPokeFired, subagentDispatchActive, lastThinkingAt, fallbackFired, lastPokeFiredAt, inFlightTools }`. This field was added in issue #1292 to power the tool-aware fallback message wording.
- **Evidence:** `telegram-plugin/silence-poke.ts` L64-L95 -- `SilencePokeState` interface includes `inFlightTools: Map<string, { name, startedAt, label }>`.
- **Rationale:** The state listing is accurate but incomplete. `inFlightTools` is load-bearing for the tool-aware 300s fallback wording.

## Out of scope for this batch

- Edits to `reference/know-what-my-agent-is-doing.md` for the same emoji error (c4 in that unit) -- that lives in `jtbd-know-what-agent-is-doing-fixes` batch.
