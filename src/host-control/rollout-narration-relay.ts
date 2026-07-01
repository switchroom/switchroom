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
 * `retry_after` handling (its `swallowingApiCall`/`robustApiCall` retry
 * policy). So an edit failure — a rate limit, a deleted message — never
 * surfaces back to hostd, and never toward the roll.
 */

import { connect, type Socket } from "node:net";
import type { RolloutNarrationRelay } from "./rollout-narrator.js";

export interface SocketRolloutNarrationRelayOptions {
  resolveGatewaySocket: (agentName: string) => string | null;
  log?: (m: string) => void;
  /** Max ms to await the post reply before giving up (message_id → null). */
  postReplyTimeoutMs?: number;
}

const DEFAULT_POST_REPLY_TIMEOUT_MS = 5000;

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

  edit(args: {
    requestId: string;
    agentName: string;
    messageId: number;
    text: string;
  }): void {
    const log = this.opts.log ?? (() => {});
    let sockPath: string | null;
    try {
      sockPath = this.opts.resolveGatewaySocket(args.agentName);
    } catch (e) {
      log(`narration edit resolveGatewaySocket threw: ${(e as Error).message}`);
      return;
    }
    if (sockPath === null) return;
    try {
      const client = connect({ path: sockPath });
      client.setTimeout(5000);
      const done = (): void => {
        try {
          client.destroy();
        } catch {
          /* gone */
        }
      };
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
          client.end();
        } catch (e) {
          log(`narration edit write failed: ${(e as Error).message}`);
          done();
        }
      });
      client.on("timeout", done);
      client.on("error", (e) => {
        log(`narration edit socket error: ${e.message}`);
        done();
      });
      client.on("close", () => {});
    } catch (e) {
      log(`narration edit connect threw: ${(e as Error).message}`);
    }
  }
}
