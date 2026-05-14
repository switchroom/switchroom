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
  type Request,
  type Response,
} from "./protocol.js";

const DEFAULT_TIMEOUT_MS = 5000;

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

export interface AccountState {
  label: string;
  expiresAt?: number;
  exhausted: boolean;
  exhausted_until?: number;
  threshold_violations?: number;
  last_refreshed_at?: number;
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

export interface MarkExhaustedData {
  account: string;
  rolled: string[];
}

export interface RefreshAccountData {
  account: string;
  expiresAt?: number;
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

/** Credentials payload for `addAccount`. */
export interface AddAccountCredentials {
  claudeAiOauth: {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
    scopes?: string[];
    subscriptionType?: string;
    rateLimitTier?: string;
  };
}

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

  async getCredentials(): Promise<GetCredentialsData> {
    const data = await this.send({
      v: PROTOCOL_VERSION,
      id: randomUUID(),
      op: "get-credentials",
    });
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
  ): Promise<AddAccountData> {
    const req: Request = replace
      ? {
          v: PROTOCOL_VERSION,
          id: randomUUID(),
          op: "add-account",
          label,
          credentials,
          replace: true,
        }
      : {
          v: PROTOCOL_VERSION,
          id: randomUUID(),
          op: "add-account",
          label,
          credentials,
        };
    const data = await this.send(req);
    return data as AddAccountData;
  }

  async rmAccount(label: string): Promise<RmAccountData> {
    const data = await this.send({
      v: PROTOCOL_VERSION,
      id: randomUUID(),
      op: "rm-account",
      label,
    });
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
