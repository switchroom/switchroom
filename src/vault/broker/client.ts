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
 * Send a single request to the broker and get a response.
 * Returns null on connection failure (unreachable broker).
 * Throws on protocol errors (bad response).
 */
async function rpc(
  req: Parameters<typeof encodeRequest>[0],
  opts?: BrokerClientOpts,
): Promise<BrokerResponse | null> {
  const socketPath = resolveBrokerSocketPath(opts);
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<BrokerResponse | null>((resolve) => {
    let settled = false;
    const settle = (val: BrokerResponse | null): void => {
      if (settled) return;
      settled = true;
      resolve(val);
    };

    const timer = setTimeout(() => {
      client.destroy();
      settle(null);
    }, timeoutMs);

    const client = net.createConnection({ path: socketPath });

    client.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      // Unreachable broker — return null (not an error for the caller)
      if (
        err.code === "ENOENT" ||
        err.code === "ECONNREFUSED" ||
        err.code === "EACCES"
      ) {
        settle(null);
      } else {
        settle(null); // treat all connection errors as unreachable
      }
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
          settle(resp);
        } catch {
          settle(null);
        }
      }
    });

    client.on("connect", () => {
      try {
        client.write(encodeRequest(req));
      } catch {
        clearTimeout(timer);
        client.destroy();
        settle(null);
      }
    });
  });
}

/**
 * Get a vault entry via the broker.
 * Returns null if broker is unreachable or key is not found.
 */
export async function getViaBroker(
  key: string,
  opts?: BrokerClientOpts,
): Promise<VaultEntry | null> {
  const resp = await rpc({ v: 1, op: "get", key }, opts);
  if (resp === null) return null;
  if (resp.ok && "entry" in resp) return resp.entry as VaultEntry;
  return null;
}

/**
 * List all vault key names via the broker.
 * Returns null if broker is unreachable.
 */
export async function listViaBroker(
  opts?: BrokerClientOpts,
): Promise<string[] | null> {
  const resp = await rpc({ v: 1, op: "list" }, opts);
  if (resp === null) return null;
  if (resp.ok && "keys" in resp) return resp.keys as string[];
  return null;
}

/**
 * Get broker status.
 * Returns null if broker is unreachable.
 */
export async function statusViaBroker(
  opts?: BrokerClientOpts,
): Promise<BrokerStatus | null> {
  const resp = await rpc({ v: 1, op: "status" }, opts);
  if (resp === null) return null;
  if (resp.ok && "status" in resp) return resp.status as BrokerStatus;
  return null;
}

/**
 * Send the lock command to the broker.
 * Returns true on success, false if broker is unreachable.
 */
export async function lockViaBroker(opts?: BrokerClientOpts): Promise<boolean> {
  const resp = await rpc({ v: 1, op: "lock" }, opts);
  if (resp === null) return false;
  return resp.ok;
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
