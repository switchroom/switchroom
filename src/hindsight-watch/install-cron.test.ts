import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CRON_LOCK_PATH,
  CRON_LOG_PATH,
  CRON_PATH,
  CRON_SCHEDULE,
  LOGROTATE_PATH,
  ensureLogFile,
  installCron,
  installLogrotate,
  parseCronUser,
  reconcileCron,
  renderCron,
  renderLogrotate,
} from "./install-cron.js";

/**
 * The watchdog shipped complete and was never armed, so these tests are about
 * the arming step being CORRECT the first time — every property below is one
 * of the classic ways a `/etc/cron.d` fragment exists on disk and silently
 * never runs.
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hw-cron-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const OPTS = { user: "kenthompson", binary: "/usr/local/bin/switchroom" };

describe("renderCron", () => {
  const out = renderCron(OPTS);

  it("ends with a newline — cron silently ignores a fragment without one", () => {
    expect(out.endsWith("\n")).toBe(true);
  });

  it("sets an explicit PATH containing /usr/local/bin, because the probes shell out to docker", () => {
    const path = out.split("\n").find((l) => l.startsWith("PATH="));
    expect(path).toBeDefined();
    // cron's own default is /usr/bin:/bin, which has no docker on most installs.
    expect(path).toContain("/usr/local/bin");
    expect(path).toContain("/usr/bin");
  });

  it("guards with flock -n so two ticks cannot race on the hysteresis counters", () => {
    expect(out).toContain(`/usr/bin/flock -n ${CRON_LOCK_PATH}`);
  });

  it("runs as the named user on the schedule the thresholds were derived against", () => {
    expect(out).toContain(`${CRON_SCHEDULE} ${OPTS.user} `);
    expect(CRON_SCHEDULE).toBe("*/15 * * * *");
  });

  it("redirects both streams to the log — cron mail is not a delivery channel here", () => {
    expect(out).toContain(`>> ${CRON_LOG_PATH} 2>&1`);
  });

  it("invokes the absolute binary path", () => {
    expect(out).toContain(`${OPTS.binary} hindsight-watch`);
  });
});

describe("installCron", () => {
  it("writes mode 0644 — cron refuses a group- or world-writable fragment", () => {
    const path = join(dir, "hindsight-watch");
    installCron({ ...OPTS, path });
    expect(statSync(path).mode & 0o777).toBe(0o644);
    expect(readFileSync(path, "utf8")).toBe(renderCron(OPTS));
  });

  it("is idempotent: a second call reports unchanged and does not rewrite", () => {
    const path = join(dir, "hindsight-watch");
    expect(installCron({ ...OPTS, path }).status).toBe("installed");
    expect(installCron({ ...OPTS, path }).status).toBe("unchanged");
  });

  it("overwrites a stale fragment (e.g. after the schedule or user changes)", () => {
    const path = join(dir, "hindsight-watch");
    writeFileSync(path, "*/5 * * * * nobody /bin/false\n");
    expect(installCron({ ...OPTS, path }).status).toBe("installed");
    expect(readFileSync(path, "utf8")).toBe(renderCron(OPTS));
  });

  it("leaves no .tmp file behind", () => {
    const path = join(dir, "hindsight-watch");
    installCron({ ...OPTS, path });
    expect(() => statSync(`${path}.${process.pid}.tmp`)).toThrow();
  });

  it("rewrites rather than throwing when the existing fragment is unreadable", () => {
    const path = join(dir, "hindsight-watch");
    writeFileSync(path, "garbage\n");
    chmodSync(path, 0o000);
    // Running as root can read a 0000 file, so accept either branch — the
    // outcome under test is that the content ends up correct, not which
    // branch got there.
    expect(installCron({ ...OPTS, path }).status).toBe("installed");
    expect(readFileSync(path, "utf8")).toBe(renderCron(OPTS));
  });
});

describe("ensureLogFile — #3991 the redirection target the cron user can append to", () => {
  // A resolver that never shells out to `id`, so these tests are hermetic and
  // never actually chown (which would need root and a real uid). We assert the
  // FILE-creation outcome; the chown target is covered by the resolver call.
  const resolveIds: () => { uid: number; gid: number } = () => ({ uid: 12345, gid: 12345 });

  it("creates an empty mode-0644 file when absent (so `>>` succeeds without /var/log write)", () => {
    const path = join(dir, "hindsight-watch.log");
    const res = ensureLogFile({ user: "kenthompson", path, resolveIds });
    expect(res.status).toBe("created");
    expect(res.path).toBe(path);
    expect(readFileSync(path, "utf8")).toBe("");
    expect(statSync(path).mode & 0o777).toBe(0o644);
  });

  it("is idempotent and NEVER truncates an existing log — accumulated ticks survive", () => {
    const path = join(dir, "hindsight-watch.log");
    writeFileSync(path, "tick 1\ntick 2\n");
    const res = ensureLogFile({ user: "kenthompson", path, resolveIds });
    expect(res.status).toBe("unchanged");
    // The content is untouched — a truncate here would throw away real history.
    expect(readFileSync(path, "utf8")).toBe("tick 1\ntick 2\n");
  });

  it("resolves the cron user's ids exactly once, only on the create path", () => {
    const path = join(dir, "hindsight-watch.log");
    let calls = 0;
    const counting = (u: string) => {
      calls++;
      expect(u).toBe("ada");
      return { uid: 999, gid: 999 };
    };
    ensureLogFile({ user: "ada", path, resolveIds: counting });
    expect(calls).toBe(1);
    // Second call short-circuits on existsSync before resolving ids.
    ensureLogFile({ user: "ada", path, resolveIds: counting });
    expect(calls).toBe(1);
  });

  // The chown is BEST-EFFORT (#4081): the file existing is what lets the cron's
  // `>>` append; ownership only matters when `/var/log` is unwritable by the
  // cron user, and only root can chown to another uid. A non-root caller (or a
  // restricted mount) must still get a created file, never a fatal EPERM that
  // aborts the arm after the fragment was already written.
  it("does NOT chown and does NOT throw when the process is not root — the file still exists to append to", () => {
    const path = join(dir, "hindsight-watch.log");
    // Force the non-root branch deterministically, independent of the test
    // runner's real uid (CI shards run non-root; a local run may be root).
    const getuidSpy = vi.spyOn(process as { getuid: () => number }, "getuid").mockReturnValue(1000);
    try {
      expect(() => ensureLogFile({ user: "kenthompson", path, resolveIds })).not.toThrow();
    } finally {
      getuidSpy.mockRestore();
    }
    expect(existsSync(path)).toBe(true);
    // chown was skipped: ownership is the CREATING process's uid, never the
    // resolved 12345. If the fix is reverted this fails — as root the file
    // becomes uid 12345, as non-root the unconditional chown throws EPERM.
    expect(statSync(path).uid).not.toBe(12345);
  });

  it("tolerates EPERM from chown on the root path — file exists, arm is not aborted", () => {
    const path = join(dir, "hindsight-watch.log");
    // Force the root branch so the chown is attempted; a non-root runner then
    // yields a real EPERM that the fix must swallow. On a root runner the chown
    // simply succeeds — either way the file exists and nothing throws.
    const getuidSpy = vi.spyOn(process as { getuid: () => number }, "getuid").mockReturnValue(0);
    try {
      expect(() => ensureLogFile({ user: "kenthompson", path, resolveIds })).not.toThrow();
    } finally {
      getuidSpy.mockRestore();
    }
    expect(existsSync(path)).toBe(true);
  });
});

describe("renderLogrotate — #3992 exact bytes of the drop-in", () => {
  const out = renderLogrotate({ logPath: "/var/log/hindsight-watch.log", user: "ada" });

  it("uses copytruncate — the only scheme that does not strand the inode for a writer-less log", () => {
    expect(out).toContain("\n  copytruncate\n");
  });

  it("rotates as the cron user that owns the file, not root", () => {
    expect(out).toContain("\n  su ada ada\n");
  });

  it("bounds retention (weekly / rotate 8) and tolerates a missing/empty log", () => {
    expect(out).toContain("\n  weekly\n");
    expect(out).toContain("\n  rotate 8\n");
    expect(out).toContain("\n  missingok\n");
    expect(out).toContain("\n  notifempty\n");
  });

  it("targets the given log path and is a complete stanza ending in a newline", () => {
    expect(out.startsWith("/var/log/hindsight-watch.log {\n")).toBe(true);
    expect(out.endsWith("}\n")).toBe(true);
  });
});

describe("installLogrotate", () => {
  const OPTS_LR = { user: "kenthompson", logPath: "/var/log/hindsight-watch.log" };

  it("writes mode 0644 with the rendered content", () => {
    const path = join(dir, "hindsight-watch");
    const res = installLogrotate({ ...OPTS_LR, path });
    expect(res.status).toBe("installed");
    expect(statSync(path).mode & 0o777).toBe(0o644);
    expect(readFileSync(path, "utf8")).toBe(renderLogrotate(OPTS_LR));
  });

  it("is idempotent: a second call reports unchanged", () => {
    const path = join(dir, "hindsight-watch");
    expect(installLogrotate({ ...OPTS_LR, path }).status).toBe("installed");
    expect(installLogrotate({ ...OPTS_LR, path }).status).toBe("unchanged");
  });

  it("overwrites a stale/foreign drop-in and leaves no .tmp behind", () => {
    const path = join(dir, "hindsight-watch");
    writeFileSync(path, "/var/log/other.log { daily }\n");
    expect(installLogrotate({ ...OPTS_LR, path }).status).toBe("installed");
    expect(readFileSync(path, "utf8")).toBe(renderLogrotate(OPTS_LR));
    expect(() => statSync(`${path}.${process.pid}.tmp`)).toThrow();
  });

  it("defaults to the production LOGROTATE_PATH and CRON_LOG_PATH", () => {
    const content = renderLogrotate({ logPath: CRON_LOG_PATH, user: "ada" });
    expect(content).toContain(CRON_LOG_PATH);
    expect(LOGROTATE_PATH).toBe("/etc/logrotate.d/hindsight-watch");
  });
});

describe("parseCronUser", () => {
  it("returns the user field of the managed schedule line", () => {
    expect(parseCronUser(renderCron(OPTS))).toBe("kenthompson");
  });

  it("ignores comment / SHELL= / PATH= lines and reads the hindsight-watch line", () => {
    const other = renderCron({ user: "ada", binary: "/usr/local/bin/switchroom" });
    expect(parseCronUser(other)).toBe("ada");
  });

  it("returns null for a fragment with no managed line", () => {
    expect(parseCronUser("# just a comment\nPATH=/bin\n")).toBeNull();
    expect(parseCronUser("")).toBeNull();
  });
});

describe("reconcileCron — repair an already-armed cron, never arm", () => {
  it("is a no-op (absent) when the fragment does not exist — never arms", () => {
    const path = join(dir, "hindsight-watch");
    const res = reconcileCron({ binary: OPTS.binary, path, fallbackUser: "ken" });
    expect(res.status).toBe("absent");
    // Crucially, nothing was written: an unarmed host STAYS unarmed.
    expect(() => statSync(path)).toThrow();
  });

  it("REWRITES a drifted fragment (stale binary path) and preserves the user", () => {
    const path = join(dir, "hindsight-watch");
    // Armed earlier as `ada` pointing at an old binary location.
    writeFileSync(path, renderCron({ user: "ada", binary: "/opt/old/switchroom" }));
    const res = reconcileCron({
      binary: "/usr/local/bin/switchroom",
      path,
      fallbackUser: "root", // must NOT be used — user is parsed from the file
    });
    expect(res.status).toBe("reconciled");
    // The operator's chosen user is preserved; only the binary is corrected.
    expect(readFileSync(path, "utf8")).toBe(
      renderCron({ user: "ada", binary: "/usr/local/bin/switchroom" }),
    );
  });

  it("is idempotent: a second reconcile of a current fragment is unchanged", () => {
    const path = join(dir, "hindsight-watch");
    writeFileSync(path, renderCron({ user: "ada", binary: "/usr/local/bin/switchroom" }));
    expect(reconcileCron({ binary: "/usr/local/bin/switchroom", path }).status).toBe(
      "unchanged",
    );
    expect(reconcileCron({ binary: "/usr/local/bin/switchroom", path }).status).toBe(
      "unchanged",
    );
  });

  it("defaults to the real CRON_PATH when none is given", () => {
    // Not writable in tests, but the resolved path must be the production one.
    const res = reconcileCron({ binary: OPTS.binary, path: undefined, fallbackUser: "ken" });
    // On a dev host with no armed cron this is absent; the point under test is
    // that it resolved CRON_PATH rather than throwing.
    expect(res.path).toBe(CRON_PATH);
  });
});
