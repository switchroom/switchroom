# Pinned progress card — reliability spec

Status: **documenting existing system + closing gaps.** The pin/unpin machinery already exists (see §3). This spec formalizes the invariants it must hold, enumerates failure modes, specifies the test matrix, and lists the residual gaps that still need closing to hit "insanely reliable UX."

## 1. Goal

When the agent is working on a turn, the user always sees a **single, live-updating, pinned** status message for that turn. When the turn ends, that message is either marked `✅ Done` and unpinned, or (for very fast turns) never shown at all. No stale pins, no orphan pins, no duplicate pins, no silent failures.

"Insanely reliable" = every one of the invariants in §4 holds under crash, kill, restart, rate-limit, race, and parallel-turn conditions, with automated tests covering each.

## 2. Non-goals

- Per-tool progress granularity beyond what the event-driven card already renders.
- Pinning arbitrary bot messages (only the per-turn progress card).
- Fighting the user for pin real-estate: a user-pinned message is always a barrier (see I8).
- Pinning in group chats with many admins (Telegram restricts `pinChatMessage` to bots with `can_pin_messages`; failure is logged and swallowed, card still updates in place).

## 3. Existing implementation (ground truth)

Files and their load-bearing roles:

| File | Role |
|---|---|
| `progress-card.ts` | Pure reducer + renderer. Turn-scoped state; event → HTML. |
| `progress-card-driver.ts` | Cadence controller. Coalesce + min-interval + heartbeat + zombie ceiling. Fires `emit` with `isFirstEmit` flag and `onTurnComplete` with `turnKey`. |
| `active-pins.ts` | Sidecar (`$AGENT_DIR/.active-pins.json`) — add/remove/read/write. Atomic rename on write. Shape-validated reads. |
| `active-pins-sweep.ts` | Two sweeps: (a) `sweepActivePins` drains the sidecar and unpins each; (b) `sweepBotAuthoredPins` walks `getChat().pinned_message` and unpins anything authored by our bot, stopping at the first user-authored pin. |
| `server.ts` (streamMode='checklist' block) | Wires driver → Telegram API. Owns `progressPinnedMsgIds`, `unpinnedTurnKeys`, and the idempotent `unpinProgressCard` closure. Boot-time + pre-restart sweeps wired. |

Current lifecycle:

```
enqueue / startTurn
  └─► driver allocates turnKey (chatId:threadId:seq)
      └─► render(state) → emit(isFirstEmit=true)
          └─► handleStreamReply creates message → messageId
              ├─► addActivePin(sidecar)     ← WRITE BEFORE API CALL
              └─► pinChatMessage(disable_notification=true)
                   └─► on failure: removeActivePin (roll back)

...live edits via coalesced flush (400ms) + heartbeat (5s)...

turn_end   OR   stream_reply(done=true)   OR   reply(final=true)
  └─► unpinProgressCard(turnKey) — idempotent via unpinnedTurnKeys
      └─► unpinChatMessage
           └─► finally: removeActivePin (regardless of outcome)
```

Crash / kill paths:
- `SIGKILL` mid-turn → sidecar retains entry → next boot's `sweepActivePins` unpins.
- `/restart`, `/update`, `/reconcile --restart` → proactive pre-SIGTERM sweep (see server.ts:2841).
- Sidecar lost but pin still on Telegram → next boot's `sweepBotAuthoredPins` walks `getChat` and removes bot-authored pins until a user-authored pin acts as barrier.

## 4. Invariants

All must be tested (see §7). `I*` numbers are referenced elsewhere in this spec.

| ID | Invariant |
|---|---|
| **I1** | Every `pinChatMessage` call is preceded by a successful `addActivePin` sidecar write. |
| **I2** | Every successful pin produces exactly one `unpinChatMessage` call over the card's lifetime (across in-session unpin + restart sweep). |
| **I3** | `unpinProgressCard(turnKey, …)` is idempotent — first call fires the API, all subsequent calls for the same `turnKey` are no-ops. |
| **I4** | On process start, any sidecar entry from a prior session is consumed (attempt unpin, then clear) before new traffic is accepted. |
| **I5** | The final render of the card (before unpin) shows `stage === 'done'` → `✅ Done` header. |
| **I6** | Turns that complete faster than `initialDelayMs` (default 30s) produce **no** pin and **no** card — suppressed, not deferred-then-cancelled. |
| **I7** | Parallel active turns on the same `(chatId, threadId)` each have independent `turnKey`, `pin`, `unpin`, and `sidecar` entries. The second `enqueue` force-closes the first (including its unpin) before creating the new pin. |
| **I8** | `sweepBotAuthoredPins` stops at the first non-bot pinned message for a chat — never unpins a user's pin. |
| **I9** | Zombie ceiling: a card whose `lastEventAt` is older than `maxIdleMs` (5 min) is force-closed via the same path as `turn_end` — unpin + `onTurnComplete` + state delete. |
| **I10** | `pinChatMessage` failure does not leave the sidecar polluted — `removeActivePin` is called in the failure branch. |
| **I11** | Completion notification (`✅ Done — <summary>` top-level message) only sent in forum-topic turns (`threadId != null`); never in plain DMs. |

## 5. Failure modes & mitigations

| # | Failure mode | Current mitigation | Residual gap |
|---|---|---|---|
| F1 | SIGKILL between `addActivePin` and `pinChatMessage` | Boot-time `sweepBotAuthoredPins` (no pin to remove, sidecar cleared) | None. |
| F2 | SIGKILL between `pinChatMessage` success and `turn_end` | Boot-time `sweepActivePins` | None. |
| F3 | SIGKILL between `unpinChatMessage` in-flight and `removeActivePin` | Next boot re-attempts unpin; Telegram unpin is idempotent (400 is harmless) | **Gap:** no structured telemetry distinguishes "real stale pin swept" from "redundant sweep on already-unpinned message" — both log generic failure. |
| F4 | `pinChatMessage` 429 (rate limit) | Error logged + sidecar rolled back; card continues to live-update in place (unpinned) | **Gap:** no retry with backoff. User silently loses the pin for that turn. Should at least surface status-reaction signal differently. |
| F5 | `unpinChatMessage` 429 | Error logged + sidecar cleared via `.finally()`; next boot will see stale pin via `sweepBotAuthoredPins` | **Gap:** mid-session stale pin persists until next restart. Consider best-effort retry (1 retry after 1s) before giving up. |
| F6 | Bot lacks `can_pin_messages` in group | Error logged and swallowed; card still live-updates inline | None — graceful degradation. |
| F7 | Session restart while turn still live | Pre-restart sweep unpins; new process's startup sweep is redundant but harmless; the resumed turn creates a fresh pin via the `--continue` path | **Gap:** user sees "Done → unpin → new pin" flicker during ~1–3s restart. Consider deferring pre-restart unpin until the new process confirms it has taken over (out of scope for this spec; needs handoff-protocol work). |
| F8 | Two parallel turns on same `chatId:threadId` | `turnKey` allocator + `isSync` guards in enqueue handler | None (tests cover). |
| F9 | Duplicate enqueue echoes from session-tail (JSONL rotation, reconnect) | `seenEnqueueMsgIds` 60s dedup + `pendingSyncEchoes` sync marker | None — well tested. |
| F10 | Heartbeat keeps ticking a card whose `turn_end` was dropped | `maxIdleMs` zombie ceiling (5 min) force-closes | **Gap:** 5 min is long. Surface a warning in the card header after ~2 min of no events: `⚠️ No events for 2m — likely stuck.` |
| F11 | User manually unpins the card mid-turn | Next `pinChatMessage` in this session is never called (pin is one-shot per turn); sidecar holds stale entry until `onTurnComplete` fires `removeActivePin` after a harmless `unpinChatMessage` 400 | **Gap:** card stops being pinned but user has no visual indication the card is still live. Low priority — if they unpinned it they chose to. |
| F12 | Two bots in the chat both managing pins | `sweepBotAuthoredPins` filters by `botUserId` | None. |
| F13 | `getChat().pinned_message` returns only the top pin, so a stack of bot pins requires iteration | `sweepBotAuthoredPins` loops up to `maxPerChat=32` | None. |

## 6. Observability requirements

Current state: `process.stderr.write` lines for pin/unpin failure. That's insufficient for "insanely reliable."

Required:

1. **Structured log event per pin/unpin**, one line JSON on stderr with prefix `pin-event:`. Fields: `event` (`pin|unpin|sweep-pin|sweep-auth`), `chatId`, `messageId`, `turnKey`, `outcome` (`ok|fail|rate-limited|forbidden`), `error?`, `durationMs`.
2. **`/pins-status` admin command** (or extend `/status`): report current sidecar entries + in-memory `progressPinnedMsgIds` + any divergence.
3. **Weekly self-audit** (or on boot): call `sweepBotAuthoredPins` in read-only mode across allowlisted chats and report count of bot pins not tracked in sidecar. Alarm if > 0 after a steady-state period.
4. **Metric: pin-to-first-edit latency** — time from `pinChatMessage` returning to the first subsequent `editMessageText`. Should stay under ~1s; breach indicates rate-limit pressure.
5. **Metric: orphan sweep frequency** — count of pins cleaned up by startup / bot-authored sweep per boot. Steady-state should be 0.

## 7. Test matrix

Existing tests to keep (enumerate and reference in CI):
- `active-pins.test.ts` — sidecar add/remove/read/write/idempotency/corruption.
- `active-pins-sweep.test.ts` — timeout bounds, barrier semantics, max-per-chat loop.
- `progress-card.test.ts` — reducer covers all `turn_end` paths, renderer produces `✅ Done`.
- `progress-card-driver.test.ts` — `isFirstEmit` fires exactly once, `onTurnComplete` fires exactly once, `initialDelayMs` suppression, parallel-turn force-close.

New tests required for this spec:

| ID | Test | Covers |
|---|---|---|
| T1 | Integration: simulate pin API failure → assert `removeActivePin` called and no stale sidecar entry | I10 |
| T2 | Integration: simulate unpin API failure → assert sidecar cleared in `.finally()`, assert next-boot sweep picks up Telegram-side stale pin via `sweepBotAuthoredPins` | F3, F5 |
| T3 | Unit: `sweepBotAuthoredPins` stops on first user-authored pin (barrier) | I8 |
| T4 | Integration: two parallel `startTurn` calls on same `chatId:threadId` → two distinct `turnKey`s, two pins, two unpins, no orphan sidecar entries at end | I7 |
| T5 | Integration: `turn_end` before `initialDelayMs` → zero emits, zero pins, sidecar untouched | I6 |
| T6 | Integration: heartbeat ticks 2 min past last event → header shows stuck-warning; 5 min → zombie close fires unpin | F10, I9 |
| T7 | Integration: boot with non-empty sidecar → sweep runs before first inbound message is processed | I4 |
| T8 | Integration: rate-limit simulation — 20 rapid turns → each gets pin + unpin, no 429 surfaces to user visibly; degraded path logs structured event | F4, F5, §6.1 |
| T9 | Structured log assertion: every pin/unpin emits exactly one `pin-event:` JSON line with all required fields | §6.1 |
| T10 | Self-audit: boot-time read-only sweep reports 0 orphan pins on a clean chat | §6.3 |

## 8. Implementation plan (gap-closing)

Order of work, smallest-first:

1. **Structured pin-event logging** (~30 LOC in `server.ts` + one helper) — closes §6.1, enables T9.
2. **T1–T5 tests** — no production code changes, just formalizes existing behavior.
3. **Stuck-warning in card header** (~15 LOC in `progress-card.ts` renderer + driver signal) — closes F10 lower tier.
4. **Unpin retry (single attempt, 1s backoff)** (~20 LOC in `unpinProgressCard`) — closes F5.
5. **`/pins-status` admin command** (~40 LOC) — closes §6.2.
6. **Boot-time read-only audit + metric** (~30 LOC) — closes §6.3–6.5.
7. **T6–T10 tests.**

Total estimate: ~150 LOC production + ~400 LOC tests. No schema changes. No config migration. Backwards compatible with existing sidecars.

## 9. Out of scope (future work)

- Handoff-protocol for restart flicker (F7): needs new-process-confirms-takeover handshake. Large.
- Multi-pin stacking UX (one pin per sub-agent task): current model is one pin per parent turn; changing it requires reworking `turnKey` allocation.
- Pinning arbitrary user-selected bot messages.
- Fallback to a "sticky last message" non-pin display when `can_pin_messages` is absent.
