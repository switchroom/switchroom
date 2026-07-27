/**
 * credit.ts — proactive OpenRouter credit monitoring.
 *
 * WHY
 * ---
 * PR #3868 stops a spent OpenRouter balance from leaking a raw 402 to an end
 * user, and routes it to an operator card. That is REACTIVE: by the time it
 * fires, the fleet has already failed a request. This is the proactive half —
 * see the shortfall coming and say so before anything breaks.
 *
 * THE ENDPOINT — VERIFIED AGAINST LIVE DOCS 2026-07-28
 * ----------------------------------------------------
 * `GET https://openrouter.ai/api/v1/key`, authenticated with the ORDINARY
 * inference key (no separate provisioning key needed), returns
 * (https://openrouter.ai/docs/api-reference/limits):
 *
 *   type Key = { data: {
 *     label: string
 *     limit: number | null            // credit limit for the KEY, or null if unlimited
 *     limit_reset: string | null      // reset cadence, or null if it never resets
 *     limit_remaining: number | null  // remaining credits for the KEY, or null if unlimited
 *     include_byok_in_limit: boolean
 *     usage: number                   // credits used, all time
 *     usage_daily / usage_weekly / usage_monthly: number
 *     byok_usage{,_daily,_weekly,_monthly}: number
 *     is_free_tier: boolean
 *   } }
 *
 * THE CASE THAT BITES — and this is the important one:
 *
 *   `limit` and `limit_remaining` are `null` when the key has NO per-key
 *   credit cap configured, and **the response carries no account-balance
 *   field at all**.
 *
 * OpenRouter's own docs are explicit that credit limits come from TWO places —
 * "Account balance — your available credits across the account" and "Per-key
 * credit limits — an optional spending cap configured on an individual API
 * key" — but `GET /api/v1/key` only ever describes the SECOND one.
 *
 * So with no per-key limit set (the default, and almost certainly the fleet's
 * current state), this endpoint CANNOT warn about the account balance running
 * out. There is no honest number to threshold. The check therefore reports
 * `warn` with "monitoring is not possible until a per-key limit is set" rather
 * than a green tick that means nothing — a monitor that silently passes when
 * it cannot see is worse than no monitor, because it manufactures confidence.
 *
 * The fix is the same manual OpenRouter-console action the spend-cap work
 * names: set a per-key credit limit at https://openrouter.ai/settings/keys.
 * Doing that is what makes proactive monitoring possible AT ALL, and it also
 * bounds the blast radius if the proxy key ever leaks.
 *
 * Pure module: no network, no FS, no clock. The caller injects the fetch.
 */

// ─── Thresholds ──────────────────────────────────────────────────────────────

/**
 * WARN when remaining credit falls below EITHER 25% of the key's limit OR
 * this many dollars — whichever fires first.
 *
 * Two thresholds because one alone is wrong at one end of the range. A pure
 * percentage on a $500 limit warns with $125 left (far too early, and the
 * operator learns to ignore it); a pure absolute on a $10 limit warns at 50%
 * (too late to be a warning). The pair warns at "you have a couple of days of
 * headroom" across plausible limits.
 */
export const WARN_REMAINING_FRACTION = 0.25;
export const WARN_REMAINING_USD = 10;

/**
 * FAIL when remaining credit falls below EITHER 10% of the limit OR this many
 * dollars. At this point a single busy session can exhaust it, so it is a
 * "top up now" condition rather than a heads-up.
 */
export const FAIL_REMAINING_FRACTION = 0.1;
export const FAIL_REMAINING_USD = 3;

/** Vault key NAME the check reads. A NAME only — never a value. */
export const OPENROUTER_VAULT_KEY = "openrouter/api-key";

/** Where the operator acts. */
export const OPENROUTER_KEYS_URL = "https://openrouter.ai/settings/keys";
export const OPENROUTER_CREDITS_URL = "https://openrouter.ai/credits";

export const OPENROUTER_KEY_ENDPOINT = "https://openrouter.ai/api/v1/key";

// ─── Parsing ─────────────────────────────────────────────────────────────────

/** The subset of `GET /api/v1/key` this module reasons about. */
export interface OpenRouterKeySnapshot {
  label: string | null;
  /** Per-key credit cap, or `null` when the key is uncapped. */
  limit: number | null;
  /** Remaining credit against `limit`, or `null` when the key is uncapped. */
  limitRemaining: number | null;
  limitReset: string | null;
  usage: number | null;
  isFreeTier: boolean | null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Parse a `GET /api/v1/key` body. Returns `null` for anything that is not the
 * documented shape — a caller must not confuse "the API changed" with "there
 * is no limit", because those have opposite meanings.
 */
export function parseKeySnapshot(body: unknown): OpenRouterKeySnapshot | null {
  if (body == null || typeof body !== "object") return null;
  const data = (body as { data?: unknown }).data;
  if (data == null || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  // `usage` is the one field documented as always present and non-nullable; if
  // it is missing the payload is not the documented shape.
  if (num(d.usage) == null) return null;
  return {
    label: typeof d.label === "string" ? d.label : null,
    limit: num(d.limit),
    limitRemaining: num(d.limit_remaining),
    limitReset: typeof d.limit_reset === "string" ? d.limit_reset : null,
    usage: num(d.usage),
    isFreeTier: typeof d.is_free_tier === "boolean" ? d.is_free_tier : null,
  };
}

// ─── Evaluation ──────────────────────────────────────────────────────────────

export type CreditVerdict = "ok" | "warn" | "fail" | "skip";

export interface CreditAssessment {
  status: CreditVerdict;
  /** One-line summary safe to render anywhere. Never contains a key VALUE. */
  detail: string;
  /** What the operator should do, or `undefined` when nothing is needed. */
  fix?: string;
  /**
   * `true` when the shortfall is real and quantified — the only case a
   * scheduled poll should DM the operator about. A "cannot monitor" verdict is
   * a standing configuration gap, not an incident, and must not page anyone
   * every six hours forever.
   */
  actionable: boolean;
}

/**
 * Turn a snapshot into a verdict.
 *
 * The three genuinely different outcomes, kept genuinely different:
 *  - a quantified shortfall (`warn`/`fail`, actionable);
 *  - enough headroom (`ok`);
 *  - NOT MONITORABLE — the key has no per-key limit, so the endpoint reports
 *    `null` and there is no account-balance field to fall back on. Reported as
 *    `warn` with an explicit explanation, NOT as `ok`.
 */
export function evaluateCredit(snapshot: OpenRouterKeySnapshot): CreditAssessment {
  const usage = snapshot.usage ?? 0;

  if (snapshot.limit == null || snapshot.limitRemaining == null) {
    return {
      status: "warn",
      detail:
        `OpenRouter key has NO per-key credit limit set, so its remaining credit cannot be measured. ` +
        `GET /api/v1/key reports limit/limit_remaining as null when a key is uncapped, and the response ` +
        `carries no account-balance field — so there is nothing to threshold and this check CANNOT warn ` +
        `you before the account runs dry. (Key has spent $${usage.toFixed(2)} all-time.)`,
      fix:
        `Set a per-key credit limit at ${OPENROUTER_KEYS_URL} (vault key: \`${OPENROUTER_VAULT_KEY}\`). ` +
        `That is what makes proactive monitoring possible at all, and it bounds the damage if the proxy ` +
        `key ever leaks. This is a manual console action — OpenRouter exposes no API to set it.`,
      // A standing config gap, not an incident: never DM about it on a timer.
      actionable: false,
    };
  }

  const { limit, limitRemaining } = snapshot;
  const fraction = limit > 0 ? limitRemaining / limit : 0;
  const reset = snapshot.limitReset ? ` (resets: ${snapshot.limitReset})` : " (never resets)";
  const where = `$${limitRemaining.toFixed(2)} of $${limit.toFixed(2)} remaining${reset}`;

  if (limitRemaining <= 0) {
    return {
      status: "fail",
      detail: `OpenRouter key credit is EXHAUSTED — ${where}. Every request through it is answering HTTP 402.`,
      fix: `Top up at ${OPENROUTER_CREDITS_URL} or raise the key's limit at ${OPENROUTER_KEYS_URL} (vault key: \`${OPENROUTER_VAULT_KEY}\`).`,
      actionable: true,
    };
  }

  if (fraction < FAIL_REMAINING_FRACTION || limitRemaining < FAIL_REMAINING_USD) {
    return {
      status: "fail",
      detail: `OpenRouter key credit is CRITICALLY low — ${where}. A single busy session can exhaust it.`,
      fix: `Top up at ${OPENROUTER_CREDITS_URL} or raise the key's limit at ${OPENROUTER_KEYS_URL} (vault key: \`${OPENROUTER_VAULT_KEY}\`).`,
      actionable: true,
    };
  }

  if (fraction < WARN_REMAINING_FRACTION || limitRemaining < WARN_REMAINING_USD) {
    return {
      status: "warn",
      detail: `OpenRouter key credit is running low — ${where}.`,
      fix: `Top up at ${OPENROUTER_CREDITS_URL} before it reaches zero (vault key: \`${OPENROUTER_VAULT_KEY}\`).`,
      actionable: true,
    };
  }

  return {
    status: "ok",
    detail: `OpenRouter key credit healthy — ${where}.`,
    actionable: false,
  };
}

// ─── Fetch ───────────────────────────────────────────────────────────────────

export type CreditFetchFn = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export type FetchCreditResult =
  | { kind: "ok"; snapshot: OpenRouterKeySnapshot }
  | { kind: "unauthorized"; status: number }
  | { kind: "unreachable"; detail: string }
  | { kind: "unexpected-shape" };

/**
 * Read the live snapshot. The API key is passed in by the caller (which got it
 * from the vault broker) and is used ONLY as the Authorization header — it is
 * never logged, never returned, and never placed in an error string.
 */
export async function fetchKeySnapshot(
  apiKey: string,
  fetchFn: CreditFetchFn,
  signal?: AbortSignal,
): Promise<FetchCreditResult> {
  let resp: Awaited<ReturnType<CreditFetchFn>>;
  try {
    resp = await fetchFn(OPENROUTER_KEY_ENDPOINT, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal,
    });
  } catch (err) {
    // The message is from the transport, never from the credential.
    return { kind: "unreachable", detail: (err as Error).message };
  }
  if (resp.status === 401 || resp.status === 403) {
    return { kind: "unauthorized", status: resp.status };
  }
  if (!resp.ok) return { kind: "unreachable", detail: `HTTP ${resp.status}` };
  let body: unknown;
  try {
    body = await resp.json();
  } catch {
    return { kind: "unexpected-shape" };
  }
  const snapshot = parseKeySnapshot(body);
  if (snapshot == null) return { kind: "unexpected-shape" };
  return { kind: "ok", snapshot };
}

/** Turn a non-`ok` fetch outcome into an assessment, without leaking anything. */
export function assessFetchFailure(result: Exclude<FetchCreditResult, { kind: "ok" }>): CreditAssessment {
  switch (result.kind) {
    case "unauthorized":
      return {
        status: "fail",
        detail: `OpenRouter rejected the credit query with HTTP ${result.status} — the key is invalid, revoked or disabled.`,
        fix: `Re-issue the key at ${OPENROUTER_KEYS_URL} and update the vault entry \`${OPENROUTER_VAULT_KEY}\`.`,
        actionable: true,
      };
    case "unexpected-shape":
      return {
        status: "warn",
        detail:
          `OpenRouter's GET /api/v1/key returned an unrecognised body, so credit could not be read. ` +
          `Treated as UNKNOWN, not as healthy — the API shape may have changed.`,
        fix: `Re-check https://openrouter.ai/docs/api-reference/limits against src/openrouter/credit.ts.`,
        // Not a credit incident — do not page the operator on a timer for it.
        actionable: false,
      };
    case "unreachable":
      return {
        status: "skip",
        detail: `Could not reach OpenRouter to check credit (${result.detail}).`,
        actionable: false,
      };
  }
}
