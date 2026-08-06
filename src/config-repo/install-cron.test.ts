import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CRON_LOCK_PATH,
  CRON_LOG_PATH,
  CRON_PATH,
  DAILY_CRON_SCHEDULE,
  DEFAULT_INTERVAL_MINUTES,
  installCron,
  parseCronUser,
  reconcileCron,
  renderCron,
  uninstallCron,
} from "./install-cron.js";

/**
 * Slice 1 shipped the sync verb but no schedule. These tests pin the arming
 * step — every property is a classic way a `/etc/cron.d` fragment exists and
 * silently never runs, plus the two-leg (30-min + daily vault backup) contract.
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cfgrepo-cron-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const OPTS = { user: "kenthompson", binary: "/usr/local/bin/switchroom" };

describe("renderCron — default (daily vault backup)", () => {
  const out = renderCron(OPTS);

  it("ends with a newline — cron ignores a fragment without one", () => {
    expect(out.endsWith("\n")).toBe(true);
  });

  it("sets an explicit PATH containing /usr/local/bin (git/gh/flock live there)", () => {
    const path = out.split("\n").find((l) => l.startsWith("PATH="));
    expect(path).toBeDefined();
    expect(path).toContain("/usr/local/bin");
    expect(path).toContain("/usr/bin");
  });

  it("runs the 30-min tick as the named user, flock-guarded, invoking `config-repo sync`", () => {
    // The default cadence is Ken's approved 30 minutes.
    expect(DEFAULT_INTERVAL_MINUTES).toBe(30);
    expect(out).toContain(
      `*/30 * * * * ${OPTS.user} /usr/bin/flock -n ${CRON_LOCK_PATH} ${OPTS.binary} config-repo sync >> ${CRON_LOG_PATH} 2>&1`,
    );
  });

  it("adds a DAILY leg that runs `vault backup && config-repo sync` before the sync", () => {
    expect(out).toContain(
      `${DAILY_CRON_SCHEDULE} ${OPTS.user} /usr/bin/flock -n ${CRON_LOCK_PATH} ` +
        `/bin/sh -c '${OPTS.binary} vault backup && ${OPTS.binary} config-repo sync' >> ${CRON_LOG_PATH} 2>&1`,
    );
  });

  it("uses ONE shared lock for both legs so two git commits can never race", () => {
    const lines = out.split("\n").filter((l) => l.includes("flock"));
    expect(lines).toHaveLength(2); // 30-min tick + daily leg
    for (const l of lines) expect(l).toContain(`/usr/bin/flock -n ${CRON_LOCK_PATH} `);
  });

  it("puts the daily leg OFF the 30-min grid so it is never pre-empted by a tick", () => {
    // Minute 17 is not a multiple of 30 (:00/:30), so a plain tick and the
    // backup leg never contend for the shared lock on the same minute.
    const dailyMinute = Number(DAILY_CRON_SCHEDULE.split(" ")[0]);
    expect(dailyMinute % 30).not.toBe(0);
  });
});

describe("renderCron — include_vault_backup modes", () => {
  it("off: a single sync tick, no daily leg, no `vault backup` command", () => {
    const out = renderCron({ ...OPTS, includeVaultBackup: "off" });
    const flockLines = out.split("\n").filter((l) => l.includes("flock"));
    expect(flockLines).toHaveLength(1);
    expect(flockLines[0]).toContain("config-repo sync");
    // No cron COMMAND line runs `vault backup` (the comment note may mention it).
    expect(flockLines[0]).not.toContain("vault backup");
  });

  it("every_tick: the 30-min tick itself runs `vault backup && config-repo sync`, no separate daily leg", () => {
    const out = renderCron({ ...OPTS, includeVaultBackup: "every_tick" });
    const flockLines = out.split("\n").filter((l) => l.includes("flock"));
    expect(flockLines).toHaveLength(1);
    expect(flockLines[0]).toContain(
      `/bin/sh -c '${OPTS.binary} vault backup && ${OPTS.binary} config-repo sync'`,
    );
    // No daily-only backup line when it already runs every tick.
    expect(out).not.toContain(DAILY_CRON_SCHEDULE);
  });

  it("honours a custom interval_minutes in the tick minute field", () => {
    const out = renderCron({ ...OPTS, intervalMinutes: 15 });
    expect(out).toContain(`*/15 * * * * ${OPTS.user} `);
  });
});

describe("installCron", () => {
  it("writes mode 0644 with the rendered content — cron refuses a group/world-writable fragment", () => {
    const path = join(dir, "switchroom-config-sync");
    installCron({ ...OPTS, path });
    expect(statSync(path).mode & 0o777).toBe(0o644);
    expect(readFileSync(path, "utf8")).toBe(renderCron(OPTS));
  });

  it("is idempotent: a second call reports unchanged and does not rewrite", () => {
    const path = join(dir, "switchroom-config-sync");
    expect(installCron({ ...OPTS, path }).status).toBe("installed");
    expect(installCron({ ...OPTS, path }).status).toBe("unchanged");
  });

  it("rewrites a drifted fragment (e.g. an interval change)", () => {
    const path = join(dir, "switchroom-config-sync");
    installCron({ ...OPTS, path, intervalMinutes: 30 });
    const r = installCron({ ...OPTS, path, intervalMinutes: 15 });
    expect(r.status).toBe("installed");
    expect(readFileSync(path, "utf8")).toBe(renderCron({ ...OPTS, intervalMinutes: 15 }));
  });

  it("leaves no .tmp file behind", () => {
    const path = join(dir, "switchroom-config-sync");
    installCron({ ...OPTS, path });
    expect(() => statSync(`${path}.${process.pid}.tmp`)).toThrow();
  });
});

describe("uninstallCron — removable and idempotent", () => {
  it("removes an installed fragment, then reports absent on a second call", () => {
    const path = join(dir, "switchroom-config-sync");
    installCron({ ...OPTS, path });
    expect(uninstallCron(path).status).toBe("removed");
    expect(existsSync(path)).toBe(false);
    // Double-uninstall is a clean no-op.
    expect(uninstallCron(path).status).toBe("absent");
  });

  it("reports absent when nothing was installed", () => {
    const path = join(dir, "switchroom-config-sync");
    expect(uninstallCron(path).status).toBe("absent");
  });
});

describe("parseCronUser", () => {
  it("returns the user field of the managed `config-repo sync` line", () => {
    expect(parseCronUser(renderCron(OPTS))).toBe("kenthompson");
    expect(parseCronUser(renderCron({ ...OPTS, user: "ada" }))).toBe("ada");
  });

  it("returns null for a fragment with no managed line", () => {
    expect(parseCronUser("# just a comment\nPATH=/bin\n")).toBeNull();
    expect(parseCronUser("")).toBeNull();
  });
});

describe("reconcileCron — repair an already-armed cron, never arm", () => {
  it("is a no-op (absent) when the fragment does not exist — an unarmed host STAYS unarmed", () => {
    const path = join(dir, "switchroom-config-sync");
    const res = reconcileCron({ binary: OPTS.binary, path, fallbackUser: "ken" });
    expect(res.status).toBe("absent");
    expect(existsSync(path)).toBe(false);
  });

  it("REWRITES a drifted fragment (stale binary + interval) and preserves the user", () => {
    const path = join(dir, "switchroom-config-sync");
    // Armed earlier as `ada`, old binary, 30-min.
    writeFileSync(path, renderCron({ user: "ada", binary: "/opt/old/switchroom", intervalMinutes: 30 }));
    const res = reconcileCron({
      binary: "/usr/local/bin/switchroom",
      intervalMinutes: 15,
      fallbackUser: "root", // must NOT be used — user is parsed from the file
      path,
    });
    expect(res.status).toBe("reconciled");
    expect(readFileSync(path, "utf8")).toBe(
      renderCron({ user: "ada", binary: "/usr/local/bin/switchroom", intervalMinutes: 15 }),
    );
  });

  it("is idempotent: a second reconcile of a current fragment is unchanged", () => {
    const path = join(dir, "switchroom-config-sync");
    writeFileSync(path, renderCron({ user: "ada", binary: "/usr/local/bin/switchroom" }));
    expect(reconcileCron({ binary: "/usr/local/bin/switchroom", path }).status).toBe("unchanged");
    expect(reconcileCron({ binary: "/usr/local/bin/switchroom", path }).status).toBe("unchanged");
  });

  it("defaults to the real CRON_PATH when none is given", () => {
    const res = reconcileCron({ binary: OPTS.binary, fallbackUser: "ken" });
    expect(res.path).toBe(CRON_PATH);
  });
});
