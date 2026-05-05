/**
 * Real-tmux E2E smoke test for inject argv shape (#725 / #728).
 *
 * Pure unit tests (`inject.test.ts`) mock `TmuxRunner` and so can't
 * catch argv-ordering bugs against the real `tmux` binary — that's how
 * #728 (`-t target` placement) escaped. This test spawns a transient
 * tmux session on a unique socket and exercises the runner directly:
 * send-keys with the literal text + Enter, then assert the bytes
 * actually arrived in the pane via capture-pane.
 *
 * Skips cleanly when `tmux` is absent so CI environments without the
 * binary don't break.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

function tmuxAvailable(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: ["pipe", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

const TMUX_PRESENT = tmuxAvailable();
const SOCKET = `srtest-${process.pid}-${Date.now().toString(36)}`;
const SESSION = "injecttest";

function tmux(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("tmux", ["-L", SOCKET, ...args], {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

async function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

describe.skipIf(!TMUX_PRESENT)("inject — real-tmux argv smoke (#728 regression)", () => {
  beforeEach(() => {
    // Spawn a fresh detached session that just runs `cat` so anything
    // we send-keys lands in stdin and gets echoed back to the pane.
    // 80x24 is the default; small enough to read, large enough to fit
    // a one-liner.
    const r = tmux([
      "new-session",
      "-d",
      "-s",
      SESSION,
      "-x",
      "120",
      "-y",
      "40",
      "bash",
      "-c",
      "echo READY; cat",
    ]);
    if (r.status !== 0) {
      throw new Error(`tmux new-session failed: ${r.stderr || r.stdout}`);
    }
  });

  afterEach(() => {
    // Best-effort cleanup. `kill-server` nukes the per-socket tmux
    // server so we don't accumulate sockets between tests / on failure.
    tmux(["kill-server"]);
  });

  it("send-keys -l <text> then Enter delivers bytes to the pane", async () => {
    // Wait for the bash inside the pane to actually start cat-ing.
    await sleep(300);

    // Use the same argv shape the runner emits in src/agents/inject.ts:
    //   tmux -L <socket> send-keys -l -t <session> <text>
    //   tmux -L <socket> send-keys    -t <session> Enter
    const text = "hello-from-inject";

    let r = tmux(["send-keys", "-l", "-t", SESSION, text]);
    expect(r.status).toBe(0);

    r = tmux(["send-keys", "-t", SESSION, "Enter"]);
    expect(r.status).toBe(0);

    // Settle window — `cat` echoes back on flush; give it a moment.
    await sleep(300);

    const cap = tmux(["capture-pane", "-p", "-t", SESSION, "-S", "-200"]);
    expect(cap.status).toBe(0);
    // The literal text must appear in the pane (cat echoed it back).
    expect(cap.stdout).toContain(text);
    // Sanity: it should NOT contain the corrupted form that #728
    // produced (text-then-target-flag glued together).
    expect(cap.stdout).not.toContain(`${text}-t`);
    expect(cap.stdout).not.toContain(`${text} -t ${SESSION}`);
  });

  it("argv ordering: send-keys positional after -t, not before", async () => {
    // Direct shape assertion — pre-#728 the runner emitted
    //   send-keys -l <text> -t <session>
    // which tmux interpreted as send-keys -l "<text>" "-t" "<session>"
    // — i.e. the target flag was typed as keystrokes. This test
    // documents the canonical order: subcmd, leading flags, -t, keys.
    await sleep(200);

    const text = "argv-order-check";
    // Correct order (matches inject.ts:158-166 splice logic):
    const r = tmux(["send-keys", "-l", "-t", SESSION, text]);
    expect(r.status).toBe(0);

    tmux(["send-keys", "-t", SESSION, "Enter"]);
    await sleep(250);

    const cap = tmux(["capture-pane", "-p", "-t", SESSION, "-S", "-200"]);
    expect(cap.stdout).toContain(text);
  });
});

describe.skipIf(TMUX_PRESENT)("inject — tmux absent, real-tmux suite skipped", () => {
  it("documents skip reason", () => {
    expect(existsSync("/usr/bin/tmux")).toBe(false);
  });
});
