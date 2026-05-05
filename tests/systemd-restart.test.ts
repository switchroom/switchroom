/**
 * Regression tests for issue #361: cgroup-escape via `script -qfc` PTY.
 *
 * Problem: ExecStart wraps claude (and gateway/foreman) in `/usr/bin/script
 * -qfc "..."`. The PTY layer detaches the child process from the systemd
 * unit's cgroup. When systemd restarts the unit it kills `script` but the
 * underlying process survives — confirmed 2026-04-29 when `ps` showed a
 * claude PID with start time Apr 17 while the service ActiveEnterTimestamp
 * was Apr 29 19:50. PR #358 merged, scaffold reconciled, agent restarted,
 * but Playwright MCP never loaded because the Apr 17 claude was still live.
 *
 * Fix: add KillMode=control-group / SendSIGKILL=yes / TimeoutStopSec=15
 * to every unit type. systemd then SIGTERMs every process in the cgroup
 * (including script's spawned children), waits TimeoutStopSec, and
 * SIGKILLs any survivors.
 *
 * These unit-level tests are the regression-catcher. They assert the
 * directives are present in ALL unit types so a future template edit
 * can't silently reintroduce the bug.
 */

import { describe, it, expect } from "vitest";
import {
  generateUnit,
  generateGatewayUnit,
  generateTimerServiceUnit,
  generateBrokerUnit,
  generateForemanUnit,
  generateAgentTmuxConf,
} from "../src/agents/systemd.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Extract the text between [Service] and the next section header. */
function serviceSection(unit: string): string {
  const after = unit.split("[Service]")[1];
  if (!after) throw new Error("No [Service] section found in unit");
  // Stop at the next `[…]` header (e.g. [Install])
  return after.split(/^\[/m)[0];
}

// ─── Agent unit ───────────────────────────────────────────────────────────────

describe("generateUnit — cgroup kill semantics (issue #361)", () => {
  const unit = generateUnit("clerk", "/tmp/clerk");
  const svc = serviceSection(unit);

  it("sets KillMode=control-group in [Service]", () => {
    expect(svc).toContain("KillMode=control-group");
  });

  it("sets KillSignal=SIGTERM in [Service]", () => {
    expect(svc).toContain("KillSignal=SIGTERM");
  });

  it("sets SendSIGKILL=yes in [Service]", () => {
    expect(svc).toContain("SendSIGKILL=yes");
  });

  it("sets TimeoutStopSec=15 in [Service]", () => {
    expect(svc).toContain("TimeoutStopSec=15");
  });

  it("preserves ExecStart with script -qfc (PTY must not be removed)", () => {
    expect(unit).toContain("ExecStart=/usr/bin/script -qfc");
  });

  it("preserves Restart=on-failure", () => {
    expect(svc).toContain("Restart=on-failure");
  });

  it("same kill semantics apply with useAutoaccept=true", () => {
    const autoUnit = generateUnit("clerk", "/tmp/clerk", true);
    const autoSvc = serviceSection(autoUnit);
    expect(autoSvc).toContain("KillMode=control-group");
    expect(autoSvc).toContain("SendSIGKILL=yes");
    expect(autoSvc).toContain("TimeoutStopSec=15");
    // PTY wrapper still present
    expect(autoUnit).toContain("autoaccept.exp");
  });
});

// ─── Gateway unit ─────────────────────────────────────────────────────────────

describe("generateGatewayUnit — cgroup kill semantics (issue #361)", () => {
  const unit = generateGatewayUnit("/tmp/clerk/telegram", "clerk");
  const svc = serviceSection(unit);

  it("sets KillMode=control-group in [Service]", () => {
    expect(svc).toContain("KillMode=control-group");
  });

  it("sets KillSignal=SIGTERM in [Service]", () => {
    expect(svc).toContain("KillSignal=SIGTERM");
  });

  it("sets SendSIGKILL=yes in [Service]", () => {
    expect(svc).toContain("SendSIGKILL=yes");
  });

  it("preserves TimeoutStopSec=45 for the 35s Telegram drain budget", () => {
    // The gateway needs 45s (35s drain + headroom) — do NOT reduce to 15s.
    expect(svc).toContain("TimeoutStopSec=45");
    expect(svc).not.toContain("TimeoutStopSec=15");
  });

  it("preserves ExecStart with script -qfc (PTY must not be removed)", () => {
    expect(unit).toContain("ExecStart=/usr/bin/script -qfc");
  });

  it("preserves Restart=always", () => {
    expect(svc).toContain("Restart=always");
  });

  it("smears restart timing with RandomizedDelaySec to avoid thundering herd", () => {
    expect(svc).toContain("RandomizedDelaySec=5");
  });
});

// ─── Foreman unit ─────────────────────────────────────────────────────────────

describe("generateForemanUnit — cgroup kill semantics (issue #361)", () => {
  const unit = generateForemanUnit();
  const svc = serviceSection(unit);

  it("sets KillMode=control-group in [Service]", () => {
    expect(svc).toContain("KillMode=control-group");
  });

  it("sets KillSignal=SIGTERM in [Service]", () => {
    expect(svc).toContain("KillSignal=SIGTERM");
  });

  it("sets SendSIGKILL=yes in [Service]", () => {
    expect(svc).toContain("SendSIGKILL=yes");
  });

  it("sets TimeoutStopSec=30 in [Service]", () => {
    expect(svc).toContain("TimeoutStopSec=30");
  });

  it("preserves ExecStart with script -qfc (PTY must not be removed)", () => {
    expect(unit).toContain("ExecStart=/usr/bin/script -qfc");
  });

  it("preserves Restart=always", () => {
    expect(svc).toContain("Restart=always");
  });

  it("smears restart timing with RandomizedDelaySec to avoid thundering herd", () => {
    expect(svc).toContain("RandomizedDelaySec=5");
  });
});

// ─── Broker unit ──────────────────────────────────────────────────────────────

describe("generateBrokerUnit — cgroup kill semantics (issue #361)", () => {
  const unit = generateBrokerUnit({
    homeDir: "/home/user",
    bunBinDir: "/home/user/.bun/bin",
  });
  const svc = serviceSection(unit);

  it("sets KillMode=control-group in [Service]", () => {
    expect(svc).toContain("KillMode=control-group");
  });

  it("sets KillSignal=SIGTERM in [Service]", () => {
    expect(svc).toContain("KillSignal=SIGTERM");
  });

  it("sets SendSIGKILL=yes in [Service]", () => {
    expect(svc).toContain("SendSIGKILL=yes");
  });

  it("sets TimeoutStopSec=15 in [Service]", () => {
    expect(svc).toContain("TimeoutStopSec=15");
  });

  it("preserves Restart=on-failure", () => {
    expect(svc).toContain("Restart=on-failure");
  });
});

// ─── Kill directives in [Service] not [Unit] ─────────────────────────────────

describe("kill directives placement — must be in [Service] not [Unit]", () => {
  it("agent unit: KillMode is in [Service], not [Unit]", () => {
    const unit = generateUnit("test", "/tmp/test");
    const unitSection = unit.split("[Service]")[0];
    expect(unitSection).not.toContain("KillMode");
    expect(serviceSection(unit)).toContain("KillMode=control-group");
  });

  it("gateway unit: KillMode is in [Service], not [Unit]", () => {
    const unit = generateGatewayUnit("/tmp/telegram", "test");
    const unitSection = unit.split("[Service]")[0];
    expect(unitSection).not.toContain("KillMode");
    expect(serviceSection(unit)).toContain("KillMode=control-group");
  });
});

// ─── Integration test (skipped unless RUN_SYSTEMD_INTEGRATION_TESTS=1) ───────
//
// This test scaffolds a real agent service, starts it, captures the claude
// PID, restarts the service via systemctl, and asserts the new claude PID
// differs from the old one — proving the cgroup kill actually terminated
// the old process rather than leaving it orphaned.
//
// It is SKIPPED by default because it requires:
//   - A systemd user session (--user)
//   - switchroom installed (switchroom agent scaffold …)
//   - The test runner to have permission to start/stop user services
//
// Enable in CI by setting RUN_SYSTEMD_INTEGRATION_TESTS=1.

// ─── tmux supervisor variants (issue #725 pre-fanout hardening) ──────────────
//
// When experimental.tmux_supervisor=true, the unit shape is materially
// different: ExecStart is `tmux ... new-session -A -d`, Type=forking,
// Delegate=yes, and ExecStop=-/usr/bin/tmux ... kill-session (with a
// leading dash to silence the FAILURE log on the migration restart). These
// tests assert the tmux shape survives unit re-renders so a future template
// edit can't silently revert the supervisor opt-in.

describe("generateUnit — tmux supervisor shape survives re-renders (#725)", () => {
  it("uses tmux new-session ExecStart when tmuxSupervisor=true", () => {
    const unit = generateUnit("clerk", "/tmp/clerk", false, undefined, undefined, true);
    expect(unit).toContain("/usr/bin/tmux -L switchroom-clerk");
    expect(unit).toContain("new-session -A -d -s clerk");
    // legacy script -qfc must NOT be the ExecStart under tmux supervisor
    const execStartLine = unit.split("\n").find((l) => l.startsWith("ExecStart=")) ?? "";
    expect(execStartLine).not.toContain("/usr/bin/script -qfc");
  });

  it("ExecStop has a leading dash to silence migration FAILURE", () => {
    const unit = generateUnit("clerk", "/tmp/clerk", false, undefined, undefined, true);
    // Critical: the dash makes systemd ignore non-zero exit when stopping
    // the OLD (script-wrapped) unit which has no tmux socket. Without it
    // the script→tmux migration restart logs FAILURE.
    expect(unit).toContain("ExecStop=-/usr/bin/tmux");
    expect(unit).toContain("kill-session -t clerk");
  });

  it("uses Type=forking + Delegate=yes for tmux supervisor", () => {
    const unit = generateUnit("clerk", "/tmp/clerk", false, undefined, undefined, true);
    const svc = serviceSection(unit);
    expect(svc).toContain("Type=forking");
    expect(svc).toContain("Delegate=yes");
  });

  it("includes ExecStartPost pipe-pane wiring to service.log", () => {
    const unit = generateUnit("klanker", "/tmp/klanker", false, undefined, undefined, true);
    expect(unit).toContain("ExecStartPost=/usr/bin/tmux");
    expect(unit).toContain("pipe-pane -o -t klanker");
  });

  it("preserves cgroup-kill semantics under tmux supervisor", () => {
    const unit = generateUnit("clerk", "/tmp/clerk", false, undefined, undefined, true);
    const svc = serviceSection(unit);
    expect(svc).toContain("KillMode=control-group");
    expect(svc).toContain("SendSIGKILL=yes");
    expect(svc).toContain("TimeoutStopSec=15");
  });

  it("identical input produces identical output across re-renders (deterministic)", () => {
    const u1 = generateUnit("ziggy", "/tmp/ziggy", true, "ziggy-gateway", "Australia/Sydney", true);
    const u2 = generateUnit("ziggy", "/tmp/ziggy", true, "ziggy-gateway", "Australia/Sydney", true);
    expect(u1).toBe(u2);
  });

  it("legacy path (tmuxSupervisor=false) still uses script -qfc", () => {
    const unit = generateUnit("clerk", "/tmp/clerk", false, undefined, undefined, false);
    expect(unit).toContain("ExecStart=/usr/bin/script -qfc");
    expect(unit).not.toContain("ExecStart=/usr/bin/tmux");
    expect(unit).not.toContain("ExecStop=-/usr/bin/tmux");
  });
});

describe("generateAgentTmuxConf — config regeneration is deterministic (#725)", () => {
  it("emits xterm-256color, history-limit, status off, remain-on-exit off", () => {
    const conf = generateAgentTmuxConf();
    expect(conf).toContain('default-terminal "xterm-256color"');
    expect(conf).toContain("history-limit 100000");
    expect(conf).toContain("status off");
    expect(conf).toContain("remain-on-exit off");
  });

  it("regenerates byte-identical content across calls (re-render safe)", () => {
    expect(generateAgentTmuxConf()).toBe(generateAgentTmuxConf());
  });
});

describe("generateGatewayUnit — tmux supervisor env propagation (#725)", () => {
  it("stamps SWITCHROOM_TMUX_SUPERVISOR=1 when flag is true", () => {
    const unit = generateGatewayUnit("/tmp/clerk/telegram", "clerk", false, true);
    expect(unit).toContain("Environment=SWITCHROOM_TMUX_SUPERVISOR=1");
  });

  it("omits SWITCHROOM_TMUX_SUPERVISOR when flag is false", () => {
    const unit = generateGatewayUnit("/tmp/clerk/telegram", "clerk", false, false);
    expect(unit).not.toContain("SWITCHROOM_TMUX_SUPERVISOR");
  });
});

// Removed: a long-broken stub gated on RUN_SYSTEMD_INTEGRATION_TESTS=1
// that threw unconditionally rather than implementing the PID-change
// assertion. Real systemd-interaction coverage now lives in
// `tests/cgroup-kill.integration.test.ts`.
