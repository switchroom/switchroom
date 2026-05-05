/**
 * Integration test for `bin/autoaccept.exp` post-timeout `interact` block (#725).
 *
 * The supervisor flag relies on autoaccept.exp falling through to
 * `interact { eof exit }` once the bounded autoaccept window expires —
 * otherwise expect owns stdin and tmux send-keys never reach Claude.
 *
 * Strategy:
 *   1. Spawn tmux with a session running expect against a tiny dummy
 *      shell that prints READY and reads stdin into a sentinel file.
 *   2. After the autoaccept window has had a chance to settle, send
 *      keystrokes via `tmux send-keys`.
 *   3. Read the sentinel file — if `interact` works the bytes arrived;
 *      if expect still owns stdin (regression) the file stays empty.
 *
 * Skips when `tmux` or `expect` are absent. Uses very tight timing so
 * the test runs in <2s.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

function bin(name: string): boolean {
  try {
    execFileSync("which", [name], { stdio: ["pipe", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

const TOOLS_OK = bin("tmux") && bin("expect");

const SOCKET = `srtest-aa-${process.pid}-${Date.now().toString(36)}`;
const SESSION = "aatest";

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

describe.skipIf(!TOOLS_OK)("autoaccept.exp — interact block forwards stdin (#725)", () => {
  let workdir: string;
  let dummyScript: string;
  let sentinel: string;
  let shortExp: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "srtest-aa-"));
    sentinel = join(workdir, "received.txt");
    dummyScript = join(workdir, "dummy.sh");
    // Tiny "shell" that signals ready and reads one line into the
    // sentinel file. Mirrors what claude would do on stdin.
    writeFileSync(
      dummyScript,
      `#!/bin/bash\necho READY\nIFS= read -r line\nprintf '%s\\n' "$line" > ${sentinel}\necho GOTLINE\n`,
      { mode: 0o755 },
    );
    chmodSync(dummyScript, 0o755);

    // Build a one-shot copy of autoaccept.exp with timeout=1 so we
    // don't wait 30s for the interact block to engage.
    const realExp = resolve(__dirname, "..", "bin", "autoaccept.exp");
    const orig = readFileSync(realExp, "utf-8");
    const fast = orig.replace(/^set timeout \d+/m, "set timeout 1");
    shortExp = join(workdir, "autoaccept-fast.exp");
    writeFileSync(shortExp, fast, { mode: 0o755 });
    chmodSync(shortExp, 0o755);
  });

  afterEach(() => {
    tmux(["kill-server"]);
    try {
      rmSync(workdir, { recursive: true, force: true });
    } catch { /* best-effort */ }
  });

  it("send-keys reaches the spawned dummy shell after the autoaccept window expires", async () => {
    const r = tmux([
      "new-session",
      "-d",
      "-s",
      SESSION,
      "-x",
      "120",
      "-y",
      "40",
      "expect",
      "-f",
      shortExp,
      dummyScript,
    ]);
    expect(r.status, `tmux new-session failed: ${r.stderr || r.stdout}`).toBe(0);

    // Wait for the 1s timeout in autoaccept.exp to fire and interact
    // to engage. 1500ms is conservative.
    await sleep(1500);

    const payload = "interact-block-works";
    const sk1 = tmux(["send-keys", "-l", "-t", SESSION, payload]);
    expect(sk1.status).toBe(0);
    const sk2 = tmux(["send-keys", "-t", SESSION, "Enter"]);
    expect(sk2.status).toBe(0);

    // Give the dummy shell a moment to receive + write the sentinel.
    await sleep(500);

    let received = "";
    try {
      received = readFileSync(sentinel, "utf-8").trim();
    } catch { /* file may not exist yet */ }

    expect(received).toBe(payload);
  });
});

describe.skipIf(TOOLS_OK)("autoaccept-interact — required tooling absent, suite skipped", () => {
  it("documents the skip", () => {
    expect(TOOLS_OK).toBe(false);
  });
});
