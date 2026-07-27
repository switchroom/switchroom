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
 *
 * Socket discipline (#3733): every test case gets its OWN tmux socket
 * name. Sharing one socket across cases means `afterEach`'s teardown
 * races the next `beforeEach`'s `new-session` — the teardown request
 * returns to the client while the server is still unwinding and
 * unlinking its socket, so the next connect on that same name can hit
 * a mid-shutdown server and die with `server exited unexpectedly`
 * before any assertion runs. That reddened `main` on a diff touching
 * no tmux code. A distinct socket per case removes the race by
 * construction rather than by sleeping or retrying — no `new-session`
 * ever addresses a socket name a previous case has already used. Note
 * that per-case `kill-session` is NOT a fix: killing a server's last
 * session terminates the server too, so the same shutdown race
 * survives, just with a different trigger.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
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
const SOCKET_PREFIX = `srtest-${process.pid}-${Date.now().toString(36)}`;
const SESSION = "injecttest";

/** Sockets handed out so far — the uniqueness invariant is asserted, not assumed. */
const usedSockets = new Set<string>();
let socketSeq = 0;
/** Socket for the case currently running; set by `beforeEach`, cleared by `afterEach`. */
let socket = "";

function nextSocket(): string {
  socketSeq += 1;
  return `${SOCKET_PREFIX}-${socketSeq}`;
}

/** Path tmux uses for a `-L <name>` socket, so teardown can unlink the stale file. */
function socketPath(name: string): string {
  const base = process.env.TMUX_TMPDIR || "/tmp";
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return join(base, `tmux-${uid}`, name);
}

function tmuxOn(
  sock: string,
  args: string[],
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("tmux", ["-L", sock, ...args], {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Run tmux against the socket owned by the current test case. */
function tmux(args: string[]): { status: number | null; stdout: string; stderr: string } {
  if (!socket) throw new Error("tmux() called outside a test case — no socket assigned");
  return tmuxOn(socket, args);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * True once no tmux server answers on `sock`. Polls rather than probing
 * once: `kill-server` returns to the client while the server is still
 * unwinding, so a single immediate probe would be the very race this
 * file is fixing. Bounded so a genuinely stray server still fails.
 */
function socketIsDead(sock: string, timeoutMs = 3000): boolean {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (tmuxOn(sock, ["has-session", "-t", SESSION]).status !== 0) return true;
    if (Date.now() >= deadline) return false;
    // spawnSync round-trip is itself the pause; no busy-spin needed.
    spawnSync("sleep", ["0.05"]);
  }
}

describe.skipIf(!TMUX_PRESENT)("inject — real-tmux argv smoke (#728 regression)", () => {
  beforeEach(() => {
    // #3733 invariant: this case must not reuse a previous case's
    // socket generation. Under the old shared-socket fixture this
    // assertion fails from the second case onward.
    socket = nextSocket();
    expect(usedSockets.has(socket)).toBe(false);
    usedSockets.add(socket);

    // Assigning `socket` BEFORE spawning matters: vitest still runs
    // `afterEach` when `beforeEach` throws, so a failed spawn can't
    // leave a stray server behind on this socket.
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
    // Best-effort cleanup. `kill-server` nukes this case's tmux server
    // so we don't accumulate servers between tests / on failure. No
    // later case addresses this socket name again, so nothing races
    // the shutdown (#3733). Unlink the socket file tmux leaves behind
    // so per-case sockets don't accumulate in $TMUX_TMPDIR either.
    const retired = socket;
    socket = "";
    if (!retired) return;
    tmuxOn(retired, ["kill-server"]);
    try {
      rmSync(socketPath(retired), { force: true });
    } catch {
      /* best effort */
    }
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
    expect(runner.hasSession(socket, SESSION)).toBe(true);

    const payload = "/test-payload";
    runner.send(socket, SESSION, ["send-keys", "-l", payload]);
    runner.send(socket, SESSION, ["send-keys", "Enter"]);

    await sleep(300);

    const captured = runner.capture(socket, SESSION) ?? "";

    // The literal slash payload must appear, with no -t/session
    // contamination glued on.
    expect(captured).toContain(payload);
    expect(captured).not.toContain(`${payload}-t`);
    expect(captured).not.toContain(`${payload}-t${SESSION}`);
    expect(captured).not.toContain(`${payload} -t ${SESSION}`);
    expect(captured).not.toContain(`${payload}-tinjecttest`);
  });

  it("fixture isolation: no case reuses a socket generation (#3733)", () => {
    // Runs last, so `usedSockets` holds every socket this describe has
    // handed out. Under the pre-#3733 fixture (one module-level socket
    // shared by every case) this file could not reach here green: the
    // second case's `beforeEach` would already have failed the
    // "not previously used" assertion.
    expect(usedSockets.size).toBe(socketSeq);
    expect(usedSockets.has(socket)).toBe(true);

    // Every retired socket must be dead — a `beforeEach` that threw, or
    // a teardown that missed, would leave a server behind, and a stray
    // server is exactly what a later `new-session` would race.
    for (const retired of usedSockets) {
      if (retired === socket) continue;
      expect(socketIsDead(retired)).toBe(true);
    }

    // And the live socket is genuinely this case's own server.
    expect(tmuxOn(socket, ["has-session", "-t", SESSION]).status).toBe(0);
  });
});

describe.skipIf(TMUX_PRESENT)("inject — tmux absent, real-tmux suite skipped", () => {
  it("documents skip reason", () => {
    expect(existsSync("/usr/bin/tmux")).toBe(false);
  });
});
