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

describe("evaluateCreditState — transition decisions", () => {
  const NOW = 1_780_000_000_000;
  const HEALTHY = emptyCreditState();
  const FATAL_OUT = { lastNotifiedReason: "out_of_credits", lastNotifiedAt: NOW - 1000 };

  it("entry: healthy → fatal triggers a notify", () => {
    const d = evaluateCreditState({
      agentName: "lawgpt",
      currentReason: "out_of_credits",
      prev: HEALTHY,
      now: NOW,
    });
    expect(d.kind).toBe("notify");
    if (d.kind !== "notify") return;
    expect(d.transition).toBe("entered");
    expect(d.message).toContain("out of pre-paid credits");
    expect(d.message).toContain("<b>lawgpt</b>");
    expect(d.newState.lastNotifiedReason).toBe("out_of_credits");
    expect(d.newState.lastNotifiedAt).toBe(NOW);
  });

  it("steady-state: fatal → same fatal reason skips", () => {
    const d = evaluateCreditState({
      agentName: "lawgpt",
      currentReason: "out_of_credits",
      prev: FATAL_OUT,
      now: NOW,
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
    });
    expect(d.kind).toBe("skip");
  });

  it("escapes HTML in the agent name (defensive)", () => {
    const d = evaluateCreditState({
      agentName: "<evil>",
      currentReason: "out_of_credits",
      prev: HEALTHY,
      now: NOW,
    });
    expect(d.kind).toBe("notify");
    if (d.kind !== "notify") return;
    expect(d.message).toContain("&lt;evil&gt;");
    expect(d.message).not.toContain("<evil>");
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
