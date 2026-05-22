// hostd ApprovalGateway (#1623): abstracts the operator-approval surface
// so HostdServer.handleConfigProposeEdit's apply path is testable.

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
  /** Update the approval card with the apply outcome. */
  finalize: (outcome: {
    outcome: "applied" | "reconcile_failed_rolled_back";
    detail?: string;
  }) => Promise<void>;
}

export interface ApprovalGateway {
  requestApproval(req: ApprovalRequest): Promise<ApprovalResult>;
}

// SocketApprovalGateway — production wiring against `<agentDir>/telegram/gateway.sock`.

export interface SocketApprovalGatewayOptions {
  /** Resolve gateway IPC socket path; null → deny. */
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
    // Single connection holds both the request and the resolved event.
    // Gateway is the source of truth for the timeout; socket error/close → deny.
    return await new Promise<ApprovalResult>((resolve) => {
      const client: Socket = connect({ path: sockPath });
      let buffer = "";
      let resolved = false;
      const log = this.opts.log ?? (() => {});

      const finalize = async (outcome: {
        outcome: "applied" | "reconcile_failed_rolled_back";
        detail?: string;
      }): Promise<void> => {
        // Best-effort single-shot write on the existing connection.
        if (client.destroyed) return;
        try {
          client.write(
            JSON.stringify({
              type: "request_config_finalize",
              requestId: req.requestId,
              outcome: outcome.outcome,
              ...(outcome.detail ? { detail: outcome.detail } : {}),
            }) + "\n",
          );
          client.end();
        } catch (err) {
          log(
            `finalize write failed (requestId=${req.requestId}): ${(err as Error).message}`,
          );
        }
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
        log(
          `gateway socket error (requestId=${req.requestId}): ${err.message}`,
        );
        resolve({ verdict: "deny", finalize: async () => {} });
      });

      client.on("close", () => {
        if (resolved) return;
        resolved = true;
        resolve({ verdict: "deny", finalize: async () => {} });
      });
    });
  }
}
