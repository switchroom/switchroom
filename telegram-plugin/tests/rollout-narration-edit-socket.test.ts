/**
 * #4065 — the SOCKET-LEVEL proof that hostd actually RECEIVES the
 * `rollout_status_edited` reply over the real transport.
 *
 * Why this file exists
 * --------------------
 * Every other test for this feature fakes the seam that carries the bug:
 * `rollout-status-edit.test.ts` drives `handleRolloutStatusEdit` against an
 * in-process `{ send }` sink, and `rollout-narrator.test.ts` drives the
 * narrator against a fake relay. Both were green while the feature was
 * COMPLETELY INERT in production, because the relay's `edit()` half-closed the
 * socket (`client.end()`) right after writing the request, and the gateway's
 * IPC server is `Bun.listen`, which tears the connection down on the peer FIN
 * (~5ms) instead of keeping it readable. The real reply — which only arrives
 * AFTER a Telegram API round-trip, i.e. hundreds of ms later — was written to a
 * dead socket (`socket.write` returning -1, unchecked by `IpcClientImpl.send`)
 * and never reached hostd. hostd then always resolved
 * `{ok:false, gone:false, reason:"no edit reply"}`, which by design never
 * re-posts: identical behaviour to no fix at all.
 *
 * So this test wires the REAL `createIpcServer` (Bun.listen) to the REAL
 * `SocketRolloutNarrationRelay` over a real unix socket, and makes the reply
 * land only AFTER a delay at least as long as a Telegram round-trip. It fails
 * on the half-close implementation and passes on the hold-open one.
 *
 * Runs under bun (`Bun.listen` is a bun built-in) — vitest-excluded, named by
 * telegram-plugin/scripts/bun-test-ci.sh via the `tests/` target.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createIpcServer, type IpcServer, type IpcClient } from "../gateway/ipc-server.js";
import { handleRolloutStatusEdit } from "../gateway/rollout-status-edit.js";
import type { RolloutStatusEditMessage } from "../gateway/ipc-protocol.js";
import { SocketRolloutNarrationRelay } from "../../src/host-control/rollout-narration-relay.js";

/**
 * The load-bearing constant. A real `editMessageText` costs a network
 * round-trip to api.telegram.org — on the order of 100-500ms, and more under
 * `robustApiCall`'s 429 retry policy. The reply CANNOT be delivered
 * synchronously with the request, which is exactly why a half-closed socket
 * loses it. Anything comfortably above one event-loop turn reproduces it; 300ms
 * is a conservative stand-in for the round-trip while keeping the suite fast.
 */
const TELEGRAM_ROUND_TRIP_MS = 300;

function tmpSocket(): string {
  const dir = mkdtempSync(join(tmpdir(), "rollout-edit-sock-"));
  return join(dir, "gateway.sock");
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Stand up the real IPC server with the real edit handler behind a delayed
 * `editMessage`, and return a real relay pointed at it.
 */
function harness(editMessage: () => Promise<unknown>): {
  server: IpcServer;
  relay: SocketRolloutNarrationRelay;
} {
  const socketPath = tmpSocket();
  const server = createIpcServer({
    socketPath,
    onClientRegistered: () => {},
    onClientDisconnected: () => {},
    onToolCall: async () => ({ type: "tool_call_result", id: "x", success: true }),
    onSessionEvent: () => {},
    onPermissionRequest: () => {},
    onHeartbeat: () => {},
    onScheduleRestart: () => {},
    onRolloutStatusEdit: (client: IpcClient, msg: RolloutStatusEditMessage) =>
      handleRolloutStatusEdit(
        {
          selfAgentName: "carrie",
          operatorChatId: () => "12345",
          editMessage,
          log: () => {},
        },
        client,
        msg,
      ),
  });
  const relay = new SocketRolloutNarrationRelay({
    resolveGatewaySocket: () => socketPath,
    editReplyTimeoutMs: 5000,
  });
  return { server, relay };
}

describe("rollout narration edit — real socket, delayed reply (#4065)", () => {
  const servers: IpcServer[] = [];

  afterEach(async () => {
    for (const s of servers) await s.close();
    servers.length = 0;
  });

  it("receives an ok reply that arrives a Telegram round-trip after the request", async () => {
    const { server, relay } = harness(async () => {
      await wait(TELEGRAM_ROUND_TRIP_MS);
      return { message_id: 77 };
    });
    servers.push(server);
    await wait(50);

    const started = Date.now();
    const outcome = await relay.edit({
      requestId: "ro-ok-1",
      agentName: "carrie",
      messageId: 77,
      text: "phase 2/4 — restarting carrie",
    });

    // The outcome must be the gateway's real answer, not the connection-closed
    // fallback the half-close produced.
    expect(outcome).toEqual({ ok: true });
    // And it must genuinely have waited for the round-trip, i.e. the socket
    // stayed alive across it rather than resolving early on close.
    expect(Date.now() - started).toBeGreaterThanOrEqual(TELEGRAM_ROUND_TRIP_MS);
  });

  it("receives a gone:true classification that arrives after the round-trip", async () => {
    const { server, relay } = harness(async () => {
      await wait(TELEGRAM_ROUND_TRIP_MS);
      throw new Error("Bad Request: message to edit not found");
    });
    servers.push(server);
    await wait(50);

    const outcome = await relay.edit({
      requestId: "ro-gone-1",
      agentName: "carrie",
      messageId: 77,
      text: "phase 3/4 — verifying carrie",
    });

    // This is the whole point of #4065: only an explicit `gone` may trigger the
    // narrator's one-shot re-post. A lost reply degrades to gone:false and the
    // operator keeps staring at a frozen card.
    expect(outcome.ok).toBe(false);
    expect(outcome.gone).toBe(true);
    expect(outcome.reason).toMatch(/message to edit not found/);
  });

  it("receives a transient classification (gone:false) after the round-trip", async () => {
    const { server, relay } = harness(async () => {
      await wait(TELEGRAM_ROUND_TRIP_MS);
      throw new Error("Bad Gateway");
    });
    servers.push(server);
    await wait(50);

    const outcome = await relay.edit({
      requestId: "ro-transient-1",
      agentName: "carrie",
      messageId: 77,
      text: "phase 4/4 — carrie back up",
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.gone).toBe(false);
    // A REAL gateway answer, distinguishable from the "no edit reply" the
    // dropped-reply bug produced.
    expect(outcome.reason).toMatch(/Bad Gateway/);
  });
});
