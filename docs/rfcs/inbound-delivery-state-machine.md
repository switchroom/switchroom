# RFC — InboundDeliveryStateMachine

> Status: draft v1 — design contract for Phase 2b of the wedge-cluster remediation. Closes the architectural class of bugs that v0.12.22 (#1573) patched at the symptom level.

## Why this RFC

Between 2026-05-18 and 2026-05-20 the gateway shipped **9 PRs** (#1536 #1537 #1539 #1541 #1545 #1546 #1549 #1555 #1558 #1564 #1573) all patching variants of one bug class: **inbound messages get stranded in some pipeline stage and only surface 5 minutes later when the silence-poke framework-fallback fires**. Every PR closed a specific case; every PR was followed by a new case the previous fix exposed.

The v0.12.22 boot-wedge (#1573) is the latest instance:

- `handleInbound` ran the fresh-turn init bundle which set `activeTurnStartedAt[key]`
- The #1556 delivery gate (next 190 lines) read `activeTurnStartedAt.size > 0` LIVE — saw the entry the same handler had just written for THIS inbound's turn
- Buffered the turn-starting message; bridge never received it; claude never replied; `activeTurnStartedAt[key]` stayed set; silence-poke fallback fired 300s later
- Symptom: every first user message after every container restart was stuck 5 minutes

The fix was a 2-line snapshot of the live size at receipt-time. **It works** (validated by mtcute UAT, 19.4s → 1.77s for warm trivial). But it's a symptom fix — the underlying problem is **the gateway's delivery state is implicit and scattered**:

- `currentTurn` (singleton, module-level)
- `activeTurnStartedAt` (`Map<ChatKey, number>`)
- `activeStatusReactions` (`Map<ChatKey, Controller>`)
- `pendingInboundBuffer` (in-memory per-agent queue + on-disk JSONL spool)
- `pendingPermissionBuffer` (in-memory per-agent queue, #1539)
- `inboundSpool` (JSONL persistence layer)
- Three drain triggers (onClientRegistered, silence-poke fallback self-heal #1546, idle-drain timer #1549)
- One delivery gate (turn-gated #1555)
- One sibling-key sweep (#1564)
- One restart-marker dance (#1546)

Each piece is correct in isolation. The interactions produce the wedges. There is **no model** anywhere in the codebase that says "given these inputs, what should the gateway do" — only an accumulated pile of imperative code paths that have to be kept consistent by hand. Every new PR risks introducing a new misalignment.

A **post-v0.12.22 mid-turn silence wedge** was discovered during the 2026-05-20 rollout: overlapping turns (turn 966 created 27.5s after turn 965 was still in flight) cause the silence-poke clock to reset to 0 on each `startTurn(key)`, with no carry-forward of the prior turn's outbound signal. User status-query messages don't reset the clock (they're inbound). At 300s the fallback fires spuriously even though the model replied 290s ago. **Same shape of bug**: a per-turn lifecycle resets state that should have been per-key-persistent.

## The proposal

Extract the implicit state into a single pure module: `telegram-plugin/gateway/inbound-delivery-machine.ts`. The module **decides**; the gateway **executes effects**. No I/O, no timers, no mutation — every transition is `(state, event) → (state', effects[])`.

The module is then property-tested against four invariants. Any state schedule that violates an invariant is a counterexample. The wedge cluster bugs are not patched one-by-one; they become **unrepresentable**.

## Contract

### States

```typescript
type GlobalState =
  | { kind: 'bridge_dead' }
  | { kind: 'bridge_alive_idle' }
  | { kind: 'bridge_alive_in_turn'; activeTurn: ChatKey }

type PerKeyState = {
  // The chat-level turn lifecycle. Lifted from activeTurnStartedAt.
  turnStartedAt: number | null
  // The chat-level last-outbound timestamp. Carries across turns —
  // this is the fix for the post-v0.12.22 overlapping-turn silence
  // bug, where startTurn() resetting lastOutboundAt to null caused
  // spurious fallback fires.
  lastOutboundAt: number | null
}
```

`GlobalState` mirrors the existing `currentTurn` singleton. `PerKeyState` is keyed by `ChatKey` (the brand introduced in v0.12.21 #1570) and lifts both `activeTurnStartedAt` AND the silence-poke clock into one place.

### Events

```typescript
type Event =
  | { kind: 'bridgeUp'; at: number }
  | { kind: 'bridgeDown'; at: number }
  | { kind: 'turnStart'; key: ChatKey; at: number }
  | { kind: 'turnEnd'; key: ChatKey; at: number; outboundEmitted: boolean }
  | { kind: 'inbound'; key: ChatKey; msgId: number; at: number; isSteering: boolean }
  | { kind: 'callback'; key: ChatKey; data: unknown; at: number }
  | { kind: 'permVerdict'; verdict: PermissionVerdict; at: number }
  | { kind: 'spoolReady'; entries: SpooledInbound[]; at: number }
  | { kind: 'ackFromBridge'; msgId: number; at: number }
  | { kind: 'modelOutbound'; key: ChatKey; at: number }
  | { kind: 'tick'; now: number }
```

`modelOutbound` is the canonical signal for "the model produced output for this key" — replaces the scattered `signalTracker.noteOutbound` / `silencePoke.noteOutbound` calls.

### Effects

```typescript
type Effect =
  | { kind: 'deliverToBridge'; msg: InboundMessage }
  | { kind: 'bufferInbound'; msg: InboundMessage }
  | { kind: 'persistInbound'; msg: InboundMessage; spoolKey: string }
  | { kind: 'drainBuffer'; agentName: string }
  | { kind: 'setTurnStarted'; key: ChatKey; at: number }
  | { kind: 'clearTurnStarted'; key: ChatKey }
  | { kind: 'noteOutbound'; key: ChatKey; at: number }
  | { kind: 'firePoke'; key: ChatKey; level: 'soft' | 'firm' | 'fallback' }
  | { kind: 'autoDenyExpiredPermVerdicts'; set: PermissionRequest[] }
  | { kind: 'redeliverPermVerdict'; v: PermissionVerdict }
  | { kind: 'logTrace'; stage: string; key?: ChatKey; metadata?: Record<string, unknown> }
```

Effects are **returned, not performed**. The gateway dispatcher receives `(state', effects[])` and runs them. This makes the property test trivial: drive arbitrary event sequences through the pure transitions, assert invariants over the resulting (state, effects) traces.

### Transition rules (concrete)

These are exhaustive — every `(state, event)` pair has a defined transition. (Full table in the implementation PR; key cases here.)

**`bridge_alive_idle` + `inbound(key, msgId, at, isSteering=false)`:**
- Look up `perKey[key].turnStartedAt`. If non-null: state stays `bridge_alive_idle` (wait — but turnStartedAt non-null means a turn IS in flight, so this case can't happen — that's invariant #2's content).
- Otherwise: state → `bridge_alive_in_turn(key)`. Effects: `setTurnStarted(key, at)`, `deliverToBridge(msg)`, `logTrace(stage=fresh_turn_deliver)`.

**`bridge_alive_in_turn(activeKey)` + `inbound(key, msgId, at, isSteering=false)`:**
- ALWAYS buffer. State unchanged. Effects: `bufferInbound(msg)`, `persistInbound(msg)`, `logTrace(stage=held_mid_turn)`.

**`bridge_alive_in_turn(activeKey)` + `turnEnd(key=activeKey, at, outboundEmitted=true)`:**
- State → `bridge_alive_idle`. Effects: `clearTurnStarted(key)`, `drainBuffer(agentName)`, `noteOutbound(key, at)` (if outboundEmitted), `logTrace(stage=turn_complete)`.

**`bridge_alive_*` + `bridgeDown(at)`:**
- State → `bridge_dead`. Effects: `clearTurnStarted(activeKey if in_turn)` (no — actually KEEP per-key state, the bridge flap shouldn't clobber turn state; let the next bridgeUp + turnEnd handle it), `logTrace(stage=bridge_flap)`.

**`bridge_dead` + `inbound(...)`:**
- Effects: `bufferInbound(msg)`, `persistInbound(msg)`, `logTrace(stage=bridge_dead_buffer)`. State unchanged.

**`bridge_dead` + `bridgeUp(at)`:**
- State → `bridge_alive_idle`. Effects: `drainBuffer(agentName)`, `logTrace(stage=bridge_recover)`.

**Any state + `tick(now)`:**
- For each `key` in `perKey`: if `turnStartedAt != null` and `now - turnStartedAt > TURN_TTL` (5 min):
  - **Check `lastOutboundAt` first** (this is the v0.12.22-mid-turn-silence fix). If `lastOutboundAt != null && now - lastOutboundAt < OUTBOUND_RECENT_MS` (60s), the model recently broke silence; suppress the fallback fire. Otherwise emit `firePoke(key, 'fallback')` + `clearTurnStarted(key)` + transition to `bridge_alive_idle` if this was the activeTurn.

**Any state + `modelOutbound(key, at)`:**
- Effects: `noteOutbound(key, at)` — updates `perKey[key].lastOutboundAt = at`. Does NOT change global state.

### Property-test invariants (the load-bearing contract)

These four invariants are property-tested with arbitrary event schedules. Any violation is a bug; the test prints the minimal counterexample.

**Invariant #1 — Every inbound is exactly delivered OR persisted.**

For every `inbound(msg)` event in the schedule, the effects emitted in response contain either `deliverToBridge(msg)` OR (`bufferInbound(msg)` AND `persistInbound(msg)`) — never both, never neither. Catches the wedge-cluster class where a buffered inbound was lost (no persist) or double-delivered (deliver + buffer).

**Invariant #2 — Turn lifecycle: setTurnStarted always paired with clearTurnStarted before next end-of-life event.**

For every `setTurnStarted(key, t)` effect: the next `turnEnd(key)` event, OR `tick(now ≥ t + TURN_TTL)` event, OR `bridgeDown(at)` event (whichever comes first) MUST emit `clearTurnStarted(key)`. Catches the wedge-cluster class where `activeTurnStartedAt[key]` stayed set after turn-end, causing the next inbound to wedge.

**Invariant #3 — Per-chat sibling-key cleanup on turnEnd.**

For any chatId, after the last `turnEnd(key)` whose key has that chatId, no entry for that chatId remains in `perKey` within one event-loop tick. Lifts PR #1564's `purgeStaleTurnsForChat` to a machine invariant. The test generates arbitrary `(chatId, threadId | null | undefined | 0)` sequences and asserts no sibling entries survive — this is the invariant that catches the #1564 sibling-key class as a property-test counterexample.

**Invariant #4 — Permission verdicts: delivered iff bridge alive, else persisted and re-delivered on next bridgeUp.**

For every `permVerdict(v)` event: emitted effects contain `deliverToBridge(v)` iff state is `bridge_alive_*`. If `bridge_dead`, contains `persistInbound(v)`. On next `bridgeUp`, `drainBuffer` is emitted and the prior persisted verdict is among the drained items. Catches PR #1539's class.

**(Bonus) Invariant #5 — Spurious-fallback suppression.**

For every `firePoke(key, level='fallback')` effect: the state's `perKey[key].lastOutboundAt` is either null OR more than `OUTBOUND_RECENT_MS` (60s) before the firing `tick.now`. Equivalently: if the model produced an outbound for this key in the last 60s, the fallback does NOT fire. Catches the post-v0.12.22 overlapping-turn silence bug (turn 966's fresh state, prior turn's outbound ignored).

## Cutover plan — 3 PRs

The state machine must be introduced without breaking the live system. Phased:

### PR 1 — Pure module + property test (NOT WIRED)

Add `telegram-plugin/gateway/inbound-delivery-machine.ts` with the state, events, effects, and pure transition function. Add `telegram-plugin/tests/inbound-delivery-machine.test.ts` with the 5 property-test invariants. The module is exported but no production code imports it yet. **Zero behavior change.**

Gate: all 5 invariants pass on 10,000 random schedules.

### PR 2 — Gateway delegates (behavior bit-identical)

`gateway.ts:handleInbound` constructs an Event for each input and dispatches through the state machine. The dispatcher receives the Effects array and executes them in order. Each effect maps 1:1 to an existing code path (e.g., `deliverToBridge` → `ipcServer.sendToAgent`; `bufferInbound` → `pendingInboundBuffer.push`).

Gate: every existing UAT scenario still passes, including the post-restart mtcute UAT (jtbd-always-on-after-restart), the fast-trivial UAT, and every fuzz scenario. The state machine SHOULD produce the same observable behavior as the current ad-hoc code — if it doesn't, either the machine has a bug or the current code has one we're now seeing.

### PR 3 — Delete the redundant primitives (cleanup)

Once PR 2 has baked 48+ hours with no regressions, remove the now-redundant code:
- `silence-poke.ts`'s scattered `noteOutbound` / `noteSignal` calls (replaced by `modelOutbound` event)
- `purgeStaleTurnsForChat` (now an automatic effect of `turnEnd` per invariant #3)
- The three drain triggers' overlapping logic (state machine emits `drainBuffer` exactly once at the right moment)
- The redundant boot-card / mid-turn-buffer cleanups

Net: a few hundred lines removed, plus the bugs they were patching.

## Updated cutover plan (post PR 2/3 — split into 3a/3b/3c)

The original "PR 3 = cleanup" framing turned out to be too coarse. PR
3 (#1591) shipped the dispatcher and bit-identical effect execution
for the **happy paths**, but the legacy `purgeReactionTracking` callsites
were left in place — the shadow `turnEnd` event still fires from inside
that function, and several callsites can't see the authoritative
`turn` object (so `outboundEmitted` falls back to module-scope
`currentTurn` which may already be nulled).

The cleanup PR is therefore being split:

- **PR 3a (#1591) — DONE.** Dispatcher + happy-path effect exec.
  Shadow continues for turn-lifecycle events.
- **PR 3b — turnEnd cutover.** This section.
- **PR 3c — inbound cutover.** The biggest. `handleInbound` constructs
  the inbound Event and dispatches through the machine; the machine's
  `deliverToBridge` / `bufferInbound` effects replace the imperative
  in-handler routing.
- **PR 4 — delete the imperative kill-switch fallback.** Once 3b and
  3c have baked, remove the keep-the-old-path-as-a-fallback branches
  and the redundant primitives listed under PR 3 above.

### PR 3b — turnEnd cutover (current focus)

**Step 1 — refine `outboundEmitted` (prerequisite).** Today
`purgeReactionTracking(key, endingTurn?)` reads `outboundEmitted` from
`endingTurn.replyCalled` if the caller threaded the turn, else falls
back to `currentTurn?.replyCalled`. The canonical, threaded path is
`endCurrentTurnAtomic(turn)` (gateway.ts:1381) — it nulls
`currentTurn`, then passes `turn` explicitly. Legacy bare-purge
callsites can produce **wrong** `outboundEmitted` data in the shadow
trace, which makes the shadow→live cutover (step 2) unsafe.

Per-callsite audit (gateway.ts on `feat/state-machine-turnend-cutover`
worktree, baseline commit a6e48b88):

| Site | Path                          | `turn` in scope? | Recommended migration                                  |
|------|-------------------------------|------------------|--------------------------------------------------------|
| 1601 | `endStatusReaction`           | No               | **Misuse — investigate.** This is called mid-turn from the reply tool (line 4345); it should NOT emit `turnEnd`. Either remove the purge here (`endStatusReaction` is a reaction-state transition, not a turn-end signal) or split `purgeReactionTracking` into reaction-cleanup vs turn-end. The current code emits a premature `turnEnd` shadow event on every reply-tool success. **Highest-priority finding.** |
| 3096 | silence-poke fallback         | `fbKey` only     | No turn object — the silence-poke fired AFTER the original turn was abandoned. Best signal is `outboundEmitted=false` explicitly. Refactor: add an `endingTurn: null` parameter or a `reason: 'silence-fallback'` discriminant so shadow data is unambiguous. |
| 5831 | context-exhaust warning       | Yes (line 5683)  | Route through `endCurrentTurnAtomic(turn)`. This path is mid-turn-error; the canonical pattern handles the race guard + module-state null. Verify `currentTurn === turn` still holds at the call point. |
| 5989 | silent-marker turn finalize   | Yes (line 5862)  | Same — route through `endCurrentTurnAtomic(turn)`. The silent-marker path is a legitimate turn-end, just one that didn't emit visible outbound. |
| 6130 | backstop dedup (post-finalize)| Yes (line 5884)  | Route through `endCurrentTurnAtomic(turn)`. The reply already fired and was deduped — `outboundEmitted=true` is the truthful signal, which `endCurrentTurnAtomic` will read from `turn.replyCalled`. |
| 6258 | turn-flush IIFE finally       | Closure-captured | The IIFE captures `turn` from the enclosing scope. Hoist `endCurrentTurnAtomic(turn)` out of the `finally` so it runs once at the end of the IIFE regardless of send success/failure (the current pattern is right, just needs the canonical primitive). |
| 6265 | turn-flush success            | Yes (line 5884)  | Route through `endCurrentTurnAtomic(turn)`. Adjacent code at 6268 already reads `turn.startedAt`, so scope is unambiguous. This is the dominant happy-path turn-end. |

**Risk profile by site:**
- 1601 is a bug, not just a refinement. Fixing it stops a class of
  bogus shadow events. Highest value.
- 5831 / 5989 / 6130 / 6258 / 6265 are bit-identical refactors if
  `endCurrentTurnAtomic`'s `currentTurn === turn` guard holds — which
  it should, since `purgeReactionTracking` is already doing the
  end-of-turn work and the only difference is the null + race guard.
  Add `expect(currentTurn === turn || currentTurn === null)` assertion
  in dev mode for one bake cycle to verify the invariant before
  trusting it.
- 3096 is the trickiest — needs an explicit "no outbound" signal
  because there's no surviving turn object to read.

**Step 2 — cutover.** Once step 1 lands and the shadow trace shows
correct `outboundEmitted` for ≥48 hours of test-harness + fleet
traffic: flip `shadowEmit({ kind: 'turnEnd', ...})` to
`dispatchEvent({ kind: 'turnEnd', ...})` inside the canonical
`endCurrentTurnAtomic` function (gateway.ts:1389), and remove the
imperative cleanups from `purgeReactionTracking` (the effects array
from the machine now drives them). The other turnEnd-emit callsites
disappear by virtue of step 1's routing through
`endCurrentTurnAtomic`.

**UAT gates before step 2:**
- `jtbd-fast-trivial-dm` (TTFO baseline)
- `jtbd-always-on-after-restart-dm` (post-restart turn semantics)
- `jtbd-memory-survives-restart-dm` (turn lifecycle around restart)
- A new scenario: fire 5 reply-tool calls in a single turn and assert
  exactly ONE `turnEnd` shadow/machine event (catches the line 1601
  bug class).

**Bake:** 48 hours on test-harness, then staggered fleet rollout
behind a `SWITCHROOM_INBOUND_MACHINE_TURNEND=live` env knob defaulting
to `shadow`. Knob removed in PR 4.

### PR 3c — inbound cutover (preview)

`handleInbound`'s imperative `if (currentTurn != null) buffer else
deliver` becomes `dispatch({ kind: 'inboundArrival', ... })` whose
effects array drives the same outcome. Same shadow→live pattern,
same kill-switch env knob. Out of scope for this section; PR 3b
prerequisites must land first.

## What this RFC does NOT cover

- **The boot-time cost** of cold-starting claude + the gateway. The state machine doesn't help; it's pure model-side latency. Tracked separately under "cold-start optimization" (Sprint 4 of the vision-aligned roadmap — defer handoff, async boot card, pre-warm session).
- **Webhook vs polling.** Polling lag (0-3s typical) is upstream of the state machine. Separate decision.
- **PostHog observability dashboards** for the runtime-metrics emitted by the new machine (`logTrace` effect). The state machine emits the trace events; the dashboards consume them — separate workstream.

## Risks + mitigations

- **PR 2 cutover risk**: behavior-equivalence is asserted by every existing UAT, but the property test ONLY asserts invariants — it doesn't prove equivalence to the prior ad-hoc code. If there was an UNDOCUMENTED behavior the prior code had that the new machine doesn't, it'd break silently. *Mitigation*: run PR 2 against the full fuzz scenario suite (already CI-gated) + a 48-hour test-harness bake before merging.
- **State machine becomes the new monolith**: easy to keep growing. *Mitigation*: the invariants are the contract. New features must show how they satisfy or extend the invariants, not just add to the transition function.
- **Polling vs event-driven**: the `tick(now)` event has to be driven by something. Currently the gateway has a setInterval idle-drain timer (#1549). The state machine can use the same trigger or be event-driven externally. *Mitigation*: explicit `tick` effect lets the dispatcher decide; no opinion baked into the machine.

## Open questions

1. **Granularity of `perKey`**: today the machine plans `ChatKey` (chatId+threadId canonical). Should `agentName` factor in? (Multi-agent containers don't currently exist, but if they ever do, the per-key namespace must be wider.)
2. **Property-test breadth**: 10,000 random schedules sufficient? Or use coverage-guided fuzzing (fast-check with shrinking)?
3. **mtcute UAT integration**: a NEW UAT scenario should drive arbitrary inbound schedules against a real agent and assert the runtime-metrics traces match the state machine's predicted effect sequence. This is the bridge between property-tested invariants and live-system contracts.

## Success criteria

- The post-v0.12.22 overlapping-turn silence wedge (currently firing 2x/hour on test-harness) becomes unrepresentable per Invariant #5.
- The wedge cluster class — any variant — fails the property test before reaching the fleet.
- Net code: -200 to -500 lines after PR 3.
- Cold-start TTFO unchanged (this work is about correctness, not speed — cold-start optimization is a separate workstream).
- mtcute UATs `jtbd-always-on-after-restart` and `jtbd-fast-trivial` continue passing.

---

*Ground in `reference/vision.md` (always-on specialist exec-assistants), `reference/know-what-my-agent-is-doing.md` (visibility JTBD), and the memory entries `feedback_5min_restart_wedge_violates_vision.md`, `feedback_gateway_bot_api_allowlist_drift.md`, `project_fleet_update_thundering_herd_wedge.md`.*
