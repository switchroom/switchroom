# Recommendation: Escalation E6 — Silence-poke empirical success rate (0-7% vs >80% JTBD target)

**Recommended option:** E (deterministic fallback floor + prompt iteration)

**Confidence:** high

## Why

The failure is structural, not incidental. `telegram-plugin/pending-work-progress.ts:L13-16`
documents the root cause clearly: the soft and firm pokes reach the model as
`<system-reminder>` blocks piggybacked on the next tool result
(`telegram-plugin/silence-poke.ts:L367-380`, drained at the gateway's
`onToolCall` chokepoint). This means (a) the poke only lands if the model is
actively cycling tools at that exact moment, (b) it competes with all the
other tokens in the tool result context, and (c) it disappears the instant the
turn ends. Three hundred fires across three agents — finn 0/78, clerk 6/91,
klanker 5/158 — is not a bad-run sample: it is the steady state. The prompt
text itself (`formatPokeText` at `telegram-plugin/silence-poke.ts:L354-380`)
is clear and well-formed. The delivery channel is the problem, not the wording.

Option A alone (prompt variants) cannot fix a delivery problem. Option D
(lower the target) is honest but abandons a real user need — "you never feel
the need to ask status?" is the JTBD's primary anti-pattern
(`reference/know-what-my-agent-is-doing.md:L196-198`). Option B (deterministic
inference from the last tool call's args, the same signal the progress card
used before it was retired) gives a guaranteed floor: every long tool-churn
produces a user-visible line at a defined cadence without any model hop. Option
C (tighten the firing trigger to long-running tools only) reduces noise but
does not change the delivery-channel failure rate for the fires that do occur.

Option E combines B and A because they address different things. B ships the
floor immediately: infer the status line from the most recent in-flight tool
entry in `SilencePokeState.inFlightTools` (`telegram-plugin/silence-poke.ts:L64-
67`) — tool name, label, elapsed time — and emit it as a gateway-authored
framework message rather than a model prompt. This is the same tool-label
infrastructure already used by the progress card (retired in #1122) and
`telegram-plugin/tool-labels.ts`. It gives the user something at 75s even when
the model is in the middle of a 10-minute Bash run. Alongside that, A iterates
on three to five prompt variants using `SWITCHROOM_DISABLE_SILENCE_POKE=1` to
isolate them — tested against a fixed eval set of long-tool-churn sessions —
and picks the best. The model variant tops up the deterministic floor on turns
where the model is actively cycling tools and can respond.

## Tradeoffs

The risk of B is voice: a gateway-authored line reads differently from a
model-authored one. The JTBD (`reference/know-what-my-agent-is-doing.md:L27`)
was explicit that the progress card was retired precisely because it "covered
for the model not chatting." A deterministic fallback risks reintroducing that
pattern. Mitigate by making the B output clearly framework-attributed (e.g.,
"still working — last tool: grep, 2m 10s") rather than persona-voiced, so
users learn to distinguish it from real agent narration. The 300s framework
fallback (`telegram-plugin/silence-poke.ts:L385-403`) already does this with
its parenthetical "(no update from agent in N min)."

## Work estimates

- Option B (deterministic fallback from `inFlightTools`): ~40 agent-minutes.
  Wire the tool-label inference into `formatFallbackText`-equivalent; emit via
  the existing `onFrameworkFallback` callback path; add a snapshot test. No
  new external dependencies.
- Option A (prompt variant eval): ~30 agent-minutes. Write three variants,
  run against a replay set of 50 long-turn sessions, measure
  `silence_poke_succeeded` rate, pick winner. Requires eval harness that
  replays tool-result streams with the poke injected.
- Option E total: ~70 agent-minutes, sequenced B first (immediate user
  impact), A second (model quality uplift on top of the floor).
- Option D (JTBD target update only): ~5 agent-minutes. Honest but abandons
  the outcome; use only if product decides the JTBD's "never feel the need
  to ask status" bar is being set aside.

## Open question for the operator

The pending-work-progress module (`telegram-plugin/pending-work-progress.ts`)
already covers the cross-turn case (turn ends with a pending background Agent
or Task dispatch). The remaining gap is intra-turn: a 10-minute synchronous
Bash or WebFetch run where the turn is open but the model is simply inside a
blocking tool and not cycling. Is Option B's scope the full silence-poke
ladder (75s + 180s + fallback), or only the 300s framework-fallback tier where
deterministic output is already accepted? The answer determines how much of the
model-authored path is bypassed.
