/**
 * Read-only hostd helpers for the dashboard.
 *
 * The dashboard ships as a DELIBERATELY dockerless container
 * (`switchroom-web`, operator uid, no docker binary/socket — security
 * hardening, do not change). That makes three things impossible from the
 * web vantage: reading agent uptime/memory (`docker inspect`/`stats`),
 * reading agent logs (`docker logs`), and reading each agent's 0600
 * `schedule.d/*.yaml` cron overlays (owned by the agent container UID →
 * operator/web gets EACCES). hostd runs as root with the docker socket
 * AND `~/.switchroom` mounted, so it can do all three.
 *
 * These helpers talk to hostd over the OPERATOR socket — which
 * `checkGate` leaves ungated (the operator is root-equivalent on its own
 * host) — so the new read-only verbs need no auth plumbing here. Every
 * helper NEVER throws: an unreachable daemon / timeout / bad payload
 * degrades to `null`, and the caller falls back to its dockerless path
 * (or surfaces an actionable "needs hostd" message). The web must never
 * 500 just because hostd is down.
 */

import { hostdRequest } from "../host-control/client.js";
import type { HostdRequest, HostdResponse } from "../host-control/protocol.js";
import { resolveHostdOperatorSocket } from "./hostd-config-propose.js";
import type { AgentStatus } from "../agents/lifecycle.js";
import type { SchedulerEntry, DispatchResult } from "../scheduler/dispatch.js";

/** Default timeout for the (fast, read-only) hostd round-trip. The 10s
 *  dashboard poll cadence means we want this well under that. */
const READ_TIMEOUT_MS = 4000;

/** Monotonic-ish request id for a one-shot read. */
function readRequestId(verb: string): string {
  return `web-${verb}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

export interface HostdReadOpts {
  /** Override the resolved operator socket (tests). When the function
   *  receives `undefined` it resolves via `resolveHostdOperatorSocket()`;
   *  pass `null` to force the "unreachable" branch. */
  socketPath?: string | null;
  timeoutMs?: number;
  /** Injectable hostd transport (tests). Defaults to the real client. */
  send?: typeof hostdRequest;
}

/**
 * The fleet docker status, keyed by agent name. Mirrors
 * {@link AgentStatus} minus `pid` (the dashboard doesn't render it). Used
 * to backfill uptime/memory the dockerless web container can't read.
 * Returns `null` when hostd is unreachable / the payload is unusable —
 * the caller then keeps its dockerless `.bridge-alive`-derived view.
 */
export async function fetchFleetStatusViaHostd(
  opts: HostdReadOpts = {},
): Promise<Record<string, AgentStatus> | null> {
  const socketPath =
    opts.socketPath !== undefined ? opts.socketPath : resolveHostdOperatorSocket();
  if (!socketPath) return null;
  const send = opts.send ?? hostdRequest;
  const req: HostdRequest = {
    v: 1,
    op: "agent_status",
    request_id: readRequestId("agent_status"),
    args: {},
  };
  try {
    const resp: HostdResponse = await send(
      { socketPath, timeoutMs: opts.timeoutMs ?? READ_TIMEOUT_MS },
      req,
    );
    if (resp.result !== "completed" || !resp.payload) return null;
    const parsed = JSON.parse(resp.payload) as {
      statuses?: Record<string, AgentStatus>;
    };
    if (!parsed || typeof parsed !== "object" || !parsed.statuses) return null;
    return parsed.statuses;
  } catch {
    // Unreachable / timeout / bad-JSON / wrong-shape — degrade.
    return null;
  }
}

/**
 * The cascade-resolved cron schedule + recent fires, read FRESH by hostd
 * (so the 0600 `schedule.d` overlays are merged). Returns `null` when
 * hostd is unreachable / payload unusable — the caller then falls back to
 * the base-config-only `collectScheduleEntries`.
 */
export async function fetchScheduleViaHostd(
  opts: HostdReadOpts = {},
): Promise<{
  entries: SchedulerEntry[];
  recentByAgent: Record<string, DispatchResult[]>;
  /** True when hostd shed entries/fires to fit the response frame. */
  truncated?: boolean;
} | null> {
  const socketPath =
    opts.socketPath !== undefined ? opts.socketPath : resolveHostdOperatorSocket();
  if (!socketPath) return null;
  const send = opts.send ?? hostdRequest;
  const req: HostdRequest = {
    v: 1,
    op: "agent_schedule",
    request_id: readRequestId("agent_schedule"),
    args: {},
  };
  try {
    const resp: HostdResponse = await send(
      { socketPath, timeoutMs: opts.timeoutMs ?? READ_TIMEOUT_MS },
      req,
    );
    if (resp.result !== "completed" || !resp.payload) return null;
    const parsed = JSON.parse(resp.payload) as {
      entries?: SchedulerEntry[];
      recentByAgent?: Record<string, DispatchResult[]>;
      truncated?: boolean;
    };
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.entries)) {
      return null;
    }
    return {
      entries: parsed.entries,
      recentByAgent: parsed.recentByAgent ?? {},
      ...(parsed.truncated ? { truncated: true } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Read a peer agent's container logs via the EXISTING `agent_logs` hostd
 * verb (the dockerless web container can't `docker logs`). Returns the
 * combined stdout tail (hostd's `docker logs` already merges streams) or
 * an actionable error when hostd is unreachable. Never throws.
 */
export async function fetchAgentLogsViaHostd(
  name: string,
  lines: number,
  opts: HostdReadOpts = {},
): Promise<{ ok: true; logs: string } | { ok: false; error: string }> {
  const socketPath =
    opts.socketPath !== undefined ? opts.socketPath : resolveHostdOperatorSocket();
  if (!socketPath) {
    return { ok: false, error: HOSTD_UNREACHABLE_LOGS_MESSAGE };
  }
  const send = opts.send ?? hostdRequest;
  // hostd's agent_logs caps `tail` at 2000; clamp to the schema bound.
  const tail = Math.max(1, Math.min(lines, 2000));
  const req: HostdRequest = {
    v: 1,
    op: "agent_logs",
    request_id: readRequestId("agent_logs"),
    args: { name, tail },
  };
  try {
    const resp: HostdResponse = await send(
      { socketPath, timeoutMs: opts.timeoutMs ?? READ_TIMEOUT_MS },
      req,
    );
    if (resp.result === "completed") {
      return { ok: true, logs: resp.stdout_tail ?? "" };
    }
    // denied / error — surface hostd's reason if it gave one.
    return {
      ok: false,
      error: resp.error ?? `hostd agent_logs returned '${resp.result}'`,
    };
  } catch {
    return { ok: false, error: HOSTD_UNREACHABLE_LOGS_MESSAGE };
  }
}

/** Actionable error shown when logs can't be read because hostd is down.
 *  The dashboard container has no docker access BY DESIGN, so this points
 *  the operator at the real levers rather than leaking `spawn docker
 *  ENOENT`. */
export const HOSTD_UNREACHABLE_LOGS_MESSAGE =
  "Logs need hostd (the dashboard container has no docker access by design). " +
  "Ensure host_control is enabled, or run `switchroom agent logs <name>` on the host.";

/** Actionable error shown when agent CONTROL (restart) can't reach hostd.
 *  The dashboard container has no docker BY DESIGN, so a restart cannot
 *  `docker` directly — it must go through hostd's `agent_restart` verb.
 *  When hostd is down/unconfigured we point the operator at the real
 *  levers rather than leaking `spawn docker ENOENT`. */
export const HOSTD_UNREACHABLE_CONTROL_MESSAGE =
  "Agent control needs hostd (the dashboard container has no docker access by design). " +
  "Ensure host_control is enabled, or run `switchroom agent restart <name>` on the host.";

export interface RestartViaHostdOpts extends HostdReadOpts {
  /** Operator-visible reason rendered into the hostd audit row. */
  reason?: string;
  /** Bypass safety prompts on the host-side CLI. Defaults true (the
   *  dashboard restart is an explicit operator click). */
  force?: boolean;
}

/**
 * Restart a peer agent via hostd's EXISTING `agent_restart` verb. The
 * dockerless web container can't `docker` — so the dashboard's Restart
 * button routes here instead of shelling docker (which `spawn`s ENOENT).
 *
 * The verb is reached over the OPERATOR socket, which `checkGate` leaves
 * ungated — so restart from the dashboard acts immediately (the operator
 * chose ungated for restart; start/stop are a separate approval-gated PR).
 *
 * Never throws. Maps:
 *   - `completed` / `started` → `{ ok: true }` (restart is async — hostd
 *     returns `started` after spawning the recreate; that IS success).
 *   - `denied` / `error`      → `{ ok: false, error: <hostd reason> }`.
 *   - null socket / transport throw → `{ ok: false, error: <actionable> }`.
 */
export async function restartAgentViaHostd(
  name: string,
  opts: RestartViaHostdOpts = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
  const socketPath =
    opts.socketPath !== undefined ? opts.socketPath : resolveHostdOperatorSocket();
  if (!socketPath) {
    return { ok: false, error: HOSTD_UNREACHABLE_CONTROL_MESSAGE };
  }
  const send = opts.send ?? hostdRequest;
  const req: HostdRequest = {
    v: 1,
    op: "agent_restart",
    request_id: readRequestId("agent_restart"),
    args: {
      name,
      reason: opts.reason ?? "restart requested from dashboard",
      force: opts.force ?? true,
    },
  };
  try {
    const resp: HostdResponse = await send(
      { socketPath, timeoutMs: opts.timeoutMs ?? READ_TIMEOUT_MS },
      req,
    );
    // `started` is the expected happy path: hostd spawns the recreate
    // detached and acks immediately. `completed` covers a fast synchronous
    // finish. Either is success.
    if (resp.result === "completed" || resp.result === "started") {
      return { ok: true };
    }
    return {
      ok: false,
      error: resp.error ?? `hostd agent_restart returned '${resp.result}'`,
    };
  } catch {
    return { ok: false, error: HOSTD_UNREACHABLE_CONTROL_MESSAGE };
  }
}
