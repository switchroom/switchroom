// Issue #2971 — read-only gateway query: "is there a live pending permission
// request (Telegram approval card) for this agent right now?"
//
// Since PR #2581 (a42215da), the wedge-watchdog's permission branch Esc-denied
// EVERY per-tool permission prompt after ~15s of shape-persistence — including
// prompts that already had a live Telegram approval card racing in parallel
// (Claude Code renders the interactive TUI AND emits the
// `notifications/claude/channel/permission_request` channel notification
// unconditionally; first responder wins). That raced and killed the entire
// per-tool approval flow fleet-wide.
//
// This module is the thin client half of the fix: before the watchdog fires
// Esc, it asks the gateway (over the same per-agent UDS the rate-limit signal
// and agent-scheduler already use) whether a card is live. The gateway
// answers from its `pendingPermissions` map — pure read, no mutation.
//
//   pending: true  → a card (and the #2724 TTL reaper) already own this
//                     prompt. The watchdog must NOT Esc; the reaper's
//                     channel-delivered deny dismisses the TUI at TTL with no
//                     keystroke needed.
//   pending: false → no live card (bridge down, a `requiresUserInteraction`
//                     tool, or genuinely card-less). Esc fallback is safe.
//   unreachable     → gateway socket didn't answer within the budget (down,
//                     mixed-version old gateway that doesn't know this
//                     message type, slow). Esc fallback is safe — this is
//                     the SAME behaviour as before this fix ever existed.
//
// Soft-fail throughout — must NEVER throw (the sidecar's never-throw
// contract). Any failure resolves to `{ ok: false }` (unreachable), which the
// caller must treat as "fall back to Esc".

import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/** Mirrors ipc-protocol's `QueryPendingPermissionMessage`. */
export interface QueryPendingPermissionWireMessage {
  type: "query_pending_permission";
  agentName: string;
  correlationId: string;
}

/** Mirrors ipc-protocol's `PendingPermissionStatusEvent`. */
export interface PendingPermissionStatusWireMessage {
  type: "pending_permission_status";
  correlationId: string;
  pending: boolean;
  requestId?: string;
}

export type PendingPermissionQueryResult =
  | { ok: true; pending: boolean; requestId?: string }
  | { ok: false; reason: string };

export interface QueryOptions {
  socketPath?: string;
  /** Connect+round-trip budget in ms. Default 2000 (issue's ~2s budget). */
  timeoutMs?: number;
  /** Test seam: replace createConnection. */
  _connect?: (path: string) => Socket;
  /** Test seam: log sink. */
  _log?: (msg: string) => void;
}

/** Resolve the gateway socket the same way rate-limit-signal / the
 *  agent-scheduler do. */
export function resolveGatewaySocketPath(): string {
  const stateDir = process.env.TELEGRAM_STATE_DIR ?? "/state/agent/telegram";
  return process.env.SWITCHROOM_GATEWAY_SOCKET ?? join(stateDir, "gateway.sock");
}

/**
 * Ask the gateway whether a live pending permission request (Telegram
 * approval card) exists for `agentName`. Never throws. Resolves
 * `{ ok: false }` on ANY failure (connect error, timeout, malformed/absent
 * reply — including an older gateway that doesn't recognise this message
 * type at all) — the caller's fallback for `ok: false` MUST be identical to
 * pre-#2971 behaviour (Esc).
 */
export function queryPendingPermission(
  agentName: string,
  opts: QueryOptions = {},
): Promise<PendingPermissionQueryResult> {
  const socketPath = opts.socketPath ?? resolveGatewaySocketPath();
  const connect = opts._connect ?? ((p: string) => createConnection(p));
  const log = opts._log ?? ((m: string) => console.error(m));
  const timeoutMs = opts.timeoutMs ?? 2_000;
  const correlationId = randomUUID();

  const msg: QueryPendingPermissionWireMessage = {
    type: "query_pending_permission",
    agentName,
    correlationId,
  };
  const line = JSON.stringify(msg) + "\n";

  return new Promise<PendingPermissionQueryResult>((resolve) => {
    let settled = false;
    let sock: Socket | undefined;
    const done = (r: PendingPermissionQueryResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        sock?.destroy();
      } catch {
        /* ignore */
      }
      resolve(r);
    };

    const timer = setTimeout(() => {
      log(`[permission-pending-query] ${agentName}: timed out after ${timeoutMs}ms — treating as unreachable`);
      done({ ok: false, reason: "timeout" });
    }, timeoutMs);

    try {
      sock = connect(socketPath);
    } catch (err) {
      log(`[permission-pending-query] ${agentName}: connect threw: ${(err as Error).message}`);
      done({ ok: false, reason: `connect threw: ${(err as Error).message}` });
      return;
    }

    let buffer = "";
    sock.on("connect", () => {
      try {
        sock!.write(line);
      } catch (err) {
        log(`[permission-pending-query] ${agentName}: write threw: ${(err as Error).message}`);
        done({ ok: false, reason: `write threw: ${(err as Error).message}` });
      }
    });

    sock.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const rawLine = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!rawLine.trim()) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(rawLine);
        } catch {
          continue; // ignore malformed lines; keep waiting up to the timeout
        }
        const p = parsed as Partial<PendingPermissionStatusWireMessage>;
        if (
          p &&
          p.type === "pending_permission_status" &&
          p.correlationId === correlationId
        ) {
          done({ ok: true, pending: !!p.pending, requestId: p.requestId });
          return;
        }
        // Some other IPC message (e.g. `status`) may arrive first on a
        // freshly-connected socket — ignore and keep waiting for ours.
      }
    });

    sock.on("error", (err) => {
      log(`[permission-pending-query] ${agentName}: socket error: ${(err as Error).message}`);
      done({ ok: false, reason: `socket error: ${(err as Error).message}` });
    });

    sock.on("close", () => {
      done({ ok: false, reason: "socket closed before a matching reply arrived" });
    });
  });
}
