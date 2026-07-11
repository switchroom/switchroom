/**
 * Unit tests for `hostd-dispatch.ts` — the gateway's helper that routes
 * self-restart slash-commands through the hostd UDS when enabled.
 *
 * The config-loading branches are validated by mocking
 * `loadSwitchroomConfig` (the schema's complexity isn't this test's
 * concern — we just need to feed it a known value). The wire-error
 * branch is validated by pointing the helper at a nonexistent socket.
 *
 * The "actually hits a real hostd" path is covered in
 * `tests/host-control/server.test.ts` end-to-end — we don't re-test
 * the server here.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";

const loadConfigMock = vi.fn();
vi.mock("../../src/config/loader.js", () => ({
  loadConfig: loadConfigMock,
}));

const hostdRequestMock = vi.fn();
vi.mock("../../src/host-control/client.js", () => ({
  hostdRequest: hostdRequestMock,
}));

const existsSyncMock = vi.fn();
vi.mock("node:fs", async () => {
  const real = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...real,
    existsSync: (p: string) => existsSyncMock(p),
  };
});

// Import AFTER the mocks so the module captures the mocked functions.
const {
  tryHostdDispatch,
  hostdWillBeUsed,
  isHostdEnabled,
  hostdSocketPath,
  pollHostdStatus,
  warnLegacySpawnIfHostdDisabled,
  withOperatorAttestation,
  _resetHostdEnabledCache,
  _resetDeprecationSeen,
} = await import("../../telegram-plugin/gateway/hostd-dispatch.js");

beforeEach(() => {
  _resetHostdEnabledCache();
  _resetDeprecationSeen();
  loadConfigMock.mockReset();
  hostdRequestMock.mockReset();
  existsSyncMock.mockReset();
  // Default: pretend the socket exists so dispatch reaches the wire.
  existsSyncMock.mockReturnValue(true);
});

afterEach(() => {
  _resetHostdEnabledCache();
  _resetDeprecationSeen();
});

describe("isHostdEnabled() — config gate", () => {
  it("returns true when host_control is absent (default-on since RFC C Phase 2)", () => {
    // Mock returns a partial config without host_control — simulates an
    // older config object or a path that bypassed Zod. The helper now
    // uses `!== false` semantics, matching the schema's `.default(true)`
    // so default-on stays default-on across both parsed and unparsed
    // config paths.
    loadConfigMock.mockReturnValue({});
    expect(isHostdEnabled()).toBe(true);
  });

  it("returns false when host_control.enabled is explicitly false", () => {
    loadConfigMock.mockReturnValue({ host_control: { enabled: false } });
    expect(isHostdEnabled()).toBe(false);
  });

  it("returns true when host_control.enabled is explicitly true", () => {
    loadConfigMock.mockReturnValue({ host_control: { enabled: true } });
    expect(isHostdEnabled()).toBe(true);
  });

  it("returns false on config-load throw (best-effort fallback)", () => {
    // Gateway runs in environments where the config may not be
    // readable yet (very-early-boot, broken symlink). The helper must
    // not propagate — it just disables the hostd path.
    loadConfigMock.mockImplementation(() => {
      throw new Error("config: file not found");
    });
    expect(isHostdEnabled()).toBe(false);
  });

  it("caches the result across calls (no re-read)", () => {
    loadConfigMock.mockReturnValue({ host_control: { enabled: true } });
    expect(isHostdEnabled()).toBe(true);
    expect(isHostdEnabled()).toBe(true);
    expect(isHostdEnabled()).toBe(true);
    expect(loadConfigMock).toHaveBeenCalledTimes(1);
  });
});

describe("hostdWillBeUsed() — config + socket existence", () => {
  it("false when hostd disabled even if socket would be present", () => {
    loadConfigMock.mockReturnValue({ host_control: { enabled: false } });
    expect(hostdWillBeUsed("klanker")).toBe(false);
  });

  it("false when hostd enabled but per-agent socket isn't bound", () => {
    loadConfigMock.mockReturnValue({ host_control: { enabled: true } });
    existsSyncMock.mockReturnValue(false);
    expect(hostdWillBeUsed("klanker-no-such-agent")).toBe(false);
  });
});

describe("tryHostdDispatch()", () => {
  it("returns 'not-configured' when hostd disabled", async () => {
    loadConfigMock.mockReturnValue({ host_control: { enabled: false } });
    const result = await tryHostdDispatch("klanker", {
      v: 1,
      op: "agent_restart",
      request_id: "test-1",
      args: { name: "klanker", force: true },
    });
    expect(result).toBe("not-configured");
  });

  it("returns 'not-configured' when socket absent", async () => {
    loadConfigMock.mockReturnValue({ host_control: { enabled: true } });
    existsSyncMock.mockReturnValue(false);
    const result = await tryHostdDispatch("nonexistent-agent", {
      v: 1,
      op: "agent_restart",
      request_id: "test-2",
      args: { name: "nonexistent-agent", force: true },
    });
    expect(result).toBe("not-configured");
  });

  it("locks the socket-path contract", () => {
    // RFC C pins this path. If the gateway and the compose generator
    // drift apart on the bind path, the mount silently goes nowhere
    // and every dispatch returns "not-configured". Catch any rename
    // in lockstep with the compose-generator test.
    expect(hostdSocketPath("klanker")).toBe(
      "/run/switchroom/hostd/klanker/sock",
    );
  });

  // RFC C §5.4 trust model: cross-agent verbs go through the same
  // `tryHostdDispatch` pipeline as self-target ones. The admin gate
  // lives in the daemon (server.ts:checkGate), not the gateway — so
  // from the dispatch helper's perspective there's no distinction.
  // These cases pin that "the helper treats agent_start, agent_stop,
  // and cross-agent agent_restart the same as the self-restart it
  // was originally written for".
  it("round-trips agent_start through hostd when enabled", async () => {
    loadConfigMock.mockReturnValue({ host_control: { enabled: true } });
    hostdRequestMock.mockResolvedValue({
      v: 1,
      request_id: "test-start",
      result: "completed",
      exit_code: 0,
      duration_ms: 12,
    });
    const result = await tryHostdDispatch("klanker", {
      v: 1,
      op: "agent_start",
      request_id: "test-start",
      args: { name: "bob" },
    });
    expect(result).not.toBe("not-configured");
    expect((result as { result: string }).result).toBe("completed");
  });

  it("round-trips agent_stop through hostd when enabled", async () => {
    loadConfigMock.mockReturnValue({ host_control: { enabled: true } });
    hostdRequestMock.mockResolvedValue({
      v: 1,
      request_id: "test-stop",
      result: "completed",
      exit_code: 0,
      duration_ms: 8,
    });
    const result = await tryHostdDispatch("klanker", {
      v: 1,
      op: "agent_stop",
      request_id: "test-stop",
      args: { name: "bob" },
    });
    expect(result).not.toBe("not-configured");
    expect((result as { result: string }).result).toBe("completed");
  });

  it("round-trips cross-agent agent_restart through hostd when enabled", async () => {
    loadConfigMock.mockReturnValue({ host_control: { enabled: true } });
    hostdRequestMock.mockResolvedValue({
      v: 1,
      request_id: "test-rx",
      result: "started",
      exit_code: null,
      duration_ms: 2,
    });
    const result = await tryHostdDispatch("klanker", {
      v: 1,
      op: "agent_restart",
      request_id: "test-rx",
      args: { name: "bob", force: true, reason: "user: /restart bob from chat" },
    });
    expect(result).not.toBe("not-configured");
    expect((result as { result: string }).result).toBe("started");
  });
});

describe("pollHostdStatus() — long-running verb completion polling", () => {
  // Helper: zero-delay sleep so the polling loop drains instantly.
  const noSleep = (_ms: number) => Promise.resolve();
  let nowCursor = 0;
  const advancingNow = () => {
    nowCursor += 100;
    return nowCursor;
  };

  beforeEach(() => {
    nowCursor = 0;
  });

  it("returns the terminal response when get_status reaches completed", async () => {
    loadConfigMock.mockReturnValue({ host_control: { enabled: true } });
    hostdRequestMock
      .mockResolvedValueOnce({
        v: 1,
        request_id: "poll-1",
        result: "started",
        exit_code: null,
        duration_ms: 100,
      })
      .mockResolvedValueOnce({
        v: 1,
        request_id: "poll-2",
        result: "completed",
        exit_code: 0,
        duration_ms: 4_200,
      });
    const resp = await pollHostdStatus("klanker", "gw-update-abc", {
      timeoutMs: 60_000,
      intervalMs: 50,
      sleep: noSleep,
      now: advancingNow,
    });
    expect(resp).not.toBe("not-configured");
    expect((resp as { result: string }).result).toBe("completed");
  });

  it("returns the error response when the target request fails on the daemon", async () => {
    // The exact bug from the live repro: update_apply returns started,
    // then the recreate's image-pull fails on the daemon and the gateway
    // never finds out. With polling, the next tick returns the error
    // and the gateway can edit the ack.
    loadConfigMock.mockReturnValue({ host_control: { enabled: true } });
    hostdRequestMock.mockResolvedValueOnce({
      v: 1,
      request_id: "poll-err",
      result: "error",
      exit_code: 1,
      duration_ms: 5_000,
      error: "image pull failed: manifest unknown",
    });
    const resp = await pollHostdStatus("klanker", "gw-update-abc", {
      timeoutMs: 60_000,
      intervalMs: 50,
      sleep: noSleep,
      now: advancingNow,
    });
    expect(resp).not.toBe("not-configured");
    expect((resp as { result: string }).result).toBe("error");
    expect((resp as { error?: string }).error).toContain("image pull failed");
  });

  it("returns a synthesized error response on timeout", async () => {
    // started → started → started → … until deadline. Verifies the
    // caller gets a clear timeout reason instead of an indefinite hang.
    loadConfigMock.mockReturnValue({ host_control: { enabled: true } });
    hostdRequestMock.mockResolvedValue({
      v: 1,
      request_id: "poll-stuck",
      result: "started",
      exit_code: null,
      duration_ms: 100,
    });
    // Slow time so deadline hits after ~3 polls (interval 50 × now=100/tick).
    const resp = await pollHostdStatus("klanker", "gw-stuck-xyz", {
      timeoutMs: 200,
      intervalMs: 50,
      sleep: noSleep,
      now: advancingNow,
    });
    expect(resp).not.toBe("not-configured");
    expect((resp as { result: string }).result).toBe("error");
    expect((resp as { error?: string }).error).toMatch(/timeout/);
    expect((resp as { error?: string }).error).toMatch(/gw-stuck-xyz/);
  });

  it("returns 'not-configured' when hostd is disabled", async () => {
    loadConfigMock.mockReturnValue({ host_control: { enabled: false } });
    const resp = await pollHostdStatus("klanker", "gw-x", {
      timeoutMs: 1000,
      intervalMs: 50,
      sleep: noSleep,
      now: advancingNow,
    });
    expect(resp).toBe("not-configured");
  });

  it("returns 'not-configured' when socket disappears mid-poll", async () => {
    // Daemon was stopped during the verb. The gateway should bail
    // instead of looping forever on a vanished socket.
    loadConfigMock.mockReturnValue({ host_control: { enabled: true } });
    // First poll tick: socket gone.
    existsSyncMock.mockReturnValueOnce(true).mockReturnValue(false);
    const resp = await pollHostdStatus("klanker", "gw-x", {
      timeoutMs: 1000,
      intervalMs: 50,
      sleep: noSleep,
      now: advancingNow,
    });
    expect(resp).toBe("not-configured");
  });

  it("bails immediately when get_status says target_request_id is not visible", async () => {
    // No point retrying — the daemon explicitly said the request is
    // unknown / cross-agent restricted. Retrying just spams the audit log.
    loadConfigMock.mockReturnValue({ host_control: { enabled: true } });
    hostdRequestMock.mockResolvedValue({
      v: 1,
      request_id: "poll-notfound",
      result: "denied",
      exit_code: null,
      duration_ms: 1,
      error: "get_status: request_id not found or not visible to caller \"klanker\"",
    });
    const resp = await pollHostdStatus("klanker", "gw-vanished", {
      timeoutMs: 60_000,
      intervalMs: 50,
      sleep: noSleep,
      now: advancingNow,
    });
    expect(resp).not.toBe("not-configured");
    expect((resp as { result: string }).result).toBe("denied");
    // Bailed fast — only one wire call after the initial sleep, not many.
    expect(hostdRequestMock.mock.calls.length).toBe(1);
  });
});

describe("warnLegacySpawnIfHostdDisabled() — deprecation noise", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it("emits exactly one warning per verb per process", () => {
    loadConfigMock.mockReturnValue({ host_control: { enabled: false } });
    warnLegacySpawnIfHostdDisabled("agent_restart");
    warnLegacySpawnIfHostdDisabled("agent_restart");
    warnLegacySpawnIfHostdDisabled("agent_restart");
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(String(stderrSpy.mock.calls[0]?.[0])).toMatch(
      /spawnSwitchroomDetached\(agent_restart\)/,
    );
  });

  it("emits per distinct verb", () => {
    loadConfigMock.mockReturnValue({ host_control: { enabled: false } });
    warnLegacySpawnIfHostdDisabled("agent_restart");
    warnLegacySpawnIfHostdDisabled("update_apply");
    warnLegacySpawnIfHostdDisabled("agent_start");
    expect(stderrSpy).toHaveBeenCalledTimes(3);
  });

  it("is silent when hostd is enabled (no deprecation needed)", () => {
    loadConfigMock.mockReturnValue({ host_control: { enabled: true } });
    warnLegacySpawnIfHostdDisabled("agent_restart");
    warnLegacySpawnIfHostdDisabled("update_apply");
    expect(stderrSpy).not.toHaveBeenCalled();
  });
});

describe("regression — issue #1305 silent /update apply", () => {
  // Live repro 2026-05-14: /update apply from a DM stamped the
  // clean-shutdown marker, posted "🚀 update started" to chat, and
  // went silent — no fleet recreate ever happened, no error ever came
  // back. Root cause: gateway dispatched update_apply via hostd, got
  // result: "started", and returned without polling get_status. When
  // the daemon's mutation failed before recreate (image pull, scaffold
  // regen crash, etc.) the gateway stayed alive but never surfaced
  // anything to the operator. Polling closes that gap.
  //
  // This test wires the exact failure shape and asserts the helper
  // surfaces a usable terminal response that the gateway can edit
  // into the ack. Without the polling helper, the test couldn't even
  // express the bug — the gateway's only post-started behaviour was
  // `return`.
  const noSleep = (_ms: number) => Promise.resolve();
  let nowCursor = 0;
  const advancingNow = () => {
    nowCursor += 100;
    return nowCursor;
  };

  beforeEach(() => {
    nowCursor = 0;
  });

  it("surfaces image-pull failure as a terminal error response", async () => {
    loadConfigMock.mockReturnValue({ host_control: { enabled: true } });
    // 1. Gateway calls update_apply, daemon returns "started" (we
    //    simulate this happening before the polling test — the
    //    polling test starts AFTER the kickoff).
    // 2. Gateway polls get_status. Daemon reports the failure.
    hostdRequestMock.mockResolvedValueOnce({
      v: 1,
      request_id: "poll-1",
      result: "error",
      exit_code: 1,
      duration_ms: 5_120,
      error: "image pull failed: manifest unknown",
      stderr_tail:
        "Error response from daemon: manifest for " +
        "ghcr.io/switchroom/switchroom-agent:latest not found",
    });
    const terminal = await pollHostdStatus("klanker", "gw-update-2026-05-14", {
      timeoutMs: 60_000,
      intervalMs: 50,
      sleep: noSleep,
      now: advancingNow,
    });
    expect(terminal).not.toBe("not-configured");
    const t = terminal as {
      result: string;
      error?: string;
      stderr_tail?: string;
    };
    // The terminal response carries enough detail for the gateway
    // to edit the "🚀 update started" ack into a "❌ FAILED" message
    // with a stderr tail the operator can act on. This is the exact
    // payload the gateway's editMessageText wiring at gateway.ts
    // expects (see the polling block in the /update apply handler).
    expect(t.result).toBe("error");
    expect(t.error).toContain("image pull failed");
    expect(t.stderr_tail).toContain("manifest for");
  });
});

describe("withOperatorAttestation — gateway passphrase-forward (#1841)", () => {
  it("attaches the cached passphrase as operator_passphrase", () => {
    const req = {
      v: 1 as const,
      op: "update_apply" as const,
      request_id: "gw-1",
      args: {},
    };
    const out = withOperatorAttestation(req, "s3cret");
    expect(out.operator_passphrase).toBe("s3cret");
    // Pure — original request is not mutated.
    expect(
      (req as { operator_passphrase?: string }).operator_passphrase,
    ).toBeUndefined();
  });

  it("returns the request unchanged when no passphrase is cached", () => {
    const req = {
      v: 1 as const,
      op: "update_apply" as const,
      request_id: "gw-2",
      args: {},
    };
    expect(withOperatorAttestation(req, undefined)).toBe(req);
    expect(withOperatorAttestation(req, "")).toBe(req);
  });
});
