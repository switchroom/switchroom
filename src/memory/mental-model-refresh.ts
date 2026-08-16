/**
 * Model-free mental-model refresh sweep — memory-redesign RFC P10.
 *
 * Mental models are hindsight's only synthesis layer, and they go stale
 * unattended: phase 2 J5 measured all six of `klanker`'s models 41 days old
 * with zero refreshes. This is the switchroom-side, model-free mechanism that
 * keeps them current — on a schedule, list each bank's models, select the ones
 * past a declared staleness interval, and call the engine's
 * `refresh_mental_model` MCP tool for each. Zero model tokens: no `claude`, no
 * session wake, no NL synthesis anywhere in this module.
 *
 * ## Why the MCP `refresh_mental_model` tool, and NOT `trigger.refresh_cron`
 *
 * Reaching an engine-side refresh cron would need the model's `trigger` config,
 * and that field is not on hindsight's MCP create/update surface — the shim
 * exposes only `trigger_refresh_after_consolidation`
 * (`src/cli/hindsight-mcp-shim.ts` FALLBACK_TOOL_TABLE, `create_mental_model` /
 * `update_mental_model`). So there is no reachable write path for it short of a
 * REST client nobody has built. `refresh_mental_model` IS on the surface and is
 * the same tool `bin/user-profile-refresh-hook.sh` already drives on Stop.
 *
 * ## Transport split — mirrors what already exists in the tree
 *
 *   - READ (list models + freshness) rides the REST surface via
 *     {@link inspectBankHealth} (`src/memory/bank-health.ts`) — the exact call
 *     the doctor's ingest-health check uses. So the staleness data
 *     (`last_refreshed_at`) and the selection (`staleMentalModels`) are SHARED
 *     with the doctor, not forked: one definition of "stale" for the whole
 *     tree.
 *   - WRITE (refresh) rides one MCP `tools/call` per model over `/mcp/`, exactly
 *     like the user-profile Stop hook: the server is stateless
 *     (`HINDSIGHT_API_MCP_STATELESS=true`, no `mcp-session-id`), `initialize` is
 *     best-effort, and refresh is keyed by `mental_model_id` (a UUID), never
 *     `name`.
 *
 * Never throws: every failure is captured into the returned result so a cron
 * tick records it and moves to the next model/bank rather than aborting the
 * sweep.
 */

import { collectProfileBanks } from "./hindsight.js";
import {
  ageDays,
  inspectBankHealth,
  staleMentalModels,
} from "./bank-health.js";
import type { SwitchroomConfig } from "../config/schema.js";

/**
 * Default "declared refresh interval" in days. Matches `staleMentalModels`'s
 * own default and the doctor's `>7d since refresh` WARN, so the cron refreshes
 * exactly the models the doctor would otherwise nag about.
 */
export const DEFAULT_STALE_DAYS = 7;

/**
 * Per-call wall timeout for one `refresh_mental_model`. A refresh is real
 * engine work (a reflect + write), so it is generous relative to a read probe;
 * it still bounds a hung request so one stuck model cannot stall the sweep.
 */
export const DEFAULT_REFRESH_TIMEOUT_MS = 30_000;

/** Short, best-effort timeout for the stateless-server `initialize` preflight. */
const INIT_TIMEOUT_MS = 3_000;

/**
 * Parse a Hindsight MCP response body: strip the SSE preamble
 * (`event: message\ndata: {json}`) and parse the JSON, falling back to raw
 * JSON when no `data:` line is present. A deliberate small sibling of
 * `parseSseOrJson` in `src/memory/hindsight.ts` and the `grep '^data:'` in
 * `bin/user-profile-refresh-hook.sh`: a fourth copy of four lines is cheaper
 * and lower-risk than a new import edge into the 2500-line hindsight.ts module,
 * and it is kept byte-compatible with those siblings.
 */
function parseMcpBody<T>(text: string): T {
  const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
  const payload = dataLine ? dataLine.slice("data: ".length) : text;
  return JSON.parse(payload) as T;
}

export interface RefreshFetchOpts {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Refresh ONE mental model by id via the engine's `refresh_mental_model` MCP
 * tool. Never throws; returns `{ ok: false, reason }` on any transport or
 * tool-level error.
 *
 * Two failure shapes are both caught, because the engine surfaces the second
 * one as an HTTP 200:
 *   - transport (unreachable, non-200, timeout) → `{ ok: false, reason }`;
 *   - tool-level `isError: true` (e.g. a renamed/missing argument, or the model
 *     id no longer exists) → `{ ok: false, reason: <the tool's message> }`.
 *     Not checking this is how `src/memory/hindsight.ts`'s create path once
 *     reported success while creating nothing — the same guard applies here.
 */
export async function refreshMentalModel(
  mcpUrl: string,
  bankId: string,
  modelId: string,
  opts?: RefreshFetchOpts,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS;
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "X-Bank-Id": bankId,
  };

  // Best-effort `initialize`. The server is stateless and returns no
  // `mcp-session-id`, so a failure or timeout here does not block the call —
  // mirrors the Stop hook's `|| true`. Its own short signal so a hung
  // preflight cannot eat the refresh's whole budget.
  try {
    await fetchImpl(mcpUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "mm-refresh", version: "0.1" },
        },
      }),
      signal: AbortSignal.timeout(INIT_TIMEOUT_MS),
    });
  } catch {
    // Stateless server needs no session; ignore preflight failures.
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetchImpl(mcpUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "refresh_mental_model",
          arguments: { mental_model_id: modelId },
        },
      }),
      signal: controller.signal,
    });
    if (!resp.ok) return { ok: false, reason: `HTTP ${resp.status}` };
    const parsed = parseMcpBody<{
      result?: { isError?: boolean; content?: Array<{ text?: string }> };
    }>(await resp.text());
    if (parsed.result?.isError === true) {
      return {
        ok: false,
        reason: parsed.result.content?.[0]?.text ?? "refresh returned isError",
      };
    }
    return { ok: true };
  } catch (err) {
    if ((err as Error).name === "AbortError") return { ok: false, reason: "Timeout" };
    return { ok: false, reason: String((err as Error).message ?? err) };
  } finally {
    clearTimeout(timeout);
  }
}

/** One stale model the sweep acted on (or would act on, under `--dry-run`). */
export interface ModelRefreshOutcome {
  id: string;
  name: string;
  /** Age in days of the last refresh (or creation, if never refreshed). */
  ageDays: number | null;
  /** True when the refresh POST succeeded. Always false under `dryRun`. */
  refreshed: boolean;
  /** Set only when the refresh was attempted and failed. */
  reason?: string;
}

/** Result of sweeping one bank. */
export interface BankRefreshResult {
  bankId: string;
  /** False only when the bank could not be INSPECTED (engine unreachable). */
  ok: boolean;
  /** Inspection failure reason, when `ok` is false. */
  reason?: string;
  totalModels: number;
  staleModels: number;
  refreshed: number;
  failed: number;
  dryRun: boolean;
  /** One entry per STALE model (the ones acted on), not per model in the bank. */
  models: ModelRefreshOutcome[];
}

export interface SweepOpts {
  /** "Declared refresh interval" — a model older than this is refreshed. */
  staleDays?: number;
  now?: Date;
  /** Select and report stale models but issue no refresh POSTs. */
  dryRun?: boolean;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Sweep one bank: inspect it, select the models past `staleDays`, and refresh
 * each SEQUENTIALLY. Sequential is deliberate — refresh is engine
 * (consolidation) work and the RFC calls for not hammering the engine in
 * parallel. A refresh failure on one model is recorded and the sweep proceeds
 * to the next.
 */
export async function refreshStaleModelsInBank(
  mcpUrl: string,
  bankId: string,
  opts?: SweepOpts,
): Promise<BankRefreshResult> {
  const staleDays = opts?.staleDays ?? DEFAULT_STALE_DAYS;
  const now = opts?.now ?? new Date();
  const dryRun = opts?.dryRun ?? false;

  const health = await inspectBankHealth(mcpUrl, bankId, {
    fetchImpl: opts?.fetchImpl,
    timeoutMs: opts?.timeoutMs,
  });
  if (!health.ok) {
    return {
      bankId,
      ok: false,
      reason: health.reason,
      totalModels: 0,
      staleModels: 0,
      refreshed: 0,
      failed: 0,
      dryRun,
      models: [],
    };
  }

  const stale = staleMentalModels(health.mentalModels, staleDays, now);
  const models: ModelRefreshOutcome[] = [];
  let refreshed = 0;
  let failed = 0;
  for (const m of stale) {
    const age = ageDays(m.lastRefreshedAt ?? m.createdAt, now);
    if (dryRun) {
      models.push({ id: m.id, name: m.name, ageDays: age, refreshed: false });
      continue;
    }
    const res = await refreshMentalModel(mcpUrl, bankId, m.id, {
      fetchImpl: opts?.fetchImpl,
      timeoutMs: opts?.timeoutMs,
    });
    if (res.ok) {
      refreshed++;
      models.push({ id: m.id, name: m.name, ageDays: age, refreshed: true });
    } else {
      failed++;
      models.push({ id: m.id, name: m.name, ageDays: age, refreshed: false, reason: res.reason });
    }
  }

  return {
    bankId,
    ok: true,
    totalModels: health.mentalModels.length,
    staleModels: stale.length,
    refreshed,
    failed,
    dryRun,
    models,
  };
}

/**
 * The banks a fleet-wide sweep covers: every agent's own bank
 * (`memory.collection ?? agentName`) plus the profile / shared banks, deduped
 * and sorted. Mirrors `checkBankIngestHealth`'s enumeration in
 * `src/cli/doctor.ts` so the refresh cron and the doctor sweep the same set.
 */
export function collectRefreshBanks(config: SwitchroomConfig): string[] {
  const banks = new Set<string>();
  for (const [agentName, agentConfig] of Object.entries(config.agents)) {
    banks.add(agentConfig.memory?.collection ?? agentName);
  }
  for (const bank of collectProfileBanks(config)) banks.add(bank);
  return [...banks].sort();
}

export interface FleetRefreshResult {
  banks: BankRefreshResult[];
  totalRefreshed: number;
  totalFailed: number;
  /**
   * True when EVERY requested bank failed inspection — the engine is
   * unreachable and the tick could not do its job. Individual refresh failures
   * do NOT set this: they are reported per-model but are transient and must not
   * make a healthy cron look perpetually broken.
   */
  couldNotComplete: boolean;
}

/**
 * Run the sweep over a set of banks, ONE BANK AT A TIME (see
 * {@link refreshStaleModelsInBank} for why sequential). Never throws.
 */
export async function runMentalModelRefresh(opts: {
  mcpUrl: string;
  bankIds: string[];
  staleDays?: number;
  now?: Date;
  dryRun?: boolean;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  log?: (msg: string) => void;
}): Promise<FleetRefreshResult> {
  const banks: BankRefreshResult[] = [];
  let totalRefreshed = 0;
  let totalFailed = 0;
  for (const bankId of opts.bankIds) {
    const r = await refreshStaleModelsInBank(opts.mcpUrl, bankId, {
      staleDays: opts.staleDays,
      now: opts.now,
      dryRun: opts.dryRun,
      fetchImpl: opts.fetchImpl,
      timeoutMs: opts.timeoutMs,
    });
    banks.push(r);
    totalRefreshed += r.refreshed;
    totalFailed += r.failed;
    if (opts.log) {
      opts.log(
        r.ok
          ? `${r.bankId}: ${r.staleModels}/${r.totalModels} stale, ` +
              `${r.dryRun ? "would refresh" : "refreshed"} ${r.dryRun ? r.staleModels : r.refreshed}` +
              (r.failed > 0 ? `, ${r.failed} failed` : "")
          : `${r.bankId}: could not inspect (${r.reason})`,
      );
    }
  }
  const couldNotComplete = banks.length > 0 && banks.every((b) => !b.ok);
  return { banks, totalRefreshed, totalFailed, couldNotComplete };
}
