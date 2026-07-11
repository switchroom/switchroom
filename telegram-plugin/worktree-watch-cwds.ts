/**
 * Ownership filter for the worktree-isolated cwds the subagent-watcher should
 * additionally watch (deterministic-turn-liveness.md Known Gap 2 + the #2893
 * ownership-predicate review fix + the #1116 / #2893 durable-identity fix).
 *
 * A sub-agent dispatched into a `switchroom worktree claim` cwd runs under a
 * different project-dir slug than the agent's own `agentCwd`, so the #1116
 * foreign-slug filter would skip it forever unless the watcher also watches
 * the slugs of worktrees THIS agent owns. This helper derives that set from
 * the host-global worktree registry, filtered by the agent's own identity.
 *
 * Identity resolution is two-tier (durable fix for the gap where a worktree
 * worker whose identity can't be attributed gets NO live progress feed):
 *
 *   1. FAST PATH — `self` (`process.env.SWITCHROOM_AGENT_NAME`). Set
 *      authoritatively by compose env (compose.ts) AND hoisted in start.sh
 *      before the gateway fork, so this is present in the overwhelming
 *      majority of runs.
 *   2. DURABLE FALLBACK — when `self` is unset/empty, derive the identity
 *      from `agentDir` (the agent's own directory, itself derived from
 *      `TELEGRAM_STATE_DIR` = `<agentDir>/telegram`, which the gateway
 *      already requires to be present before it even starts the watcher).
 *      The basename of `agentDir` is `resolve(agents_dir, <name>)`'s leaf —
 *      i.e. this agent's OWN name. This can only ever resolve to THIS
 *      agent's identity, never another agent's, so it cannot mis-attribute:
 *      a wrong basename matches zero registry records (fail-closed), it
 *      never matches a DIFFERENT owner. Env is just the fast path; ownership
 *      resolves correctly from durable config when env is missing.
 *
 * Fail-CLOSED, deliberately, and never mis-attributing:
 *
 *   - Owner match ⇒ include, realpath'd. Claude Code mints the project slug
 *     off the process's PHYSICAL cwd, so a symlinked base (macOS `/tmp` →
 *     `/private/tmp`) would otherwise derive a slug that misses the physical
 *     one; realpath best-effort, falling back to the raw path.
 *   - Ownerless registry records (`ownerAgent` undefined) are NEVER matched,
 *     even with identity set — a naive `undefined === undefined` would leak
 *     every other agent's ownerless worktree (the #1116 leak this exists to
 *     prevent).
 *   - A registry read failure ⇒ `[]` (best-effort; never disturb the base
 *     agentCwd watch).
 *   - BOTH env AND agentDir-derived identity unavailable ⇒ `[]` (same
 *     fail-closed contract as before this fix — we never guess) but escalate
 *     the log from the #2893 one-shot warn to a clear ERROR naming that
 *     identity resolution fully failed, so the lost live feed is diagnosable.
 *     Never throws, never mis-attributes.
 */
import { realpathSync } from "node:fs";
import { basename } from "node:path";

export interface WorktreeOwnershipRecord {
  path: string;
  ownerAgent?: string;
}

export interface OwnedWorktreeCwdsOptions {
  /** The agent's identity — `process.env.SWITCHROOM_AGENT_NAME` (fast path). */
  self: string | undefined;
  /** The host-global registry read (`listRecords` from src/worktree/registry). */
  listRecords: () => WorktreeOwnershipRecord[];
  /**
   * Durable, non-env fallback source for identity: the agent's OWN directory
   * (`resolveAgentDirFromEnv()` in the gateway). When `self` is unset/empty,
   * the identity is derived as `basename(agentDir)`. Omit to disable the
   * fallback (the pre-fix, env-only behaviour — used by the kill-switch).
   */
  agentDir?: string | null;
  /** Injectable for tests; defaults to `fs.realpathSync`. */
  realpath?: (p: string) => string;
  /**
   * Injectable derivation of the agent name from `agentDir`. Defaults to
   * `path.basename`. Returns "" when it cannot derive a usable name.
   */
  deriveName?: (agentDir: string) => string;
  /** Escalated-failure sink (both identity sources unavailable). */
  log?: (msg: string) => void;
}

// One-shot guard so the escalated "identity fully unresolved" ERROR is emitted
// ONCE per process rather than every rescan tick (the provider is re-invoked on
// every tick). Mirrors the #2893 one-shot-warn ethos; exported reset for tests.
let identityEscalated = false;
export function __resetIdentityEscalationForTests(): void {
  identityEscalated = false;
}

function defaultDeriveName(agentDir: string): string {
  if (!agentDir || agentDir.trim().length === 0) return "";
  const leaf = basename(agentDir).trim();
  return leaf;
}

/**
 * Two-tier owner-identity resolution shared by `ownedWorktreeCwds` and
 * `refreshOwnedWorktreeHeartbeats`:
 *   Tier 1 — env fast path (`SWITCHROOM_AGENT_NAME`).
 *   Tier 2 — durable fallback derived from the agent's OWN directory basename.
 * Returns "" when neither source yields a usable identity — callers MUST treat
 * "" as fail-closed (never guess ownership).
 */
export function resolveOwnerIdentity(
  self: string | undefined,
  agentDir: string | null | undefined,
  deriveName?: (agentDir: string) => string,
): string {
  let resolved: string = self != null ? self : "";
  if (resolved === "" && agentDir != null && agentDir !== "") {
    const derive = deriveName ?? defaultDeriveName;
    resolved = derive(agentDir) || "";
  }
  return resolved;
}

export function ownedWorktreeCwds(opts: OwnedWorktreeCwdsOptions): string[] {
  // Tier 1: env fast path. Tier 2: durable agentDir-derived fallback.
  const resolved = resolveOwnerIdentity(opts.self, opts.agentDir, opts.deriveName);

  if (resolved === "") {
    // Both env and durable config unavailable. Keep the historical
    // fail-closed contract (return [] — never guess, never mis-attribute) but
    // ESCALATE past the #2893 one-shot warn: name that identity resolution
    // fully failed and the live worktree-worker feed is lost for this run.
    if (!identityEscalated) {
      identityEscalated = true;
      opts.log?.(
        "ERROR: worktree identity resolution FAILED — both " +
          "SWITCHROOM_AGENT_NAME and the agentDir-derived fallback are " +
          "unavailable. Worktree ownership cannot be attributed; a " +
          "worktree-isolated background sub-agent will get NO live progress " +
          "feed this run (its registry row is still reaped by the 1h safety " +
          "net). This is a configuration fault, not a transient error.",
      );
    }
    return [];
  }

  const rp = opts.realpath ?? realpathSync;
  try {
    return opts
      .listRecords()
      .filter((r) => r.ownerAgent === resolved)
      .map((r) => {
        try {
          return rp(r.path);
        } catch {
          return r.path;
        }
      });
  } catch {
    return [];
  }
}

/**
 * Default minimum interval (ms) between heartbeat writes for the same
 * worktree record. The gateway invokes the refresh on every ~1s rescan tick;
 * writing every tick would be needless churn. Refreshing at most every 2 min
 * keeps every live claim's heartbeat FAR fresher than the reaper's 10-min
 * `STALE_THRESHOLD_MS`, so a live claim never reads as stale, while a dead
 * gateway (no ticks) lets the heartbeat age out and become reap-eligible.
 */
export const DEFAULT_HEARTBEAT_REFRESH_INTERVAL_MS = 2 * 60_000;

/** Minimal record shape needed to refresh a worktree heartbeat. */
export interface WorktreeHeartbeatRecord {
  id: string;
  ownerAgent?: string;
  /** ISO 8601 timestamp of the record's current heartbeat (for throttling). */
  heartbeatAt?: string;
}

export interface RefreshOwnedHeartbeatsOptions {
  /** The agent's identity — `process.env.SWITCHROOM_AGENT_NAME` (fast path). */
  self: string | undefined;
  /** Durable, non-env identity fallback: the agent's OWN directory. */
  agentDir?: string | null;
  /** Host-global registry read (`listRecords` from src/worktree/registry). */
  listRecords: () => WorktreeHeartbeatRecord[];
  /** Advance one record's heartbeat (`touchHeartbeat` from the registry). */
  touchHeartbeat: (id: string) => void;
  /**
   * Skip a touch while the record's heartbeat is younger than this (ms).
   * Defaults to `DEFAULT_HEARTBEAT_REFRESH_INTERVAL_MS`. Set to 0 to always
   * touch (used by tests).
   */
  minRefreshIntervalMs?: number;
  /** `Date.now` override for tests. */
  now?: () => number;
  /** Injectable name derivation (defaults to `path.basename`). */
  deriveName?: (agentDir: string) => string;
  /** Best-effort error sink. */
  log?: (msg: string) => void;
}

/**
 * Refresh the heartbeat of every worktree THIS agent owns.
 *
 * This is the production driver that keeps `touchHeartbeat` (previously dead —
 * F1/H3) alive: the gateway calls it on the same rescan tick that re-derives
 * the watched worktree cwds, so a claim held by a LIVE agent has its heartbeat
 * advanced continuously and never trips the reaper's staleness gate. When the
 * owning gateway dies, the ticks stop, the heartbeat ages past
 * `STALE_THRESHOLD_MS`, and the (now fail-safe) reaper can reclaim the truly
 * abandoned claim.
 *
 * Fail-CLOSED, mirroring `ownedWorktreeCwds`:
 *   - Unresolved identity ⇒ touch nothing (never guess ownership).
 *   - Ownerless records (`ownerAgent` undefined) are NEVER matched — we must
 *     not advance another agent's / an unattributable claim's heartbeat.
 *   - A registry read failure ⇒ touch nothing.
 *   - A per-record touch failure is swallowed (logged) — one bad record must
 *     not abort the rest, and this runs on the hot watch loop.
 *
 * @returns the number of heartbeats actually advanced this call.
 */
export function refreshOwnedWorktreeHeartbeats(
  opts: RefreshOwnedHeartbeatsOptions,
): number {
  const identity = resolveOwnerIdentity(opts.self, opts.agentDir, opts.deriveName);
  if (identity === "") return 0; // fail-closed: never guess ownership

  const nowMs = (opts.now ?? Date.now)();
  const minInterval =
    opts.minRefreshIntervalMs ?? DEFAULT_HEARTBEAT_REFRESH_INTERVAL_MS;

  let records: WorktreeHeartbeatRecord[];
  try {
    records = opts.listRecords();
  } catch {
    return 0;
  }

  let touched = 0;
  for (const r of records) {
    if (r.ownerAgent !== identity) continue; // ownerless never matched
    // Throttle: skip if the heartbeat is still comfortably fresh.
    if (minInterval > 0 && r.heartbeatAt != null) {
      const age = nowMs - new Date(r.heartbeatAt).getTime();
      if (Number.isFinite(age) && age >= 0 && age < minInterval) continue;
    }
    try {
      opts.touchHeartbeat(r.id);
      touched++;
    } catch (err) {
      opts.log?.(
        `worktree heartbeat refresh failed for ${r.id}: ${(err as Error).message}`,
      );
    }
  }
  return touched;
}
