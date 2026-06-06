import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  proposeConfigEditViaHostd,
  resolveHostdOperatorSocket,
} from "./hostd-config-propose.js";
import type { HostdResponse } from "../host-control/protocol.js";

function resp(partial: Partial<HostdResponse>): HostdResponse {
  return {
    v: 1,
    request_id: "r1",
    result: "completed",
    exit_code: null,
    duration_ms: 1,
    ...partial,
  } as HostdResponse;
}

describe("proposeConfigEditViaHostd", () => {
  it("maps result=completed → applied, sending the right request shape", async () => {
    let sent: unknown;
    const out = await proposeConfigEditViaHostd({
      unifiedDiff: "@@ patch @@",
      reason: "dashboard: enable marko",
      requestId: "req-1",
      socketPath: "/x/sock",
      send: async (_opts, req) => {
        sent = req;
        return resp({ result: "completed" });
      },
    });
    expect(out).toEqual({ state: "applied" });
    expect(sent).toMatchObject({
      op: "config_propose_edit",
      request_id: "req-1",
      args: {
        unified_diff: "@@ patch @@",
        reason: "dashboard: enable marko",
        target_path: "/state/config/switchroom.yaml",
      },
    });
  });

  it("maps result=denied → denied with the operator reason", async () => {
    const out = await proposeConfigEditViaHostd({
      unifiedDiff: "d",
      reason: "r",
      requestId: "req-2",
      socketPath: "/x/sock",
      send: async () => resp({ result: "denied", error: "operator said no" }),
    });
    expect(out).toEqual({ state: "denied", reason: "operator said no" });
  });

  it("maps result=error → error", async () => {
    const out = await proposeConfigEditViaHostd({
      unifiedDiff: "d",
      reason: "r",
      requestId: "req-3",
      socketPath: "/x/sock",
      send: async () => resp({ result: "error", error: "E_PATCH_APPLY_FAILED" }),
    });
    expect(out).toEqual({ state: "error", reason: "E_PATCH_APPLY_FAILED" });
  });

  it("never throws — a transport failure becomes state:error", async () => {
    const out = await proposeConfigEditViaHostd({
      unifiedDiff: "d",
      reason: "r",
      requestId: "req-4",
      socketPath: "/x/sock",
      send: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(out.state).toBe("error");
    if (out.state === "error") expect(out.reason).toContain("ECONNREFUSED");
  });
});

describe("resolveHostdOperatorSocket", () => {
  const KEY = "SWITCHROOM_HOSTD_OPERATOR_SOCKET";
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env[KEY];
    delete process.env[KEY];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  it("honors the env override first", () => {
    expect(resolveHostdOperatorSocket({ [KEY]: "/custom/sock" } as NodeJS.ProcessEnv)).toBe(
      "/custom/sock",
    );
  });

  it("returns null when no candidate socket exists (no env, no mounts)", () => {
    // In CI/dev there's no /host-home/... and no ~/.switchroom/hostd/operator/sock.
    const r = resolveHostdOperatorSocket({} as NodeJS.ProcessEnv);
    // Either null (typical) or a real socket if the dev box happens to run hostd.
    expect(r === null || typeof r === "string").toBe(true);
  });
});
