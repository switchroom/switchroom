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
