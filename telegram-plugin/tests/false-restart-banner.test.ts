import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  shouldFallBackToLegacy,
  writePidFile,
  readPidFile,
  clearPidFile,
  isPidAlive,
} from "../gateway/pid-file";
import {
  shouldFireRestartBanner,
  writeSessionMarker,
  readSessionMarker,
  clearSessionMarker,
  type SessionMarker,
} from "../gateway/session-marker";

/**
 * Regression guard for the false-restart banner storm observed on
 * 2026-04-22.
 *
 * Symptom: users received "⚡ Recovered from unexpected restart.
 * (down ~Ns)" banners in Telegram while the gateway PID was constant
 * for 9+ hours and systemd recorded zero lifecycle events.
 *
 * Root causes (two, merged into one banner-storm):
 *   1. server.ts dual-mode probe fell back to legacy monolith on a
 *      transient socket miss even when the gateway process was alive,
 *      spawning a second grammY poller that 409'd against the
 *      gateway's own.
 *   2. The "recovered from unexpected restart" banner fired on every
 *      grammY poll-restart (triggered by the 409s), not on actual
 *      process restart.
 *
 * Fix, Part 1: legacy fallback checks the gateway PID file first and
 * retries the socket with backoff if the PID is alive. Only falls back
 * when the PID file is absent or the recorded PID is dead.
 *
 * Fix, Part 2: banner compares current (pid, startedAtMs) to a stored
 * session marker and stays silent when they match — this means we are
 * the same process as last time the banner logic looked.
 */

describe("shouldFallBackToLegacy (Part 1 decision)", () => {
  it("stays on bridge when socket is reachable", () => {
    expect(
      shouldFallBackToLegacy({
        socketReachable: true,
        pidFileExists: false,
        pidAlive: false,
      }),
    ).toBe(false);
  });

  it("stays on bridge when socket misses but PID file says gateway is alive", () => {
    // This is the 2026-04-22 incident — a transient socket miss on a
    // live gateway. The fix is: do NOT fall back, retry the socket.
    expect(
      shouldFallBackToLegacy({
        socketReachable: false,
        pidFileExists: true,
        pidAlive: true,
      }),
    ).toBe(false);
  });

  it("falls back when no PID file exists (true clean absence)", () => {
    expect(
      shouldFallBackToLegacy({
        socketReachable: false,
        pidFileExists: false,
        pidAlive: false,
      }),
    ).toBe(true);
  });

  it("falls back when PID file points at a dead process", () => {
    expect(
      shouldFallBackToLegacy({
        socketReachable: false,
        pidFileExists: true,
        pidAlive: false,
      }),
    ).toBe(true);
  });
});

describe("pid-file round-trip", () => {
  it("writes and reads a record atomically", () => {
    const dir = mkdtempSync(join(tmpdir(), "pidfile-"));
    const path = join(dir, "gateway.pid.json");
    writePidFile(path, { pid: 12345, startedAtMs: 1_700_000_000_000 });
    const got = readPidFile(path);
    expect(got).toEqual({ pid: 12345, startedAtMs: 1_700_000_000_000 });
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null for missing file", () => {
    const dir2 = mkdtempSync(join(tmpdir(), "pidfile-"));
    const missing = join(dir2, "missing.json");
    expect(readPidFile(missing)).toBeNull();
    rmSync(dir2, { recursive: true, force: true });
  });

  it("returns null for malformed file", () => {
    const dir2 = mkdtempSync(join(tmpdir(), "pidfile-"));
    const p = join(dir2, "bad.json");
    writePidFile(p, { pid: 1, startedAtMs: 1 });
    writeFileSync(p, "{not valid json", "utf-8");
    expect(readPidFile(p)).toBeNull();
    rmSync(dir2, { recursive: true, force: true });
  });

  it("returns null when fields are wrong type", () => {
    const dir2 = mkdtempSync(join(tmpdir(), "pidfile-"));
    const p = join(dir2, "wrong.json");
    writeFileSync(p, JSON.stringify({ pid: "not a number", startedAtMs: 1 }));
    expect(readPidFile(p)).toBeNull();
    rmSync(dir2, { recursive: true, force: true });
  });

  it("clearPidFile removes the file and tolerates missing file", () => {
    const dir2 = mkdtempSync(join(tmpdir(), "pidfile-"));
    const p = join(dir2, "gw.pid.json");
    writePidFile(p, { pid: 99, startedAtMs: 1 });
    expect(existsSync(p)).toBe(true);
    clearPidFile(p);
    expect(existsSync(p)).toBe(false);
    // second call must not throw
    clearPidFile(p);
    rmSync(dir2, { recursive: true, force: true });
  });
});

describe("isPidAlive", () => {
  it("returns true for the current process", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it("returns false for PID 0 and negative PIDs", () => {
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
  });

  it("returns false for ESRCH (process gone)", () => {
    const gone = (_pid: number, _sig: number) => {
      const err = new Error("no such process") as NodeJS.ErrnoException;
      err.code = "ESRCH";
      throw err;
    };
    expect(isPidAlive(999999, gone)).toBe(false);
  });

  it("returns true for EPERM (owned by another user, still alive)", () => {
    const eperm = (_pid: number, _sig: number) => {
      const err = new Error("permission denied") as NodeJS.ErrnoException;
      err.code = "EPERM";
      throw err;
    };
    expect(isPidAlive(1, eperm)).toBe(true);
  });
});

describe("shouldFireRestartBanner (Part 2 decision)", () => {
  const current: SessionMarker = { pid: 2021166, startedAtMs: 1_700_000_000_000 };

  it("fires when no marker exists (first boot)", () => {
    expect(shouldFireRestartBanner({ stored: null, current })).toBe(true);
  });

  it("fires when stored PID differs from current (real restart)", () => {
    expect(
      shouldFireRestartBanner({
        stored: { pid: 1234567, startedAtMs: 1_700_000_000_000 },
        current,
      }),
    ).toBe(true);
  });

  it("fires when stored startedAt differs (same PID miraculously reused)", () => {
    expect(
      shouldFireRestartBanner({
        stored: { pid: 2021166, startedAtMs: 1_600_000_000_000 },
        current,
      }),
    ).toBe(true);
  });

  it("suppresses when stored matches current exactly (poll-restart within one lifetime)", () => {
    // This is the 2026-04-22 incident: grammY poll-restart fired a
    // banner even though the process didn't restart.
    expect(
      shouldFireRestartBanner({
        stored: { pid: 2021166, startedAtMs: 1_700_000_000_000 },
        current,
      }),
    ).toBe(false);
  });
});

describe("session-marker round-trip", () => {
  it("writes, reads, clears", () => {
    const dir = mkdtempSync(join(tmpdir(), "sessmarker-"));
    const p = join(dir, "gateway-session.json");
    expect(readSessionMarker(p)).toBeNull();
    writeSessionMarker(p, { pid: 555, startedAtMs: 42 });
    expect(readSessionMarker(p)).toEqual({ pid: 555, startedAtMs: 42 });
    clearSessionMarker(p);
    expect(existsSync(p)).toBe(false);
    // idempotent clear
    clearSessionMarker(p);
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null for malformed marker", () => {
    const dir = mkdtempSync(join(tmpdir(), "sessmarker-"));
    const p = join(dir, "bad.json");
    writeFileSync(p, "not json");
    expect(readSessionMarker(p)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * Source-level guards: make sure the fix is actually wired in at the
 * two call sites. Refactor catches.
 */
describe("source-level wiring", () => {
  it("gateway.ts writes a PID file and session marker on startup", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(
      new URL("../gateway/gateway.ts", import.meta.url),
      "utf8",
    );
    expect(src).toContain("writePidFile");
    expect(src).toContain("writeSessionMarker");
    expect(src).toContain("shouldFireRestartBanner");
  });

  it("server.ts dual-mode probe consults the PID file before falling back", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(
      new URL("../server.ts", import.meta.url),
      "utf8",
    );
    expect(src).toContain("shouldFallBackToLegacy");
    expect(src).toContain("readPidFile");
    expect(src).toContain("isPidAlive");
  });
});
