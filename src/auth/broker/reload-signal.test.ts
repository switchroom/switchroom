import { describe, it, expect } from "vitest";

import {
  reloadAuthBroker,
  authBrokerReloadHint,
  AUTH_BROKER_CONTAINER,
  type DockerRunner,
} from "./reload-signal.js";

function runnerReturning(
  ret: { status: number | null; stderr?: string; error?: Error },
): { runner: DockerRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: DockerRunner = (args) => {
    calls.push(args);
    return { status: ret.status, stderr: ret.stderr ?? "", error: ret.error };
  };
  return { runner, calls };
}

describe("reloadAuthBroker", () => {
  it("sends SIGHUP to the auth-broker container (regression: nothing used to)", () => {
    const { runner, calls } = runnerReturning({ status: 0 });
    const result = reloadAuthBroker({ runner });
    expect(result).toEqual({ ok: true });
    // The exact invocation the hot-reload depends on.
    expect(calls).toEqual([["kill", "--signal=HUP", AUTH_BROKER_CONTAINER]]);
  });

  it("honours a custom container name", () => {
    const { runner, calls } = runnerReturning({ status: 0 });
    reloadAuthBroker({ runner, container: "switchroom-auth-broker-test" });
    expect(calls[0]).toEqual([
      "kill",
      "--signal=HUP",
      "switchroom-auth-broker-test",
    ]);
  });

  it("reports no-docker when the docker binary is missing (ENOENT)", () => {
    const err = Object.assign(new Error("spawn docker ENOENT"), {
      code: "ENOENT",
    });
    const { runner } = runnerReturning({ status: null, error: err });
    expect(reloadAuthBroker({ runner })).toEqual({
      ok: false,
      reason: "no-docker",
    });
  });

  it("reports not-running when the container is absent", () => {
    const { runner } = runnerReturning({
      status: 1,
      stderr:
        "Error response from daemon: No such container: switchroom-auth-broker",
    });
    expect(reloadAuthBroker({ runner })).toEqual({
      ok: false,
      reason: "not-running",
    });
  });

  it("reports not-running when the container is stopped", () => {
    const { runner } = runnerReturning({
      status: 1,
      stderr: "Error response from daemon: Cannot kill container: ... is not running",
    });
    expect(reloadAuthBroker({ runner })).toEqual({
      ok: false,
      reason: "not-running",
    });
  });

  it("reports a generic error for other docker failures", () => {
    const { runner } = runnerReturning({
      status: 1,
      stderr: "permission denied while trying to connect to the Docker daemon",
    });
    const result = reloadAuthBroker({ runner });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("error");
      expect(result.detail).toContain("permission denied");
    }
  });
});

describe("authBrokerReloadHint", () => {
  it("returns null on success (caller prints its own line)", () => {
    expect(authBrokerReloadHint({ ok: true })).toBeNull();
  });

  it("treats not-running as informational (next boot picks it up)", () => {
    const hint = authBrokerReloadHint({ ok: false, reason: "not-running" });
    expect(hint).toMatch(/not running/i);
    expect(hint).toMatch(/next start/i);
  });

  it("points at docker restart when docker is unreachable", () => {
    const hint = authBrokerReloadHint({ ok: false, reason: "no-docker" });
    expect(hint).toMatch(/docker restart switchroom-auth-broker/);
  });

  it("surfaces the detail on a generic error", () => {
    const hint = authBrokerReloadHint({
      ok: false,
      reason: "error",
      detail: "boom",
    });
    expect(hint).toMatch(/boom/);
    expect(hint).toMatch(/docker restart switchroom-auth-broker/);
  });
});
