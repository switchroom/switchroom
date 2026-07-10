// Unit tests for the read-only gateway query client (issue #2971):
// queryPendingPermission. Uses a fake socket via the _connect seam — no real
// UDS, mirrors tests/rate-limit-signal.test.ts's pattern.

import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { queryPendingPermission } from "../src/agents/permission-pending-query.js";

/** Minimal fake Socket: emits 'connect' on next tick, records writes, and
 *  lets the test push a reply line via `.reply(obj)`. */
function fakeSocket(opts: { failConnect?: boolean } = {}) {
  const ee = new EventEmitter() as unknown as Socket &
    EventEmitter & { written: string[]; destroyed: boolean; reply: (obj: unknown) => void };
  (ee as any).written = [];
  (ee as any).destroyed = false;
  (ee as any).write = (data: string) => {
    (ee as any).written.push(data);
    return true;
  };
  (ee as any).destroy = () => {
    (ee as any).destroyed = true;
  };
  (ee as any).reply = (obj: unknown) => {
    ee.emit("data", Buffer.from(JSON.stringify(obj) + "\n"));
  };
  queueMicrotask(() => {
    if (opts.failConnect) ee.emit("error", new Error("ECONNREFUSED"));
    else ee.emit("connect");
  });
  return ee;
}

describe("queryPendingPermission", () => {
  it("writes ONE query_pending_permission envelope with agentName + a correlationId", async () => {
    let sock: ReturnType<typeof fakeSocket> | undefined;
    const p = queryPendingPermission("carrie", {
      _connect: () => (sock = fakeSocket()) as unknown as Socket,
      _log: () => {},
    });
    // Let the connect+write microtask run, then reply.
    await Promise.resolve();
    await Promise.resolve();
    expect(sock!.written).toHaveLength(1);
    const parsed = JSON.parse(sock!.written[0]);
    expect(parsed.type).toBe("query_pending_permission");
    expect(parsed.agentName).toBe("carrie");
    expect(typeof parsed.correlationId).toBe("string");
    expect(parsed.correlationId.length).toBeGreaterThan(0);

    sock!.reply({
      type: "pending_permission_status",
      correlationId: parsed.correlationId,
      pending: true,
      requestId: "req-1",
    });
    const result = await p;
    expect(result).toEqual({ ok: true, pending: true, requestId: "req-1" });
  });

  it("resolves pending:false with no requestId when the gateway reports none pending", async () => {
    let sock: ReturnType<typeof fakeSocket> | undefined;
    const p = queryPendingPermission("carrie", {
      _connect: () => (sock = fakeSocket()) as unknown as Socket,
      _log: () => {},
    });
    await Promise.resolve();
    await Promise.resolve();
    const parsed = JSON.parse(sock!.written[0]);
    sock!.reply({
      type: "pending_permission_status",
      correlationId: parsed.correlationId,
      pending: false,
    });
    const result = await p;
    expect(result).toEqual({ ok: true, pending: false, requestId: undefined });
  });

  it("ignores a reply with a MISMATCHED correlationId, keeps waiting", async () => {
    let sock: ReturnType<typeof fakeSocket> | undefined;
    const p = queryPendingPermission("carrie", {
      _connect: () => (sock = fakeSocket()) as unknown as Socket,
      _log: () => {},
      timeoutMs: 200,
    });
    await Promise.resolve();
    await Promise.resolve();
    const parsed = JSON.parse(sock!.written[0]);
    sock!.reply({
      type: "pending_permission_status",
      correlationId: "someone-elses-correlation-id",
      pending: true,
      requestId: "not-ours",
    });
    // Correct reply now arrives.
    sock!.reply({
      type: "pending_permission_status",
      correlationId: parsed.correlationId,
      pending: false,
    });
    const result = await p;
    expect(result).toEqual({ ok: true, pending: false, requestId: undefined });
  });

  it("soft-fails ok:false on connect error", async () => {
    const result = await queryPendingPermission("carrie", {
      _connect: () => fakeSocket({ failConnect: true }) as unknown as Socket,
      _log: () => {},
    });
    expect(result.ok).toBe(false);
  });

  it("soft-fails ok:false when connect THROWS synchronously", async () => {
    const result = await queryPendingPermission("carrie", {
      _connect: () => {
        throw new Error("boom");
      },
      _log: () => {},
    });
    expect(result.ok).toBe(false);
  });

  it("soft-fails ok:false on timeout (no reply within budget) — never throws", async () => {
    const result = await queryPendingPermission("carrie", {
      _connect: () => fakeSocket() as unknown as Socket, // connects but never replies
      _log: () => {},
      timeoutMs: 20,
    });
    expect(result.ok).toBe(false);
  });

  it("mixed-version safety: an old gateway that never answers still resolves ok:false", async () => {
    // Simulates an older gateway build that doesn't recognise
    // `query_pending_permission` at all — it silently drops the message
    // (logs "invalid IPC message shape") and never replies. From the
    // client's perspective this is indistinguishable from any other
    // no-reply case: the timeout budget still bounds it.
    const result = await queryPendingPermission("carrie", {
      _connect: () => fakeSocket() as unknown as Socket,
      _log: () => {},
      timeoutMs: 20,
    });
    expect(result).toEqual({ ok: false, reason: "timeout" });
  });
});
