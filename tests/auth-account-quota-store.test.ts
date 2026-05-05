/**
 * Tests for the per-account quota snapshot store (issue #708).
 *
 * Covers:
 *   - round-trip of `writeAccountQuota` → `readAccountQuota`
 *   - tolerant read when the file is missing or malformed
 *   - schema validation: unexpected types come back as null fields
 *   - the QuotaUtilization adapter shapes the right output
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

import {
  accountQuotaPath,
  readAccountQuota,
  snapshotFromQuotaUtilization,
  writeAccountQuota,
} from "../src/auth/account-quota-store.js";

let home: string;
const LABEL = "pixsoul@gmail.com";

beforeEach(() => {
  home = resolve(
    tmpdir(),
    `switchroom-acct-quota-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(home, { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("writeAccountQuota / readAccountQuota", () => {
  it("returns null when no snapshot exists yet", () => {
    expect(readAccountQuota(LABEL, home)).toBeNull();
  });

  it("round-trips a fresh snapshot", () => {
    const snap = {
      capturedAt: "2026-05-05T09:55Z",
      fiveHourPct: 10,
      sevenDayPct: 79,
      fiveHourResetAt: 1_777_677_708_000,
      sevenDayResetAt: 1_778_290_508_000,
    };
    writeAccountQuota(LABEL, snap, home);
    const round = readAccountQuota(LABEL, home);
    expect(round).toEqual(snap);
  });

  it("tolerates missing fields, returning nulls for absent numbers", () => {
    // Hand-write a partial file (mirrors a future-proofing scenario where
    // the schema gets new fields and we read an older snapshot).
    const dir = resolve(home, ".switchroom", "accounts", LABEL);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      resolve(dir, "quota.json"),
      JSON.stringify({ capturedAt: "2026-05-05T00:00Z" }),
    );
    const got = readAccountQuota(LABEL, home);
    expect(got).toEqual({
      capturedAt: "2026-05-05T00:00Z",
      fiveHourPct: null,
      sevenDayPct: null,
      fiveHourResetAt: null,
      sevenDayResetAt: null,
    });
  });

  it("returns null when JSON is malformed", () => {
    const dir = resolve(home, ".switchroom", "accounts", LABEL);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, "quota.json"), "{ not json");
    expect(readAccountQuota(LABEL, home)).toBeNull();
  });

  it("returns null when capturedAt is missing", () => {
    const dir = resolve(home, ".switchroom", "accounts", LABEL);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, "quota.json"), JSON.stringify({ fiveHourPct: 10 }));
    expect(readAccountQuota(LABEL, home)).toBeNull();
  });

  it("rejects unsafe labels at write time", () => {
    expect(() =>
      writeAccountQuota(
        "../escape",
        {
          capturedAt: "x",
          fiveHourPct: 0,
          sevenDayPct: 0,
          fiveHourResetAt: null,
          sevenDayResetAt: null,
        },
        home,
      ),
    ).toThrow();
  });
});

describe("snapshotFromQuotaUtilization", () => {
  it("captures the relevant fields and stamps capturedAt", () => {
    const fiveReset = new Date("2026-05-05T12:00:00Z");
    const sevenReset = new Date("2026-05-12T12:00:00Z");
    const now = new Date("2026-05-05T09:55:54.123Z");
    const snap = snapshotFromQuotaUtilization(
      {
        fiveHourUtilizationPct: 12.7,
        sevenDayUtilizationPct: 78.5,
        fiveHourResetAt: fiveReset,
        sevenDayResetAt: sevenReset,
      },
      now,
    );
    expect(snap).toEqual({
      capturedAt: "2026-05-05T09:55:54Z",
      fiveHourPct: 12.7,
      sevenDayPct: 78.5,
      fiveHourResetAt: fiveReset.getTime(),
      sevenDayResetAt: sevenReset.getTime(),
    });
  });

  it("emits null reset timestamps when the source dates are null", () => {
    const snap = snapshotFromQuotaUtilization({
      fiveHourUtilizationPct: 0,
      sevenDayUtilizationPct: 0,
      fiveHourResetAt: null,
      sevenDayResetAt: null,
    });
    expect(snap.fiveHourResetAt).toBeNull();
    expect(snap.sevenDayResetAt).toBeNull();
  });
});

describe("accountQuotaPath", () => {
  it("places the file under accounts/<label>/quota.json", () => {
    const path = accountQuotaPath(LABEL, home);
    expect(path).toBe(
      resolve(home, ".switchroom", "accounts", LABEL, "quota.json"),
    );
  });
});
