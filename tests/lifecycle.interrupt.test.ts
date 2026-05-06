import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SwitchroomConfig } from "../src/config/schema.js";

// Mock node:child_process so systemctl(...) calls are observable and
// don't escape the test. tmux.js is mocked separately so we can
// control sendAgentInterrupt's outcome per-case.
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock("../src/agents/tmux.js", () => ({
  sendAgentInterrupt: vi.fn(),
  captureAgentPane: vi.fn(),
}));

import { execFileSync } from "node:child_process";
import { sendAgentInterrupt } from "../src/agents/tmux.js";
import { interruptAgent } from "../src/agents/lifecycle.js";

const mockedExec = execFileSync as unknown as ReturnType<typeof vi.fn>;
const mockedSendInterrupt = sendAgentInterrupt as unknown as ReturnType<typeof vi.fn>;

/**
 * The lifecycle module's `getAgentStatus` shells out to systemctl
 * many times to compute its return value. We don't want to model
 * systemd here, so we just intercept all execFileSync invocations
 * and decide what to do based on argv.
 *
 *   - `systemctl is-active <unit>`     → "active"
 *   - `systemctl show ...`             → MainPID + ControlGroup synthetic data
 *   - `systemctl kill --signal=INT ...` → recorded for assertions, returns ""
 *   - anything else                    → ""
 */
function installSystemctlStub(opts: { killShouldThrow?: boolean } = {}): void {
  mockedExec.mockImplementation((bin: string, args: string[]) => {
    if (bin !== "systemctl") return "";
    if (args[0] === "--user" && args[1] === "is-active") return "active";
    if (args[0] === "--user" && args[1] === "show") {
      // Return a stub that getAgentStatus can parse → MainPID=4242
      return "MainPID=4242\nControlGroup=/user.slice/test\nMemoryCurrent=1024\nActiveEnterTimestampMonotonic=1\n";
    }
    if (args[0] === "--user" && args[1] === "kill") {
      if (opts.killShouldThrow) {
        throw new Error("Unit not loaded");
      }
      return "";
    }
    return "";
  });
}

function makeConfig(legacyPty: boolean): SwitchroomConfig {
  return {
    switchroom: { version: 1, agents_dir: "/tmp/agents", skills_dir: "/tmp/skills" },
    telegram: { bot_token: "123:abc" },
    defaults: {},
    profiles: {},
    agents: {
      klanker: {
        experimental: { legacy_pty: legacyPty },
      } as unknown as SwitchroomConfig["agents"][string],
    },
  } as unknown as SwitchroomConfig;
}

describe("interruptAgent dual-path", () => {
  beforeEach(() => {
    mockedExec.mockReset();
    mockedSendInterrupt.mockReset();
  });

  it("tmux-supervised agent: prefers tmux send-keys; does NOT fire systemctl kill on success", () => {
    installSystemctlStub();
    mockedSendInterrupt.mockReturnValue({ ok: true });

    const result = interruptAgent("klanker", { config: makeConfig(false) });

    expect(result.pid).toBe(4242);
    expect(mockedSendInterrupt).toHaveBeenCalledWith({ agentName: "klanker" });

    const killCalls = mockedExec.mock.calls.filter(
      (c) => c[0] === "systemctl" && (c[1] as string[])[1] === "kill",
    );
    expect(killCalls).toHaveLength(0);
  });

  it("tmux-supervised agent: falls back to systemctl kill when send-keys errors", () => {
    installSystemctlStub();
    mockedSendInterrupt.mockReturnValue({ error: "no server running" });

    const result = interruptAgent("klanker", { config: makeConfig(false) });

    expect(result.pid).toBe(4242);
    expect(mockedSendInterrupt).toHaveBeenCalledTimes(1);

    const killCalls = mockedExec.mock.calls.filter(
      (c) => c[0] === "systemctl" && (c[1] as string[])[1] === "kill",
    );
    expect(killCalls).toHaveLength(1);
    const args = killCalls[0]![1] as string[];
    expect(args).toContain("--signal=INT");
    expect(args).toContain("switchroom-klanker");
  });

  it("legacy_pty agent: bypasses tmux send-keys entirely and uses systemctl kill", () => {
    installSystemctlStub();
    mockedSendInterrupt.mockReturnValue({ ok: true });

    const result = interruptAgent("klanker", { config: makeConfig(true) });

    expect(result.pid).toBe(4242);
    expect(mockedSendInterrupt).not.toHaveBeenCalled();

    const killCalls = mockedExec.mock.calls.filter(
      (c) => c[0] === "systemctl" && (c[1] as string[])[1] === "kill",
    );
    expect(killCalls).toHaveLength(1);
  });

  it("logs the chosen route on the tmux path", () => {
    installSystemctlStub();
    mockedSendInterrupt.mockReturnValue({ ok: true });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      interruptAgent("klanker", { config: makeConfig(false) });
      const messages = logSpy.mock.calls.map((c) => String(c[0]));
      expect(messages.some((m) => /tmux send-keys C-c/.test(m))).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("logs the chosen route on the legacy_pty path", () => {
    installSystemctlStub();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      interruptAgent("klanker", { config: makeConfig(true) });
      const messages = logSpy.mock.calls.map((c) => String(c[0]));
      expect(
        messages.some((m) => /systemctl kill --signal=INT/.test(m)),
      ).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("logs the fallback when tmux send-keys errors", () => {
    installSystemctlStub();
    mockedSendInterrupt.mockReturnValue({ error: "no server running" });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      interruptAgent("klanker", { config: makeConfig(false) });
      const errMsgs = errSpy.mock.calls.map((c) => String(c[0]));
      expect(
        errMsgs.some((m) => /tmux send-keys failed.*falling back/.test(m)),
      ).toBe(true);
      const logMsgs = logSpy.mock.calls.map((c) => String(c[0]));
      expect(
        logMsgs.some((m) => /systemctl kill --signal=INT/.test(m)),
      ).toBe(true);
    } finally {
      errSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});
