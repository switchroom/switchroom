/**
 * Hostd dispatch helpers for the gateway's self-restart slash-commands
 * (#1175 RFC C, Phase 2). When the operator has opted into
 * `host_control.enabled: true`, /restart, /new, and
 * /update apply route through the per-agent hostd UDS instead of the
 * in-container `spawnSwitchroomDetached` shellout.
 *
 * Rationale: in docker-mode (the v0.7+ default) the agent container
 * has no docker binary and no `/var/run/docker.sock` — so the
 * spawn-path verbs fail with exit-127 the moment they touch compose.
 * Hostd runs on the host with the docker socket mounted, so the verbs
 * actually work.
 *
 * Extracted from gateway.ts for unit-testability — gateway.ts itself
 * has too many boot-time side-effects to import directly in a test.
 */
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { hostdRequest } from "../../src/host-control/client.js";
import type {
  HostdRequest,
  HostdResponse,
} from "../../src/host-control/protocol.js";
import { loadConfig as loadSwitchroomConfig } from "../../src/config/loader.js";

let _hostdEnabled: boolean | undefined;

/**
 * Reads `host_control.enabled` from the resolved switchroom config.
 * Cached for the gateway's lifetime — config doesn't change without a
 * restart, and the file-read isn't free.
 *
 * Default-on since the RFC C Phase 2 default-flip: the schema gives
 * `host_control.enabled` a `.default(true)` and the block itself a
 * `.default({})`, so any config parsed through Zod will have the
 * field populated. We use `!== false` semantics here so this helper
 * also matches the default-on view on paths that bypass the parser
 * (tests with partial mocks, code that constructs configs directly).
 *
 * Best-effort: if the config can't be loaded (gateway running in a
 * dir where loadConfig fails), returns false so the dispatch helper
 * falls through to the legacy spawn path — better to fail closed
 * than to attempt a hostd RPC against a daemon that might not exist.
 */
export function isHostdEnabled(): boolean {
  if (_hostdEnabled !== undefined) return _hostdEnabled;
  try {
    const cfg = loadSwitchroomConfig();
    _hostdEnabled = cfg.host_control?.enabled !== false;
  } catch {
    _hostdEnabled = false;
  }
  return _hostdEnabled;
}

/** @internal Reset the cache so tests can swap config and re-probe. */
export function _resetHostdEnabledCache(): void {
  _hostdEnabled = undefined;
}

export function hostdSocketPath(agentName: string): string {
  return `/run/switchroom/hostd/${agentName}/sock`;
}

/**
 * True only when (a) host_control is enabled in config AND (b) the
 * per-agent socket is bound on disk. Distinct from "will the wire call
 * succeed" — that's only knowable after attempting it.
 *
 * Callers use this to decide *whether to skip docker-availability
 * preflight guards* (since hostd doesn't need in-container docker).
 */
export function hostdWillBeUsed(agentName: string): boolean {
  if (!isHostdEnabled()) return false;
  return existsSync(hostdSocketPath(agentName));
}

/**
 * Send one request to the per-agent hostd socket.
 *
 * Returns:
 *   - `"not-configured"` — hostd is disabled in config OR the per-agent
 *     socket isn't bound. Callers should fall back to the legacy
 *     `spawnSwitchroomDetached` path.
 *   - `HostdResponse` — hostd was contacted. Callers branch on
 *     `resp.result`. Wire errors (ECONNREFUSED, timeout, bad frame)
 *     are synthesized into a `result: "error"` response so callers
 *     don't need a separate try/catch around the failure.
 *
 * Deliberately no silent fallback to spawn when hostd is configured-on
 * but returns error/denied: the operator opted in, so masking failures
 * would just confuse them about why the verb didn't actually run.
 */
export async function tryHostdDispatch(
  agentName: string,
  req: HostdRequest,
  timeoutMs = 5000,
): Promise<HostdResponse | "not-configured"> {
  if (!isHostdEnabled()) return "not-configured";
  const sockPath = hostdSocketPath(agentName);
  if (!existsSync(sockPath)) return "not-configured";
  try {
    return await hostdRequest(
      { socketPath: sockPath, timeoutMs },
      req,
    );
  } catch (err) {
    process.stderr.write(
      `telegram gateway: hostd dispatch failed ` +
        `(request_id=${req.request_id} op=${req.op}): ` +
        `${(err as Error).message}\n`,
    );
    return {
      v: 1,
      request_id: req.request_id,
      result: "error",
      exit_code: null,
      duration_ms: 0,
      error: `hostd wire error: ${(err as Error).message}`,
    };
  }
}

export function hostdRequestId(prefix: string): string {
  return `${prefix}-${Date.now()}-${randomBytes(4).toString("hex")}`;
}

/**
 * Single-shot `get_status` snapshot for `targetRequestId` (NOT a
 * poll-until-terminal — {@link pollHostdStatus} does that). Used by
 * the framework silence-fallback to render a deterministic in-flight
 * status line. Returns `"not-configured"` (hostd off / socket absent)
 * or `"unavailable"` (wire error / hostd couldn't answer) so the
 * caller can cleanly fall back to the generic fallback text — never
 * throws, never blocks the fallback.
 */
export async function hostdGetStatusOnce(
  agentName: string,
  targetRequestId: string,
): Promise<HostdResponse | "not-configured" | "unavailable"> {
  if (!isHostdEnabled()) return "not-configured";
  const sockPath = hostdSocketPath(agentName);
  if (!existsSync(sockPath)) return "not-configured";
  try {
    const resp = await hostdRequest(
      { socketPath: sockPath, timeoutMs: 3000 },
      {
        v: 1,
        op: "get_status",
        request_id: hostdRequestId("gw-poke-status"),
        args: { target_request_id: targetRequestId },
      },
    );
    // hostd answered but couldn't resolve the entry → treat as
    // unavailable so we degrade to the generic fallback, not a
    // confusing "error" status line.
    if (resp.result === "denied" || resp.result === "error") {
      return "unavailable";
    }
    return resp;
  } catch {
    return "unavailable";
  }
}

/**
 * Poll hostd's `get_status` verb until the target request reaches a
 * terminal state (`completed` / `error` / `denied`) or the caller's
 * timeout elapses.
 *
 * Motivation: the long-running mutating verbs (`update_apply`, `apply`)
 * respond `result: "started"` immediately and run the work in a
 * detached child on the daemon side. Without polling, callers that
 * acked "started" to the operator have no way to surface a *fail
 * before recreate* (image-pull error, scaffold regeneration crash,
 * etc.) — the gateway dies if recreate succeeds, but stays alive and
 * silent if it fails. Polling closes that observability hole.
 *
 * Behaviour:
 *   - Polls every {@link opts.intervalMs} ms (default 2000 per RFC C §5.3).
 *   - Bails out after {@link opts.timeoutMs} with a synthesized
 *     `result: "error"` response describing the timeout. Caller should
 *     treat that as inconclusive — for `update_apply` specifically,
 *     a timeout often means the recreate succeeded and killed the
 *     gateway; the *new* gateway's post-restart greeting card is the
 *     true success signal.
 *   - Any terminal state from the daemon (`completed`/`error`/`denied`)
 *     bails immediately and returns that response. Wire errors are
 *     synthesized by {@link tryHostdDispatch} as `result: "error"`,
 *     which also bails — there's no separate retry on transient wire
 *     failures because (a) the daemon doesn't actually go down except
 *     during a recreate that kills us anyway, and (b) waiting until
 *     timeout to surface a clear error is worse UX than surfacing it
 *     immediately.
 *   - Returns immediately if hostd is unconfigured (treats as
 *     `not-configured`, same as {@link tryHostdDispatch}).
 */
export async function pollHostdStatus(
  agentName: string,
  targetRequestId: string,
  opts: {
    /** Hard cap. update_apply: 60_000; apply: 30_000. */
    timeoutMs: number;
    /** Default 2000. */
    intervalMs?: number;
    /** Test seam — defaults to `Date.now`. */
    now?: () => number;
    /** Test seam — defaults to `setTimeout`. */
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<HostdResponse | "not-configured"> {
  if (!isHostdEnabled()) return "not-configured";
  const sockPath = hostdSocketPath(agentName);
  if (!existsSync(sockPath)) return "not-configured";
  const now = opts.now ?? Date.now;
  const sleep =
    opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const intervalMs = opts.intervalMs ?? 2000;
  const deadline = now() + opts.timeoutMs;
  // Initial wait — the caller just sent the kick-off request. Give the
  // daemon a tick to begin work before the first poll.
  await sleep(intervalMs);
  while (now() < deadline) {
    const pollId = hostdRequestId("gw-poll");
    const resp = await tryHostdDispatch(agentName, {
      v: 1,
      op: "get_status",
      request_id: pollId,
      args: { target_request_id: targetRequestId },
    });
    if (resp === "not-configured") {
      // Socket disappeared mid-poll — daemon was stopped. Surface that
      // distinctly from a target-request error so callers can decide
      // whether to retry or bail.
      return resp;
    }
    // get_status returns the StatusEntry's result, which IS the target
    // request's result. Any terminal state (completed/error/denied) is
    // the target's final answer — bail with it. The previous draft of
    // this helper retried on `error`/`denied` in case the daemon was
    // transiently busy; that policy masked real errors as
    // "still polling" until the 60s cap, then synthesized a misleading
    // "timeout" response. Bailing immediately surfaces the daemon's
    // audit-log truth directly to the operator.
    if (
      resp.result === "completed" ||
      resp.result === "error" ||
      resp.result === "denied"
    ) {
      return resp;
    }
    // result: "started" — get_status reflects the latest StatusEntry,
    // which is still `started` until the daemon's mutation finishes.
    // Keep polling.
    await sleep(intervalMs);
  }
  return {
    v: 1,
    request_id: hostdRequestId("gw-poll-timeout"),
    result: "error",
    exit_code: null,
    duration_ms: opts.timeoutMs,
    error:
      `hostd poll timeout after ${opts.timeoutMs}ms waiting for ` +
      `target_request_id=${targetRequestId}`,
  };
}

/**
 * Emit a one-line operator-visible deprecation warning when a verb that
 * hostd supports is being dispatched via the legacy spawn path. Quiet
 * by design — operators see it once per verb per process in journald,
 * never in chat. RFC C §7 Phase 2 → Phase 3.
 */
const _deprecationSeen = new Set<string>();
export function warnLegacySpawnIfHostdDisabled(verb: string): void {
  if (isHostdEnabled()) return;
  if (_deprecationSeen.has(verb)) return;
  _deprecationSeen.add(verb);
  process.stderr.write(
    `telegram gateway: spawnSwitchroomDetached(${verb}) — set ` +
      `host_control.enabled: true and run \`switchroom hostd install\` ` +
      `to route through audited hostd. Legacy path scheduled for ` +
      `removal in v0.10 (RFC C Phase 3).\n`,
  );
}

/** @internal Reset both caches so tests can re-assert behaviour. */
export function _resetDeprecationSeen(): void {
  _deprecationSeen.clear();
}
