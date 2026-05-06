/**
 * Default-flip migration test (#725 PR-1).
 *
 * As of PR-1 the tmux supervisor is the production default — agents that
 * previously had `experimental.tmux_supervisor: true` no longer need to
 * declare anything, and agents on hosts without tmux opt out via
 * `experimental.legacy_pty: true`.
 *
 * Verifies the default ExecStart shape is tmux, and that legacy_pty=true
 * still yields the historical `script -qfc` shape (rollback path).
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

describe("default-flip: tmux supervisor is the default", () => {
  it("default unit (no flag) uses tmux new-session and dashed ExecStop", () => {
    const def = generateUnit("clerk", "/tmp/clerk");
    const start = execStart(def);
    expect(start).toContain("/usr/bin/tmux -L switchroom-clerk");
    expect(start).toContain("new-session -A -d -s clerk");
    expect(start).not.toContain("/usr/bin/script -qfc");

    // CRITICAL — leading dash on ExecStop. Without it, the first
    // migration restart (where the OLD running unit is still
    // script -qfc) would log FAILURE because kill-session against a
    // missing socket exits non-zero. The dash silences that one-shot.
    const stop = execStop(def);
    expect(stop).toContain("ExecStop=-/usr/bin/tmux");
    expect(stop).toContain("kill-session -t clerk");
  });

  it("legacy_pty=true unit uses script -qfc and has no ExecStop line", () => {
    const legacy = generateUnit("clerk", "/tmp/clerk", false, undefined, undefined, true);
    const start = execStart(legacy);
    expect(start).toContain("/usr/bin/script -qfc");
    expect(start).toContain("/bin/bash -l /tmp/clerk/start.sh");
    expect(execStop(legacy)).toBe("");
  });

  it("autoaccept default → legacy: ExecStart wraps autoaccept.exp under both shapes", () => {
    const def = generateUnit("clerk", "/tmp/clerk", true, "clerk-gateway");
    const legacy = generateUnit("clerk", "/tmp/clerk", true, "clerk-gateway", undefined, true);
    expect(execStart(def)).toContain("autoaccept.exp");
    expect(execStart(def)).toContain("/usr/bin/tmux -L switchroom-clerk");
    expect(execStart(legacy)).toContain("autoaccept.exp");
    expect(execStart(legacy)).toContain("/usr/bin/script -qfc");
  });

  it("gateway unit stamps SWITCHROOM_TMUX_SUPERVISOR=1 by default; omits under legacy_pty", () => {
    const def = generateGatewayUnit("/tmp/x/telegram", "x", false, false);
    const legacy = generateGatewayUnit("/tmp/x/telegram", "x", false, true);
    expect(def).toContain("Environment=SWITCHROOM_TMUX_SUPERVISOR=1");
    expect(legacy).not.toContain("SWITCHROOM_TMUX_SUPERVISOR");
    // Gateway ExecStart shape doesn't change between modes — only the env
    // block — so flipping the flag is a no-op for the long-poll connection.
    expect(execStart(def)).toBe(execStart(legacy));
  });

  it("snapshot — default tmux ExecStart vs legacy_pty ExecStart shapes", () => {
    const tmuxUnit = execStart(generateUnit("ziggy", "/home/u/.switchroom/agents/ziggy"));
    const legacy = execStart(generateUnit("ziggy", "/home/u/.switchroom/agents/ziggy", false, undefined, undefined, true));

    expect({ tmuxUnit, legacy }).toMatchInlineSnapshot(`
      {
        "legacy": "ExecStart=/usr/bin/script -qfc "/bin/bash -l /home/u/.switchroom/agents/ziggy/start.sh" /home/u/.switchroom/agents/ziggy/service.log",
        "tmuxUnit": "ExecStart=/usr/bin/tmux -L switchroom-ziggy -f /home/u/.switchroom/agents/ziggy/tmux.conf new-session -A -d -s ziggy -x 400 -y 50 'bash -l /home/u/.switchroom/agents/ziggy/start.sh'",
      }
    `);
  });
});
