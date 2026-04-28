/**
 * Tests for the bounded-poll auth-settling behaviour introduced by #171 / #176.
 *
 * The two issues describe the same underlying race from different angles:
 *   #171 — meta file absent right after scaffold → status shows ✗
 *   #176 — after `switchroom restart`, status shows stale values for ~10-30 s
 *
 * The primary fix lives in two places:
 *   1. getAuthStatus()  — lazy-sync of the legacy .oauth-token mirror when the
 *      accounts/ slot token exists but the legacy path doesn't (tested here).
 *   2. registerRestartCommand() — waitForAuthConverge() blocks the restart CLI
 *      until getAuthStatus() returns authenticated=true (tested here via the
 *      getAuthStatus primitive, since waitForAuthConverge() is internal).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { getAuthStatus } from "../src/auth/manager.js";

describe("auth status settling (#171 / #176)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = resolve(tmpdir(), `switchroom-auth-settle-test-${Date.now()}`);
    mkdirSync(resolve(tempDir, ".claude"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("converges to authenticated=true within one call when slot token exists but legacy mirror is absent", () => {
    // Reproduce the #171 race:
    //   - accounts/default/.oauth-token written by submitAuthCode
    //   - .claude/.oauth-token (legacy mirror) NOT yet created
    //   - getAuthStatus() must lazy-sync and return authenticated=true
    const accountsDir = resolve(tempDir, ".claude", "accounts", "default");
    mkdirSync(accountsDir, { recursive: true });

    const expiresAt = Date.now() + 365 * 24 * 60 * 60_000;
    writeFileSync(
      resolve(accountsDir, ".oauth-token"),
      "sk-ant-oat01-settle-test\n",
      { mode: 0o600 },
    );
    writeFileSync(
      resolve(accountsDir, ".oauth-token.meta.json"),
      JSON.stringify({ createdAt: Date.now(), expiresAt, source: "claude-setup-token" }),
      { mode: 0o600 },
    );
    writeFileSync(resolve(tempDir, ".claude", "active"), "default\n", { mode: 0o600 });

    // Legacy mirror absent — this is the "first call before restart mirrored it"
    expect(existsSync(resolve(tempDir, ".claude", ".oauth-token"))).toBe(false);

    const status = getAuthStatus("settle-agent", tempDir);

    // Must report authenticated on the FIRST call — no manual retry needed.
    expect(status.authenticated).toBe(true);
    expect(status.source).toBe("oauth-token");
  });

  it("returns authenticated=false when no token exists at all (not a false-positive)", () => {
    // Guard: no slot, no legacy file — must NOT return authenticated.
    const status = getAuthStatus("empty-agent", tempDir);
    expect(status.authenticated).toBe(false);
  });

  it("returns authenticated=false when slot token exists but active marker is absent", () => {
    // Without the active marker, lazy-sync can't know which slot to mirror.
    // Must fall through gracefully rather than crash.
    const accountsDir = resolve(tempDir, ".claude", "accounts", "default");
    mkdirSync(accountsDir, { recursive: true });
    writeFileSync(
      resolve(accountsDir, ".oauth-token"),
      "sk-ant-oat01-no-active\n",
      { mode: 0o600 },
    );
    // No active marker file.

    const status = getAuthStatus("no-active-agent", tempDir);
    // Without knowing the active slot, legacy sync can't run → no oauth token.
    expect(status.authenticated).toBe(false);
  });

  it("simulates #176 polling loop: repeated getAuthStatus calls converge once token is mirrored", () => {
    // Simulate the window where restart has completed but the legacy mirror
    // hasn't been written yet.  A tight waitForAuthConverge() loop calls
    // getAuthStatus() repeatedly.  On the first call with the fix the lazy-sync
    // mirrors the slot token → converged immediately.
    //
    // This test verifies idempotence: calling getAuthStatus() multiple times
    // in quick succession all return the same settled result.
    const accountsDir = resolve(tempDir, ".claude", "accounts", "default");
    mkdirSync(accountsDir, { recursive: true });

    const expiresAt = Date.now() + 365 * 24 * 60 * 60_000;
    writeFileSync(
      resolve(accountsDir, ".oauth-token"),
      "sk-ant-oat01-poll-test\n",
      { mode: 0o600 },
    );
    writeFileSync(
      resolve(accountsDir, ".oauth-token.meta.json"),
      JSON.stringify({ createdAt: Date.now(), expiresAt, source: "claude-setup-token" }),
      { mode: 0o600 },
    );
    writeFileSync(resolve(tempDir, ".claude", "active"), "default\n", { mode: 0o600 });

    // Three back-to-back calls (like the poll loop in waitForAuthConverge).
    for (let i = 0; i < 3; i++) {
      const s = getAuthStatus("poll-agent", tempDir);
      expect(s.authenticated).toBe(true);
      expect(s.source).toBe("oauth-token");
    }
  });
});
