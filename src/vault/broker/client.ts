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
 */

import * as net from "node:net";
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
