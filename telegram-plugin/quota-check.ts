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
  /** Path to the agent's Claude config dir (contains `.oauth-token`). */
  claudeConfigDir: string;
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
  const token = readOauthToken(opts.claudeConfigDir);
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
