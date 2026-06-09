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
import { existsSync } from "node:fs";
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
}

export interface AccountState {
  label: string;
  expiresAt?: number;
  exhausted: boolean;
  exhausted_until?: number;
  threshold_violations?: number;
  last_refreshed_at?: number;
  /**
   * Most recent utilization snapshot from a probeQuota call.
   * Absent or null when the broker has not probed this account since its last
   * start. Consumers (quota-watch loop) use this for health classification
   * without triggering a live network call.
   */
  last_quota?: LastQuotaSnapshot | null;
}

export interface AgentState {
  name: string;
  account: string;
  override: string | null;
}

export interface ConsumerState {
  name: string;
  account: string;
  last_seen_at: number | null;
}

export interface ListStateData {
  active: string;
  fallback_order: string[];
  accounts: AccountState[];
  agents: AgentState[];
  consumers: ConsumerState[];
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
        };
      }
    | { ok: false; reason: string };
}

export interface ProbeQuotaData {
  results: ProbeQuotaEntry[];
}

export interface MarkExhaustedData {
  account: string;
  rolled: string[];
  /** The account the fleet rolled TO (next non-exhausted in fallback_order),
   *  or null when every fallback is also exhausted. Added so a non-admin
   *  caller can announce an accurate swap target without an admin set-active. */
  rolledTo?: string | null;
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

  async getCredentials(provider?: ProviderName): Promise<GetCredentialsData> {
    const base = {
      v: PROTOCOL_VERSION,
      id: randomUUID(),
      op: "get-credentials" as const,
    };
    const req = (provider !== undefined ? { ...base, provider } : base) as Request;
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
  ): Promise<ProbeQuotaData> {
    const data = await this.send({
      v: PROTOCOL_VERSION,
      id: randomUUID(),
      op: "probe-quota",
      accounts: [...accounts],
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
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

/**
 * Probe whether the broker socket exists on disk — useful for the CLI
 * to give a clearer error message when the daemon isn't running at all
 * (vs a connect that times out for other reasons).
 */
export function authBrokerSocketExists(opts?: AuthBrokerClientOpts): boolean {
  return existsSync(resolveAuthBrokerSocketPath(opts));
}
