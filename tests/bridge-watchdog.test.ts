import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Regression tests for the bash bridge-watchdog.sh. We can't easily
 * unit-test bash, but we can pin the critical pieces of the script
 * that an accidental refactor could break:
 *   - Agent discovery is dynamic (no hardcoded agent names).
 *   - The script derives the gateway log path from the unit's
 *     WorkingDirectory (survives rename / new-agent scenarios).
 *   - Defensive exits (no-active-gateways, missing log, inactive
 *     agent) are in place.
 *
 * These tests are static-analysis flavour; they lock down behaviours
 * the production incident on 2026-04-21 showed can silently regress.
 */
const scriptPath = resolve(__dirname, "..", "bin", "bridge-watchdog.sh");
const script = readFileSync(scriptPath, "utf8");

describe("bridge-watchdog.sh — dynamic agent discovery (regression guard)", () => {
  it("does NOT hardcode any agent names in an AGENTS= array", () => {
    // The 2026-04-21 incident: a hardcoded AGENTS=(assistant klanker)
    // array silently skipped clerk (renamed from assistant) and
    // lawgpt (new agent). Both were stuck for hours.
    //
    // Match any '<agent>:<path>' colon-pair entry inside an array —
    // that was the shape of the old list.
    expect(script).not.toMatch(/AGENTS=\(/);
    expect(script).not.toMatch(/"(assistant|clerk|klanker|lawgpt):/);
  });

  it("discovers agents via systemctl list-units with the switchroom-*-gateway pattern", () => {
    expect(script).toContain("systemctl --user list-units");
    expect(script).toMatch(/switchroom-\.\+-gateway\\.service/);
  });

  it("derives the gateway log path from the unit's WorkingDirectory (not hardcoded)", () => {
    // WorkingDirectory is set by generateGatewayUnit in src/agents/systemd.ts.
    // Using it keeps the watchdog in sync with whatever the unit generator
    // produces, across agent renames and multi-root deployments (klanker
    // lives under .switchroom-klanker/).
    expect(script).toMatch(/WorkingDirectory/);
    expect(script).toMatch(/gateway_log=.*gateway\.log/);
  });

  it("strips the switchroom- prefix and -gateway.service suffix to get agent names", () => {
    expect(script).toMatch(/agent="\$\{gateway_svc#switchroom-\}"/);
    expect(script).toMatch(/agent="\$\{agent%-gateway\.service\}"/);
  });

  it("exits cleanly when no gateway services are active (no error spam in deploys)", () => {
    expect(script).toMatch(/gateway_services\[@\]\}.*eq 0/);
    expect(script).toMatch(/exit 0/);
  });

  it("heals agents whose agent service is inactive (start them, don't silently skip)", () => {
    // Regression: 2026-04-22 incident #2. clerk's start.sh exited with
    // status=0/SUCCESS (clean exit, not a crash). Restart=on-failure
    // doesn't restart on clean exits. Previous watchdog skipped
    // inactive services entirely. Result: agent dead indefinitely
    // while the gateway stayed up.
    expect(script).toMatch(/systemctl --user is-active --quiet.*\$agent_svc/);
    expect(script).toMatch(/systemctl --user start "\$agent_svc"/);
    expect(script).toMatch(/agent service is inactive/);
  });

  it("does NOT restart an agent in 'failed' state (needs operator reset-failed)", () => {
    expect(script).toMatch(/\[\[ "\$state" == "failed" \]\]/);
    expect(script).toMatch(/needs operator reset-failed/);
  });

  it("uses strings(1) to bypass PTY control codes in the gateway log", () => {
    // The gateway runs under `script -qfc` which adds TTY escape codes
    // to the log; grep alone would miss 'bridge registered' lines
    // wrapped in escape sequences.
    expect(script).toMatch(/strings.*gateway_log/);
  });

  it("treats no-bridge-events as unhealthy (heals cold-start gateway bugs)", () => {
    // If the gateway has been up but the bridge never connected, we
    // still want to restart the agent. The 2026-04-21 incident also
    // showed a stuck agent's log had zero bridge events.
    expect(script).toMatch(/-z "\$last_bridge_event".*false/s);
  });

  it("uses set -euo pipefail (safe bash)", () => {
    expect(script).toMatch(/set -euo pipefail/);
  });

  it("is still executable (chmod +x preserved)", () => {
    const stat = require("node:fs").statSync(scriptPath);
    // 0o100 bit = executable by owner.
    expect(stat.mode & 0o100).toBeTruthy();
  });
});
