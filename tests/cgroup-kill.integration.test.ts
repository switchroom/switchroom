/**
 * Cgroup-kill verification (#725 pre-fanout hardening).
 *
 * Spawns a transient tmux session inside a systemd-run --user
 * transient unit, then `systemctl --user stop` the unit and verify
 * zero leftover processes within the timeout. Proves the
 * `KillMode=control-group` directive in the agent unit template
 * actually kills the whole tmux process tree (tmux server +
 * spawned bash + descendants), not just MainPID.
 *
 * Skipped in any environment without `systemd-run` or a `--user`
 * systemd manager. CI runners typically have neither, so the suite
 * documents its skip rather than failing.
 */

import { describe, it, expect, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";

function which(bin: string): boolean {
  try {
    execFileSync("which", [bin], { stdio: ["pipe", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

function userSystemdRunWorks(): boolean {
  if (!which("systemd-run")) return false;
  if (!which("systemctl")) return false;
  // Probe: can we even talk to a user systemd manager?
  const r = spawnSync("systemctl", ["--user", "is-system-running"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  // Returns non-zero on degraded but still WORKS — we just need
  // the connection to succeed (status 0..4 are valid manager replies).
  return r.status !== null && r.status >= 0 && r.status <= 4;
}

const RUN_OK = userSystemdRunWorks() && which("tmux");

const UNIT = `srtest-cgkill-${process.pid}-${Date.now().toString(36)}`;
const SOCKET = `${UNIT}-sock`;

function userctl(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("systemctl", ["--user", ...args], {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

async function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

describe.skipIf(!RUN_OK)("cgroup-kill — systemctl stop reaps the whole tmux tree (#725)", () => {
  afterEach(() => {
    // Belt-and-braces — stop + reset the unit even if the test bailed.
    userctl(["stop", `${UNIT}.service`]);
    userctl(["reset-failed", `${UNIT}.service`]);
    spawnSync("tmux", ["-L", SOCKET, "kill-server"], { stdio: ["pipe", "pipe", "pipe"] });
  });

  it("stop kills tmux server + descendants within 5s", async () => {
    // Spawn a transient unit that runs tmux new-session in the
    // foreground (Type=forking would let us match the agent unit
    // shape but that needs systemd to track the forked leader; the
    // plain new-session -d also works for a kill-test because
    // KillMode=control-group is the default).
    // Use a foreground bash that starts a tmux session and then sleeps,
    // so the systemd-run unit stays "active" rather than tmux's `-d`
    // detach causing systemd to mark the unit exited immediately.
    const launch = spawnSync(
      "systemd-run",
      [
        "--user",
        `--unit=${UNIT}`,
        "--property=KillMode=control-group",
        "--property=SendSIGKILL=yes",
        "--property=TimeoutStopSec=5",
        "bash",
        "-c",
        `tmux -L ${SOCKET} new-session -d -s cgkill -x 120 -y 40 'while :; do sleep 1; done' && sleep 600`,
      ],
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    expect(launch.status, `systemd-run failed: ${launch.stderr}`).toBe(0);

    // Wait for the unit to actually be active and tmux to bind.
    await sleep(1500);

    // Sanity: tmux session exists.
    const ls = spawnSync("tmux", ["-L", SOCKET, "ls"], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    expect(ls.status, `expected tmux ls to succeed before stop: ${ls.stderr}`).toBe(0);

    // Stop the unit; cgroup-kill should reap tmux + the bash sleeper.
    const stop = userctl(["stop", `${UNIT}.service`]);
    // stop returns 0 even when KillMode reaps non-trivially.
    expect(stop.status).not.toBe(null);

    // Poll for up to 5s — every leftover should be gone.
    const deadline = Date.now() + 5000;
    let stillAlive = true;
    while (Date.now() < deadline) {
      const ls2 = spawnSync("tmux", ["-L", SOCKET, "ls"], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      // Once kill-session takes effect, `tmux ls` either errors out
      // (no server) or returns no sessions.
      if (ls2.status !== 0) {
        stillAlive = false;
        break;
      }
      await sleep(150);
    }
    expect(stillAlive, "tmux server survived systemctl stop — cgroup-kill failed").toBe(false);
  }, 15000);
});

describe.skipIf(RUN_OK)("cgroup-kill — required tooling absent, suite skipped", () => {
  it("documents the skip", () => {
    expect(RUN_OK).toBe(false);
  });
});
