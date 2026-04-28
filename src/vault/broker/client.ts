/**
 * vault-broker client library.
 *
 * Used by the CLI and resolver to communicate with a running broker daemon.
 * All functions return null (or { ok: false }) when the broker is unreachable
 * (ENOENT / ECONNREFUSED / EACCES / timeout) — the caller decides whether
 * to fall through to legacy passphrase-based vault access.
 *
 * Default socket path resolution order:
 *   1. env SWITCHROOM_VAULT_BROKER_SOCK
 *   2. config vault.broker.socket (if a config is provided)
 *   3. ~/.switchroom/vault-broker.sock
 *
 * Default timeout: 2000ms — kept tight because cron scripts block on this.
 *
 * Token resolution (issue #226):
 *   createBrokerClient(agentSlug?, opts?) reads ~/.switchroom/agents/<slug>/.vault-token
 *   at init time and includes the token in every get/list request. If the file
 *   is missing or unreadable, the client falls through to peercred ACL silently.
 *   If a token IS present but the broker rejects it with grant-expired or
 *   grant-revoked, the client writes a clear message to stderr and throws so
 *   the cron exits non-zero — silent fallback to peercred is intentionally
 *   NOT done in that case (an operator must mint a fresh grant).
 */

import * as net from "node:net";
import * as fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  encodeRequest,
  decodeResponse,
  type BrokerResponse,
  type BrokerStatus,
  type ErrorCode,
  type GrantMeta,
  type OkMintGrantResponse,
} from "./protocol.js";
import type { VaultEntry } from "../vault.js";

const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_SOCKET_PATH = join(homedir(), ".switchroom", "vault-broker.sock");

export interface BrokerClientOpts {
  /** Override socket path */
  socket?: string;
  /** Timeout in ms (default: 2000) */
  timeoutMs?: number;
  /** Loaded config for socket path resolution */
  vaultBrokerSocket?: string;
  /**
   * Agent slug used for token-file discovery.
   * When provided, createBrokerClient reads
   * ~/.switchroom/agents/<agentSlug>/.vault-token at init time.
   * Ignored when constructing opts inline (use createBrokerClient instead).
   */
  agentSlug?: string;
}

// ─── Token-file helpers ────────────────────────────────────────────────────────

/**
 * Compute the path to the agent's capability token file.
 * Public so tests can locate the file without duplicating the path formula.
 */
export function vaultTokenFilePath(agentSlug: string): string {
  return join(homedir(), ".switchroom", "agents", agentSlug, ".vault-token");
}

/**
 * Attempt to read the agent's vault token from disk.
 *
 * Returns the trimmed first line of the file on success, or null when:
 *   - ENOENT: file does not exist (no grant minted yet) — silent fall-through.
 *   - EACCES: file is unreadable — logs a warning to stderr, falls through.
 *   - Any other error: logs a warning to stderr, falls through.
 *
 * NEVER logs the token bytes themselves.
 */
export function readVaultTokenFile(agentSlug: string): string | null {
  const filePath = vaultTokenFilePath(agentSlug);
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const token = raw.split("\n")[0].trim();
    return token.length > 0 ? token : null;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      // Normal: no grant has been minted for this agent yet.
      return null;
    }
    // EACCES or anything else — warn and fall through to peercred.
    const reason = code === "EACCES"
      ? "permission denied"
      : (err instanceof Error ? err.message : String(err));
    process.stderr.write(
      `[vault-broker] Warning: could not read token file ${filePath}: ${reason}. ` +
      `Falling through to peercred ACL.\n`,
    );
    return null;
  }
}

// ─── Stateful broker client (issue #226) ──────────────────────────────────────

/**
 * Error thrown when a capability token is present but the broker rejects it
 * with grant-expired or grant-revoked. The cron must exit non-zero; silently
 * falling back to peercred would mask a security-relevant event.
 */
export class VaultTokenRejectedError extends Error {
  constructor(
    public readonly reason: "grant-expired" | "grant-revoked",
    msg: string,
  ) {
    super(msg);
    this.name = "VaultTokenRejectedError";
  }
}

/**
 * A stateful broker client that carries an optional capability token.
 * Obtained via `createBrokerClient()`.
 *
 * get() and list() include the token in the request payload when present.
 * If the broker rejects the token with grant-expired or grant-revoked,
 * they throw VaultTokenRejectedError (the caller / cron should exit non-zero).
 */
export interface BrokerClient {
  /** True when a token was successfully read from disk at init time. */
  readonly hasToken: boolean;
  /** Structured get — same semantics as getViaBrokerStructured, plus token. */
  get(key: string): Promise<GetResult>;
  /** List all keys — same semantics as listViaBroker, plus token. */
  list(): Promise<string[] | null>;
}

/**
 * Create a broker client.
 *
 * If agentSlug is provided (or opts.agentSlug is set), attempts to read
 * ~/.switchroom/agents/<agentSlug>/.vault-token. Falls through silently on
 * ENOENT; warns on EACCES or other read errors. The agent slug is also
 * discoverable via the SWITCHROOM_AGENT_NAME environment variable — callers
 * that don't have the slug at hand can pass process.env.SWITCHROOM_AGENT_NAME.
 *
 * @example
 *   const client = createBrokerClient(process.env.SWITCHROOM_AGENT_NAME);
 *   const result = await client.get("my-key");
 */
export function createBrokerClient(
  agentSlugOrOpts?: string | BrokerClientOpts,
  opts?: BrokerClientOpts,
): BrokerClient {
  let agentSlug: string | undefined;
  let baseOpts: BrokerClientOpts | undefined;

  if (typeof agentSlugOrOpts === "string") {
    agentSlug = agentSlugOrOpts || undefined;
    baseOpts = opts;
  } else {
    baseOpts = agentSlugOrOpts;
    agentSlug = baseOpts?.agentSlug;
  }

  // Read the token once at init time. Never store it in a closure that leaks
  // to logs — only included in wire requests.
  const token: string | null =
    agentSlug ? readVaultTokenFile(agentSlug) : null;

  // Centralised token-rejection check. When the client has a token AND
  // the broker rejects with grant-expired/grant-revoked, throw a hard
  // failure (no peercred fallback). Used by both `get()` and `list()` so
  // a future op can't silently lose the rejection signal — and so
  // tightening the broker's wire format (e.g. moving the reason to the
  // `code` enum) is a one-line change.
  function assertTokenAccepted(msg: string | undefined): void {
    if (token === null) return;
    const text = msg ?? "";
    let reason: "grant-expired" | "grant-revoked" | null = null;
    if (text.includes("grant-expired")) reason = "grant-expired";
    else if (text.includes("grant-revoked")) reason = "grant-revoked";
    if (reason === null) return;
    const err = new VaultTokenRejectedError(
      reason,
      `vault-broker rejected capability token: ${text}. ` +
      `Mint a new grant with: switchroom vault grant mint <agent> --key <key>`,
    );
    process.stderr.write(`[vault-broker] ERROR: ${err.message}\n`);
    throw err;
  }

  return {
    hasToken: token !== null,

    async get(key: string): Promise<GetResult> {
      const req: Parameters<typeof encodeRequest>[0] = token
        ? { v: 1, op: "get", key, token }
        : { v: 1, op: "get", key };
      const result = await rpc(req, baseOpts);
      if (result.kind === "unreachable") {
        return { kind: "unreachable", msg: result.msg };
      }
      const resp = result.resp;
      if (resp.ok && "entry" in resp) {
        return { kind: "ok", entry: resp.entry as VaultEntry };
      }
      if (!resp.ok) {
        // Hard-fail on token rejection BEFORE classifying as denied/not_found.
        assertTokenAccepted(resp.msg);
        if (resp.code === "UNKNOWN_KEY") {
          return { kind: "not_found", code: resp.code, msg: resp.msg };
        }
        return { kind: "denied", code: resp.code, msg: resp.msg };
      }
      return { kind: "unreachable", msg: "unexpected broker response shape" };
    },

    async list(): Promise<string[] | null> {
      const req: Parameters<typeof encodeRequest>[0] = token
        ? { v: 1, op: "list", token }
        : { v: 1, op: "list" };
      const result = await rpc(req, baseOpts);
      if (result.kind === "unreachable") return null;
      if (result.resp.ok && "keys" in result.resp) {
        return result.resp.keys as string[];
      }
      // #226 review-fix: hard-fail on token rejection here too — without
      // this, a `list()` call with a revoked token silently returned null
      // (caller would think the broker was unreachable, never know to mint
      // a new grant).
      if (!result.resp.ok) {
        assertTokenAccepted(result.resp.msg);
      }
      return null;
    },
  };
}

export interface UnlockResult {
  ok: boolean;
  msg?: string;
}

/**
 * Structured result from a broker `get` request.
 *
 * `kind` discriminator surfaces the four cases callers actually need to
 * distinguish, instead of collapsing all failures into `null` (issue #129).
 *
 *   - `ok`           — entry was returned; use `.entry`.
 *   - `unreachable`  — broker is not running, timed out, or refused the
 *                     connection. Caller may want to fall back to direct
 *                     vault decrypt with the user's passphrase.
 *   - `denied`       — broker rejected the caller (cron unit not in ACL,
 *                     allow_interactive disabled, vault locked, etc).
 *                     Falling back to direct decrypt is the right move
 *                     for the CLI; for cron scripts it's a config bug.
 *   - `not_found`    — broker is running and the caller is allowed, but
 *                     the key doesn't exist in the vault. Don't fall back.
 *
 * `code` is the wire error code from `protocol.ts` (LOCKED, DENIED,
 * UNKNOWN_KEY, BAD_REQUEST, INTERNAL) for `denied` and `not_found` cases.
 * `msg` is the broker's human-readable reason.
 */
export type GetResult =
  | { kind: "ok"; entry: VaultEntry }
  | { kind: "unreachable"; msg: string }
  | { kind: "denied"; code: ErrorCode; msg: string }
  | { kind: "not_found"; code: ErrorCode; msg: string };

/**
 * Resolve the data socket path from options.
 */
export function resolveBrokerSocketPath(opts?: BrokerClientOpts): string {
  if (opts?.socket) return opts.socket;
  const env = process.env.SWITCHROOM_VAULT_BROKER_SOCK;
  if (env) return env;
  if (opts?.vaultBrokerSocket) return opts.vaultBrokerSocket;
  return DEFAULT_SOCKET_PATH;
}

/**
 * Result of a single RPC: either a parsed broker response, or an
 * "unreachable" status with a human-readable reason. Internal helper
 * — public API on top distinguishes denied vs not-found vs unreachable.
 */
type RpcResult =
  | { kind: "response"; resp: BrokerResponse }
  | { kind: "unreachable"; msg: string };

/**
 * Send a single request to the broker and get a response.
 * Returns { kind: "unreachable", msg } on any connection / protocol failure.
 */
async function rpc(
  req: Parameters<typeof encodeRequest>[0],
  opts?: BrokerClientOpts,
): Promise<RpcResult> {
  const socketPath = resolveBrokerSocketPath(opts);
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<RpcResult>((resolve) => {
    let settled = false;
    const settle = (val: RpcResult): void => {
      if (settled) return;
      settled = true;
      resolve(val);
    };

    const timer = setTimeout(() => {
      client.destroy();
      settle({ kind: "unreachable", msg: `broker did not respond within ${timeoutMs}ms` });
    }, timeoutMs);

    const client = net.createConnection({ path: socketPath });

    client.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      const code = err.code ?? "ERR";
      let msg: string;
      if (code === "ENOENT") msg = "broker socket not found (is the daemon running?)";
      else if (code === "ECONNREFUSED") msg = "broker socket exists but refused connection";
      else if (code === "EACCES") msg = "broker socket access denied (wrong UID?)";
      else msg = `broker connection failed: ${err.message}`;
      settle({ kind: "unreachable", msg });
    });

    let buffer = "";
    client.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newlineIdx = buffer.indexOf("\n");
      if (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx).trimEnd();
        clearTimeout(timer);
        client.destroy();
        try {
          const resp = decodeResponse(line);
          settle({ kind: "response", resp });
        } catch (err) {
          settle({
            kind: "unreachable",
            msg: `unparseable broker response: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
    });

    client.on("connect", () => {
      try {
        client.write(encodeRequest(req));
      } catch (err) {
        clearTimeout(timer);
        client.destroy();
        settle({
          kind: "unreachable",
          msg: `failed to send request: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });
  });
}

/**
 * Get a vault entry via the broker.
 *
 * Returns a structured `GetResult` distinguishing the four cases callers
 * actually need to act on. See the `GetResult` type for semantics.
 *
 * For ergonomic callers that only care about success vs anything-else,
 * use `getEntryOrNull()` below — it preserves the old null-on-failure shape.
 */
export async function getViaBrokerStructured(
  key: string,
  opts?: BrokerClientOpts,
): Promise<GetResult> {
  const result = await rpc({ v: 1, op: "get", key }, opts);
  if (result.kind === "unreachable") {
    return { kind: "unreachable", msg: result.msg };
  }
  const resp = result.resp;
  if (resp.ok && "entry" in resp) {
    return { kind: "ok", entry: resp.entry as VaultEntry };
  }
  if (!resp.ok) {
    // UNKNOWN_KEY is "broker is healthy and willing, but the key isn't there"
    // — meaningfully different from DENIED for the CLI's UX. LOCKED, DENIED,
    // BAD_REQUEST, INTERNAL all roll up into "denied" from the caller's
    // perspective: the broker said no and it isn't a missing-key issue.
    if (resp.code === "UNKNOWN_KEY") {
      return { kind: "not_found", code: resp.code, msg: resp.msg };
    }
    return { kind: "denied", code: resp.code, msg: resp.msg };
  }
  return { kind: "unreachable", msg: "unexpected broker response shape" };
}

/**
 * Get a vault entry via the broker. Legacy shape: returns the entry on
 * success or `null` on any failure. Prefer `getViaBrokerStructured()` in
 * new code so the caller can tell unreachable from denied from not-found.
 */
export async function getViaBroker(
  key: string,
  opts?: BrokerClientOpts,
): Promise<VaultEntry | null> {
  const result = await getViaBrokerStructured(key, opts);
  return result.kind === "ok" ? result.entry : null;
}

/**
 * List all vault key names via the broker.
 * Returns null if broker is unreachable.
 */
export async function listViaBroker(
  opts?: BrokerClientOpts,
): Promise<string[] | null> {
  const result = await rpc({ v: 1, op: "list" }, opts);
  if (result.kind === "unreachable") return null;
  if (result.resp.ok && "keys" in result.resp) {
    return result.resp.keys as string[];
  }
  return null;
}

/**
 * Get broker status.
 * Returns null if broker is unreachable.
 */
export async function statusViaBroker(
  opts?: BrokerClientOpts,
): Promise<BrokerStatus | null> {
  const result = await rpc({ v: 1, op: "status" }, opts);
  if (result.kind === "unreachable") return null;
  if (result.resp.ok && "status" in result.resp) {
    return result.resp.status as BrokerStatus;
  }
  return null;
}

/**
 * Send the lock command to the broker.
 * Returns true on success, false if broker is unreachable.
 */
export async function lockViaBroker(opts?: BrokerClientOpts): Promise<boolean> {
  const result = await rpc({ v: 1, op: "lock" }, opts);
  if (result.kind === "unreachable") return false;
  return result.resp.ok;
}

/**
 * Send a passphrase to the unlock socket.
 * The passphrase goes to the UNLOCK socket, never the data socket.
 * Returns { ok: true } on success, { ok: false, msg } on failure.
 */
export async function unlockViaBroker(
  passphrase: string,
  opts?: BrokerClientOpts,
): Promise<UnlockResult> {
  const dataSocketPath = resolveBrokerSocketPath(opts);
  // Unlock socket is named <data-socket>.replace(/.sock$/, ".unlock.sock")
  const unlockSocketPath = dataSocketPath.replace(/\.sock$/, ".unlock.sock");
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<UnlockResult>((resolve) => {
    let settled = false;
    const settle = (val: UnlockResult): void => {
      if (settled) return;
      settled = true;
      resolve(val);
    };

    const timer = setTimeout(() => {
      client.destroy();
      settle({ ok: false, msg: "Timeout waiting for broker" });
    }, timeoutMs);

    const client = net.createConnection({ path: unlockSocketPath });

    client.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      settle({ ok: false, msg: `Broker unreachable: ${err.message}` });
    });

    let buffer = "";
    client.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newlineIdx = buffer.indexOf("\n");
      if (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx).trimEnd();
        clearTimeout(timer);
        client.destroy();
        if (line === "OK") {
          settle({ ok: true });
        } else if (line.startsWith("ERR ")) {
          settle({ ok: false, msg: line.slice(4) });
        } else {
          settle({ ok: false, msg: `Unexpected response: ${line}` });
        }
      }
    });

    client.on("connect", () => {
      // Send passphrase as a single line, then half-close so the broker
      // knows we're done sending.
      client.write(passphrase + "\n");
      client.end();
    });
  });
}

// ─── Grant management RPCs ─────────────────────────────────────────────────

export interface MintGrantOpts extends BrokerClientOpts {
  agent: string;
  keys: string[];
  ttl_seconds: number | null;
  description?: string;
}

export type MintGrantResult =
  | { kind: "ok"; token: string; id: string; expires_at: number | null }
  | { kind: "unreachable"; msg: string }
  | { kind: "error"; msg: string };

/**
 * Mint a new capability grant via the broker.
 */
export async function mintGrantViaBroker(
  opts: MintGrantOpts,
): Promise<MintGrantResult> {
  const result = await rpc(
    {
      v: 1,
      op: "mint_grant",
      agent: opts.agent,
      keys: opts.keys,
      ttl_seconds: opts.ttl_seconds,
      description: opts.description,
    },
    opts,
  );
  if (result.kind === "unreachable") return { kind: "unreachable", msg: result.msg };
  const resp = result.resp;
  if (resp.ok && "token" in resp) {
    return {
      kind: "ok",
      token: (resp as OkMintGrantResponse).token,
      id: (resp as OkMintGrantResponse).id,
      expires_at: (resp as OkMintGrantResponse).expires_at,
    };
  }
  if (!resp.ok) return { kind: "error", msg: resp.msg };
  return { kind: "error", msg: "unexpected broker response" };
}

export type ListGrantsResult =
  | { kind: "ok"; grants: GrantMeta[] }
  | { kind: "unreachable"; msg: string }
  | { kind: "error"; msg: string };

/**
 * List active grants via the broker, optionally filtered by agent.
 */
export async function listGrantsViaBroker(
  agent: string | undefined,
  opts?: BrokerClientOpts,
): Promise<ListGrantsResult> {
  const result = await rpc({ v: 1, op: "list_grants", agent }, opts);
  if (result.kind === "unreachable") return { kind: "unreachable", msg: result.msg };
  const resp = result.resp;
  if (resp.ok && "grants" in resp) {
    return { kind: "ok", grants: resp.grants as GrantMeta[] };
  }
  if (!resp.ok) return { kind: "error", msg: resp.msg };
  return { kind: "error", msg: "unexpected broker response" };
}

export type RevokeGrantResult =
  | { kind: "ok"; revoked: boolean }
  | { kind: "unreachable"; msg: string }
  | { kind: "error"; msg: string };

/**
 * Revoke a grant by ID via the broker.
 */
export async function revokeGrantViaBroker(
  id: string,
  opts?: BrokerClientOpts,
): Promise<RevokeGrantResult> {
  const result = await rpc({ v: 1, op: "revoke_grant", id }, opts);
  if (result.kind === "unreachable") return { kind: "unreachable", msg: result.msg };
  const resp = result.resp;
  if (resp.ok && "revoked" in resp) {
    return { kind: "ok", revoked: resp.revoked as boolean };
  }
  if (!resp.ok) return { kind: "error", msg: resp.msg };
  return { kind: "error", msg: "unexpected broker response" };
}
