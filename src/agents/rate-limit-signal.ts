// One-shot gateway signal for the rate-limit (weekly-quota) wedge.
//
// When the wedge-watchdog (autoaccept-poll sidecar) detects claude's
// `/rate-limit-options` menu, it must trigger the gateway's EXISTING account-
// failover chain (markExhausted → roll → quota-watch alert). The watchdog runs
// in a separate process from the gateway, so it signals over the gateway's
// per-agent UDS — the same socket + trust model the agent-scheduler uses
// (anything inside this container's network namespace may connect; the agent
// name is validated server-side, never trusted from the wire alone).
//
// Fire-and-forget, one connection per signal (the signal fires at most once per
// watchdog cooldown, ~60s). Soft-fail throughout — must NEVER throw, to honour
// the sidecar's never-throw contract. A dropped signal just means failover
// isn't triggered this tick; the next stable detection retries.

import { createConnection, type Socket } from "node:net";
import { join } from "node:path";

/** The NDJSON envelope written to the gateway socket. Mirrors the
 *  ipc-protocol `QuotaWallDetectedMessage`. */
export interface QuotaWallSignal {
  type: "quota_wall_detected";
  agentName: string;
  /** Parsed weekly-reset epoch-ms, or omitted when unparseable (the gateway
   *  substitutes a weekly-scale default — never the ~5h markExhausted default,
   *  which would un-exhaust a weekly wall and re-wedge). */
  resetAt?: number;
}

export interface SignalOptions {
  socketPath?: string;
  connectTimeoutMs?: number;
  /** Test seam: replace createConnection. */
  _connect?: (path: string) => Socket;
  /** Test seam: log sink. */
  _log?: (msg: string) => void;
}

/** Resolve the gateway socket the same way the agent-scheduler does. */
export function resolveGatewaySocketPath(): string {
  const stateDir = process.env.TELEGRAM_STATE_DIR ?? "/state/agent/telegram";
  return process.env.SWITCHROOM_GATEWAY_SOCKET ?? join(stateDir, "gateway.sock");
}

/**
 * Send a `quota_wall_detected` signal to the gateway. Fire-and-forget,
 * never throws. Returns a Promise that resolves true if the bytes were written
 * to the socket (the strongest delivery signal a fire-and-forget client gets),
 * false on any failure. The watchdog does not await it (so a slow/absent socket
 * can never stall the poll loop), but it is awaitable for tests.
 */
export function signalQuotaWall(
  agentName: string,
  resetAt: number | null,
  opts: SignalOptions = {},
): Promise<boolean> {
  const socketPath = opts.socketPath ?? resolveGatewaySocketPath();
  const connect = opts._connect ?? ((p: string) => createConnection(p));
  const log = opts._log ?? ((m: string) => console.error(m));
  const connectTimeoutMs = opts.connectTimeoutMs ?? 5_000;

  const msg: QuotaWallSignal = { type: "quota_wall_detected", agentName };
  if (resetAt != null) msg.resetAt = resetAt;
  const line = JSON.stringify(msg) + "\n";

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    let sock: Socket;
    try {
      sock = connect(socketPath);
    } catch (err) {
      log(`[rate-limit-signal] ${agentName}: connect threw: ${(err as Error).message}`);
      done(false);
      return;
    }
    const timer = setTimeout(() => {
      log(`[rate-limit-signal] ${agentName}: connect timed out`);
      try { sock.destroy(); } catch { /* ignore */ }
      done(false);
    }, connectTimeoutMs);

    sock.on("connect", () => {
      try {
        sock.write(line, () => {
          clearTimeout(timer);
          try { sock.end(); } catch { /* ignore */ }
          log(`[rate-limit-signal] ${agentName}: quota_wall_detected sent`);
          done(true);
        });
      } catch (err) {
        clearTimeout(timer);
        log(`[rate-limit-signal] ${agentName}: write threw: ${(err as Error).message}`);
        try { sock.destroy(); } catch { /* ignore */ }
        done(false);
      }
    });
    sock.on("error", (err) => {
      clearTimeout(timer);
      log(`[rate-limit-signal] ${agentName}: socket error: ${(err as Error).message}`);
      done(false);
    });
  });
}
