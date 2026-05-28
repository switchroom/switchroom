/**
 * Unit tests for the proactive quota threshold-tier push helper (#E4).
 * Mirrors the shape of credits-watch.test.ts. Covers:
 *   - Pure decision logic across all transition-table cases
 *   - State persistence round-trip
 *   - Message body content sanity
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  evaluateQuotaWatchAccount,
  loadQuotaWatchState,
  saveQuotaWatchState,
  patchQuotaWatchState,
  emptyQuotaWatchState,
  emptyAccountState,
} from "../quota-watch.js";
import type { AccountSnapshot } from "../auth-snapshot-format.js";
import type { QuotaUtilization } from "../quota-check.js";

// ── test fixtures ────────────────────────────────────────────────────────────

const NOW = 1_780_000_000_000;

/** Build a minimal QuotaUtilization at given utilization percentages. */
function makeQuota(
  fivePct: number,
  sevenPct: number,
  fiveHourResetAt?: Date,
  sevenDayResetAt?: Date,
): QuotaUtilization {
  return {
    fiveHourUtilizationPct: fivePct,
    sevenDayUtilizationPct: sevenPct,
    fiveHourResetAt: fiveHourResetAt ?? null,
    sevenDayResetAt: sevenDayResetAt ?? null,
    representativeClaim: null,
    overageStatus: null,
    overageDisabledReason: null,
  };
}

/** Build an AccountSnapshot with given quota. */
function makeSnap(
  label: string,
  quota: QuotaUtilization | null,
  isActive = false,
): AccountSnapshot {
  return { label, isActive, quota };
}

const HEALTHY_SNAP = makeSnap("alice@example.com", makeQuota(30, 40));
const THROTTLING_5H = makeSnap("alice@example.com", makeQuota(85, 40));
const THROTTLING_7D = makeSnap("alice@example.com", makeQuota(40, 90));
const BLOCKED_SNAP = makeSnap("alice@example.com", makeQuota(99.9, 99.9));
const UNKNOWN_SNAP = makeSnap("alice@example.com", null);

const PREV_NEVER_NOTIFIED = emptyAccountState(); // lastNotifiedHealth: null
const PREV_WAS_HEALTHY = { lastNotifiedHealth: "healthy" as const, lastNotifiedAt: NOW - 1000 };
const PREV_WAS_THROTTLING = { lastNotifiedHealth: "throttling" as const, lastNotifiedAt: NOW - 1000 };

// ── transition decision tests ────────────────────────────────────────────────

describe("evaluateQuotaWatchAccount — transition table", () => {
  it("healthy → healthy (never notified) skips", () => {
    const d = evaluateQuotaWatchAccount({
      agentName: "lawgpt",
      snap: HEALTHY_SNAP,
      prev: PREV_NEVER_NOTIFIED,
      now: NOW,
    });
    expect(d.kind).toBe("skip");
    if (d.kind !== "skip") return;
    expect(d.reason).toBe("steady-state");
  });

  it("healthy → healthy (was healthy) skips", () => {
    const d = evaluateQuotaWatchAccount({
      agentName: "lawgpt",
      snap: HEALTHY_SNAP,
      prev: PREV_WAS_HEALTHY,
      now: NOW,
    });
    expect(d.kind).toBe("skip");
  });

  it("healthy → throttling (5h) fires entered-throttling notification", () => {
    const d = evaluateQuotaWatchAccount({
      agentName: "lawgpt",
      snap: THROTTLING_5H,
      prev: PREV_NEVER_NOTIFIED,
      now: NOW,
    });
    expect(d.kind).toBe("notify");
    if (d.kind !== "notify") return;
    expect(d.transition).toBe("entered-throttling");
    expect(d.newAccountState.lastNotifiedHealth).toBe("throttling");
    expect(d.newAccountState.lastNotifiedAt).toBe(NOW);
  });

  it("healthy → throttling (7d) fires entered-throttling notification", () => {
    const d = evaluateQuotaWatchAccount({
      agentName: "lawgpt",
      snap: THROTTLING_7D,
      prev: PREV_NEVER_NOTIFIED,
      now: NOW,
    });
    expect(d.kind).toBe("notify");
    if (d.kind !== "notify") return;
    expect(d.transition).toBe("entered-throttling");
  });

  it("throttling → throttling skips (already notified)", () => {
    const d = evaluateQuotaWatchAccount({
      agentName: "lawgpt",
      snap: THROTTLING_5H,
      prev: PREV_WAS_THROTTLING,
      now: NOW,
    });
    expect(d.kind).toBe("skip");
    if (d.kind !== "skip") return;
    expect(d.reason).toBe("steady-state");
  });

  it("throttling → healthy fires recovered-to-healthy notification", () => {
    const d = evaluateQuotaWatchAccount({
      agentName: "lawgpt",
      snap: HEALTHY_SNAP,
      prev: PREV_WAS_THROTTLING,
      now: NOW,
    });
    expect(d.kind).toBe("notify");
    if (d.kind !== "notify") return;
    expect(d.transition).toBe("recovered-to-healthy");
    expect(d.newAccountState.lastNotifiedHealth).toBe("healthy");
    expect(d.newAccountState.lastNotifiedAt).toBe(NOW);
  });

  it("* → blocked skips (credits-watch domain)", () => {
    const dFromHealthy = evaluateQuotaWatchAccount({
      agentName: "lawgpt",
      snap: BLOCKED_SNAP,
      prev: PREV_NEVER_NOTIFIED,
      now: NOW,
    });
    expect(dFromHealthy.kind).toBe("skip");
    if (dFromHealthy.kind !== "skip") return;
    expect(dFromHealthy.reason).toBe("blocked-not-our-domain");
  });

  it("blocked → healthy skips (credits-watch domain)", () => {
    // blocked → healthy: credits-watch handles the blocked recovery path.
    // Our watcher should not fire for it (we never tracked 'blocked').
    const d = evaluateQuotaWatchAccount({
      agentName: "lawgpt",
      snap: HEALTHY_SNAP,
      prev: PREV_NEVER_NOTIFIED, // we were never tracking as throttling
      now: NOW,
    });
    // healthy → healthy from null-prev should skip, not fire
    expect(d.kind).toBe("skip");
  });

  it("unknown quota snap skips (probe failed)", () => {
    const d = evaluateQuotaWatchAccount({
      agentName: "lawgpt",
      snap: UNKNOWN_SNAP,
      prev: PREV_WAS_THROTTLING,
      now: NOW,
    });
    expect(d.kind).toBe("skip");
    if (d.kind !== "skip") return;
    expect(d.reason).toBe("unknown-not-our-domain");
  });

  it("no duplicate: two consecutive polls in throttling state produce one notify then skip", () => {
    // First poll: healthy → throttling → notify
    const d1 = evaluateQuotaWatchAccount({
      agentName: "lawgpt",
      snap: THROTTLING_5H,
      prev: PREV_NEVER_NOTIFIED,
      now: NOW,
    });
    expect(d1.kind).toBe("notify");
    if (d1.kind !== "notify") return;

    // Second poll: throttling → throttling → skip
    const d2 = evaluateQuotaWatchAccount({
      agentName: "lawgpt",
      snap: THROTTLING_5H,
      prev: d1.newAccountState,
      now: NOW + 15 * 60_000,
    });
    expect(d2.kind).toBe("skip");
  });
});

// ── message content tests ────────────────────────────────────────────────────

describe("evaluateQuotaWatchAccount — message content", () => {
  it("throttling message contains account label and percentages", () => {
    const d = evaluateQuotaWatchAccount({
      agentName: "lawgpt",
      snap: THROTTLING_5H,
      prev: PREV_NEVER_NOTIFIED,
      now: NOW,
    });
    expect(d.kind).toBe("notify");
    if (d.kind !== "notify") return;
    expect(d.message).toContain("alice@example.com");
    expect(d.message).toContain("85%");
    expect(d.message).toContain("40%");
    expect(d.message).toContain("5-hour");
  });

  it("recovery message contains account label and percentages", () => {
    const d = evaluateQuotaWatchAccount({
      agentName: "lawgpt",
      snap: HEALTHY_SNAP,
      prev: PREV_WAS_THROTTLING,
      now: NOW,
    });
    expect(d.kind).toBe("notify");
    if (d.kind !== "notify") return;
    expect(d.message).toContain("alice@example.com");
    expect(d.message).toContain("Quota back in healthy range");
    expect(d.message).toContain("30%");
  });

  it("throttling message HTML-escapes account label", () => {
    const d = evaluateQuotaWatchAccount({
      agentName: "lawgpt",
      snap: makeSnap("<evil>@example.com", makeQuota(85, 40)),
      prev: PREV_NEVER_NOTIFIED,
      now: NOW,
    });
    expect(d.kind).toBe("notify");
    if (d.kind !== "notify") return;
    expect(d.message).toContain("&lt;evil&gt;");
    expect(d.message).not.toContain("<evil>");
  });

  it("throttling message for active account mentions /auth use", () => {
    const activeSnap = makeSnap("alice@example.com", makeQuota(85, 40), /* isActive */ true);
    const d = evaluateQuotaWatchAccount({
      agentName: "lawgpt",
      snap: activeSnap,
      prev: PREV_NEVER_NOTIFIED,
      now: NOW,
    });
    expect(d.kind).toBe("notify");
    if (d.kind !== "notify") return;
    // Active account message should mention switching
    expect(d.message).toContain("/auth");
  });

  it("throttling message includes reset time when provided", () => {
    const resetAt = new Date(NOW + 3 * 60 * 60_000); // 3 hours from now
    const d = evaluateQuotaWatchAccount({
      agentName: "lawgpt",
      snap: makeSnap("alice@example.com", makeQuota(85, 40, resetAt)),
      prev: PREV_NEVER_NOTIFIED,
      now: NOW,
    });
    expect(d.kind).toBe("notify");
    if (d.kind !== "notify") return;
    expect(d.message).toContain("refills in");
  });
});

// ── state persistence tests ──────────────────────────────────────────────────

describe("loadQuotaWatchState / saveQuotaWatchState — round-trip", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "quota-watch-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns emptyQuotaWatchState when no file exists", () => {
    expect(loadQuotaWatchState(tmp)).toEqual(emptyQuotaWatchState());
  });

  it("round-trips a saved state with multiple accounts", () => {
    const state = {
      "alice@example.com": { lastNotifiedHealth: "throttling" as const, lastNotifiedAt: 1_780_000_000_000 },
      "bob@example.com": { lastNotifiedHealth: null, lastNotifiedAt: 0 },
    };
    saveQuotaWatchState(tmp, state);
    expect(loadQuotaWatchState(tmp)).toEqual(state);
  });

  it("falls back to empty on malformed JSON", () => {
    mkdirSync(tmp, { recursive: true });
    writeFileSync(join(tmp, "quota-watch.json"), "{broken");
    expect(loadQuotaWatchState(tmp)).toEqual(emptyQuotaWatchState());
  });

  it("falls back to empty on shape mismatch (not an object)", () => {
    writeFileSync(join(tmp, "quota-watch.json"), JSON.stringify([1, 2, 3]));
    expect(loadQuotaWatchState(tmp)).toEqual(emptyQuotaWatchState());
  });

  it("drops malformed entries but preserves valid ones", () => {
    writeFileSync(
      join(tmp, "quota-watch.json"),
      JSON.stringify({
        "good@example.com": { lastNotifiedHealth: "throttling", lastNotifiedAt: 1000 },
        "bad@example.com": { lastNotifiedHealth: "invalid", lastNotifiedAt: "not-a-number" },
      }),
    );
    const loaded = loadQuotaWatchState(tmp);
    expect(loaded["good@example.com"]).toEqual({ lastNotifiedHealth: "throttling", lastNotifiedAt: 1000 });
    expect(loaded["bad@example.com"]).toBeUndefined();
  });

  it("creates the state dir on save (if it doesn't exist yet)", () => {
    const fresh = join(tmp, "fresh-subdir");
    saveQuotaWatchState(fresh, {});
    expect(loadQuotaWatchState(fresh)).toEqual({});
  });
});

// ── patchQuotaWatchState tests ────────────────────────────────────────────────

describe("patchQuotaWatchState", () => {
  it("adds a new account entry without clobbering others", () => {
    const current: ReturnType<typeof emptyQuotaWatchState> = {
      "alice@example.com": { lastNotifiedHealth: "throttling", lastNotifiedAt: 1000 },
    };
    const updated = patchQuotaWatchState(
      current,
      "bob@example.com",
      { lastNotifiedHealth: "healthy", lastNotifiedAt: 2000 },
    );
    expect(updated["alice@example.com"]).toEqual({ lastNotifiedHealth: "throttling", lastNotifiedAt: 1000 });
    expect(updated["bob@example.com"]).toEqual({ lastNotifiedHealth: "healthy", lastNotifiedAt: 2000 });
  });

  it("updates an existing account entry", () => {
    const current = {
      "alice@example.com": { lastNotifiedHealth: "throttling" as const, lastNotifiedAt: 1000 },
    };
    const updated = patchQuotaWatchState(
      current,
      "alice@example.com",
      { lastNotifiedHealth: "healthy", lastNotifiedAt: 2000 },
    );
    expect(updated["alice@example.com"]).toEqual({ lastNotifiedHealth: "healthy", lastNotifiedAt: 2000 });
  });

  it("does not mutate the original state object", () => {
    const current = {
      "alice@example.com": { lastNotifiedHealth: "throttling" as const, lastNotifiedAt: 1000 },
    };
    patchQuotaWatchState(current, "bob@example.com", { lastNotifiedHealth: null, lastNotifiedAt: 0 });
    expect(current["bob@example.com"]).toBeUndefined();
  });
});
