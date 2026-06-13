/**
 * Cheap-cron session identity — docs/rfcs/cheap-cron-sessions.md §3.3.
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
