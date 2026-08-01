/**
 * #2726 Part 2 — the socket-backed RolloutNarrationRelay.
 *
 * Same transport as the approval gateway / the Part 1 terminal relay: hostd
 * connects, as a client, to the caller agent's gateway IPC socket and writes a
 * typed JSON line. `post` awaits the gateway's `rollout_status_posted` reply
 * (bounded, so a silent gateway can't stall the narrator) to learn the
 * message_id; `edit` is pure fire-and-forget.
 *
 * The gateway side owns the actual Telegram send/edit, INCLUDING 429
 * `retry_after` handling (its `robustApiCall` retry policy), so a rate limit
 * never surfaces toward the roll.
 *
 * #4065 — `edit` is still never awaited by the roll, but it is no longer
 * BLIND: it resolves with a `RolloutEditOutcome`, and the gateway distinguishes
 * "the message is gone" from every other failure. That is what lets a
 * seeded-resume narrator (editing a card a previous hostd posted) notice it is
 * editing into the void and re-post once instead of leaving the operator with
 * a frozen card for the rest of the roll.
 */

import { connect, type Socket } from "node:net";
import type {
  RolloutEditOutcome,
  RolloutNarrationRelay,
} from "./rollout-narrator.js";

export interface SocketRolloutNarrationRelayOptions {
  resolveGatewaySocket: (agentName: string) => string | null;
  log?: (m: string) => void;
  /** Max ms to await the post reply before giving up (message_id → null). */
  postReplyTimeoutMs?: number;
  /**
   * Max ms to await the `rollout_status_edited` reply (#4065). On expiry the
   * edit resolves `gone:false` — unknown, never a re-post trigger.
   */
  editReplyTimeoutMs?: number;
}

const DEFAULT_POST_REPLY_TIMEOUT_MS = 5000;
const DEFAULT_EDIT_REPLY_TIMEOUT_MS = 5000;

export class SocketRolloutNarrationRelay implements RolloutNarrationRelay {
  constructor(private opts: SocketRolloutNarrationRelayOptions) {}

  post(args: {
    requestId: string;
    agentName: string;
    text: string;
  }): Promise<number | null> {
    const log = this.opts.log ?? (() => {});
    let sockPath: string | null;
    try {
      sockPath = this.opts.resolveGatewaySocket(args.agentName);
    } catch (e) {
      log(`narration resolveGatewaySocket threw: ${(e as Error).message}`);
      return Promise.resolve(null);
    }
    if (sockPath === null) {
      log(`narration post: no reachable gateway for ${args.agentName}`);
      return Promise.resolve(null);
    }
    return new Promise<number | null>((resolve) => {
      let settled = false;
      const finish = (v: number | null): void => {
        if (settled) return;
        settled = true;
        try {
          client.destroy();
        } catch {
          /* already gone */
        }
        resolve(v);
      };
      let client: Socket;
      try {
        client = connect({ path: sockPath! });
      } catch (e) {
        log(`narration post connect threw: ${(e as Error).message}`);
        resolve(null);
        return;
      }
      client.setTimeout(this.opts.postReplyTimeoutMs ?? DEFAULT_POST_REPLY_TIMEOUT_MS);
      let buffer = "";
      client.on("connect", () => {
        try {
          client.write(
            JSON.stringify({
              type: "rollout_status_post",
              requestId: args.requestId,
              agentName: args.agentName,
              text: args.text,
            }) + "\n",
          );
        } catch (e) {
          log(`narration post write failed: ${(e as Error).message}`);
          finish(null);
        }
      });
      client.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let obj: Record<string, unknown>;
          try {
            obj = JSON.parse(line) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (
            obj.type === "rollout_status_posted" &&
            obj.requestId === args.requestId
          ) {
            if (obj.ok === true && typeof obj.messageId === "number") {
              finish(obj.messageId);
            } else {
              log(
                `narration post rejected by gateway (requestId=${args.requestId}): ${typeof obj.reason === "string" ? obj.reason : "no message_id"}`,
              );
              finish(null);
            }
            return;
          }
        }
      });
      client.on("timeout", () => {
        log(`narration post reply timed out (requestId=${args.requestId})`);
        finish(null);
      });
      client.on("error", (e) => {
        log(`narration post socket error (requestId=${args.requestId}): ${e.message}`);
        finish(null);
      });
      client.on("close", () => finish(null));
    });
  }

  /**
   * Relay one edit and resolve with its outcome (#4065). Never rejects: every
   * failure path resolves, and everything the gateway does not positively
   * report as a missing message resolves `gone:false` — a re-post is only ever
   * triggered by an explicit "that message is gone", never by a timeout, an
   * unreachable gateway, or a gateway too old to send the reply.
   */
  edit(args: {
    requestId: string;
    agentName: string;
    messageId: number;
    text: string;
  }): Promise<RolloutEditOutcome> {
    const log = this.opts.log ?? (() => {});
    let sockPath: string | null;
    try {
      sockPath = this.opts.resolveGatewaySocket(args.agentName);
    } catch (e) {
      log(`narration edit resolveGatewaySocket threw: ${(e as Error).message}`);
      return Promise.resolve({
        ok: false,
        gone: false,
        reason: `resolveGatewaySocket threw: ${(e as Error).message}`,
      });
    }
    if (sockPath === null) {
      return Promise.resolve({
        ok: false,
        gone: false,
        reason: "no reachable gateway",
      });
    }
    return new Promise<RolloutEditOutcome>((resolve) => {
      let settled = false;
      let client: Socket;
      const finish = (outcome: RolloutEditOutcome): void => {
        if (settled) return;
        settled = true;
        try {
          client.destroy();
        } catch {
          /* already gone */
        }
        resolve(outcome);
      };
      try {
        client = connect({ path: sockPath! });
      } catch (e) {
        log(`narration edit connect threw: ${(e as Error).message}`);
        resolve({ ok: false, gone: false, reason: (e as Error).message });
        return;
      }
      client.setTimeout(
        this.opts.editReplyTimeoutMs ?? DEFAULT_EDIT_REPLY_TIMEOUT_MS,
      );
      let buffer = "";
      client.on("connect", () => {
        try {
          client.write(
            JSON.stringify({
              type: "rollout_status_edit",
              requestId: args.requestId,
              agentName: args.agentName,
              messageId: args.messageId,
              text: args.text,
            }) + "\n",
          );
          // NO half-close here. `client.end()` would send a FIN, and the
          // gateway's IPC server is `Bun.listen`, which tears the connection
          // down on the peer FIN (~5ms) rather than keeping it readable — its
          // `socket.write` for the reply then returns -1 and `IpcClientImpl.send`
          // does not check that, so the reply is dropped SILENTLY. The reply
          // only exists after a Telegram round-trip (hundreds of ms), so a
          // half-close loses it every single time and this whole feature
          // degrades to `{ok:false, gone:false, reason:"no edit reply"}` — a
          // frozen card, exactly the pre-fix behaviour. Instead we mirror
          // `post()` above: hold the socket open and let `finish()` destroy it
          // once the reply lands, the timeout fires, or the peer closes.
          // Pinned by tests/rollout-narration-edit-socket.test.ts.
        } catch (e) {
          log(`narration edit write failed: ${(e as Error).message}`);
          finish({ ok: false, gone: false, reason: (e as Error).message });
        }
      });
      client.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let obj: Record<string, unknown>;
          try {
            obj = JSON.parse(line) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (
            obj.type === "rollout_status_edited" &&
            obj.requestId === args.requestId
          ) {
            if (obj.ok === true) {
              finish({ ok: true });
            } else {
              finish({
                ok: false,
                gone: obj.gone === true,
                ...(typeof obj.reason === "string" ? { reason: obj.reason } : {}),
              });
            }
            return;
          }
        }
      });
      client.on("timeout", () =>
        finish({ ok: false, gone: false, reason: "edit reply timed out" }),
      );
      client.on("error", (e) => {
        log(`narration edit socket error: ${e.message}`);
        finish({ ok: false, gone: false, reason: e.message });
      });
      // A gateway that predates the reply just closes; degrade to "unknown".
      client.on("close", () =>
        finish({ ok: false, gone: false, reason: "no edit reply" }),
      );
    });
  }
}
