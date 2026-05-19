import { describe, it, expect } from "vitest";

import { runAgentSmokeChecks } from "./doctor-agent-smoke.js";
import type { HostdResponse } from "../host-control/protocol.js";

const cfg = { agents: { klanker: {}, gymbro: {} } };

function resp(body: unknown, over: Partial<HostdResponse> = {}): HostdResponse {
  return {
    v: 1,
    request_id: "x",
    result: "completed",
    exit_code: 0,
    duration_ms: 1,
    stdout_tail: JSON.stringify(body),
    ...over,
  };
}

describe("runAgentSmokeChecks", () => {
  it("--fast omits the section entirely", async () => {
    const r = await runAgentSmokeChecks(cfg, {
      fast: true,
      hostdRequestImpl: async () => resp({}),
    });
    expect(r).toEqual([]);
  });

  it("operator socket absent → one honest skip row (no per-agent noise)", async () => {
    const r = await runAgentSmokeChecks(cfg, {
      operatorSockPath: "/definitely/not/here.sock",
    });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ name: "agent liveness", status: "skip" });
    expect(r[0].detail).toMatch(/operator socket not found/);
  });

  it("all probes ok → one `ok` row per agent with a compact summary", async () => {
    const r = await runAgentSmokeChecks(cfg, {
      hostdRequestImpl: async (_s, name) =>
        resp({
          container: "running",
          probes: [
            { name: "auth", state: "ok", detail: "ok" },
            { name: "scheduler", state: "ok", detail: "ok" },
          ],
        }),
    });
    expect(r.map((c) => c.name)).toEqual(["klanker: liveness", "gymbro: liveness"]);
    expect(r.every((c) => c.status === "ok")).toBe(true);
    expect(r[0].detail).toBe("auth:ok scheduler:ok");
  });

  it("a failing probe → `fail` row naming the failed probe in the fix", async () => {
    const r = await runAgentSmokeChecks(
      { agents: { klanker: {} } },
      {
        hostdRequestImpl: async () =>
          resp({
            container: "running",
            probes: [
              { name: "auth", state: "fail", detail: "exit 1" },
              { name: "state", state: "ok", detail: "ok" },
            ],
          }),
      },
    );
    expect(r[0].status).toBe("fail");
    expect(r[0].detail).toBe("auth:FAIL state:ok");
    expect(r[0].fix).toMatch(/auth/);
  });

  it("container absent → skip (never fail — agent-down is not a defect this acts on)", async () => {
    const r = await runAgentSmokeChecks(
      { agents: { klanker: {} } },
      {
        hostdRequestImpl: async () =>
          resp({ container: "absent", probes: [{ name: "auth", state: "skip", detail: "" }] }),
      },
    );
    expect(r[0].status).toBe("skip");
    expect(r[0].detail).toMatch(/not running/);
  });

  it("hostd denied → skip (not fail)", async () => {
    const r = await runAgentSmokeChecks(
      { agents: { klanker: {} } },
      {
        hostdRequestImpl: async () =>
          resp({}, { result: "denied", error: "agent_smoke cross-agent requires admin" }),
      },
    );
    expect(r[0].status).toBe("skip");
    expect(r[0].detail).toMatch(/denied/);
  });

  it("hostd unreachable (throws) → skip (infra, not an agent defect)", async () => {
    const r = await runAgentSmokeChecks(
      { agents: { klanker: {} } },
      {
        hostdRequestImpl: async () => {
          throw new Error("ECONNREFUSED");
        },
      },
    );
    expect(r[0].status).toBe("skip");
    expect(r[0].detail).toMatch(/unreachable/);
  });
});
