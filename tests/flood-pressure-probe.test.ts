// Unit tests for the wedge-watchdog's read-only flood-pressure probe.
//
// Hermetic by construction: every case points `stateDir` at a fresh tmpdir, so
// the probe never reads a live agent's `~/.switchroom/agents/<name>/telegram/`.
// The fixtures are the REAL bytes from the clerk incident (2026-07-28) that
// motivated the fix.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readFloodPressure,
  FLOOD_PRESSURE_GRACE_MS,
} from "../src/agents/flood-pressure-probe.js";

// Verbatim from ~/.switchroom/agents/clerk/telegram/ on 2026-07-28.
const CLERK_WINDOWS = [
  {
    scopeKey: "chat:12345",
    untilTs: 1785197287509,
    retryAfterSrc: "429",
    observedAt: 1785197284509,
  },
];
const CLERK_LEDGER = [
  { firstTs: 1785196413517, lastTs: 1785196413517, peakRetryAfterSec: 3, untilTs: 1785196416517, count: 1 },
  { firstTs: 1785197264885, lastTs: 1785197284509, peakRetryAfterSec: 3, untilTs: 1785197287509, count: 3 },
];
/** Epoch ms the clerk `chat:12345` window expired. */
const WINDOW_CLOSE = 1785197287509;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "flood-pressure-probe-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeWindows(v: unknown) {
  writeFileSync(join(dir, "flood-windows.json"), JSON.stringify(v));
}
function writeLedger(v: unknown) {
  writeFileSync(join(dir, "429-ledger.json"), JSON.stringify(v));
}

describe("readFloodPressure", () => {
  it("reports no pressure when neither artefact exists", () => {
    expect(readFloodPressure(WINDOW_CLOSE, { stateDir: dir }).active).toBe(false);
  });

  it("reports pressure from an OPEN scoped window", () => {
    writeWindows(CLERK_WINDOWS);
    const p = readFloodPressure(WINDOW_CLOSE - 1_000, { stateDir: dir });
    expect(p.active).toBe(true);
    expect(p.reason).toContain("chat:12345");
  });

  it("still reports pressure just AFTER the window closes (within the grace)", () => {
    // The load-bearing case. Each clerk window was only ~3s wide (retry_after
    // 3) while the edit-flood-fuse kept deferring the card for ~47s, so a 5s
    // poll cadence samples between windows and would otherwise see "all clear".
    writeWindows(CLERK_WINDOWS);
    expect(readFloodPressure(WINDOW_CLOSE + 30_000, { stateDir: dir }).active).toBe(true);
  });

  it("reports no pressure once the window is older than the grace", () => {
    writeWindows(CLERK_WINDOWS);
    expect(
      readFloodPressure(WINDOW_CLOSE + FLOOD_PRESSURE_GRACE_MS + 1_000, { stateDir: dir }).active,
    ).toBe(false);
  });

  it("reports pressure from a recent 429 EPISODE even with no window file", () => {
    writeLedger(CLERK_LEDGER);
    const p = readFloodPressure(WINDOW_CLOSE + 10_000, { stateDir: dir });
    expect(p.active).toBe(true);
    expect(p.reason).toContain("429 episode");
  });

  it("ignores a 429 episode older than the grace", () => {
    writeLedger(CLERK_LEDGER);
    expect(
      readFloodPressure(WINDOW_CLOSE + FLOOD_PRESSURE_GRACE_MS + 60_000, { stateDir: dir }).active,
    ).toBe(false);
  });

  it("ignores a msg-edit: window — it cannot delay a NEW card post", () => {
    writeWindows([
      { scopeKey: "msg-edit:123", untilTs: WINDOW_CLOSE, retryAfterSrc: "429", observedAt: 0 },
    ]);
    expect(readFloodPressure(WINDOW_CLOSE - 1_000, { stateDir: dir }).active).toBe(false);
  });

  it("counts a global window", () => {
    writeWindows([
      { scopeKey: "global", untilTs: WINDOW_CLOSE, retryAfterSrc: "429", observedAt: 0 },
    ]);
    expect(readFloodPressure(WINDOW_CLOSE - 1_000, { stateDir: dir }).active).toBe(true);
  });

  it("fails SAFE (pressure active) on a corrupt windows file", () => {
    writeFileSync(join(dir, "flood-windows.json"), "{not json");
    // Matches `readFloodWindows`'s deliberate fail-safe posture: if we cannot
    // tell whether a ban is open, we must not fire a permanent Esc-deny on the
    // assumption that it is not. Bounded by the caller's poll ceiling.
    expect(readFloodPressure(WINDOW_CLOSE, { stateDir: dir }).active).toBe(true);
  });

  it("reports no pressure on a corrupt LEDGER (the window file is the safety-critical one)", () => {
    writeFileSync(join(dir, "429-ledger.json"), "{not json");
    expect(readFloodPressure(WINDOW_CLOSE, { stateDir: dir }).active).toBe(false);
  });
});
