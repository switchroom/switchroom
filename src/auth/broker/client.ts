/**
 * switchroom-auth-broker client library (RFC H §4.3, §4.6).
 *
 * Used by the CLI (operator socket), agent-side consumers (per-agent
 * socket), and ephemeral consumers (per-consumer socket) to talk to a
 * running auth-broker daemon.
 *
 * Wire shape mirrors `src/auth/broker/protocol.ts`: one NDJSON frame
 * per request, one per response, request/response correlated by `id`.
 *
 * Failure model — Decision 9 of the RFC ("degraded, not catastrophic"):
 *
 *   - Server reachable → `AuthBrokerError` thrown on non-ok response,
 *     carries the `ErrorCode` from the wire so callers can branch.
 *   - Server unreachable (ENOENT / ECONNREFUSED / EACCES / timeout)
 *     → `AuthBrokerUnreachableError` thrown, so callers can fall back
 *     to reading `<agentDir>/.claude/credentials.json` directly. The
 *     8-hour token lifetime means the broker can be down for hours
 *     without a user-visible outage.
 *
 * Socket-path resolution (in priority order):
 *   1. Explicit `socket` option (tests; explicit operator overrides).
 *   2. `SWITCHROOM_AUTH_BROKER_SOCKET` env (set by compose for agents).
 *   3. `~/.switchroom/state/auth-broker-operator/sock` (operator bind
 *      mount from the auth-broker container).
 *
 * Connection model: open-on-first-call, multiplex over a single
 * persistent UDS connection (each request gets a UUID `id`),
 * graceful close on `client.close()`. The vault-broker uses one
 * connection per RPC; here we keep one open because the CLI's
 * `auth show` issues one `list-state` call, but the long-running
 * gateway / hindsight consumers call repeatedly and connection churn
 * is wasteful.
 */

import * as net from "node:net";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  PROTOCOL_VERSION,
  encodeRequest,
  decodeResponse,
  type ErrorCode,
  type ProviderName,
  type Request,
  type Response,
} from "./protocol.js";

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Revive a wire value back into `Date | null`. The broker serialises
 * Date fields to ISO strings over NDJSON (JSON has no Date type); a
 * blind `as` cast leaves them as strings, so `.getTime()` in the
 * format layer throws. Accepts Date (already revived), string/number
 * (epoch or ISO), or null/undefined. Invalid dates collapse to null
 * rather than producing an `Invalid Date` that crashes formatters.
 */
function reviveDate(v: Date | string | number | null | undefined): Date | null {
  if (v == null) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Resolved operator socket — bind-mount target from the broker container. */
function operatorSocketPath(home: string = homedir()): string {
  return join(home, ".switchroom", "state", "auth-broker-operator", "sock");
}

/**
 * Resolve the socket path the client should connect to.
 *
 * Order: explicit option > SWITCHROOM_AUTH_BROKER_SOCKET env > operator
 * fallback. The env var is set by `src/agents/compose.ts` on every
 * agent service to `/run/switchroom/auth-broker/sock` — the path-as-
 * identity contract for in-container agents.
 */
export function resolveAuthBrokerSocketPath(opts?: AuthBrokerClientOpts): string {
  if (opts?.socket) return opts.socket;
  const env = process.env.SWITCHROOM_AUTH_BROKER_SOCKET;
  if (env && env.length > 0) return env;
  return operatorSocketPath(opts?.home);
}

export interface AuthBrokerClientOpts {
  /** Override the resolved socket path (tests, explicit operator paths). */
  socket?: string;
  /** RPC timeout in ms. Default 5000. */
  timeoutMs?: number;
  /** Override homedir() for tests. */
  home?: string;
}

/**
 * Error thrown for broker-side failures with a typed `ErrorCode`. The
 * CLI surfaces `code` in operator-readable form (e.g. "FORBIDDEN") and
 * pairs `message` with it for context.
 */
export class AuthBrokerError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AuthBrokerError";
  }
}

/**
 * Thrown when the broker can't be reached at all (socket missing,
 * connect refused, no response within timeout). Callers should treat
 * this as the "degraded mode" signal — agents keep running on their
 * existing credentials file (Decision 9).
 */
export class AuthBrokerUnreachableError extends Error {
  constructor(
    public readonly reason: string,
    public readonly socketPath: string,
  ) {
    super(
      `auth-broker unreachable at ${socketPath}: ${reason}. ` +
        `The broker may be down; existing credentials remain valid until expiry.`,
    );
    this.name = "AuthBrokerUnreachableError";
  }
}

// ─── Response data interfaces ─────────────────────────────────────────────

export interface GetCredentialsData {
  account: string;
  credentials: unknown;
  expiresAt?: number;
}

/**
 * Cached utilization snapshot attached to each AccountState when the
 * broker has a recent probe result. Populated by opProbeQuota (in-memory
 * on the broker). `null` when no probe has run since broker start.
 * Dates are serialised as ISO strings over NDJSON.
 */
export interface LastQuotaSnapshot {
  fiveHourUtilizationPct: number;
  sevenDayUtilizationPct: number;
  /** ISO 8601 string, or null when the server didn't return a reset time. */
  fiveHourResetAt: string | null;
  /** ISO 8601 string, or null when the server didn't return a reset time. */
  sevenDayResetAt: string | null;
  representativeClaim: string | null;
  overageStatus: string | null;
  overageDisabledReason: string | null;
  /** Unix ms when this snapshot was captured by the broker. */
  capturedAt: number;
  /**
   * #2494 Bug C — which utilization windows were actually present in the probe
   * headers. Optional: a snapshot that predates the field (or a real probe
   * that measured 0%) leaves them unset, which is read as "present". A thin
   * probe (both explicitly false) renders as `unknown`, never a confident 0%.
   */
  fiveHourUtilPresent?: boolean;
  sevenDayUtilPresent?: boolean;
}

export interface AccountState {
  label: string;
  expiresAt?: number;
  exhausted: boolean;
  /**
   * Fleet in-service classification: TRUE when the config still routes to this
   * account (it is the active, a `fallback_order` candidate, or an agent /
   * consumer pin). FALSE → RETIRED — the credentials still sit on disk but the
   * fleet no longer routes to it, so every account view must render it "retired"
   * rather than "available". Absent on a pre-field broker (treat absent as
   * in-service — only an explicit `false` retires an account, so a broker that
   * predates this field never falsely retires the whole fleet).
   */
  in_service?: boolean;
  /**
   * Org / entitlement-level block: TRUE when Anthropic reports the account
   * disabled at the organization level (populated by the entitlement probe in
   * PR2). Renders as "DISABLED (org)" and OUTRANKS `in_service` retirement.
   * Absent / false on a pre-PR2 broker (treat as not-blocked).
   */
  entitlement_blocked?: boolean;
  exhausted_until?: number;
  /**
   * 429 throttle tier — unix ms until which the account is transiently
   * rate-limited (recorded by `mark-throttled`). Informational only: it never
   * gates serving or failover eligibility. Cron quota-preflight soft-defers a
   * fire while the agent's effective account carries a future value here.
   * Absent on pre-throttle-tier brokers.
   */
  throttled_until?: number;
  threshold_violations?: number;
  last_refreshed_at?: number;
  /**
   * Most recent utilization snapshot from a probeQuota call.
   * Absent or null when the broker has not probed this account since its last
   * start. Consumers (quota-watch loop) use this for health classification
   * without triggering a live network call.
   */
  last_quota?: LastQuotaSnapshot | null;
  /**
   * #3176 — flagship-tier (`7d_oi` / `seven_day_overage_included`) wall. TRUE
   * when the account is walled on the premium tier right now (an unexpired
   * `premium_walled_until` mark not contradicted by a fresher tier-allowed
   * canary). Tier-scoped: the account still serves opus/haiku. Absent on
   * pre-#3176 brokers (treat as false).
   */
  premium_walled?: boolean;
  /** #3176 — raw ledger mark: unix ms until which the flagship tier is walled. */
  premium_walled_until?: number;
  /** #3176 — the binding bucket claim (seven_day_overage_included). */
  premium_wall_bucket?: string;
  /** #3176 — latest flagship-tier canary snapshot, for the dashboard/card. */
  last_tier_quota?: LastTierQuotaSnapshot | null;
  /**
   * #3185 — rolling per-tier usage summary (standard 5h/7d + premium `7d_oi`),
   * refill-normalized by the broker. Answers "how much Fable/standard headroom
   * is left, and the recent trend". Absent on pre-#3185 brokers.
   */
  usage_ledger?: UsageAccountSummary | null;
}

/**
 * #3176 — the flagship-tier (`7d_oi`) canary snapshot exposed via `list-state`.
 * Separate from {@link LastQuotaSnapshot} (the haiku probe's 5h/7d windows).
 */
export interface LastTierQuotaSnapshot {
  unifiedStatus: string | null;
  sevenDayOiStatus: string | null;
  sevenDayOiUtilizationPct: number | null;
  /** ISO 8601 string, or null. */
  sevenDayOiResetAt: string | null;
  capturedAt: number;
}

/**
 * #3185 — rolling per-tier usage summary attached to each `AccountState`. The
 * broker computes it (refill-normalized) from its durable usage ledger, so the
 * dashboard / `switchroom auth usage` can answer "how much Fable is left" with
 * no live probe. Re-exported from the ledger module's summary type so the wire
 * shape has a single source of truth. Absent on pre-#3185 brokers.
 */
export type { UsageAccountSummary, UsageTierSummary } from "./usage-ledger.js";
import type { UsageAccountSummary } from "./usage-ledger.js";

export interface AgentState {
  name: string;
  account: string;
  override: string | null;
  /** Hard pin: the broker never serves this agent from another account.
   *  Absent on pre-flag brokers — treat undefined as false. */
  strict?: boolean;
  /** Owner-locked: the pinned account is never served to anyone else.
   *  Absent on pre-flag brokers — treat undefined as false. */
  exclusive?: boolean;
}

export interface ConsumerState {
  name: string;
  account: string;
  last_seen_at: number | null;
}

export interface ListStateData {
  /**
   * The CONFIGURED fleet pin (`auth.active`). Not necessarily what serves —
   * see `serving`. Use this only when you mean "what is pinned".
   */
  active: string;
  /**
   * The account the fleet is ACTUALLY served from right now
   * (`accountWithFailover(auth.active)` broker-side). Diverges from `active`
   * whenever the pin has been rolled off without a durable promote — the
   * soft-avoid proactive roll (#3031 PR 2) and the exhaustion-blind fanout
   * guard both do exactly that. Every "which account is live" renderer must
   * read this, not `active`, or it names an account that stopped serving.
   * Absent on pre-`serving` brokers — callers fall back to `active`
   * (`effectiveServingLabel`).
   */
  serving?: string;
  fallback_order: string[];
  accounts: AccountState[];
  agents: AgentState[];
  consumers: ConsumerState[];
  /**
   * Whether the account THIS caller is bound to may currently be served past the
   * weekly utilization wall on Anthropic overage billing — the broker's single
   * audited spend-authorization signal. The in-agent wedge-watchdog reads it
   * (never config) before a `/rate-limit-options` menu may select "usage
   * credits". Absent on pre-overage brokers (treat as false). Default-off:
   * false whenever `auth.allow_overage_accounts` is empty/unset.
   */
  active_overage_serving?: boolean;
  /**
   * Most recent BROKER-INITIATED proactive fleet roll (fleetQuotaProbeTick
   * failover), so gateways can announce the switch to the operator (#3031
   * PR 3). Absent/null on pre-roll brokers or until the first proactive
   * roll. Reactive gateway-triggered rolls are NOT recorded here — the
   * triggering gateway announces those itself.
   */
  last_fleet_roll?: {
    from: string;
    to: string;
    at: number;
    exhausted_until?: number;
    window?: "5h" | "7d";
    pct?: number;
    /**
     * Trigger attribution (#3031 PR 2): "hard-exhaustion" = the probe saw a
     * genuine quota wall; "soft-avoid" = a proactive serving-preference roll
     * off an account approaching its limits (no mark, no promote). Absent on
     * pre-PR-2 brokers (render as hard exhaustion).
     */
    reason?: "soft-avoid" | "hard-exhaustion" | "model-tier-wall";
    /** #3176 — the binding tier bucket, set only when reason is model-tier-wall. */
    bucket?: string;
  } | null;
  /**
   * #3176 — fleet-wide flagship-tier all-walled alert. Set when EVERY account
   * is walled on the `7d_oi` bucket with no premium-eligible failover target,
   * so the gateway can surface an operator card naming the bucket and the
   * earliest recovery. Null/absent whenever at least one account can serve the
   * flagship tier.
   */
  premium_tier_all_walled?: {
    bucket: string | null;
    earliest_reset?: number;
    at: number;
  } | null;
}

/**
 * The account the fleet is actually served from, for any renderer that wants
 * to say "this one is live". Prefers the broker's `serving` field and falls
 * back to the configured pin (`active`) — so a pre-`serving` broker degrades
 * to the old behaviour instead of rendering nothing as active.
 *
 * Never inline `state.active` for an "(active)" marker: the pin and the
 * serving account diverge on every soft-avoid roll.
 */
export function effectiveServingLabel(
  state: Pick<ListStateData, "active" | "serving">,
): string {
  const serving = state.serving;
  return typeof serving === "string" && serving.length > 0 ? serving : state.active;
}

export interface SetActiveData {
  active: string;
  fanned: string[];
}

/**
 * Per-account probe result returned by `probe-quota`. The broker
 * runs each probe server-side and returns the parsed
 * rate-limit-utilization headers. `result` is a `QuotaResult`
 * (same shape `fetchQuota` returns), so the format layer is shared
 * with the direct-probe path.
 */
export interface ProbeQuotaEntry {
  label: string;
  result:
    | {
        ok: true;
        data: {
          fiveHourUtilizationPct: number;
          sevenDayUtilizationPct: number;
          fiveHourResetAt: Date | null;
          sevenDayResetAt: Date | null;
          representativeClaim: string | null;
          overageStatus: string | null;
          overageDisabledReason: string | null;
          // #2494 Bug C — header-presence markers (see LastQuotaSnapshot).
          fiveHourUtilPresent?: boolean;
          sevenDayUtilPresent?: boolean;
        };
      }
    | { ok: false; reason: string };
  /**
   * #2495 Change 2 — how this result was sourced. `"live"` = a fresh upstream
   * probe; `"cache"` = served from the durable cache (TTL-hit or probe-failure
   * fallback). Absent on legacy responses. When `"cache"`, `capturedAt` carries
   * the snapshot age so the card can stamp "⚠ cached Nm ago" instead of a false
   * live stamp.
   */
  served?: "live" | "cache";
  /** Unix ms the served snapshot was captured (set when `served === "cache"`). */
  capturedAt?: number;
}

export interface GetExternalSpendData {
  available: boolean;
  day24hUsd?: number;
  day7dUsd?: number;
  top?: Array<{ label: string; usd: number }>;
  capturedAtMs?: number;
  served?: "live" | "cache";
  reason?: string;
}

export interface ProbeQuotaData {
  results: ProbeQuotaEntry[];
}

export interface MarkExhaustedData {
  account: string;
  rolled: string[];
  /** The account the fleet rolled TO (next non-exhausted in fallback_order),
   *  or null when every fallback is also exhausted. Added so a non-admin
   *  caller can announce an accurate swap target without an admin set-active.
   *  Always null for a strict-pinned caller (see `caller_pinned_strict`). */
  rolledTo?: string | null;
  /** True when the CALLER is an agent with a strict pin (`auth.strict`): its
   *  mirror kept the pin, so a null `rolledTo` means "you ride out the wall;
   *  fleet unaffected" — NOT fleet-wide all-blocked. Absent on pre-flag
   *  brokers. */
  caller_pinned_strict?: boolean;
}

export interface MarkThrottledData {
  account: string;
  /** The recorded (server-clamped) throttle expiry, unix ms. */
  throttled_until: number;
  /** True when the escalation guard fired: repeated transient 429s were
   *  corroborated by a live probe as a genuine wall, so the broker marked
   *  the account exhausted and rolled the fleet. */
  escalated: boolean;
  /** Set only when `escalated` — the roll target (null = all blocked, unless
   *  `caller_pinned_strict` is true: then the caller simply didn't roll). */
  rolledTo?: string | null;
  /** True when the CALLER is an agent with a strict pin — see
   *  `MarkExhaustedData.caller_pinned_strict`. Absent on pre-flag brokers. */
  caller_pinned_strict?: boolean;
}

export interface RefreshAccountData {
  account: string;
  expiresAt?: number;
}

export interface ClaimNotificationData {
  /** True for the first claimant of the key inside the window. */
  granted: boolean;
}

export interface AddAccountData {
  label: string;
  expiresAt?: number;
}

export interface RmAccountData {
  label: string;
}

export interface SetOverrideData {
  agent: string;
  account: string | null;
}

/** Per-account inventory entry returned by `listGoogleAccounts()`. */
export interface GoogleAccountState {
  account: string;
  expiresAt: number;
  scope: string;
  clientId: string;
}

export interface ListGoogleAccountsData {
  accounts: GoogleAccountState[];
}

/** Per-account inventory entry returned by `listMicrosoftAccounts()`. */
export interface MicrosoftAccountState {
  account: string;
  expiresAt: number;
  scope: string;
  clientId: string;
  accountType: "personal" | "work";
}

export interface ListMicrosoftAccountsData {
  accounts: MicrosoftAccountState[];
}

/** Anthropic-shaped credentials payload for `addAccount`. */
export interface AnthropicAddAccountCredentials {
  claudeAiOauth: {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
    scopes?: string[];
    subscriptionType?: string;
    rateLimitTier?: string;
  };
}

/**
 * Google-shaped credentials payload for `addAccount`. Phase 3b.2a
 * shipped the protocol-side schema (`GoogleCredentialsSchema`); this
 * is the client-side TS type. Phase 3b.3 callers (CLI verbs) construct
 * this from a Google OAuth token-exchange response.
 */
export interface GoogleAddAccountCredentials {
  googleOauth: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    scope: string;
    clientId: string;
    accountEmail: string;
    tokenType: "Bearer";
  };
}

/**
 * Microsoft-shaped credentials payload for `addAccount`. RFC #1873 PR 2
 * — client-side TS type matching protocol's `MicrosoftCredentialsSchema`.
 * Richer than Google's shape: persists tenant + account-type discriminators.
 */
export interface MicrosoftAddAccountCredentials {
  microsoftOauth: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    scope: string;
    clientId: string;
    accountEmail: string;
    tokenType: "Bearer";
    tenantId: string;
    accountType: "personal" | "work";
    homeAccountId: string;
  };
}

/** Discriminated union of credentials shapes for `addAccount`. */
export type AddAccountCredentials =
  | AnthropicAddAccountCredentials
  | GoogleAddAccountCredentials
  | MicrosoftAddAccountCredentials;

// ─── Client ───────────────────────────────────────────────────────────────

interface Pending {
  resolve(resp: Response): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

/**
 * Multiplexed auth-broker client. One persistent UDS connection;
 * requests correlated by `id`. Safe to share across concurrent
 * callers — writes are serialised by the underlying socket.
 */
export class AuthBrokerClient {
  private readonly socketPath: string;
  private readonly timeoutMs: number;
  private socket: net.Socket | null = null;
  private connecting: Promise<net.Socket> | null = null;
  private buffer = "";
  private readonly pending = new Map<string, Pending>();
  private closed = false;

  constructor(opts: AuthBrokerClientOpts = {}) {
    this.socketPath = resolveAuthBrokerSocketPath(opts);
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Resolved socket path — exposed for diagnostics and tests. */
  getSocketPath(): string {
    return this.socketPath;
  }

  async close(): Promise<void> {
    this.closed = true;
    const sock = this.socket;
    this.socket = null;
    this.connecting = null;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("auth-broker client closed"));
    }
    this.pending.clear();
    if (sock) {
      sock.destroy();
    }
  }

  // ─── Verb methods ────────────────────────────────────────────────────

  async getCredentials(
    provider?: ProviderName,
    account?: string,
  ): Promise<GetCredentialsData> {
    const base = {
      v: PROTOCOL_VERSION,
      id: randomUUID(),
      op: "get-credentials" as const,
    };
    let req: Request = base as Request;
    if (provider !== undefined) req = { ...req, provider } as Request;
    if (account !== undefined) req = { ...req, account } as Request;
    const data = await this.send(req);
    return data as GetCredentialsData;
  }

  async listState(): Promise<ListStateData> {
    const data = await this.send({
      v: PROTOCOL_VERSION,
      id: randomUUID(),
      op: "list-state",
    });
    return data as ListStateData;
  }

  async listGoogleAccounts(): Promise<ListGoogleAccountsData> {
    const data = await this.send({
      v: PROTOCOL_VERSION,
      id: randomUUID(),
      op: "list-google-accounts",
    });
    return data as ListGoogleAccountsData;
  }

  async listMicrosoftAccounts(): Promise<ListMicrosoftAccountsData> {
    const data = await this.send({
      v: PROTOCOL_VERSION,
      id: randomUUID(),
      op: "list-microsoft-accounts",
    });
    return data as ListMicrosoftAccountsData;
  }

  /**
   * Probe live Anthropic quota for a set of accounts. The broker
   * does the network call server-side using its stored credentials,
   * so accessTokens never reach the caller. Returns one result per
   * input label (order preserved).
   */
  async probeQuota(
    accounts: readonly string[],
    timeoutMs?: number,
    forceLive?: boolean,
  ): Promise<ProbeQuotaData> {
    const data = await this.send({
      v: PROTOCOL_VERSION,
      id: randomUUID(),
      op: "probe-quota",
      accounts: [...accounts],
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(forceLive ? { forceLive: true } : {}),
    });
    // JSON.parse does not revive Date. The broker serialises
    // fiveHourResetAt/sevenDayResetAt as Date → ISO string on the wire,
    // so the typed `Date | null` is a lie until we revive here. Without
    // this, every `.getTime()` in the format layer (auth-snapshot-format,
    // /auth show) throws "target.getTime is not a function".
    const parsed = data as ProbeQuotaData;
    for (const entry of parsed.results) {
      if (entry.result.ok) {
        entry.result.data.fiveHourResetAt = reviveDate(entry.result.data.fiveHourResetAt);
        entry.result.data.sevenDayResetAt = reviveDate(entry.result.data.sevenDayResetAt);
      }
    }
    return parsed;
  }


  /**
   * Fleet external (OpenRouter cash) spend summary for `/usage`.
   * Auth-broker owns the LiteLLM master key; agents never see it.
   */
  async getExternalSpend(forceLive?: boolean): Promise<GetExternalSpendData> {
    const data = await this.send({
      v: PROTOCOL_VERSION,
      id: randomUUID(),
      op: "get-external-spend",
      ...(forceLive ? { forceLive: true } : {}),
    });
    return data as GetExternalSpendData;
  }

  async setActive(account: string): Promise<SetActiveData> {
    const data = await this.send({
      v: PROTOCOL_VERSION,
      id: randomUUID(),
      op: "set-active",
      account,
    });
    return data as SetActiveData;
  }

  async markExhausted(until?: number): Promise<MarkExhaustedData> {
    const req: Request = until !== undefined
      ? { v: PROTOCOL_VERSION, id: randomUUID(), op: "mark-exhausted", until }
      : { v: PROTOCOL_VERSION, id: randomUUID(), op: "mark-exhausted" };
    const data = await this.send(req);
    return data as MarkExhaustedData;
  }

  /**
   * 429 throttle tier — record a transient per-account rate limit on the
   * caller's bound account (`throttled_until` in the quota ledger). Never
   * rolls the fleet and never blocks eligibility; the broker's escalation
   * guard may corroborate a hit into a real mark-exhausted (see
   * `MarkThrottledData.escalated`). Non-admin, same posture as
   * `markExhausted`.
   *
   * `probeOnly` (#failover-429-corroborate, generic-transient origin): run ONLY
   * the rate-bounded escalation probe — a corroborated wall still escalates
   * (mark-exhausted + roll), but a healthy probe records NOTHING (no
   * `throttled_until`, no hit, no soft-defer), keeping the account inert.
   */
  async markThrottled(until: number, probeOnly = false): Promise<MarkThrottledData> {
    const data = await this.send({
      v: PROTOCOL_VERSION,
      id: randomUUID(),
      op: "mark-throttled",
      until,
      ...(probeOnly ? { probeOnly: true } : {}),
    });
    return data as MarkThrottledData;
  }

  /**
   * Fleet notification-dedup claim. Returns `granted: true` only for
   * the first caller of `key` within `windowMs` — the winner sends the
   * notification, everyone else stays silent. Callers should FAIL OPEN
   * on error (send anyway): a broker that predates this op rejects the
   * request at the protocol layer, and duplicated notifications beat
   * silently dropped ones during a skewed rollout.
   */
  async claimNotification(key: string, windowMs: number): Promise<ClaimNotificationData> {
    const data = await this.send({
      v: PROTOCOL_VERSION,
      id: randomUUID(),
      op: "claim-notification",
      key,
      windowMs,
    });
    return data as ClaimNotificationData;
  }

  async refreshAccount(account: string): Promise<RefreshAccountData> {
    const data = await this.send({
      v: PROTOCOL_VERSION,
      id: randomUUID(),
      op: "refresh-account",
      account,
    });
    return data as RefreshAccountData;
  }

  async addAccount(
    label: string,
    credentials: AddAccountCredentials,
    replace?: boolean,
    provider?: ProviderName,
  ): Promise<AddAccountData> {
    // Build the request inline — Request is a discriminated union and
    // the conditional `replace` field plus optional `provider` field
    // need to be attached in a way that satisfies the schema.
    const base = {
      v: PROTOCOL_VERSION,
      id: randomUUID(),
      op: "add-account" as const,
      label,
      credentials,
    };
    const withReplace = replace ? { ...base, replace: true } : base;
    const req: Request = (provider !== undefined
      ? { ...withReplace, provider }
      : withReplace) as Request;
    const data = await this.send(req);
    return data as AddAccountData;
  }

  async rmAccount(
    label: string,
    provider?: ProviderName,
  ): Promise<RmAccountData> {
    const base = {
      v: PROTOCOL_VERSION,
      id: randomUUID(),
      op: "rm-account" as const,
      label,
    };
    const req: Request = (provider !== undefined
      ? { ...base, provider }
      : base) as Request;
    const data = await this.send(req);
    return data as RmAccountData;
  }

  async setOverride(
    agent: string,
    account: string | null,
  ): Promise<SetOverrideData> {
    const data = await this.send({
      v: PROTOCOL_VERSION,
      id: randomUUID(),
      op: "set-override",
      agent,
      account,
    });
    return data as SetOverrideData;
  }

  // ─── Connection management ───────────────────────────────────────────

  private async ensureConnected(): Promise<net.Socket> {
    if (this.closed) {
      throw new Error("auth-broker client is closed");
    }
    if (this.socket && !this.socket.destroyed) return this.socket;
    if (this.connecting) return this.connecting;

    this.connecting = new Promise<net.Socket>((resolve, reject) => {
      const sock = new net.Socket();
      const onError = (err: NodeJS.ErrnoException) => {
        sock.removeAllListeners();
        sock.destroy();
        const code = err.code ?? "ERR";
        let reason: string;
        if (code === "ENOENT") reason = "socket file not found";
        else if (code === "ECONNREFUSED") reason = "connection refused";
        else if (code === "EACCES") reason = "access denied";
        else reason = err.message;
        reject(new AuthBrokerUnreachableError(reason, this.socketPath));
      };
      sock.once("error", onError);
      sock.once("connect", () => {
        sock.removeListener("error", onError);
        sock.on("data", (chunk: Buffer) => this.onData(chunk));
        sock.on("error", (err: Error) => this.onSocketError(err));
        sock.on("close", () => this.onSocketClose());
        this.socket = sock;
        resolve(sock);
      });
      sock.connect({ path: this.socketPath });
    });

    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.length === 0) continue;
      let resp: Response;
      try {
        resp = decodeResponse(line);
      } catch (err) {
        // Unparseable frame — surface to any pending request as a hard
        // failure so the caller doesn't hang. Without an `id` we have
        // no way to correlate, so fail every in-flight request.
        const msg = `unparseable auth-broker response: ${err instanceof Error ? err.message : String(err)}`;
        this.failAll(new AuthBrokerUnreachableError(msg, this.socketPath));
        return;
      }
      const p = this.pending.get(resp.id);
      if (!p) {
        // Spurious frame (out-of-order id); ignore.
        continue;
      }
      this.pending.delete(resp.id);
      clearTimeout(p.timer);
      p.resolve(resp);
    }
  }

  private onSocketError(err: Error): void {
    // Surface to in-flight callers; further sends will reconnect.
    this.failAll(
      new AuthBrokerUnreachableError(err.message, this.socketPath),
    );
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }

  private onSocketClose(): void {
    // Connection dropped — pending requests fail; next send reconnects.
    if (this.pending.size > 0) {
      this.failAll(
        new AuthBrokerUnreachableError(
          "connection closed mid-request",
          this.socketPath,
        ),
      );
    }
    this.socket = null;
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private async send(req: Request): Promise<unknown> {
    const sock = await this.ensureConnected();
    const id = req.id;
    const frame = encodeRequest(req);
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new AuthBrokerUnreachableError(
            `request ${req.op} timed out after ${this.timeoutMs}ms`,
            this.socketPath,
          ),
        );
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: (resp: Response) => {
          if (resp.ok) {
            resolve(resp.data);
          } else {
            reject(new AuthBrokerError(resp.error.code, resp.error.message));
          }
        },
        reject,
        timer,
      });
      sock.write(frame, (err) => {
        if (err) {
          const p = this.pending.get(id);
          if (p) {
            clearTimeout(p.timer);
            this.pending.delete(id);
          }
          reject(
            new AuthBrokerUnreachableError(
              `failed to send ${req.op}: ${err.message}`,
              this.socketPath,
            ),
          );
        }
      });
    });
  }
}

/**
 * One-shot convenience: create a client, run `fn`, close it. Used by
 * CLI verbs that issue a single RPC and exit.
 */
export async function withAuthBrokerClient<T>(
  fn: (client: AuthBrokerClient) => Promise<T>,
  opts?: AuthBrokerClientOpts,
): Promise<T> {
  const client = new AuthBrokerClient(opts);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}
