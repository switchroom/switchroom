import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentConfig, SwitchroomConfig } from "../config/schema.js";
import {
  getAllAgentStatuses,
  startAgent,
  stopAgent,
  restartAgent,
  containerName,
} from "../agents/lifecycle.js";
import { getAllAuthStatuses } from "../auth/manager.js";
import { getCollectionForAgent } from "../memory/hindsight.js";
import {
  getHindsightStatus,
  isHindsightRunning,
} from "../setup/hindsight.js";
import {
  defaultAuditLogPath,
  readAndFilter,
  type AuditEntry,
} from "../host-control/audit-reader.js";
import {
  collectScheduleEntries,
  type SchedulerEntry,
  type DispatchResult,
} from "../scheduler/dispatch.js";
import { readRecentFires } from "../agent-scheduler/replay.js";
import {
  approvalList,
  resolveKernelOperatorSocket,
} from "../vault/approvals/client.js";
import type { ApprovalDecisionMeta } from "../vault/broker/protocol.js";
import { captureEvent, captureException } from "../analytics/posthog.js";
import { resolveAgentsDir } from "../config/loader.js";
import { resolveAgentConfig } from "../config/merge.js";
import {
  agentCanAccessNotionDB,
  shouldEmitNotionMcp,
} from "../config/notion-workspace-acl.js";
import {
  enableAgentsOnGoogleAccount,
  disableAgentsOnGoogleAccount,
} from "../cli/google-accounts-yaml.js";
import {
  enableAgentsOnMicrosoftAccount,
  disableAgentsOnMicrosoftAccount,
} from "../cli/microsoft-accounts-yaml.js";
import {
  setAgentWorkspaceAccount,
  clearAgentWorkspaceAccount,
  getAgentWorkspaceAccount,
  type WorkspaceProvider,
} from "../config/agent-workspace-account.js";
import {
  planConfigEdit,
  composeTransforms,
  ConfigPlanError,
  type YamlTransform,
} from "./config-edit-plan.js";
import { generateUnifiedDiff } from "./config-diff.js";
import {
  proposeConfigEditViaHostd,
  resolveHostdOperatorSocket,
  type ProposeOutcome,
} from "./hostd-config-propose.js";
import { randomUUID } from "node:crypto";
import {
  startMicrosoftConnect,
  runMicrosoftConnectPoll,
  type MicrosoftConnectDeps,
} from "./microsoft-connect.js";
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
  // Agents are Docker containers since v0.7 — there is no
  // `switchroom-<name>` systemd user unit to journalctl against.
  // `docker logs` splits the container's stdout/stderr across the two
  // fds; a container can log to either, so merge both for a complete
  // view. spawnSync hands back both streams regardless of exit code.
  const res = spawnSync(
    "docker",
    ["logs", "--tail", String(lines), containerName(name)],
    { encoding: "utf-8", timeout: 5000 },
  );
  if (res.error) {
    return { ok: false, error: res.error.message };
  }
  if (res.status !== 0) {
    const stderr = (res.stderr ?? "").trim();
    return {
      ok: false,
      error: stderr || `docker logs exited ${res.status ?? "non-zero"}`,
    };
  }
  return { ok: true, logs: `${res.stdout ?? ""}${res.stderr ?? ""}` };
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
/**
 * Live rate-limit utilization for an account, from the broker's
 * `probe-quota` op. Distinct from `quota: AccountState` (exhaustion
 * flags from list-state) — this is the actual 5h/7d %.
 *
 * COST: each probe is a live billed `POST api.anthropic.com/v1/messages`
 * per account (the broker sends "hi" to read the rate-limit headers).
 * So it is NEVER called on the default accounts load — only from the
 * explicit refresh endpoint, and cached with a TTL so neither the 10s
 * fleet poll nor a tab re-open can cause a probe storm.
 */
export interface AccountQuotaUsage {
  fiveHourPct: number;
  sevenDayPct: number;
  /** ms epoch (Date serialised) or null when the broker didn't report one. */
  fiveHourResetAt: number | null;
  sevenDayResetAt: number | null;
  /** ms epoch when this probe was taken. */
  capturedAt: number;
}

/** Probe results cached at most this long before a refresh re-probes. */
export const QUOTA_CACHE_TTL_MS = 10 * 60 * 1000;

interface QuotaCacheEntry {
  usage: AccountQuotaUsage | null;
  fetchedAt: number;
  error?: string;
}

// Module-level: the dashboard server is a single long-lived process,
// so a plain Map is the cache. Bounded by account count.
const quotaCache = new Map<string, QuotaCacheEntry>();

function quotaEntryFresh(e: QuotaCacheEntry | undefined, now: number): boolean {
  return !!e && now - e.fetchedAt < QUOTA_CACHE_TTL_MS;
}

export interface AccountDashboardInfo extends AccountInfo {
  /** Broker-derived quota / exhaustion state. `null` when broker unreachable. */
  quota: AccountState | null;
  /**
   * Live 5h/7d utilization from the last cached probe, or null if never
   * probed / probe failed. Populated by the refresh endpoint, never by
   * this default load (cost — see AccountQuotaUsage).
   */
  quotaUsage: AccountQuotaUsage | null;
  /** true when there's no fresh cached probe (UI shows a refresh prompt). */
  quotaStale: boolean;
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
    const now = Date.now();
    const ce = quotaCache.get(info.label);
    return {
      ...info,
      quota: brokerAccounts.get(info.label) ?? null,
      // Cache read only — NEVER probe here (cost). Stale/missing → null
      // + quotaStale:true so the UI can prompt a refresh.
      quotaUsage: quotaEntryFresh(ce, now) ? (ce!.usage ?? null) : null,
      quotaStale: !quotaEntryFresh(ce, now),
      usedBy,
    };
  });
}

export interface RefreshQuotaResult {
  ok: boolean;
  error?: string;
  /** Per-label outcome after the (possibly cache-skipped) refresh. */
  usage: Record<
    string,
    { usage: AccountQuotaUsage | null; stale: boolean; error?: string }
  >;
}

/**
 * Explicitly refresh cached quota usage via the broker's `probe-quota`
 * (live billed Anthropic call per account). TTL-respecting: an account
 * whose cache is still fresh is skipped UNLESS `force` is set (the
 * manual per-account / "refresh all" button passes force=true; the
 * accounts-tab auto-trigger does NOT, so it no-ops when fresh and can
 * never storm).
 *
 * @param labels  accounts to (maybe) probe; omitted ⇒ all known accounts
 * @param force   bypass the TTL and re-probe now
 */
export async function handleRefreshAccountsQuota(
  labels?: string[],
  force = false,
  home?: string,
): Promise<RefreshQuotaResult> {
  const now = Date.now();
  const all = getAccountInfos(now, home).map((i) => i.label);
  const targets = (labels && labels.length > 0 ? labels : all).filter((l) =>
    all.includes(l),
  );
  // Only probe accounts that are forced or stale; serve cache otherwise.
  const toProbe = targets.filter(
    (l) => force || !quotaEntryFresh(quotaCache.get(l), now),
  );

  if (toProbe.length > 0) {
    try {
      await withAuthBrokerClient(async (client) => {
        const data = await client.probeQuota(toProbe);
        const probedAt = Date.now();
        for (const entry of data.results) {
          if (entry.result.ok) {
            const d = entry.result.data;
            quotaCache.set(entry.label, {
              fetchedAt: probedAt,
              usage: {
                fiveHourPct: d.fiveHourUtilizationPct,
                sevenDayPct: d.sevenDayUtilizationPct,
                fiveHourResetAt: d.fiveHourResetAt
                  ? d.fiveHourResetAt.getTime()
                  : null,
                sevenDayResetAt: d.sevenDayResetAt
                  ? d.sevenDayResetAt.getTime()
                  : null,
                capturedAt: probedAt,
              },
            });
          } else {
            quotaCache.set(entry.label, {
              fetchedAt: probedAt,
              usage: null,
              error: entry.result.reason,
            });
          }
        }
      });
    } catch (err) {
      const msg =
        err instanceof AuthBrokerUnreachableError
          ? err.message
          : err instanceof AuthBrokerError
            ? `${err.code}: ${err.message}`
            : err instanceof Error
              ? err.message
              : String(err);
      // Degraded: report the error but still return whatever's cached.
      const out: RefreshQuotaResult = { ok: false, error: msg, usage: {} };
      const t = Date.now();
      for (const l of targets) {
        const e = quotaCache.get(l);
        out.usage[l] = {
          usage: quotaEntryFresh(e, t) ? (e!.usage ?? null) : null,
          stale: !quotaEntryFresh(e, t),
          error: e?.error,
        };
      }
      return out;
    }
  }

  const t = Date.now();
  const usage: RefreshQuotaResult["usage"] = {};
  for (const l of targets) {
    const e = quotaCache.get(l);
    usage[l] = {
      usage: quotaEntryFresh(e, t) ? (e!.usage ?? null) : null,
      stale: !quotaEntryFresh(e, t),
      error: e?.error,
    };
  }
  return { ok: true, usage };
}

/** Test-only: reset the module quota cache between cases. */
export function __resetQuotaCacheForTests(): void {
  quotaCache.clear();
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
 * `/api/accounts/:label/promote` endpoint. No YAML rewrite from this
 * code path — the broker owns mirror writes; the CLI handles YAML
 * when present.
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

/**
 * Fleet infrastructure health — the three singletons the dashboard
 * never surfaced (auth-broker, hindsight, hostd). All reads are
 * best-effort and degrade independently: a broker timeout doesn't
 * blank the hindsight panel and vice versa. This is observability,
 * not control — no mutating ops live here.
 */
export interface SystemHealth {
  broker: {
    reachable: boolean;
    active?: string;
    accounts?: number;
    agents?: number;
    consumers?: number;
    error?: string;
  };
  hindsight: {
    /** Raw `docker ps` Status string, or null when the container is absent. */
    containerStatus: string | null;
    running: boolean;
    /** Live values read from the running container's env (truth, not the
     *  compile-time default) — null when the container isn't inspectable. */
    model: string | null;
    provider: string | null;
    mcpStateless: boolean | null;
  };
  hostd: {
    auditLogPresent: boolean;
    /** Most-recent privileged-verb audit rows (newest last), capped. */
    recent: AuditEntry[];
    error?: string;
  };
}

/**
 * Pull a single env var out of `docker inspect`'s Config.Env array for
 * a container. Returns null when the container is absent or the var
 * isn't set — the caller renders that as "unknown" rather than guessing
 * from the compile-time default (the running container is the truth).
 */
function inspectEnv(
  container: string,
  keys: readonly string[],
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const k of keys) out[k] = null;
  const res = spawnSync(
    "docker",
    ["inspect", "--format", "{{json .Config.Env}}", container],
    { encoding: "utf-8", timeout: 4000 },
  );
  if (res.error || res.status !== 0 || !res.stdout) return out;
  try {
    const env = JSON.parse(res.stdout.trim()) as string[];
    for (const pair of env) {
      const eq = pair.indexOf("=");
      if (eq < 0) continue;
      const name = pair.slice(0, eq);
      if (name in out) out[name] = pair.slice(eq + 1);
    }
  } catch {
    /* malformed inspect output — leave nulls */
  }
  return out;
}

export async function handleGetSystemHealth(
  home?: string,
): Promise<SystemHealth> {
  // ── auth-broker ──────────────────────────────────────────────────
  const broker: SystemHealth["broker"] = { reachable: false };
  try {
    await withAuthBrokerClient(async (client) => {
      const state = await client.listState();
      broker.reachable = true;
      broker.active = state.active;
      broker.accounts = state.accounts.length;
      broker.agents = state.agents.length;
      broker.consumers = state.consumers.length;
    });
  } catch (err) {
    broker.reachable = false;
    if (err instanceof AuthBrokerUnreachableError) {
      broker.error = err.message;
    } else if (err instanceof AuthBrokerError) {
      broker.error = `${err.code}: ${err.message}`;
    } else {
      broker.error = err instanceof Error ? err.message : String(err);
    }
  }

  // ── hindsight ────────────────────────────────────────────────────
  const containerStatus = getHindsightStatus();
  const running = isHindsightRunning();
  const env = running
    ? inspectEnv("switchroom-hindsight", [
        "HINDSIGHT_API_LLM_MODEL",
        "HINDSIGHT_API_LLM_PROVIDER",
        "HINDSIGHT_API_MCP_STATELESS",
      ])
    : {
        HINDSIGHT_API_LLM_MODEL: null,
        HINDSIGHT_API_LLM_PROVIDER: null,
        HINDSIGHT_API_MCP_STATELESS: null,
      };
  const statelessRaw = env.HINDSIGHT_API_MCP_STATELESS;
  const hindsight: SystemHealth["hindsight"] = {
    containerStatus,
    running,
    model: env.HINDSIGHT_API_LLM_MODEL,
    provider: env.HINDSIGHT_API_LLM_PROVIDER,
    mcpStateless:
      statelessRaw == null ? null : statelessRaw.toLowerCase() === "true",
  };

  // ── hostd ────────────────────────────────────────────────────────
  const hostd: SystemHealth["hostd"] = {
    auditLogPresent: false,
    recent: [],
  };
  try {
    const logPath = defaultAuditLogPath(home);
    if (existsSync(logPath)) {
      hostd.auditLogPresent = true;
      const raw = readFileSync(logPath, "utf-8");
      hostd.recent = readAndFilter(raw, {}, 10);
    }
  } catch (err) {
    hostd.error = err instanceof Error ? err.message : String(err);
  }

  return { broker, hindsight, hostd };
}

/**
 * Google Workspace (RFC G) accounts. Live inventory (expiry / scope /
 * clientId) comes from the broker; the per-agent ACL is config-side
 * (`google_accounts[email].enabled_for`). Broker-unreachable degrades
 * to "config only" — the ACL still renders, live fields are null.
 */
export interface GoogleAccountDashboardInfo {
  account: string;
  expiresAt: number | null;
  scope: string | null;
  clientId: string | null;
  /** Agents allowed to use this account (config ACL). */
  enabledFor: string[];
  /** false when the broker couldn't confirm the slot exists. */
  brokerKnown: boolean;
}

export async function handleGetGoogleAccounts(
  config: SwitchroomConfig,
): Promise<GoogleAccountDashboardInfo[]> {
  const live = new Map<
    string,
    { expiresAt: number; scope: string; clientId: string }
  >();
  try {
    await withAuthBrokerClient(async (client) => {
      const data = await client.listGoogleAccounts();
      for (const a of data.accounts) {
        live.set(a.account.toLowerCase(), {
          expiresAt: a.expiresAt,
          scope: a.scope,
          clientId: a.clientId,
        });
      }
    });
  } catch (err) {
    if (!(err instanceof AuthBrokerUnreachableError)) throw err;
    // Degraded: ACL still renders from config; live fields stay null.
  }
  // Union of config-declared accounts and broker-known slots so an
  // account present in only one source is still visible.
  const cfgAccounts = config.google_accounts ?? {};
  const keys = new Set<string>([
    ...Object.keys(cfgAccounts).map((k) => k.toLowerCase()),
    ...live.keys(),
  ]);
  const out: GoogleAccountDashboardInfo[] = [];
  for (const key of [...keys].sort()) {
    const cfg = cfgAccounts[key];
    const l = live.get(key);
    out.push({
      account: key,
      expiresAt: l?.expiresAt ?? null,
      scope: l?.scope ?? null,
      clientId: l?.clientId ?? null,
      enabledFor: cfg?.enabled_for ? [...cfg.enabled_for].sort() : [],
      brokerKnown: l != null,
    });
  }
  return out;
}

export interface MicrosoftAccountDashboardInfo {
  account: string;
  expiresAt: number | null;
  scope: string | null;
  clientId: string | null;
  /** "personal" (outlook.com/hotmail MSA) or "work" (M365 tenant). */
  accountType: "personal" | "work" | null;
  /** Agents allowed to use this account (config ACL). */
  enabledFor: string[];
  /** false when the broker couldn't confirm the slot exists. */
  brokerKnown: boolean;
}

/**
 * Microsoft account inventory for the dashboard — mirrors
 * {@link handleGetGoogleAccounts} (RFC #1873). Unions the config ACL
 * (`microsoft_accounts.<email>.enabled_for[]`) with the broker's
 * live credential inventory (`listMicrosoftAccounts`), so an account
 * present in only one source is still visible. Degrades gracefully when
 * the broker is unreachable (ACL renders, live fields null).
 */
export async function handleGetMicrosoftAccounts(
  config: SwitchroomConfig,
): Promise<MicrosoftAccountDashboardInfo[]> {
  const live = new Map<
    string,
    {
      expiresAt: number;
      scope: string;
      clientId: string;
      accountType: "personal" | "work";
    }
  >();
  try {
    await withAuthBrokerClient(async (client) => {
      const data = await client.listMicrosoftAccounts();
      for (const a of data.accounts) {
        live.set(a.account.toLowerCase(), {
          expiresAt: a.expiresAt,
          scope: a.scope,
          clientId: a.clientId,
          accountType: a.accountType,
        });
      }
    });
  } catch (err) {
    if (!(err instanceof AuthBrokerUnreachableError)) throw err;
    // Degraded: ACL still renders from config; live fields stay null.
  }
  const cfgAccounts =
    (config as { microsoft_accounts?: Record<string, { enabled_for?: string[] }> })
      .microsoft_accounts ?? {};
  const keys = new Set<string>([
    ...Object.keys(cfgAccounts).map((k) => k.toLowerCase()),
    ...live.keys(),
  ]);
  const out: MicrosoftAccountDashboardInfo[] = [];
  for (const key of [...keys].sort()) {
    const cfg = cfgAccounts[key];
    const l = live.get(key);
    out.push({
      account: key,
      expiresAt: l?.expiresAt ?? null,
      scope: l?.scope ?? null,
      clientId: l?.clientId ?? null,
      accountType: l?.accountType ?? null,
      enabledFor: cfg?.enabled_for ? [...cfg.enabled_for].sort() : [],
      brokerKnown: l != null,
    });
  }
  return out;
}

export interface NotionDatabaseInfo {
  /** Friendly name operators/agents reference. */
  name: string;
  /** Notion database UUID. */
  id: string;
  /** Agents whose notion_workspace.databases grants this DB. */
  enabledFor: string[];
}

export interface NotionWorkspaceDashboard {
  /** True when a top-level notion_workspace block is configured. */
  configured: boolean;
  /** Vault key holding the integration token (not the token itself). */
  vaultKey: string | null;
  /** Declared friendly-name → id databases with their agent grants. */
  databases: NotionDatabaseInfo[];
  /**
   * Agents with UNRESTRICTED Notion access (a `notion_workspace:` block
   * with no `databases` filter → every DB the integration can see). They
   * also appear in each database's `enabledFor`, but are surfaced here
   * so the UI can render "full access" once instead of in every row.
   */
  fullAccessAgents: string[];
}

/**
 * Notion workspace view for the dashboard. Unlike Google/Microsoft,
 * Notion has no per-account concept (one operator-owned internal
 * integration token); access is per-DATABASE via each agent's
 * `notion_workspace.databases` friendly-name list — OR unrestricted when
 * an agent has a `notion_workspace:` block with no `databases` filter.
 * This surfaces the declared databases and, for each, which agents are
 * granted it — the "which agents can reach Notion (and which DBs)"
 * answer. Per-DB grants are computed via the canonical
 * `agentCanAccessNotionDB` so the dashboard exactly matches runtime
 * authorization (including the empty-filter = full-access case). The
 * token itself never leaves the vault and is never returned here.
 */
export function handleGetNotionWorkspace(
  config: SwitchroomConfig,
): NotionWorkspaceDashboard {
  const nw = (
    config as {
      notion_workspace?: { vault_key?: string; databases?: Record<string, string> };
    }
  ).notion_workspace;
  if (!nw) {
    return { configured: false, vaultKey: null, databases: [], fullAccessAgents: [] };
  }
  const declared = nw.databases ?? {};
  const agentNames = Object.keys(config.agents ?? {});

  const databases: NotionDatabaseInfo[] = Object.entries(declared)
    .map(([name, id]) => {
      // Canonical ACL — credits both explicit-filter and full-access
      // (no-filter) agents, exactly as runtime authorization does.
      const enabledFor = agentNames
        .filter((n) => agentCanAccessNotionDB(config, n, id))
        .sort();
      return { name, id, enabledFor };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  // Full-access agents: a notion_workspace block present (gate) with no
  // databases filter. These reach every DB the integration can see.
  const agentsRaw = (config.agents ?? {}) as Record<
    string,
    { notion_workspace?: { databases?: string[] } }
  >;
  const fullAccessAgents = agentNames
    .filter((n) => {
      if (!shouldEmitNotionMcp(n, config)) return false;
      const dbs = agentsRaw[n]?.notion_workspace?.databases;
      return dbs === undefined || dbs.length === 0;
    })
    .sort();

  return {
    configured: true,
    vaultKey: nw.vault_key ?? null,
    databases,
    fullAccessAgents,
  };
}

export type ConnectionAccessStatus =
  | { state: "pending"; startedAt: number }
  | { state: "applied"; startedAt: number; restartAgent: string }
  | { state: "denied"; startedAt: number; reason: string }
  | { state: "error"; startedAt: number; reason: string };

export interface SetAccessResult {
  ok: boolean;
  error?: string;
  /** False when nothing would change (already in that state) — no proposal raised. */
  changed?: boolean;
  /** Poll handle for the approval outcome (present when a proposal was raised). */
  requestId?: string;
  /** True when a Telegram Allow/Deny card was raised and is awaiting the tap. */
  pendingApproval?: boolean;
}

/**
 * In-flight + recently-settled connection-access proposals, keyed by a
 * server-generated requestId. The dashboard POSTs, gets a requestId, and
 * polls {@link handleGetConnectionAccessStatus} until the operator taps
 * Allow/Deny in Telegram. Bounded by a reaper (see
 * reapConnectionAccessStatuses).
 */
const connectionAccessStatuses = new Map<string, ConnectionAccessStatus>();

/** Drop settled entries older than 30 min so the map can't grow without bound. */
export function reapConnectionAccessStatuses(now = Date.now()): void {
  for (const [id, s] of connectionAccessStatuses) {
    if (s.state !== "pending" && now - s.startedAt > 30 * 60_000) {
      connectionAccessStatuses.delete(id);
    }
  }
}

export function handleGetConnectionAccessStatus(
  requestId: string,
): ConnectionAccessStatus | { state: "unknown" } {
  return connectionAccessStatuses.get(requestId) ?? { state: "unknown" };
}

/** Test-only reset. */
export function __resetConnectionAccessStatuses(): void {
  connectionAccessStatuses.clear();
}

// ─── In-browser Microsoft connect (device-code) ───────────────────────────

export type MicrosoftConnectStatus =
  | { state: "pending"; startedAt: number; userCode: string; verificationUri: string; expiresInSec: number }
  | { state: "connected"; startedAt: number; account: string; accountType: "personal" | "work" }
  | { state: "failed"; startedAt: number; reason: string };

const microsoftConnectStatuses = new Map<string, MicrosoftConnectStatus>();

function reapMicrosoftConnects(now = Date.now()): void {
  for (const [id, s] of microsoftConnectStatuses) {
    // Settled entries > 30 min, or pending entries past their device-code
    // expiry + grace, are dropped.
    const ttl = s.state === "pending" ? s.expiresInSec * 1000 + 60_000 : 30 * 60_000;
    if (now - s.startedAt > ttl) microsoftConnectStatuses.delete(id);
  }
}

export interface StartConnectResult {
  ok: boolean;
  error?: string;
  requestId?: string;
  userCode?: string;
  verificationUri?: string;
  expiresInSec?: number;
}

/**
 * Start an in-browser Microsoft connect (device-code). Returns the short
 * code + verification URL for the operator to complete on Microsoft's
 * site; polls for consent in the background and registers the account
 * with the broker on success. Poll {@link handleGetMicrosoftConnectStatus}.
 *
 * `deps` is injectable for tests (device-code + poll + addAccount).
 */
export async function handleStartMicrosoftConnect(
  config: SwitchroomConfig,
  deps: MicrosoftConnectDeps = {},
): Promise<StartConnectResult> {
  const now = deps.now ?? Date.now;
  const configClientId = (
    config as { microsoft_workspace?: { microsoft_client_id?: string; org_mode?: boolean } }
  ).microsoft_workspace?.microsoft_client_id;
  const orgMode =
    deps.orgMode ??
    (config as { microsoft_workspace?: { org_mode?: boolean } }).microsoft_workspace?.org_mode === true;

  const started = await startMicrosoftConnect({ ...deps, configClientId, orgMode });
  if (started.kind === "byo-vault") {
    return {
      ok: false,
      error:
        `This install uses a vaulted custom Microsoft app (${started.ref}) the dashboard can't read. ` +
        `Connect from the host: switchroom auth microsoft account add <email>.`,
    };
  }
  if (started.kind === "error") {
    return { ok: false, error: started.message };
  }

  const requestId = randomUUID();
  microsoftConnectStatuses.set(requestId, {
    state: "pending",
    startedAt: now(),
    userCode: started.device.user_code,
    verificationUri: started.device.verification_uri,
    expiresInSec: started.device.expires_in,
  });
  reapMicrosoftConnects(now());

  // Background: poll Microsoft → register the account → record the outcome.
  void runMicrosoftConnectPoll(
    { device: started.device, clientId: started.clientId, scopes: started.scopes },
    deps,
  )
    .then((res) => {
      const startedAt = microsoftConnectStatuses.get(requestId)?.startedAt ?? now();
      if (res.state === "connected") {
        microsoftConnectStatuses.set(requestId, {
          state: "connected",
          startedAt,
          account: res.account,
          accountType: res.accountType,
        });
        void captureEvent("microsoft_connect", { outcome: "connected", source: "web_api" });
      } else {
        const reason =
          res.state === "no-refresh-token"
            ? "Microsoft returned no refresh token (account would expire in ~1h)."
            : res.message;
        microsoftConnectStatuses.set(requestId, { state: "failed", startedAt, reason });
      }
    })
    .catch((err) => {
      const startedAt = microsoftConnectStatuses.get(requestId)?.startedAt ?? now();
      microsoftConnectStatuses.set(requestId, {
        state: "failed",
        startedAt,
        reason: err instanceof Error ? err.message : String(err),
      });
      void captureException(err, { action: "microsoft_connect" });
    });

  return {
    ok: true,
    requestId,
    userCode: started.device.user_code,
    verificationUri: started.device.verification_uri,
    expiresInSec: started.device.expires_in,
  };
}

export function handleGetMicrosoftConnectStatus(
  requestId: string,
): MicrosoftConnectStatus | { state: "unknown" } {
  return microsoftConnectStatuses.get(requestId) ?? { state: "unknown" };
}

/** Test-only reset. */
export function __resetMicrosoftConnectStatuses(): void {
  microsoftConnectStatuses.clear();
}

/**
 * Propose granting/revoking an agent's access to a Google/Microsoft
 * account from the dashboard. SECURITY: the dashboard does NOT write
 * config — that would be self-elevation (an agent on host networking can
 * forge the dashboard's loopback auth). Instead this computes the edit
 * (the enabled_for ACL + the per-agent workspace.account selector — the
 * broker needs both), turns it into a unified diff, and proposes it to
 * hostd over the operator socket. hostd raises a Telegram Allow/Deny card
 * and is the sole writer — nothing changes without the operator's tap.
 *
 * Returns a requestId the dashboard polls; the actual approval resolves
 * asynchronously (hostd blocks on the human tap up to 10 min, so we run
 * the proposal in the background and never hang the HTTP POST). When the
 * edit would be a no-op, returns `changed:false` with no card raised.
 *
 * `deps` is injectable for tests (diff generation + the hostd send).
 */
export function handleSetConnectionAccess(
  configPath: string,
  config: SwitchroomConfig,
  args: { provider: string; account: string; agent: string; action: string },
  deps: {
    socketPath?: string | null;
    propose?: (reqId: string, diff: string, reason: string) => Promise<ProposeOutcome>;
    generateDiff?: (before: string, after: string) => string;
    now?: () => number;
  } = {},
): SetAccessResult {
  const provider = args.provider as WorkspaceProvider;
  if (provider !== "google" && provider !== "microsoft") {
    return { ok: false, error: `unsupported provider '${args.provider}' (google|microsoft)` };
  }
  if (args.action !== "enable" && args.action !== "disable") {
    return { ok: false, error: `action must be 'enable' or 'disable'` };
  }
  const agent = args.agent;
  if (!agent || !config.agents?.[agent]) {
    return { ok: false, error: `unknown agent '${agent}'` };
  }
  const account = String(args.account ?? "").trim().toLowerCase();
  if (!/^[^@\s:]+@[^@\s:]+\.[^@\s:]+$/.test(account)) {
    return { ok: false, error: `invalid account email '${args.account}'` };
  }

  const enableAcl =
    provider === "google" ? enableAgentsOnGoogleAccount : enableAgentsOnMicrosoftAccount;
  const disableAcl =
    provider === "google" ? disableAgentsOnGoogleAccount : disableAgentsOnMicrosoftAccount;

  let transform: YamlTransform;
  if (args.action === "enable") {
    transform = composeTransforms(
      (y) => enableAcl(y, account, [agent]),
      (y) => setAgentWorkspaceAccount(y, provider, agent, account),
    );
  } else {
    transform = composeTransforms(
      (y) => disableAcl(y, account, [agent]),
      // Only clear the per-agent pin if it actually points at THIS
      // account — never disturb a pin to a different account.
      (y) =>
        getAgentWorkspaceAccount(y, provider, agent) === account
          ? clearAgentWorkspaceAccount(y, provider, agent)
          : y,
    );
  }

  // 1. Compute + schema-validate the edit (no write). Reject a broken
  //    edit before bothering the operator with a card.
  let plan;
  try {
    plan = planConfigEdit(configPath, transform);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof ConfigPlanError ? err.message : (err as Error).message,
    };
  }
  if (!plan.changed) {
    return { ok: true, changed: false };
  }

  // 2. Need hostd to write it (the sole writer + the approval card).
  const socketPath = deps.socketPath !== undefined ? deps.socketPath : resolveHostdOperatorSocket();
  if (!socketPath) {
    return {
      ok: false,
      error:
        "hostd operator socket not found — credential grants require hostd (the Telegram approval path). " +
        "Ensure host_control is enabled and the switchroom-web container mounts ~/.switchroom.",
    };
  }

  // 3. Build the diff and fire the proposal in the BACKGROUND (hostd
  //    blocks on the operator's tap; the POST must return immediately).
  let diff: string;
  try {
    diff = (deps.generateDiff ?? generateUnifiedDiff)(plan.before, plan.after);
  } catch (err) {
    return { ok: false, error: `could not build config diff: ${(err as Error).message}` };
  }

  const now = deps.now ?? Date.now;
  const requestId = randomUUID();
  const reason = `dashboard: ${args.action} ${agent} on ${account} (${provider})`;
  connectionAccessStatuses.set(requestId, { state: "pending", startedAt: now() });
  reapConnectionAccessStatuses(now());

  const propose =
    deps.propose ??
    ((reqId, d, r) =>
      proposeConfigEditViaHostd({ requestId: reqId, unifiedDiff: d, reason: r, socketPath }));

  void propose(requestId, diff, reason)
    .then((outcome) => {
      const startedAt = connectionAccessStatuses.get(requestId)?.startedAt ?? now();
      if (outcome.state === "applied") {
        connectionAccessStatuses.set(requestId, { state: "applied", startedAt, restartAgent: agent });
      } else if (outcome.state === "denied") {
        connectionAccessStatuses.set(requestId, { state: "denied", startedAt, reason: outcome.reason });
      } else {
        connectionAccessStatuses.set(requestId, { state: "error", startedAt, reason: outcome.reason });
      }
      void captureEvent("connection_access", {
        provider,
        action: args.action,
        outcome: outcome.state,
        source: "web_api",
      });
    })
    .catch((err) => {
      const startedAt = connectionAccessStatuses.get(requestId)?.startedAt ?? now();
      connectionAccessStatuses.set(requestId, {
        state: "error",
        startedAt,
        reason: err instanceof Error ? err.message : String(err),
      });
      void captureException(err, { action: "connection_access", provider });
    });

  return { ok: true, changed: true, requestId, pendingApproval: true };
}

/**
 * Cron schedule view: every cascade-resolved schedule entry plus the
 * most-recent fire rows from each agent's host-side `scheduler.jsonl`
 * (the bind source for the in-container `/state/agent/scheduler.jsonl`
 * ledger). No next-fire calculation — that needs a cron parser we
 * deliberately don't depend on; the cron expression + recent-fire
 * history is the high-signal data without the dep.
 */
export interface ScheduleDashboard {
  entries: SchedulerEntry[];
  /** agent → most-recent DispatchResult rows (newest last), capped. */
  recentByAgent: Record<string, DispatchResult[]>;
}

export function handleGetSchedule(
  config: SwitchroomConfig,
): ScheduleDashboard {
  const entries = collectScheduleEntries(config);
  const agentsDir = resolveAgentsDir(config);
  const recentByAgent: Record<string, DispatchResult[]> = {};
  const agents = new Set(entries.map((e) => e.agent));
  for (const agent of agents) {
    // Reuse the canonical ledger reader (existsSync + torn-line skip
    // baked in) so the dashboard and the boot-replay path can't drift.
    const rows = readRecentFires(
      resolve(agentsDir, agent, "scheduler.jsonl"),
    );
    if (rows.length > 0) recentByAgent[agent] = rows.slice(-10);
  }
  return { entries, recentByAgent };
}

/**
 * Approval-kernel decision ledger (RFC B) — the host read-only view
 * over the operator socket added in #1362. The kernel restricts that
 * socket to `approval_list`, so this is observation only: no grant /
 * consume / revoke is reachable from here by construction.
 *
 * Three states, each rendered distinctly rather than collapsed:
 *   - operator socket absent  → kernel not host-reachable on this
 *     install (pre-#1362 deploy, or operatorUid unset). `reachable:false`.
 *   - socket present, RPC null → kernel down / protocol error.
 *   - ok → decisions[] (newest first for the table).
 */
export interface ApprovalsDashboard {
  reachable: boolean;
  decisions: ApprovalDecisionMeta[];
  error?: string;
}

export async function handleGetApprovals(): Promise<ApprovalsDashboard> {
  const opSock = resolveKernelOperatorSocket();
  if (opSock === null) {
    return {
      reachable: false,
      decisions: [],
      error:
        "approval-kernel operator socket not present — host-side approval " +
        "listing needs operatorUid set (compose) and a post-#1362 deploy.",
    };
  }
  // No agent_unit filter → fleet-wide. Pin opts.socket to the operator
  // socket so the resolver doesn't fall through to the broker.
  const decisions = await approvalList(undefined, { socket: opSock });
  if (decisions === null) {
    return {
      reachable: false,
      decisions: [],
      error: "approval-kernel unreachable or returned an error",
    };
  }
  // Newest first — most relevant grant at the top of the table.
  const sorted = [...decisions].sort((a, b) => b.granted_at - a.granted_at);
  return { reachable: true, decisions: sorted };
}
