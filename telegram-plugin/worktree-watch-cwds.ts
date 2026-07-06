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

export function ownedWorktreeCwds(opts: OwnedWorktreeCwdsOptions): string[] {
  // Tier 1: env fast path. Tier 2: durable agentDir-derived fallback.
  let resolved: string = opts.self != null ? opts.self : "";
  if (resolved === "" && opts.agentDir != null && opts.agentDir !== "") {
    const derive = opts.deriveName ?? defaultDeriveName;
    resolved = derive(opts.agentDir) || "";
  }

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
