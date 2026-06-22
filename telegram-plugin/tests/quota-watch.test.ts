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
  evaluateFleetAllExhausted,
  loadQuotaWatchState,
  saveQuotaWatchState,
  patchQuotaWatchState,
  emptyQuotaWatchState,
  emptyAccountState,
  isLiveCorroboration,
  type CorroborationProbe,
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

  it("#2495 Change 3 — throttling alarm advertises live-probe corroboration, not a raw cache read", () => {
    const d = evaluateQuotaWatchAccount({
      agentName: "lawgpt",
      snap: THROTTLING_5H,
      prev: PREV_NEVER_NOTIFIED,
      now: NOW,
    });
    expect(d.kind).toBe("notify");
    if (d.kind !== "notify") return;
    // The alarm body's source-of-truth footnote must reflect that the gateway
    // corroborates the alarm with a forceLive probe (the broker re-probe at
    // gateway.ts runQuotaWatch), not "Source: broker quota cache".
    expect(d.message).toContain("Live-probe corroborated");
    expect(d.message).not.toContain("Source: broker quota cache");
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

// ── corroboration gate (#2495 BLOCKER) ───────────────────────────────────────

describe("isLiveCorroboration — only a genuine live probe corroborates (#2495 BLOCKER)", () => {
  // A successful upstream live probe.
  const LIVE_OK: CorroborationProbe = { result: { ok: true }, served: "live" };
  // The trap: under forceLive, when the upstream probe FAILS but the broker
  // holds a prior snapshot, opProbeQuota returns cachedSnapshotToResult →
  // result.ok === true but served === "cache". Vacuous corroboration.
  const CACHE_FALLBACK_AFTER_PROBE_FAIL: CorroborationProbe = {
    result: { ok: true },
    served: "cache",
  };
  // A hard probe failure with no prior snapshot to fall back on.
  const PROBE_FAILED: CorroborationProbe = { result: { ok: false }, served: "live" };

  it("a genuine live probe (ok:true, served:'live') corroborates", () => {
    expect(isLiveCorroboration(LIVE_OK)).toBe(true);
  });

  it("a failed-probe cache fallback (ok:true, served:'cache') does NOT corroborate", () => {
    // This is the BLOCKER: a stale cache read must NOT be mistaken for a live
    // corroboration, even though result.ok is true.
    expect(isLiveCorroboration(CACHE_FALLBACK_AFTER_PROBE_FAIL)).toBe(false);
  });

  it("a failed probe (ok:false) does NOT corroborate", () => {
    expect(isLiveCorroboration(PROBE_FAILED)).toBe(false);
  });

  it("a missing entry (probe absent from batch result) does NOT corroborate", () => {
    expect(isLiveCorroboration(undefined)).toBe(false);
  });

  it("a legacy entry with no `served` tag does NOT corroborate (fail-closed)", () => {
    expect(isLiveCorroboration({ result: { ok: true } })).toBe(false);
  });

  // Simulate the gateway gate (runQuotaWatch). The gate fires the alarm and
  // stamps the "Live-probe corroborated" footnote ONLY when
  // isLiveCorroboration is true; otherwise it DEFERS (state untouched).
  function gateDecision(entry: CorroborationProbe | undefined): {
    fired: boolean;
    message: string | null;
  } {
    if (isLiveCorroboration(entry)) {
      // Genuine corroboration → re-evaluate and notify with the live numbers.
      const d = evaluateQuotaWatchAccount({
        agentName: "lawgpt",
        snap: THROTTLING_5H,
        prev: PREV_NEVER_NOTIFIED,
        now: NOW,
      });
      return { fired: true, message: d.kind === "notify" ? d.message : null };
    }
    // Not corroborated → defer. No alarm, no footnote.
    return { fired: false, message: null };
  }

  it("failed-probe cache fallback → alarm DEFERRED, no false 'Live-probe corroborated' footnote", () => {
    const decision = gateDecision(CACHE_FALLBACK_AFTER_PROBE_FAIL);
    expect(decision.fired).toBe(false);
    expect(decision.message).toBeNull();
    // The false footnote must NOT be produced on this path.
    expect(decision.message ?? "").not.toContain("Live-probe corroborated");
  });

  it("genuine live probe → alarm FIRES and stamps the 'Live-probe corroborated' footnote", () => {
    const decision = gateDecision(LIVE_OK);
    expect(decision.fired).toBe(true);
    expect(decision.message).toContain("Live-probe corroborated");
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

describe("evaluateFleetAllExhausted", () => {
  const notAlerting = { lastNotifiedHealth: null, lastNotifiedAt: 0 };
  const alerting = { lastNotifiedHealth: "throttling" as const, lastNotifiedAt: 1000 };
  // Use a realistic "now" so a fresh probe (capturedAt near NOW) and a stale
  // probe (capturedAt older than maxStaleMs) are unambiguous.
  const NOW = 10_000_000_000;
  const STALE = DEFAULT_QUOTA_WATCH_MAX_STALE_MS;
  const gate = { maxStaleMs: STALE };
  /** A fresh live snapshot captured `ageMs` ago (default: just now). */
  const freshProbe = (ageMs = 0) => ({ capturedAt: NOW - ageMs });
  /** A stale snapshot, captured just past the staleness ceiling. */
  const staleProbe = () => ({ capturedAt: NOW - STALE - 1 });

  it("notifies (entered) when every exhausted account is backed by a FRESH probe", () => {
    const d = evaluateFleetAllExhausted({
      accounts: [
        { label: "a", exhausted: true, exhausted_until: NOW + 5_000, last_quota: freshProbe() },
        { label: "b", exhausted: true, exhausted_until: NOW + 9_000, last_quota: freshProbe(60_000) },
      ],
      prev: notAlerting,
      now: NOW,
      tuning: gate,
    });
    expect(d.kind).toBe("notify");
    if (d.kind === "notify") {
      expect(d.transition).toBe("entered");
      expect(d.newState.lastNotifiedHealth).toBe("throttling");
      expect(d.message).toContain("All accounts exhausted");
      // earliest reset is the +5_000 one
      expect(d.message).toContain("Earliest reset");
    }
  });

  it("skips (probe-blind) when all exhausted rests on STALE marks with no fresh probe (#2478)", () => {
    const d = evaluateFleetAllExhausted({
      accounts: [
        { label: "a", exhausted: true, exhausted_until: NOW + 5_000, last_quota: staleProbe() },
        { label: "b", exhausted: true, exhausted_until: NOW + 9_000, last_quota: null },
      ],
      prev: notAlerting,
      now: NOW,
      tuning: gate,
    });
    expect(d.kind).toBe("skip");
    if (d.kind === "skip") expect(d.reason).toBe("probe-blind");
  });

  it("skips (probe-blind) on MIXED freshness — one stale-mark-only account is enough (#2478)", () => {
    const d = evaluateFleetAllExhausted({
      accounts: [
        { label: "a", exhausted: true, exhausted_until: NOW + 5_000, last_quota: freshProbe() },
        { label: "b", exhausted: true, exhausted_until: NOW + 9_000, last_quota: staleProbe() },
      ],
      prev: notAlerting,
      now: NOW,
      tuning: gate,
    });
    expect(d.kind).toBe("skip");
    if (d.kind === "skip") expect(d.reason).toBe("probe-blind");
  });

  it("skips (probe-blind) when a probe is FUTURE-dated beyond the clock-skew tolerance (#2479 nit)", () => {
    // A future-dated capturedAt makes `now - capturedAt` negative, which would
    // slip under the staleness ceiling and read as fresh. The clock-skew guard
    // (mirrored from broker `snapshotFresh`: capturedAt <= now + 60_000) must
    // reject it so a skewed snapshot does NOT corroborate exhaustion.
    const futureProbe = () => ({ capturedAt: NOW + 60_000 + 1 }); // 1ms past tolerance
    const d = evaluateFleetAllExhausted({
      accounts: [
        { label: "a", exhausted: true, exhausted_until: NOW + 5_000, last_quota: futureProbe() },
      ],
      prev: notAlerting,
      now: NOW,
      tuning: gate,
    });
    expect(d.kind).toBe("skip");
    if (d.kind === "skip") expect(d.reason).toBe("probe-blind");
  });

  it("notifies (entered) when a probe is future-dated WITHIN the skew tolerance (boundary)", () => {
    // Exactly +60_000 ms is within tolerance and still negative-age fresh — it
    // must count as a fresh live probe (proves the guard is a future-dating
    // skew allowance, not an outright rejection of any future timestamp).
    const d = evaluateFleetAllExhausted({
      accounts: [
        { label: "a", exhausted: true, exhausted_until: NOW + 5_000, last_quota: { capturedAt: NOW + 60_000 } },
      ],
      prev: notAlerting,
      now: NOW,
      tuning: gate,
    });
    expect(d.kind).toBe("notify");
    if (d.kind === "notify") expect(d.transition).toBe("entered");
  });

  it("notifies (entered) when out_of_credits account has a FRESH probe (freshness drives corroboration, not the credits flag)", () => {
    // NEW CONTRACT (fix/out-of-credits-serve-block): out_of_credits is
    // informational — it does NOT corroborate exhaustion on its own. But a
    // genuinely fresh probe (capturedAt within maxStaleMs) still corroborates.
    // Result: still notifies — for the right reason (fresh snapshot), not the
    // credits reason.
    const d = evaluateFleetAllExhausted({
      accounts: [
        {
          label: "a",
          exhausted: true,
          last_quota: { capturedAt: NOW, overageDisabledReason: "out_of_credits" },
        },
      ],
      prev: notAlerting,
      now: NOW,
      tuning: gate,
    });
    expect(d.kind).toBe("notify");
    if (d.kind === "notify") expect(d.transition).toBe("entered");
  });

  it("out_of_credits does NOT corroborate exhaustion when the snapshot is past the staleness ceiling (probe-blind)", () => {
    // NEW CONTRACT (fix/out-of-credits-serve-block): out_of_credits is
    // informational, NOT exhaustion in its own right at any util. A stale
    // snapshot with only out_of_credits provides no live corroboration →
    // probe-blind → skip (no false fleet alert). Contrast with the test above:
    // a FRESH probe with out_of_credits still notifies via freshness, not the
    // credits flag.
    const d = evaluateFleetAllExhausted({
      accounts: [
        {
          label: "a",
          exhausted: true,
          last_quota: { capturedAt: NOW - STALE - 1, overageDisabledReason: "out_of_credits" },
        },
      ],
      prev: notAlerting,
      now: NOW,
      tuning: gate,
    });
    expect(d.kind).toBe("skip");
    if (d.kind === "skip") expect(d.reason).toBe("probe-blind");
  });

  it("skips (still) when all exhausted and already alerting — no re-spam", () => {
    const d = evaluateFleetAllExhausted({
      accounts: [{ label: "a", exhausted: true }, { label: "b", exhausted: true }],
      prev: alerting,
      now: 2_000,
      tuning: gate,
    });
    expect(d.kind).toBe("skip");
  });

  it("notifies (recovered) when one account frees after we were alerting — UNGUARDED by probe-blind", () => {
    // Recovery must fire even when freshness data is absent, so a legitimately
    // fired alert is never stranded (#2478 scope: gate only the `entered` edge).
    const d = evaluateFleetAllExhausted({
      accounts: [{ label: "a", exhausted: false }, { label: "b", exhausted: true }],
      prev: alerting,
      now: 3_000,
      tuning: gate,
    });
    expect(d.kind).toBe("notify");
    if (d.kind === "notify") {
      expect(d.transition).toBe("recovered");
      expect(d.newState.lastNotifiedHealth).toBe("healthy");
      expect(d.message).toContain("Fleet recovered");
      expect(d.message).toContain("a"); // names the healthy account
    }
  });

  it("entered then recovered: a legit fire (fresh probes) is followed by a working recovery edge", () => {
    const entered = evaluateFleetAllExhausted({
      accounts: [
        { label: "a", exhausted: true, last_quota: freshProbe() },
        { label: "b", exhausted: true, last_quota: freshProbe() },
      ],
      prev: notAlerting,
      now: NOW,
      tuning: gate,
    });
    expect(entered.kind).toBe("notify");
    if (entered.kind !== "notify") return;
    expect(entered.transition).toBe("entered");
    // Feed the persisted state forward; one account frees.
    const recovered = evaluateFleetAllExhausted({
      accounts: [
        { label: "a", exhausted: false, last_quota: freshProbe() },
        { label: "b", exhausted: true, last_quota: freshProbe() },
      ],
      prev: entered.newState,
      now: NOW + 60_000,
      tuning: gate,
    });
    expect(recovered.kind).toBe("notify");
    if (recovered.kind === "notify") expect(recovered.transition).toBe("recovered");
  });

  it("skips (not-all) when some account is healthy and we weren't alerting", () => {
    const d = evaluateFleetAllExhausted({
      accounts: [{ label: "a", exhausted: false }, { label: "b", exhausted: true }],
      prev: notAlerting,
      now: 4_000,
      tuning: gate,
    });
    expect(d.kind).toBe("skip");
  });

  it("never alerts on an empty fleet", () => {
    expect(
      evaluateFleetAllExhausted({ accounts: [], prev: notAlerting, now: 1, tuning: gate }).kind,
    ).toBe("skip");
  });

  it("with the gate disabled (maxStaleMs 0) the legacy bare-mark behaviour is preserved", () => {
    // Kill-switch parity: tuning omitted / 0 → fire on bare marks (pre-#2478).
    const d = evaluateFleetAllExhausted({
      accounts: [{ label: "a", exhausted: true }],
      prev: notAlerting,
      now: 1_000,
    });
    expect(d.kind).toBe("notify");
    if (d.kind === "notify") expect(d.message).toContain("Reset time unknown");
  });
});

// ── hardening: tuning resolver + claim keys (2026-06-09 incident) ───────────

import {
  resolveQuotaWatchTuning,
  buildQuotaClaimKey,
  DEFAULT_QUOTA_WATCH_MAX_STALE_MS,
  DEFAULT_QUOTA_WATCH_LATE_RECOVERY_MS,
  QUOTA_WATCH_CLAIM_WINDOW_MS,
  type QuotaWatchDecision,
} from "../quota-watch.js";

describe("resolveQuotaWatchTuning", () => {
  it("defaults: stale gate 60min, late-recovery 6h, dedup on, probe-fail send off", () => {
    const t = resolveQuotaWatchTuning({});
    expect(t.maxStaleMs).toBe(DEFAULT_QUOTA_WATCH_MAX_STALE_MS);
    expect(t.lateRecoveryMs).toBe(DEFAULT_QUOTA_WATCH_LATE_RECOVERY_MS);
    expect(t.fleetDedup).toBe(true);
    expect(t.sendOnProbeFail).toBe(false);
  });

  it("each knob is individually kill-switchable", () => {
    const t = resolveQuotaWatchTuning({
      SWITCHROOM_QUOTA_WATCH_MAX_STALE_MS: "0",
      SWITCHROOM_QUOTA_WATCH_LATE_RECOVERY_MS: "0",
      SWITCHROOM_QUOTA_WATCH_FLEET_DEDUP: "0",
      SWITCHROOM_QUOTA_WATCH_SEND_ON_PROBE_FAIL: "1",
    });
    expect(t.maxStaleMs).toBe(0);
    expect(t.lateRecoveryMs).toBe(0);
    expect(t.fleetDedup).toBe(false);
    expect(t.sendOnProbeFail).toBe(true);
  });

  it("garbage numeric values fall back to defaults", () => {
    const t = resolveQuotaWatchTuning({
      SWITCHROOM_QUOTA_WATCH_MAX_STALE_MS: "banana",
      SWITCHROOM_QUOTA_WATCH_LATE_RECOVERY_MS: "-5",
    });
    expect(t.maxStaleMs).toBe(DEFAULT_QUOTA_WATCH_MAX_STALE_MS);
    expect(t.lateRecoveryMs).toBe(DEFAULT_QUOTA_WATCH_LATE_RECOVERY_MS);
  });

  it("claim window exceeds one poll cycle (15 min) so all agents' observations of one edge dedup", () => {
    expect(QUOTA_WATCH_CLAIM_WINDOW_MS).toBeGreaterThan(15 * 60_000);
  });
});

describe("buildQuotaClaimKey", () => {
  it("is namespaced and distinct per account, transition, and chat", () => {
    const k1 = buildQuotaClaimKey("a@x.com", "entered-throttling", 111);
    const k2 = buildQuotaClaimKey("a@x.com", "entered-throttling", 222);
    const k3 = buildQuotaClaimKey("a@x.com", "recovered-to-healthy", 111);
    const k4 = buildQuotaClaimKey("b@x.com", "entered-throttling", 111);
    expect(new Set([k1, k2, k3, k4]).size).toBe(4);
    expect(k1).toBe("quota-watch:a@x.com:entered-throttling:111");
  });
});

// ── hardening: staleness gate ────────────────────────────────────────────────

const TUNING = {
  maxStaleMs: DEFAULT_QUOTA_WATCH_MAX_STALE_MS,
  lateRecoveryMs: DEFAULT_QUOTA_WATCH_LATE_RECOVERY_MS,
};

describe("evaluateQuotaWatchAccount — staleness gate", () => {
  it("a cached snapshot past maxStaleMs carries no opinion (skip, even on a real edge)", () => {
    const staleHealthy: AccountSnapshot = {
      ...HEALTHY_SNAP,
      capturedAtMs: NOW - DEFAULT_QUOTA_WATCH_MAX_STALE_MS - 1,
    };
    const d = evaluateQuotaWatchAccount({
      agentName: "test", snap: staleHealthy, prev: PREV_WAS_THROTTLING, now: NOW, tuning: TUNING,
    });
    expect(d.kind).toBe("skip");
    expect((d as { reason: string }).reason).toBe("stale-snapshot");
  });

  it("a cached snapshot inside the shelf life classifies normally", () => {
    const freshEnough: AccountSnapshot = {
      ...THROTTLING_5H,
      capturedAtMs: NOW - 5 * 60_000,
    };
    const d = evaluateQuotaWatchAccount({
      agentName: "test", snap: freshEnough, prev: PREV_WAS_HEALTHY, now: NOW, tuning: TUNING,
    });
    expect(d.kind).toBe("notify");
  });

  it("live-probe snapshots (no capturedAtMs) are never stale-gated", () => {
    const d = evaluateQuotaWatchAccount({
      agentName: "test", snap: THROTTLING_5H, prev: PREV_WAS_HEALTHY, now: NOW, tuning: TUNING,
    });
    expect(d.kind).toBe("notify");
  });

  it("maxStaleMs=0 disables the gate (legacy behaviour)", () => {
    const ancient: AccountSnapshot = { ...THROTTLING_5H, capturedAtMs: NOW - 86_400_000 };
    const d = evaluateQuotaWatchAccount({
      agentName: "test", snap: ancient, prev: PREV_WAS_HEALTHY, now: NOW,
      tuning: { maxStaleMs: 0, lateRecoveryMs: 0 },
    });
    expect(d.kind).toBe("notify");
  });
});

// ── hardening: boot-tick + late-recovery reconciliation ─────────────────────

describe("evaluateQuotaWatchAccount — recovery reconciliation", () => {
  it("recovery on a boot tick reconciles silently (the fleet-bounce flood case)", () => {
    const d = evaluateQuotaWatchAccount({
      agentName: "test", snap: HEALTHY_SNAP, prev: PREV_WAS_THROTTLING, now: NOW,
      bootTick: true, tuning: TUNING,
    });
    expect(d.kind).toBe("reconcile");
    const r = d as Extract<QuotaWatchDecision, { kind: "reconcile" }>;
    expect(r.reason).toBe("boot-tick-recovery");
    expect(r.transition).toBe("recovered-to-healthy");
    // The latch must clear so the edge never re-fires.
    expect(r.newAccountState.lastNotifiedHealth).toBe("healthy");
  });

  it("recovery whose 🟡 warning is older than lateRecoveryMs reconciles silently", () => {
    const prev = {
      lastNotifiedHealth: "throttling" as const,
      lastNotifiedAt: NOW - DEFAULT_QUOTA_WATCH_LATE_RECOVERY_MS - 1,
    };
    const d = evaluateQuotaWatchAccount({
      agentName: "test", snap: HEALTHY_SNAP, prev, now: NOW, tuning: TUNING,
    });
    expect(d.kind).toBe("reconcile");
    expect((d as Extract<QuotaWatchDecision, { kind: "reconcile" }>).reason).toBe("late-recovery");
  });

  it("a prompt recovery on a normal tick still notifies", () => {
    const prev = { lastNotifiedHealth: "throttling" as const, lastNotifiedAt: NOW - 30 * 60_000 };
    const d = evaluateQuotaWatchAccount({
      agentName: "test", snap: HEALTHY_SNAP, prev, now: NOW, tuning: TUNING,
    });
    expect(d.kind).toBe("notify");
    expect((d as Extract<QuotaWatchDecision, { kind: "notify" }>).transition).toBe("recovered-to-healthy");
  });

  it("a 🟡 warning still notifies on a boot tick (warnings are level-state news)", () => {
    const d = evaluateQuotaWatchAccount({
      agentName: "test", snap: THROTTLING_5H, prev: PREV_WAS_HEALTHY, now: NOW,
      bootTick: true, tuning: TUNING,
    });
    expect(d.kind).toBe("notify");
    expect((d as Extract<QuotaWatchDecision, { kind: "notify" }>).transition).toBe("entered-throttling");
  });

  it("lateRecoveryMs=0 disables reconciliation (legacy always-send)", () => {
    const prev = { lastNotifiedHealth: "throttling" as const, lastNotifiedAt: NOW - 86_400_000 };
    const d = evaluateQuotaWatchAccount({
      agentName: "test", snap: HEALTHY_SNAP, prev, now: NOW,
      tuning: { maxStaleMs: 0, lateRecoveryMs: 0 },
    });
    expect(d.kind).toBe("notify");
  });

  it("omitting bootTick/tuning entirely preserves the pre-hardening table", () => {
    const prev = { lastNotifiedHealth: "throttling" as const, lastNotifiedAt: NOW - 86_400_000 };
    const d = evaluateQuotaWatchAccount({
      agentName: "test", snap: HEALTHY_SNAP, prev, now: NOW,
    });
    expect(d.kind).toBe("notify");
  });
});

// ── total enumeration: every (state × input) cell of the decision FSM ────────
//
// Operator standard (feedback_prove_finite_fsm_not_sample): the decision
// function is a finite table — prove it by enumerating EVERY cell, not by
// sampling. Dimensions:
//   prevHealth      ∈ {null, healthy, throttling}
//   currentHealth   ∈ {healthy, throttling, blocked, unknown}
//   staleness       ∈ {live (no capturedAtMs), fresh-cache, stale-cache}
//   bootTick        ∈ {false, true}
//   warningAge      ∈ {recent (< lateRecoveryMs), late (> lateRecoveryMs)}
// = 3 × 4 × 3 × 2 × 2 = 144 cells. The expected kind for every cell is
// computed from the documented table independently and asserted.

describe("evaluateQuotaWatchAccount — total enumeration (144 cells)", () => {
  const PREVS = [null, "healthy", "throttling"] as const;
  const CURRENTS = ["healthy", "throttling", "blocked", "unknown"] as const;
  const STALENESS = ["live", "fresh-cache", "stale-cache"] as const;
  const BOOLS = [false, true] as const;
  const AGES = ["recent", "late"] as const;

  const SNAPS: Record<(typeof CURRENTS)[number], QuotaUtilization | null> = {
    healthy: makeQuota(30, 40),
    throttling: makeQuota(85, 40),
    blocked: makeQuota(99.9, 99.9),
    unknown: null,
  };

  it("every cell matches the documented table", () => {
    let cells = 0;
    for (const prevHealth of PREVS) {
      for (const currentHealth of CURRENTS) {
        for (const staleness of STALENESS) {
          for (const bootTick of BOOLS) {
            for (const age of AGES) {
              cells++;
              const lastNotifiedAt =
                prevHealth === null
                  ? 0
                  : age === "late"
                    ? NOW - DEFAULT_QUOTA_WATCH_LATE_RECOVERY_MS - 1
                    : NOW - 30 * 60_000;
              const prev = { lastNotifiedHealth: prevHealth, lastNotifiedAt };
              const snap: AccountSnapshot = {
                label: "enum@example.com",
                isActive: false,
                quota: SNAPS[currentHealth],
                capturedAtMs:
                  staleness === "live"
                    ? undefined
                    : staleness === "fresh-cache"
                      ? NOW - 60_000
                      : NOW - DEFAULT_QUOTA_WATCH_MAX_STALE_MS - 1,
              };
              const d = evaluateQuotaWatchAccount({
                agentName: "enum", snap, prev, now: NOW, bootTick, tuning: TUNING,
              });

              // Independent expectation, straight from the documented table.
              let expected: "notify" | "reconcile" | "skip";
              const effPrev = prevHealth ?? "healthy";
              if (staleness === "stale-cache") {
                expected = "skip"; // gate fires before everything else
              } else if (currentHealth === "blocked" || currentHealth === "unknown") {
                expected = "skip"; // credits-watch domain / no data
              } else if (currentHealth === effPrev) {
                expected = "skip"; // steady-state
              } else if (currentHealth === "throttling") {
                expected = "notify"; // warnings always notify
              } else {
                // recovery: throttling → healthy
                expected = bootTick || age === "late" ? "reconcile" : "notify";
              }

              expect(
                d.kind,
                `cell prev=${prevHealth} cur=${currentHealth} stale=${staleness} boot=${bootTick} age=${age}`,
              ).toBe(expected);

              // Terminal-state invariant: any notify/reconcile lands the
              // latch on currentHealth, so re-running the SAME cell with the
              // updated state is always a skip (the FSM cannot loop).
              if (d.kind === "notify" || d.kind === "reconcile") {
                const again = evaluateQuotaWatchAccount({
                  agentName: "enum", snap, prev: d.newAccountState, now: NOW, bootTick, tuning: TUNING,
                });
                expect(again.kind, `re-run of cell prev=${prevHealth} cur=${currentHealth}`).toBe("skip");
              }
            }
          }
        }
      }
    }
    expect(cells).toBe(144);
  });
});
