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

/**
 * Model-tier canary probe model (#3176). The `7d_oi`
 * (`seven_day_overage_included`) quota bucket is PER-MODEL-TIER: an account
 * can be `rejected` on the flagship (Fable) tier while `allowed` on
 * opus/haiku (verified 2026-07-12 — same account, same moment, fable=429 /
 * opus=200 / haiku=200). The default haiku probe therefore CANNOT observe a
 * Fable-tier wall, so a walled account looked healthy and the fleet stormed
 * it. This probe issues the 1-token request against the flagship tier so its
 * OWN 429/200 response carries the tier signal.
 *
 * Overridable via `SWITCHROOM_MODEL_TIER_PROBE_MODEL`. Unlike the model
 * PICKER (where a stale pinned id 4xx's the fleet — the 2026-06-13
 * `claude-fable-5` incident), a stale id HERE is safe: a non-429 response
 * (incl. a 4xx "model not found") is classified as "no tier wall observed",
 * so a rotted id degrades the canary to a benign no-op, never a mismark. Keep
 * this pointed at the current flagship id; update it here (or via env) when
 * the flagship id changes.
 */
export const DEFAULT_MODEL_TIER_PROBE_MODEL = "claude-fable-5";

/** Resolve the model-tier canary probe model from env, else the default. */
export function resolveModelTierProbeModel(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw = env.SWITCHROOM_MODEL_TIER_PROBE_MODEL;
  if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  return DEFAULT_MODEL_TIER_PROBE_MODEL;
}

/**
 * Anthropic's `representative-claim` value naming the model-tier weekly
 * overage bucket. When the unified status is `rejected` and this is the
 * binding claim, the account is walled on the flagship (Fable) tier — the
 * `7d_oi` bucket — regardless of how healthy the 5h/7d windows read.
 */
export const MODEL_TIER_REPRESENTATIVE_CLAIM = "seven_day_overage_included";

export type QuotaUtilization = {
  fiveHourUtilizationPct: number;
  sevenDayUtilizationPct: number;
  fiveHourResetAt: Date | null;
  sevenDayResetAt: Date | null;
  representativeClaim: string | null;
  overageStatus: string | null;
  overageDisabledReason: string | null;
  /**
   * #3176 — model-tier (7d_oi / seven_day_overage_included) bucket signals.
   * These come from a request issued AGAINST the flagship tier (the default
   * haiku probe leaves them null). `unifiedStatus` is the overall
   * allowed/rejected verdict; `sevenDayOiStatus` is the per-tier bucket
   * status; `sevenDayOiUtilizationPct` is that bucket's utilization (0-100);
   * `sevenDayOiResetAt` is when the tier wall lifts (from the `7d_oi-reset`
   * header, else the overall `unified-reset`, else `retry-after`).
   *
   * Optional (default-null semantics) so hand-built fixtures and cached/legacy
   * snapshots that predate the field still satisfy the type — an absent field
   * reads as "the probe carried no tier signal", never a wall.
   */
  unifiedStatus?: string | null;
  sevenDayOiStatus?: string | null;
  sevenDayOiUtilizationPct?: number | null;
  sevenDayOiResetAt?: Date | null;
  /** True when the probe response actually carried a `7d_oi` bucket header —
   *  lets consumers tell "tier bucket absent (haiku probe)" from "measured
   *  and healthy". Absent (undefined) on legacy/cached snapshots. */
  sevenDayOiPresent?: boolean;
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

/**
 * Structured probe-failure classification.
 *  - `entitlement_blocked` — a 403 that denotes an org/subscription-level
 *    Claude Code disablement, detected on EITHER the structured
 *    `error.details.error_code` (see {@link ENTITLEMENT_BLOCKED_ERROR_CODES},
 *    e.g. a deactivated org's `oauth_not_allowed_for_organization`) OR the
 *    legacy prose matcher ({@link isEntitlementDisabledMessage}, "Your
 *    organization has disabled Claude subscription access for Claude Code").
 *    A hard, account-level block: the account can NEVER serve, and re-probing
 *    won't lift it until the org re-enables Code access — at which point the
 *    next successful probe self-heals the mark. Distinct from a bad-token-scope
 *    403 (that keeps `"other"`).
 *  - `"other"` — any other non-ok HTTP status (bad scope 403, 401, 5xx, …) or
 *    a header-parse miss. Retains the legacy no-op semantics upstream.
 */
export type QuotaFailureKind = "entitlement_blocked" | "other";

export type QuotaResult =
  | { ok: true; data: QuotaUtilization }
  | {
      ok: false;
      /** Human-readable failure string (preserved for logs, unchanged shape). */
      reason: string;
      /** HTTP status when the failure came from an upstream response. Absent
       *  for pre-response failures (network error, timeout, empty token). */
      httpStatus?: number;
      /** The Anthropic API error `message` (from the JSON body `error.message`,
       *  else the raw body text truncated). Absent when no body was read. */
      apiErrorMessage?: string;
      /** Structured classification (see {@link QuotaFailureKind}). Absent =
       *  unclassified (legacy callers read the same `{ ok:false, reason }`). */
      failureKind?: QuotaFailureKind;
    };

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

/**
 * #3176 — resolve the tier-bucket reset. Prefer the per-bucket `7d_oi-reset`
 * header, fall back to the overall `unified-reset`, then to `retry-after`
 * (seconds from now) which a 429 always carries. `now` is injectable so the
 * retry-after anchor is testable.
 */
function parseTierReset(headers: Headers, now: Date): Date | null {
  const oi = parseEpochHeader(headers, "anthropic-ratelimit-unified-7d_oi-reset");
  if (oi != null) return oi;
  const unified = parseEpochHeader(headers, "anthropic-ratelimit-unified-reset");
  if (unified != null) return unified;
  const ra = headers.get("retry-after");
  if (ra != null) {
    const secs = Number(ra);
    if (Number.isFinite(secs) && secs > 0 && secs < 30 * 24 * 3600) {
      return new Date(now.getTime() + secs * 1000);
    }
  }
  return null;
}

export function parseQuotaHeaders(
  headers: Headers,
  now: Date = new Date(),
): QuotaResult {
  const fiveHour = parseFloatHeader(headers, "anthropic-ratelimit-unified-5h-utilization");
  const sevenDay = parseFloatHeader(headers, "anthropic-ratelimit-unified-7d-utilization");
  // #3176 — model-tier (7d_oi) bucket + overall unified verdict. Present on a
  // request issued against the flagship tier (a 429 wall carries these even
  // when the 5h/7d utilization headers are omitted).
  const unifiedStatus = headers.get("anthropic-ratelimit-unified-status");
  const sevenDayOiStatus = headers.get("anthropic-ratelimit-unified-7d_oi-status");
  const sevenDayOiUtil = parseFloatHeader(
    headers,
    "anthropic-ratelimit-unified-7d_oi-utilization",
  );
  const representativeClaim = headers.get(
    "anthropic-ratelimit-unified-representative-claim",
  );
  const hasTierSignal =
    unifiedStatus != null || sevenDayOiStatus != null || sevenDayOiUtil != null;
  if (fiveHour == null && sevenDay == null && !hasTierSignal) {
    return {
      ok: false,
      reason: "no unified rate-limit headers in response (API token, not OAuth?)",
    };
  }
  const oiPresent = sevenDayOiStatus != null || sevenDayOiUtil != null;
  return {
    ok: true,
    data: {
      // #2494 Bug C — we still coalesce a missing window header to 0 so the
      // numeric fields stay non-null for back-compat, but record which
      // windows were actually present so renderers can tell a real 0% from a
      // filled-0. (All-absent already returned ok:false above, so at least
      // one signal is present here.)
      fiveHourUtilizationPct: (fiveHour ?? 0) * 100,
      sevenDayUtilizationPct: (sevenDay ?? 0) * 100,
      fiveHourUtilPresent: fiveHour != null,
      sevenDayUtilPresent: sevenDay != null,
      fiveHourResetAt: parseEpochHeader(headers, "anthropic-ratelimit-unified-5h-reset"),
      sevenDayResetAt: parseEpochHeader(headers, "anthropic-ratelimit-unified-7d-reset"),
      representativeClaim,
      overageStatus: headers.get("anthropic-ratelimit-unified-overage-status"),
      overageDisabledReason: headers.get("anthropic-ratelimit-unified-overage-disabled-reason"),
      // #3176 — model-tier bucket signals.
      unifiedStatus,
      sevenDayOiStatus,
      sevenDayOiUtilizationPct: sevenDayOiUtil != null ? sevenDayOiUtil * 100 : null,
      sevenDayOiResetAt: parseTierReset(headers, now),
      sevenDayOiPresent: oiPresent,
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

/**
 * Extract the human-facing API error message from an Anthropic error body.
 * Anthropic returns `{"type":"error","error":{"type":"...","message":"..."}}`
 * on a 4xx; fall back to the raw (truncated) body when it isn't that shape.
 * Returns null for an empty body. PURE — no I/O.
 */
export function extractApiErrorMessage(bodyText: string): string | null {
  if (!bodyText || bodyText.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(bodyText) as unknown;
    const msg = (parsed as { error?: { message?: unknown } })?.error?.message;
    if (typeof msg === "string" && msg.trim().length > 0) return msg.trim();
  } catch {
    // Body isn't JSON — fall through to the raw text.
  }
  return bodyText.trim().slice(0, 500);
}

/**
 * Extract the STRUCTURED Anthropic error code from an error body. Anthropic
 * nests a machine-readable code at `error.details.error_code` (e.g.
 * `"oauth_not_allowed_for_organization"` for an OAuth-disabled org). Returns
 * null when the body isn't JSON, isn't the error shape, or carries no code.
 * PURE — no I/O.
 *
 * Keying on this stable code — rather than the human-facing `message` prose —
 * is why {@link isEntitlementBlockedErrorCode} can classify a deactivated
 * account deterministically even when its message wording differs from the
 * legacy "organization has disabled…" string the prose matcher targets.
 */
export function extractApiErrorCode(bodyText: string): string | null {
  if (!bodyText || bodyText.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(bodyText) as unknown;
    const code = (parsed as { error?: { details?: { error_code?: unknown } } })
      ?.error?.details?.error_code;
    if (typeof code === "string" && code.trim().length > 0) return code.trim();
  } catch {
    // Body isn't JSON — no structured code available.
  }
  return null;
}

/**
 * Structured Anthropic `error.details.error_code` values that mean the account
 * is DISABLED for Claude Code at the org/subscription level — a hard,
 * self-healing entitlement block (NOT a transient failure).
 *
 *  - `oauth_not_allowed_for_organization` — the observed signature of a
 *    deactivated / OAuth-disabled organization: a 403 whose message is "OAuth
 *    authentication is currently not allowed for this organization." The prose
 *    matcher ({@link isEntitlementDisabledMessage}) does NOT catch this — the
 *    message carries no "disabled" nor "claude code" — so keying on the code is
 *    what closes the gap where such an account decayed to `unknown` and could
 *    still be selected to serve.
 *
 * DELIBERATELY NARROW. This is an allowlist, not a "any 403 is a block" rule —
 * an unrelated/transient 403 (bad token scope, a flaky edge 403) must stay
 * `"other"` so it never benches a healthy account. Add a new code here only
 * when it is a confirmed org/subscription-level Claude Code disablement.
 */
export const ENTITLEMENT_BLOCKED_ERROR_CODES = new Set<string>([
  "oauth_not_allowed_for_organization",
]);

/**
 * Does this structured `error_code` denote an org/subscription-level Claude
 * Code disablement (a hard entitlement block)? See
 * {@link ENTITLEMENT_BLOCKED_ERROR_CODES}. PURE — no I/O.
 */
export function isEntitlementBlockedErrorCode(
  code: string | null | undefined,
): boolean {
  return code != null && ENTITLEMENT_BLOCKED_ERROR_CODES.has(code);
}

/**
 * Does this API error message indicate the org/subscription has DISABLED Claude
 * Code access (the entitlement-403), as opposed to a bad-token-scope 403?
 *
 * The observed entitlement message is "Your organization has disabled Claude
 * subscription access for Claude Code". We key on the DISABLED verb plus a
 * Claude-Code/subscription reference plus an org/subscription reference — a
 * conjunction the scope-error messages ("credential is only authorized for use
 * with Claude Code", "OAuth token does not have the required scopes") never
 * satisfy, since they carry no "disabled". PURE — no I/O.
 */
export function isEntitlementDisabledMessage(
  message: string | null | undefined,
): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  if (!m.includes("disabled")) return false;
  const mentionsCode = m.includes("claude code") || m.includes("claude subscription");
  const mentionsOrgOrSub = m.includes("organization") || m.includes("subscription") || m.includes(" org ");
  return mentionsCode && mentionsOrgOrSub;
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
  // NOTE: do NOT clearTimeout yet — the abort signal must keep covering the
  // body read below (a stalled 4xx body would otherwise hang the probe slot).
  // Each return path clears the timer after it is done consuming the response.

  // Read headers regardless of HTTP status — the rate-limit headers
  // are populated on 200 AND on auth-failure 4xx responses. A 429 tier-wall
  // carries the 7d_oi headers and parses ok:true here (kept as-is).
  const parsed = parseQuotaHeaders(resp.headers);
  if (parsed.ok) {
    clearTimeout(timeout);
    return parsed;
  }

  if (!resp.ok) {
    // The probe FAILED at the HTTP layer. Read the body to classify the
    // failure: an entitlement-403 (org disabled Claude Code access) is a hard
    // account-level block, NOT the transient no-op every other failure is.
    // Losing the body here was the gap — a disabled account looked identical to
    // a flaky probe and decayed to "unknown" on the stale cache.
    let bodyText = "";
    try {
      bodyText = await resp.text();
    } catch {
      // Body unreadable / timed out — leave empty; classification degrades to "other".
    }
    clearTimeout(timeout);
    const apiErrorMessage = extractApiErrorMessage(bodyText);
    // Classify a 403 as a hard entitlement block on EITHER signal:
    //  1. the STRUCTURED `error.details.error_code` (preferred — deterministic,
    //     survives message-wording changes; catches the OAuth-disabled-org
    //     deactivation whose prose the matcher below misses), or
    //  2. the legacy prose matcher (fallback for the "organization has disabled
    //     Claude subscription access…" body that carries no structured code).
    // Deliberately narrow to an error-code allowlist + the existing matcher — an
    // unrelated/transient 403 stays "other" and never benches a healthy account.
    const apiErrorCode = extractApiErrorCode(bodyText);
    const entitlement =
      resp.status === 403 &&
      (isEntitlementBlockedErrorCode(apiErrorCode) ||
        isEntitlementDisabledMessage(apiErrorMessage));
    return {
      ok: false,
      reason: `HTTP ${resp.status} from Anthropic (${parsed.reason})`,
      httpStatus: resp.status,
      ...(apiErrorMessage ? { apiErrorMessage } : {}),
      failureKind: entitlement ? "entitlement_blocked" : "other",
    };
  }
  clearTimeout(timeout);
  return parsed;
}
