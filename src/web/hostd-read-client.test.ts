import { describe, expect, it } from "vitest";
import {
  fetchFleetStatusViaHostd,
  fetchScheduleViaHostd,
  fetchAgentLogsViaHostd,
  restartAgentViaHostd,
  HOSTD_UNREACHABLE_LOGS_MESSAGE,
  HOSTD_UNREACHABLE_CONTROL_MESSAGE,
} from "./hostd-read-client.js";
import type { HostdResponse } from "../host-control/protocol.js";

function resp(partial: Partial<HostdResponse>): HostdResponse {
  return {
    v: 1,
    request_id: "r1",
    result: "completed",
    exit_code: 0,
    duration_ms: 1,
    ...partial,
  } as HostdResponse;
}

const SOCK = "/x/operator/sock";

describe("fetchFleetStatusViaHostd", () => {
  it("parses the statuses payload and sends an agent_status request (no name = fleet)", async () => {
    let sent: unknown;
    const out = await fetchFleetStatusViaHostd({
      socketPath: SOCK,
      send: async (_opts, req) => {
        sent = req;
        return resp({
          payload: JSON.stringify({
            statuses: {
              clerk: { active: "active", uptime: "2026-06-15T00:00:00Z", memory: "256MB", pid: 7 },
            },
          }),
        });
      },
    });
    expect(out).toEqual({
      clerk: { active: "active", uptime: "2026-06-15T00:00:00Z", memory: "256MB", pid: 7 },
    });
    expect(sent).toMatchObject({ op: "agent_status", args: {} });
  });

  it("returns null when the socket is unresolved (hostd not reachable)", async () => {
    let called = false;
    const out = await fetchFleetStatusViaHostd({
      socketPath: null,
      send: async () => {
        called = true;
        return resp({});
      },
    });
    expect(out).toBeNull();
    // Short-circuits before opening any connection.
    expect(called).toBe(false);
  });

  it("returns null when the transport throws (timeout / connection refused)", async () => {
    const out = await fetchFleetStatusViaHostd({
      socketPath: SOCK,
      send: async () => {
        throw new Error("hostd: request timed out after 4000ms");
      },
    });
    expect(out).toBeNull();
  });

  it("returns null on a non-completed result", async () => {
    const out = await fetchFleetStatusViaHostd({
      socketPath: SOCK,
      send: async () => resp({ result: "error", exit_code: null, error: "boom" }),
    });
    expect(out).toBeNull();
  });

  it("returns null on a bad-JSON payload (degrade, never throw)", async () => {
    const out = await fetchFleetStatusViaHostd({
      socketPath: SOCK,
      send: async () => resp({ payload: "{ not json" }),
    });
    expect(out).toBeNull();
  });

  it("returns null when the payload is the wrong shape (no statuses)", async () => {
    const out = await fetchFleetStatusViaHostd({
      socketPath: SOCK,
      send: async () => resp({ payload: JSON.stringify({ nope: 1 }) }),
    });
    expect(out).toBeNull();
  });

  it("returns null when there is no payload at all", async () => {
    const out = await fetchFleetStatusViaHostd({
      socketPath: SOCK,
      send: async () => resp({ stdout_tail: "hi" }),
    });
    expect(out).toBeNull();
  });
});

describe("fetchScheduleViaHostd", () => {
  it("parses the schedule payload and sends an agent_schedule request", async () => {
    let sent: unknown;
    const out = await fetchScheduleViaHostd({
      socketPath: SOCK,
      send: async (_opts, req) => {
        sent = req;
        return resp({
          payload: JSON.stringify({
            entries: [{ agent: "clerk", scheduleIndex: 0, cron: "*/30 * * * *", promptKey: "k" }],
            recentByAgent: { clerk: [] },
          }),
        });
      },
    });
    expect(out).not.toBeNull();
    expect(out!.entries).toHaveLength(1);
    expect(out!.entries[0].agent).toBe("clerk");
    expect(out!.recentByAgent).toEqual({ clerk: [] });
    expect(sent).toMatchObject({ op: "agent_schedule", args: {} });
  });

  it("defaults recentByAgent to {} when the payload omits it", async () => {
    const out = await fetchScheduleViaHostd({
      socketPath: SOCK,
      send: async () =>
        resp({ payload: JSON.stringify({ entries: [] }) }),
    });
    expect(out).toEqual({ entries: [], recentByAgent: {} });
  });

  it("returns null on a null socket", async () => {
    const out = await fetchScheduleViaHostd({ socketPath: null, send: async () => resp({}) });
    expect(out).toBeNull();
  });

  it("returns null when entries isn't an array (bad shape)", async () => {
    const out = await fetchScheduleViaHostd({
      socketPath: SOCK,
      send: async () => resp({ payload: JSON.stringify({ entries: "nope" }) }),
    });
    expect(out).toBeNull();
  });

  it("returns null on a throwing transport", async () => {
    const out = await fetchScheduleViaHostd({
      socketPath: SOCK,
      send: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(out).toBeNull();
  });
});

describe("fetchAgentLogsViaHostd", () => {
  it("routes through the existing agent_logs verb and returns stdout_tail", async () => {
    let sent: unknown;
    const out = await fetchAgentLogsViaHostd("clerk", 100, {
      socketPath: SOCK,
      send: async (_opts, req) => {
        sent = req;
        return resp({ stdout_tail: "log line 1\nlog line 2\n" });
      },
    });
    expect(out).toEqual({ ok: true, logs: "log line 1\nlog line 2\n" });
    expect(sent).toMatchObject({ op: "agent_logs", args: { name: "clerk", tail: 100 } });
  });

  it("clamps tail to the schema bound (max 2000)", async () => {
    let sentTail = -1;
    await fetchAgentLogsViaHostd("clerk", 99999, {
      socketPath: SOCK,
      send: async (_opts, req) => {
        sentTail = (req as { args: { tail: number } }).args.tail;
        return resp({ stdout_tail: "" });
      },
    });
    expect(sentTail).toBe(2000);
  });

  it("returns the actionable hostd-down message when the socket is null", async () => {
    const out = await fetchAgentLogsViaHostd("clerk", 50, {
      socketPath: null,
      send: async () => resp({}),
    });
    expect(out).toEqual({ ok: false, error: HOSTD_UNREACHABLE_LOGS_MESSAGE });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("need hostd");
  });

  it("returns the actionable message when the transport throws", async () => {
    const out = await fetchAgentLogsViaHostd("clerk", 50, {
      socketPath: SOCK,
      send: async () => {
        throw new Error("spawn-equivalent failure");
      },
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toBe(HOSTD_UNREACHABLE_LOGS_MESSAGE);
  });

  it("surfaces hostd's reason on a denied/error result", async () => {
    const out = await fetchAgentLogsViaHostd("clerk", 50, {
      socketPath: SOCK,
      send: async () => resp({ result: "error", exit_code: null, error: "No such container" }),
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("No such container");
  });
});

describe("restartAgentViaHostd", () => {
  it("routes through agent_restart and maps `completed` → ok", async () => {
    let sent: unknown;
    const out = await restartAgentViaHostd("clerk", {
      socketPath: SOCK,
      send: async (_opts, req) => {
        sent = req;
        return resp({ result: "completed" });
      },
    });
    expect(out).toEqual({ ok: true });
    expect(sent).toMatchObject({
      op: "agent_restart",
      args: { name: "clerk", force: true, reason: "restart requested from dashboard" },
    });
  });

  it("maps `started` → ok (restart is async — started IS success)", async () => {
    const out = await restartAgentViaHostd("clerk", {
      socketPath: SOCK,
      send: async () => resp({ result: "started", exit_code: null }),
    });
    expect(out).toEqual({ ok: true });
  });

  it("maps `denied` → {ok:false} surfacing hostd's reason", async () => {
    const out = await restartAgentViaHostd("clerk", {
      socketPath: SOCK,
      send: async () =>
        resp({ result: "denied", exit_code: null, error: "cross-agent restart needs admin" }),
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("cross-agent restart needs admin");
  });

  it("maps `error` → {ok:false} surfacing hostd's reason", async () => {
    const out = await restartAgentViaHostd("clerk", {
      socketPath: SOCK,
      send: async () => resp({ result: "error", exit_code: null, error: "recreate failed" }),
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("recreate failed");
  });

  it("returns the actionable control message on a null socket", async () => {
    let called = false;
    const out = await restartAgentViaHostd("clerk", {
      socketPath: null,
      send: async () => {
        called = true;
        return resp({});
      },
    });
    expect(out).toEqual({ ok: false, error: HOSTD_UNREACHABLE_CONTROL_MESSAGE });
    // Short-circuits before opening any connection.
    expect(called).toBe(false);
    if (!out.ok) expect(out.error).toContain("needs hostd");
  });

  it("returns the actionable control message when the transport throws", async () => {
    const out = await restartAgentViaHostd("clerk", {
      socketPath: SOCK,
      send: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toBe(HOSTD_UNREACHABLE_CONTROL_MESSAGE);
  });
});
