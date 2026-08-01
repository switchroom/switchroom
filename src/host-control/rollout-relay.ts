// hostd RolloutRelay (#2726 Part 1) — pushes ONE ordinary operator-DM message
// to Telegram when a fleet rollout reaches its terminal row.
//
// This reuses the SAME transport as the approval card
// (`src/host-control/approval-gateway.ts`): hostd connects, as a client, to the
// caller agent's gateway IPC socket (`<agentsDir>/<agent>/telegram/gateway.sock`)
// and writes one typed JSON line. The gateway posts it to the operator's chat
// (`allowFrom[0]`) as a NORMAL message — NOT a pinned card, NOT a bespoke
// widget. That keeps it clear of the `chat-is-the-single-source-of-truth`
// invariant: it is the model/framework speaking a plain message in the chat,
// the invariant's own prescribed remedy.
//
// Discipline (locked by the design review): fire-and-forget. The approval path
// blocks up to 61 min awaiting an operator tap; this MUST NOT inherit that. We
// connect, write, and disconnect — never awaiting a reply, wrapping everything
// so a slow / absent / erroring gateway can never block or fail the roll.

import { connect, type Socket } from "node:net";

export interface RolloutTerminalNotice {
  /** hostd request_id of the roll (binds the message to a real request). */
  requestId: string;
  /** The admin agent whose gateway relays the message (the rollout caller). */
  agentName: string;
  /** Fully-rendered message body (already safe plain/markdown text). */
  text: string;
  /**
   * #4048 — optional tap-to-restart inline keyboard. Present only on an
   * ensure-banks residue terminal (one `🔄 Restart <agent>` button per drifted
   * agent, `op:restart:<encoded>` callback). Fire-and-forget like the text: a
   * gateway that can't render buttons still gets the prose body.
   */
  inlineKeyboard?: Array<Array<{ text: string; callback_data: string }>>;
}

export interface RolloutRelay {
  /**
   * Post ONE ordinary operator-DM message. Fire-and-forget: returns
   * immediately, never throws, never blocks the caller. A failure to reach the
   * gateway is swallowed (logged) — a rolled fleet with a missing chat ping is
   * strictly better than a roll stalled on a chat send.
   */
  postTerminal(notice: RolloutTerminalNotice): void;
}

export interface SocketRolloutRelayOptions {
  /** Resolve the caller agent's gateway IPC socket path; null → drop. */
  resolveGatewaySocket: (agentName: string) => string | null;
  log?: (msg: string) => void;
}

/**
 * Production relay against `<agentDir>/telegram/gateway.sock`. Same socket the
 * SocketApprovalGateway uses — but this one NEVER waits for a reply.
 */
export class SocketRolloutRelay implements RolloutRelay {
  constructor(private opts: SocketRolloutRelayOptions) {}

  postTerminal(notice: RolloutTerminalNotice): void {
    const log = this.opts.log ?? (() => {});
    let sockPath: string | null;
    try {
      sockPath = this.opts.resolveGatewaySocket(notice.agentName);
    } catch (e) {
      log(`resolveGatewaySocket threw for ${notice.agentName}: ${(e as Error).message}`);
      return;
    }
    if (sockPath === null) {
      // No reachable gateway. Drop — the durable terminal audit row is still
      // the record of what happened; the chat ping is best-effort.
      log(`no reachable gateway socket for ${notice.agentName}; dropping terminal ping`);
      return;
    }
    // Wrap the whole connect+write so nothing here can throw into the caller.
    try {
      const client: Socket = connect({ path: sockPath });
      // Never let a hung connect keep an fd / event loop ref around.
      client.setTimeout(5000);
      const done = (): void => {
        try {
          client.destroy();
        } catch {
          /* already gone */
        }
      };
      client.on("connect", () => {
        try {
          client.write(
            JSON.stringify({
              type: "rollout_status_post",
              requestId: notice.requestId,
              agentName: notice.agentName,
              text: notice.text,
              ...(notice.inlineKeyboard
                ? { inlineKeyboard: notice.inlineKeyboard }
                : {}),
            }) + "\n",
          );
          // Fire-and-forget: end the write side immediately. We do NOT wait for
          // a reply — the roll must not depend on the chat send resolving.
          client.end();
        } catch (e) {
          log(`rollout terminal write failed (requestId=${notice.requestId}): ${(e as Error).message}`);
          done();
        }
      });
      client.on("timeout", () => {
        log(`rollout terminal connect timed out (requestId=${notice.requestId})`);
        done();
      });
      client.on("error", (e) => {
        log(`rollout terminal socket error (requestId=${notice.requestId}): ${e.message}`);
        done();
      });
      // Nothing to do on close — the write already left our process.
      client.on("close", () => {});
    } catch (e) {
      log(`rollout terminal connect threw (requestId=${notice.requestId}): ${(e as Error).message}`);
    }
  }
}
