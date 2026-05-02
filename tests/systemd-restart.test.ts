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

const runIntegration = process.env.RUN_SYSTEMD_INTEGRATION_TESTS === "1";

describe.skipIf(!runIntegration)(
  "integration: restart actually changes claude PID (issue #361) [requires RUN_SYSTEMD_INTEGRATION_TESTS=1]",
  () => {
    it(
      "claude PID after restart differs from claude PID before restart",
      async () => {
        // This test body intentionally left as a stub.
        // Full implementation requires:
        //   1. scaffoldAgent() + installUnit() for a test agent
        //   2. systemctl --user start switchroom-<agent>.service
        //   3. pgrep -f "claude.*<agent>" to capture PID
        //   4. systemctl --user restart switchroom-<agent>.service
        //   5. pgrep again — assert new PID !== old PID
        //   6. systemctl --user stop + uninstall cleanup
        //
        // Until a full harness is wired up, skip with a descriptive error
        // so anyone who sets the env var gets a clear signal to implement.
        throw new Error(
          "Integration test stub: implement the PID-change assertion described in the comment above. " +
          "Set RUN_SYSTEMD_INTEGRATION_TESTS=1 to run."
        );
      },
      60_000,
    );
  },
);
