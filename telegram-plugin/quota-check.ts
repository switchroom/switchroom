/**
 * Pro/Max plan quota check — hits /v1/messages with the Claude CLI's OAuth
 * auth + header shape and reads the rate-limit utilization values from the
 * response headers. This is the same mechanism the TUI's /usage panel uses.
 *
 * Why this module exists: before discovering the header surface, Switchroom
 * only had ccusage-based dollar-cost tracking (what you spent), not what
 * the Pro/Max plan's 5-hour and 7-day rolling windows actually show. Those
 * utilization values never appear in request/response bodies, only in
 * headers, and only when the request is authenticated with a subscription
 * OAuth token and carries the CLI's exact user-agent + beta headers.
 *
 * Returning `{ ok: false, reason }` instead of throwing lets callers
 * (greeting hook, /usage command) render a graceful fallback row without
 * having to catch.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";

/**
 * OAuth beta flag — proves the request is coming from a subscription client.
 * Plain bearer OAuth tokens without this header are rejected with
 * "OAuth authentication is currently not supported".
 */
const OAUTH_BETA = "oauth-2025-04-20";

/**
 * User-agent the CLI sends. Kept in sync with observed traffic;
 * the server is lenient on the version suffix but strict on the
 * overall shape ("claude-cli/X.Y.Z (external, cli)").
 */
const DEFAULT_USER_AGENT = "claude-cli/1.0.0 (external, cli)";

/**
 * Default model for the probe. Picked to minimize spend — one input token,
 * max_tokens=1, a Haiku model. The response body is discarded; we only
 * care about the headers.
 */
const DEFAULT_PROBE_MODEL = "claude-haiku-4-5-20251001";

export type QuotaUtilization = {
  fiveHourUtilizationPct: number;
  sevenDayUtilizationPct: number;
  fiveHourResetAt: Date | null;
  sevenDayResetAt: Date | null;
  representativeClaim: string | null;
  overageStatus: string | null;
  overageDisabledReason: string | null;
};

export type QuotaResult =
  | { ok: true; data: QuotaUtilization }
  | { ok: false; reason: string };

export type FetchQuotaOptions = {
  /**
   * Path to the agent's Claude config dir (contains `.oauth-token`).
   * Mutually exclusive with `accessToken`. One of the two must be set.
   */
  claudeConfigDir?: string;
  /**
   * OAuth access token to probe with directly. Use this from the
   * account-level path (`~/.switchroom/accounts/<label>/credentials.json`)
   * where the credentials live in the new account model rather than
   * a legacy `.oauth-token` file. Mutually exclusive with
   * `claudeConfigDir`.
   */
  accessToken?: string;
  /** Override probe model. Defaults to haiku-4-5. */
  model?: string;
  /** Abort after this many ms. Defaults to 10s. */
  timeoutMs?: number;
  /** Override fetch for tests. */
  fetchImpl?: typeof fetch;
};

function readOauthToken(claudeConfigDir: string): string | null {
  const tokenFile = join(claudeConfigDir, ".oauth-token");
  if (!existsSync(tokenFile)) return null;
  try {
    const raw = readFileSync(tokenFile, "utf-8").trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

function parseFloatHeader(headers: Headers, name: string): number | null {
  const v = headers.get(name);
  if (v == null || v.trim().length === 0) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseEpochHeader(headers: Headers, name: string): Date | null {
  const v = headers.get(name);
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000);
}

export function parseQuotaHeaders(headers: Headers): QuotaResult {
  const fiveHour = parseFloatHeader(headers, "anthropic-ratelimit-unified-5h-utilization");
  const sevenDay = parseFloatHeader(headers, "anthropic-ratelimit-unified-7d-utilization");
  if (fiveHour == null && sevenDay == null) {
    return {
      ok: false,
      reason: "no unified rate-limit headers in response (API token, not OAuth?)",
    };
  }
  return {
    ok: true,
    data: {
      fiveHourUtilizationPct: (fiveHour ?? 0) * 100,
      sevenDayUtilizationPct: (sevenDay ?? 0) * 100,
      fiveHourResetAt: parseEpochHeader(headers, "anthropic-ratelimit-unified-5h-reset"),
      sevenDayResetAt: parseEpochHeader(headers, "anthropic-ratelimit-unified-7d-reset"),
      representativeClaim: headers.get("anthropic-ratelimit-unified-representative-claim"),
      overageStatus: headers.get("anthropic-ratelimit-unified-overage-status"),
      overageDisabledReason: headers.get("anthropic-ratelimit-unified-overage-disabled-reason"),
    },
  };
}

export async function fetchQuota(opts: FetchQuotaOptions): Promise<QuotaResult> {
  // Resolve the bearer token from either an explicit accessToken
  // (account-level path) or by reading `.oauth-token` from a Claude
  // config dir (legacy per-agent path). Reject if neither is set or
  // both are — keep the API contract narrow.
  let token: string | null;
  if (opts.accessToken && opts.claudeConfigDir) {
    return {
      ok: false,
      reason: "pass only one of `accessToken` or `claudeConfigDir`, not both",
    };
  }
  if (opts.accessToken) {
    token = opts.accessToken.trim().length > 0 ? opts.accessToken : null;
  } else if (opts.claudeConfigDir) {
    token = readOauthToken(opts.claudeConfigDir);
  } else {
    return {
      ok: false,
      reason: "fetchQuota requires `accessToken` or `claudeConfigDir`",
    };
  }
  if (!token) {
    return { ok: false, reason: "no OAuth token at .oauth-token" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);

  const fetchFn = opts.fetchImpl ?? fetch;
  let resp: Response;
  try {
    resp = await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "anthropic-version": "2023-06-01",
        "anthropic-beta": OAUTH_BETA,
        "authorization": `Bearer ${token}`,
        "x-app": "cli",
        "user-agent": DEFAULT_USER_AGENT,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: opts.model ?? DEFAULT_PROBE_MODEL,
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
      signal: controller.signal,
    });
  } catch (err: unknown) {
    const msg = (err as Error)?.message ?? String(err);
    return { ok: false, reason: `request failed: ${msg}` };
  } finally {
    clearTimeout(timeout);
  }

  // We don't care whether the probe succeeded for message generation —
  // Anthropic returns the rate-limit headers on both 2xx and rate-limited
  // responses. Only bail if auth itself was rejected.
  if (resp.status === 401 || resp.status === 403) {
    return { ok: false, reason: `auth rejected (HTTP ${resp.status})` };
  }

  const parsed = parseQuotaHeaders(resp.headers);
  if (!parsed.ok && resp.status >= 400) {
    return { ok: false, reason: `HTTP ${resp.status}, ${parsed.reason}` };
  }
  return parsed;
}

/**
 * Compact single-line representation for the session greeting.
 * Example: "29% / 5h · 33% / 7d"
 */
export function formatQuotaLine(q: QuotaUtilization): string {
  const fmt = (n: number) => `${Math.round(n)}%`;
  return `${fmt(q.fiveHourUtilizationPct)} / 5h · ${fmt(q.sevenDayUtilizationPct)} / 7d`;
}

/**
 * Render a human-friendly "resets in …" countdown for a Date target.
 * Exported so other surfaces (model-unavailable card, auth dashboard,
 * banner helpers) speak the same dialect as `/usage`. Returns "—" for
 * null targets and "resets now" once the target is in the past.
 */
export function formatResetRelative(target: Date | null, now: Date = new Date()): string {
  if (!target) return "—";
  const deltaMs = target.getTime() - now.getTime();
  if (deltaMs <= 0) return "resets now";
  const totalMin = Math.round(deltaMs / 60_000);
  if (totalMin < 60) return `resets in ${totalMin}m`;
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours < 24) return mins > 0 ? `resets in ${hours}h ${mins}m` : `resets in ${hours}h`;
  const days = Math.floor(hours / 24);
  const remH = hours % 24;
  return remH > 0 ? `resets in ${days}d ${remH}h` : `resets in ${days}d`;
}

/**
 * Multi-line Telegram HTML block for the /usage command. Shows both
 * windows with their utilization percentages and reset countdowns,
 * plus a representative-claim line if the server flagged one.
 */
export function formatQuotaBlock(q: QuotaUtilization, now: Date = new Date()): string {
  const lines: string[] = [];
  lines.push("<b>Claude plan quota</b>");
  lines.push("");
  lines.push(
    `<b>5h window</b>  ${Math.round(q.fiveHourUtilizationPct)}% · ${formatResetRelative(q.fiveHourResetAt, now)}`,
  );
  lines.push(
    `<b>7d window</b>  ${Math.round(q.sevenDayUtilizationPct)}% · ${formatResetRelative(q.sevenDayResetAt, now)}`,
  );
  if (q.representativeClaim) {
    lines.push("");
    lines.push(`<i>Binding window: ${q.representativeClaim.replace(/_/g, " ")}</i>`);
  }
  if (q.overageStatus && q.overageStatus !== "allowed") {
    const reason = q.overageDisabledReason ? ` (${q.overageDisabledReason})` : "";
    lines.push(`<i>Overage: ${q.overageStatus}${reason}</i>`);
  }
  return lines.join("\n");
}

/* ── Account-level quota probe + short-lived cache ───────────────────── */

/**
 * Resolve an account's OAuth access token from
 * `~/.switchroom/accounts/<label>/credentials.json` (new account model
 * — see `reference/share-auth-across-the-fleet.md`). Returns null when
 * the file is missing, malformed, or has no accessToken — caller
 * surfaces a graceful "missing credentials" badge.
 *
 * Exported for unit testing; production callers go through
 * {@link fetchAccountQuota}.
 */
export function readAccountAccessToken(
  label: string,
  home: string = (process.env.HOME ?? "/root"),
): string | null {
  const credPath = join(home, ".switchroom", "accounts", label, "credentials.json");
  if (!existsSync(credPath)) return null;
  try {
    const raw = readFileSync(credPath, "utf-8");
    const parsed = JSON.parse(raw) as {
      claudeAiOauth?: { accessToken?: string };
    };
    const token = parsed.claudeAiOauth?.accessToken?.trim();
    return token && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/**
 * Cache key per account label. The cached entry holds the result and
 * the wall-clock timestamp it was fetched at, so the dashboard tap
 * pattern (refresh-on-tap) doesn't trigger a fresh API call within the
 * TTL window. Quota numbers don't move within a few seconds anyway.
 */
type AccountQuotaCacheEntry = {
  fetchedAt: number;
  result: QuotaResult;
};

/** TTL for the per-account quota cache — controls when
 *  `prefetchAccountQuotaIfStale` re-probes Anthropic and when
 *  `fetchAccountQuota`'s cache-bypass kicks in. 5 min: quota numbers
 *  don't move within a few minutes for human-scale usage; the
 *  prefetch fires on every dashboard render so the cache stays fresh
 *  whenever the operator interacts. The dashboard's sync read
 *  (`getCachedAccountQuota`) returns last-known data regardless of
 *  staleness — see that function's docstring for why. */
export const ACCOUNT_QUOTA_CACHE_TTL_MS = 5 * 60_000;

const accountQuotaCache = new Map<string, AccountQuotaCacheEntry>();

/**
 * Fetch quota for a global account by label. Wraps {@link fetchQuota}
 * with token-resolution (`~/.switchroom/accounts/<label>/credentials.json`)
 * and a short-lived in-process cache so repeat dashboard taps within
 * the TTL don't re-hit the Anthropic API.
 *
 * Pass `force: true` to bypass the cache (used when the user
 * explicitly taps "📊 Full quota" — they expect a live read).
 */
export async function fetchAccountQuota(
  label: string,
  opts: {
    home?: string;
    force?: boolean;
    now?: () => number;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<QuotaResult> {
  const now = opts.now?.() ?? Date.now();
  if (!opts.force) {
    const cached = accountQuotaCache.get(label);
    if (cached && now - cached.fetchedAt < ACCOUNT_QUOTA_CACHE_TTL_MS) {
      return cached.result;
    }
  }

  const token = readAccountAccessToken(label, opts.home);
  if (!token) {
    const result: QuotaResult = {
      ok: false,
      reason: "no credentials.json or accessToken for account",
    };
    accountQuotaCache.set(label, { fetchedAt: now, result });
    return result;
  }

  const result = await fetchQuota({
    accessToken: token,
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
  });
  accountQuotaCache.set(label, { fetchedAt: now, result });
  return result;
}

/** Test/utility helper — wipe the per-account quota cache. The
 *  gateway calls this on auth-account-level mutations (account add,
 *  account rm, account rename, refresh-accounts tick) so a stale
 *  pre-rename label doesn't survive into the dashboard. */
export function clearAccountQuotaCache(label?: string): void {
  if (label == null) {
    accountQuotaCache.clear();
    return;
  }
  accountQuotaCache.delete(label);
}

/**
 * Sync read of the account quota cache. Returns whatever's cached for
 * this label — `null` only when there's NO entry at all. Stale-but-
 * present cache entries are returned on purpose:
 *
 *   - The dashboard renders sync; awaiting a fresh probe would block
 *     the user-visible message (and a probe can stall on Anthropic
 *     latency or network).
 *   - Showing yesterday's number is dramatically better UX than
 *     showing nothing — quota changes slowly enough that "the cached
 *     value" is almost always close to truth.
 *   - The background prefetch (`prefetchAccountQuotaIfStale`) keeps
 *     the cache fresh across renders. Within the 5-min TTL it
 *     no-ops; past the TTL it kicks off a fresh probe whose result
 *     is visible on the operator's NEXT render (refresh tap or
 *     auto-refresh after an action).
 *
 * Pre-v0.6.11 this function treated stale entries as a miss, which
 * meant the boot-warmed cache vanished after 30s and the operator
 * saw empty quota rows on the first /auth tap of any day after the
 * gateway restart. That's the bug this docstring exists to keep
 * fixed.
 */
export function getCachedAccountQuota(
  _label: string,
  _now: number = Date.now(),
): QuotaResult | null {
  // Note the unused params — we keep the signature stable for callers
  // that pass `now` (test helpers) even though we no longer use it.
  const cached = accountQuotaCache.get(_label);
  if (!cached) return null;
  return cached.result;
}

/**
 * Fire-and-forget background prefetch — kicks off
 * `fetchAccountQuota` if the cache is cold/stale and discards the
 * promise. Safe to call on every dashboard render: the cache TTL
 * keeps the API call rate bounded to ~1 per account per 30s
 * regardless of how many times the user taps /auth.
 *
 * Errors are swallowed (the next tap re-tries via the cache miss
 * path); the dashboard's empty quota row is the user-visible
 * "didn't probe yet" signal.
 */
export function prefetchAccountQuotaIfStale(
  label: string,
  opts: { home?: string; now?: () => number; fetchImpl?: typeof fetch } = {},
): void {
  const now = opts.now?.() ?? Date.now();
  const cached = accountQuotaCache.get(label);
  if (cached && now - cached.fetchedAt < ACCOUNT_QUOTA_CACHE_TTL_MS) return;
  // Don't await — background warm.
  void fetchAccountQuota(label, opts).catch(() => {});
}
