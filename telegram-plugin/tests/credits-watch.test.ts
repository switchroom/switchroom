/**
 * Unit tests for the Claude-independent credit-exhaustion notify
 * helper (#348). Covers:
 *   - Pure decision logic across the transition table
 *   - State persistence round-trip
 *   - File-read robustness (missing / malformed / wrong-type field)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  readClaudeJsonOverage,
  evaluateCreditState,
  resolveCreditWatchFatalReasons,
  loadCreditState,
  saveCreditState,
  emptyCreditState,
} from "../credits-watch.js";

describe("readClaudeJsonOverage", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "credits-watch-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns null when .claude.json is missing", () => {
    expect(readClaudeJsonOverage(tmp)).toBeNull();
  });

  it("returns null when .claude.json is malformed", () => {
    writeFileSync(join(tmp, ".claude.json"), "{not valid json");
    expect(readClaudeJsonOverage(tmp)).toBeNull();
  });

  it("returns null when the field is absent", () => {
    writeFileSync(join(tmp, ".claude.json"), JSON.stringify({ unrelated: "x" }));
    expect(readClaudeJsonOverage(tmp)).toBeNull();
  });

  it("returns null when the field is null", () => {
    writeFileSync(
      join(tmp, ".claude.json"),
      JSON.stringify({ cachedExtraUsageDisabledReason: null }),
    );
    expect(readClaudeJsonOverage(tmp)).toBeNull();
  });

  it("returns null when the field is the wrong type", () => {
    writeFileSync(
      join(tmp, ".claude.json"),
      JSON.stringify({ cachedExtraUsageDisabledReason: 42 }),
    );
    expect(readClaudeJsonOverage(tmp)).toBeNull();
  });

  it("returns the string value when present", () => {
    writeFileSync(
      join(tmp, ".claude.json"),
      JSON.stringify({ cachedExtraUsageDisabledReason: "out_of_credits" }),
    );
    expect(readClaudeJsonOverage(tmp)).toBe("out_of_credits");
  });

  it("returns the value even when other unrelated keys exist", () => {
    writeFileSync(
      join(tmp, ".claude.json"),
      JSON.stringify({
        numStartups: 12,
        installMethod: "npm",
        cachedExtraUsageDisabledReason: "org_level_disabled",
        cachedGrowthBookFeatures: { x: 1 },
      }),
    );
    expect(readClaudeJsonOverage(tmp)).toBe("org_level_disabled");
  });
});

describe("evaluateCreditState — transition decisions (machinery, explicit fatal set)", () => {
  const NOW = 1_780_000_000_000;
  const HEALTHY = emptyCreditState();
  const FATAL_OUT = { lastNotifiedReason: "out_of_credits", lastNotifiedAt: NOW - 1000 };
  // The transition machinery is policy-agnostic — pass an explicit fatal set so
  // these tests pin entered/changed/exited behaviour independent of the (now
  // empty) subscription-only default.
  const FATAL = new Set(["out_of_credits", "org_level_disabled", "credits_exhausted", "extra_usage_disabled"]);

  it("entry: healthy → fatal triggers a notify", () => {
    const d = evaluateCreditState({
      agentName: "lawgpt",
      currentReason: "out_of_credits",
      prev: HEALTHY,
      now: NOW,
      fatalReasons: FATAL,
    });
    expect(d.kind).toBe("notify");
    if (d.kind !== "notify") return;
    expect(d.transition).toBe("entered");
    expect(d.message).toContain("out of pre-paid credits");
    expect(d.message).toContain("**lawgpt**");
    expect(d.newState.lastNotifiedReason).toBe("out_of_credits");
    expect(d.newState.lastNotifiedAt).toBe(NOW);
  });

  it("steady-state: fatal → same fatal reason skips", () => {
    const d = evaluateCreditState({
      agentName: "lawgpt",
      currentReason: "out_of_credits",
      prev: FATAL_OUT,
      now: NOW,
      fatalReasons: FATAL,
    });
    expect(d.kind).toBe("skip");
    if (d.kind !== "skip") return;
    expect(d.reason).toBe("already-notified-for-this-reason");
  });

  it("change: fatal X → fatal Y triggers a notify (different message)", () => {
    const d = evaluateCreditState({
      agentName: "lawgpt",
      currentReason: "org_level_disabled",
      prev: FATAL_OUT,
      now: NOW,
      fatalReasons: FATAL,
    });
    expect(d.kind).toBe("notify");
    if (d.kind !== "notify") return;
    expect(d.transition).toBe("changed");
    expect(d.message).toContain("org admin has disabled extra usage");
    expect(d.newState.lastNotifiedReason).toBe("org_level_disabled");
  });

  it("recovery: fatal → healthy triggers a notify (credits restored)", () => {
    const d = evaluateCreditState({
      agentName: "lawgpt",
      currentReason: null,
      prev: FATAL_OUT,
      now: NOW,
      fatalReasons: FATAL,
    });
    expect(d.kind).toBe("notify");
    if (d.kind !== "notify") return;
    expect(d.transition).toBe("exited");
    expect(d.message).toContain("credits restored");
    expect(d.newState.lastNotifiedReason).toBeNull();
  });

  it("non-fatal current state from healthy prev skips silently", () => {
    const d = evaluateCreditState({
      agentName: "lawgpt",
      currentReason: "some_unknown_transient_reason",
      prev: HEALTHY,
      now: NOW,
      fatalReasons: FATAL,
    });
    expect(d.kind).toBe("skip");
    if (d.kind !== "skip") return;
    expect(d.reason).toBe("no-fatal-state");
  });

  it("steady-state healthy skips silently", () => {
    const d = evaluateCreditState({
      agentName: "lawgpt",
      currentReason: null,
      prev: HEALTHY,
      now: NOW,
      fatalReasons: FATAL,
    });
    expect(d.kind).toBe("skip");
  });

  it("markdown-escapes emphasis specials in the agent name; < > stay literal (#2669)", () => {
    const d = evaluateCreditState({
      agentName: "ev_il",
      currentReason: "out_of_credits",
      prev: HEALTHY,
      now: NOW,
      fatalReasons: FATAL,
    });
    expect(d.kind).toBe("notify");
    if (d.kind !== "notify") return;
    // The underscore is escaped so it can't open an italic run inside **…**.
    expect(d.message).toContain("ev\\_il");
  });

  // Boundary-escaping after the #2695 escaper de-dup: the entry message escapes
  // BOTH the agent name and the raw reason via the consolidated `escapeMarkdown`
  // import. A metacharacter-laden value through each site proves the import swap
  // preserved escaping at this call-site.
  it("escapes metacharacters in both the agent name and the cached reason (#2695)", () => {
    const d = evaluateCreditState({
      agentName: "a_b*c",
      currentReason: "weird_reason*x",
      prev: HEALTHY,
      now: NOW,
      fatalReasons: new Set(["weird_reason*x"]),
    });
    expect(d.kind).toBe("notify");
    if (d.kind !== "notify") return;
    expect(d.message).toContain("a\\_b\\*c");
    expect(d.message).toContain("weird\\_reason\\*x");
  });
});

describe("evaluateCreditState — subscription-only default (the fix)", () => {
  const NOW = 1_780_000_000_000;
  const HEALTHY = emptyCreditState();

  // With the default (empty) fatal set, NONE of the extra-usage reasons alarm —
  // because for subscription-only switchroom, extra-usage-off is the expected
  // state and real exhaustion is handled by failover. This is the bug fix.
  for (const reason of ["out_of_credits", "extra_usage_disabled", "credits_exhausted", "org_level_disabled"]) {
    it(`default: '${reason}' does NOT alarm (no false 'out of credits' card)`, () => {
      const d = evaluateCreditState({
        agentName: "clerk",
        currentReason: reason,
        prev: HEALTHY,
        now: NOW,
        // fatalReasons omitted → DEFAULT_CREDIT_FATAL_REASONS (empty)
      });
      expect(d.kind).toBe("skip");
    });
  }

  it("opt-in via explicit set restores the alarm (operator on pay-as-you-go)", () => {
    const d = evaluateCreditState({
      agentName: "clerk",
      currentReason: "out_of_credits",
      prev: HEALTHY,
      now: NOW,
      fatalReasons: new Set(["out_of_credits"]),
    });
    expect(d.kind).toBe("notify");
  });
});

describe("resolveCreditWatchFatalReasons", () => {
  it("defaults to EMPTY (subscription-only)", () => {
    expect(resolveCreditWatchFatalReasons({}).size).toBe(0);
  });
  it("parses a comma-separated opt-in list", () => {
    const s = resolveCreditWatchFatalReasons({ SWITCHROOM_CREDITS_WATCH_FATAL_REASONS: "out_of_credits, org_level_disabled" });
    expect(s.has("out_of_credits")).toBe(true);
    expect(s.has("org_level_disabled")).toBe(true);
    expect(s.size).toBe(2);
  });
  it("'*' opts in all known reasons", () => {
    const s = resolveCreditWatchFatalReasons({ SWITCHROOM_CREDITS_WATCH_FATAL_REASONS: "*" });
    expect(s.has("out_of_credits")).toBe(true);
    expect(s.size).toBeGreaterThanOrEqual(4);
  });
  it("blank/whitespace → empty", () => {
    expect(resolveCreditWatchFatalReasons({ SWITCHROOM_CREDITS_WATCH_FATAL_REASONS: "  " }).size).toBe(0);
  });
});

describe("loadCreditState / saveCreditState — round-trip", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "credits-state-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns emptyCreditState when no file exists", () => {
    expect(loadCreditState(tmp)).toEqual(emptyCreditState());
  });

  it("round-trips a saved state", () => {
    const state = { lastNotifiedReason: "out_of_credits", lastNotifiedAt: 1_780_000_000_000 };
    saveCreditState(tmp, state);
    expect(loadCreditState(tmp)).toEqual(state);
  });

  it("falls back to empty on malformed JSON (not a hard fail)", () => {
    mkdirSync(tmp, { recursive: true });
    writeFileSync(join(tmp, "credits-watch.json"), "{broken");
    expect(loadCreditState(tmp)).toEqual(emptyCreditState());
  });

  it("falls back to empty on shape mismatch", () => {
    writeFileSync(
      join(tmp, "credits-watch.json"),
      JSON.stringify({ lastNotifiedReason: 42, lastNotifiedAt: "nope" }),
    );
    expect(loadCreditState(tmp)).toEqual(emptyCreditState());
  });

  it("creates the state dir on save (if it doesn't exist yet)", () => {
    const fresh = join(tmp, "fresh-subdir");
    saveCreditState(fresh, { lastNotifiedReason: null, lastNotifiedAt: 0 });
    expect(loadCreditState(fresh)).toEqual({ lastNotifiedReason: null, lastNotifiedAt: 0 });
  });
});
