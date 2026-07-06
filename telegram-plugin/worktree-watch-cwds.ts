/**
 * Ownership filter for the worktree-isolated cwds the subagent-watcher should
 * additionally watch (deterministic-turn-liveness.md Known Gap 2 + the #2893
 * ownership-predicate review fix).
 *
 * A sub-agent dispatched into a `switchroom worktree claim` cwd runs under a
 * different project-dir slug than the agent's own `agentCwd`, so the #1116
 * foreign-slug filter would skip it forever unless the watcher also watches
 * the slugs of worktrees THIS agent owns. This helper derives that set from
 * the host-global worktree registry, and it is deliberately fail-CLOSED:
 *
 *   - Unset/empty identity ⇒ contribute NOTHING. `ownerAgent` is optional in
 *     the registry, so a naive `r.ownerAgent === process.env.SWITCHROOM_AGENT_NAME`
 *     with the env var unset becomes `undefined === undefined` and matches
 *     every OWNERLESS record in the host-global registry — including other
 *     agents' worktrees. That is precisely the #1116 leak the filter exists to
 *     prevent, reintroduced by failing OPEN. With no identity we cannot prove
 *     ownership of anything, so we return `[]`.
 *   - A registry read failure ⇒ `[]` (best-effort; never disturb the base
 *     agentCwd watch).
 *   - Owner match ⇒ include, realpath'd. Claude Code mints the project slug off
 *     the process's PHYSICAL cwd, so a symlinked base (macOS `/tmp` →
 *     `/private/tmp`) would otherwise derive a slug that misses the physical
 *     one; realpath best-effort, falling back to the raw path.
 */
import { realpathSync } from "node:fs";

export interface WorktreeOwnershipRecord {
  path: string;
  ownerAgent?: string;
}

export interface OwnedWorktreeCwdsOptions {
  /** The agent's identity — `process.env.SWITCHROOM_AGENT_NAME`. */
  self: string | undefined;
  /** The host-global registry read (`listRecords` from src/worktree/registry). */
  listRecords: () => WorktreeOwnershipRecord[];
  /** Injectable for tests; defaults to `fs.realpathSync`. */
  realpath?: (p: string) => string;
}

export function ownedWorktreeCwds(opts: OwnedWorktreeCwdsOptions): string[] {
  const { self } = opts;
  if (self == null || self === "") return [];
  const rp = opts.realpath ?? realpathSync;
  try {
    return opts
      .listRecords()
      .filter((r) => r.ownerAgent === self)
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
