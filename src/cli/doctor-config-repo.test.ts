import { describe, it, expect } from "vitest";
import {
  classifyConfigRepo,
  classifyConfigSyncCron,
  CONFIG_SYNC_STALE_INTERVALS,
  UNPUSHED_STALE_MS,
  type ConfigRepoFacts,
  type ConfigSyncCronFacts,
} from "./doctor-config-repo.js";

const base: ConfigRepoFacts = {
  configured: true,
  enabled: true,
  repoPath: "/home/op/.switchroom-config",
  isGitRepo: true,
  isPrivate: true,
  untrackedPersonalSkills: 0,
  unpushedCount: 0,
  oldestUnpushedAgeMs: null,
};

function row(rows: ReturnType<typeof classifyConfigRepo>, name: string) {
  return rows.find((r) => r.name === name);
}

describe("classifyConfigRepo", () => {
  it("emits no rows when config_repo is not configured", () => {
    expect(classifyConfigRepo({ ...base, configured: false })).toHaveLength(0);
  });

  it("FAILs and short-circuits when the path is not a git repo", () => {
    const rows = classifyConfigRepo({ ...base, isGitRepo: false });
    expect(rows).toHaveLength(1);
    expect(row(rows, "config repo present")?.status).toBe("fail");
  });

  it("FAILs when the remote is public", () => {
    const rows = classifyConfigRepo({ ...base, isPrivate: false });
    expect(row(rows, "config repo private")?.status).toBe("fail");
  });

  it("WARNs when visibility is unverifiable", () => {
    const rows = classifyConfigRepo({ ...base, isPrivate: null });
    expect(row(rows, "config repo private")?.status).toBe("warn");
  });

  it("WARNs on untracked personal skills (GAP A backstop) and clears when zero", () => {
    expect(row(classifyConfigRepo({ ...base, untrackedPersonalSkills: 84 }), "config repo personal skills tracked")?.status).toBe("warn");
    expect(row(classifyConfigRepo(base), "config repo personal skills tracked")?.status).toBe("ok");
  });

  it("FAILs on unpushed commits older than 24h, OK when recent", () => {
    const stale = classifyConfigRepo({ ...base, unpushedCount: 3, oldestUnpushedAgeMs: UNPUSHED_STALE_MS + 1 });
    expect(row(stale, "config repo unpushed")?.status).toBe("fail");
    const recent = classifyConfigRepo({ ...base, unpushedCount: 1, oldestUnpushedAgeMs: 60_000 });
    expect(row(recent, "config repo unpushed")?.status).toBe("ok");
  });

  it("WARNs when there is no upstream tracking ref", () => {
    const rows = classifyConfigRepo({ ...base, unpushedCount: null });
    expect(row(rows, "config repo unpushed")?.status).toBe("warn");
  });
});

describe("classifyConfigSyncCron", () => {
  const NOW = 1_700_000_000_000;
  const cronBase: ConfigSyncCronFacts = {
    configured: true,
    enabled: true,
    cronInstalled: true,
    logMtimeMs: NOW - 5 * 60_000, // 5m ago — fresh
    intervalMinutes: 30,
  };
  const staleMs = 30 * CONFIG_SYNC_STALE_INTERVALS * 60_000;

  it("emits no row when config_repo is not configured", () => {
    expect(classifyConfigSyncCron({ ...cronBase, configured: false }, NOW)).toBeNull();
  });

  it("emits no row when the feature is off and no cron is installed", () => {
    expect(
      classifyConfigSyncCron({ ...cronBase, enabled: false, cronInstalled: false }, NOW),
    ).toBeNull();
  });

  it("FAILs when enabled but the cron is not installed — backups are NOT running", () => {
    const r = classifyConfigSyncCron({ ...cronBase, cronInstalled: false, logMtimeMs: null }, NOW);
    expect(r?.status).toBe("fail");
    expect(r?.detail).toContain("scheduled backups are NOT running");
  });

  it("WARNs when the cron is installed but the feature is disabled", () => {
    const r = classifyConfigSyncCron(
      { ...cronBase, enabled: false, cronInstalled: true },
      NOW,
    );
    expect(r?.status).toBe("warn");
    expect(r?.fix).toContain("uninstall-cron");
  });

  it("WARNs when armed but no tick has ever completed (no log)", () => {
    const r = classifyConfigSyncCron({ ...cronBase, logMtimeMs: null }, NOW);
    expect(r?.status).toBe("warn");
    expect(r?.detail).toContain("no tick has completed");
  });

  it("is OK when armed, enabled, and a tick ran within the staleness window", () => {
    const r = classifyConfigSyncCron({ ...cronBase, logMtimeMs: NOW - staleMs + 60_000 }, NOW);
    expect(r?.status).toBe("ok");
  });

  it("FAILs when the last tick is stale past the window", () => {
    const r = classifyConfigSyncCron({ ...cronBase, logMtimeMs: NOW - staleMs - 60_000 }, NOW);
    expect(r?.status).toBe("fail");
    expect(r?.detail).toContain("stale past");
  });

  it("WARNs on a future-dated log (clock skew)", () => {
    const r = classifyConfigSyncCron({ ...cronBase, logMtimeMs: NOW + staleMs + 60_000 }, NOW);
    expect(r?.status).toBe("warn");
    expect(r?.detail).toContain("FUTURE");
  });

  it("scales the staleness window with interval_minutes", () => {
    // 5-min cadence → window is 15m; a 20m-old tick is stale.
    const r = classifyConfigSyncCron(
      { ...cronBase, intervalMinutes: 5, logMtimeMs: NOW - 20 * 60_000 },
      NOW,
    );
    expect(r?.status).toBe("fail");
  });
});
