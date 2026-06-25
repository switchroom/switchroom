---
artefact: bridge presence — guaranteeing always-on inbound delivery
serves: jobs/survive-reboots-and-real-life.md
status: draft v1
---

# RFC: Bridge presence — guaranteeing always-on inbound delivery

> Status: **draft v1** — design contract for the real fix to the
> bridge-flap / bridge-wedge class. Supersedes the two rejected fix
> attempts catalogued in issue #1613. Implementation is gated on the
> "Open questions" section being closed.

## Why this RFC

The Telegram bridge is the relay between `claude` (running the agent)
and the long-lived gateway sidecar. Inbound Telegram messages reach
claude only through a **registered** bridge; when none is registered
the gateway buffers them.

Two production-visible failure modes share one root:

1. **The flap** — bursts of `bridge reconnect race` / `bridge
   disconnected` every ~2s. Ugly; occasionally eats a `turn_end`
   signal; self-heals in 20-30s.
2. **The wedge** — `global=bridge_dead` with buffered inbounds
   stranded for minutes; a turn's completion lost.

Issue #1613 root-caused both and — critically — proved that **the
flap is load-bearing *during active-state channel cycling***: while
claude is cycling bridges (~every 7s during a turn), the flap's
constant reconnect/re-register storm is currently the only thing
keeping a bridge continuously registered. This is a *scoped* claim,
not an unconditional one — see research finding #6: an *idle* agent
holds one stable bridge with no flap at all. The flap is therefore
not needed in general; it is only inadvertently covering the
**active-state handover gap**. The real fix does not need a wholesale
"replacement for the flap" — it needs to **bound that handover gap**.
Two structurally different fixes were built, canary-tested, and
rejected (both removed the flap and, on a saturated host, surfaced
the wedge):

- **`superseded` handshake** (`fix/bridge-stale-socket-close-guard`)
  — gateway tells the prior bridge to stand down. Killed the flap;
  the wedge returned.
- **Remove the zombie-close** (`fix/bridge-flap-remove-zombie-close`)
  — gateway stops force-closing the prior bridge. Killed the flap;
  the wedge returned.

Both confirm the scoped claim above: removing the flap is safe only
if the **active-state handover gap is bounded** — otherwise an inbound
that lands in the gap is delayed (until the next bridge registers, or
until the agent settles to its idle bridge). Bounding that gap — by
measuring it, by tolerating it, or by eliminating it structurally —
is what this RFC designs.

## Background — the architecture

```
 Telegram ──► gateway sidecar ──IPC(UDS)──► bridge ──MCP(stdio)──► claude
              (long-lived,                  (claude's MCP
               start.sh-managed)             subprocess)
```

- The **gateway** is forked by `start.sh`, lives for the container's
  lifetime, owns the IPC server socket, and buffers inbounds.
- The **bridge** (`server:switchroom-telegram`, loaded via
  `claude --dangerously-load-development-channels`) is an MCP server.
  **Claude spawns it as a subprocess and owns its entire lifecycle.**
- Claude's experimental channel layer **cycles** the MCP connection
  roughly every 7s — closing the old bridge's MCP session and
  spawning a fresh bridge process. The old process is given no
  detectable close signal (no stdin EOF, no MCP `onclose`; verified
  against bridge stderr captured in claude's MCP debug logs).

## The core constraint

**The gateway cannot create, keep alive, or directly control a bridge
process.** Claude owns bridge lifecycle completely. Every viable
design must work within this constraint — the gateway can only react
to bridges that connect to its IPC socket.

## What we know (research)

From the #1613 investigation, the two rejected fixes, and the
instrumented canaries:

1. **Claude cycles the channel ~every 7s.** Each cycle = a new bridge
   process; the prior is orphaned without a clean signal.
2. **A bridge process connects to the gateway exactly once** and does
   not self-reconnect within its own lifetime (confirmed by
   nonce-tagged lifecycle instrumentation — each bridge's ipc-client
   logs exactly one `doConnect`/`open`).
3. **The flap is two+ bridge processes ping-ponging:** the gateway's
   #1585 zombie-close force-closes a prior bridge's socket → that
   bridge's ipc-client treats it as a lost connection → reconnects on
   its 2s timer → re-registers → the gateway closes the now-prior
   other client → repeat. Period 2.001s = `reconnectDelayMs`.
4. **The reconnect storm keeps `agentIndex` continuously populated.**
   This is the accidental bridge-presence guarantee. Remove it and,
   when claude's handover leaves a gap, `agentIndex` empties and stays
   empty — the wedge.
5. **The gateway already buffers and drains correctly.** Inbounds
   that arrive while `bridge_dead` are held in `pendingInboundBuffer`
   and flushed by the `drainBuffer` effect on the next `bridgeUp`.
   Buffered inbounds are **not lost** — they are delayed until a
   bridge returns. The open question is whether a bridge always
   returns (see below).
6. **Idle agents hold exactly one stable bridge.** A 4.5-minute
   observation of an idle clean-v0.13.2 agent (16 samples, 17s apart)
   showed `bridgeProcs=1, global=bridge_alive_idle` on *every* sample
   — zero churn, no flap, no cycling. **The ~7s channel cycling is an
   ACTIVE-state behaviour, not an idle one.** When the agent has
   nothing to do it keeps one steady bridge.
7. **The flap and the wedge are active-state phenomena.** They occur
   only during turns / channel activity, when claude cycles bridges.
   An agent that finishes its work returns to the stable single-bridge
   idle state — which means a backlog buffered during active churn
   *will* drain once the agent settles (`bridgeUp` on the stable
   bridge fires `drainBuffer`).
8. **Wedge severity scales with host load.** The canary wedges that
   rejected both prior fixes ran on a host saturated by an all-night
   build+canary session. On a loaded host, claude's bridge spawn is
   slow, so the handover gap stretches from ~1-2s to tens of seconds.
   The prior rejections are therefore **confounded** — they measured
   "remove the flap on a saturated host", not "remove the flap". This
   materially changes the verdict on Option 2 (below).

## Design options

### Option 1 — Decouple bridge lifetime from claude's MCP connection (recommended)

**Make the bridge a long-lived, `start.sh`-managed process** — a
sibling of the gateway, not a claude subprocess. Claude's channel
connects to the already-running bridge; claude cycling its MCP
connection no longer kills the bridge process.

```
 Telegram ─► gateway ─IPC─► bridge (long-lived, start.sh-managed)
                                │
                                └─MCP─► claude   (claude connects/
                                                  disconnects freely;
                                                  bridge process persists)
```

- The bridge keeps **one** persistent IPC connection to the gateway
  for the container's lifetime. `agentIndex` is populated once and
  never churns. No flap, no wedge, no handover gap — structurally.
- When claude's MCP side is down (between cycles), the bridge holds
  inbounds and flushes them when claude's MCP session reconnects.
  The bridge already knows when claude connects (a new MCP session is
  an explicit event) — the flush trigger is clean and detectable,
  unlike the close signal.

**The hard dependency:** claude must be able to connect its channel
to an MCP server it did *not* spawn. With a stdio MCP server claude
always spawns+owns the subprocess. This needs one of:
- a non-stdio MCP transport for the channel (socket/HTTP) that claude
  can dial into a pre-existing listener, **or**
- claude's channel layer supporting an "attach, don't spawn" mode.

**→ This is the first Open Question.** If claude's channel only
supports spawn-a-stdio-subprocess, Option 1 is blocked at the
transport layer and becomes an upstream ask (#1613 Option B).

### Option 2 — Gateway-tolerant delivery (no flap, accept handover gaps)

Keep the bridge as claude's per-cycle subprocess. Remove the flap
(this is exactly `fix/bridge-flap-remove-zombie-close`). Accept a
handover gap on every active-state cycle and rely on the fact that
**the gap is self-closing**:

- During active churn, claude cycles a fresh bridge ~every 7s; every
  new registration fires `bridgeUp` → `drainBuffer`. The buffer
  therefore drains roughly once per cycle even mid-burst.
- When activity ends, the agent returns to the stable single-bridge
  idle state (research finding #6) — a final guaranteed `drainBuffer`.
- The gateway buffer already holds inbounds indefinitely and is
  lossless across the gap; an inbound is *delayed*, never *lost*.

**Re-assessment (post research findings #6-8):** Option 2 was
*rejected* in #1613 — but on a host saturated by the build session,
where claude's bridge spawn was pathologically slow and the handover
gap stretched to tens of seconds. That was not a fair test. On a
healthy host the gap should be ~1-2s, which is well inside tolerance.
**Option 2's rejection is confounded and must be re-evaluated on a
clean host before it is dismissed.**

If a clean-host re-test shows bounded (~1-2s) gaps, Option 2 is the
*pragmatic* fix: it is small (already implemented on the branch),
needs no claude-channel-transport change, and ships fast. Its
residual cost is bounded added latency for an inbound that lands
exactly inside a handover gap during a sustained active burst —
acceptable, and strictly better than the flap.

### Option 3 — Status quo: accept the flap (#1613 Option C)

The flap is survivable: self-heals in 20-30s, occasionally costs one
turn's `turn_end`. It is the only **currently-safe** state and is
where the fleet sits today (v0.13.2). The cost is real but bounded.
This RFC exists to retire Option 3, not endorse it — but it remains
the fallback if Options 1 and 2 both prove infeasible.

### Option 4 — "Sticky bridge": gateway nominates one reconnecting bridge (rejected)

Surfaced in #1613 as "A′". The idea: instead of *all* bridges
reconnecting (the flap), exactly **one** gateway-nominated bridge is
allowed to reconnect-on-drop; the rest stand down. The single sticky
bridge keeps `agentIndex` populated.

**Rejected, on analysis:**

- The gateway's "nomination" has no force. Claude owns every bridge
  process and kills the sticky one on its normal cycle exactly like
  any other — a gateway flag does not stop that.
- Once the sticky bridge is killed, *something* must become the new
  sticky bridge, and there is a gap between "old sticky killed" and
  "new one nominated + reconnecting" — the same handover gap, not
  removed.
- "One bridge reconnects-on-drop" is just a single-participant flap.
  It collapses into Option 1 if "sticky" is made to mean "a
  long-lived process", or into Option 2 if it means "tolerate the
  gap". It is not a distinct third mechanism.

Recorded here so the design history is complete; not pursued.

## Recommendation

The research (findings #6-8) shifts the verdict. **Option 2 is the
recommended first move** — not because it is more elegant than
Option 1, but because it is already built, needs no upstream
dependency, and its only prior rejection is confounded by host
saturation. Validate it cleanly; if it holds, ship it. Option 1
remains the architecturally-purest fix and the right destination if
Option 2's clean re-test still shows unacceptable gaps.

**Sequenced plan:**

1. **Clean-host re-test of Option 2.** On an unloaded host, run the
   `bridge-flap-resilience-dm` UAT against `fix/bridge-flap-remove-
   zombie-close` ≥5× and against clean v0.13.2 ≥5×. Instrument the
   handover-gap distribution (time from current-bridge disconnect to
   next-bridge register). Decision gate:
   - Gaps reliably ≤5s and the UAT passes repeatably → **ship
     Option 2.** Done.
   - Gaps still routinely exceed ~5s on a clean host → Option 2 is
     genuinely insufficient; proceed to step 2.
2. **Option 1**, gated on Open Question 1 (channel transport). If
   claude can attach to a pre-existing MCP server → build the
   long-lived bridge. If not → escalate the upstream ask (#1613
   Option B) and hold at Option 3.
3. Until step 1 or 2 lands, **Option 3 (status quo / accept the
   flap)** stands. The fleet is there now (v0.13.2).

**Why not jump straight to Option 1:** it is a real rearchitecture
(bridge process model, a new MCP transport or an upstream change, a
buffer relocated into the bridge) — weeks of work with an unresolved
upstream dependency. Option 2 is a ~30-line diff that already exists.
If the clean re-test vindicates it, shipping Option 2 retires the
flap *now* and Option 1 becomes a deliberate, unhurried follow-up
rather than an emergency.

## Open questions

The handover-gap measurement is not listed here — it is not an open
*question*, it is a *test task* (step 1 of the plan). The genuine
unknowns:

1. **Channel transport.** Can claude's experimental channel attach to
   an already-running MCP server (socket/HTTP transport, or an
   attach-don't-spawn mode), rather than spawning a stdio subprocess?
   This determines whether Option 1 is buildable in switchroom or
   needs an upstream change.
2. **Bridge re-spawn reliability after active churn ends — the
   gating unknown for Option 2.** Option 2's safety rests entirely on
   the agent always returning to a registered bridge once a burst
   ends. Research finding #6 observed exactly this once (a 4.5-minute
   idle hold) — but *not* across the specific race that matters: the
   moment a turn ends while claude is mid-cycle. Does claude reliably
   re-spawn and keep a bridge after every turn-end, including
   turn-end-during-cycle? If there is any path where claude ends a
   turn and leaves zero bridges indefinitely, Option 2 is unsafe and
   Option 1 is mandatory. The clean-host re-test (step 1) must
   specifically probe turn-end-during-cycle, not just steady idle.
3. **Buffer-drain after marker-sweep.** When a gap outlasts the turn
   marker-sweep (~114s), does the buffered inbound still drain
   correctly on the eventual `bridgeUp`, or does sweep interaction
   drop it? Needs a targeted test.
4. **Inbound ordering across drain.** When `drainBuffer` flushes a
   multi-message backlog, are the inbounds delivered in arrival
   order? A reorder would surface as a user seeing replies out of
   sequence. Needs a targeted test.

## Success criteria

A correct fix:
- (a) eliminates the 2s `reconnect race` flap, **and**
- (b) keeps a bridge continuously registered (or re-registered within
  a few seconds) so no inbound is delayed more than ~5s by bridge
  absence, **and**
- (c) preserves inbound ordering — a backlog drained after a gap is
  delivered in arrival order (OQ4), **and**
- (d) passes `bridge-flap-resilience-dm.test.ts` repeatably on an
  unloaded host (4 rapid DMs, all replied, low `bridge disconnected`
  density), **and**
- (e) survives a 48-hour test-harness bake with zero `bridge_dead`
  episodes longer than 5s.
