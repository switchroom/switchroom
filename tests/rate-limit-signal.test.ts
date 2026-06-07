// Unit tests for the one-shot gateway signal client (signalQuotaWall). Uses a
// fake socket via the _connect seam — no real UDS.

import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { signalQuotaWall } from "../src/agents/rate-limit-signal.js";

/** Minimal fake Socket: emits 'connect' on next tick, records writes. */
function fakeSocket(opts: { failConnect?: boolean } = {}) {
  const ee = new EventEmitter() as unknown as Socket & EventEmitter & { written: string[]; ended: boolean };
  (ee as any).written = [];
  (ee as any).ended = false;
  (ee as any).write = (data: string, cb?: () => void) => {
    (ee as any).written.push(data);
    cb?.();
    return true;
  };
  (ee as any).end = () => { (ee as any).ended = true; };
  (ee as any).destroy = () => {};
  queueMicrotask(() => {
    if (opts.failConnect) ee.emit("error", new Error("ECONNREFUSED"));
    else ee.emit("connect");
  });
  return ee;
}

describe("signalQuotaWall", () => {
  it("writes ONE NDJSON quota_wall_detected envelope with agentName + resetAt", async () => {
    let sock: ReturnType<typeof fakeSocket> | undefined;
    const ok = await signalQuotaWall("finn", 1_780_000_000_000, {
      _connect: () => (sock = fakeSocket()) as unknown as Socket,
      _log: () => {},
    });
    expect(ok).toBe(true);
    expect(sock!.written).toHaveLength(1);
    const line = sock!.written[0];
    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line)).toEqual({
      type: "quota_wall_detected",
      agentName: "finn",
      resetAt: 1_780_000_000_000,
    });
    expect(sock!.ended).toBe(true);
  });

  it("OMITS resetAt when null (gateway then uses the +7d default)", async () => {
    let sock: ReturnType<typeof fakeSocket> | undefined;
    await signalQuotaWall("finn", null, {
      _connect: () => (sock = fakeSocket()) as unknown as Socket,
      _log: () => {},
    });
    const parsed = JSON.parse(sock!.written[0]);
    expect(parsed.resetAt).toBeUndefined();
    expect(parsed.type).toBe("quota_wall_detected");
  });

  it("soft-fails (returns false, never throws) when the socket errors", async () => {
    const ok = await signalQuotaWall("finn", null, {
      _connect: () => fakeSocket({ failConnect: true }) as unknown as Socket,
      _log: () => {},
    });
    expect(ok).toBe(false);
  });

  it("soft-fails when connect THROWS synchronously", async () => {
    const ok = await signalQuotaWall("finn", null, {
      _connect: () => { throw new Error("boom"); },
      _log: () => {},
    });
    expect(ok).toBe(false);
  });
});
