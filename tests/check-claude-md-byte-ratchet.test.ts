/**
 * Tests for the rendered-CLAUDE.md anti-inflation ratchet
 * (`scripts/check-claude-md-byte-ratchet.mjs`).
 *
 * Same shape as `tests/check-gateway-line-ratchet.test.ts`, which is the
 * precedent this ratchet follows. The guard's job: fail CI when the
 * always-loaded agent prompt grows past a checked-in BYTE ceiling, and force
 * that ceiling to ratchet DOWN as the prompt shrinks (a PR may lower it,
 * never raise it).
 *
 * We assert OUTCOMES of the pure decision across the band — each rule is
 * exercised with a case that would PASS if the rule were deleted — plus that
 * the checked-in ratchet file is well-formed at HEAD.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
// @ts-expect-error — plain .mjs guard, no types; importing the pure helpers.
import {
  evaluateRatchet,
  readRatchet,
  SLACK,
  RATCHET_PATH,
} from "../scripts/check-claude-md-byte-ratchet.mjs";

const REPO = resolve(import.meta.dirname, "..");

describe("CLAUDE.md byte ratchet — pure decision", () => {
  it("passes when the rendered size sits exactly on the ceiling", () => {
    const r = evaluateRatchet({ actual: 31000, ratchet: 31000 });
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("INFLATION: fails when the prompt grows past ceiling + slack", () => {
    const r = evaluateRatchet({ actual: 31000 + SLACK + 1, ratchet: 31000 });
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toContain("INFLATION");
  });

  it("INFLATION: tolerates growth strictly within the slack band", () => {
    const r = evaluateRatchet({ actual: 31000 + SLACK, ratchet: 31000 });
    expect(r.ok).toBe(true);
  });

  it("INFLATION message directs at cutting prompt, never at raising the ceiling", () => {
    // The whole point of the ratchet: the remedy must not be "edit the number".
    const r = evaluateRatchet({ actual: 99999, ratchet: 31000 });
    const msg = r.errors.join("\n");
    expect(msg).toContain("Raising the ceiling is NOT the remedy");
    expect(msg).toContain("loads on demand");
  });

  it("AUTO-TIGHTEN: fails when the prompt shrank well below the ceiling", () => {
    // A PR that removes 3KB must record the new ceiling in the same PR.
    const r = evaluateRatchet({ actual: 28000, ratchet: 31000 });
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toContain("STALE RATCHET");
  });

  it("AUTO-TIGHTEN: suggests a concrete lower value", () => {
    const r = evaluateRatchet({ actual: 28000, ratchet: 31000 });
    expect(r.errors.join("\n")).toContain(String(28000 + SLACK));
  });

  it("AUTO-TIGHTEN: is suppressed for secondary stacks via autoTighten:false", () => {
    // A small profile legitimately renders far under the worst-case ceiling.
    const r = evaluateRatchet({ actual: 20000, ratchet: 31000, autoTighten: false });
    expect(r.ok).toBe(true);
  });

  it("NEVER-RAISE: fails when the ratchet is higher than origin/main's", () => {
    const r = evaluateRatchet({ actual: 31500, ratchet: 31500, mainRatchet: 31000 });
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toContain("RATCHET RAISED");
  });

  it("NEVER-RAISE: allows LOWERING the ratchet", () => {
    const r = evaluateRatchet({ actual: 30000, ratchet: 30000, mainRatchet: 31000 });
    expect(r.ok).toBe(true);
  });

  it("NEVER-RAISE: skipped when origin/main is unreachable", () => {
    const r = evaluateRatchet({ actual: 31500, ratchet: 31500, mainRatchet: null });
    expect(r.ok).toBe(true);
  });

  it("rejects a malformed ratchet value instead of silently passing", () => {
    const r = evaluateRatchet({ actual: 31000, ratchet: NaN });
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toContain("not a positive integer");
  });
});

describe("CLAUDE.md byte ratchet — checked-in state", () => {
  it("the ratchet file holds a single positive integer", () => {
    const raw = readFileSync(resolve(REPO, RATCHET_PATH), "utf-8");
    expect(raw.trim()).toMatch(/^\d+$/);
    expect(readRatchet(REPO)).toBeGreaterThan(0);
  });

  it("the ratchet has not drifted upward past the old 40000 magic ceiling", () => {
    // Guards the direction of travel: this ratchet replaced a bare 40000
    // ceiling that had been raised repeatedly. It must never climb back.
    expect(readRatchet(REPO)).toBeLessThan(40000);
  });
});
