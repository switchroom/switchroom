import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appliesToday,
  canAutoApply,
  recordAutoApply,
} from "../src/self-improve/rate-limit.js";

let stateDir: string;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "self-improve-rl-"));
});
afterEach(() => {
  if (stateDir && existsSync(stateDir)) rmSync(stateDir, { recursive: true, force: true });
});

const DAY1 = Date.parse("2026-06-20T09:00:00Z");
const DAY1_LATER = Date.parse("2026-06-20T23:00:00Z");
const DAY2 = Date.parse("2026-06-21T01:00:00Z");

describe("T1 auto-apply rate limit (<=3/day)", () => {
  it("starts at zero and allows applying", () => {
    expect(appliesToday(stateDir, () => DAY1)).toBe(0);
    expect(canAutoApply(stateDir, () => DAY1, 3)).toBe(true);
  });

  it("counts applies within the same UTC day and blocks at the cap", () => {
    recordAutoApply(stateDir, () => DAY1);
    recordAutoApply(stateDir, () => DAY1);
    recordAutoApply(stateDir, () => DAY1_LATER);
    expect(appliesToday(stateDir, () => DAY1)).toBe(3);
    expect(canAutoApply(stateDir, () => DAY1, 3)).toBe(false);
  });

  it("resets across a UTC day boundary", () => {
    recordAutoApply(stateDir, () => DAY1);
    recordAutoApply(stateDir, () => DAY1);
    recordAutoApply(stateDir, () => DAY1);
    expect(canAutoApply(stateDir, () => DAY1, 3)).toBe(false);
    // Next day: budget restored.
    expect(appliesToday(stateDir, () => DAY2)).toBe(0);
    expect(canAutoApply(stateDir, () => DAY2, 3)).toBe(true);
  });
});
