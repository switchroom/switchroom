# Waiting-for-reply UX — v2 spec (three-class contract)

Tracks: [#545](https://github.com/mekenthompson/switchroom/issues/545),
[#553](https://github.com/mekenthompson/switchroom/issues/553) (PR series)

This document codifies the user-perceived contract for what happens
between "I sent a Telegram message" and "the agent's reply is locked
in." The contract varies by **turn class**. The v2 rewrite (#553)
sharpens the gates: tools alone never trigger the progress card,
placeholder text is removed entirely, and sub-agents (= background
workers) are the single concept for parallel work.

## Three turn classes

### Class A — Instant (<2s, NO tools)

| Surface           | Contract                                                               |
| ----------------- | ---------------------------------------------------------------------- |
| Status reaction   | 👀 within 800ms of inbound. Terminates with 👍.                        |
| Progress card     | **Never rendered.** Suppressed regardless of `initialDelayMs`.         |
| Placeholder text  | **Never sent.** No `🔵 thinking` / `📚 recalling memories` / `💭 thinking`. |
| Answer text       | First answer-text edit lands within **800ms** of inbound (TBD #553-PR-3). |
| Ladder            | 👀 → 👍. Optional 🤔 if the controller debounce window is crossed.    |

User experience: feels like a chat partner typing back instantly.

### Class B — Short (2–60s, tools, NO sub-agents)

| Surface           | Contract                                                               |
| ----------------- | ---------------------------------------------------------------------- |
| Status reaction   | 👀 within 800ms. Ladder progresses through 🤔 / tool-glyphs (🔥/✍/👨‍💻/⚡) before 👍. **Must NOT collapse straight to 👍.** |
| Progress card     | **Never rendered.** The card gate is `(elapsed >= 60s) OR (sub-agent appeared)` — tools alone do NOT trigger it. |
| Placeholder text  | **Never sent.**                                                        |
| Answer text       | First answer-text edit lands within **<Ns** of inbound (TBD #553-PR-3). Streams progressively as the model produces tokens. |
| Final             | 👍 + locked stream answer.                                             |

User experience: live ladder of tool reactions, answer text starts
streaming as soon as the model resumes, no fake "thinking" spacers.

### Class C — Long-running (>60s OR sub-agents/background workers)

| Surface           | Contract                                                               |
| ----------------- | ---------------------------------------------------------------------- |
| Status reaction   | 👀 within 800ms. Ladder throughout. Settles to 👍 only after full quiescence (all sub-agents terminal). |
| Progress card     | Renders the moment the gate trips: `(elapsed >= 60s) OR (any sub-agent has appeared)`. Stays pinned-feel and stable. |
| Card "Done" stamp | **≥ last sub-agent terminal timestamp.** Card never marks Done while a sub-agent is still in flight. |
| Sub-agent header  | Header count == rendered-list-length. **No drift between summary and bullets.** |
| Placeholder text  | **Never sent.**                                                        |

A "background worker" ≡ a sub-agent dispatched with
`Agent({ run_in_background: true })`. There is no separate concept —
the card gate, the bullet list, and the quiescence check all key on
the sub-agent stream.

## Key invariants (v2)

1. **No placeholder strings** — `🔵 thinking`, `📚 recalling memories`,
   and `💭 thinking` must never appear in any `sendMessage` /
   `editMessageText` payload at any point in any turn class. PR 5
   removes the production code that emits them.
2. **Card gate** — `(elapsed >= 60s) OR (any sub-agent has appeared)`.
   Tool-use count, tool category, and parent narrative content are
   NOT inputs to the gate.
3. **First-answer-text deadline** — Class A: <800ms. Class B/C: <Ns
   (TBD by PR 3 once production measurement lands).
4. **Sub-agent header == list length** — every render of the card.

## PR 1 — foundation: spec + harness extensions (this PR)

PR 1 ships:

- This rewritten spec — supersedes the v1 four-failure-mode framing.
- Three new helpers on `tests/real-gateway-harness.ts`:
  - `expectNoPlaceholderEdits(chatId)` — returns recorded calls whose
    payload matches a banned placeholder string. Tests assert
    `toEqual([])`.
  - `expectNoCardSent(chatId)` — wraps `progressCardSendMs` for
    assertion-friendly use (`.toBeNull()`).
  - `firstAnswerTextMs(chatId)` — first `sendMessage` /
    `editMessageText` whose payload is neither a card payload nor a
    placeholder string.
- A new RED test file `tests/real-gateway-spec.test.ts` (all
  `describe.skip`'d) pinning the three-class contract:
  - Class A — 5 tests
  - Class B — 4 tests
  - Class C — 5 tests
  Each carries a `// TODO(#553-PR-N)` marker for which subsequent PR
  un-skips it.

PR 1 does NOT change production code. The existing F1/F2/F3/F4
regression tests stay green; the new spec tests are skipped, so they
do not gate CI yet.

## PR 2–5 — implementation roadmap

| PR  | Scope                                                                | Un-skips                                            |
| --- | -------------------------------------------------------------------- | --------------------------------------------------- |
| 2   | Kill instant-draft placeholder; preserve early-ack 👀                | Class A no-placeholder, Class B no-placeholder      |
| 3   | First-answer-text deadline implementation; tighten <Ns numbers       | Class A/B/C answer-text-deadline assertions         |
| 4   | Card-gate rewrite to `(>=60s) OR (sub-agent appeared)`               | Class B no-card; Class C card-gate tests            |
| 5   | Remove `🔵 thinking` / `📚 recalling memories` / `💭 thinking` strings; sub-agent header = list length | Remaining no-placeholder + sub-agent count tests    |

## Failure-mode history (F1–F4, fixed in earlier #553 PRs)

The v1 spec framed the rewrite around four observed regressions from
the 2026-04-30 live demo. They are all fixed; the regression tests
(`tests/real-gateway-f1-ladder-integrity.test.ts`,
`real-gateway-f2-instant-draft.test.ts`, `real-gateway-f3-late-card.test.ts`,
`real-gateway-f4-interim-text.test.ts`) stay in place to keep the gaps closed.

| ID  | Symptom                                                                    | Class | Status                                            |
| --- | -------------------------------------------------------------------------- | ----- | ------------------------------------------------- |
| F1  | Ladder collapses straight to 👍 (skips 👀 → 🤔 → 🔥)                       | B     | Fixed — `StatusReactionController.finishWithState` flushes pending pre-terminal emoji. |
| F2  | No instant draft / typing signal — chat sits silent "for ages"             | All   | Fixed — `handleInboundCoalesced` fires 👀 directly on raw arrival before the coalesce buffer. |
| F3  | Progress card renders late (after turn_end, or never on long turns)        | C     | Fixed under v1 rules with a 5s time-promote in the driver; **superseded by PR 4**, which replaces the gate with `(>=60s) OR (sub-agent)`. |
| F4  | Pre-tool preamble static — one preamble then silence                       | B     | Regression-guarded only; not reproducible deterministically. The v2 contract sidesteps F4 by tightening the first-answer-text deadline (Class B/C, PR 3). |

The F1/F2/F3/F4 tests remain green throughout the v2 rewrite — they
encode tighter invariants than the v2 spec relaxes. PR 4's gate
change does not regress F3 (the F3 long-single-tool case crosses the
60s threshold).

## Test methodology

- **Time control**: `vi.useFakeTimers()` + `vi.setSystemTime` for
  deterministic wall-clock assertions. The harness records every
  outbound `bot.api` call with `Date.now()` at invocation, so all
  deadlines are reproducibly measurable.
- **Recorder** (existing): `firstReactionMs`, `progressCardSendMs`,
  `reactionSequence`, `lastReactionEmoji`, `edits`, `sentTexts`.
- **Recorder** (PR 1 additions): `expectNoPlaceholderEdits`,
  `expectNoCardSent`, `firstAnswerTextMs`.
- **Production wiring**: the harness uses the actual
  `StatusReactionController`, `createProgressDriver`, and
  `createInboundCoalescer` from production — not mocks. The bot.api
  layer below is a recording fake.
- **Out of scope**: foreman queue, IPC bridge, auth, history. Those
  do not influence the user-perceived waiting UX.

## CI gate

The harness runs as part of the root vitest suite via `npm test` →
`vitest run`. PR 1's spec tests are `describe.skip`'d and do not
fail CI; PRs 2–5 un-skip them as the production code lands.

## Phase 1 / Phase 3 history (legacy)

For posterity:

- **Phase 1** (#547): `tests/waiting-ux.e2e.test.ts` — controller +
  driver in isolation, hand-written `feedSessionEvent` adapter. F2
  passed trivially because the harness called `setQueued()`
  synchronously inside `inbound()`.
- **Phase 3** (#553 PR 1, original): `tests/real-gateway-harness.ts`
  composed the production `InboundCoalescer` before the Phase 1
  controller stack, exposing the real F2 gap (👀 only fired after
  the coalesce window). F2's fix landed against this harness.
- **v2 rewrite** (this PR series, also numbered #553): same Phase 3
  harness, plus three v2 helpers; new spec test file pins the
  three-class contract.
