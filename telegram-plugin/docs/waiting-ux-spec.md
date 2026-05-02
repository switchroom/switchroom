# Waiting-for-reply UX — deterministic time-sequence spec

Tracks: [#545](https://github.com/mekenthompson/switchroom/issues/545)

This document codifies the user-perceived contract for what happens between
"I sent a Telegram message" and "the agent's reply is locked in." The contract
varies by **turn class**. Phase 1 of #545 lands an E2E harness
(`tests/waiting-ux.e2e.test.ts`) that asserts these invariants in fake-timer
deterministic time.

## Three turn classes

### Class A — Instant reply (no tool calls, < ~2s of model time)

| Surface              | Contract                                                                |
| -------------------- | ----------------------------------------------------------------------- |
| Status reaction      | 👀 lands within **800ms** of inbound. Terminates with 👍.               |
| Progress card        | **Never rendered.** `initialDelayMs` (~30s) suppresses it entirely.     |
| Draft answer         | Streams via `stream_reply` direct. No card scaffolding.                 |
| Ladder               | 👀 → (optional 🤔 burst) → 👍. No tool reactions.                       |

User experience: feels like a chat partner typing back.

### Class B — Short turn (1–3 tool calls, < ~15s)

| Surface              | Contract                                                                |
| -------------------- | ----------------------------------------------------------------------- |
| Status reaction      | 👀 within 800ms. Ladder progresses through 🤔 / tool-glyphs (🔥/✍/👨‍💻/⚡) before 👍. **Must NOT collapse straight to 👍.** |
| Progress card        | Optional. Renders if turn exceeds `initialDelayMs` threshold (configurable, default 30s) with live tool bullets. |
| Pre-tool preamble    | Refreshes ≥1 time across step transitions (new tool category, or >Ns since last refresh). **Must NOT be a single static line for the entire turn.** |
| Final                | 👍 + locked stream answer.                                              |

### Class C — Long-running / multi-agent (sub-agents, background workers)

| Surface              | Contract                                                                |
| -------------------- | ----------------------------------------------------------------------- |
| Status reaction      | 👀 within 800ms. Settles to 👍 only after full quiescence (all sub-agents + workers terminal). |
| Progress card        | Renders early — **before turn_end** — and stays stable. Each sub-agent + background worker has its own bullet. |
| Card "Done" timestamp | Must be **≥ last sub-agent terminal timestamp**. Card does not mark Done while any worker is still in flight. |
| Ladder               | Tool reactions throughout, settling to 👍 only after full quiescence.   |

## Failure modes the harness must catch

These are the four observed regressions from the live demo on 2026-04-30:

| ID  | Symptom                                                                    | Class | Test                                            |
| --- | -------------------------------------------------------------------------- | ----- | ----------------------------------------------- |
| F1  | Ladder collapses straight to 👍 (skips 👀 → 🤔 → 🔥)                       | B     | `Class B — short turn > ladder integrity`       |
| F2  | No instant draft / typing signal — chat sits silent "for ages"             | All   | `Class A > first-paint deadline`, `Class C > first-paint`         |
| F3  | Progress card renders late (after turn_end, or never on long turns)        | C     | `Class C > progress card renders early`         |
| F4  | Pre-tool interim text is static — one preamble then silence                | B     | `Class B > interim refresh`                     |

## Test methodology

- **Time control**: `vi.useFakeTimers()` + `vi.setSystemTime` for deterministic
  wall-clock assertions. The harness records every outbound `bot.api` call with
  `Date.now()` at invocation, so first-paint and ladder deltas are
  reproducibly measurable.
- **Recorder**: a `Recorder` object exposes the helpers tests need
  (`firstReactionMs`, `progressCardSendMs`, `reactionSequence`,
  `lastReactionEmoji`, `edits`, `sentTexts`).
- **Production wiring**: the harness uses the actual
  `StatusReactionController` and `createProgressDriver` from production —
  not mocks. The bot.api layer below is a recording fake.
- **Out of scope**: gateway message-coalescing, foreman queue, inbound update
  handler, and IPC surfaces are not exercised by this harness. See
  "Known limitation" below.

## Known limitation (Phase 1)

The harness drives `controller.*` and `driver.*` methods directly from a
hand-written `feedSessionEvent` adapter that mirrors the relevant `case`
branches in `gateway/gateway.ts`'s session-tail dispatcher. This means the
harness asserts the contract is upheld **inside the controller + driver
components** but does not catch failures introduced by:

- Gateway-side message gating / queueing latency before the controller is constructed
- Session-tail parser bugs (events dropped or mis-tagged before reaching dispatch)
- IPC bridge dropouts that desynchronise the two halves of the system

A Phase 2 harness that drives the real gateway through a synthetic update
stream is filed as a follow-up. Until then, integration-boundary regressions
remain CI-invisible.

## Phase 3 — real-gateway harness (#553)

The Phase 1 harness called `controller.setQueued()` synchronously inside
its `inbound()` helper, which is why the F2 deadline passed trivially —
not because the production code was correct, but because the harness
was lying about the inbound flow.

Phase 3 introduces `tests/real-gateway-harness.ts` which composes the
production `InboundCoalescer` (extracted to `gateway/inbound-coalesce.ts`)
*before* the Phase 1 controller + driver stack. This faithfully reproduces
what every Telegram-only user sees: 👀 fires only after the coalesce
window closes (default `gapMs=1500`), ~1500ms after their message landed
— ~700ms over the F2 deadline.

### F2 root cause hypothesis (now CI-observable)

- `gateway.ts`'s `handleInboundCoalesced` buffers messages for `gapMs`
  and only on flush calls `handleInbound` → `firstPaintTurn` →
  `controller.setQueued()` (👀).
- That couples first-paint to the coalesce window. The fix is to fire
  the reaction on raw arrival (before buffering) and let only the
  Claude-side dispatch wait on the buffer.
- `tests/real-gateway-f2-instant-draft.test.ts` pins this contract.
  Currently `.skip`'d with a `TODO(#553-F2)` — un-skipped when the fix
  lands.

## CI gate

The harness runs as part of the root vitest suite via `npm test` →
`vitest run`. It picks up
`telegram-plugin/tests/waiting-ux.e2e.test.ts` automatically — no separate
config required.
