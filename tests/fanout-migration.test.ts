/**
 * Fanout migration test (#725 pre-fanout hardening).
 *
 * Verifies the legacy → tmux-supervisor unit transition produces the
 * expected ExecStart + ExecStop string shapes. Pure unit test — no
 * real systemctl. Captures the migration sequence we expect during
 * fleet rollout: legacy ExecStart switches to tmux ExecStart, and the
 * new ExecStop carries a leading dash so the FIRST restart (which
 * stops the OLD script-wrapped process that has no tmux socket) does
 * not log FAILURE.
 */

import { describe, it, expect } from "vitest";
import {
  generateUnit,
  generateGatewayUnit,
} from "../src/agents/systemd.js";

function execStart(unit: string): string {
  const line = unit.split("\n").find((l) => l.startsWith("ExecStart="));
  return line ?? "";
}

function execStop(unit: string): string {
  const line = unit.split("\n").find((l) => l.startsWith("ExecStop="));
  return line ?? "";
}

describe("fanout migration: legacy → tmux supervisor", () => {
  it("legacy unit uses script -qfc and has no ExecStop line", () => {
    const legacy = generateUnit("clerk", "/tmp/clerk", false, undefined, undefined, false);
    const start = execStart(legacy);
    expect(start).toContain("/usr/bin/script -qfc");
    expect(start).toContain("/bin/bash -l /tmp/clerk/start.sh");
    // Legacy units have no explicit ExecStop — systemd's default
    // KillMode=control-group handles termination.
    expect(execStop(legacy)).toBe("");
  });

  it("tmux unit uses tmux new-session and has dashed ExecStop", () => {
    const tmuxUnit = generateUnit("clerk", "/tmp/clerk", false, undefined, undefined, true);
    const start = execStart(tmuxUnit);
    expect(start).toContain("/usr/bin/tmux -L switchroom-clerk");
    expect(start).toContain("new-session -A -d -s clerk");
    expect(start).not.toContain("/usr/bin/script -qfc");

    // CRITICAL — leading dash on ExecStop. Without it, the first
    // migration restart logs FAILURE because the OLD unit (still
    // running script -qfc) has no tmux socket; kill-session exits
    // non-zero and systemd marks the unit failed even though
    // everything worked. The dash silences that one-shot transition.
    const stop = execStop(tmuxUnit);
    expect(stop).toContain("ExecStop=-/usr/bin/tmux");
    expect(stop).toContain("kill-session -t clerk");
  });

  it("autoaccept legacy → tmux: ExecStart wraps autoaccept.exp under both shapes", () => {
    const legacy = generateUnit("clerk", "/tmp/clerk", true, "clerk-gateway", undefined, false);
    const tmuxUnit = generateUnit("clerk", "/tmp/clerk", true, "clerk-gateway", undefined, true);
    expect(execStart(legacy)).toContain("autoaccept.exp");
    expect(execStart(legacy)).toContain("/usr/bin/script -qfc");
    expect(execStart(tmuxUnit)).toContain("autoaccept.exp");
    expect(execStart(tmuxUnit)).toContain("/usr/bin/tmux -L switchroom-clerk");
  });

  it("gateway unit picks up SWITCHROOM_TMUX_SUPERVISOR=1 only when flag is true", () => {
    const off = generateGatewayUnit("/tmp/x/telegram", "x", false, false);
    const on = generateGatewayUnit("/tmp/x/telegram", "x", false, true);
    expect(off).not.toContain("SWITCHROOM_TMUX_SUPERVISOR");
    expect(on).toContain("Environment=SWITCHROOM_TMUX_SUPERVISOR=1");
    // Gateway ExecStart shape doesn't change between the two — only
    // the env block — so re-installing the gateway on flip is a
    // no-op for the long-poll connection.
    expect(execStart(off)).toBe(execStart(on));
  });

  it("migration sequence (snapshot) — legacy → tmux ExecStart shapes", () => {
    const legacy = execStart(generateUnit("ziggy", "/home/u/.switchroom/agents/ziggy", false, undefined, undefined, false));
    const tmuxUnit = execStart(generateUnit("ziggy", "/home/u/.switchroom/agents/ziggy", false, undefined, undefined, true));

    expect({ legacy, tmuxUnit }).toMatchInlineSnapshot(`
      {
        "legacy": "ExecStart=/usr/bin/script -qfc "/bin/bash -l /home/u/.switchroom/agents/ziggy/start.sh" /home/u/.switchroom/agents/ziggy/service.log",
        "tmuxUnit": "ExecStart=/usr/bin/tmux -L switchroom-ziggy -f /home/u/.switchroom/agents/ziggy/tmux.conf new-session -A -d -s ziggy -x 400 -y 50 'bash -l /home/u/.switchroom/agents/ziggy/start.sh'",
      }
    `);
  });
});
