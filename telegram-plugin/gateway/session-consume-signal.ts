/**
 * session-consume-signal.ts — "did the claude session consume input after T?"
 *
 * Built for the 2026-08-02 klanker false-orphan incident (handback turnId
 * `#1785628912223`). A background worker's `subagent_handback` was released and
 * DELIVERED to the bridge at 00:01:53Z; the session consumed it and answered it
 * (a `reply` tool call at 00:02:58Z, IPC-observed, while the gateway's shadow
 * state was `bridge_alive_idle`) — but NO gateway turn ever minted for it: the
 * session-tail produced no `enqueue`/stream events for that consumption, so
 * `handback-preturn-signal`'s entry was never adopted. After the delivered TTL
 * the reap declared a genuine orphan and RE-INJECTED the already-answered
 * handback — twice — re-processing the same worker report three times.
 *
 * The orphan reap's existing gates (`isClaudeBusy`, the delivered TTL) key off
 * gateway-minted TURN state, which is exactly the signal that was absent. This
 * module tracks the two consumption proxies the gateway CAN always observe,
 * independent of the session-tail:
 *
 *   - a TURN MINT (the `enqueue` seam in stream-render): claude holds a single
 *     FIFO input queue, so a turn minting for an inbound delivered AFTER the
 *     handback proves everything delivered before it entered the model's
 *     context (2026-08-02: real turn `#25821` minted 00:04:13Z and completed,
 *     while the reap still declared the 00:01:53Z handback orphaned);
 *   - a MAIN-SESSION MCP TOOL CALL over the IPC bridge (reply, progress_update,
 *     …): the session can only produce a tool call by processing input, so a
 *     tool call arriving after the delivery is direct evidence the session is
 *     alive and consuming — the 00:02:58Z reply was the ONLY observable trace
 *     of the invisible consumption. Cron/foreign sessions are excluded at the
 *     call site (their activity says nothing about the main session's queue).
 *
 * Consumers ask `activitySince(deliveredAt)`. The deliberate trade: when this
 * returns true for a handback that was in fact DROPPED before reaching claude
 * (bridge death in the release→write window) while unrelated session activity
 * happened to occur, the reap now cleans up instead of re-injecting — a lost
 * recovery for a rare double-fault, logged distinctly for fleet-health. The
 * previous behaviour re-injected an already-answered handback on every
 * invisible consumption, which is the incident that actually occurs.
 *
 * Pure state, no I/O; module singleton mirrors `subagentReplyAuthority`.
 */

export class SessionConsumeSignal {
  private lastTurnMintAt = 0
  private lastMainToolCallAt = 0

  /** A gateway turn minted at the `enqueue` seam (stream-render). */
  noteTurnMint(now: number = Date.now()): void {
    if (now > this.lastTurnMintAt) this.lastTurnMintAt = now
  }

  /** A NON-CRON client's MCP tool call arrived over the IPC bridge. The call
   *  site excludes cron identities — a Tier-1 cheap-cron session consuming its
   *  own input proves nothing about the main session's queue. */
  noteMainToolCall(now: number = Date.now()): void {
    if (now > this.lastMainToolCallAt) this.lastMainToolCallAt = now
  }

  /** True IFF either consumption proxy was observed strictly after `sinceTs`. */
  activitySince(sinceTs: number): boolean {
    return this.lastTurnMintAt > sinceTs || this.lastMainToolCallAt > sinceTs
  }

  /** Test-only: forget all observations. */
  reset(): void {
    this.lastTurnMintAt = 0
    this.lastMainToolCallAt = 0
  }
}

/** The ONE live instance (one CLI session per gateway process — the same
 *  module-singleton shape as `subagentReplyAuthority`). */
export const sessionConsumeSignal = new SessionConsumeSignal()
