/**
 * Pure decision for the "make a just-persisted grant LIVE" self-restart
 * (the side-effecting `scheduleGrantRestart` in gateway.ts wraps this).
 *
 * Extracted so the gating — kill-switch, self-agent-only, and
 * turn-deferred-vs-now — unit-tests without gateway.ts's boot side-effects
 * (same pattern as scoped-approval.ts / admin-commands/index.ts).
 *
 * Contract (reference/access-model.md): the restart only ever follows an
 * operator-approved, single-agent, additive `tools.allow` edit, and only
 * ever bounces the CALLER's own agent — never a peer, never fleet-wide.
 */
export type GrantRestartDecision = "disabled" | "deferred" | "now";

export function grantRestartDecision(opts: {
  /** SWITCHROOM_AUTORESTART_ON_GRANT value ("0" disables; default on). */
  killSwitch: string | undefined;
  /** The gateway's own agent identity ($SWITCHROOM_AGENT_NAME). */
  selfAgent: string | undefined;
  /** The agent whose config was edited (must equal selfAgent — self only). */
  agentName: string;
  /** Whether a turn is currently in flight (defer the restart to its end). */
  turnInFlight: boolean;
}): GrantRestartDecision {
  if ((opts.killSwitch ?? "") === "0") return "disabled";
  // Self-only: an "Always allow" edits agents.<self>.tools.allow. We never
  // bounce a peer or the fleet from this path.
  if (!opts.selfAgent || opts.selfAgent !== opts.agentName) return "disabled";
  return opts.turnInFlight ? "deferred" : "now";
}
