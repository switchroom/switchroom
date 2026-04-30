import { describe, it, expect } from "vitest";
import {
  evaluateFallbackTrigger,
  performAutoFallback,
  nextLockout,
  emptyLockout,
  DEFAULT_TRIGGER_UTILIZATION_PCT,
  DEFAULT_FALLBACK_COOLDOWN_MS,
  type LockoutRecord,
  type FallbackDecision,
} from "../auto-fallback";
import type { QuotaResult } from "../quota-check";

const NOW = 1_780_000_000_000;

function okQuota(fivePct: number, sevenPct = 0, resetOffsetMs = 60 * 60_000): QuotaResult {
  return {
    ok: true,
    data: {
      fiveHourUtilizationPct: fivePct,
      sevenDayUtilizationPct: sevenPct,
      fiveHourResetAt: new Date(NOW + resetOffsetMs),
      sevenDayResetAt: new Date(NOW + resetOffsetMs * 2),
      representativeClaim: null,
      overageStatus: null,
      overageDisabledReason: null,
    },
  };
}

describe("evaluateFallbackTrigger", () => {
  it("no active slot → noop", () => {
    const d = evaluateFallbackTrigger({
      quota: okQuota(100),
      activeSlot: null,
      now: NOW,
      lockout: emptyLockout(),
    });
    expect(d.action).toBe("noop");
  });

  it("utilization below threshold → noop", () => {
    const d = evaluateFallbackTrigger({
      quota: okQuota(95),
      activeSlot: "default",
      now: NOW,
      lockout: emptyLockout(),
    });
    expect(d.action).toBe("noop");
  });

  it("5h utilization at default threshold → fallback", () => {
    const d = evaluateFallbackTrigger({
      quota: okQuota(DEFAULT_TRIGGER_UTILIZATION_PCT, 50),
      activeSlot: "default",
      now: NOW,
      lockout: emptyLockout(),
    });
    expect(d.action).toBe("fallback");
    if (d.action === "fallback") {
      expect(d.triggerReason).toBe("utilization-over-threshold");
      expect(d.utilizationPct).toBe(DEFAULT_TRIGGER_UTILIZATION_PCT);
    }
  });

  it("7d utilization over threshold (5h fine) → still fallback", () => {
    const d = evaluateFallbackTrigger({
      quota: okQuota(80, 100),
      activeSlot: "default",
      now: NOW,
      lockout: emptyLockout(),
    });
    expect(d.action).toBe("fallback");
    if (d.action === "fallback") expect(d.utilizationPct).toBe(100);
  });

  it("saw429=true short-circuits utilization check", () => {
    const d = evaluateFallbackTrigger({
      quota: okQuota(40, 40),
      activeSlot: "default",
      now: NOW,
      lockout: emptyLockout(),
      saw429: true,
    });
    expect(d.action).toBe("fallback");
    if (d.action === "fallback") expect(d.triggerReason).toBe("429-response");
  });

  it("within cooldown for same slot → noop", () => {
    const lockout: LockoutRecord = { lastTransitionedFrom: "default", lastTransitionAt: NOW - 10_000 };
    const d = evaluateFallbackTrigger({
      quota: okQuota(100),
      activeSlot: "default",
      now: NOW,
      lockout,
    });
    expect(d.action).toBe("noop");
    if (d.action === "noop") expect(d.reason).toMatch(/cooldown/);
  });

  it("cooldown expired → fallback fires again", () => {
    const lockout: LockoutRecord = {
      lastTransitionedFrom: "default",
      lastTransitionAt: NOW - DEFAULT_FALLBACK_COOLDOWN_MS - 1,
    };
    const d = evaluateFallbackTrigger({
      quota: okQuota(100),
      activeSlot: "default",
      now: NOW,
      lockout,
    });
    expect(d.action).toBe("fallback");
  });

  it("cooldown applies per-slot (different slot allowed)", () => {
    const lockout: LockoutRecord = { lastTransitionedFrom: "personal", lastTransitionAt: NOW - 10_000 };
    const d = evaluateFallbackTrigger({
      quota: okQuota(100),
      activeSlot: "default",
      now: NOW,
      lockout,
    });
    expect(d.action).toBe("fallback");
  });

  it("quota fetch failed → noop with reason", () => {
    const quota: QuotaResult = { ok: false, reason: "no OAuth token" };
    const d = evaluateFallbackTrigger({
      quota,
      activeSlot: "default",
      now: NOW,
      lockout: emptyLockout(),
    });
    expect(d.action).toBe("noop");
    if (d.action === "noop") expect(d.reason).toMatch(/no OAuth/);
  });

  it("quota ok but no utilization headers → noop", () => {
    const quota: QuotaResult = {
      ok: true,
      data: {
        fiveHourUtilizationPct: null as unknown as number,
        sevenDayUtilizationPct: null as unknown as number,
        fiveHourResetAt: null,
        sevenDayResetAt: null,
        representativeClaim: null,
        overageStatus: null,
        overageDisabledReason: null,
      },
    };
    const d = evaluateFallbackTrigger({
      quota,
      activeSlot: "default",
      now: NOW,
      lockout: emptyLockout(),
    });
    expect(d.action).toBe("noop");
  });

  it("custom threshold override respected", () => {
    const d = evaluateFallbackTrigger({
      quota: okQuota(90),
      activeSlot: "default",
      now: NOW,
      lockout: emptyLockout(),
      thresholdPct: 85,
    });
    expect(d.action).toBe("fallback");
  });
});

describe("performAutoFallback", () => {
  const baseDecision: Extract<FallbackDecision, { action: "fallback" }> = {
    action: "fallback",
    triggerReason: "utilization-over-threshold",
    resetAtMs: NOW + 60 * 60_000,
    utilizationPct: 100,
  };

  function mkDeps(overrides?: Partial<{ active: string | null; next: string | null; previous: string | null }>) {
    const marks: Array<{ slot: string; resetAtMs?: number; reason?: string }> = [];
    const fallbacks: Array<{ name: string; agentDir: string }> = [];
    const initialActive = overrides?.active === undefined ? "default" : overrides.active;
    return {
      marks,
      fallbacks,
      deps: {
        currentActiveSlot: () => initialActive,
        markSlotQuotaExhausted: (
          _agentDir: string,
          slot: string,
          resetAtMs?: number,
          reason?: string,
        ) => {
          marks.push({ slot, resetAtMs, reason });
        },
        fallbackToNextSlot: (name: string, agentDir: string) => {
          fallbacks.push({ name, agentDir });
          return {
            newActive: overrides?.next === undefined ? "personal" : overrides.next,
            previous: overrides?.previous === undefined ? initialActive : overrides.previous,
          };
        },
      },
    };
  }

  it("healthy fallback available → executes swap", () => {
    const { marks, fallbacks, deps } = mkDeps();
    const plan = performAutoFallback({
      agentDir: "/tmp/x",
      agentName: "clerk",
      decision: baseDecision,
      deps,
    });
    expect(plan.kind).toBe("executed");
    if (plan.kind === "executed") {
      expect(plan.previousSlot).toBe("default");
      expect(plan.newSlot).toBe("personal");
      expect(plan.notificationHtml).toContain("Quota exhausted");
      // Slot names appear in the detail text (migrated to renderOperatorEvent)
      expect(plan.notificationHtml).toContain("default");
      expect(plan.notificationHtml).toContain("personal");
    }
    expect(marks).toHaveLength(1);
    expect(marks[0].slot).toBe("default");
    expect(marks[0].reason).toBe("utilization-over-threshold");
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0].name).toBe("clerk");
  });

  it("no fallback available → exhausted-all plan", () => {
    const { marks, deps } = mkDeps({ next: null });
    const plan = performAutoFallback({
      agentDir: "/tmp/x",
      agentName: "clerk",
      decision: baseDecision,
      deps,
    });
    expect(plan.kind).toBe("exhausted-all");
    if (plan.kind === "exhausted-all") {
      expect(plan.notificationHtml).toContain("All account slots");
      expect(plan.notificationHtml).toContain("/auth add clerk");
    }
    // Still marks the active slot exhausted before giving up.
    expect(marks).toHaveLength(1);
  });

  it("fallbackToNextSlot returns same slot → treated as exhausted-all", () => {
    const { deps } = mkDeps({ next: "default", previous: "default" });
    const plan = performAutoFallback({
      agentDir: "/tmp/x",
      agentName: "clerk",
      decision: baseDecision,
      deps,
    });
    expect(plan.kind).toBe("exhausted-all");
  });

  it("no active slot when invoked → exhausted-all without marking", () => {
    const { marks, deps } = mkDeps({ active: null });
    const plan = performAutoFallback({
      agentDir: "/tmp/x",
      agentName: "clerk",
      decision: baseDecision,
      deps,
    });
    expect(plan.kind).toBe("exhausted-all");
    expect(marks).toHaveLength(0);
  });

  it("uses Anthropic reset timestamp when available", () => {
    const { deps } = mkDeps();
    const resetAt = NOW + 3600_000;
    const plan = performAutoFallback({
      agentDir: "/tmp/x",
      agentName: "clerk",
      decision: { ...baseDecision, resetAtMs: resetAt },
      deps,
    });
    if (plan.kind === "executed") {
      expect(plan.resetAtMs).toBe(resetAt);
      expect(plan.notificationHtml).toContain("Reset at");
    }
  });

  it("escapes HTML in agent + slot names in notification", () => {
    const { deps } = mkDeps({ previous: "<evil>", next: "<also>" });
    const plan = performAutoFallback({
      agentDir: "/tmp/x",
      agentName: "<danger>",
      decision: baseDecision,
      deps,
    });
    expect(plan.notificationHtml).toContain("&lt;evil&gt;");
    expect(plan.notificationHtml).toContain("&lt;also&gt;");
    expect(plan.notificationHtml).toContain("&lt;danger&gt;");
    expect(plan.notificationHtml).not.toContain("<evil>");
  });
});

describe("nextLockout / emptyLockout", () => {
  it("emptyLockout has no previous slot", () => {
    const l = emptyLockout();
    expect(l.lastTransitionedFrom).toBeNull();
    expect(l.lastTransitionAt).toBe(0);
  });
  it("nextLockout records the slot we just transitioned from", () => {
    const l = nextLockout("default", NOW);
    expect(l.lastTransitionedFrom).toBe("default");
    expect(l.lastTransitionAt).toBe(NOW);
  });
});

describe("loadLockout / saveLockout (#417)", () => {
  // Use require to avoid hoisting the import to top of file (and to keep the
  // existing import block untouched).
  const { loadLockout, saveLockout } = require("../auto-fallback") as typeof import("../auto-fallback");

  function fakeOps() {
    const files = new Map<string, string>();
    const dirs = new Set<string>();
    return {
      files,
      dirs,
      readFileSync: (p: string) => {
        const v = files.get(p);
        if (v === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return v;
      },
      writeFileSync: (p: string, data: string) => {
        files.set(p, data);
      },
      existsSync: (p: string) => files.has(p),
      mkdirSync: (p: string) => {
        dirs.add(p);
      },
      joinPath: (...parts: string[]) => parts.join("/"),
    };
  }

  it("returns emptyLockout when no file exists", () => {
    const ops = fakeOps();
    expect(loadLockout("/agent", ops)).toEqual(emptyLockout());
  });

  it("round-trips a saved lockout", () => {
    const ops = fakeOps();
    const original = nextLockout("default", NOW);
    saveLockout("/agent", original, ops);
    expect(loadLockout("/agent", ops)).toEqual(original);
  });

  it("creates the .claude directory before writing", () => {
    const ops = fakeOps();
    saveLockout("/agent", nextLockout("default", NOW), ops);
    expect(ops.dirs.has("/agent/.claude")).toBe(true);
  });

  it("falls back to emptyLockout on malformed JSON (not a hard fail)", () => {
    const ops = fakeOps();
    ops.files.set("/agent/.claude/auto-fallback-lockout.json", "{broken json");
    expect(loadLockout("/agent", ops)).toEqual(emptyLockout());
  });

  it("falls back to emptyLockout on missing fields", () => {
    const ops = fakeOps();
    ops.files.set(
      "/agent/.claude/auto-fallback-lockout.json",
      JSON.stringify({ wrong: "shape" }),
    );
    expect(loadLockout("/agent", ops)).toEqual(emptyLockout());
  });

  it("falls back to emptyLockout on non-finite lastTransitionAt", () => {
    const ops = fakeOps();
    ops.files.set(
      "/agent/.claude/auto-fallback-lockout.json",
      JSON.stringify({ lastTransitionedFrom: "x", lastTransitionAt: "nope" }),
    );
    expect(loadLockout("/agent", ops)).toEqual(emptyLockout());
  });
});
