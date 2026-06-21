/**
 * Anthropic Pro/Max OAuth quota probe — shared between the
 * auth-broker server (probe-quota op) and the telegram-plugin
 * gateway (in-process cache + dashboard format).
 *
 * Hits `POST /v1/messages` with the Claude CLI's exact OAuth +
 * header shape and reads `anthropic-ratelimit-unified-*` headers
 * off the response. Those headers only appear when the request is
 * authenticated with a subscription OAuth token AND carries the
 * CLI's user-agent + `anthropic-beta: oauth-2025-04-20` header.
 *
 * This module is intentionally dependency-free: just `fetch`, no
 * filesystem, no telegram, no broker. The two callers wrap it with
 * their own credential resolution.
 *
 * Pre-#1336 this lived in `telegram-plugin/quota-check.ts` and the
 * broker couldn't reach it (cross-package import + bundle boundary).
 * The broker's probe path duplicates would have drifted. Lifted to
 * `src/auth/quota.ts` so both bundles import from one place.
 */

/**
 * OAuth beta flag — proves the request is coming from a subscription
 * client. Plain bearer OAuth tokens without this header are rejected
 * with "OAuth authentication is currently not supported".
 */
export const OAUTH_BETA = "oauth-2025-04-20";

/**
 * User-agent the CLI sends. Kept in sync with observed traffic; the
 * server is lenient on version suffix but strict on overall shape
 * ("claude-cli/X.Y.Z (external, cli)").
 */
export const DEFAULT_USER_AGENT = "claude-cli/1.0.0 (external, cli)";

/**
 * Default model — picked to minimize spend. One input token,
 * max_tokens=1, Haiku. Response body is discarded; only headers
 * matter.
 */
export const DEFAULT_PROBE_MODEL = "claude-haiku-4-5-20251001";

export type QuotaUtilization = {
  fiveHourUtilizationPct: number;
  sevenDayUtilizationPct: number;
  fiveHourResetAt: Date | null;
  sevenDayResetAt: Date | null;
  representativeClaim: string | null;
  overageStatus: string | null;
  overageDisabledReason: string | null;
  /**
   * #2494 Bug C — header-presence markers. The two utilization fields are
   * always numeric (a missing header coalesces to 0 for back-compat), so on
   * their own they cannot distinguish "genuinely 0% used" from "the probe
   * came back thin / headerless and we filled 0". These flags carry that
   * distinction so renderers can show `unknown` for an absent window instead
   * of a confident `0%`. Optional (default-true semantics) so cached
   * snapshots / hand-built fixtures that predate the field still read as a
   * real probe — a snapshot that genuinely measured 0% leaves them unset.
   */
  fiveHourUtilPresent?: boolean;
  sevenDayUtilPresent?: boolean;
};

/**
 * #2494 Bug C — is this probe "thin" (no real utilization signal)? True only
 * when BOTH windows are explicitly marked absent. A probe with at least one
 * present window (the existing "7d missing, 5h present" case) is NOT thin.
 * When the markers are unset (cached snapshot / legacy fixture) we treat the
 * probe as real, never thin — absence of the flag means "predates the flag",
 * not "headerless".
 */
export function isProbeThin(q: {
  fiveHourUtilPresent?: boolean;
  sevenDayUtilPresent?: boolean;
}): boolean {
  return q.fiveHourUtilPresent === false && q.sevenDayUtilPresent === false;
}

export type QuotaResult =
  | { ok: true; data: QuotaUtilization }
  | { ok: false; reason: string };

export type FetchQuotaOptions = {
  /** OAuth access token to probe with. Required. */
  accessToken: string;
  /** Override probe model. Defaults to haiku-4-5. */
  model?: string;
  /** Abort after this many ms. Defaults to 10s. */
  timeoutMs?: number;
  /** Override fetch for tests. */
  fetchImpl?: typeof fetch;
};

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
      // #2494 Bug C — we still coalesce a missing window header to 0 so the
      // numeric fields stay non-null for back-compat, but record which
      // windows were actually present so renderers can tell a real 0% from a
      // filled-0. (Both-absent already returned ok:false above, so at least
      // one of these is true here.)
      fiveHourUtilizationPct: (fiveHour ?? 0) * 100,
      sevenDayUtilizationPct: (sevenDay ?? 0) * 100,
      fiveHourUtilPresent: fiveHour != null,
      sevenDayUtilPresent: sevenDay != null,
      fiveHourResetAt: parseEpochHeader(headers, "anthropic-ratelimit-unified-5h-reset"),
      sevenDayResetAt: parseEpochHeader(headers, "anthropic-ratelimit-unified-7d-reset"),
      representativeClaim: headers.get("anthropic-ratelimit-unified-representative-claim"),
      overageStatus: headers.get("anthropic-ratelimit-unified-overage-status"),
      overageDisabledReason: headers.get("anthropic-ratelimit-unified-overage-disabled-reason"),
    },
  };
}

// ── #2494 Bug A — refill-aware utilization normalization ──────────────────
//
// A cached/probed snapshot carries its window RESET timestamps alongside the
// utilization. When `now` has crossed a window's reset, that window has rolled
// since capture and its old utilization is stale — the window is empty again.
// Every classifier (card `classifyHealth`, `auth schedule` `classifyState`,
// the fleet `recommendation`) must read through this normalization so a
// just-refilled account self-corrects across the refill boundary with zero
// extra probes, regardless of snapshot age.

export interface RefillNormalizedUtils {
  fiveHourUtilizationPct: number;
  sevenDayUtilizationPct: number;
  /** True when the 5h window's reset has passed (treated as refilled → 0%). */
  fiveHourRefilled: boolean;
  /** True when the 7d window's reset has passed (treated as refilled → 0%). */
  sevenDayRefilled: boolean;
}

/**
 * Given a snapshot's per-window utilization + reset timestamps and the
 * current clock, return utilization normalized for refills: any window whose
 * `resetAt` is non-null and `<= now` is treated as `0%` (the window rolled
 * after the snapshot was captured). Windows without a reset timestamp, or
 * whose reset is still in the future, pass through unchanged.
 */
export function refillNormalizedUtils(
  q: {
    fiveHourUtilizationPct: number;
    sevenDayUtilizationPct: number;
    fiveHourResetAt: Date | null;
    sevenDayResetAt: Date | null;
  },
  now: Date,
): RefillNormalizedUtils {
  const nowMs = now.getTime();
  const fiveHourRefilled =
    q.fiveHourResetAt != null && q.fiveHourResetAt.getTime() <= nowMs;
  const sevenDayRefilled =
    q.sevenDayResetAt != null && q.sevenDayResetAt.getTime() <= nowMs;
  return {
    fiveHourUtilizationPct: fiveHourRefilled ? 0 : q.fiveHourUtilizationPct,
    sevenDayUtilizationPct: sevenDayRefilled ? 0 : q.sevenDayUtilizationPct,
    fiveHourRefilled,
    sevenDayRefilled,
  };
}

export async function fetchQuota(opts: FetchQuotaOptions): Promise<QuotaResult> {
  const token = opts.accessToken?.trim();
  if (!token || token.length === 0) {
    return { ok: false, reason: "fetchQuota requires a non-empty accessToken" };
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
    clearTimeout(timeout);
    if (msg.includes("aborted")) {
      return { ok: false, reason: `quota probe timed out after ${opts.timeoutMs ?? 10_000}ms` };
    }
    return { ok: false, reason: `quota probe network error: ${msg}` };
  }
  clearTimeout(timeout);

  // Read headers regardless of HTTP status — the rate-limit headers
  // are populated on 200 AND on auth-failure 4xx responses.
  const parsed = parseQuotaHeaders(resp.headers);
  if (parsed.ok) return parsed;

  if (!resp.ok) {
    return { ok: false, reason: `HTTP ${resp.status} from Anthropic (${parsed.reason})` };
  }
  return parsed;
}
