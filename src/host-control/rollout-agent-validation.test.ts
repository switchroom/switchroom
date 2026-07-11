/**
 * #2972 — handleRollout must FAIL FAST on a bad `agents` list before it
 * spawns the rollout child. Pre-fix it returned `result: "started"`
 * unconditionally; the child then rejected unknown agents on stderr (exit 2)
 * but hostd had already replied success, so the caller saw a phantom
 * "started" and no approval card ever appeared (the 2026-07-10
 * `switchroom-test-harness` incident).
 *
 * We drive the private `handleRollout` directly on a bare instance (same
 * private-method cast pattern as reconcile-rollback-output.test.ts), with the
 * config loader mocked so validation runs against a deterministic agent set.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const loadConfigMock = vi.fn();

vi.mock("../config/loader.js", async () => {
  const actual =
    await vi.importActual<typeof import("../config/loader.js")>(
      "../config/loader.js",
    );
  return {
    ...actual,
    loadConfig: (...args: unknown[]) => loadConfigMock(...args),
  };
});

const { HostdServer } = await import("./server.js");
import type { ServerOptions } from "./server.js";
import type { HostdRequest, HostdResponse } from "./protocol.js";
import type { SocketIdentity } from "./peercred.js";

const caller: SocketIdentity = {
  kind: "agent",
  name: "overlord",
} as SocketIdentity;

type RolloutReq = Extract<HostdRequest, { op: "rollout" }>;

function rolloutReq(agents?: string[]): RolloutReq {
  return {
    v: 1,
    request_id: "req-2972",
    op: "rollout",
    args: {
      pin: "v0.15.18",
      ...(agents !== undefined ? { agents } : {}),
    },
  } as RolloutReq;
}

/** A bare server with self-bump + asset preflight neutralised, and
 *  launchRollout stubbed so no real child is ever spawned. Returns both the
 *  server and a spy that records whether launchRollout was reached. */
function makeServer() {
  const server = new HostdServer({
    selfVersion: "v99.0.0",
  } as unknown as ServerOptions);
  const launchSpy = vi.fn(() => ({ request_id: "req-2972" }));
  const s = server as unknown as {
    missingApplyAssets: () => string[];
    launchRollout: unknown;
    handleRollout: (
      req: RolloutReq,
      caller: SocketIdentity,
      started: number,
    ) => Promise<HostdResponse>;
  };
  s.missingApplyAssets = () => [];
  s.launchRollout = launchSpy;
  return { server: s, launchSpy };
}

beforeEach(() => {
  loadConfigMock.mockReset();
  loadConfigMock.mockReturnValue({
    agents: { "test-harness": {}, clerk: {}, overlord: {} },
  });
});

describe("handleRollout — #2972 fail-fast agent validation", () => {
  it("rejects a single unknown agent with E_UNKNOWN_AGENT and the valid names", async () => {
    const { server, launchSpy } = makeServer();
    const resp = await server.handleRollout(
      rolloutReq(["switchroom-test-harness"]),
      caller,
      Date.now(),
    );
    expect(resp.result).toBe("denied");
    expect(resp.error).toMatch(/E_UNKNOWN_AGENT/);
    expect(resp.error).toMatch(/switchroom-test-harness/);
    // The valid agent names are listed so the caller can self-correct.
    expect(resp.error).toMatch(/test-harness/);
    expect(resp.error).toMatch(/clerk/);
    // #1758 structured envelope: code + fix.kind + human naming the names.
    expect(resp.error_envelope?.code).toBe("E_UNKNOWN_AGENT");
    expect(resp.error_envelope?.fix?.kind).toBe("bad_input");
    expect(resp.error_envelope?.human).toMatch(/switchroom-test-harness/);
    expect(resp.error_envelope?.human).toMatch(/clerk/);
    expect(resp.error_envelope?.request_id).toBe("req-2972");
    // No child was spawned.
    expect(launchSpy).not.toHaveBeenCalled();
  });

  it("rejects a mixed valid+invalid list, naming ONLY the bad one", async () => {
    const { server, launchSpy } = makeServer();
    const resp = await server.handleRollout(
      rolloutReq(["clerk", "ghost-agent"]),
      caller,
      Date.now(),
    );
    expect(resp.result).toBe("denied");
    expect(resp.error).toMatch(/ghost-agent/);
    // "clerk" is valid — it must not be named as unknown.
    expect(resp.error).not.toMatch(/unknown agent\(s\): [^.]*clerk/);
    expect(resp.error_envelope?.code).toBe("E_UNKNOWN_AGENT");
    expect(launchSpy).not.toHaveBeenCalled();
  });

  it("rejects an explicitly empty agents list", async () => {
    const { server, launchSpy } = makeServer();
    const resp = await server.handleRollout(rolloutReq([]), caller, Date.now());
    expect(resp.result).toBe("denied");
    expect(resp.error).toMatch(/E_UNKNOWN_AGENT|empty/);
    expect(resp.error_envelope?.code).toBe("E_UNKNOWN_AGENT");
    expect(resp.error_envelope?.fix?.kind).toBe("bad_input");
    expect(launchSpy).not.toHaveBeenCalled();
  });

  it("proceeds (started) when every requested agent is valid — happy path unchanged", async () => {
    const { server, launchSpy } = makeServer();
    const resp = await server.handleRollout(
      rolloutReq(["test-harness", "clerk"]),
      caller,
      Date.now(),
    );
    expect(resp.result).toBe("started");
    expect(launchSpy).toHaveBeenCalledTimes(1);
  });

  it("proceeds (started) when no agents list is given (roll all)", async () => {
    const { server, launchSpy } = makeServer();
    const resp = await server.handleRollout(rolloutReq(), caller, Date.now());
    expect(resp.result).toBe("started");
    expect(launchSpy).toHaveBeenCalledTimes(1);
  });

  it("does NOT convert a config-read failure into a denial — proceeds and lets the child fail", async () => {
    loadConfigMock.mockImplementation(() => {
      throw new Error("Invalid YAML in switchroom.yaml");
    });
    const { server, launchSpy } = makeServer();
    const resp = await server.handleRollout(
      rolloutReq(["switchroom-test-harness"]),
      caller,
      Date.now(),
    );
    // Malformed config → skip validation, proceed as before (item 2 on the
    // MCP side catches the child's early death).
    expect(resp.result).toBe("started");
    expect(launchSpy).toHaveBeenCalledTimes(1);
  });
});
