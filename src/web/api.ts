import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import type { AgentConfig, SwitchroomConfig } from "../config/schema.js";
import {
  getAllAgentStatuses,
} from "../agents/lifecycle.js";
import { getAllAuthStatuses } from "../auth/manager.js";
import {
  collectProfileBanks,
  getCollectionForAgent,
  probeHindsight,
} from "../memory/hindsight.js";
import {
  inspectBankHealth,
  getMentalModelDetail,
  staleMentalModels,
  corruptedMentalModels,
  recentUnextracted,
  ageDays,
  type BankMentalModelSummary,
  type MentalModelDetail,
} from "../memory/bank-health.js";
import {
  reprocessDocuments,
  refreshMentalModel,
  buildUserProfile,
  restBaseFromMcpUrl,
} from "./memory-remediation.js";
import {
  getHindsightStatus,
} from "../setup/hindsight.js";
import {
  formatBlockedFor,
  handleGetBlockedApprovals,
  type BlockedApproval,
} from "./blocked-approvals-read.js";
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
import { listGrantsViaBroker } from "../vault/broker/client.js";
import type { ApprovalDecisionMeta } from "../vault/broker/protocol.js";
import { homedir } from "node:os";
import { captureEvent, captureException } from "../analytics/posthog.js";
import { resolveAgentsDir } from "../config/loader.js";
import type { ContextSnapshot } from "../cli/doctor-context.js";
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
import {
  fetchFleetStatusViaHostd,
  fetchScheduleViaHostd,
  fetchAgentLogsViaHostd,
  restartAgentViaHostd,
} from "./hostd-read-client.js";
import type { AgentStatus } from "../agents/lifecycle.js";
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
import { openTurnsDb, listTurnsForAgent, listDistinctThreadIds, type Turn } from "../../telegram-plugin/registry/turns-schema.js";
import { applySubagentsSchema, listSubagents, type Subagent } from "../../telegram-plugin/registry/subagents-schema.js";
import { SwrCache } from "./cache.js";

/**
 * Shared stale-while-revalidate cache for the dashboard's read-only
 * panels. Every expensive READ route (system-health, memory-health,
 * schedule, agents, accounts, approvals) goes through this so a tab-open
 * or poll-tick serves a cached value fast and at most one background
 * refresh hits the host (docker inspect / broker RPC / hindsight probe /
 * hostd round-trip / per-agent sqlite). The `/api/summary` aggregate
 * pulls each part through the SAME keys + TTLs, so a Summary open warms
 * the per-tab caches (and vice-versa) — they can never disagree.
 *
 * NOT cached: the billed quota refresh (`handleRefreshAccountsQuota`),
 * any mutation (start/stop/restart/use/connect/access), webhooks, logs WS.
 */
export const dashboardCache = new SwrCache();

/** Cache TTLs (ms), keyed by the dashboard route. Tuned per cost/churn:
 *  fast-changing + cheap (agents) gets a short TTL; expensive + slow-
 *  changing (memory-health, one MCP round-trip per bank) gets a long one. */
export const DASHBOARD_CACHE_TTL = {
  "system-health": 15000,
  "memory-health": 60000,
  schedule: 30000,
  agents: 5000,
  accounts: 10000,
  approvals: 15000,
  grants: 15000,
} as const;

/** Test-only: reset the shared dashboard cache between cases. */
export function __resetDashboardCacheForTests(): void {
  dashboardCache.clear();
}

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
  /**
   * When the agent last STARTED a turn (newest `turns.started_at`, unix
   * ms), or null when the agent has no turns DB / no turns yet. A real
   * claude-liveness signal distinct from `active` — which only reflects
   * the bridge↔gateway `.bridge-alive` heartbeat (a claude wedged on a
   * quota menu still shows `active`). The UI renders this as "Last turn".
   */
  lastTurnAt: number | null;
  /**
   * Working-context headroom snapshot the gateway writes at each idle gate
   * (RFC context-headroom-surface): occupancy / cap / state. Null when the
   * agent hasn't run a turn since boot (no snapshot) or it's unreadable. The
   * UI renders a gauge; pillar 3 (predictable) made visible.
   */
  context: ContextSnapshot | null;
}

/**
 * Read an agent's context-occupancy snapshot from `<agentsDir>/<name>/
 * context-occupancy.json` (the gateway writes it in-container to
 * /state/agent/, host-mounted here). Null on any error — missing snapshot
 * (idle since boot) / unreadable / malformed → the UI shows "—". Mirrors
 * readLastTurnAt's degrade-to-null contract.
 */
export function readContextOccupancy(
  agentsDir: string,
  name: string,
): ContextSnapshot | null {
  try {
    const raw = readFileSync(resolve(agentsDir, name, "context-occupancy.json"), "utf-8");
    const s = JSON.parse(raw) as ContextSnapshot;
    if (typeof s?.occupancy !== "number") return null;
    return s;
  } catch {
    return null;
  }
}

/**
 * Read the newest turn's `started_at` for an agent from its per-agent
 * turns DB. `started_at` (not `ended_at`) is the field that always
 * exists and best represents "when the agent last ran a turn" — an
 * in-flight turn has a null `ended_at` but a real `started_at`, and
 * `listTurnsForAgent` already orders by `started_at DESC`, so the top
 * row is the most recent activity. Wrapped in try/catch → null on a
 * missing DB / read error / `bun:sqlite` unavailable (under vitest the
 * Bun-only sqlite loader throws — the dashboard runs under Bun, so this
 * is real there and degrades to null in tests).
 */
export function readLastTurnAt(agentsDir: string, name: string): number | null {
  try {
    const db = openTurnsDb(resolve(agentsDir, name));
    try {
      const turns = listTurnsForAgent(db, { limit: 1 });
      return turns.length > 0 ? turns[0].started_at : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/**
 * Docker-free agent-liveness check for the web container: an agent's gateway
 * touches `<agentsDir>/<name>/telegram/.bridge-alive` every ~5s (bridge
 * heartbeat). A mtime within `maxAgeMs` means the gateway is live. Returns
 * false on any error (missing file / unreadable) — i.e. treat as not-alive.
 */
export function agentBridgeAlive(
  agentsDir: string,
  name: string,
  maxAgeMs = 30_000,
  now: number = Date.now(),
): boolean {
  try {
    const f = resolve(agentsDir, name, "telegram", ".bridge-alive");
    return now - statSync(f).mtimeMs <= maxAgeMs;
  } catch {
    return false;
  }
}

/**
 * Short-TTL cache for the hostd-backfilled fleet status. `/api/agents` is
 * polled every ~10s by the dashboard; without a cache that poll would
 * round-trip hostd (and thus `docker inspect`/`docker stats` host-side)
 * every tick → a docker-stats storm. A ~5s TTL means at most one hostd
 * round-trip per poll cycle. Mirrors the `quotaCache` module-Map pattern.
 * Single key (`"fleet"`) — the web always asks hostd for the whole fleet.
 */
export const AGENT_STATUS_CACHE_TTL_MS = 5000;
interface StatusCacheEntry {
  statuses: Record<string, AgentStatus> | null;
  fetchedAt: number;
}
const statusCache = new Map<string, StatusCacheEntry>();

/** Test-only: reset the module status cache between cases. */
export function __resetAgentStatusCacheForTests(): void {
  statusCache.clear();
}

/**
 * TTL-cached hostd fleet-status fetch. Returns the (possibly null)
 * backfill map. `fetch` is injectable for tests. A `null` from hostd is
 * cached too — so a down daemon doesn't get hammered every 10s tick.
 */
async function cachedFleetStatus(
  now: number,
  fetchImpl: () => Promise<Record<string, AgentStatus> | null> = fetchFleetStatusViaHostd,
): Promise<Record<string, AgentStatus> | null> {
  const cached = statusCache.get("fleet");
  if (cached && now - cached.fetchedAt < AGENT_STATUS_CACHE_TTL_MS) {
    return cached.statuses;
  }
  const statuses = await fetchImpl();
  statusCache.set("fleet", { statuses, fetchedAt: now });
  return statuses;
}

export async function handleGetAgents(
  config: SwitchroomConfig,
  deps: {
    now?: number;
    fetchFleetStatus?: () => Promise<Record<string, AgentStatus> | null>;
    /** Injectable for tests (default reads the real per-agent turns DB,
     *  which needs `bun:sqlite` — unavailable under vitest). */
    readLastTurn?: (agentsDir: string, name: string) => number | null;
    /** Injectable for tests (default reads the per-agent snapshot file). */
    readContext?: (agentsDir: string, name: string) => ContextSnapshot | null;
  } = {},
): Promise<AgentInfo[]> {
  const readLastTurn = deps.readLastTurn ?? readLastTurnAt;
  const readContext = deps.readContext ?? readContextOccupancy;
  const statuses = getAllAgentStatuses(config);
  const authStatuses = getAllAuthStatuses(config);
  const agentsDir = resolveAgentsDir(config);
  const agents: AgentInfo[] = [];

  // Dockerless web: `getAllAgentStatuses` shells docker and returns
  // uptime/memory=null for every agent. hostd (root, docker socket) can
  // read them — backfill from it when any status is missing them. TTL-
  // cached so the 10s poll doesn't storm docker-stats. Never throws:
  // hostd unreachable ⇒ null ⇒ we keep the null uptime/memory.
  const needsBackfill = Object.values(statuses).some(
    (s) => s && (s.uptime === null || s.memory === null),
  );
  const hostdStatuses = needsBackfill
    ? await cachedFleetStatus(deps.now ?? Date.now(), deps.fetchFleetStatus)
    : null;

  for (const [name, agentConfig] of Object.entries(config.agents)) {
    const status = statuses[name];
    const auth = authStatuses[name];
    const collection = getCollectionForAgent(name, config);
    const resolved = resolveAgentConfig(config.defaults, config.profiles, agentConfig);
    // RFC H schema: per-agent `auth.override:` wins, else fleet-wide
    // `auth.active`. No more per-agent fallback list.
    const primaryAccount = resolved.auth?.override ?? config.auth?.active;

    // `getAllAgentStatuses` derives `active` from `docker ps`, which throws in
    // the dockerless web container → every agent reads "inactive". Fall back to
    // the gateway's `.bridge-alive` heartbeat (touched every ~5s; web mounts
    // the agents dir): a fresh mtime means the gateway is live. Only used when
    // the docker signal isn't already "active", so docker-context callers are
    // unchanged.
    const active =
      status?.active === "active"
        ? "active"
        : agentBridgeAlive(agentsDir, name)
          ? "active"
          : (status?.active ?? "unknown");

    // uptime/memory: prefer the local docker read; backfill from hostd
    // when the dockerless path left them null. `active` keeps the
    // docker-or-.bridge-alive logic above (hostd is only consulted for
    // the two fields the web genuinely cannot read).
    const hostd = hostdStatuses?.[name];
    const uptime = status?.uptime ?? hostd?.uptime ?? null;
    const memory = status?.memory ?? hostd?.memory ?? null;

    agents.push({
      name,
      active,
      uptime,
      memory,
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
      // A real claude-liveness signal (newest turn's start), distinct
      // from `active` (bridge heartbeat only). Null-safe per agent.
      lastTurnAt: readLastTurn(agentsDir, name),
      context: readContext(agentsDir, name),
    });
  }

  return agents;
}

/**
 * Start/Stop from the dashboard are deferred to a follow-up PR — they
 * need a new Telegram approval card (start/stop are NOT ungated like
 * restart). Until then the dashboard does NOT shell docker (the web
 * container is dockerless BY DESIGN — that would `spawn` ENOENT).
 * It returns this actionable message pointing the operator at the host
 * CLI. `verb` is "start" or "stop".
 */
export function startStopNeedsOperatorMessage(verb: "start" | "stop"): string {
  return (
    `${verb === "start" ? "Start" : "Stop"} from the dashboard needs operator approval (a follow-up). ` +
    `For now run on the host: \`switchroom agent ${verb} ${"<name>"}\`.`
  );
}

/** Exported for tests + UI parity — the static start/stop deferral text. */
export const START_NEEDS_OPERATOR_MESSAGE = startStopNeedsOperatorMessage("start");
export const STOP_NEEDS_OPERATOR_MESSAGE = startStopNeedsOperatorMessage("stop");

export async function handleStartAgent(
  _name: string,
): Promise<{ ok: boolean; error?: string }> {
  // Deferred to the start/stop-approval PR. Do NOT shell docker (dockerless
  // web → ENOENT) — return the actionable host-CLI message instead.
  return { ok: false, error: START_NEEDS_OPERATOR_MESSAGE };
}

export async function handleStopAgent(
  _name: string,
): Promise<{ ok: boolean; error?: string }> {
  // Deferred to the start/stop-approval PR. See handleStartAgent.
  return { ok: false, error: STOP_NEEDS_OPERATOR_MESSAGE };
}

/**
 * Restart an agent from the dashboard. The web container is dockerless BY
 * DESIGN, so this CANNOT shell `restartAgent()` (→ `spawn docker ENOENT`).
 * It routes through hostd's existing `agent_restart` verb over the
 * ungated operator socket — the operator chose restart to be UNGATED, so
 * it acts immediately (no approval card). When hostd is unreachable the
 * helper returns an actionable "needs hostd" message instead of a raw
 * docker error. `deps.restart` is injectable for tests.
 */
export async function handleRestartAgent(
  name: string,
  deps: { restart?: typeof restartAgentViaHostd } = {},
): Promise<{ ok: boolean; error?: string }> {
  const restart = deps.restart ?? restartAgentViaHostd;
  try {
    const result = await restart(name);
    if (result.ok) {
      void captureEvent("agent_restarted", { agent: name, source: "web_api" });
      return { ok: true };
    }
    return { ok: false, error: result.error };
  } catch (err) {
    void captureException(err, { action: "restart_agent", agent: name });
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function handleGetLogs(
  name: string,
  lines: number = 50,
  deps: {
    fetchLogs?: typeof fetchAgentLogsViaHostd;
  } = {},
): Promise<{ ok: boolean; logs?: string; error?: string }> {
  // The web container is dockerless BY DESIGN (no docker binary/socket —
  // security hardening). It cannot `docker logs`. Route through hostd's
  // existing `agent_logs` verb (hostd runs as root with the docker
  // socket). hostd already merges the container's stdout/stderr streams
  // and caps the tail at 4 KiB — acceptable for this one-shot view; live
  // streaming is a later PR. When hostd is unreachable the helper returns
  // an actionable "needs hostd" message instead of a raw
  // `spawn docker ENOENT`.
  const fetchLogs = deps.fetchLogs ?? fetchAgentLogsViaHostd;
  return await fetchLogs(name, lines);
}

/**
 * Parse a Hermes session ID into agentName + optional threadId.
 * Format: "agentName" (DM / general topic) or "agentName~threadId" (forum topic).
 * threadId === null means explicitly the null/general thread (not "all threads").
 */
export function parseHermesSessionId(sessionId: string): { agentName: string; threadId?: string | null } {
  const tilde = sessionId.indexOf('~')
  if (tilde === -1) return { agentName: sessionId }
  return { agentName: sessionId.slice(0, tilde), threadId: sessionId.slice(tilde + 1) || null }
}

export function handleGetTurns(
  config: SwitchroomConfig,
  sessionId: string,
  limit: number,
): { ok: boolean; turns?: Turn[]; error?: string } {
  try {
    const parsed = parseHermesSessionId(sessionId)
    const agentName = parsed.agentName
    const hasThread = 'threadId' in parsed
    const agentsDir = resolveAgentsDir(config);
    const agentDir = resolve(agentsDir, agentName);
    const chatId: string | undefined =
      config.agents?.[agentName]?.channels?.telegram?.chat_id ?? undefined;
    const db = openTurnsDb(agentDir);
    try {
      // For threaded sessions, filter by both chatId and threadId.
      // hasThread means the session ID had a "~" — even "~null" (general topic).
      const opts = chatId && hasThread
        ? { limit, chatId, threadId: parsed.threadId }
        : chatId
        ? { limit, chatId }
        : { limit }
      const turns = listTurnsForAgent(db, opts);
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

/** List distinct forum thread_ids for a supergroup agent. Returns [] for DM agents. */
export function handleListThreadIds(
  config: SwitchroomConfig,
  agentName: string,
): (string | null)[] {
  try {
    const chatId = config.agents?.[agentName]?.channels?.telegram?.chat_id
    if (!chatId) return []
    const agentsDir = resolveAgentsDir(config)
    const db = openTurnsDb(resolve(agentsDir, agentName))
    try {
      return listDistinctThreadIds(db, chatId)
    } finally {
      db.close()
    }
  } catch {
    return []
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
   * Live 5h/7d utilization. Sourced (in order) from the in-process probe
   * cache (the billed ↻ button), else the broker's own `last_quota` snapshot
   * — which the default-on fleet quota probe populates for FREE, so a cold
   * tab shows live usage without spending a billed probe. null only when
   * neither source has data.
   */
  quotaUsage: AccountQuotaUsage | null;
  /** Where quotaUsage came from: a billed probe, the free broker snapshot, or nothing. */
  quotaUsageSource: "probe" | "broker-cache" | null;
  /** true when the displayed usage is older than the cache TTL (UI hints ↻). */
  quotaStale: boolean;
  /** Agents currently bound to this account (fleet active or per-agent override). */
  usedBy: string[];
}

/** ISO 8601 → unix ms, or null when absent/unparseable. */
export function isoToMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Resolve the 5h/7d usage to show for an account, preferring (in order):
 *   1. the in-process probe cache (freshest — from the billed ↻ button), then
 *   2. the broker's own `last_quota` snapshot, which the default-on fleet
 *      quota probe keeps fresh for FREE — so a cold tab shows live usage with
 *      no billed probe (the ↻ stays a true force-refresh).
 * null only when neither source has data. Pure + exported for unit testing.
 */
export function deriveAccountQuotaView(
  brokerState: AccountState | null,
  probe: { usage: AccountQuotaUsage | null; fetchedAt: number } | undefined,
  now: number,
): {
  quotaUsage: AccountQuotaUsage | null;
  quotaUsageSource: "probe" | "broker-cache" | null;
  quotaStale: boolean;
} {
  const probeFresh = !!probe && now - probe.fetchedAt < QUOTA_CACHE_TTL_MS;
  let quotaUsage: AccountQuotaUsage | null = probeFresh ? (probe!.usage ?? null) : null;
  let quotaUsageSource: "probe" | "broker-cache" | null = quotaUsage ? "probe" : null;
  let quotaStale = !probeFresh;

  if (!quotaUsage && brokerState?.last_quota) {
    const lq = brokerState.last_quota;
    quotaUsage = {
      fiveHourPct: lq.fiveHourUtilizationPct,
      sevenDayPct: lq.sevenDayUtilizationPct,
      fiveHourResetAt: isoToMs(lq.fiveHourResetAt),
      sevenDayResetAt: isoToMs(lq.sevenDayResetAt),
      capturedAt: lq.capturedAt,
    };
    quotaUsageSource = "broker-cache";
    quotaStale = now - lq.capturedAt >= QUOTA_CACHE_TTL_MS;
  }
  return { quotaUsage, quotaUsageSource, quotaStale };
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
    const brokerState = brokerAccounts.get(info.label) ?? null;
    const view = deriveAccountQuotaView(brokerState, quotaCache.get(info.label), now);

    return {
      ...info,
      // The on-disk health (from the abandoned meta.json) can never show
      // quota-exhausted; the broker's exhausted flag is the live authority.
      health: brokerState?.exhausted ? "quota-exhausted" : info.health,
      quota: brokerState,
      quotaUsage: view.quotaUsage,
      quotaUsageSource: view.quotaUsageSource,
      quotaStale: view.quotaStale,
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

/**
 * Read-only / health-probe hostd verbs excluded from the "recent privileged
 * verbs" panel — they aren't mutations and (agent_smoke especially) dominate
 * the audit log, drowning the real actions the panel is meant to show.
 */
const HOSTD_NOISE_OPS = new Set<string>([
  "agent_smoke",
  "get_status",
  "agent_status",
  "agent_logs",
]);

export async function handleGetSystemHealth(
  config?: SwitchroomConfig,
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
  // "running" must come from an HTTP probe, NOT `docker ps`: the web
  // container is dockerless by design (no socket mounted), so the docker
  // helpers below throw and would falsely report hindsight DOWN even when it
  // is serving. The web reaches hindsight over host networking, so probe its
  // MCP endpoint — which also tests that it's actually *serving*, not merely
  // that a container exists. The docker-based fields (containerStatus, env)
  // stay best-effort: populated when docker IS available (CLI/host context),
  // null in the web container — but they no longer gate the running dot.
  const memoryUrl =
    (config?.memory?.config?.url as string | undefined) ??
    "http://127.0.0.1:18888/mcp/";
  let running = false;
  try {
    running = (await probeHindsight(memoryUrl)).ok;
  } catch {
    running = false;
  }
  const containerStatus = getHindsightStatus(); // null without docker
  const env = inspectEnv("switchroom-hindsight", [
    "HINDSIGHT_API_LLM_MODEL",
    "HINDSIGHT_API_LLM_PROVIDER",
    "HINDSIGHT_API_MCP_STATELESS",
  ]); // all null without docker — fine, the dot comes from `running`
  const statelessRaw = env.HINDSIGHT_API_MCP_STATELESS;
  const hindsight: SystemHealth["hindsight"] = {
    containerStatus,
    running,
    model: env.HINDSIGHT_API_LLM_MODEL,
    // Fall back to the configured provider when docker inspect is unavailable.
    provider:
      env.HINDSIGHT_API_LLM_PROVIDER ??
      ((config?.memory?.config?.provider as string | undefined) ?? null),
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
      // Drop read-only/health-probe verbs — agent_smoke alone is the large
      // majority of rows and buries the actual privileged mutations this
      // panel exists to surface. Read a wide window, filter, then take 10.
      hostd.recent = readAndFilter(raw, {}, 1000)
        .filter((e) => !HOSTD_NOISE_OPS.has(e.op))
        .slice(-10);
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
    // Degraded — never 500 the dashboard: ANY broker error (unreachable OR a
    // protocol/internal error) falls through to the config-only union so a
    // configured account never vanishes (the #2239 vanish bug via the
    // error-response channel). Log the non-unreachable case for diagnosis.
    if (!(err instanceof AuthBrokerUnreachableError)) {
      process.stderr.write(
        `dashboard: live broker error reading workspace accounts ` +
          `(${err instanceof AuthBrokerError ? err.code : "unknown"}); ` +
          `showing config-only ACL: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    // ACL still renders from config; live fields stay null.
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
    // Degraded — never 500 the dashboard: ANY broker error (unreachable OR a
    // protocol/internal error) falls through to the config-only union so a
    // configured account never vanishes (the #2239 vanish bug via the
    // error-response channel). Log the non-unreachable case for diagnosis.
    if (!(err instanceof AuthBrokerUnreachableError)) {
      process.stderr.write(
        `dashboard: live broker error reading workspace accounts ` +
          `(${err instanceof AuthBrokerError ? err.code : "unknown"}); ` +
          `showing config-only ACL: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    // ACL still renders from config; live fields stay null.
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

export interface LinearAgentInfo {
  /** Agent name. */
  agent: string;
  /** Linear workspace (organization) id, if declared. */
  workspaceId: string | null;
  /** Default Linear team id new captured issues file into, if declared. */
  defaultTeamId: string | null;
  /**
   * Vault key REFERENCE for the OAuth access token (e.g.
   * `vault:linear/<agent>/token`) — never the token itself. Null if the
   * config field is absent or (defensively) not a `vault:` reference.
   */
  tokenVaultKey: string | null;
}

export interface LinearAgentsDashboard {
  /** True when at least one agent is connected as a Linear OAuth app actor. */
  configured: boolean;
  /** Agents with `channels.telegram.linear_agent.enabled` (cascade-resolved). */
  agents: LinearAgentInfo[];
}

/**
 * Linear view for the dashboard. Linear has exactly ONE integration mode:
 * the first-class OAuth **app actor** (`channels.telegram.linear_agent`) — an
 * agent appears in the workspace as its own actor (#2298). There is no
 * "personal API token for MCP" alternative, so an agent with
 * `linear_agent.enabled` IS connected as a Linear OAuth agent.
 *
 * This is config-only (like Notion): the internet-facing web tier reads the
 * cascade-resolved per-agent config and returns only metadata + the token's
 * vault-key REFERENCE. It never reads the vault, so the access token / OAuth
 * refresh bundle (client_secret, refresh_token) never reach the web tier or
 * the client. Live token freshness lives with the in-agent gateway's proactive
 * `linear-auth-watch` (which alerts the operator on Telegram); surfacing it
 * here would require the web tier to read per-agent vault state, which the
 * minimal-surface web container deliberately cannot do.
 */
export function handleGetLinearAgents(
  config: SwitchroomConfig,
): LinearAgentsDashboard {
  const agentNames = Object.keys(config.agents ?? {});
  const agents: LinearAgentInfo[] = [];
  for (const name of agentNames) {
    const rawAgent = config.agents?.[name];
    if (!rawAgent) continue;
    const linear = resolveAgentConfig(
      config.defaults,
      config.profiles,
      rawAgent,
    ).channels?.telegram?.linear_agent;
    if (!linear?.enabled) continue;
    // The schema mandates a `vault:` reference; surface it only when it
    // actually looks like one so a misconfigured inline literal can't leak.
    const tok = linear.token;
    const tokenVaultKey =
      typeof tok === "string" && tok.startsWith("vault:") ? tok : null;
    agents.push({
      agent: name,
      workspaceId: linear.workspace_id ?? null,
      defaultTeamId: linear.default_team_id ?? null,
      tokenVaultKey,
    });
  }
  agents.sort((a, b) => a.agent.localeCompare(b.agent));
  return { configured: agents.length > 0, agents };
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
  /**
   * True when hostd was unreachable and this view is base-config-only —
   * i.e. it is MISSING the agent-authored `schedule.d/*.yaml` cron
   * overlays (0600, owned by the agent UID → operator/web gets EACCES;
   * only hostd, as root, can read them). The UI uses this to warn that
   * an agent may be firing crons not shown here.
   */
  degraded?: boolean;
  /** Human-readable explanation when `degraded` is true. */
  reason?: string;
  /** True when hostd shed entries/fires to fit the response frame (a
   *  pathologically large fleet) — the view is otherwise accurate. */
  truncated?: boolean;
}

/**
 * Cron schedule view. The accurate source is hostd (`agent_schedule`):
 * it re-loads config FRESH as root, merging each agent's 0600
 * `schedule.d/*.yaml` overlays the dockerless web can't read — so it's
 * the SUPERSET (e.g. clerk's 9 agent-authored crons). When hostd is
 * unreachable we fall back to the base-config-only
 * `collectScheduleEntries(config)` and mark the response `degraded` so
 * the UI can say "schedule view needs hostd — showing base-config only".
 *
 * `fetchSchedule` is injectable for tests.
 */
export async function handleGetSchedule(
  config: SwitchroomConfig,
  deps: {
    fetchSchedule?: typeof fetchScheduleViaHostd;
  } = {},
): Promise<ScheduleDashboard> {
  const fetchSchedule = deps.fetchSchedule ?? fetchScheduleViaHostd;
  const viaHostd = await fetchSchedule();
  if (viaHostd) {
    // hostd already bounded the payload (last 8 fires/agent, truncated
    // prompts/summaries, slim entries); pass it through unchanged.
    return {
      entries: viaHostd.entries,
      recentByAgent: viaHostd.recentByAgent,
      ...(viaHostd.truncated ? { truncated: true } : {}),
    };
  }

  // Degraded: hostd unreachable. Base-config-only view (no overlay crons).
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
  return {
    entries,
    recentByAgent,
    degraded: true,
    reason:
      "schedule view needs hostd — showing base-config only " +
      "(agent-authored schedule.d crons are not included). " +
      "Ensure host_control is enabled.",
  };
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

/**
 * Host-side vault-broker OPERATOR socket path — the host end of the
 * compose bind `~/.switchroom/broker-operator → /run/switchroom/broker/operator`.
 * The broker restricts this socket to read-only ops (notably
 * `list_grants`), so it is safe for the host observer (the web dashboard)
 * and is what `switchroom vault grants` reads passphrase-free.
 *
 * Mirrors `resolveKernelOperatorSocket` (approvals/client.ts): probe the
 * host fs here and pass the result as `opts.socket` to `listGrantsViaBroker`
 * — deliberately NOT folded into the broker's own `resolveBrokerSocketPath`,
 * which stays a pure env/opts function so no other caller's behaviour
 * depends on whether this socket happens to exist.
 */
export function brokerOperatorSocketPath(
  home: string = process.env.HOME || homedir(),
): string {
  return join(home, ".switchroom", "broker-operator", "sock");
}

/**
 * Resolve the host broker-operator socket iff it exists, else null. The
 * read-only host caller uses this to decide whether to talk to the broker;
 * absent ⇒ the grants view degrades (broker not host-reachable) rather
 * than silently changing the broker resolver contract.
 */
export function resolveBrokerOperatorSocket(
  home: string = process.env.HOME || homedir(),
): string | null {
  const p = brokerOperatorSocketPath(home);
  return existsSync(p) ? p : null;
}

/**
 * Standing capability grants (the vault-broker grants DB) for the dashboard
 * Approvals tab. The approval-KERNEL decision ledger (`handleGetApprovals`)
 * is honestly empty on most installs — the daily per-tool Allow/Deny taps
 * never write it — so the operator's REAL standing grants live here, in the
 * broker's `list_grants` op (the same data `switchroom vault grants` shows).
 *
 * READ-ONLY by construction: this calls `list_grants` over the operator
 * socket (no agent filter → fleet-wide) and never grants/mints/revokes. No
 * model call, no docker, no broker WRITE op.
 *
 * Three states, each rendered distinctly:
 *   - operator socket absent  → broker not host-reachable on this install.
 *     `reachable:false` + an actionable error.
 *   - socket present, RPC unreachable/error → `reachable:false` + the
 *     broker's reason.
 *   - ok → grants[] (newest first for the table).
 */
export interface GrantDashboardRow {
  id: string;
  agent: string;
  /** Keys/globs this grant authorizes for READ. */
  keys: string[];
  /** Keys/globs this grant authorizes for WRITE. `[]` = read-only. */
  writeKeys: string[];
  /** unix MILLISECONDS (converted from the broker's unix seconds) or null. */
  expiresAt: number | null;
  /** unix MILLISECONDS (converted from the broker's unix seconds). */
  createdAt: number;
  description: string | null;
}

export interface GrantsDashboard {
  reachable: boolean;
  grants: GrantDashboardRow[];
  error?: string;
}

export async function handleGetGrants(
  deps: {
    socketPath?: string | null;
    list?: typeof listGrantsViaBroker;
  } = {},
): Promise<GrantsDashboard> {
  // `deps.socketPath` overrides the fs probe (tests / injected); when the
  // key is OMITTED we probe, when it's explicitly null we honour that.
  const socket =
    "socketPath" in deps ? deps.socketPath : resolveBrokerOperatorSocket();
  if (socket == null) {
    return {
      reachable: false,
      grants: [],
      error:
        "vault-broker operator socket not present — host-side grant " +
        "listing needs a broker-operator bind (re-apply to (re)create it).",
    };
  }
  const list = deps.list ?? listGrantsViaBroker;
  // No agent filter → all agents' grants. Pin opts.socket to the operator
  // socket so the broker resolver can't fall through to a non-operator path.
  // listGrantsViaBroker is contractually non-throwing, but wrap defensively
  // so this handler's documented "never throws" holds even if that contract
  // ever changes — a thrown error degrades to reachable:false, not a 500.
  let result: Awaited<ReturnType<typeof list>>;
  try {
    result = await list(undefined, { socket });
  } catch (err) {
    return {
      reachable: false,
      grants: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
  if (result.kind !== "ok") {
    // unreachable | error — surface the broker's reason; never throw.
    return { reachable: false, grants: [], error: result.msg };
  }
  // GrantMeta `created_at` / `expires_at` are unix SECONDS (see
  // src/vault/grants.ts — `Math.floor(Date.now() / 1000)`); the UI's
  // `formatTimestamp` expects unix MILLISECONDS, so convert at this
  // boundary (×1000) and document the unit on the row fields.
  const rows: GrantDashboardRow[] = result.grants.map((g) => ({
    id: g.id,
    agent: g.agent_slug,
    keys: g.key_allow,
    writeKeys: g.write_allow,
    expiresAt: g.expires_at == null ? null : g.expires_at * 1000,
    createdAt: g.created_at * 1000,
    description: g.description,
  }));
  // Newest first — most recent grant at the top of the table.
  rows.sort((a, b) => b.createdAt - a.createdAt);
  return { reachable: true, grants: rows };
}

/**
 * Per-agent memory-bank health for the dashboard Memory tab. Mirrors the
 * doctor's bank-ingest check (extraction gaps, mental-model staleness) so
 * the operator sees the same truth in both surfaces.
 */
export interface MemoryBankHealthRow {
  bank: string;
  agents: string[];
  ok: boolean;
  reason?: string;
  totalDocuments: number;
  totalFacts: number;
  pendingOperations: number;
  newestDocumentAt: string | null;
  /** Documents ≤30d old retained with zero extracted facts (silent extraction outage). */
  recentUnextractedCount: number;
  oldestUnextractedAt: string | null;
  /**
   * IDs of the recent-unextracted gap docs (the reprocess button's
   * targets), bounded to the first 20 so a huge backlog can't bloat the
   * payload. Server re-derives these on the POST — the client never
   * supplies them.
   */
  unextractedDocIds: string[];
  mentalModels: BankMentalModelSummary[];
  staleMentalModelCount: number;
  /** Models whose content is a persisted LLM-failure message (quota wall during refresh). */
  corruptedMentalModelNames: string[];
  /** ok | warn | fail — same thresholds as `switchroom doctor`. */
  status: "ok" | "warn" | "fail";
  statusDetail: string;
  /**
   * `agent` = an agent's own `memory.collection`; `profile` = a standalone
   * per-user / shared profile bank that recall routes to but no agent owns
   * (its `agents` list is empty). Lets the UI label profile banks distinctly.
   */
  kind: "agent" | "profile";
}

export interface MemoryHealth {
  reachable: boolean;
  url: string;
  banks: MemoryBankHealthRow[];
}

export async function handleGetMemoryHealth(
  config: SwitchroomConfig,
  opts?: { fetchImpl?: typeof fetch; now?: Date },
): Promise<MemoryHealth> {
  const url =
    (config.memory?.config?.url as string | undefined) ??
    "http://127.0.0.1:18888/mcp/";
  const now = opts?.now ?? new Date();

  let reachable = false;
  try {
    reachable = (await probeHindsight(url, { fetchImpl: opts?.fetchImpl })).ok;
  } catch {
    reachable = false;
  }
  if (!reachable) return { reachable, url, banks: [] };

  // Group agents sharing a bank (memory.collection) into one row.
  const banks = new Map<string, string[]>();
  for (const agentName of Object.keys(config.agents)) {
    const bank = getCollectionForAgent(agentName, config);
    banks.set(bank, [...(banks.get(bank) ?? []), agentName]);
  }

  // Profile banks (per-user / shared) have no owning agent — recall routes to
  // them but they're not any agent's collection. Add them as agent-less rows
  // so the operator sees their health alongside the agent banks.
  const profileBankSet = collectProfileBanks(config);
  for (const bank of profileBankSet) {
    if (!banks.has(bank)) banks.set(bank, []);
  }

  const rows = await Promise.all(
    [...banks].map(async ([bank, agents]): Promise<MemoryBankHealthRow> => {
      const h = await inspectBankHealth(url, bank, { fetchImpl: opts?.fetchImpl });
      const gaps = recentUnextracted(h.unextractedDocuments, 30, now);
      const stale = staleMentalModels(h.mentalModels, 7, now);
      const corrupted = corruptedMentalModels(h.mentalModels);
      const newestAge = ageDays(h.newestDocumentAt, now);
      // Mirror doctor.ts's "pending queue may be stuck" warn: pending
      // operations AND no new documents for >1d.
      const pendingStuck =
        h.pendingOperations > 0 && newestAge !== null && newestAge > 1;
      let status: MemoryBankHealthRow["status"] = "ok";
      let statusDetail = "facts flowing";
      if (!h.ok) {
        status = "warn";
        statusDetail = `inspection failed: ${h.reason ?? "unknown"}`;
      } else if (corrupted.length > 0) {
        status = "fail";
        statusDetail = `${corrupted.length} mental model(s) corrupted by an LLM failure message — injected into every turn until refreshed`;
      } else if (gaps.length > 0) {
        status = "fail";
        statusDetail = `${gaps.length} recent conversation(s) stored with zero extracted facts — invisible to recall`;
      } else if (pendingStuck) {
        // Doctor precedence: after gaps, before stale.
        status = "warn";
        statusDetail = `${h.pendingOperations} memory operation(s) pending with no new documents for ${Math.round(newestAge)}d — pipeline may be stuck`;
      } else if (stale.length > 0) {
        status = "warn";
        statusDetail = `${stale.length} mental model(s) not refreshed in >7d`;
      } else if (h.totalDocuments === 0) {
        status = "warn";
        statusDetail = "bank is empty";
      }
      return {
        bank,
        agents,
        ok: h.ok,
        reason: h.reason,
        totalDocuments: h.totalDocuments,
        totalFacts: h.totalFacts,
        pendingOperations: h.pendingOperations,
        newestDocumentAt: h.newestDocumentAt,
        recentUnextractedCount: gaps.length,
        oldestUnextractedAt: gaps[0]?.createdAt ?? null,
        unextractedDocIds: gaps.slice(0, 20).map((d) => d.id),
        mentalModels: h.mentalModels,
        staleMentalModelCount: stale.length,
        corruptedMentalModelNames: corrupted.map((m) => m.name),
        status,
        statusDetail,
        kind: profileBankSet.has(bank) ? "profile" : "agent",
      };
    }),
  );

  rows.sort((a, b) => a.bank.localeCompare(b.bank));
  return { reachable, url, banks: rows };
}

/**
 * Resolve the configured hindsight MCP url (default 127.0.0.1:18888).
 * Shared by the memory-remediation handlers below.
 */
function resolveMemoryUrl(config: SwitchroomConfig): string {
  return (
    (config.memory?.config?.url as string | undefined) ??
    "http://127.0.0.1:18888/mcp/"
  );
}

/**
 * Is `bank` a real memory bank for this fleet? Used to gate the
 * remediation POSTs so the dashboard can't poke an arbitrary bank.
 */
function isKnownBank(config: SwitchroomConfig, bank: string): boolean {
  for (const agentName of Object.keys(config.agents)) {
    if (getCollectionForAgent(agentName, config) === bank) return true;
  }
  // Profile banks (per-user / shared) are real banks too — allow remediation
  // (reprocess / refresh model) on them, same as agent banks.
  return collectProfileBanks(config).has(bank);
}

/**
 * POST /api/memory/reprocess — re-extract facts from the stuck (gap)
 * documents of a bank.
 *
 * The doc IDs are re-derived SERVER-SIDE from the live inspect result
 * (NOT trusted from the client) so a loopback-forgeable dashboard POST
 * can't reprocess arbitrary documents. Triggers only; hindsight runs
 * the extraction on its own provider — the web makes no model call.
 * Never throws.
 */
export async function handleMemoryReprocess(
  config: SwitchroomConfig,
  body: { bank?: unknown },
  deps?: {
    fetchImpl?: typeof fetch;
    trigger?: typeof reprocessDocuments;
    inspect?: typeof inspectBankHealth;
    now?: Date;
  },
): Promise<{ ok: boolean; triggered?: number; failed?: number; error?: string }> {
  const bank = typeof body.bank === "string" ? body.bank : "";
  if (!bank) return { ok: false, error: "Body must include `bank` (string)." };
  if (!isKnownBank(config, bank)) return { ok: false, error: `Unknown bank: ${bank}` };

  const url = resolveMemoryUrl(config);
  const inspect = deps?.inspect ?? inspectBankHealth;
  const trigger = deps?.trigger ?? reprocessDocuments;
  const now = deps?.now ?? new Date();

  try {
    const h = await inspect(url, bank, { fetchImpl: deps?.fetchImpl });
    if (!h.ok) return { ok: false, error: `inspection failed: ${h.reason ?? "unknown"}` };
    const gaps = recentUnextracted(h.unextractedDocuments, 30, now);
    const docIds = gaps.slice(0, 20).map((d) => d.id);
    if (docIds.length === 0) return { ok: true, triggered: 0, failed: 0 };

    const result = await trigger(restBaseFromMcpUrl(url), bank, docIds, {
      fetchImpl: deps?.fetchImpl,
    });
    return {
      ok: result.failed === 0,
      triggered: result.triggered,
      failed: result.failed,
      ...(result.error ? { error: result.error } : {}),
    };
  } catch (err) {
    return { ok: false, error: String((err as Error).message ?? err) };
  }
}

/**
 * POST /api/memory/refresh-model — regenerate one mental model (fixes a
 * corrupted or stale model).
 *
 * `modelId` is validated against the bank's ACTUAL mental models (live
 * inspect) before any POST, so the dashboard can't refresh an arbitrary
 * model id. Triggers only; no model call from the web. Never throws.
 */
export async function handleMemoryRefreshModel(
  config: SwitchroomConfig,
  body: { bank?: unknown; modelId?: unknown },
  deps?: {
    fetchImpl?: typeof fetch;
    trigger?: typeof refreshMentalModel;
    inspect?: typeof inspectBankHealth;
  },
): Promise<{ ok: boolean; error?: string }> {
  const bank = typeof body.bank === "string" ? body.bank : "";
  const modelId = typeof body.modelId === "string" ? body.modelId : "";
  if (!bank) return { ok: false, error: "Body must include `bank` (string)." };
  if (!modelId) return { ok: false, error: "Body must include `modelId` (string)." };
  if (!isKnownBank(config, bank)) return { ok: false, error: `Unknown bank: ${bank}` };

  const url = resolveMemoryUrl(config);
  const inspect = deps?.inspect ?? inspectBankHealth;
  const trigger = deps?.trigger ?? refreshMentalModel;

  try {
    const h = await inspect(url, bank, { fetchImpl: deps?.fetchImpl });
    if (!h.ok) return { ok: false, error: `inspection failed: ${h.reason ?? "unknown"}` };
    if (!h.mentalModels.some((m) => m.id === modelId)) {
      return { ok: false, error: `Unknown mental model for bank ${bank}` };
    }

    return await trigger(restBaseFromMcpUrl(url), bank, modelId, {
      fetchImpl: deps?.fetchImpl,
    });
  } catch (err) {
    return { ok: false, error: String((err as Error).message ?? err) };
  }
}

/**
 * POST /api/memory/build-profile — create-if-missing the user-profile
 * mental model for a bank (the "knows you" feature). Triggers hindsight
 * to build it on its own provider; no model call from the web. Never
 * throws.
 */
export async function handleMemoryBuildProfile(
  config: SwitchroomConfig,
  body: { bank?: unknown },
  deps?: { fetchImpl?: typeof fetch; trigger?: typeof buildUserProfile },
): Promise<{ ok: boolean; error?: string }> {
  const bank = typeof body.bank === "string" ? body.bank : "";
  if (!bank) return { ok: false, error: "Body must include `bank` (string)." };
  if (!isKnownBank(config, bank)) return { ok: false, error: `Unknown bank: ${bank}` };

  const url = resolveMemoryUrl(config);
  const trigger = deps?.trigger ?? buildUserProfile;
  try {
    return await trigger(url, bank, { fetchImpl: deps?.fetchImpl });
  } catch (err) {
    return { ok: false, error: String((err as Error).message ?? err) };
  }
}

export interface MentalModelDetailResult {
  ok: boolean;
  model?: MentalModelDetail;
  error?: string;
}

/**
 * GET /api/memory/model?bank=&id= — full detail for one mental model (the
 * content the operator reads + its provenance). On-demand so the memory-health
 * list stays light.
 *
 * SECURITY: `bank` is gated to a known fleet bank (no network); the model id
 * is then resolved straight against hindsight by-id, which 404s on an unknown
 * id (a forged loopback request can only READ models that genuinely exist in
 * the operator's own fleet banks — no write, no model call). This is a pure
 * read, so — unlike the remediation POSTs that trigger LLM work — it doesn't
 * pay the extra round-trip to re-validate the id against a full inspect.
 * Never throws.
 */
export async function handleGetMentalModel(
  config: SwitchroomConfig,
  bank: string,
  modelId: string,
  deps?: { fetchImpl?: typeof fetch; detail?: typeof getMentalModelDetail },
): Promise<MentalModelDetailResult> {
  if (!bank) return { ok: false, error: "Query must include `bank`." };
  if (!modelId) return { ok: false, error: "Query must include `id`." };
  if (!isKnownBank(config, bank)) return { ok: false, error: `Unknown bank: ${bank}` };

  const url = resolveMemoryUrl(config);
  const detail = deps?.detail ?? getMentalModelDetail;
  try {
    const res = await detail(url, bank, modelId, { fetchImpl: deps?.fetchImpl });
    if (!res.ok) return { ok: false, error: res.reason };
    return { ok: true, model: res.model };
  } catch (err) {
    return { ok: false, error: String((err as Error).message ?? err) };
  }
}

/**
 * The default Summary tab's single round-trip. Aggregates the cached
 * reads the tiles need so the client fetches ONE endpoint instead of
 * five. Each part is pulled through the SAME per-tab cache key + TTL it
 * has on its own route — so a Summary open warms the per-tab caches (and
 * vice-versa) and the two surfaces can never show different numbers.
 *
 * Each field degrades INDEPENDENTLY: the parts run under `Promise.all`,
 * but every producer is wrapped so a throw yields `null` for that field
 * (and `dataAsOf` 0 for the stamp calc) rather than failing the whole
 * summary. `dataAsOf` is the OLDEST of the parts' stamps (the summary is
 * only as fresh as its stalest piece). The caller (server.ts) supplies
 * the cache-bound producers via `deps`; the default reads are wired there.
 */
export interface SummaryDashboard {
  agents: AgentInfo[] | null;
  systemHealth: SystemHealth | null;
  approvals: ApprovalsDashboard | null;
  schedule: ScheduleDashboard | null;
  accounts: AccountDashboardInfo[] | null;
  /** Per-agent memory-bank health, pulled through the same cache key the
   *  Memory tab uses. Powers the "needs attention" memory rows. null when
   *  hindsight was unreachable / the producer threw. */
  memoryHealth: MemoryHealth | null;
  /** Agents held on an approval that could not be delivered to Telegram.
   *  Always an array — honest empty `[]` when nothing is blocked (and while
   *  the gateway-side record producer is not yet deployed). Powers the
   *  Summary "needs attention" rows and the blocked count on the services
   *  rail: a held agent must be visible WITHOUT Telegram. */
  blockedApprovals: BlockedApproval[];
  /** Server-derived triage list — the things that genuinely need the
   *  operator's eye right now, sorted critical→warn→info and capped. Empty
   *  when nothing is wrong. Each item points at the tab to investigate. */
  attention: AttentionItem[];
  /** Oldest (min) `dataAsOf` across the parts, unix ms — the summary's
   *  effective freshness. */
  dataAsOf: number;
}

/**
 * One row in the Summary tab's "needs attention" triage strip. Pure data,
 * derived server-side from the parts the summary already aggregates (no
 * new wire reads). `tab` is the dashboard tab the operator should open to
 * act on it — the UI makes the row clickable → `switchTab(item.tab)`.
 */
export interface AttentionItem {
  severity: "critical" | "warn" | "info";
  title: string;
  detail?: string;
  tab: "memory" | "accounts" | "schedule" | "system" | "agents" | "approvals";
}

/** Severity ordering for the triage sort — lower sorts first. */
const ATTENTION_SEVERITY_RANK: Record<AttentionItem["severity"], number> = {
  critical: 0,
  warn: 1,
  info: 2,
};

/** Cap on the number of attention rows so a pathological fleet can't bloat
 *  the strip (or the payload). The most-severe items survive the cap. */
export const ATTENTION_MAX_ITEMS = 12;

/**
 * Derive the "needs attention" triage list from the already-aggregated
 * summary parts. PURE — no IO, no clock except the injected `now` (used
 * only for the token-expiry window) — so it's fully unit-testable. Every
 * part is optional: a null/missing part contributes nothing (the summary
 * degrades part-by-part, and so does the triage). Sorted critical→warn→
 * info and capped at {@link ATTENTION_MAX_ITEMS}.
 */
export function deriveAttention(
  parts: {
    memoryHealth?: MemoryHealth | null;
    accounts?: AccountDashboardInfo[] | null;
    schedule?: ScheduleDashboard | null;
    systemHealth?: SystemHealth | null;
    agents?: AgentInfo[] | null;
    blockedApprovals?: BlockedApproval[] | null;
  },
  now: number,
): AttentionItem[] {
  const items: AttentionItem[] = [];

  // ── blocked approvals ────────────────────────────────────────────────
  // An agent held on an approval that could not be delivered to Telegram.
  // It HOLDS (never auto-approves, never auto-denies), so it will wait
  // indefinitely — which is only safe if the operator can SEE it. This row
  // is the Telegram-independent surface: it must show up on the default tab
  // without anyone going looking (#3084 — overlord sat blocked 50 minutes
  // behind a flood ban and nobody knew).
  for (const b of parts.blockedApprovals ?? []) {
    if (!b) continue;
    const held = formatBlockedFor(now - b.blockedSince);
    const what = b.action?.trim() || b.toolName || "an approval";
    const retry =
      typeof b.retryableAt === "number" && b.retryableAt > now
        ? ` Retry in ${formatBlockedFor(b.retryableAt - now)}.`
        : "";
    items.push({
      severity: "critical",
      title: `${b.agent} — blocked ${held}`,
      detail: `Waiting on approval to ${what}. Could not deliver the card (${b.reason}).${retry}`,
      tab: "approvals",
    });
  }

  // ── memory ───────────────────────────────────────────────────────────
  const mem = parts.memoryHealth;
  if (mem) {
    if (!mem.reachable) {
      items.push({
        severity: "critical",
        title: "Hindsight unreachable",
        detail: "Memory recall and extraction are down — agents are amnesiac.",
        tab: "memory",
      });
    }
    for (const bank of mem.banks ?? []) {
      for (const name of bank.corruptedMentalModelNames ?? []) {
        items.push({
          severity: "critical",
          title: `Mental model corrupted: ${name}`,
          detail: `Bank ${bank.bank} — an LLM-failure message is injected into every turn until refreshed.`,
          tab: "memory",
        });
      }
      if (bank.recentUnextractedCount > 0) {
        items.push({
          severity: "critical",
          title: `${bank.recentUnextractedCount} unextracted conversation(s)`,
          detail: `Bank ${bank.bank} — stored with zero extracted facts, invisible to recall.`,
          tab: "memory",
        });
      }
      if (bank.staleMentalModelCount > 0) {
        items.push({
          severity: "warn",
          title: `${bank.staleMentalModelCount} stale mental model(s)`,
          detail: `Bank ${bank.bank} — not refreshed in >7d.`,
          tab: "memory",
        });
      }
    }
  }

  // ── accounts ─────────────────────────────────────────────────────────
  for (const acct of parts.accounts ?? []) {
    if (acct?.quota?.exhausted) {
      items.push({
        severity: "warn",
        title: `Account ${acct.label} quota exhausted`,
        detail: acct.quota.exhausted_until
          ? `Resets around ${new Date(acct.quota.exhausted_until).toISOString()}.`
          : undefined,
        tab: "accounts",
      });
    }
  }

  // ── schedule ─────────────────────────────────────────────────────────
  for (const [agent, fires] of Object.entries(parts.schedule?.recentByAgent ?? {})) {
    if ((fires ?? []).some((f) => f && f.exitCode !== 0)) {
      items.push({
        severity: "warn",
        title: `Cron ${agent} last fire failed`,
        detail: "A recent scheduled fire returned a non-zero exit code.",
        tab: "schedule",
      });
    }
  }

  // ── system ───────────────────────────────────────────────────────────
  const sys = parts.systemHealth;
  if (sys) {
    if (sys.broker?.reachable === false) {
      items.push({
        severity: "critical",
        title: "Auth-broker unreachable",
        detail: sys.broker.error,
        tab: "system",
      });
    }
    if (sys.hindsight?.running === false) {
      items.push({
        severity: "critical",
        title: "Hindsight not running",
        detail: "The memory backend container isn't serving.",
        tab: "system",
      });
    }
    if (sys.hostd?.error) {
      items.push({
        severity: "critical",
        title: "Hostd error",
        detail: sys.hostd.error,
        tab: "system",
      });
    }
  }

  // ── agents (auth token expiry) ───────────────────────────────────────
  const DAY_MS = 24 * 60 * 60 * 1000;
  for (const agent of parts.agents ?? []) {
    const exp = agent?.auth?.expiresAt;
    // Within the next 24h (and not already long-expired into the deep past —
    // any future-or-recent expiry inside the window warrants a warning).
    if (typeof exp === "number" && exp - now > 0 && exp - now < DAY_MS) {
      items.push({
        severity: "warn",
        title: `${agent.name} token expires soon`,
        detail: "OAuth token expires within 24h — re-auth before it lapses.",
        tab: "agents",
      });
    }
  }

  // Stable sort critical→warn→info (Array.prototype.sort is stable in V8),
  // then cap so the most-severe items always survive.
  items.sort(
    (a, b) =>
      ATTENTION_SEVERITY_RANK[a.severity] - ATTENTION_SEVERITY_RANK[b.severity],
  );
  return items.slice(0, ATTENTION_MAX_ITEMS);
}

/** One cached part of the summary: the value plus when it was produced. */
export interface SummaryPart<T> {
  value: T;
  dataAsOf: number;
}

/**
 * Aggregate the summary from cache-bound producers. Each `deps.<part>`
 * returns the cached value + its `dataAsOf`; a rejection is caught here
 * and becomes a null field (the others still render). Pure orchestration
 * — no broker/docker/hostd knowledge — so it's unit-testable with fakes.
 */
export async function handleGetSummary(
  deps: {
    agents: () => Promise<SummaryPart<AgentInfo[]>>;
    systemHealth: () => Promise<SummaryPart<SystemHealth>>;
    approvals: () => Promise<SummaryPart<ApprovalsDashboard>>;
    schedule: () => Promise<SummaryPart<ScheduleDashboard>>;
    accounts: () => Promise<SummaryPart<AccountDashboardInfo[]>>;
    memoryHealth: () => Promise<SummaryPart<MemoryHealth>>;
    /** Blocked approvals — a plain local dir read, not a cached host
     *  round-trip, so it takes no `SummaryPart` stamp and never gates the
     *  summary's freshness. Defaults to the real reader: the dangerous
     *  failure here is a held agent going SILENTLY invisible, so the
     *  default must be "wired", not "empty". Injectable for tests. */
    blockedApprovals?: () => BlockedApproval[];
  },
  now: number = Date.now(),
): Promise<SummaryDashboard> {
  const safe = async <T>(
    p: () => Promise<SummaryPart<T>>,
  ): Promise<{ value: T | null; dataAsOf: number | null }> => {
    try {
      const r = await p();
      return { value: r.value, dataAsOf: r.dataAsOf };
    } catch {
      return { value: null, dataAsOf: null };
    }
  };

  const [agents, systemHealth, approvals, schedule, accounts, memoryHealth] =
    await Promise.all([
      safe(deps.agents),
      safe(deps.systemHealth),
      safe(deps.approvals),
      safe(deps.schedule),
      safe(deps.accounts),
      safe(deps.memoryHealth),
    ]);

  // The summary is only as fresh as its OLDEST present part. Ignore
  // nulls (a failed part has no stamp). When every part failed there's no
  // data to stamp → 0. memoryHealth participates in freshness too.
  const stamps = [agents, systemHealth, approvals, schedule, accounts, memoryHealth]
    .map((p) => p.dataAsOf)
    .filter((d): d is number => typeof d === "number");
  const dataAsOf = stamps.length > 0 ? Math.min(...stamps) : 0;

  // Blocked approvals: a local 0644-file read that already degrades to `[]`
  // on every failure. Wrapped anyway so it can never take the summary down —
  // the surface that makes a held agent visible must itself be unkillable.
  let blockedApprovals: BlockedApproval[] = [];
  try {
    blockedApprovals =
      (deps.blockedApprovals ?? handleGetBlockedApprovals)() ?? [];
  } catch {
    blockedApprovals = [];
  }

  // Server-side triage from the parts already aggregated — pure derivation,
  // no extra reads. Each null part simply contributes nothing.
  const attention = deriveAttention(
    {
      memoryHealth: memoryHealth.value,
      accounts: accounts.value,
      schedule: schedule.value,
      systemHealth: systemHealth.value,
      agents: agents.value,
      blockedApprovals,
    },
    now,
  );

  return {
    agents: agents.value,
    systemHealth: systemHealth.value,
    approvals: approvals.value,
    schedule: schedule.value,
    accounts: accounts.value,
    memoryHealth: memoryHealth.value,
    blockedApprovals,
    attention,
    dataAsOf,
  };
}
