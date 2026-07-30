import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CRON_LOCK_PATH,
  CRON_LOG_PATH,
  CRON_PATH,
  CRON_SCHEDULE,
  installCron,
  parseCronUser,
  reconcileCron,
  renderCron,
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
