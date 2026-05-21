/**
 * hostd ApprovalGateway — RFC §3.3 / #1623.
 *
 * Abstracts the "ask the operator to approve a config diff" surface
 * so the apply path in `HostdServer.handleConfigProposeEdit` is
 * testable without spinning up a real Telegram gateway. Production
 * code wires `SocketApprovalGateway` (below), which connects to the
 * caller agent's gateway IPC socket and exchanges the new
 * `request_config_approval` / `config_approval_resolved` /
 * `request_config_finalize` messages defined in
 * `telegram-plugin/gateway/ipc-protocol.ts`.
 *
 * The single-method contract keeps the server's apply path narrow:
 * one round-trip yields a verdict, and the returned `finalize`
 * callback is invoked once after the apply attempt completes to
 * flip the card body to the terminal outcome. The interface is
 * intentionally identical to what the in-process tests need — no
 * gateway, no sockets, just `{verdict, finalize}`.
 */

import { connect, type Socket } from "node:net";

export type ApprovalVerdict = "approve" | "deny" | "timeout";

export interface ApprovalRequest {
  requestId: string;
  agentName: string;
  reason: string;
  unifiedDiff: string;
  timeoutMs: number;
}

export interface ApprovalResult {
  verdict: ApprovalVerdict;
  /** Update the operator-visible card with the apply outcome. Idempotent
   *  best-effort — failures inside the gateway are logged, not thrown. */
  finalize: (outcome: {
    outcome: "applied" | "reconcile_failed_rolled_back";
    detail?: string;
  }) => Promise<void>;
}

export interface ApprovalGateway {
  requestApproval(req: ApprovalRequest): Promise<ApprovalResult>;
}

// ────────────────────────────────────────────────────────────────────────
// SocketApprovalGateway — production wiring against the per-agent
// gateway IPC socket at `<agentDir>/telegram/gateway.sock`.
// ────────────────────────────────────────────────────────────────────────

export interface SocketApprovalGatewayOptions {
  /**
   * Resolve a per-agent gateway IPC socket path. Hostd invokes this
   * once per request with the caller agent's name (RFC §3.3: the
   * card lands in the calling admin agent's chat, which is the
   * operator's primary surface for that agent). Returns null when
   * no gateway socket is reachable — the caller treats this as a
   * deny + diagnostic error.
   */
  resolveGatewaySocket: (agentName: string) => string | null;
  log?: (msg: string) => void;
}

export class SocketApprovalGateway implements ApprovalGateway {
  constructor(private opts: SocketApprovalGatewayOptions) {}

  async requestApproval(req: ApprovalRequest): Promise<ApprovalResult> {
    const sockPath = this.opts.resolveGatewaySocket(req.agentName);
    if (sockPath === null) {
      // No reachable gateway — fail closed.
      return {
        verdict: "deny",
        finalize: async () => {},
      };
    }
    // Single TCP-like connection holds both the request and the
    // eventual resolved event. We keep it open until either the
    // verdict arrives, our local timeout fires, or the connection
    // drops — whichever first.
    return await new Promise<ApprovalResult>((resolve) => {
      const client: Socket = connect({ path: sockPath });
      let buffer = "";
      let resolved = false;
      const log = this.opts.log ?? (() => {});

      // Hostd-side hard deadline. The gateway also runs a timer and
      // SHOULD beat us to it; this is defense-in-depth in case the
      // gateway is silent (process gone, socket hung).
      const localTimeout = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        try { client.end(); } catch { /* noop */ }
        resolve({
          verdict: "timeout",
          finalize: async () => {},
        });
      }, req.timeoutMs + 5_000); // grace window so gateway-side timer wins

      const finalize = async (outcome: {
        outcome: "applied" | "reconcile_failed_rolled_back";
        detail?: string;
      }): Promise<void> => {
        // Best-effort second message on the same connection; if it
        // dropped after the verdict we open a fresh one.
        const send = (sock: Socket) => {
          try {
            sock.write(
              JSON.stringify({
                type: "request_config_finalize",
                requestId: req.requestId,
                outcome: outcome.outcome,
                ...(outcome.detail ? { detail: outcome.detail } : {}),
              }) + "\n",
            );
            sock.end();
          } catch (err) {
            log(
              `finalize write failed (requestId=${req.requestId}): ${(err as Error).message}`,
            );
          }
        };
        if (!client.destroyed) {
          send(client);
          return;
        }
        const sock2 = connect({ path: sockPath });
        sock2.on("connect", () => send(sock2));
        sock2.on("error", (err) => {
          log(
            `finalize reconnect failed (requestId=${req.requestId}): ${err.message}`,
          );
        });
      };

      client.on("connect", () => {
        try {
          client.write(
            JSON.stringify({
              type: "request_config_approval",
              requestId: req.requestId,
              agentName: req.agentName,
              reason: req.reason,
              unifiedDiff: req.unifiedDiff,
              timeoutMs: req.timeoutMs,
            }) + "\n",
          );
        } catch (err) {
          if (resolved) return;
          resolved = true;
          clearTimeout(localTimeout);
          log(
            `request_config_approval write failed (requestId=${req.requestId}): ${(err as Error).message}`,
          );
          resolve({ verdict: "deny", finalize: async () => {} });
        }
      });

      client.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            log(`bad JSON from gateway: ${line.slice(0, 200)}`);
            continue;
          }
          const obj = parsed as Record<string, unknown>;
          if (
            obj.type === "config_approval_resolved" &&
            obj.requestId === req.requestId &&
            (obj.verdict === "approve" ||
              obj.verdict === "deny" ||
              obj.verdict === "timeout") &&
            !resolved
          ) {
            resolved = true;
            clearTimeout(localTimeout);
            resolve({
              verdict: obj.verdict as ApprovalVerdict,
              finalize,
            });
            // Note: we keep `client` open so finalize can reuse it.
          }
        }
      });

      client.on("error", (err) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(localTimeout);
        log(
          `gateway socket error (requestId=${req.requestId}): ${err.message}`,
        );
        resolve({ verdict: "deny", finalize: async () => {} });
      });

      client.on("close", () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(localTimeout);
        resolve({ verdict: "deny", finalize: async () => {} });
      });
    });
  }
}
