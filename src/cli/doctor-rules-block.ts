/**
 * doctor-rules-block — Memory v2 M1 (carve-M1.md §3, T3/T7).
 *
 * Two independent probes per agent whose `memory.rules_block` flag is
 * true (dark by default — an agent with the flag unset/false has no
 * block to check, so it's skipped entirely, not warned):
 *
 *  1. Integrity — local, no network: `verifyIntegrity` (rules-store.ts)
 *     re-checks the mutation-log hash chain and the block's own sentinel.
 *     FAILs with a quoted diff-bearing detail on genuine tamper.
 *
 *  2. Index divergence — compares the rendered `switchroom:index` block's
 *     model-name list against the engine's live `/mental-models` list for
 *     the agent's RESOLVED bank id (`memory.collection ?? agentName` —
 *     same dedup as `checkBankObservationsMissions`, per red-team D3: an
 *     explicit resolved-bank-id input, not a raw agent name).
 *
 * BLOCKER 2 FIX (red-team-M1.md §D, MUST-FIX): the engine returns
 * `200 {"items":[]}` for an UNKNOWN bank_id (E-33), not 404/403. A
 * doctor probe that only checks "reachable" would read a benign
 * misroute (or an as-yet-unseeded bank) as if the engine had reported
 * zero models, and a non-empty local index block would then look like
 * tampered/divergent content. So: reachable-but-empty is NEVER treated
 * as a content mismatch — it degrades to "skip" (nothing to compare
 * against) when the local index is also empty, or "warn" (ambiguous —
 * could be E-33 misroute OR a genuinely stale unsynced bank) when the
 * local index is non-empty. FAIL is reserved for the unambiguous case:
 * engine reachable, NON-empty response, and that response's model-name
 * set differs from the local index block's — genuine divergence.
 */

import { getJson, type FetchOpts } from "../memory/bank-health.js";
import { parseIndexBlock, parseRulesBlock } from "../memory/rules-block.js";
import { verifyIntegrity } from "../memory/rules-store.js";
import { resolveAgentConfig } from "../config/merge.js";
import { resolveAgentsDir } from "../config/loader.js";
import type { AgentConfig, SwitchroomConfig } from "../config/schema.js";
import type { CheckStatus } from "./doctor-status.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail?: string;
  fix?: string;
}

export interface RulesBlockCheckDeps {
  agentsDir?: string;
  readFileFn?: (p: string) => string;
  fetchImpl?: FetchOpts["fetchImpl"];
}

interface BankEntry {
  agents: string[];
  config: AgentConfig;
}

function resolveBanks(config: SwitchroomConfig): Map<string, BankEntry> {
  const banks = new Map<string, BankEntry>();
  for (const [agentName, agentConfig] of Object.entries(config.agents)) {
    const resolved = resolveAgentConfig(config.defaults, config.profiles, agentConfig);
    if (resolved.memory?.rules_block !== true) continue; // dark: nothing to check
    const bankId = resolved.memory?.collection ?? agentName;
    const existing = banks.get(bankId);
    if (existing) existing.agents.push(agentName);
    else banks.set(bankId, { agents: [agentName], config: resolved });
  }
  return banks;
}

function readClaudeMdSafe(
  agentsDir: string | undefined,
  agentName: string,
  readFileFn: (p: string) => string,
): string | null {
  if (!agentsDir) return null;
  const p = join(agentsDir, agentName, "CLAUDE.md");
  try {
    return readFileFn(p);
  } catch {
    return null;
  }
}

/**
 * Memory v2 M3 (Surface-A) suppress-flag cross-check — synchronous, no network.
 *
 * An agent flipped to `memory.inject_directives: false` has its
 * `<active_directives>` recall block SUPPRESSED by `recall.py`'s guard — but
 * ONLY when a non-empty rules block physically carries the migrated guardrails.
 * If the flip is on while CLAUDE.md has no (or an empty) rules block, the
 * Python guard fails SAFE at runtime (keeps injecting + emits a degraded-canary
 * notice), but that is a misconfiguration the operator must fix, not a healthy
 * steady state. This check surfaces it as a FAIL so `switchroom doctor` catches
 * a mis-sequenced flip fleet-wide.
 *
 * FAIL conditions for an `inject_directives === false` agent:
 *   - `memory.rules_block` is not also true (two-flag ordering violated), or
 *   - CLAUDE.md is unreadable / has no rules block / the block has zero rules.
 * Otherwise ok. Agents that are NOT flipped produce no rows.
 */
export function runDirectiveFlipChecks(
  config: SwitchroomConfig,
  deps: RulesBlockCheckDeps = {},
): CheckResult[] {
  const readFileFn = deps.readFileFn ?? ((p: string) => readFileSync(p, "utf-8"));
  let agentsDir = deps.agentsDir;
  if (agentsDir === undefined) {
    try {
      agentsDir = resolveAgentsDir(config);
    } catch {
      agentsDir = undefined;
    }
  }

  const results: CheckResult[] = [];
  for (const [agentName, agentConfig] of Object.entries(config.agents)) {
    const resolved = resolveAgentConfig(config.defaults, config.profiles, agentConfig);
    if (resolved.memory?.inject_directives !== false) continue; // not flipped

    const name = `agent ${agentName} directive flip (inject_directives=false)`;

    if (resolved.memory?.rules_block !== true) {
      results.push({
        name,
        status: "fail",
        detail:
          "inject_directives is false but memory.rules_block is not true — the " +
          "rules block that must carry the migrated directives is not even " +
          "enabled. recall.py fails safe (keeps injecting), but fix the config: " +
          "enable rules_block and migrate, or re-enable inject_directives.",
        fix: `Set memory.rules_block: true for ${agentName} (and migrate its directives) before flipping.`,
      });
      continue;
    }

    const claudeMd = readClaudeMdSafe(agentsDir, agentName, readFileFn);
    const parsed = claudeMd ? parseRulesBlock(claudeMd) : null;
    const ruleCount = parsed?.rules.length ?? 0;

    if (ruleCount === 0) {
      results.push({
        name,
        status: "fail",
        detail:
          claudeMd === null
            ? "inject_directives is false but the agent's CLAUDE.md could not be " +
              "read to confirm a rules block carries the migrated directives."
            : "inject_directives is false but the CLAUDE.md rules block is empty " +
              "(no `- **R-…` rule lines). Every directive would be suppressed with " +
              "nothing carrying its guarantee. recall.py fails safe at runtime, but " +
              "fix the config: migrate the directives into the rules block, or " +
              "re-enable inject_directives.",
        fix: `Migrate ${agentName}'s directives into the rules block (memory rule add) or re-enable inject_directives.`,
      });
    } else {
      results.push({
        name,
        status: "ok",
        detail: `flipped, and the rules block carries ${ruleCount} rule(s) — directive injection safely suppressed.`,
      });
    }
  }
  return results;
}

export async function runRulesBlockChecks(
  config: SwitchroomConfig,
  engineUrl: string,
  deps: RulesBlockCheckDeps = {},
): Promise<CheckResult[]> {
  const readFileFn = deps.readFileFn ?? ((p: string) => readFileSync(p, "utf-8"));
  let agentsDir = deps.agentsDir;
  if (agentsDir === undefined) {
    try {
      agentsDir = resolveAgentsDir(config);
    } catch {
      agentsDir = undefined;
    }
  }

  const banks = resolveBanks(config);
  if (banks.size === 0) return [];

  const results: CheckResult[] = [];

  for (const [bankId, entry] of banks) {
    const firstAgent = entry.agents[0];
    const label = `bank ${bankId} rules block` +
      (entry.agents.length > 1 ? ` (${entry.agents.join(", ")})` : "");

    // --- 1. Local integrity (per-agent) ---------------------------------
    // Each agent in a shared bank has its OWN CLAUDE.md + mutation log, so
    // integrity is checked for EVERY agent, not just entry.agents[0]: a
    // tampered block on the second agent of a shared-collection bank would
    // otherwise pass silently (MEDIUM fix). Only the index-divergence probe
    // below is legitimately per-bank (it compares against the shared engine
    // bank, which all agents in the bank point at).
    for (const agentName of entry.agents) {
      const perAgentSuffix = entry.agents.length > 1 ? ` (${agentName})` : "";
      if (agentsDir && existsSync(join(agentsDir, agentName))) {
        const integrity = verifyIntegrity(join(agentsDir, agentName));
        results.push({
          name: `${label} — integrity${perAgentSuffix}`,
          status: integrity.ok ? "ok" : "fail",
          detail: integrity.detail,
          ...(integrity.ok ? {} : { fix: `Run: switchroom memory rule verify ${agentName}` }),
        });
      } else {
        results.push({
          name: `${label} — integrity${perAgentSuffix}`,
          status: "warn",
          detail: "could not resolve the agent directory to verify",
        });
      }
    }

    // --- 2. Index divergence ---------------------------------------------
    const claudeMd = readClaudeMdSafe(agentsDir, firstAgent, readFileFn);
    const localModels = claudeMd ? (parseIndexBlock(claudeMd)?.models ?? []) : [];

    const remote = await getJson<{ items?: Array<{ name?: string }> }>(
      `${engineUrl}/v1/default/banks/${encodeURIComponent(bankId)}/mental-models`,
      { fetchImpl: deps.fetchImpl },
    );

    if (!remote.ok) {
      results.push({
        name: `${label} — index divergence`,
        status: "warn",
        detail: `could not reach the engine to compare: ${remote.reason}`,
      });
      continue;
    }

    const remoteModels = (remote.data.items ?? [])
      .map((m) => m.name)
      .filter((n): n is string => typeof n === "string")
      .sort();
    const sortedLocal = [...localModels].sort();

    // BLOCKER 2 FIX: reachable + empty is never a content-divergence FAIL.
    if (remoteModels.length === 0) {
      if (sortedLocal.length === 0) {
        results.push({
          name: `${label} — index divergence`,
          status: "ok",
          detail: "no models on either side",
        });
      } else {
        results.push({
          name: `${label} — index divergence`,
          status: "warn",
          detail:
            `engine reports zero mental models for bank "${bankId}" while the ` +
            `local index block lists ${sortedLocal.length}. This is expected for ` +
            `an unknown bank_id (the engine returns 200 {"items":[]} rather than ` +
            `404/403 — E-33), so this is NOT treated as tampering. Verify ` +
            `memory.collection resolves to the intended bank before assuming drift.`,
        });
      }
      continue;
    }

    const diverged =
      remoteModels.length !== sortedLocal.length ||
      remoteModels.some((m, i) => m !== sortedLocal[i]);

    if (diverged) {
      results.push({
        name: `${label} — index divergence`,
        status: "fail",
        detail:
          `local index block: [${sortedLocal.join(", ")}] vs engine bank ` +
          `"${bankId}": [${remoteModels.join(", ")}].`,
        fix: `Regenerate the index block for ${firstAgent} (memory rule tooling: ` +
          `see \`regenerateIndexBlock\` in src/memory/rules-store.ts).`,
      });
    } else {
      results.push({
        name: `${label} — index divergence`,
        status: "ok",
        detail: "local index block matches the engine's live mental-model list",
      });
    }
  }

  return results;
}
