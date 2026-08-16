import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CRON_LOCK_PATH,
  CRON_LOG_PATH,
  CRON_PATH,
  CRON_SCHEDULE,
  LOGROTATE_PATH,
  installCron,
  installLogrotate,
  parseCronUser,
  reconcileCron,
  renderCron,
  renderLogrotate,
} from "./mm-refresh-cron.js";

/**
 * The RFC-P10 refresh cron reuses `hindsight-watch/install-cron.ts`'s arming
 * shape, so these tests pin the same "silently never runs" foot-guns on the
 * NEW fragment: trailing newline, explicit PATH, flock guard, the daily
 * off-peak schedule, and the reconcile-preserves-user contract.
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mmr-cron-"));
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

  it("sets an explicit PATH — cron's default /usr/bin:/bin is a known foot-gun", () => {
    const path = out.split("\n").find((l) => l.startsWith("PATH="));
    expect(path).toBeDefined();
    expect(path).toContain("/usr/local/bin");
    expect(path).toContain("/usr/bin");
  });

  it("guards with flock -n so two sweeps cannot race and double-refresh", () => {
    expect(out).toContain(`/usr/bin/flock -n ${CRON_LOCK_PATH}`);
  });

  it("runs as the named user on the daily off-peak schedule", () => {
    expect(out).toContain(`${CRON_SCHEDULE} ${OPTS.user} `);
    // Daily at 04:27 — off-peak, and an odd minute to avoid the top-of-hour herd.
    expect(CRON_SCHEDULE).toBe("27 4 * * *");
  });

  it("redirects both streams to the log", () => {
    expect(out).toContain(`>> ${CRON_LOG_PATH} 2>&1`);
  });

  it("invokes the absolute binary with the mental-model-refresh verb", () => {
    expect(out).toContain(`${OPTS.binary} mental-model-refresh`);
  });
});

describe("installCron", () => {
  it("writes mode 0644 with the rendered content", () => {
    const path = join(dir, "mental-model-refresh");
    installCron({ ...OPTS, path });
    expect(statSync(path).mode & 0o777).toBe(0o644);
    expect(readFileSync(path, "utf8")).toBe(renderCron(OPTS));
  });

  it("is idempotent: a second call reports unchanged", () => {
    const path = join(dir, "mental-model-refresh");
    expect(installCron({ ...OPTS, path }).status).toBe("installed");
    expect(installCron({ ...OPTS, path }).status).toBe("unchanged");
  });

  it("overwrites a stale fragment and leaves no .tmp behind", () => {
    const path = join(dir, "mental-model-refresh");
    writeFileSync(path, "*/5 * * * * nobody /bin/false\n");
    expect(installCron({ ...OPTS, path }).status).toBe("installed");
    expect(readFileSync(path, "utf8")).toBe(renderCron(OPTS));
    expect(() => statSync(`${path}.${process.pid}.tmp`)).toThrow();
  });
});

describe("renderLogrotate", () => {
  const out = renderLogrotate({ logPath: CRON_LOG_PATH, user: "ada" });

  it("uses copytruncate for the writer-less log and rotates as the owning user", () => {
    expect(out).toContain("\n  copytruncate\n");
    expect(out).toContain("\n  su ada ada\n");
  });

  it("targets the production log path and defaults are wired", () => {
    expect(out.startsWith(`${CRON_LOG_PATH} {\n`)).toBe(true);
    expect(out.endsWith("}\n")).toBe(true);
    expect(CRON_LOG_PATH).toBe("/var/log/mental-model-refresh.log");
    expect(LOGROTATE_PATH).toBe("/etc/logrotate.d/mental-model-refresh");
  });
});

describe("installLogrotate", () => {
  it("writes mode 0644 with the rendered content, idempotently", () => {
    const path = join(dir, "mmr-lr");
    const opts = { user: "kenthompson", logPath: CRON_LOG_PATH };
    expect(installLogrotate({ ...opts, path }).status).toBe("installed");
    expect(statSync(path).mode & 0o777).toBe(0o644);
    expect(readFileSync(path, "utf8")).toBe(renderLogrotate(opts));
    expect(installLogrotate({ ...opts, path }).status).toBe("unchanged");
  });
});

describe("parseCronUser", () => {
  it("returns the user field of the managed schedule line", () => {
    expect(parseCronUser(renderCron(OPTS))).toBe("kenthompson");
    expect(parseCronUser(renderCron({ user: "ada", binary: OPTS.binary }))).toBe("ada");
  });

  it("returns null for a fragment with no managed line", () => {
    expect(parseCronUser("# comment\nPATH=/bin\n")).toBeNull();
    expect(parseCronUser("")).toBeNull();
  });
});

describe("reconcileCron — repair an already-armed cron, never arm", () => {
  it("is a no-op (absent) when the fragment does not exist", () => {
    const path = join(dir, "mental-model-refresh");
    const res = reconcileCron({ binary: OPTS.binary, path, fallbackUser: "ken" });
    expect(res.status).toBe("absent");
    expect(() => statSync(path)).toThrow();
  });

  it("REWRITES a drifted fragment and preserves the parsed user over the fallback", () => {
    const path = join(dir, "mental-model-refresh");
    writeFileSync(path, renderCron({ user: "ada", binary: "/opt/old/switchroom" }));
    const res = reconcileCron({ binary: "/usr/local/bin/switchroom", path, fallbackUser: "root" });
    expect(res.status).toBe("reconciled");
    expect(readFileSync(path, "utf8")).toBe(
      renderCron({ user: "ada", binary: "/usr/local/bin/switchroom" }),
    );
  });

  it("is idempotent on a current fragment", () => {
    const path = join(dir, "mental-model-refresh");
    writeFileSync(path, renderCron({ user: "ada", binary: "/usr/local/bin/switchroom" }));
    expect(reconcileCron({ binary: "/usr/local/bin/switchroom", path }).status).toBe("unchanged");
  });

  it("defaults to the real CRON_PATH when none is given", () => {
    const res = reconcileCron({ binary: OPTS.binary, path: undefined, fallbackUser: "ken" });
    expect(res.path).toBe(CRON_PATH);
  });
});
