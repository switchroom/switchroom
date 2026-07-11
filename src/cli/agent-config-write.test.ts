import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scheduleAdd, scheduleRemove, extractCronSmallestGapMin } from "./agent-config-write.js";
import { cronUnitHash } from "../agents/cron-unit-name.js";

let root: string;
let savedEnv: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "scw-"));
  savedEnv = process.env.SWITCHROOM_AGENT_NAME;
  process.env.SWITCHROOM_AGENT_NAME = "alice";
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.SWITCHROOM_AGENT_NAME;
  else process.env.SWITCHROOM_AGENT_NAME = savedEnv;
});

describe("scheduleAdd — happy path", () => {
  it("writes cron-<sha12>.yaml and returns the hash + path", () => {
    const r = scheduleAdd({
      cronExpr: "0 9 * * *",
      prompt: "morning standup",
      root,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const expected = cronUnitHash("0 9 * * *", "morning standup");
    expect(r.cron_hash).toBe(expected);
    expect(r.slug).toBe(`cron-${expected}`);
    expect(r.would_recreate).toBe(false);
    // Since #2293 the scheduler hot-reloads, so an add is live within ~30s
    // with no restart (hot-reload is on by default).
    expect(r.restart_required).toBe(false);
    expect(r.restart_hint).toMatch(/~30s|hot-reload|no restart/i);
    expect(existsSync(r.path)).toBe(true);
    const content = readFileSync(r.path, "utf-8");
    expect(content).toContain("prompt: morning standup");
  });

  it("reports restart_required + names the agent when hot-reload is disabled", () => {
    const prev = process.env.SWITCHROOM_SCHEDULER_HOT_RELOAD;
    process.env.SWITCHROOM_SCHEDULER_HOT_RELOAD = "0";
    try {
      const r = scheduleAdd({ agent: "alice", cronExpr: "0 7 * * *", prompt: "frozen", root });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.restart_required).toBe(true);
      expect(r.restart_hint).toContain("alice");
      expect(r.restart_hint).toMatch(/restart/i);
    } finally {
      if (prev === undefined) delete process.env.SWITCHROOM_SCHEDULER_HOT_RELOAD;
      else process.env.SWITCHROOM_SCHEDULER_HOT_RELOAD = prev;
    }
  });

  it("authors a Tier-1 cheap-cron entry with --model / --context", () => {
    const r = scheduleAdd({
      agent: "alice",
      cronExpr: "0 8 * * *",
      prompt: "daily digest",
      model: "sonnet",
      context: "fresh",
      root,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const content = readFileSync(r.path, "utf-8");
    expect(content).toContain("model: sonnet");
    expect(content).toContain("context: fresh");
  });
});

describe("scheduleAdd — security gates", () => {
  it("rejects overlay write with non-empty secrets (E_OVERLAY_SECRETS_REQUIRES_APPROVAL)", () => {
    const r = scheduleAdd({
      cronExpr: "0 9 * * *",
      prompt: "needs key",
      secrets: ["foo/bar"],
      root,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("E_OVERLAY_SECRETS_REQUIRES_APPROVAL");
    expect(r.exit).toBe(9);
    // No file should have been written
    const expected = cronUnitHash("0 9 * * *", "needs key");
    expect(existsSync(join(root, "alice", "schedule.d", `cron-${expected}.yaml`))).toBe(false);
  });

  it("rejects too-frequent cron (E_CRON_TOO_FREQUENT)", () => {
    const r = scheduleAdd({
      cronExpr: "* * * * *",
      prompt: "spammy",
      root,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("E_CRON_TOO_FREQUENT");
    expect(r.exit).toBe(9);
  });

  // #1783 — CSV / range / step-on-range forms previously bypassed the
  // 5-min floor. Assert they are now rejected with E_CRON_TOO_FREQUENT.
  it.each([
    ["CSV clustered `0,1,2`", "0,1,2 * * * *"],
    ["range `0-4`", "0-4 * * * *"],
    ["step-on-range `0-30/2`", "0-30/2 * * * *"],
    ["wraparound `58,59`", "58,59 * * * *"],
    ["every-minute-during-hour `* 1 * * *`", "* 1 * * *"],
  ])("rejects sub-floor cadence %s (#1783)", (_label, cronExpr) => {
    const r = scheduleAdd({ cronExpr, prompt: "spammy", root });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("E_CRON_TOO_FREQUENT");
    expect(r.exit).toBe(9);
  });

  // #1783 — legal cadences at/above the floor must still be accepted.
  it.each([
    ["`0,30` (30-min)", "0,30 * * * *"],
    ["`*/5` (== floor)", "*/5 * * * *"],
    ["single minute `15` (hourly)", "15 * * * *"],
  ])("accepts at-or-above-floor cadence %s (#1783)", (_label, cronExpr) => {
    const r = scheduleAdd({ cronExpr, prompt: "fine", root });
    expect(r.ok).toBe(true);
  });

  // #1770 Phase 3 — envelope shape assertions parallel to the Phase 2
  // tests in tests/host-control/. The ScheduleErrorResult now carries
  // a `meta` side-channel that the CLI's emitError lifts into the
  // `error_envelope` JSON sibling on stderr. We assert the meta shape
  // here (the actual stderr serialisation is exercised end-to-end by
  // the CLI tests; the meta payload is the structured contract).
  describe("#1770 — error_envelope meta side-channel", () => {
    it("E_CRON_TOO_FREQUENT carries meta.requested_interval_min", () => {
      const r = scheduleAdd({
        cronExpr: "* * * * *",
        prompt: "spammy",
        root,
      });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.code).toBe("E_CRON_TOO_FREQUENT");
      expect(r.meta).toBeDefined();
      // `*` → 1 minute cadence (extractCronIntervalMin contract)
      expect(r.meta?.requested_interval_min).toBe(1);
    });

    it("E_CRON_TOO_FREQUENT parses */N step form", () => {
      const r = scheduleAdd({
        cronExpr: "*/2 * * * *",
        prompt: "twomin",
        root,
      });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.code).toBe("E_CRON_TOO_FREQUENT");
      expect(r.meta?.requested_interval_min).toBe(2);
    });

    it("E_QUOTA_EXCEEDED carries meta.current at the cap", () => {
      // Fill the agent to MAX_ENTRIES_PER_AGENT (20) then attempt one more.
      for (let i = 0; i < 20; i++) {
        const r = scheduleAdd({
          cronExpr: `${i} 9 * * *`,
          prompt: `task ${i}`,
          root,
        });
        expect(r.ok).toBe(true);
      }
      const overflow = scheduleAdd({
        cronExpr: "0 10 * * *",
        prompt: "one too many",
        root,
      });
      expect(overflow.ok).toBe(false);
      if (overflow.ok) return;
      expect(overflow.code).toBe("E_QUOTA_EXCEEDED");
      expect(overflow.meta?.current).toBe(20);
    });
  });

  it("empty secrets array passes through", () => {
    const r = scheduleAdd({
      cronExpr: "0 9 * * *",
      prompt: "ok",
      secrets: [],
      root,
    });
    expect(r.ok).toBe(true);
  });
});

describe("scheduleAdd — duplicate guard (#cron-dupe)", () => {
  it("rejects a second entry sharing the same cron expression (double-fire)", () => {
    // The gymbro incident: same time, DIFFERENT prompt → different slug,
    // so the content-hash overwrite misses it. The cron-expr guard catches it.
    const first = scheduleAdd({ cronExpr: "0 20 * * 0", prompt: "review v1", root });
    expect(first.ok).toBe(true);
    const dup = scheduleAdd({ cronExpr: "0 20 * * 0", prompt: "review v2", root });
    expect(dup.ok).toBe(false);
    if (dup.ok) return;
    expect(dup.code).toBe("E_CRON_DUPLICATE");
    expect(dup.exit).toBe(9);
    expect(dup.message).toMatch(/0 20 \* \* 0/);
    expect(dup.meta?.conflicting_slug).toBeDefined();
  });

  it("treats whitespace-different cron exprs as the same (still rejected)", () => {
    scheduleAdd({ cronExpr: "0 20 * * 0", prompt: "a", root });
    const dup = scheduleAdd({ cronExpr: "0  20  *  *  0", prompt: "b", root });
    expect(dup.ok).toBe(false);
    if (dup.ok) return;
    expect(dup.code).toBe("E_CRON_DUPLICATE");
  });

  it("rejects a second entry sharing the same name", () => {
    scheduleAdd({ cronExpr: "0 8 * * *", prompt: "p", name: "digest", root });
    const dup = scheduleAdd({ cronExpr: "0 9 * * *", prompt: "p2", name: "digest", root });
    expect(dup.ok).toBe(false);
    if (dup.ok) return;
    expect(dup.code).toBe("E_CRON_DUPLICATE");
    expect(dup.message).toMatch(/digest/);
  });

  it("allows distinct cron expressions + names", () => {
    expect(scheduleAdd({ cronExpr: "0 8 * * *", prompt: "a", name: "morning", root }).ok).toBe(true);
    expect(scheduleAdd({ cronExpr: "0 20 * * *", prompt: "b", name: "evening", root }).ok).toBe(true);
  });

  it("re-adding the identical cron+prompt is an overwrite, not a dupe reject", () => {
    const first = scheduleAdd({ cronExpr: "0 8 * * *", prompt: "same", root });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // Identical cron AND prompt → same content-hash slug. The cron-expr
    // guard would match the existing file, but the intent is idempotent
    // overwrite of the SAME logical cron. We still reject (the agent should
    // see "already exists") — assert the clear signal rather than a silent
    // double-write.
    const again = scheduleAdd({ cronExpr: "0 8 * * *", prompt: "same", root });
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.code).toBe("E_CRON_DUPLICATE");
  });
});

describe("scheduleRemove", () => {
  it("removes by cron_hash", () => {
    const add = scheduleAdd({ cronExpr: "0 9 * * *", prompt: "p", root });
    expect(add.ok).toBe(true);
    if (!add.ok) return;
    const r = scheduleRemove({ cronHash: add.cron_hash, root });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Hot-reload (#2293): a remove is picked up within ~30s, no restart.
    expect(r.restart_required).toBe(false);
    expect(r.restart_hint).toMatch(/~30s|hot-reload|no restart/i);
    expect(existsSync(add.path)).toBe(false);
  });

  it("removes by name (matches the YAML header comment)", () => {
    const add = scheduleAdd({
      cronExpr: "0 9 * * *",
      prompt: "p",
      name: "morning",
      root,
    });
    expect(add.ok).toBe(true);
    if (!add.ok) return;
    const r = scheduleRemove({ name: "morning", root });
    expect(r.ok).toBe(true);
  });

  it("returns E_NOT_FOUND for missing target", () => {
    const r = scheduleRemove({ name: "nope", root });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("E_NOT_FOUND");
  });

  it("requires either name or cron_hash", () => {
    const r = scheduleRemove({ root });
    expect(r.ok).toBe(false);
  });
});

describe("scheduleAdd — reconcile trigger (hot-apply wiring)", () => {
  it("calls reconcile once with the caller agent name on successful add", () => {
    const calls: string[] = [];
    const r = scheduleAdd({
      cronExpr: "0 9 * * *",
      prompt: "morning",
      root,
      reconcile: (agent) => {
        calls.push(agent);
        return { ok: true, changes: [], cronScripts: [] };
      },
    });
    expect(r.ok).toBe(true);
    expect(calls).toEqual(["alice"]);
  });

  it("rolls back the overlay write when reconcile fails, returns E_RECONCILE_FAILED", () => {
    const r = scheduleAdd({
      cronExpr: "0 9 * * *",
      prompt: "boom",
      root,
      reconcile: () => ({ ok: false, error: "scheduler exploded" }),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("E_RECONCILE_FAILED");
    expect(r.exit).toBe(10);
    expect(r.message).toContain("scheduler exploded");
    // The overlay file must be gone (rollback).
    const expected = cronUnitHash("0 9 * * *", "boom");
    expect(
      existsSync(join(root, "alice", "schedule.d", `cron-${expected}.yaml`)),
    ).toBe(false);
  });
});

describe("scheduleRemove — reconcile trigger", () => {
  it("calls reconcile once with the caller agent on successful remove", () => {
    const add = scheduleAdd({ cronExpr: "0 9 * * *", prompt: "p", root });
    expect(add.ok).toBe(true);
    if (!add.ok) return;
    const calls: string[] = [];
    const r = scheduleRemove({
      cronHash: add.cron_hash,
      root,
      reconcile: (agent) => {
        calls.push(agent);
        return { ok: true, changes: [], cronScripts: [] };
      },
    });
    expect(r.ok).toBe(true);
    expect(calls).toEqual(["alice"]);
  });

  it("restores the deleted overlay file when reconcile fails", () => {
    const add = scheduleAdd({ cronExpr: "0 9 * * *", prompt: "p", root });
    expect(add.ok).toBe(true);
    if (!add.ok) return;
    const before = readFileSync(add.path, "utf-8");
    const r = scheduleRemove({
      cronHash: add.cron_hash,
      root,
      reconcile: () => ({ ok: false, error: "nope" }),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("E_RECONCILE_FAILED");
    expect(existsSync(add.path)).toBe(true);
    expect(readFileSync(add.path, "utf-8")).toBe(before);
  });
});

describe("scheduleAdd — cross-agent denial", () => {
  it("throws when --agent mismatches the env-pinned identity", () => {
    expect(() => {
      scheduleAdd({ agent: "other-agent", cronExpr: "0 9 * * *", prompt: "p", root });
    }).toThrow(/cross-agent/);
  });
});

// #1779 — extractCronSmallestGapMin returns the *smallest gap* between
// consecutive fires, used as the rejection signal for the 5-min floor.
// Explicitly NOT the worst-case wait (see fn docstring). For
// `0,1,2 * * * *` the worst-case wait is ~58 min, but the rejection
// signal — and what this fn returns — is the smallest gap (1 min).
describe("extractCronSmallestGapMin (#1779)", () => {
  it("CSV `0,1,2` → 1 (smallest gap is the rejection signal, not 58)", () => {
    expect(extractCronSmallestGapMin("0,1,2 * * * *")).toBe(1);
  });
  it("CSV `0,30` → 30", () => {
    expect(extractCronSmallestGapMin("0,30 * * * *")).toBe(30);
  });
  it("CSV `0,15,30,45` → 15", () => {
    expect(extractCronSmallestGapMin("0,15,30,45 * * * *")).toBe(15);
  });
  it("stepped `*/5` → 5 (== floor, accepted)", () => {
    expect(extractCronSmallestGapMin("*/5 * * * *")).toBe(5);
  });
  it("stepped `*/4` → 4 (< floor, rejected)", () => {
    expect(extractCronSmallestGapMin("*/4 * * * *")).toBe(4);
  });
  it("`*` → 1 (every minute)", () => {
    expect(extractCronSmallestGapMin("* * * * *")).toBe(1);
  });
  // #1783 — range / step-on-range / single-value forms are now expanded
  // (previously returned 0 and bypassed the floor).
  it("range `0-4` → 1 (fires every minute for 5 mins)", () => {
    expect(extractCronSmallestGapMin("0-4 * * * *")).toBe(1);
  });
  it("range `0-30` → 1", () => {
    expect(extractCronSmallestGapMin("0-30 * * * *")).toBe(1);
  });
  it("step-on-range `0-30/2` → 2", () => {
    expect(extractCronSmallestGapMin("0-30/2 * * * *")).toBe(2);
  });
  it("single value `15` → 60 (hourly)", () => {
    expect(extractCronSmallestGapMin("15 * * * *")).toBe(60);
  });
  it("wraparound CSV `58,59` → 1 (circular gap)", () => {
    expect(extractCronSmallestGapMin("58,59 * * * *")).toBe(1);
  });
  it("unparseable / out-of-range forms → 0 (unknown, pass through)", () => {
    expect(extractCronSmallestGapMin("bogus")).toBe(0);
    expect(extractCronSmallestGapMin("75 * * * *")).toBe(0);
  });
});
