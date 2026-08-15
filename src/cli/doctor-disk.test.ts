/**
 * Disk-headroom doctor probe (`runDiskChecks`).
 *
 * The bug these guard: before this module, `switchroom doctor` measured free
 * space nowhere — the fleet host reached 85% full and doctor stayed green. The
 * load-bearing assertions are therefore about the *verdict a full filesystem
 * produces* (`fail` / `warn` with the real numbers in the message), not about
 * any code path being reached: run against a filesystem that is 95% full, the
 * pre-fix doctor emitted no row at all, so every one of these fails on it.
 *
 * `statfs` is injected — a test must never depend on the runner's real disk.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DiskConfigSchema,
  SwitchroomConfigSchema,
  type SwitchroomConfig,
} from "../config/schema.js";
import {
  runDiskChecks,
  usageFromStatfs,
  diskRow,
  reapSweepRow,
  nearestExistingPath,
  readReapLog,
  REAP_LOG_TAIL_BYTES,
  fmtBytes,
  type StatfsLike,
  type DiskProbeDeps,
} from "./doctor-disk.js";

function configWith(over: Partial<SwitchroomConfig> = {}): SwitchroomConfig {
  return {
    switchroom: { version: 1, agents_dir: "/agents", skills_dir: "/skills" },
    telegram: { bot_token: "x", forum_chat_id: "-1001234567890" },
    vault: { path: "/v.enc" },
    defaults: {},
    agents: { assistant: { topic_name: "A" } },
    ...over,
  } as unknown as SwitchroomConfig;
}

/**
 * A filesystem that is `usedPct` full in `df` terms, on 4 KiB blocks.
 * `bfree` deliberately exceeds `bavail` by a 5% root reserve, so any code
 * that used `bfree` for the capacity sum reports a different number.
 */
function fsAt(usedPct: number, totalGiB = 100): StatfsLike {
  const bsize = 4096;
  const blocks = Math.round((totalGiB * 1024 ** 3) / bsize);
  const reserve = Math.round(blocks * 0.05);
  // df capacity = used / (used + bavail) ⇒ used = pct * (blocks - reserve)
  const usable = blocks - reserve;
  const used = Math.round((usedPct / 100) * usable);
  const bavail = usable - used;
  return { bsize, blocks, bavail, bfree: bavail + reserve };
}

/** Deps that measure every path as `fs`, see no scratch volume, and find a fresh sweep log. */
function deps(fs: StatfsLike | null, over: Partial<DiskProbeDeps> = {}): DiskProbeDeps {
  const now = Date.UTC(2026, 7, 15, 12, 0, 0);
  return {
    statfs: () => fs,
    exists: () => true,
    scratchAvailable: () => false,
    readReapLog: () => ({ kind: "ok", generatedAtMs: now - 3_600_000 }),
    nowMs: now,
    ...over,
  };
}

const agentsRow = (rows: ReturnType<typeof runDiskChecks>) =>
  rows.find((r) => r.name === "free space: agent homes")!;

describe("runDiskChecks — free space on the agent-homes filesystem", () => {
  it("FAILs on a filesystem at 95% used, naming free/total/percent", () => {
    const rows = runDiskChecks(configWith(), deps(fsAt(95)));
    const row = agentsRow(rows);
    expect(row).toBeDefined();
    expect(row.status).toBe("fail");
    // The operator must be able to act without running `df`.
    expect(row.detail).toMatch(/95% used/);
    expect(row.detail).toMatch(/free of/);
    expect(row.detail).toMatch(/100\.0G/);
    expect(row.fix).toMatch(/reap-report/);
  });

  it("WARNs — not fails — at 85% used, the level the real incident was found at", () => {
    const row = agentsRow(runDiskChecks(configWith(), deps(fsAt(85))));
    expect(row.status).toBe("warn");
    expect(row.detail).toMatch(/85% used/);
  });

  it("is ok on a healthy filesystem", () => {
    const row = agentsRow(runDiskChecks(configWith(), deps(fsAt(40))));
    expect(row.status).toBe("ok");
    expect(row.detail).toMatch(/40% used/);
  });

  it("measures the configured agents dir, not `/`", () => {
    const seen: string[] = [];
    const cfg = configWith({
      switchroom: { version: 1, agents_dir: "/mnt/other/agents", skills_dir: "/s" } as never,
    });
    runDiskChecks(
      cfg,
      deps(fsAt(10), {
        statfs: (p) => {
          seen.push(p);
          return fsAt(10);
        },
      }),
    );
    expect(seen).toContain("/mnt/other/agents");
    expect(seen).not.toContain("/");
  });

  it("honours disk.warn_pct / disk.fail_pct overrides", () => {
    const strict = configWith({ disk: { warn_pct: 30, fail_pct: 35 } } as never);
    expect(agentsRow(runDiskChecks(strict, deps(fsAt(40)))).status).toBe("fail");
    const lax = configWith({ disk: { warn_pct: 96, fail_pct: 98 } } as never);
    expect(agentsRow(runDiskChecks(lax, deps(fsAt(95)))).status).toBe("ok");
  });

  it("skips (never fails) when the path does not exist anywhere up the tree", () => {
    const rows = runDiskChecks(
      configWith(),
      deps(null, { exists: () => false }),
    );
    const row = agentsRow(rows);
    expect(row.status).toBe("skip");
    expect(rows.every((r) => r.status !== "fail")).toBe(true);
    // A tree where nothing exists is not a fleet host — `at === agentsDir`
    // here only because measurePath falls back to the original path.
    expect(rows.some((r) => r.name.startsWith("worktree reap sweep"))).toBe(false);
  });

  it("skips when statfs is unavailable rather than reporting a bogus verdict", () => {
    const row = agentsRow(runDiskChecks(configWith(), deps(null)));
    expect(row.status).toBe("skip");
    expect(row.detail).toMatch(/statfs unavailable/);
  });
});

describe("verdict and displayed number never disagree", () => {
  it("a filesystem that PRINTS 90% used is treated as 90% used", () => {
    // 89.6% raw. Comparing the raw float while printing the rounded one would
    // render "90% used" beside a warn verdict on a host whose fail_pct is 90.
    const row = agentsRow(runDiskChecks(configWith(), deps(fsAt(89.6))));
    expect(row.detail).toMatch(/90% used/);
    expect(row.status).toBe("fail");
  });
});

describe("a not-yet-created agents dir", () => {
  it("measures the nearest existing ancestor and says so", () => {
    const present = new Set(["/", "/home", "/home/op"]);
    const cfg = configWith({
      switchroom: { version: 1, agents_dir: "/home/op/.switchroom/agents", skills_dir: "/s" } as never,
    });
    const row = agentsRow(
      runDiskChecks(cfg, deps(fsAt(20), { exists: (p) => present.has(p) })),
    );
    expect(row.status).toBe("ok");
    expect(row.detail).toContain("/home/op (holding /home/op/.switchroom/agents, not yet created)");
  });
});

describe("usageFromStatfs — df capacity semantics", () => {
  it("computes used/(used+available), excluding the root reserve", () => {
    // 100 blocks, 5 reserved, 47.5 used ⇒ df says 50%, used/blocks says 47.5%.
    const s: StatfsLike = { bsize: 1024, blocks: 100, bfree: 52, bavail: 47 };
    const u = usageFromStatfs(s);
    // used = 100 - 52 = 48; denom = 48 + 47 = 95 ⇒ 50.5%
    expect(u.usedPct).toBeCloseTo((48 / 95) * 100, 6);
    // Naive used/blocks would be 48% — a different verdict near a threshold.
    expect(u.usedPct).not.toBeCloseTo(48, 3);
    expect(u.freeBytes).toBe(47 * 1024);
    expect(u.totalBytes).toBe(100 * 1024);
  });

  it("does not divide by zero on a pseudo-filesystem with no blocks", () => {
    const u = usageFromStatfs({ bsize: 4096, blocks: 0, bfree: 0, bavail: 0 });
    expect(u.usedPct).toBe(0);
    expect(u.totalBytes).toBe(0);
  });
});

describe("scratch volume row (#4723)", () => {
  it("emits a scratch row when the bulk volume is mounted", () => {
    const rows = runDiskChecks(
      configWith(),
      deps(fsAt(92), { scratchAvailable: () => true }),
    );
    const row = rows.find((r) => r.name === "free space: scratch volume");
    expect(row).toBeDefined();
    expect(row!.status).toBe("fail");
    expect(row!.detail).toMatch(/\/mnt\/bulkdata/);
  });

  it("emits NO scratch row at all when the volume is absent (silent degradation)", () => {
    const rows = runDiskChecks(configWith(), deps(fsAt(10)));
    expect(rows.some((r) => r.name === "free space: scratch volume")).toBe(false);
  });

  it("emits no scratch row when the feature is disabled in config", () => {
    const cfg = configWith({ scratch: { enabled: false } } as never);
    const rows = runDiskChecks(cfg, deps(fsAt(10), { scratchAvailable: () => true }));
    expect(rows.some((r) => r.name === "free space: scratch volume")).toBe(false);
  });
});

describe("worktree reap sweep evidence row (#4724)", () => {
  const NOW = Date.UTC(2026, 7, 15, 12, 0, 0);
  const LOG = "/var/log/switchroom/reap-report.jsonl";

  it("is ok when the sweep ran inside the freshness window", () => {
    const r = reapSweepRow(LOG, { kind: "ok", generatedAtMs: NOW - 2 * 3_600_000 }, 48, NOW);
    expect(r.status).toBe("ok");
    expect(r.detail).toMatch(/2\.0h ago/);
  });

  it("WARNs when the log does not exist — the sweep was never scheduled", () => {
    const r = reapSweepRow(LOG, { kind: "absent" }, 48, NOW);
    expect(r.status).toBe("warn");
    expect(r.detail).toMatch(/never run/);
    // The fix must hand over a schedule line that cannot delete anything.
    // Assert on the backticked COMMAND, not the surrounding prose (which
    // legitimately says the verb "has no --yes").
    const cmd = /`([^`]*switchroom worktree[^`]*)`/.exec(r.fix ?? "")?.[1];
    expect(cmd).toBeDefined();
    expect(cmd).toMatch(/reap-report --append/);
    expect(cmd).not.toMatch(/--yes/);
    expect(cmd).not.toMatch(/--purge-trash/);
    // ...and never names a reclaim verb (`worktree gc` / `worktree reap`).
    expect(cmd).not.toMatch(/worktree (gc|reap)(\s|$)/);
  });

  it("WARNs when the newest record is older than the window — the sweep stopped", () => {
    const r = reapSweepRow(LOG, { kind: "ok", generatedAtMs: NOW - 96 * 3_600_000 }, 48, NOW);
    expect(r.status).toBe("warn");
    expect(r.detail).toMatch(/stopped running/);
    expect(r.detail).toMatch(/4\.0d ago/);
  });

  it("skips (never warns) when the log exists but cannot be parsed", () => {
    const r = reapSweepRow(LOG, { kind: "unreadable", msg: "permission denied" }, 48, NOW);
    expect(r.status).toBe("skip");
  });

  it("is dropped on a host with no agents directory — nothing to sweep, no noise", () => {
    const present = new Set(["/", "/home", "/home/op"]);
    const cfg = configWith({
      switchroom: { version: 1, agents_dir: "/home/op/.switchroom/agents", skills_dir: "/s" } as never,
    });
    const rows = runDiskChecks(
      cfg,
      deps(fsAt(10), {
        exists: (p) => present.has(p),
        readReapLog: () => ({ kind: "absent" }),
      }),
    );
    expect(rows.some((r) => r.name.startsWith("worktree reap sweep"))).toBe(false);
    // ...but the free-space row is still there. Disk pressure is measured
    // everywhere; only the sweep row is fleet-conditional.
    expect(rows.some((r) => r.name === "free space: agent homes")).toBe(true);
  });

  it("IS emitted on a host whose agents directory exists", () => {
    const rows = runDiskChecks(
      configWith(),
      deps(fsAt(10), { readReapLog: () => ({ kind: "absent" }) }),
    );
    const row = rows.find((r) => r.name.startsWith("worktree reap sweep"));
    expect(row?.status).toBe("warn");
  });

  it("is dropped entirely when disk.reap_report.enabled is false", () => {
    const cfg = configWith({ disk: { reap_report: { enabled: false } } } as never);
    const rows = runDiskChecks(cfg, deps(fsAt(10)));
    expect(rows.some((r) => r.name.startsWith("worktree reap sweep"))).toBe(false);
  });

  it("honours a custom log path and freshness window", () => {
    const seen: string[] = [];
    const cfg = configWith({
      disk: { reap_report: { log: "/srv/reap.jsonl", max_age_hours: 6 } },
    } as never);
    const rows = runDiskChecks(
      cfg,
      deps(fsAt(10), {
        readReapLog: (p) => {
          seen.push(p);
          return { kind: "ok", generatedAtMs: Date.UTC(2026, 7, 15, 12, 0, 0) - 7 * 3_600_000 };
        },
      }),
    );
    expect(seen).toEqual(["/srv/reap.jsonl"]);
    const row = rows.find((r) => r.name.startsWith("worktree reap sweep"))!;
    expect(row.status).toBe("warn");
    expect(row.detail).toMatch(/6h freshness window/);
  });
});

describe("readReapLog — real files", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reaplog-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports `absent` for a path that does not exist", () => {
    expect(readReapLog(join(dir, "nope.jsonl"))).toEqual({ kind: "absent" });
  });

  it("reports `empty` for a zero-byte log", () => {
    const p = join(dir, "e.jsonl");
    writeFileSync(p, "");
    expect(readReapLog(p)).toEqual({ kind: "empty" });
  });

  it("returns the NEWEST record's generatedAt, not the first", () => {
    const p = join(dir, "l.jsonl");
    writeFileSync(
      p,
      JSON.stringify({ generatedAt: "2026-08-01T00:00:00.000Z" }) + "\n" +
        JSON.stringify({ generatedAt: "2026-08-14T03:40:00.000Z" }) + "\n",
    );
    expect(readReapLog(p)).toEqual({
      kind: "ok",
      generatedAtMs: Date.parse("2026-08-14T03:40:00.000Z"),
    });
  });

  it("reads only the tail — a multi-megabyte log still yields the newest record", () => {
    const p = join(dir, "big.jsonl");
    // ~2 MB of prior records, then the one that matters.
    const filler =
      JSON.stringify({ generatedAt: "2020-01-01T00:00:00.000Z", pad: "x".repeat(900) }) + "\n";
    writeFileSync(p, filler.repeat(2200) + JSON.stringify({ generatedAt: "2026-08-14T03:40:00.000Z" }) + "\n");
    expect(statSync(p).size).toBeGreaterThan(2 * REAP_LOG_TAIL_BYTES);
    expect(readReapLog(p)).toEqual({
      kind: "ok",
      generatedAtMs: Date.parse("2026-08-14T03:40:00.000Z"),
    });
  });

  it("reports `unreadable` (a skip, not a warn) for a corrupt trailing line", () => {
    const p = join(dir, "bad.jsonl");
    writeFileSync(p, JSON.stringify({ generatedAt: "2026-08-14T03:40:00.000Z" }) + "\n{oops\n");
    expect(readReapLog(p).kind).toBe("unreadable");
  });
});

describe("DiskConfigSchema", () => {
  it("defaults to WARN 80 / FAIL 90 and a 48h reap freshness window", () => {
    const v = DiskConfigSchema.parse({});
    expect(v.warn_pct).toBe(80);
    expect(v.fail_pct).toBe(90);
    expect(v.reap_report.enabled).toBe(true);
    expect(v.reap_report.max_age_hours).toBe(48);
    expect(v.reap_report.log).toBe("/var/log/switchroom/reap-report.jsonl");
  });

  it("rejects a fail threshold at or below the warn threshold", () => {
    // Inverted thresholds would make the FAIL band unreachable — a check that
    // can never go red is the bug this PR exists to fix, re-introduced by config.
    expect(DiskConfigSchema.safeParse({ warn_pct: 90, fail_pct: 80 }).success).toBe(false);
    expect(DiskConfigSchema.safeParse({ warn_pct: 90, fail_pct: 90 }).success).toBe(false);
    expect(DiskConfigSchema.safeParse({ warn_pct: 70, fail_pct: 90 }).success).toBe(true);
  });

  it("is present on the top-level config with defaults applied", () => {
    const parsed = SwitchroomConfigSchema.parse({
      switchroom: { version: 1 },
      telegram: { bot_token: "x", forum_chat_id: "-1001234567890" },
      agents: { assistant: { topic_name: "A" } },
    });
    expect(parsed.disk.warn_pct).toBe(80);
    expect(parsed.disk.fail_pct).toBe(90);
  });
});

describe("doctor wiring", () => {
  // An unwired probe is exactly the pre-fix state: the code to measure free
  // space existing somewhere while `switchroom doctor` still reports nothing.
  // Same structure-only shape as tests/cli.doctor.memory.test.ts.
  it("`switchroom doctor` registers the Disk headroom section", () => {
    const src = readFileSync("src/cli/doctor.ts", "utf-8");
    expect(src).toContain('from "./doctor-disk.js"');
    expect(src).toContain('title: "Disk headroom"');
    expect(src).toContain("results: runDiskChecks(config)");
  });
});

describe("helpers", () => {
  it("nearestExistingPath walks up to the first existing ancestor", () => {
    const present = new Set(["/", "/home", "/home/op"]);
    expect(nearestExistingPath("/home/op/.switchroom/agents", (p) => present.has(p))).toBe(
      "/home/op",
    );
  });

  it("nearestExistingPath returns null when even the root is unreadable", () => {
    expect(nearestExistingPath("/a/b/c", () => false)).toBeNull();
  });

  it("fmtBytes uses base-1024 units like df -h", () => {
    expect(fmtBytes(0)).toBe("0B");
    expect(fmtBytes(1024)).toBe("1.0K");
    expect(fmtBytes(5 * 1024 ** 3)).toBe("5.0G");
  });

  it("diskRow reports numbers even when it is ok", () => {
    const r = diskRow("x", "/p", usageFromStatfs(fsAt(10)));
    expect(r.status).toBe("ok");
    expect(r.detail).toMatch(/free of/);
    expect(r.detail).toMatch(/% used/);
  });
});
