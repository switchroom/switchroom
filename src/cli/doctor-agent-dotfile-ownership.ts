/**
 * Agent dotfile-ownership doctor probe (#3157 direction 2).
 *
 * ## Why this exists
 *
 * The rollout restart-reconcile once rewrote per-agent
 * `.claude/settings.json` as `root:root 0600` (the 2026-07-12 v0.18.13→14
 * incident). A non-root agent then could not read its own settings.json,
 * so Claude Code loaded NO permission allowlist and every tool call threw
 * an operator approval card — a fleet-wide "approve everything" storm.
 *
 * The recurrence is now blocked at the source: `reconcileAgent` ends with
 * the `alignAgentTreeOwnershipIfRoot` sweep + `findAgentUnreadablePaths`
 * assert (#3169, `agent-owned-tree.ts`). This probe is the OPERATOR-facing
 * twin of that runtime assert — a cheap standing `switchroom doctor` check
 * that catches a tree ALREADY poisoned (by the historical incident, a
 * writer that ran OUTSIDE reconcile, or a stopgap host-side edit that
 * flipped ownership) BEFORE the agent boots into a card storm.
 *
 * Issue #3157 fix-direction 2 asked precisely for this: the ownership
 * pre-flight already caught a root-owned `switchroom.yaml`, but NOT the
 * per-agent `.claude/settings.json` / `.claude.json`. This closes that gap.
 *
 * ## Runtime-uid correctness (the klanker caveat)
 *
 * The check compares each dotfile against the agent's ACTUAL runtime uid,
 * not a blanket "must be 10001+". A `root:` agent (e.g. klanker) runs its
 * `claude` as uid 0 (`compose.ts`: `user: "0:0"`), so root-owned files are
 * BENIGN there and must not be flagged — exactly the note in #3157. So the
 * expected uid is `0` for a `root:` agent and the deterministic
 * `allocateAgentUid(name)` (10001+) otherwise, matching what compose writes
 * into the container's `user:` field.
 *
 * ## Predicate reuse
 *
 * Readability is decided by the SAME `findAgentUnreadablePaths` predicate
 * the reconcile assert uses (owner-or-other-readable, symlinks skipped) so
 * the doctor verdict can never drift from what actually wedges the agent.
 */

import { existsSync, lstatSync, statSync } from "node:fs";
import { join } from "node:path";

import { resolveAgentsDir } from "../config/loader.js";
import { allocateAgentUid } from "../agents/agent-uid.js";
import {
  findAgentUnreadablePaths,
  type UnreadableScanFs,
} from "../agents/agent-owned-tree.js";
import type { SwitchroomConfig } from "../config/schema.js";
import type { CheckStatus } from "./doctor-status.js";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail?: string;
  fix?: string;
}

export interface AgentDotfileOwnershipDeps {
  /** Defaults to `resolveAgentsDir(config)`, resolved lazily + guarded. */
  agentsDir?: string;
  /** Existence probe — injected in tests. */
  existsSync?: (p: string) => boolean;
  /** Stat seam handed to `findAgentUnreadablePaths` — injected in tests so a
   *  root:root 0600 file can be simulated without a real chown. */
  scanFs?: UnreadableScanFs;
}

/**
 * The per-agent dotfiles whose ownership determines whether the agent can
 * load its own Claude Code state. `.claude/settings.json` carries the
 * permission allowlist + defaultMode (the incident file); `.claude.json`
 * holds the MCP trust list; `.mcp.json` and the cron `.mcp.json` carry the
 * agent's MCP server wiring. All are atomic-rewrite (new-inode) targets on
 * the reconcile path, i.e. exactly the class that flips to root-owned.
 */
export function agentDotfileCandidates(agentDir: string): string[] {
  return [
    join(agentDir, ".claude", "settings.json"),
    join(agentDir, ".claude.json"),
    join(agentDir, ".claude", ".claude.json"),
    join(agentDir, ".mcp.json"),
    join(agentDir, ".claude-cron", ".mcp.json"),
  ];
}

/**
 * For each configured agent, assert its critical dotfiles are readable by
 * the agent's actual runtime uid. A root-owned 0600 settings.json under a
 * non-root agent fails with a `chown` remediation; a `root:` agent whose
 * files are root-owned passes (benign — it runs as uid 0).
 */
export function runAgentDotfileOwnershipChecks(
  config: SwitchroomConfig,
  deps: AgentDotfileOwnershipDeps = {},
): CheckResult[] {
  const results: CheckResult[] = [];
  const agents = Object.keys(config.agents ?? {});
  if (agents.length === 0) return results;

  const exists = deps.existsSync ?? existsSync;
  const scanFs = deps.scanFs ?? { lstatSync, statSync };

  let agentsDir = deps.agentsDir;
  if (agentsDir === undefined) {
    try {
      agentsDir = resolveAgentsDir(config);
    } catch {
      agentsDir = undefined;
    }
  }
  if (agentsDir === undefined) {
    return [
      {
        name: "agent dotfile ownership",
        status: "warn",
        detail:
          "could not resolve the agents directory (no switchroom block) — skipped dotfile-ownership check",
      },
    ];
  }

  for (const name of agents) {
    const agentDir = join(agentsDir, name);
    if (!exists(agentDir)) {
      // Not scaffolded yet — nothing to own. Silent (no result) mirrors
      // other scaffold probes' "run apply first" posture without noise.
      continue;
    }

    // Actual runtime uid: 0 for a root-tier agent (runs `user: "0:0"`),
    // the deterministic non-root uid otherwise. This is the exact value
    // compose.ts stamps into the container, so a root-owned file is only
    // ever flagged when the agent CANNOT read it at runtime. `root:` is a
    // per-agent-only flag (never cascaded), so read it from the raw agent
    // config exactly as compose.ts does (`agent.root === true`).
    const isRoot = config.agents[name]?.root === true;
    const runtimeUid = isRoot ? 0 : allocateAgentUid(name);

    const candidates = agentDotfileCandidates(agentDir);
    const unreadable = findAgentUnreadablePaths(candidates, runtimeUid, scanFs);

    if (unreadable.length === 0) {
      results.push({
        name: `dotfile ownership: ${name}`,
        status: "ok",
        detail: isRoot
          ? `runs as uid 0 (root-tier) — dotfiles readable`
          : `dotfiles readable by agent uid ${runtimeUid}`,
      });
      continue;
    }

    results.push({
      name: `dotfile ownership: ${name}`,
      status: "fail",
      detail:
        `${unreadable.length} dotfile(s) not readable by the agent's runtime ` +
        `uid ${runtimeUid}: ${unreadable.join(", ")}. Claude Code loads no ` +
        `permission allowlist from an unreadable settings.json → the agent ` +
        `prompts the operator to approve every tool call (card storm).`,
      fix: `sudo chown -h -R ${runtimeUid}:${runtimeUid} ${agentDir}  # then \`switchroom agent restart ${name}\``,
    });
  }

  return results;
}
