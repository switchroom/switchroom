import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  TIMER_UNIT,
  installSelfHealTimer,
  renderService,
  renderTimer,
  resolveOperatorUser,
  type InstallTimerDeps,
} from "./install-timer.js";

/**
 * The self-heal timer IS the mechanism that makes a shipped release converge the
 * host binary automatically, so these tests assert OUTCOMES: which bytes land in
 * /etc/systemd/system, that the timer is enabled, and that the unsafe hosts write
 * NOTHING and instead emit a manual fallback. Every property is one of the ways
 * this could silently install a timer that never heals (root user, wrong flag,
 * disabled).
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sh-timer-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const BIN = "/usr/local/bin/switchroom";

describe("renderService", () => {
  const out = renderService({ binary: BIN, user: "alice", home: "/home/alice" });

  it("is a oneshot that runs `update --skip-images` — self-heal still self-updates the binary", () => {
    expect(out).toContain("Type=oneshot");
    // --skip-images keeps the tick cheap but DOES run self-update-cli; only
    // --skip-self-update would skip the host-binary swap (update.ts).
    expect(out).toContain(`ExecStart=${BIN} update --skip-images`);
    expect(out).not.toContain("--skip-self-update");
  });

  it("runs as the resolved operator, never root", () => {
    expect(out).toContain("User=alice");
    expect(out).not.toContain("User=root");
  });

  it("pins HOME when resolvable, omits it otherwise", () => {
    expect(out).toContain("Environment=HOME=/home/alice");
    expect(renderService({ binary: BIN, user: "ada" })).not.toContain("Environment=HOME=");
  });

  it("ends with a newline", () => {
    expect(out.endsWith("\n")).toBe(true);
  });
});

describe("renderTimer", () => {
  const out = renderTimer();
  it("fires 5min after boot then every 30min, jittered, persistent, in timers.target", () => {
    expect(out).toContain("OnBootSec=5min");
    expect(out).toContain("OnUnitActiveSec=30min");
    expect(out).toContain("RandomizedDelaySec=2min");
    expect(out).toContain("Persistent=true");
    expect(out).toContain("WantedBy=timers.target");
  });
});

describe("resolveOperatorUser — mirrors the cron --cron-user resolution", () => {
  it("prefers SUDO_USER (the real user under `sudo switchroom update`)", () => {
    expect(resolveOperatorUser({ SUDO_USER: "ken", USER: "root" })).toBe("ken");
  });
  it("falls back to USER then LOGNAME", () => {
    expect(resolveOperatorUser({ USER: "ada" })).toBe("ada");
    expect(resolveOperatorUser({ LOGNAME: "grace" })).toBe("grace");
  });
  it("refuses root and empty — the exact value that would no-op forever", () => {
    expect(resolveOperatorUser({ SUDO_USER: "root" })).toBeNull();
    expect(resolveOperatorUser({})).toBeNull();
  });
});

/** A deps bundle for the happy path with injectable IO. */
function happyDeps(overrides: Partial<InstallTimerDeps> = {}): {
  deps: InstallTimerDeps;
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    deps: {
      env: { SUDO_USER: "alice", SWITCHROOM_BINARY: BIN },
      systemdBooted: () => true,
      geteuid: () => 0,
      homeForUser: () => "/home/alice",
      runner: (cmd, args) => {
        calls.push([cmd, ...args]);
        return { status: 0 };
      },
      servicePath: join(dir, "switchroom-self-heal.service"),
      timerPath: join(dir, "switchroom-self-heal.timer"),
      ...overrides,
    },
  };
}

describe("installSelfHealTimer — systemd present + privileged", () => {
  it("writes both units with the resolved non-root User= and enables the timer", () => {
    const { deps, calls } = happyDeps();
    const res = installSelfHealTimer(deps);

    expect(res.status).toBe("installed");
    // Both units landed on disk.
    const svc = readFileSync(deps.servicePath!, "utf8");
    const tim = readFileSync(deps.timerPath!, "utf8");
    expect(svc).toContain("User=alice");
    expect(svc).not.toContain("User=root");
    expect(svc).toContain(`ExecStart=${BIN} update --skip-images`);
    expect(tim).toContain("OnUnitActiveSec=30min");
    expect(statSync(deps.servicePath!).mode & 0o777).toBe(0o644);

    // The timer was reloaded and enabled --now.
    expect(calls).toEqual([
      ["systemctl", "daemon-reload"],
      ["systemctl", "enable", "--now", TIMER_UNIT],
    ]);
  });

  it("is idempotent: a re-run rewrites nothing and reports unchanged", () => {
    const { deps } = happyDeps();
    expect(installSelfHealTimer(deps).status).toBe("installed");
    const res2 = installSelfHealTimer(deps);
    expect(res2.status).toBe("unchanged");
  });

  it("throws (non-fatal to the caller) when systemctl enable fails", () => {
    const { deps } = happyDeps({
      runner: (cmd, args) =>
        args.includes("enable") ? { status: 1 } : { status: 0 },
    });
    expect(() => installSelfHealTimer(deps)).toThrow(/enable --now/);
  });
});

describe("installSelfHealTimer — graceful skip writes NOTHING + emits a fallback", () => {
  it("skips when the host is not systemd-booted", () => {
    const { deps, calls } = happyDeps({ systemdBooted: () => false });
    const res = installSelfHealTimer(deps);
    expect(res.status).toBe("skipped");
    expect(res.reason).toMatch(/systemd/i);
    // Nothing written, nothing run.
    expect(() => statSync(deps.servicePath!)).toThrow();
    expect(() => statSync(deps.timerPath!)).toThrow();
    expect(calls).toEqual([]);
    // The manual fallback is fully populated so the operator can install by hand.
    expect(res.serviceContent).toContain("ExecStart=");
    expect(res.timerContent).toContain("OnUnitActiveSec=30min");
    expect(res.manualCommands).toEqual([
      "sudo systemctl daemon-reload",
      `sudo systemctl enable --now ${TIMER_UNIT}`,
    ]);
  });

  it("skips (writes nothing) when unprivileged", () => {
    const { deps, calls } = happyDeps({ geteuid: () => 1000 });
    const res = installSelfHealTimer(deps);
    expect(res.status).toBe("skipped");
    expect(res.reason).toMatch(/privileged/i);
    expect(() => statSync(deps.servicePath!)).toThrow();
    expect(calls).toEqual([]);
  });

  it("skips (never installs a root timer) when no non-root operator resolves", () => {
    const { deps } = happyDeps({ env: { SUDO_USER: "root", SWITCHROOM_BINARY: BIN } });
    const res = installSelfHealTimer(deps);
    expect(res.status).toBe("skipped");
    expect(res.reason).toMatch(/operator user/i);
    // Even the fallback message renders a placeholder, never root.
    expect(res.serviceContent).not.toContain("User=root");
    expect(() => statSync(deps.servicePath!)).toThrow();
  });

  it("skips when the binary path is not absolute", () => {
    const { deps } = happyDeps({ env: { SUDO_USER: "ken", SWITCHROOM_BINARY: "switchroom" } });
    const res = installSelfHealTimer(deps);
    expect(res.status).toBe("skipped");
    expect(res.reason).toMatch(/absolute/i);
  });
});
