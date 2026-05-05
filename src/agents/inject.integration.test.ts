/**
 * Real-tmux E2E test for inject runner (#725 / #728).
 *
 * Pure unit tests (`inject.test.ts`) mock `TmuxRunner` and so can't
 * catch argv-ordering bugs against the real `tmux` binary — that's how
 * #728 (`-t target` placement) escaped. This file pairs two checks:
 *
 *  1) An argv-shape pre-check that drives raw `spawnSync` directly to
 *     confirm tmux's own grammar still accepts the canonical order.
 *  2) The load-bearing test: drive the production `makeTmuxRunner`
 *     factory itself against a real transient tmux session. A
 *     regression of the splice fix in `src/agents/inject.ts` would
 *     fail this test because the literal payload would be corrupted
 *     with a glued-on `-t<session>` suffix when typed into the pane.
 *
 * Skips cleanly when `tmux` is absent so CI environments without the
 * binary don't break.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { makeTmuxRunner } from "./inject.js";

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

  it("argv-shape pre-check: send-keys -l -t <session> <text> + Enter delivers bytes", async () => {
    // Fast pre-check — directly exercises tmux grammar (no runner) so
    // a tmux upgrade that changes argv parsing surfaces with a clear
    // failure here before the runner-level test below.
    await sleep(300);

    const text = "hello-from-inject";

    let r = tmux(["send-keys", "-l", "-t", SESSION, text]);
    expect(r.status).toBe(0);

    r = tmux(["send-keys", "-t", SESSION, "Enter"]);
    expect(r.status).toBe(0);

    await sleep(300);

    const cap = tmux(["capture-pane", "-p", "-t", SESSION, "-S", "-200"]);
    expect(cap.status).toBe(0);
    expect(cap.stdout).toContain(text);
    expect(cap.stdout).not.toContain(`${text}-t`);
    expect(cap.stdout).not.toContain(`${text} -t ${SESSION}`);
  });

  it("makeTmuxRunner.send delivers literal slash payload + Enter to pane (#728 regression)", async () => {
    // Load-bearing assertion: drive the same factory production uses.
    // If the splice in inject.ts:158-166 regresses, the pane would
    // receive `/test-payload-tinjecttest` instead of `/test-payload`.
    await sleep(300);

    const runner = makeTmuxRunner("tmux");

    // Sanity: hasSession returns true for a session that exists.
    expect(runner.hasSession(SOCKET, SESSION)).toBe(true);

    const payload = "/test-payload";
    runner.send(SOCKET, SESSION, ["send-keys", "-l", payload]);
    runner.send(SOCKET, SESSION, ["send-keys", "Enter"]);

    await sleep(300);

    const captured = runner.capture(SOCKET, SESSION) ?? "";

    // The literal slash payload must appear, with no -t/session
    // contamination glued on.
    expect(captured).toContain(payload);
    expect(captured).not.toContain(`${payload}-t`);
    expect(captured).not.toContain(`${payload}-t${SESSION}`);
    expect(captured).not.toContain(`${payload} -t ${SESSION}`);
    expect(captured).not.toContain(`${payload}-tinjecttest`);
  });
});

describe.skipIf(TMUX_PRESENT)("inject — tmux absent, real-tmux suite skipped", () => {
  it("documents skip reason", () => {
    expect(existsSync("/usr/bin/tmux")).toBe(false);
  });
});
