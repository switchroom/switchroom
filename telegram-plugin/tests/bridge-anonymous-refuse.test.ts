import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

/**
 * Bridge-side enforcement of #430. When SWITCHROOM_AGENT_NAME is
 * unset, the bridge must exit cleanly without connecting to the
 * gateway socket. The script logs a short stderr line explaining why
 * so an operator running a stray claude-code session knows what
 * happened.
 *
 * Test strategy: spawn `bun bridge.ts` with no agent name, assert
 * exit 0 and stderr contains the refusal line. We deliberately don't
 * test against a real gateway socket — the assertion is "exits before
 * trying to connect."
 */

const BRIDGE = resolve(__dirname, "..", "bridge", "bridge.ts");
const BUN = process.env.BUN_PATH ?? "bun";

function findBun(): string {
  if (process.env.BUN_PATH) return process.env.BUN_PATH;
  try {
    const r = spawnSync("which", ["bun"], { encoding: "utf-8" });
    return r.stdout.trim() || "bun";
  } catch {
    return "bun";
  }
}

describe("bridge.ts — refuses to start without SWITCHROOM_AGENT_NAME (#430)", () => {
  it("exits 0 and logs a refusal when SWITCHROOM_AGENT_NAME is unset", () => {
    const bun = findBun();
    const r = spawnSync(bun, ["run", BRIDGE], {
      env: {
        // Strip every var that might let it limp along.
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: process.env.HOME ?? "/tmp",
        // Pointing TELEGRAM_STATE_DIR at a fresh tmpdir avoids any
        // chance of probing a real gateway socket.
        TELEGRAM_STATE_DIR: "/tmp/__nonexistent_dir_for_bridge_test__",
        // Explicitly omit SWITCHROOM_AGENT_NAME.
      },
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
      timeout: 5_000,
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/SWITCHROOM_AGENT_NAME is not set/);
    expect(r.stderr).toMatch(/refusing to register/);
  });

  // Avoid a positive-path test here — actually starting the bridge
  // would make it block on stdin and try to connect to a gateway.
  // The validator unit tests cover what the gateway does with a
  // real bridge's register message; this file just owns the
  // "no name → no connect" assertion.

  void BUN; // Silence unused-import lint when BUN_PATH is set
});
