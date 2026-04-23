/**
 * Regression tests for the clean-shutdown marker that suppresses the
 * "⚡ Recovered from unexpected restart" banner on planned shutdowns.
 *
 * Background — 2026-04-23 UX gap:
 *   The boot path posts a recovery banner whenever it doesn't find a
 *   /restart user-marker. That assumption was fine for crashes but
 *   wrong for deliberate restarts (`systemctl --user restart …`,
 *   `switchroom agent restart`, Coolify redeploys, anything that sends
 *   SIGTERM cleanly). PR #52's drain coordinator made these planned
 *   shutdowns common enough that every redeploy looked unexpected.
 *
 * Fix: SIGTERM/SIGINT writes a separate sentinel file BEFORE draining;
 * boot reads it and suppresses the banner if fresh.
 *
 * These tests pin the contract:
 *   - read/write/clear roundtrip works
 *   - malformed JSON returns null instead of crashing boot
 *   - the boot decision (shouldSuppressRecoveryBanner) is correct for
 *     present-fresh / present-stale / absent / clock-skewed inputs
 *
 * Integration with the gateway boot path is structurally tested via
 * the same pattern as gateway-startup-mutex.test.ts: extract the pure
 * helper, unit-test it, trust the wiring via live verification.
 *
 * Run with:
 *   bun test telegram-plugin/tests/gateway-clean-shutdown-marker.test.ts
 */
import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  writeCleanShutdownMarker,
  readCleanShutdownMarker,
  clearCleanShutdownMarker,
  shouldSuppressRecoveryBanner,
  resolveShutdownMarker,
  DEFAULT_MAX_AGE_MS,
  EXTERNAL_RESTART_FALLBACK_REASON,
  REASON_PRESERVE_MAX_AGE_MS,
  type CleanShutdownMarker,
} from "../gateway/clean-shutdown-marker.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpMarkerPath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "gw-clean-shutdown-test-"));
  return { dir, path: join(dir, "clean-shutdown.json") };
}

const cleanups: string[] = [];
function track(dir: string): void { cleanups.push(dir); }

afterEach(() => {
  while (cleanups.length > 0) {
    const dir = cleanups.pop();
    if (dir) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
});

// ---------------------------------------------------------------------------
// File I/O round-trip
// ---------------------------------------------------------------------------

describe("clean-shutdown-marker file I/O", () => {
  it("writes a marker with ts + signal that read returns verbatim", () => {
    const { dir, path } = tmpMarkerPath();
    track(dir);

    const marker: CleanShutdownMarker = { ts: 1_700_000_000_000, signal: "SIGTERM" };
    writeCleanShutdownMarker(path, marker);

    expect(existsSync(path)).toBe(true);
    const got = readCleanShutdownMarker(path);
    expect(got).not.toBeNull();
    expect(got?.ts).toBe(marker.ts);
    expect(got?.signal).toBe("SIGTERM");
    // Default schema: no reason field.
    expect(got?.reason).toBeUndefined();
  });

  it("preserves the optional reason field", () => {
    const { dir, path } = tmpMarkerPath();
    track(dir);

    writeCleanShutdownMarker(path, { ts: Date.now(), signal: "SIGINT", reason: "deploy" });
    const got = readCleanShutdownMarker(path);
    expect(got?.reason).toBe("deploy");
  });

  it("clearCleanShutdownMarker deletes the file", () => {
    const { dir, path } = tmpMarkerPath();
    track(dir);

    writeCleanShutdownMarker(path, { ts: Date.now(), signal: "SIGTERM" });
    expect(existsSync(path)).toBe(true);

    clearCleanShutdownMarker(path);
    expect(existsSync(path)).toBe(false);
  });

  it("clearCleanShutdownMarker is a no-op when the file is already absent", () => {
    const { dir, path } = tmpMarkerPath();
    track(dir);

    // File never existed.
    expect(existsSync(path)).toBe(false);
    expect(() => clearCleanShutdownMarker(path)).not.toThrow();
  });

  it("readCleanShutdownMarker returns null for a missing file (no crash)", () => {
    const { dir, path } = tmpMarkerPath();
    track(dir);

    expect(readCleanShutdownMarker(path)).toBeNull();
  });

  it("readCleanShutdownMarker returns null for malformed JSON (no crash on boot)", () => {
    const { dir, path } = tmpMarkerPath();
    track(dir);

    writeFileSync(path, "{ this is not json", "utf-8");
    expect(readCleanShutdownMarker(path)).toBeNull();
  });

  it("readCleanShutdownMarker returns null when ts is missing or non-numeric", () => {
    const { dir, path } = tmpMarkerPath();
    track(dir);

    writeFileSync(path, JSON.stringify({ signal: "SIGTERM" }), "utf-8");
    expect(readCleanShutdownMarker(path)).toBeNull();

    writeFileSync(path, JSON.stringify({ ts: "nope", signal: "SIGTERM" }), "utf-8");
    expect(readCleanShutdownMarker(path)).toBeNull();
  });

  it("readCleanShutdownMarker returns null when signal is missing or empty", () => {
    const { dir, path } = tmpMarkerPath();
    track(dir);

    writeFileSync(path, JSON.stringify({ ts: Date.now() }), "utf-8");
    expect(readCleanShutdownMarker(path)).toBeNull();

    writeFileSync(path, JSON.stringify({ ts: Date.now(), signal: "" }), "utf-8");
    expect(readCleanShutdownMarker(path)).toBeNull();
  });

  it("write is atomic: tmp file does not survive a successful write", () => {
    const { dir, path } = tmpMarkerPath();
    track(dir);

    writeCleanShutdownMarker(path, { ts: Date.now(), signal: "SIGTERM" });
    // After a successful write, only the final path should exist — no
    // straggling .tmp-*. (Glob-ish check via reading the dir.)
    const fs = require("node:fs") as typeof import("node:fs");
    const entries = fs.readdirSync(dir);
    const tmps = entries.filter((e) => e.includes(".tmp-"));
    expect(tmps.length).toBe(0);
    expect(entries).toContain("clean-shutdown.json");
  });
});

// ---------------------------------------------------------------------------
// Boot decision: shouldSuppressRecoveryBanner
// ---------------------------------------------------------------------------

describe("shouldSuppressRecoveryBanner", () => {
  it("returns false when no marker is present (true crash or first boot)", () => {
    expect(shouldSuppressRecoveryBanner(null, Date.now())).toBe(false);
  });

  it("returns true for a fresh marker (age < default 60s)", () => {
    const now = 1_700_000_000_000;
    const marker: CleanShutdownMarker = { ts: now - 5_000, signal: "SIGTERM" };
    expect(shouldSuppressRecoveryBanner(marker, now)).toBe(true);
  });

  it("returns true at the very edge of the window (age = 0)", () => {
    const now = 1_700_000_000_000;
    const marker: CleanShutdownMarker = { ts: now, signal: "SIGTERM" };
    expect(shouldSuppressRecoveryBanner(marker, now)).toBe(true);
  });

  it("returns false when marker age equals maxAgeMs (boundary)", () => {
    const now = 1_700_000_000_000;
    const marker: CleanShutdownMarker = { ts: now - DEFAULT_MAX_AGE_MS, signal: "SIGTERM" };
    expect(shouldSuppressRecoveryBanner(marker, now)).toBe(false);
  });

  it("returns false for a stale marker (age > default 60s)", () => {
    const now = 1_700_000_000_000;
    const marker: CleanShutdownMarker = { ts: now - 90_000, signal: "SIGTERM" };
    expect(shouldSuppressRecoveryBanner(marker, now)).toBe(false);
  });

  it("respects a custom maxAgeMs", () => {
    const now = 1_700_000_000_000;
    const marker: CleanShutdownMarker = { ts: now - 30_000, signal: "SIGTERM" };
    // Fresh under default (60s) but stale under a 10s window.
    expect(shouldSuppressRecoveryBanner(marker, now, 60_000)).toBe(true);
    expect(shouldSuppressRecoveryBanner(marker, now, 10_000)).toBe(false);
  });

  it("treats clock skew (negative age) as stale to avoid false suppression", () => {
    // If the marker says the future, something is wrong with one of the
    // clocks — don't suppress the banner. Operator probably wants to
    // know about it.
    const now = 1_700_000_000_000;
    const marker: CleanShutdownMarker = { ts: now + 60_000, signal: "SIGTERM" };
    expect(shouldSuppressRecoveryBanner(marker, now)).toBe(false);
  });

  it("works for both SIGTERM and SIGINT signals (signal value is opaque)", () => {
    const now = 1_700_000_000_000;
    expect(shouldSuppressRecoveryBanner({ ts: now, signal: "SIGTERM" }, now)).toBe(true);
    expect(shouldSuppressRecoveryBanner({ ts: now, signal: "SIGINT" }, now)).toBe(true);
    expect(shouldSuppressRecoveryBanner({ ts: now, signal: "SIGUSR1" }, now)).toBe(true);
  });
});

describe("resolveShutdownMarker (SIGTERM-handler sequencing)", () => {
  // These tests pin the fix for the 2026-04-24 bug where bare
  // `systemctl restart switchroom-<name>-gateway` produced a reasonless
  // marker AND the shutdown handler clobbered any reason stamped by a
  // preceding CLI/watchdog/user-slash initiator. The resolver preserves
  // fresh reasons and falls back to "systemctl: external restart" so
  // the next greeting card always has a non-empty Restarted row for
  // planned shutdowns.

  it("preserves a fresh prior reason (cooperative race with a CLI/user stamp)", () => {
    const now = 1_700_000_000_000;
    const prior: CleanShutdownMarker = {
      ts: now - 500, // 500ms old — CLI just stamped
      signal: "SIGTERM",
      reason: "cli: deploying abc1234",
    };
    const next = resolveShutdownMarker(prior, "SIGTERM", now);
    expect(next.reason).toBe("cli: deploying abc1234");
    expect(next.signal).toBe("SIGTERM");
    expect(next.ts).toBe(now);
  });

  it("preserves user-slash attribution when the gateway stamps before spawning the CLI", () => {
    // /restart, /reconcile, /new, /reset paths in gateway.ts call
    // stampUserRestartReason() which writes the marker, then spawn the
    // detached CLI which stamps its own. By the time SIGTERM arrives,
    // the most recent marker should already carry "user: /restart from
    // chat" (preserved by preserveExisting in writeRestartReasonMarker).
    // The SIGTERM handler must then preserve it a second time.
    const now = 1_700_000_000_000;
    const prior: CleanShutdownMarker = {
      ts: now - 2_000,
      signal: "SIGTERM",
      reason: "user: /restart from chat",
    };
    const next = resolveShutdownMarker(prior, "SIGTERM", now);
    expect(next.reason).toBe("user: /restart from chat");
  });

  it("falls back to 'systemctl: external restart' when no prior marker exists", () => {
    // Bare `systemctl restart switchroom-<name>-gateway` from an admin
    // terminal — no CLI, no watchdog, no slash command stamped anything.
    // Before this fix the marker was `{ts, signal}` with no reason and
    // the greeting silently omitted the Restarted row. This is the
    // 04:57 2026-04-24 bug Ken hit when applying an EnvironmentFile
    // change.
    const now = 1_700_000_000_000;
    const next = resolveShutdownMarker(null, "SIGTERM", now);
    expect(next.reason).toBe(EXTERNAL_RESTART_FALLBACK_REASON);
    expect(next.signal).toBe("SIGTERM");
    expect(next.ts).toBe(now);
  });

  it("falls back when a prior marker is missing its reason field", () => {
    // A reasonless prior marker means an earlier SIGTERM-only path
    // wrote it (pre-fix gateway) or an initiator stamped ts+signal
    // without a reason. Either way, we have no attribution to preserve
    // — use the fallback so the greeting is never silent.
    const now = 1_700_000_000_000;
    const prior: CleanShutdownMarker = { ts: now - 1_000, signal: "SIGTERM" };
    const next = resolveShutdownMarker(prior, "SIGTERM", now);
    expect(next.reason).toBe(EXTERNAL_RESTART_FALLBACK_REASON);
  });

  it("falls back when the prior reason is stale (>30s)", () => {
    // A stale prior reason almost certainly belongs to an earlier
    // shutdown cycle, not the current one. Using it would mis-attribute
    // today's restart to yesterday's initiator. The 30s window matches
    // writeRestartReasonMarker's preserveExisting guard in
    // src/agents/lifecycle.ts.
    const now = 1_700_000_000_000;
    const prior: CleanShutdownMarker = {
      ts: now - 60_000,
      signal: "SIGTERM",
      reason: "cli: deploying 0badc0de",
    };
    const next = resolveShutdownMarker(prior, "SIGTERM", now);
    expect(next.reason).toBe(EXTERNAL_RESTART_FALLBACK_REASON);
  });

  it("falls back when the prior reason is in the future (clock skew)", () => {
    // A negative age indicates clock skew; don't trust it.
    const now = 1_700_000_000_000;
    const prior: CleanShutdownMarker = {
      ts: now + 5_000,
      signal: "SIGTERM",
      reason: "cli: restart",
    };
    const next = resolveShutdownMarker(prior, "SIGTERM", now);
    expect(next.reason).toBe(EXTERNAL_RESTART_FALLBACK_REASON);
  });

  it("respects a custom maxPreserveAgeMs", () => {
    const now = 1_700_000_000_000;
    const prior: CleanShutdownMarker = {
      ts: now - 10_000,
      signal: "SIGTERM",
      reason: "watchdog: bridge disconnected for 145s",
    };
    // Fresh under the default 30s guard, stale under a 5s guard.
    expect(resolveShutdownMarker(prior, "SIGTERM", now).reason).toBe(
      "watchdog: bridge disconnected for 145s",
    );
    expect(resolveShutdownMarker(prior, "SIGTERM", now, 5_000).reason).toBe(
      EXTERNAL_RESTART_FALLBACK_REASON,
    );
  });

  it("copies the incoming signal onto the resolved marker (SIGTERM vs SIGINT)", () => {
    const now = 1_700_000_000_000;
    expect(resolveShutdownMarker(null, "SIGTERM", now).signal).toBe("SIGTERM");
    expect(resolveShutdownMarker(null, "SIGINT", now).signal).toBe("SIGINT");
  });

  it("REASON_PRESERVE_MAX_AGE_MS matches the lifecycle.ts cooperative window", () => {
    // Load-bearing constant — if the two windows drift out of sync, the
    // CLI-stamps-then-SIGTERM race gets harder to reason about. Pin it.
    expect(REASON_PRESERVE_MAX_AGE_MS).toBe(30_000);
  });
});

describe("gateway.ts shutdown-handler wiring (source-level)", () => {
  // Source-grep pins so a future refactor can't silently drop the
  // reason-preserving + fallback-writing behaviour the 2026-04-24 fix
  // added to the SIGTERM handler.
  const gatewaySource = readFileSync(
    join(import.meta.dir, "..", "gateway", "gateway.ts"),
    "utf8",
  );

  it("reads any prior marker before writing the new one", () => {
    // The handler MUST readCleanShutdownMarker first — writing without
    // the readback clobbers reasons stamped by CLI/watchdog/user-slash
    // initiators that ran microseconds before SIGTERM.
    expect(gatewaySource).toMatch(
      /const prior = readCleanShutdownMarker\(GATEWAY_CLEAN_SHUTDOWN_MARKER_PATH\)/,
    );
  });

  it("routes the marker computation through resolveShutdownMarker", () => {
    expect(gatewaySource).toMatch(
      /const next = resolveShutdownMarker\(prior, signal, Date\.now\(\)\)/,
    );
    expect(gatewaySource).toMatch(
      /writeCleanShutdownMarker\(GATEWAY_CLEAN_SHUTDOWN_MARKER_PATH, next\)/,
    );
  });

  it("logs the resolved reason + preserved flag so journals are diagnosable", () => {
    // The journal line is what operators grep when "why did the greeting
    // say X?" questions come up. Keep it present.
    expect(gatewaySource).toContain("shutdown.clean_marker_written");
    expect(gatewaySource).toContain("reason=${JSON.stringify(next.reason ?? '')}");
  });
});

describe("gateway.ts crash-path guard (source-level)", () => {
  // Regression for the reviewer-found bug in PR #55: shutdown() is called
  // for OS signals AND for uncaughtException/unhandledRejection (PR #53 nit
  // fix). The marker write must be GATED on signal value — otherwise a
  // crash writes the marker and silently suppresses its own recovery
  // banner at the next boot, defeating the entire feature.
  //
  // Pinned via source-level grep because the gateway.ts shutdown() function
  // can't be unit-tested in isolation without mocking the entire bot/IPC
  // surface. If anyone removes the guard, this test fails.
  const gatewaySource = readFileSync(
    join(import.meta.dir, "..", "gateway", "gateway.ts"),
    "utf8",
  );

  it("guards writeCleanShutdownMarker on isOsSignal", () => {
    expect(gatewaySource).toContain(
      `const isOsSignal = signal === 'SIGTERM' || signal === 'SIGINT'`,
    );
    expect(gatewaySource).toContain(`if (isOsSignal) {`);
  });

  it("logs the skip path so crashes leave a journal trail", () => {
    expect(gatewaySource).toContain(`shutdown.clean_marker_skipped`);
  });

  it("crash-handler signal labels stay distinguishable from OS signals", () => {
    // shutdown() is called with these literal signal strings from the
    // crash handlers. Each must NOT match isOsSignal above.
    expect(gatewaySource).toMatch(/shutdown\(['"]uncaughtException['"]/);
    expect(gatewaySource).toMatch(/shutdown\(['"]unhandledRejection['"]/);
  });
});
