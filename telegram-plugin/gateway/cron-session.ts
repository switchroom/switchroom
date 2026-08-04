/**
 * Cheap-cron session identity — reference/rfcs/cheap-cron-sessions.md §3.3.
 *
 * Rather than rekey the gateway's hardened single-bridge machinery
 * (agentIndex / pendingInboundBuffer / handleRegister, each carrying
 * subtle race fixes), a Tier-1 cron fire is routed to a SECOND bridge
 * that registers under a DERIVED identity `<agent>-cron`. To the IPC
 * layer it is "just another agent", so routing, buffering, disconnect,
 * and heartbeat all work unchanged. The gateway gates its SINGLETON
 * status machinery (shadow bridge-state, boot card, currentTurn /
 * progress card / silence-poke) off the cron identity — which IS the
 * §2.4 "cron session is status-silent" requirement, so it is one change,
 * not two.
 *
 * The cron session's bridge sets SWITCHROOM_AGENT_NAME=`<agent>-cron`;
 * the scheduler emits `meta.session='cron'` and the gateway derives the
 * target via `cronIdentity()`. Pure string fns — pinned in cron-session.test.ts.
 */

import type { InboundMessage, GatewayToClient } from './ipc-protocol.js'
import type { InboundSpool } from './inbound-spool.js'
import { redeliverBufferedInbound, type PendingInboundBuffer } from './pending-inbound-buffer.js'

/** Suffix that distinguishes a cron-session bridge from the main agent bridge. */
export const CRON_IDENTITY_SUFFIX = "-cron";

/** Derive the cron-session bridge identity for an agent. */
export function cronIdentity(agent: string): string {
  return `${agent}${CRON_IDENTITY_SUFFIX}`;
}

/** True iff `name` is a cron-session bridge identity (not a main agent bridge). */
export function isCronIdentity(name: string | null | undefined): boolean {
  return typeof name === "string" && name.endsWith(CRON_IDENTITY_SUFFIX);
}

/** The real agent name behind a (possibly cron) identity. */
export function baseAgent(name: string): string {
  return isCronIdentity(name) ? name.slice(0, -CRON_IDENTITY_SUFFIX.length) : name;
}

/**
 * #4172 — is a `reply` tool call arriving on this IPC client identity a
 * FOREIGN-SESSION reply, i.e. one that can NEVER be the main claude session's
 * own (possibly late/reworded) answer to a turn the gateway attributed?
 *
 * The whole flushed-turn supersede/bypass/latch machinery
 * (`outbound-send-path.ts`) rests on the premise that a decoupled late reply
 * resolving an ended turn is that turn's own answer unless a handback marker
 * says otherwise. That premise only holds for replies from the MAIN agent
 * bridge — the one whose session the turns belong to. A Tier-1 cheap-cron
 * fire's reply arrives on the derived `<agent>-cron` bridge: it never mints a
 * gateway turn (its session events are dropped in `onSessionEvent`), never
 * traverses `pendingInboundBuffer.push` (so it cannot stamp the handback
 * marker), and lands decoupled with foreign content — the measured #4172
 * failure was such a reply EDITING OVER a flushed answer (double loss: the
 * flushed answer destroyed, the cron digest delivered as a silent edit).
 * Identity is the one deterministic signal that separates it.
 *
 * Returns true (foreign — refuse supersede/bypass/latch authority, always
 * send fresh) for:
 *   - a cron-session identity (`<agent>-cron`);
 *   - a null/absent identity (an unregistered client — it owns no session,
 *     so fail SAFE: a visible fresh message, never destructive authority).
 * Returns false only for a registered non-cron agent bridge — the main
 * session.
 */
export function replyCallerIsForeignSession(name: string | null | undefined): boolean {
  if (name == null || name === "") return true;
  return isCronIdentity(name);
}

/**
 * True iff an inject_inbound fire is a scheduled cron fire — Tier-1 cheap-cron
 * (`meta.session='cron'`, routed to the derived `<agent>-cron` bridge) OR a
 * Tier-2 full-session cron (`meta.source='cron'`, lands on the main bridge).
 *
 * #3114 — such a fire must NOT stamp the MAIN session's idle-clear clock at
 * inject time. Before #3113, `onInjectInbound` stamped unconditionally so a
 * "working scheduled agent isn't wiped after 3h of no inbound". That is now
 * redundant AND harmful: a cron cadence shorter than `idle_clear_after`
 * re-arms the timer on every fire and keeps idle-clear permanently suppressed
 * for that agent. After #3113 a cron fire that does REAL work already stamps
 * the main clock through `handleSessionEvent` on every genuine session event,
 * so the blanket inject-time stamp buys nothing for main-bridge fires — and a
 * cheap-cron fire (whose session events are dropped for the cron identity in
 * `onSessionEvent`) correctly stops warming the main clock once it is gone.
 *
 * Only cron fires are gated: other synthetic-source injects (reaction, vault
 * grant, resume) reflect genuine operator/session presence and still stamp.
 *
 * DOCUMENTED RESIDUAL (#3114, operator-approved): a Tier-2 cron pinned to the
 * MAIN session (`context:'agent'`) that replies NO_REPLY still runs a real
 * turn on the main bridge, which emits session events → stamps via
 * `handleSessionEvent`. So "a NO_REPLY poll isn't presence" is fully closed
 * only for cheap/derived-bridge crons; an expensive main-session poll still
 * warms the clock because the model genuinely ran. This predicate governs only
 * the inject-time stamp, not the session-event stamp — closing the main-
 * session-poll case would need a separate weaker clock, out of scope here.
 */
export function isCronInjectFire(meta: Record<string, string> | undefined): boolean {
  return meta?.source === "cron" || meta?.session === "cron";
}

/**
 * Resolve the IPC routing target for an inject_inbound. When the fire
 * carries `meta.session='cron'` it goes to the derived cron bridge; every
 * other fire (and all of today's callers) goes to the agent unchanged.
 */
export function resolveInjectTarget(agentName: string, meta: Record<string, string> | undefined): string {
  return meta?.session === "cron" ? cronIdentity(agentName) : agentName;
}

export interface InjectDelivery {
  /** The bridge identity the fire was actually delivered to (or last tried). */
  target: string;
  delivered: boolean;
  /** True iff a Tier-1 (cron) fire fell back to the main agent bridge. */
  fellBackToMain: boolean;
}

/**
 * Deliver an inject with graceful Tier-1 fallback (cheap-crons JTBD: a cron
 * must NEVER be dropped because of tier routing).
 *
 * Tries the routed target via `send` (returns true iff delivered). The
 * cron-session bridge is boot-forked, so a frequent cron added by hot-reload
 * or agent self-authoring has no live `<agent>-cron` bridge until the next
 * restart — and a crashed cron session has none either. When a cron-routed
 * fire isn't delivered, fall back to the MAIN agent bridge so the fire lands
 * now (full session); it routes cheap again once the cron session is up.
 * Cheap when available, never broken. Pure: `send` is injected.
 */
export function deliverInjectWithFallback(
  agentName: string,
  meta: Record<string, string> | undefined,
  send: (target: string) => boolean,
): InjectDelivery {
  const target = resolveInjectTarget(agentName, meta);
  const wantedCron = target !== agentName;
  if (send(target)) return { target, delivered: true, fellBackToMain: false };
  if (wantedCron && send(agentName)) {
    return { target: agentName, delivered: true, fellBackToMain: true };
  }
  return { target, delivered: false, fellBackToMain: false };
}

/** Minimal view of the IPC client the cron-bridge register handler needs.
 *  A structural subset of `IpcClient` so this stays unit-testable without the
 *  gateway's module-load side effects. */
export interface CronBridgeRegisterClient {
  agentName: string | null | undefined;
  send: (msg: GatewayToClient) => void;
}

/**
 * Drain a cheap-cron (`<agent>-cron`) bridge's buffered fires when it
 * registers — the Tier-1 §2.4/§3.3 status-silent path (#4348).
 *
 * The cron bridge is STATUS-SILENT: it must NOT drive the gateway's singleton
 * machinery (shadow bridge-state, warmup, boot card). But it MUST still flush
 * any cron fire buffered+spooled during the boot window — a due tick that
 * arrived before the cron bridge registered.
 *
 * THE BUG (#4348): the pre-fix path did a raw `pendingInboundBuffer.drain()` +
 * `client.send()` loop and returned early WITHOUT ever reaching `spool.ack`.
 * `spool.ack` lives ONLY inside `redeliverBufferedInbound` — the one chokepoint
 * every other drain path (bridgeUp, idle-drain, silence-poke, turn-end) routes
 * through. So the durable spool entry stayed live, boot-replay re-pushed it on
 * the next restart, and the SAME cron fire re-fired: a duplicate delivery
 * bounded only by the 15-min escalation sweep. This was the ONLY drain that
 * bypassed the chokepoint.
 *
 * THE FIX: route the drain through `redeliverBufferedInbound` too, so each
 * delivered fire is spool-acked exactly once and cannot re-fire after a
 * restart. `beforeRedeliver` (the represent-veto) rides along by construction;
 * it self-gates and is a no-op for cron-sourced fires. A `send` throw now
 * re-buffers the fire (lossless) instead of dropping it — strictly safer than
 * the pre-fix best-effort drop and identical to every sibling drain path.
 *
 * Returns the `redeliverBufferedInbound` counts for observability.
 */
export function drainCronBridgeOnRegister(
  client: CronBridgeRegisterClient,
  buffer: PendingInboundBuffer,
  spool?: InboundSpool,
  log?: (line: string) => void,
): { drained: number; redelivered: number; rebuffered: number; retracted: number } {
  // Status-silent handshake ack (unchanged from the pre-fix path).
  client.send({ type: "status", status: "agent_connected" });
  const send = (msg: InboundMessage): boolean => {
    try {
      client.send(msg);
      return true;
    } catch {
      return false;
    }
  };
  const result = redeliverBufferedInbound(buffer, client.agentName ?? "", send, spool);
  if (result.drained > 0 && log != null) {
    log(
      `telegram gateway: cron-bridge drain agent=${client.agentName} ` +
        `drained=${result.drained} redelivered=${result.redelivered} ` +
        `rebuffered=${result.rebuffered}\n`,
    );
  }
  return result;
}
