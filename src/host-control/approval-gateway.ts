// hostd ApprovalGateway (#1623): abstracts the operator-approval surface
// so HostdServer.handleConfigProposeEdit's apply path is testable.

import { connect, type Socket } from "node:net";
import { randomBytes } from "node:crypto";

export type ApprovalVerdict = "approve" | "deny" | "timeout";

export interface ApprovalRequest {
  requestId: string;
  agentName: string;
  reason: string;
  unifiedDiff: string;
  timeoutMs: number;
  /**
   * Optional card header override (KEN-129). Default renders the
   * config-edit header ("🛠 Config edit proposed"); the update-check
   * drift card passes its own so the operator isn't told a fleet
   * update is a config edit. Old gateways ignore the field and fall
   * back to the default header — graceful degrade in mixed-version
   * rolls.
   */
  title?: string;
}

export interface ApprovalResult {
  verdict: ApprovalVerdict;
  /**
   * Diagnostic detail from the gateway when present. On a
   * dispatch-failure deny this carries the underlying cause (e.g.
   * "Telegram sendMessage failed") so the caller can surface a
   * descriptive error instead of an opaque `E_DENIED`. Issue #1762.
   */
  reason?: string;
  /**
   * On `verdict: "deny"`, distinguishes an actual operator tap
   * (`"operator"`) from a gateway-side dispatch failure that
   * auto-denied because the card never reached the operator
   * (`"dispatch_failure"`). Undefined when verdict is not "deny".
   * Issue #1762.
   */
  denySource?: "operator" | "dispatch_failure";
  /** Update the approval card with the apply outcome. */
  finalize: (outcome: {
    outcome: "applied" | "aborted_config_changed" | "reconcile_failed_rolled_back";
    detail?: string;
    /** Agents that must restart for the edit to go live (empty if fleetWide). */
    affectedAgents?: string[];
    /** True when a shared/inherited key changed → all agents affected. */
    fleetWide?: boolean;
  }) => Promise<void>;
}

export interface ApprovalGateway {
  requestApproval(req: ApprovalRequest): Promise<ApprovalResult>;
  /**
   * Read-only pre-approval query (#2975 Stage 2). Asks the gateway whether
   * this EXACT `(agentName, unifiedDiff)` pair is already operator-consented —
   * i.e. it byte-matches a correlation the gateway itself pre-registered when
   * the operator tapped Approve on a mental-model proposal (or "🔁 Always
   * allow"). When it does, hostd's `config_propose_edit` may skip the per-hour
   * rate limit for this persist: it posts no card and consumes zero operator
   * attention (issue #2975).
   *
   * The query MUST NOT mutate gateway state (the single-use auto-resolve delete
   * still happens later on the real `request_config_approval`) and MUST fail
   * CLOSED: any unreachable/unknown-message/malformed/timeout condition — e.g.
   * an old gateway during a mixed-version roll — resolves `false`, never
   * throws. `false` restores today's exact behaviour (rate limit applies, then
   * Stage 1's gateway retry backstop covers an approved-but-throttled persist).
   *
   * Optional: a gateway wiring without this method (or a hostd built before
   * Stage 2) is treated as "not pre-approved" by the caller — the same
   * fail-closed default.
   */
  checkPreApproved?(agentName: string, unifiedDiff: string): Promise<boolean>;
}

// SocketApprovalGateway — production wiring against `<agentDir>/telegram/gateway.sock`.

export interface SocketApprovalGatewayOptions {
  /** Resolve gateway IPC socket path; null → deny. */
  resolveGatewaySocket: (agentName: string) => string | null;
  log?: (msg: string) => void;
}

/**
 * Short deadline for the read-only pre-approval query (#2975 Stage 2). hostd
 * must never hang on this: it's an optimisation on the config-edit rate-limit
 * path, and a slow/absent gateway must fail closed quickly so the ordinary
 * (rate-limited) flow proceeds. The gateway answers from an in-memory map with
 * no I/O, so a real answer arrives in <1ms; this bound only guards a dead or
 * old-version socket.
 */
const PRE_APPROVED_QUERY_TIMEOUT_MS = 2000;

export class SocketApprovalGateway implements ApprovalGateway {
  constructor(private opts: SocketApprovalGatewayOptions) {}

  /**
   * #2975 Stage 2 — read-only pre-approval query. Connects to the agent's
   * gateway socket, sends a single `check_pre_approved` message, and resolves
   * with the gateway's `pre_approved_result.preApproved` boolean. FAIL CLOSED:
   * no socket, socket error/close, malformed/unknown reply, or timeout all
   * resolve `false`. Never throws, never mutates gateway state.
   */
  async checkPreApproved(
    agentName: string,
    unifiedDiff: string,
  ): Promise<boolean> {
    const sockPath = this.opts.resolveGatewaySocket(agentName);
    if (sockPath === null) return false;
    const log = this.opts.log ?? (() => {});
    // A per-query correlation id so a reply can never be confused with another
    // in-flight message on a shared connection (we use a fresh connection, but
    // the gateway echoes it and we verify the match defensively).
    const correlationId = `preapp-${randomBytes(8).toString("hex")}`;
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const client: Socket = connect({ path: sockPath });
      let buffer = "";
      const done = (result: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          client.destroy();
        } catch {
          /* best effort */
        }
        resolve(result);
      };
      const timer = setTimeout(() => {
        log(
          `checkPreApproved timed out after ${PRE_APPROVED_QUERY_TIMEOUT_MS}ms (agent=${agentName}) — failing closed`,
        );
        done(false);
      }, PRE_APPROVED_QUERY_TIMEOUT_MS);

      client.on("connect", () => {
        try {
          client.write(
            JSON.stringify({
              type: "check_pre_approved",
              agentName,
              correlationId,
              unifiedDiff,
            }) + "\n",
          );
        } catch (err) {
          log(
            `check_pre_approved write failed (agent=${agentName}): ${(err as Error).message} — failing closed`,
          );
          done(false);
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
            // Unknown/garbled reply → fail closed.
            done(false);
            return;
          }
          const obj = parsed as Record<string, unknown>;
          if (
            obj.type === "pre_approved_result" &&
            obj.correlationId === correlationId
          ) {
            done(obj.preApproved === true);
            return;
          }
          // Any other message type (e.g. an old gateway echoing an
          // unsupported-message error, or noise) → fail closed.
          done(false);
          return;
        }
      });

      client.on("error", (err) => {
        log(
          `checkPreApproved socket error (agent=${agentName}): ${err.message} — failing closed`,
        );
        done(false);
      });
      client.on("close", () => done(false));
    });
  }

  async requestApproval(req: ApprovalRequest): Promise<ApprovalResult> {
    const sockPath = this.opts.resolveGatewaySocket(req.agentName);
    if (sockPath === null) {
      // No reachable gateway — fail closed.
      return {
        verdict: "deny",
        reason: "no reachable telegram gateway socket for this agent",
        denySource: "dispatch_failure",
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
        outcome: "applied" | "aborted_config_changed" | "reconcile_failed_rolled_back";
        detail?: string;
        affectedAgents?: string[];
        fleetWide?: boolean;
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
              ...(outcome.affectedAgents ? { affectedAgents: outcome.affectedAgents } : {}),
              ...(outcome.fleetWide !== undefined ? { fleetWide: outcome.fleetWide } : {}),
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
              ...(req.title ? { title: req.title } : {}),
            }) + "\n",
          );
        } catch (err) {
          if (resolved) return;
          resolved = true;
          log(
            `request_config_approval write failed (requestId=${req.requestId}): ${(err as Error).message}`,
          );
          resolve({
            verdict: "deny",
            reason: `request_config_approval write failed: ${(err as Error).message}`,
            denySource: "dispatch_failure",
            finalize: async () => {},
          });
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
            const verdict = obj.verdict as ApprovalVerdict;
            const reasonField =
              typeof obj.reason === "string" ? obj.reason : undefined;
            // denySource is only meaningful on deny verdicts. Gateway
            // omits the field on operator-tap denies — default to
            // "operator" in that case so the caller can rely on the
            // discriminant being present whenever verdict==="deny".
            const denySource: "operator" | "dispatch_failure" | undefined =
              verdict === "deny"
                ? obj.denySource === "dispatch_failure"
                  ? "dispatch_failure"
                  : "operator"
                : undefined;
            resolve({
              verdict,
              ...(reasonField !== undefined ? { reason: reasonField } : {}),
              ...(denySource !== undefined ? { denySource } : {}),
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
        resolve({
          verdict: "deny",
          reason: `gateway socket error: ${err.message}`,
          denySource: "dispatch_failure",
          finalize: async () => {},
        });
      });

      client.on("close", () => {
        if (resolved) return;
        resolved = true;
        resolve({
          verdict: "deny",
          reason: "gateway socket closed before verdict",
          denySource: "dispatch_failure",
          finalize: async () => {},
        });
      });
    });
  }
}
