/**
 * Regression test for fleet-audit B2 — the bridge's background reconnect
 * loop must never surface a failed connect attempt as a process-level
 * unhandledRejection.
 *
 * Live evidence (kdogg, 2026-07-17):
 *   bridge-crash.log: `unhandledRejection … Error: Failed to connect
 *     | at doConnect (dist/server.js:24188) …`
 *
 * Mechanism: `scheduleReconnect()`'s timer invoked `doConnect()` without a
 * rejection handler. `doConnect` returns a promise that REJECTS whenever
 * the `Bun.connect` attempt fails (gateway restarting out from under a
 * long-lived bridge — the exact window every planned `docker restart`
 * opens). The initial-connect call sites attach a `.catch`; the retry
 * timer did not, so every failed background retry escaped as an
 * unhandledRejection. Pre-#3033 that killed the bridge process outright
 * (Claude Code never respawns a dead MCP server → mute agent); post-#3033
 * it still spams `bridge-crash.log` with pseudo-crash breadcrumbs and
 * leans on a global process handler for survival.
 *
 * Outcome asserted: with nothing listening on the socket path, the client
 * runs through its initial attempt AND several background retries without
 * a single unhandledRejection reaching the process. RED without the
 * `.catch` in scheduleReconnect's timer, GREEN with it.
 *
 * Run with: bun test telegram-plugin/tests/ipc-client-reconnect-rejection.test.ts
 */
import { describe, it, expect } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIpcClient } from "../bridge/ipc-client.js";

describe("ipc-client background reconnect", () => {
  it("a failed reconnect attempt never escapes as a process-level unhandledRejection", async () => {
    const captured: unknown[] = [];
    const onUnhandled = (err: unknown) => {
      captured.push(err);
    };
    process.on("unhandledRejection", onUnhandled);

    // Nothing listens here — every connect attempt fails, exercising both
    // the (already-handled) initial attempt and the retry-timer path.
    const socketPath = join(tmpdir(), `ipc-b2-${crypto.randomUUID()}.sock`);

    const handle = await createIpcClient({
      socketPath,
      agentName: "b2-test",
      onInbound: () => {},
      onPermission: () => {},
      onStatus: () => {},
      log: () => {},
      reconnectDelayMs: 15,
      maxReconnectDelayMs: 30,
    });

    try {
      // Long enough for several background retries (15ms, 30ms, 30ms, …)
      // plus the macrotask on which unhandledRejection is delivered.
      await new Promise((resolve) => setTimeout(resolve, 300));
    } finally {
      handle.close();
      // Give any in-flight rejection its delivery tick before detaching.
      await new Promise((resolve) => setTimeout(resolve, 50));
      process.off("unhandledRejection", onUnhandled);
    }

    expect(handle.isConnected()).toBe(false);
    expect(captured).toEqual([]);
  });
});
