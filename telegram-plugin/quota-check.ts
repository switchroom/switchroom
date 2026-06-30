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

// RFC H: per-account quota state moved to switchroom-auth-broker
// (state/auth-broker/quota.json). The gateway's in-process cache
// below is still useful for sub-second formatting, but the disk-
// persistence layer that account-quota-store provided is gone —
// the broker owns the canonical store and exposes it via
// `list-state`. Disk hydrate / disk persist below are no-ops.

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
  /**
   * #2494 Bug C — header-presence markers. Mirror of the field in
   * `src/auth/quota.ts` (kept in sync across the bundle boundary). The
   * utilization fields are always numeric (a missing header coalesces to 0),
   * so on their own they cannot tell a genuine 0% from a filled-0 thin probe.
   * Optional → unset means "real probe" (legacy snapshots / fixtures).
   */
  fiveHourUtilPresent?: boolean;
  sevenDayUtilPresent?: boolean;
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
      // #2494 Bug C — coalesce missing window to 0 for back-compat but record
      // which windows were actually present (both-absent returned ok:false).
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
  lines.push("**Claude plan quota**");
  lines.push("");
  lines.push(
    `**5h window**  \`${Math.round(q.fiveHourUtilizationPct)}%\` · \`${formatResetRelative(q.fiveHourResetAt, now)}\``,
  );
  lines.push(
    `**7d window**  \`${Math.round(q.sevenDayUtilizationPct)}%\` · \`${formatResetRelative(q.sevenDayResetAt, now)}\``,
  );
  if (q.representativeClaim) {
    lines.push("");
    lines.push(`_Binding window: ${q.representativeClaim.replace(/_/g, " ")}_`);
  }
  if (q.overageStatus && q.overageStatus !== "allowed") {
    const reason = q.overageDisabledReason ? ` (${q.overageDisabledReason})` : "";
    lines.push(`_Overage: ${q.overageStatus}${reason}_`);
  }
  return lines.join("\n");
}

