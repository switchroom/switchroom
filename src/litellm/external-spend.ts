/**
 * External (non-Claude / OpenRouter cash) spend — pure helpers shared by
 * the auth-broker publisher and the Telegram `/usage` card renderer.
 *
 * Windows are **UTC calendar days**. Spend is read from LiteLLM's
 * pre-aggregated daily table via `/user/daily/activity` (one row per
 * user×date×model — O(days), a few hundred rows), NOT the deprecated
 * unpaginated `/spend/logs?summarize=true` handler. That handler ran a
 * Prisma `group_by([api_key,user,model,startTime])` over the raw
 * `LiteLLM_SpendLogs` table: on ~1M rows it materialises ~967k groups,
 * blows past any sane fetch timeout, and each aborted-but-computed result
 * is a driver of the proxy's RSS creep. `/user/daily/activity` returns the
 * same per-model day totals the `/usage` External row needs in O(days).
 * The card still labels the today window "24h" per operator layout B.
 *
 * Security: never put the LiteLLM master key in agent containers. The
 * auth-broker fetches with the master key and serves only a sanitized
 * summary over UDS (`get-external-spend`).
 */

export interface ExternalSpendTopModel {
  label: string;
  usd: number;
}

export interface ExternalSpendSummary {
  day24hUsd: number;
  day7dUsd: number;
  top: ExternalSpendTopModel[];
}

/**
 * One normalized per-day spend row consumed by `summarizeExternalSpend`.
 * `startTime` is a UTC calendar-day string (`YYYY-MM-DD`); `models` is a
 * flat `{ [model]: usd }` map. Both the daily-activity path and the legacy
 * `/spend/logs` shape collapse to this internal row.
 */
export interface LiteLLMDaySpendRow {
  startTime?: string;
  /** Day total including Claude — never used as External. */
  spend?: number;
  models?: Record<string, number | string>;
}

/**
 * `results[].breakdown.models[<model>]` entry from `/user/daily/activity`
 * — the pre-aggregated daily table. Only `metrics.spend` is read.
 */
export interface DailyActivityModelEntry {
  metrics?: { spend?: number | string };
}

/** One `results[]` day bucket from `/user/daily/activity`. */
export interface DailyActivityDay {
  date?: string;
  breakdown?: {
    models?: Record<string, DailyActivityModelEntry | undefined>;
  };
}

/** Paginated envelope returned by `/user/daily/activity`. */
export interface DailyActivityResponse {
  results?: DailyActivityDay[];
  metadata?: { page?: number; total_pages?: number; has_more?: boolean };
}

export const EXTERNAL_SPEND_TOP_N = 3;
export const DEFAULT_LITELLM_BASE = "http://127.0.0.1:4010";

/** Broker cooldown between live refreshes (also agent soft-cache). */
export const EXTERNAL_SPEND_CACHE_TTL_MS = 90_000;

/** Live LiteLLM fetch timeout (per page request). */
export const EXTERNAL_SPEND_FETCH_TIMEOUT_MS = 5_000;

/** `/user/daily/activity` max `page_size` (LiteLLM caps at 1000). */
export const EXTERNAL_SPEND_PAGE_SIZE = 1000;

/**
 * Safety bound on daily-activity pagination. The window is 7 UTC days of
 * a pre-aggregated table (rows ≈ days×users×models), so one max-size page
 * covers any realistic fleet; this cap only guards a misbehaving
 * `has_more` that never clears. On the cap we summarize what we have
 * rather than looping forever.
 */
export const EXTERNAL_SPEND_MAX_PAGES = 50;

/**
 * Filename under the auth-broker state dir for the master key material
 * written by `switchroom apply` (mode 0600). Never mounted into agents.
 */
export const LITELLM_MASTER_KEY_STATE_BASENAME = "litellm-master-key";

const BARE_EXTERNAL_NEEDLES = [
  "gpt-oss",
  "grok",
  "gemini",
  "deepseek",
  "kimi",
  "glm-",
  "qwen",
  "llama",
] as const;

/**
 * True when a LiteLLM model name is cash/external (OpenRouter etc.), not
 * Anthropic Max/Pro subscription passthrough via the proxy.
 */
export function isExternalModel(model: string): boolean {
  const m = model.trim().toLowerCase();
  if (!m) return false;
  // Subscription Claude / Anthropic passthrough — never External $.
  // Note: `openrouter/anthropic/claude-*` is still Claude API cash via
  // OpenRouter, not Max/Pro — but operators treat Claude-named routes as
  // non-External for this card (filters openrouter/anthropic/claude too).
  if (m.startsWith("claude")) return false;
  if (m.includes("anthropic/claude")) return false;

  if (m.startsWith("openrouter/")) return true;
  if (m.startsWith("sr-")) return true;

  for (const needle of BARE_EXTERNAL_NEEDLES) {
    if (m.includes(needle)) return true;
  }
  return false;
}

/** Strip openrouter/ and keep a short trailing id for the top line. */
export function shortModelLabel(model: string): string {
  let m = model.trim();
  if (m.toLowerCase().startsWith("openrouter/")) {
    m = m.slice("openrouter/".length);
  }
  const parts = m.split("/").filter(Boolean);
  if (parts.length >= 2) {
    m = parts[parts.length - 1]!;
  }
  if (m.toLowerCase().startsWith("sr-")) {
    m = m.slice(3);
  }
  return m || model.trim();
}

export function formatUsd(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "$0.00";
  return `$${n.toFixed(2)}`;
}

export function utcDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addUtcDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  dt.setUTCDate(dt.getUTCDate() + days);
  return utcDateString(dt);
}

function rowDay(row: LiteLLMDaySpendRow): string | null {
  const st = row.startTime;
  if (!st || typeof st !== "string") return null;
  return st.length >= 10 ? st.slice(0, 10) : null;
}

function externalModelsFromRow(row: LiteLLMDaySpendRow): Record<string, number> {
  const out: Record<string, number> = {};
  const models = row.models ?? {};
  for (const [name, raw] of Object.entries(models)) {
    if (!isExternalModel(name)) continue;
    const n = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(n) || n === 0) continue;
    out[name] = (out[name] ?? 0) + n;
  }
  return out;
}

/**
 * Pure aggregator. `now` pins the UTC "today" for 24h / 7d windows.
 * Does NOT use `row.spend` (mixed Claude + external).
 */
export function summarizeExternalSpend(
  days: readonly LiteLLMDaySpendRow[],
  now: Date = new Date(),
): ExternalSpendSummary {
  const today = utcDateString(now);
  const start7 = addUtcDays(today, -6);

  let day24hUsd = 0;
  let day7dUsd = 0;
  const byModel: Record<string, number> = {};

  for (const row of days) {
    const day = rowDay(row);
    if (!day) continue;
    if (day < start7 || day > today) continue;
    const ext = externalModelsFromRow(row);
    let rowSum = 0;
    for (const [name, usd] of Object.entries(ext)) {
      rowSum += usd;
      byModel[name] = (byModel[name] ?? 0) + usd;
    }
    day7dUsd += rowSum;
    if (day === today) day24hUsd += rowSum;
  }

  const top = Object.entries(byModel)
    .filter(([, usd]) => usd > 0)
    .sort((a, b) => b[1]! - a[1]! || a[0]!.localeCompare(b[0]!))
    .slice(0, EXTERNAL_SPEND_TOP_N)
    .map(([name, usd]) => ({ label: shortModelLabel(name), usd }));

  return { day24hUsd, day7dUsd, top };
}

/**
 * Normalize one `/user/daily/activity` page body into internal day rows.
 * Collapses each day's `breakdown.models[<model>].metrics.spend` into the
 * flat `{ [model]: usd }` map `summarizeExternalSpend` consumes. Tolerant
 * of missing/partial fields — an unparseable body yields `[]`, which
 * summarizes to a zeroed row set rather than throwing.
 */
export function normalizeDailyActivityRows(body: unknown): LiteLLMDaySpendRow[] {
  const results =
    body && typeof body === "object" && Array.isArray((body as DailyActivityResponse).results)
      ? (body as DailyActivityResponse).results!
      : [];
  const rows: LiteLLMDaySpendRow[] = [];
  for (const day of results) {
    if (!day || typeof day !== "object") continue;
    const models: Record<string, number> = {};
    const breakdown = day.breakdown?.models ?? {};
    for (const [name, entry] of Object.entries(breakdown)) {
      const raw = entry?.metrics?.spend;
      const n = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(n)) continue;
      models[name] = (models[name] ?? 0) + n;
    }
    rows.push({ startTime: day.date, models });
  }
  return rows;
}

export function resolveLitellmBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.SWITCHROOM_LITELLM_BASE ?? DEFAULT_LITELLM_BASE).trim();
  return raw.replace(/\/+$/, "") || DEFAULT_LITELLM_BASE;
}

/**
 * Fetch + summarize external spend from LiteLLM. Pure-ish: inject fetch/key.
 * Returns null on transport/auth/parse failure (the `/usage` External row
 * then nulls out cleanly — the broker never crashes on this path).
 *
 * Reads the pre-aggregated daily table via `/user/daily/activity`
 * (O(days), a few hundred rows), paginating at the LiteLLM max page size
 * until `metadata.has_more` clears. This replaces the deprecated
 * unpaginated `/spend/logs?summarize=true` handler, whose per-row Prisma
 * `group_by` was uncomputable within any sane timeout on a large
 * `LiteLLM_SpendLogs` table (~1M rows → ~967k groups) and left the row
 * permanently blank while churning proxy RSS. `timezone=0` pins the day
 * buckets to UTC to match `summarizeExternalSpend`'s window clamp.
 */
export async function fetchAndSummarizeExternalSpend(opts: {
  adminKey: string;
  baseUrl?: string;
  now?: Date;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<ExternalSpendSummary | null> {
  const now = opts.now ?? new Date();
  const base = (opts.baseUrl ?? DEFAULT_LITELLM_BASE).replace(/\/+$/, "");
  const today = utcDateString(now);
  const start = addUtcDays(today, -6);

  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? EXTERNAL_SPEND_FETCH_TIMEOUT_MS;

  const rows: LiteLLMDaySpendRow[] = [];
  for (let page = 1; page <= EXTERNAL_SPEND_MAX_PAGES; page++) {
    // `/user/daily/activity` end_date is inclusive; summarizeExternalSpend
    // re-clamps to the UTC today/7d window so a wider fetch stays exact.
    const url =
      `${base}/user/daily/activity?start_date=${encodeURIComponent(start)}` +
      `&end_date=${encodeURIComponent(today)}` +
      `&page=${page}&page_size=${EXTERNAL_SPEND_PAGE_SIZE}&timezone=0`;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${opts.adminKey}`,
          Accept: "application/json",
        },
        signal: ac.signal,
      });
      if (!res.ok) {
        // Operator-observable signal (broker log): a 401 here is the classic
        // stale/wrong master key; a 5xx is proxy trouble. Without this the
        // /usage External row just silently vanishes with no breadcrumb.
        console.warn(
          `external-spend: LiteLLM /user/daily/activity returned HTTP ${res.status} — ` +
            `External /usage row will be blank (check master key / proxy)`,
        );
        return null;
      }
      let body: unknown;
      try {
        body = await res.json();
      } catch (err) {
        console.warn(
          `external-spend: failed to parse /user/daily/activity JSON: ${(err as Error)?.message ?? err}`,
        );
        return null;
      }
      rows.push(...normalizeDailyActivityRows(body));
      const meta =
        body && typeof body === "object"
          ? (body as DailyActivityResponse).metadata
          : undefined;
      if (!meta?.has_more) break;
    } catch (err) {
      // Transport failure (unreachable / DNS / timeout-abort). This is the
      // exact branch the bridge-vs-loopback outage hit: the broker could not
      // reach a loopback-published proxy and the error was swallowed to null.
      console.warn(
        `external-spend: LiteLLM /user/daily/activity fetch failed: ${(err as Error)?.message ?? err}`,
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  return summarizeExternalSpend(rows, now);
}
