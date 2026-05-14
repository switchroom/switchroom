import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import type { AgentConfig, SwitchroomConfig } from "../config/schema.js";
import {
  getAllAgentStatuses,
  startAgent,
  stopAgent,
  restartAgent,
} from "../agents/lifecycle.js";
import { getAllAuthStatuses } from "../auth/manager.js";
import { getCollectionForAgent } from "../memory/hindsight.js";
import { captureEvent, captureException } from "../analytics/posthog.js";
import { resolveAgentsDir } from "../config/loader.js";
import { resolveAgentConfig } from "../config/merge.js";
import { getAccountInfos, type AccountInfo } from "../auth/account-store.js";
import {
  AuthBrokerError,
  AuthBrokerUnreachableError,
  withAuthBrokerClient,
  type AccountState,
} from "../auth/broker/client.js";
import { openTurnsDb, listTurnsForAgent, type Turn } from "../../telegram-plugin/registry/turns-schema.js";
import { applySubagentsSchema, listSubagents, type Subagent } from "../../telegram-plugin/registry/subagents-schema.js";

export interface AgentInfo {
  name: string;
  active: string;
  uptime: string | null;
  memory: string | null;
  extends: string;
  topic_name: string;
  topic_emoji?: string;
  primaryAccount?: string;
  auth: {
    authenticated: boolean;
    subscriptionType?: string;
    timeUntilExpiry?: string;
    expiresAt?: number;
  };
  memoryCollection: string;
}

export function handleGetAgents(config: SwitchroomConfig): AgentInfo[] {
  const statuses = getAllAgentStatuses(config);
  const authStatuses = getAllAuthStatuses(config);
  const agents: AgentInfo[] = [];

  for (const [name, agentConfig] of Object.entries(config.agents)) {
    const status = statuses[name];
    const auth = authStatuses[name];
    const collection = getCollectionForAgent(name, config);
    const resolved = resolveAgentConfig(config.defaults, config.profiles, agentConfig);
    // RFC H schema: per-agent `auth.override:` wins, else fleet-wide
    // `auth.active`. No more per-agent fallback list.
    const primaryAccount = resolved.auth?.override ?? config.auth?.active;

    agents.push({
      name,
      active: status?.active ?? "unknown",
      uptime: status?.uptime ?? null,
      memory: status?.memory ?? null,
      extends: agentConfig.extends ?? "default",
      topic_name: agentConfig.topic_name,
      topic_emoji: agentConfig.topic_emoji,
      primaryAccount,
      auth: {
        authenticated: auth?.authenticated ?? false,
        subscriptionType: auth?.subscriptionType,
        timeUntilExpiry: auth?.timeUntilExpiry,
        expiresAt: auth?.expiresAt,
      },
      memoryCollection: collection,
    });
  }

  return agents;
}

export function handleStartAgent(name: string): { ok: boolean; error?: string } {
  try {
    startAgent(name);
    void captureEvent("agent_started", { agent: name, source: "web_api" });
    return { ok: true };
  } catch (err) {
    void captureException(err, { action: "start_agent", agent: name });
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function handleStopAgent(name: string): { ok: boolean; error?: string } {
  try {
    stopAgent(name);
    void captureEvent("agent_stopped", { agent: name, source: "web_api" });
    return { ok: true };
  } catch (err) {
    void captureException(err, { action: "stop_agent", agent: name });
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function handleRestartAgent(name: string): { ok: boolean; error?: string } {
  try {
    restartAgent(name);
    void captureEvent("agent_restarted", { agent: name, source: "web_api" });
    return { ok: true };
  } catch (err) {
    void captureException(err, { action: "restart_agent", agent: name });
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function handleGetLogs(
  name: string,
  lines: number = 50
): { ok: boolean; logs?: string; error?: string } {
  try {
    const output = execFileSync(
      "journalctl",
      ["--user", "-u", `switchroom-${name}`, "--no-pager", "-n", String(lines)],
      { encoding: "utf-8", timeout: 5000 }
    );
    return { ok: true, logs: output };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function handleGetTurns(
  config: SwitchroomConfig,
  agentName: string,
  limit: number,
): { ok: boolean; turns?: Turn[]; error?: string } {
  try {
    const agentsDir = resolveAgentsDir(config);
    const agentDir = resolve(agentsDir, agentName);
    const db = openTurnsDb(agentDir);
    try {
      const turns = listTurnsForAgent(db, { limit });
      return { ok: true, turns };
    } finally {
      db.close();
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function handleGetSubagents(
  config: SwitchroomConfig,
  agentName: string,
  status: string | undefined,
): { ok: boolean; subagents?: Subagent[]; error?: string } {
  try {
    const agentsDir = resolveAgentsDir(config);
    const agentDir = resolve(agentsDir, agentName);
    const db = openTurnsDb(agentDir);
    try {
      applySubagentsSchema(db);
      const subagents = listSubagents(db, { status });
      return { ok: true, subagents };
    } finally {
      db.close();
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Per-account dashboard view: stock AccountInfo + broker-derived quota
 * state + which agents are currently bound to this account.
 *
 * Quota source post-RFC-H is the broker's `list-state` snapshot — there's
 * no more `~/.switchroom/accounts/<label>/quota.json`. When the broker
 * is unreachable the quota field is `null` and callers fall back to the
 * cached view (Decision 9: degraded, not catastrophic).
 */
export interface AccountDashboardInfo extends AccountInfo {
  /** Broker-derived quota / exhaustion state. `null` when broker unreachable. */
  quota: AccountState | null;
  /** Agents currently bound to this account (fleet active or per-agent override). */
  usedBy: string[];
}

export async function handleGetAccounts(
  config?: SwitchroomConfig,
  home?: string,
): Promise<AccountDashboardInfo[]> {
  const infos = getAccountInfos(Date.now(), home);
  const brokerAccounts = new Map<string, AccountState>();
  try {
    await withAuthBrokerClient(async (client) => {
      const state = await client.listState();
      for (const a of state.accounts) brokerAccounts.set(a.label, a);
    });
  } catch (err) {
    if (!(err instanceof AuthBrokerUnreachableError)) throw err;
    // Degraded mode — keep the account list, drop the quota rows.
  }
  return infos.map((info) => {
    const usedBy: string[] = [];
    if (config) {
      const fleetActive = config.auth?.active;
      for (const [name, agent] of Object.entries(config.agents)) {
        const resolved = resolveAgentConfig(
          config.defaults,
          config.profiles,
          agent,
        );
        const bound = resolved.auth?.override ?? fleetActive;
        if (bound === info.label) usedBy.push(name);
      }
      usedBy.sort();
    }
    return {
      ...info,
      quota: brokerAccounts.get(info.label) ?? null,
      usedBy,
    };
  });
}

export interface UseAccountResult {
  ok: boolean;
  error?: string;
  /** Resolved fleet-active label after the call. */
  active?: string;
  /** Agents whose per-agent mirror the broker rewrote. */
  fanned?: string[];
}

/**
 * Set the fleet-wide active account. Replaces the pre-RFC-H
 * `/api/auth/promote` endpoint. No YAML rewrite from this code path —
 * the broker owns mirror writes; the CLI handles YAML when present.
 */
export async function handleUseAccount(label: string): Promise<UseAccountResult> {
  try {
    const data = await withAuthBrokerClient((client) => client.setActive(label));
    void captureEvent("auth_use", {
      account: label,
      fanned_count: data.fanned.length,
      source: "web_api",
    });
    return { ok: true, active: data.active, fanned: data.fanned };
  } catch (err) {
    void captureException(err, { action: "auth_use", account: label });
    let msg: string;
    if (err instanceof AuthBrokerUnreachableError) msg = err.message;
    else if (err instanceof AuthBrokerError) msg = `${err.code}: ${err.message}`;
    else msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

export interface AgentAccountsResponse {
  /** Single bound account label — fleet active or per-agent override. */
  active: string | null;
  /** AccountInfo for the bound label when present in the global store. */
  details: AccountInfo[];
}

export function handleGetAgentAccounts(
  config: SwitchroomConfig,
  agentName: string,
  home?: string,
): AgentAccountsResponse {
  const agent = config.agents[agentName];
  const resolved = resolveAgentConfig(config.defaults, config.profiles, agent);
  const active = resolved.auth?.override ?? config.auth?.active ?? null;
  const allInfos = getAccountInfos(Date.now(), home);
  const byLabel = new Map(allInfos.map((info) => [info.label, info]));
  const details: AccountInfo[] = [];
  if (active) {
    const info = byLabel.get(active);
    if (info) details.push(info);
  }
  return { active, details };
}

export function handleGetAgentConfig(
  config: SwitchroomConfig,
  agentName: string,
): AgentConfig {
  const agent = config.agents[agentName];
  return resolveAgentConfig(config.defaults, config.profiles, agent);
}
