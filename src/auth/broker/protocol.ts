/**
 * auth-broker wire protocol — newline-delimited JSON (NDJSON).
 *
 * Mirrors `src/vault/broker/protocol.ts` framing: one JSON object
 * per line, terminated by "\n", request/response per connection
 * turn, connection persists for multiple sequential requests.
 *
 * Path-as-identity is the auth model — the broker derives the
 * calling agent or consumer from the bind path the connection
 * arrived on (`/run/switchroom/auth-broker/<name>/sock`), never
 * from a wire payload. No verb takes an `agent:` or `caller:`
 * argument.
 *
 * Eight verbs in v1 (RFC H §4.3):
 *
 *   - `get-credentials` — return the caller's current credentials.
 *   - `list-state`      — fleet snapshot (accounts, agents, consumers).
 *   - `set-active`      — fleet-wide active-account swap (admin).
 *   - `mark-exhausted`  — quota event on caller's bound account.
 *   - `mark-throttled`  — transient-429 throttle on caller's bound account
 *                         (429 throttle tier; no roll, no ineligibility).
 *   - `refresh-account` — force a refresh tick (admin).
 *   - `add-account`     — register a new account (admin).
 *   - `rm-account`      — remove an account (admin).
 *   - `set-override`    — per-agent override (admin).
 *
 * `mark-exhausted` (and `mark-throttled`) take ONLY an `until`
 * argument; the account they affect is derived from path-identity.
 * This closes the fleet-wide spurious-deauth abuse path the round-1
 * review flagged.
 *
 * **Provider field (RFC G Phase 3b.1):** Per-account verbs accept an
 * optional `provider:` field. When absent or `"anthropic"`, behavior
 * is unchanged from RFC H. When `"google"` (added by Phase 3b.2),
 * the broker dispatches through the Google provider. Per-account
 * state is keyed on `(provider, account)` so an account named
 * `"alice@example.com"` registered as Google does not collide with
 * an Anthropic account label of the same string.
 *
 * `get-credentials` and `mark-exhausted` derive provider+account
 * from path-identity (the broker knows which provider an agent or
 * consumer is bound to from its socket-mount config), so they don't
 * take a `provider:` field on the wire.
 */

import { z } from "zod";
import type { AccountCredentials } from "../account-store.js";

// ─── Constants ─────────────────────────────────────────────────────────────

/** Hard cap on one frame. Credentials JSON is small; this is plenty. */
export const MAX_FRAME_BYTES = 64 * 1024;

/** Wire-protocol major version. Bump on breaking change to envelope shape. */
export const PROTOCOL_VERSION = 1;

/**
 * Provider names accepted on the wire (RFC G Phase 3b.1). New providers
 * extend this enum; the broker server validates incoming `provider:`
 * fields against it before dispatching.
 */
export const ProviderNameSchema = z.enum(["anthropic", "google", "microsoft"]);
export type ProviderName = z.infer<typeof ProviderNameSchema>;

/**
 * Default provider — `"anthropic"`. Used when verbs omit the
 * `provider:` field entirely (back-compat with RFC H pre-Phase-3b
 * clients).
 */
export const DEFAULT_PROVIDER: ProviderName = "anthropic";

// ─── Request schemas ───────────────────────────────────────────────────────

export const GetCredentialsRequestSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  op: z.literal("get-credentials"),
  id: z.string().min(1),
  /**
   * Provider for the credentials being requested. Optional; defaults to
   * `"anthropic"` for back-compat with RFC H pre-Phase-3b.4 callers.
   *
   * For Anthropic: account is derived from path-as-identity per the
   * existing callerAccount() logic (auth.active or per-agent override).
   *
   * For Google (RFC G Phase 3b.4): account is read from the agent's
   * `google_workspace.account` config field. Broker validates the
   * agent is in `google_accounts.<account>.enabled_for[]` before
   * returning credentials.
   */
  provider: ProviderNameSchema.optional(),
  /**
   * Requested Microsoft account (multi-account-per-agent). Optional. When
   * present (provider="microsoft"), the broker validates it is one of the
   * agent's `microsoft_workspace` bindings AND that the account lists this
   * agent in `microsoft_accounts.<account>.enabled_for[]`, then returns
   * THAT account's credentials. Omitted → single-account back-compat (the
   * account is derived from the agent's singular `microsoft_workspace.account`).
   */
  account: z.string().min(1).optional(),
});

export const ListStateRequestSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  op: z.literal("list-state"),
  id: z.string().min(1),
});

export const SetActiveRequestSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  op: z.literal("set-active"),
  id: z.string().min(1),
  account: z.string().min(1),
  /**
   * Provider for the target account. Optional, defaults to
   * `"anthropic"` (back-compat with RFC H pre-Phase-3b clients).
   * `set-active` is fleet-wide active-account swap which is currently
   * an Anthropic-only concept; Google's account-active model is
   * per-agent-via-`google_accounts.enabled_for[]`. This field is
   * carried for protocol uniformity even though `set-active` will
   * reject `provider: "google"` until/unless a fleet-wide-active
   * Google concept is added.
   */
  provider: ProviderNameSchema.optional(),
});

export const MarkExhaustedRequestSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  op: z.literal("mark-exhausted"),
  id: z.string().min(1),
  /** Unix ms when the exhaustion clears. Defaults to now + 5h if omitted. */
  until: z.number().int().positive().optional(),
});

/**
 * 429 throttle tier — a TRANSIENT per-account rate limit whose reset is near
 * (retry-in-place, default ≤5 min). Records `throttled_until` in the quota
 * ledger WITHOUT rolling the fleet and WITHOUT making the account ineligible
 * for live sessions — eligibility (account-eligibility.ts) keys only on
 * exhaustion marks and live snapshots. Consumers of `list-state` (cron
 * quota-preflight) read `throttled_until` to soft-defer scheduled fires until
 * the throttle clears.
 *
 * Same posture as `mark-exhausted`: non-admin, the affected account is
 * derived from path-identity, never from the wire.
 */
export const MarkThrottledRequestSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  op: z.literal("mark-throttled"),
  id: z.string().min(1),
  /** Unix ms when the throttle clears. Server-side clamped to a short
   *  ceiling (throttles are minutes, never days). Ignored when probeOnly. */
  until: z.number().int().positive(),
  /** #failover-429-corroborate — probe-only mode (generic-transient 429
   *  origin). Run ONLY the rate-bounded escalation probe: on a corroborated
   *  wall, mark-exhausted + roll; on a healthy probe, record NOTHING (no
   *  throttled_until, no hit, no soft-defer) so the account stays inert. */
  probeOnly: z.boolean().optional(),
});

export const RefreshAccountRequestSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  op: z.literal("refresh-account"),
  id: z.string().min(1),
  account: z.string().min(1),
  /** Provider for the target account. Defaults to `"anthropic"` for back-compat. */
  provider: ProviderNameSchema.optional(),
});

/**
 * Anthropic-shaped credentials — the Phase-1 (RFC H) shape. Stored
 * verbatim under `claudeAiOauth: { ... }`.
 */
export const AnthropicCredentialsSchema = z.object({
  claudeAiOauth: z.object({
    accessToken: z.string(),
    refreshToken: z.string().optional(),
    expiresAt: z.number().optional(),
    scopes: z.array(z.string()).optional(),
    subscriptionType: z.string().optional(),
    rateLimitTier: z.string().optional(),
  }),
});
export type AnthropicCredentialsShape = z.infer<typeof AnthropicCredentialsSchema>;

/**
 * Google-shaped credentials — added by Phase 3b.2. Stored verbatim
 * under `googleOauth: { ... }`. Field set mirrors what
 * `taylorwilsdon/google_workspace_mcp` and the Google OAuth 2.0
 * token-exchange response provide.
 */
export const GoogleCredentialsSchema = z.object({
  googleOauth: z.object({
    accessToken: z.string(),
    refreshToken: z.string(),
    expiresAt: z.number(),
    /** Granted scope set, space-separated as Google returns it. */
    scope: z.string(),
    /** OAuth client id used to obtain the credentials (broker validates on refresh). */
    clientId: z.string(),
    /** Account email — RFC G's per-account ACL key. */
    accountEmail: z.string(),
    tokenType: z.literal("Bearer"),
  }),
});
export type GoogleCredentialsShape = z.infer<typeof GoogleCredentialsSchema>;

/**
 * Microsoft-shaped credentials — added by RFC #1873 (Microsoft 365
 * integration). Stored verbatim under `microsoftOauth: { ... }`.
 *
 * Microsoft tokens carry more identity context than Google's because
 * one OAuth app (`/common` endpoint, `AzureADandPersonalMicrosoftAccount`
 * audience) can produce tokens for either personal MSA (`tid` =
 * `9188040d-6c67-4c5b-b112-36a304b66dad`) or work/school tenants.
 * Switchroom persists the discriminator (`accountType`) + the source
 * tenant (`tenantId`) + the MSAL-style `homeAccountId` (`<oid>.<tid>`)
 * alongside the token material so per-account state can be reasoned
 * about without re-decoding the id_token on every read.
 *
 * Refresh tokens rotate every refresh (Microsoft v2 endpoint default);
 * the broker writes the new RT atomically via `microsoft-storage.ts`
 * after each successful exchange. Provider returns `newRefreshToken`
 * on every successful refresh.
 */
export const MicrosoftCredentialsSchema = z.object({
  microsoftOauth: z.object({
    accessToken: z.string(),
    refreshToken: z.string(),
    expiresAt: z.number(),
    /** Granted scope set, space-separated as Microsoft returns it. */
    scope: z.string(),
    /** OAuth client id used to obtain the credentials. */
    clientId: z.string(),
    /** preferred_username from id_token (email-shaped for both MSA and work). */
    accountEmail: z.string(),
    tokenType: z.literal("Bearer"),
    /**
     * `tid` claim from id_token. `9188040d-6c67-4c5b-b112-36a304b66dad`
     * for personal MSA, a real tenant GUID for work/school.
     */
    tenantId: z.string(),
    /** Derived from tenantId: convenience discriminator. */
    accountType: z.enum(["personal", "work"]),
    /** MSAL-style stable account key: `<oid>.<tid>`. */
    homeAccountId: z.string(),
  }),
});
export type MicrosoftCredentialsShape = z.infer<typeof MicrosoftCredentialsSchema>;

/**
 * Personal MSA tenant constant. Microsoft's documented well-known tid
 * for all consumer Microsoft Accounts (outlook.com, hotmail.com,
 * live.com, Xbox, Skype). Tokens minted for personal accounts always
 * carry this exact tid; work/school tokens carry their org's tenant GUID.
 */
export const PERSONAL_MSA_TENANT_ID = "9188040d-6c67-4c5b-b112-36a304b66dad";

/**
 * Provider-discriminated credentials union. Each variant is the
 * verbatim on-disk shape for that provider. Broker stores credentials
 * pass-through; consumers (CLI, MCP wrapper) introspect.
 */
export const ProviderCredentialsSchema = z.union([
  AnthropicCredentialsSchema,
  GoogleCredentialsSchema,
  MicrosoftCredentialsSchema,
]);
export type ProviderCredentialsShape = z.infer<typeof ProviderCredentialsSchema>;

export const AddAccountRequestSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  op: z.literal("add-account"),
  id: z.string().min(1),
  label: z.string().min(1),
  /**
   * Provider for the new account. Defaults to `"anthropic"` for
   * back-compat — RFC H pre-Phase-3b clients omit this field and
   * pass Anthropic credentials.
   *
   * The provider field MUST agree with the credentials shape:
   * `provider: "anthropic"` requires `claudeAiOauth: { ... }`,
   * `provider: "google"` requires `googleOauth: { ... }`. Server
   * validates this agreement and rejects with INVALID_ARGS otherwise.
   */
  provider: ProviderNameSchema.optional(),
  /**
   * Full credentials.json shape for the provider; broker stores verbatim.
   * Schema is a union over provider variants — the server validates the
   * variant matches `provider:` (or `DEFAULT_PROVIDER`).
   */
  credentials: ProviderCredentialsSchema,
  /** Replace an existing account (used for drift recovery). */
  replace: z.boolean().optional(),
});

export const RmAccountRequestSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  op: z.literal("rm-account"),
  id: z.string().min(1),
  label: z.string().min(1),
  /** Provider for the account. Defaults to `"anthropic"` for back-compat. */
  provider: ProviderNameSchema.optional(),
});

export const SetOverrideRequestSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  op: z.literal("set-override"),
  id: z.string().min(1),
  agent: z.string().min(1),
  /** null clears the override (agent returns to fleet active). */
  account: z.string().min(1).nullable(),
});

/**
 * Phase 3b.2d follow-up — enumerate Google accounts the broker has
 * stored. Distinct from `list-state` (which is Anthropic-shaped:
 * fleet active, fallback order, per-agent + consumer overrides). The
 * Google equivalent is the per-account ACL via `google_accounts.<email>.
 * enabled_for[]` in switchroom.yaml — that's the operator-facing matrix
 * (see `switchroom auth google list`); this op is the broker-side
 * inventory of what credentials are stored, used by `auth google
 * account list` to confirm the YAML matches what the broker holds.
 *
 * Refresh token + access token are NOT returned — those stay on disk.
 * Only credential metadata an operator needs to reason about (which
 * accounts exist, when each token expires, what scopes were granted).
 */
export const ListGoogleAccountsRequestSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  op: z.literal("list-google-accounts"),
  id: z.string().min(1),
});

/**
 * RFC #1873 — Microsoft account inventory. Mirror of
 * `list-google-accounts`: returns credential metadata only (account,
 * expiry, scope, clientId, accountType) — never the refresh/access
 * tokens. Powers `switchroom auth microsoft account list` so an
 * operator can confirm the YAML ACL matches what the broker holds.
 */
export const ListMicrosoftAccountsRequestSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  op: z.literal("list-microsoft-accounts"),
  id: z.string().min(1),
});

/**
 * Probe live Anthropic quota for a set of accounts. The broker reads
 * each account's stored accessToken from `~/.switchroom/accounts/
 * <label>/credentials.json` (its source of truth, only the broker has
 * a HOME with this path) and probes the upstream `/v1/messages`
 * endpoint per account, returning the parsed rate-limit-utilization
 * headers.
 *
 * Why this op exists: the gateway lives in the agent container; the
 * legacy probe path read `credentials.json` off the agent's local
 * HOME, which post-RFC-H no longer holds the account-level
 * credentials (the broker writes only the `.claude/.credentials.json`
 * mirror to agent HOMEs). With nothing to read, every account showed
 * "quota probe failed: no credentials.json or accessToken" in
 * `/auth show`. probe-quota routes the probe through the broker
 * (which DOES have the file) without exposing the accessToken to
 * the gateway.
 *
 * ACL: same posture as `list-state` — no identity restriction.
 * Every peer that reaches the broker can call this op (matches the
 * existing fleet-snapshot precedent). No per-account ACL either;
 * unknown labels return a failure result for that label, never a
 * hard error.
 */
export const ProbeQuotaRequestSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  op: z.literal("probe-quota"),
  id: z.string().min(1),
  /** Account labels to probe. Order is preserved in the response. */
  accounts: z.array(z.string().min(1)).min(1).max(32),
  /** Override probe timeout per account (ms). Defaults to 10s. */
  timeoutMs: z.number().int().positive().max(60_000).optional(),
  /**
   * #2495 Change 2/3 — bypass the probe-on-open TTL gate and force a live
   * upstream probe. Used by the proactive quota-watch alarm path, which must
   * CORROBORATE a stale-snapshot transition with a true live probe before
   * alarming — a TTL-hit cache read would defeat the corroboration. Normal
   * card-open renders leave this unset (TTL-gated). Single-flight coalescing
   * still applies even when forced.
   */
  forceLive: z.boolean().optional(),
});

/**
 * Fleet-wide notification dedup claim (#E4 follow-up — quota-watch
 * de-duplication). Every agent gateway independently runs the same
 * watchers (quota-watch, fleet all-exhausted) over the same shared
 * account pool, so a single transition used to fan out one Telegram
 * message PER AGENT (×11 on a full fleet). The broker — already the
 * fleet's shared singleton — arbitrates: the first caller to claim a
 * `key` within `windowMs` is granted (and should send); everyone else
 * is denied (and should stay silent but still update local state).
 *
 * Keys are caller-defined, e.g.
 * `quota-watch:<account>:<transition>:<chatId>` — per-chat keys keep
 * the audience identical to the pre-dedup behaviour (every chat any
 * agent would have notified still gets exactly one copy).
 *
 * ACL: same posture as `list-state` — no identity restriction. A
 * denied claim is `granted: false`, never an error. Claims are
 * persisted (`notification-claims.json`) so a broker restart inside
 * the window does not re-open the gate.
 */
export const ClaimNotificationRequestSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  op: z.literal("claim-notification"),
  id: z.string().min(1),
  /** Dedup key. Caller-namespaced (e.g. "quota-watch:<acct>:<edge>:<chat>"). */
  key: z.string().min(1).max(512),
  /** Deny subsequent claims for the same key for this long. */
  windowMs: z.number().int().positive().max(86_400_000),
});

/**
 * Fleet external (OpenRouter / non-Claude cash) spend summary for the
 * `/usage` card. ACL matches `list-state` — any authenticated identity.
 * The auth-broker holds the LiteLLM master key and publishes only a
 * sanitized summary (no key material on the wire).
 *
 * forceLive bypasses the broker's refresh TTL (same idea as probe-quota)
 * when the operator re-opens /usage and wants fresher totals.
 */
export const GetExternalSpendRequestSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  op: z.literal("get-external-spend"),
  id: z.string().min(1),
  /** Bypass the ~90s live-refresh TTL and re-query LiteLLM. */
  forceLive: z.boolean().optional(),
});

export const RequestSchema = z.discriminatedUnion("op", [
  GetCredentialsRequestSchema,
  ListStateRequestSchema,
  SetActiveRequestSchema,
  MarkExhaustedRequestSchema,
  MarkThrottledRequestSchema,
  RefreshAccountRequestSchema,
  AddAccountRequestSchema,
  RmAccountRequestSchema,
  SetOverrideRequestSchema,
  ListGoogleAccountsRequestSchema,
  ListMicrosoftAccountsRequestSchema,
  ProbeQuotaRequestSchema,
  ClaimNotificationRequestSchema,
  GetExternalSpendRequestSchema,
]);

export type Request = z.infer<typeof RequestSchema>;

// ─── Response data shapes ──────────────────────────────────────────────────

export const GetCredentialsDataSchema = z.object({
  account: z.string(),
  credentials: z.unknown(), // AccountCredentials, passed through verbatim
  expiresAt: z.number().optional(),
});

export const AccountStateSchema = z.object({
  label: z.string(),
  expiresAt: z.number().optional(),
  exhausted: z.boolean(),
  /** Fleet in-service classification: TRUE when the config still routes to this
   *  account (it is the active, a `fallback_order` candidate, or an agent /
   *  consumer pin). FALSE → RETIRED: credentials linger on disk but the fleet no
   *  longer routes to it, so the account views render it "retired", never
   *  "available". Optional: ABSENT means in-service — only an explicit `false`
   *  retires, so a pre-field broker (no field) never retires the fleet. Do NOT
   *  add `.default(false)`: if a decode path ever parses this schema, a default
   *  would silently coerce absent→false and retire every account. */
  in_service: z.boolean().optional(),
  /** Org / entitlement-level block: TRUE when Anthropic reports the account
   *  disabled at the organization level (the entitlement probe, populated by
   *  PR2). Renders as "DISABLED (org)" and outranks RETIRED. Optional: absent /
   *  a pre-PR2 broker reports every account un-blocked (only explicit `true`
   *  blocks). No `.default(false)` — same decode-path safety as `in_service`. */
  entitlement_blocked: z.boolean().optional(),
  exhausted_until: z.number().optional(),
  /** 429 throttle tier — unix ms until which the account is transiently
   *  rate-limited (`mark-throttled`). Informational: never gates serving
   *  or failover eligibility; cron quota-preflight soft-defers on it. */
  throttled_until: z.number().optional(),
  threshold_violations: z.number().int().nonnegative().optional(),
  last_refreshed_at: z.number().optional(),
});

export const AgentStateSchema = z.object({
  name: z.string(),
  account: z.string(),
  override: z.string().nullable(),
});

export const ConsumerStateSchema = z.object({
  name: z.string(),
  account: z.string(),
  last_seen_at: z.number().nullable(),
});

export const ListStateDataSchema = z.object({
  active: z.string(),
  fallback_order: z.array(z.string()),
  accounts: z.array(AccountStateSchema),
  agents: z.array(AgentStateSchema),
  consumers: z.array(ConsumerStateSchema),
  /**
   * Whether the account the CALLER is bound to may currently be served past the
   * weekly utilization wall on Anthropic overage billing (in
   * `allow_overage_accounts`, `overageStatus:"allowed"`, not `out_of_credits`,
   * no active 429 mark). The in-agent rate-limit-menu handler reads this — the
   * broker's single audited spend-authorization signal — before it may select
   * "usage credits". Optional/back-compat: absent on pre-overage brokers (read
   * as false). Default-off: false whenever `allow_overage_accounts` is empty.
   */
  active_overage_serving: z.boolean().optional(),
});

export const SetActiveDataSchema = z.object({
  active: z.string(),
  fanned: z.array(z.string()),
});

export const MarkExhaustedDataSchema = z.object({
  account: z.string(),
  rolled: z.array(z.string()),
  // The account the fleet rolled TO (next non-exhausted in fallback_order),
  // or null when every fallback is also exhausted. Lets a non-admin caller
  // (auto-fallback) announce an accurate target without an admin set-active.
  rolledTo: z.string().nullable().optional(),
});

export const MarkThrottledDataSchema = z.object({
  account: z.string(),
  /** The recorded (clamped) throttle expiry, unix ms. */
  throttled_until: z.number(),
  /**
   * Escalation guard: true when this hit was the Nth transient 429 on the
   * account inside the escalation window, the broker ran a live quota probe,
   * and the probe CORROBORATED a genuine wall — so the broker marked the
   * account exhausted and rolled the fleet (standard markExhaustedAndRoll).
   */
  escalated: z.boolean(),
  /** Set only when `escalated` — the account the fleet rolled to (null when
   *  every fallback was also exhausted). */
  rolledTo: z.string().nullable().optional(),
});

export const RefreshAccountDataSchema = z.object({
  account: z.string(),
  expiresAt: z.number().optional(),
});

export const AddAccountDataSchema = z.object({
  label: z.string(),
  expiresAt: z.number().optional(),
});

export const RmAccountDataSchema = z.object({
  label: z.string(),
});

export const SetOverrideDataSchema = z.object({
  agent: z.string(),
  account: z.string().nullable(),
});

export const ClaimNotificationDataSchema = z.object({
  /** True for the first claimant inside the window — only they send. */
  granted: z.boolean(),
});

/**
 * Per-Google-account inventory entry returned by `list-google-accounts`.
 * Excludes the refresh + access tokens — operators querying the
 * inventory don't need those, and never returning them keeps the wire
 * surface narrow.
 */
export const GetExternalSpendDataSchema = z.object({
  /** False when the broker has no master key / LiteLLM unreachable and no cache. */
  available: z.boolean(),
  day24hUsd: z.number().optional(),
  day7dUsd: z.number().optional(),
  top: z
    .array(
      z.object({
        label: z.string(),
        usd: z.number(),
      }),
    )
    .optional(),
  /** Unix ms when the summary was computed. */
  capturedAtMs: z.number().int().nonnegative().optional(),
  /** "live" freshly fetched, "cache" served from durable/TTL cache. */
  served: z.enum(["live", "cache"]).optional(),
  /** Short reason when available=false (never includes secrets). */
  reason: z.string().optional(),
});


export const GoogleAccountStateSchema = z.object({
  account: z.string(),
  expiresAt: z.number(),
  scope: z.string(),
  clientId: z.string(),
});

export const ListGoogleAccountsDataSchema = z.object({
  accounts: z.array(GoogleAccountStateSchema),
});

/**
 * Per-Microsoft-account inventory entry returned by
 * `list-microsoft-accounts`. Like Google's, excludes refresh + access
 * tokens; adds `accountType` so a personal MSA is distinguishable from
 * a work/school account in the listing.
 */
export const MicrosoftAccountStateSchema = z.object({
  account: z.string(),
  expiresAt: z.number(),
  scope: z.string(),
  clientId: z.string(),
  accountType: z.enum(["personal", "work"]),
});

export const ListMicrosoftAccountsDataSchema = z.object({
  accounts: z.array(MicrosoftAccountStateSchema),
});

// ─── Response envelope ─────────────────────────────────────────────────────

export const ErrorBodySchema = z.object({
  code: z.enum([
    "FORBIDDEN",
    "INVALID_ARGS",
    "UNKNOWN_VERB",
    "VERSION_MISMATCH",
    "ACCOUNT_NOT_FOUND",
    "ACCOUNT_ALREADY_EXISTS",
    "CONFIG_INVALID",
    "DRIFT_DETECTED",
    "REFRESH_FAILED",
    "INTERNAL",
  ]),
  message: z.string(),
});
export type ErrorCode = z.infer<typeof ErrorBodySchema>["code"];

export const SuccessResponseSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  id: z.string(),
  ok: z.literal(true),
  data: z.unknown(),
});

export const ErrorResponseSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  id: z.string(),
  ok: z.literal(false),
  error: ErrorBodySchema,
});

export const ResponseSchema = z.discriminatedUnion("ok", [
  SuccessResponseSchema,
  ErrorResponseSchema,
]);

export type Response = z.infer<typeof ResponseSchema>;

// ─── Encode / decode helpers ───────────────────────────────────────────────

/**
 * Encode a request as a single NDJSON frame (trailing newline included).
 * Throws when the serialized frame would exceed MAX_FRAME_BYTES.
 */
export function encodeRequest(req: Request): string {
  const line = JSON.stringify(RequestSchema.parse(req)) + "\n";
  if (Buffer.byteLength(line, "utf-8") > MAX_FRAME_BYTES) {
    throw new Error(
      `auth-broker request exceeds MAX_FRAME_BYTES (${MAX_FRAME_BYTES})`,
    );
  }
  return line;
}

export function decodeRequest(line: string): Request {
  const trimmed = line.endsWith("\n") ? line.slice(0, -1) : line;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("auth-broker request is not valid JSON");
  }
  return RequestSchema.parse(parsed);
}

/**
 * Build a success response. `data` is unknown by design — the server
 * embeds a per-verb shape (see `*DataSchema` above) but the envelope
 * itself stays untyped.
 */
export function encodeSuccess(id: string, data: unknown): string {
  const line = JSON.stringify({ v: PROTOCOL_VERSION, id, ok: true, data }) + "\n";
  if (Buffer.byteLength(line, "utf-8") > MAX_FRAME_BYTES) {
    throw new Error(
      `auth-broker response exceeds MAX_FRAME_BYTES (${MAX_FRAME_BYTES})`,
    );
  }
  return line;
}

export function encodeError(id: string, code: ErrorCode, message: string): string {
  return (
    JSON.stringify({
      v: PROTOCOL_VERSION,
      id,
      ok: false,
      error: { code, message },
    }) + "\n"
  );
}

export function decodeResponse(line: string): Response {
  const trimmed = line.endsWith("\n") ? line.slice(0, -1) : line;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("auth-broker response is not valid JSON");
  }
  return ResponseSchema.parse(parsed);
}

/** Re-export the credentials shape so clients depend on the protocol module only. */
export type { AccountCredentials };
