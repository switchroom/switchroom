/**
 * Provider abstraction for the auth-broker (RFC G Phase 3b.1).
 *
 * The broker as shipped by RFC H (#1254) is Anthropic-only — `server.ts`
 * has `claudeAiOauth.expiresAt` references baked throughout, the protocol
 * has Anthropic's credentials shape on `add-account`, and account state
 * is keyed on label alone.
 *
 * RFC G Phase 3b plugs Google in as a second provider, sharing the
 * broker's flock-protected refresh leases, sha-index drift detection,
 * and audit log machinery. To keep two providers from colliding (account
 * `"x@y.z"` could be a Google account AND an Anthropic account label —
 * unrelated identities), all per-account state is keyed on
 * `(provider, account)`.
 *
 * **Phase 3b.1a (this file)** defines the contract Phase 3b.2 implements
 * and Phase 3b.1b's server refactor dispatches through. The server is
 * still Anthropic-only at this point; the wiring lands in 3b.1b.
 *
 * **Provider responsibilities:**
 *   1. Refresh exchange — turn a refresh token into a fresh access token
 *      + new refresh token + new expiry. Provider knows its OAuth
 *      endpoint, request shape, and error codes.
 *   2. Credential format — define the per-provider on-disk shape
 *      (Anthropic = `claudeAiOauth: { ... }`, Google = `googleOauth: { ... }`).
 *      The broker stores credentials verbatim per provider format.
 *   3. Expiry extraction — given credentials, return the expiry timestamp
 *      so the broker's threshold-based refresh tick works uniformly.
 *   4. Error mapping — provider-specific OAuth error codes → broker's
 *      generic `RefreshError` discriminant. Lets downstream UX (3b.4
 *      MCP wrapper, 3b.3 CLI) drive the right user message regardless
 *      of provider.
 *
 * **What providers DON'T own:**
 *   - On-disk storage (broker writes / reads credentials.json mirrors)
 *   - Refresh leases (broker holds the flock per (provider, account))
 *   - Drift detection (broker compares sha-index per provider)
 *   - ACL (broker enforces path-as-identity; for Google, also routes
 *     through `google_accounts.<acct>.enabled_for[]` — but that's a
 *     server-side ACL check, not a provider concern)
 */

// ────────────────────────────────────────────────────────────────────────
// Provider identity
// ────────────────────────────────────────────────────────────────────────

/**
 * The literal-union of provider names. `"anthropic"` is the default
 * (RFC H's shipped behavior); `"google"` is added by Phase 3b.2.
 *
 * Adding a new provider is a deliberate enum extension — operators
 * can't accidentally type a wrong provider name. Future Notion / Slack
 * providers extend this.
 *
 * Re-exported from `protocol.ts` so the wire-validation enum and the
 * TS-side type are guaranteed identical (single source of truth, no
 * drift risk from defining the union in two places).
 */
export type { ProviderName } from "./protocol.js";
import type { ProviderName } from "./protocol.js";

/**
 * Composite key for per-account state. Two accounts with the same label
 * under different providers are independent identities; the broker keys
 * its in-memory state (`lastWrittenExpiresAt`, refresh leases, drift
 * indices) on this composite, not on label alone.
 */
export interface AccountKey {
  provider: ProviderName;
  /** Account label / identifier within the provider's namespace. */
  account: string;
}

/**
 * Stable string form of an AccountKey for use as a Map key. Format:
 * `<provider>:<account>`. Used everywhere the broker needs a Map keyed
 * on (provider, account).
 *
 * Account labels are validated at the schema layer to not contain `:`
 * (RFC G Phase 2 enforced this for Google emails specifically; Phase
 * 3b.1b will extend the same constraint to Anthropic labels). So this
 * encoding is unambiguous.
 */
export function accountKeyString(key: AccountKey): string {
  return `${key.provider}:${key.account}`;
}

// ────────────────────────────────────────────────────────────────────────
// Refresh exchange
// ────────────────────────────────────────────────────────────────────────

/**
 * Input to a refresh exchange. The broker passes the durable refresh
 * token plus any provider-specific config (OAuth client id, scopes).
 *
 * `refreshToken` is the only field every provider needs. `clientId` /
 * `scopes` are optional — Anthropic's refresh doesn't require them
 * (the OAuth client identity is baked into the token); Google's
 * does.
 */
export interface RefreshRequest {
  refreshToken: string;
  /**
   * Account identity within the provider's namespace. For Google
   * this is the account email (e.g. "alice@example.com"); the
   * provider stores it back into rawCredentials so consumers can
   * route per-account. Phase 3b.2a temporarily smuggled this through
   * `clientId`; Phase 3b.2b promotes it to a first-class field.
   * Anthropic ignores this (uses the broker-side label directly).
   */
  accountEmail?: string;
  /** OAuth client id, when the provider needs it. */
  clientId?: string;
  /** Scope set to request, when the provider re-asserts scopes per refresh. */
  scopes?: string[];
  /**
   * Prior on-disk credentials, if any. Microsoft uses this to preserve
   * canonical identity fields (tenantId, accountType, homeAccountId)
   * across refreshes — Microsoft's v2 endpoint may omit `id_token` on
   * refresh responses under certain scope/account combinations, and
   * without prior creds the provider would clobber canonical values
   * with empty placeholders. Google + Anthropic ignore this field
   * (their credential shape doesn't carry identity claims that the
   * refresh response could fail to return).
   */
  priorCredentials?: unknown;
}

/**
 * Output of a successful refresh exchange. Every provider returns at
 * least an access token + expiry; some return a rotated refresh token.
 *
 * `rawCredentials` is the provider-shaped credentials object the broker
 * writes verbatim to the per-agent mirror. Anthropic returns
 * `{ claudeAiOauth: { ... } }`; Google returns `{ googleOauth: { ... } }`.
 * Broker doesn't introspect this — it's pass-through to consumers.
 */
export interface RefreshSuccess {
  ok: true;
  accessToken: string;
  /** Unix-ms when the access token expires. */
  expiresAt: number;
  /** Provider may rotate the refresh token; if absent, broker keeps the old one. */
  newRefreshToken?: string;
  /** Provider-shaped credentials object the broker stores verbatim. */
  rawCredentials: unknown;
}

/**
 * Discriminant for refresh failures. The broker maps these to its
 * `REFRESH_FAILED` protocol error code; downstream UX (CLI, MCP wrapper)
 * branches on `kind` to drive the right operator-actionable message.
 *
 *   - `invalid_grant` — refresh token revoked / rotated / expired.
 *     Anthropic: rare. Google: happens on password change, app
 *     revocation, or 7-day expiry under unverified-OAuth-client.
 *     Operator action: re-OAuth.
 *   - `network` — transient network failure. Operator action: wait.
 *   - `quota_exceeded` — Anthropic 5h cap or Google quota. Operator
 *     action: wait + maybe failover.
 *   - `provider_error` — anything else. Operator action: read the
 *     provider's error message in `detail`.
 */
export type RefreshErrorKind =
  | "invalid_grant"
  | "network"
  | "quota_exceeded"
  | "provider_error";

export interface RefreshFailure {
  ok: false;
  kind: RefreshErrorKind;
  /** Human-readable detail from the provider's error response. */
  detail: string;
}

export type RefreshResult = RefreshSuccess | RefreshFailure;

// ────────────────────────────────────────────────────────────────────────
// Provider interface — what every provider must implement
// ────────────────────────────────────────────────────────────────────────

export interface Provider {
  /**
   * Provider name — must match the `name` used in protocol `provider:`
   * fields and in operator-facing CLI verbs (`switchroom auth google ...`
   * has provider name `"google"`).
   */
  readonly name: ProviderName;

  /**
   * Exchange a refresh token for new access credentials. Provider owns
   * the HTTP request, error mapping, and result shape.
   */
  refresh(req: RefreshRequest): Promise<RefreshResult>;

  /**
   * Extract the expiry timestamp from a provider-shaped credentials
   * object. Used by the broker's threshold-based refresh tick to decide
   * "is this credential about to expire and need pre-emptive refresh?"
   *
   * Returns `undefined` when the credentials are missing the expiry
   * field — broker treats undefined as "needs immediate refresh"
   * (caller-of-broker probably has a stale shape).
   */
  extractExpiresAt(credentials: unknown): number | undefined;

  /**
   * Validate a credentials object has the expected shape for this
   * provider. Called when an operator runs `auth <provider> account
   * add` — broker rejects malformed credentials before storing.
   * Returns null on success; a human-readable error on failure.
   */
  validateCredentialShape(credentials: unknown): string | null;
}

// ────────────────────────────────────────────────────────────────────────
// Provider registry — how the broker discovers loaded providers
// ────────────────────────────────────────────────────────────────────────

/**
 * Registry of providers the broker knows about. Phase 3b.1b refactors
 * `server.ts` to instantiate this at startup, register the Anthropic
 * provider (extracted from current server logic), and dispatch
 * provider-shaped operations through `lookup()`.
 *
 * Phase 3b.2 adds the Google provider via `register()`.
 *
 * This registry intentionally has no plugin-discovery mechanism —
 * providers are compiled-in. Avoiding dynamic plugin loading keeps the
 * broker's trust boundary tight (per RFC H §3): no third-party code
 * runs in the broker process.
 */
export class ProviderRegistry {
  private readonly providers = new Map<ProviderName, Provider>();

  register(provider: Provider): void {
    if (this.providers.has(provider.name)) {
      throw new Error(
        `provider '${provider.name}' is already registered — registry is single-instance per name`,
      );
    }
    this.providers.set(provider.name, provider);
  }

  lookup(name: ProviderName): Provider {
    const p = this.providers.get(name);
    if (!p) {
      throw new Error(
        `provider '${name}' is not registered with the auth-broker`,
      );
    }
    return p;
  }

  /**
   * Whether the broker knows about this provider. Used by the protocol
   * dispatcher to validate `provider:` field values before routing.
   */
  has(name: ProviderName): boolean {
    return this.providers.has(name);
  }

  /**
   * List of registered provider names. Used by `list-state` to surface
   * the broker's known providers + by tests.
   */
  names(): ProviderName[] {
    return [...this.providers.keys()];
  }
}
