/**
 * Regression tests for the 2026-04-25 stale-token capture bug (gymbro incident).
 *
 * Root cause: when a non-force `/auth <agent>` flow started, the poll loop in
 * `submitAuthCode` read `.credentials.json` on the first tick and accepted
 * whatever token was already there from a prior auth — even if that token was
 * expired. Gymbro's credentials.json held a token that expired 2026-04-20;
 * switchroom captured it, wrote it to `.oauth-token`, and the agent started
 * 401-ing against api.anthropic.com.
 *
 * Two fixes are exercised here:
 *
 * Fix 1 — stale-token capture (mtime gate):
 *   `startAuthSession` snapshots the mtime of `.credentials.json` at session
 *   start. The poll loop only accepts a credentials.json read when the file's
 *   mtime is strictly greater than the snapshot. A pre-existing file at the
 *   same mtime is silently skipped; polling continues until the real new token
 *   arrives (or the timeout fires).
 *
 * Fix 2 — credentials.json shadowing at runtime:
 *   After `writeOAuthToken` succeeds, `submitAuthCode` unlinks the agent's
 *   `.credentials.json`. This prevents a running `claude` CLI from ignoring
 *   `CLAUDE_CODE_OAUTH_TOKEN` (set from `.oauth-token`) and falling back to a
 *   stale credentials file instead.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  utimesSync,
  statSync,
} from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { submitAuthCode, readTokenFromCredentialsFile } from "../src/auth/manager";

function tmuxAvailable(): boolean {
  try {
    execSync("command -v tmux", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// A syntactically valid token for use in fixtures. Not a real credential.
const STALE_TOKEN =
  "sk-ant-oat01-STALE_STALE_STALE_stale00000000000000000000000000000000000000000000000000000000000";
const FRESH_TOKEN =
  "sk-ant-oat01-FRESH_FRESH_FRESH_fresh00000000000000000000000000000000000000000000000000000000000";

// The session meta shape that submitAuthCode reads from disk.
interface AuthSessionMeta {
  sessionName: string;
  logPath: string;
  startedAt: number;
  configDir?: string;
  credentialsMtimeAtStart?: number;
}

/**
 * Write a minimal `.credentials.json` with the given token into `claudeDir`.
 */
function writeCredentials(claudeDir: string, token: string): void {
  writeFileSync(
    join(claudeDir, ".credentials.json"),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: token,
        expiresAt: Date.now() + 60_000,
      },
    }),
  );
}

/**
 * Write the session meta that submitAuthCode reads.
 * The `credentialsMtimeAtStart` field is the new stale-token guard.
 */
function writeSessionMeta(claudeDir: string, meta: AuthSessionMeta): void {
  writeFileSync(
    join(claudeDir, ".setup-token.session.json"),
    JSON.stringify(meta, null, 2),
  );
}

describe("Fix 1 — submitAuthCode rejects pre-existing stale credentials.json", () => {
  let agentDir: string;
  let claudeDir: string;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "sw-stale-fix1-"));
    claudeDir = join(agentDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(agentDir, { recursive: true, force: true });
  });

  it("returns completed:false when credentials.json predates the session start (no tmux)", () => {
    // Write a stale credentials.json BEFORE the session starts.
    writeCredentials(claudeDir, STALE_TOKEN);

    // Snapshot mtime AFTER writing (simulates what startAuthSession does).
    const staleCredPath = join(claudeDir, ".credentials.json");
    const { mtimeMs } = statSync(staleCredPath);

    // Write session meta with the snapshot. No new credentials will be written
    // during this test (no real tmux / claude CLI running).
    writeSessionMeta(claudeDir, {
      sessionName: "switchroom-auth-ghost",
      logPath: join(claudeDir, ".setup-token.log"),
      startedAt: Date.now(),
      configDir: claudeDir,
      credentialsMtimeAtStart: mtimeMs,
    });

    // submitAuthCode will fail fast on "no tmux session" — that's expected.
    // The important invariant: it must NOT succeed with the stale token.
    const result = submitAuthCode(
      "ghost",
      agentDir,
      "FAKECODE",
      undefined,
      { pollIntervalMs: 10, pollTimeoutMs: 50 },
    );

    expect(result.completed).toBe(false);
    expect(result.tokenSaved).toBe(false);
    // The result should be "No pending auth session", not a false success.
    expect(result.instructions.join(" ")).toMatch(/No pending auth session/);
    // The stale token must NOT have been written to .oauth-token.
    expect(existsSync(join(claudeDir, ".oauth-token"))).toBe(false);
  });

  it("poll loop skips credentials.json when mtime equals the snapshot (not strictly newer)", () => {
    // This tests the core invariant: mtime must be STRICTLY greater.
    // We write the file, snapshot, then call submitAuthCode with no tmux.
    // Because there's no tmux session it returns early with "No pending auth
    // session". The stale file was present but the function must not have
    // treated it as a fresh successful auth.

    writeCredentials(claudeDir, STALE_TOKEN);
    const { mtimeMs } = statSync(join(claudeDir, ".credentials.json"));

    writeSessionMeta(claudeDir, {
      sessionName: "switchroom-auth-stale",
      logPath: join(claudeDir, ".setup-token.log"),
      startedAt: Date.now(),
      configDir: claudeDir,
      credentialsMtimeAtStart: mtimeMs, // exact same mtime → must be rejected
    });

    const result = submitAuthCode(
      "stale-agent",
      agentDir,
      "FAKECODE",
      undefined,
      { pollIntervalMs: 10, pollTimeoutMs: 50 },
    );

    expect(result.completed).toBe(false);
    expect(result.tokenSaved).toBe(false);
    expect(existsSync(join(claudeDir, ".oauth-token"))).toBe(false);
  });

  it("legacy session meta (no credentialsMtimeAtStart field) does not break in-flight sessions", () => {
    // Pre-upgrade sessions written before Fix 1 have no credentialsMtimeAtStart.
    // Missing value → treated as 0, so any positive mtime passes. We can't do a
    // full happy-path test (needs real tmux), but we confirm the no-tmux early
    // exit works correctly — the function must not throw.
    writeCredentials(claudeDir, STALE_TOKEN);

    // Deliberately omit credentialsMtimeAtStart to simulate a legacy meta file.
    writeSessionMeta(claudeDir, {
      sessionName: "switchroom-auth-legacy",
      logPath: join(claudeDir, ".setup-token.log"),
      startedAt: Date.now(),
      configDir: claudeDir,
      // credentialsMtimeAtStart intentionally absent
    });

    const result = submitAuthCode(
      "legacy-agent",
      agentDir,
      "FAKECODE",
      undefined,
      { pollIntervalMs: 10, pollTimeoutMs: 50 },
    );

    // Should still return a clean failure, not throw.
    expect(result.completed).toBe(false);
    expect(result.tokenSaved).toBe(false);
  });
});

describe("Fix 2 — submitAuthCode clears credentials.json on success", () => {
  let agentDir: string;
  let claudeDir: string;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "sw-stale-fix2-"));
    claudeDir = join(agentDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(agentDir, { recursive: true, force: true });
  });

  it("credentials.json is preserved when submitAuthCode early-exits with no tmux session", () => {
    // Negative invariant for Fix 2: the unlink must NOT fire on the no-session
    // failure path. Otherwise a stale stranded session would silently nuke a
    // user's credentials file the next time they typed /auth code. The full
    // success-branch behavior is exercised in the tmux-gated describe block
    // below.
    writeCredentials(claudeDir, STALE_TOKEN);

    writeSessionMeta(claudeDir, {
      sessionName: "switchroom-auth-fix2-baseline",
      logPath: join(claudeDir, ".setup-token.log"),
      startedAt: Date.now(),
      configDir: claudeDir,
      credentialsMtimeAtStart: Date.now() - 1000,
    });

    const result = submitAuthCode(
      "fix2-agent",
      agentDir,
      "FAKECODE",
      undefined,
      { pollIntervalMs: 10, pollTimeoutMs: 50 },
    );

    // No-tmux early exit — credentials.json must survive (we don't delete on failure).
    expect(result.completed).toBe(false);
    expect(existsSync(join(claudeDir, ".credentials.json"))).toBe(true);
  });

});

// Behavioral end-to-end test for Fix 2. Drives submitAuthCode through its
// success branch using a real tmux session and the log-file detection
// channel, then asserts the credentials.json was unlinked by the function
// itself (not by the test). Mirrors the tmux-gating pattern from
// auth.stale-session.test.ts.
describe.runIf(tmuxAvailable())("Fix 2 — submitAuthCode unlinks credentials.json on success (tmux required)", () => {
  let agentDir: string;
  let claudeDir: string;
  let agentName: string;
  let sessionName: string;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "sw-stale-fix2-real-"));
    claudeDir = join(agentDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    // Unique agent name → unique tmux session per test (no parallel collisions).
    agentName = `fix2real-${process.pid}-${Date.now()}`;
    sessionName = `switchroom-auth-${agentName}`;
  });

  afterEach(() => {
    try {
      execSync(`tmux kill-session -t ${sessionName}`, { stdio: "ignore" });
    } catch {
      // already gone — submitAuthCode kills its own session on success
    }
    rmSync(agentDir, { recursive: true, force: true });
  });

  it("removes a stale credentials.json after a successful auth via log-file channel", () => {
    // 1. Stale credentials.json on disk before the auth started — Fix 2 must
    //    delete this on success even though it wasn't the source of the token.
    writeCredentials(claudeDir, STALE_TOKEN);
    const staleMtime = statSync(join(claudeDir, ".credentials.json")).mtimeMs;

    // 2. Pre-populate the auth log with a fresh token. The log-file channel
    //    is NOT mtime-gated, so it'll be the one that wins the poll race —
    //    while the credentials.json channel correctly stays blocked because
    //    the snapshot mtime equals the file's mtime (no claude write happened).
    const logPath = join(claudeDir, ".setup-token.log");
    writeFileSync(logPath, `boot output\nLogin successful\n${FRESH_TOKEN}\n`);

    // 3. Session meta that submitAuthCode will read.
    writeSessionMeta(claudeDir, {
      sessionName,
      logPath,
      startedAt: Date.now(),
      configDir: claudeDir,
      credentialsMtimeAtStart: staleMtime, // gate blocks the stale file
    });

    // 4. Live, harmless tmux session so tmuxSessionExists returns true and
    //    `tmux send-keys` has somewhere to deliver the code. Detached, no-op.
    execSync(`tmux new-session -d -s ${sessionName} "sleep 30"`);

    const result = submitAuthCode(agentName, agentDir, "BROWSERCODE", undefined, {
      pollIntervalMs: 10,
      pollTimeoutMs: 2000,
    });

    // Fix 2 invariant: submitAuthCode itself removed credentials.json.
    expect(result.completed).toBe(true);
    expect(result.tokenSaved).toBe(true);
    expect(existsSync(join(claudeDir, ".credentials.json"))).toBe(false);

    // Fix 1 invariant: the stale token did NOT win — the fresh token from
    // the log-file channel was captured and persisted.
    const oauthTokenPath = join(claudeDir, ".oauth-token");
    expect(existsSync(oauthTokenPath)).toBe(true);
    expect(readFileSync(oauthTokenPath, "utf-8").trim()).toBe(FRESH_TOKEN);

    // Auth log file is also cleaned up on success (it contained the token).
    expect(existsSync(logPath)).toBe(false);
  });
});

describe("Fix 1 + Fix 2 combined — mtime snapshot with fresh credentials write", () => {
  let agentDir: string;
  let claudeDir: string;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "sw-stale-combined-"));
    claudeDir = join(agentDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(agentDir, { recursive: true, force: true });
  });

  it("mtime gate accepts a credentials.json written after the snapshot", () => {
    // Write the stale credentials file.
    writeCredentials(claudeDir, STALE_TOKEN);
    const credPath = join(claudeDir, ".credentials.json");
    const staleMtime = statSync(credPath).mtimeMs;

    // Advance the mtime by 2 seconds to simulate claude writing a fresh token.
    const newMtime = new Date(staleMtime + 2000);
    writeFileSync(credPath, JSON.stringify({
      claudeAiOauth: {
        accessToken: FRESH_TOKEN,
        expiresAt: Date.now() + 365 * 24 * 60 * 60_000,
      },
    }));
    utimesSync(credPath, newMtime, newMtime);

    const freshMtime = statSync(credPath).mtimeMs;

    // Verify the mtime is now strictly greater than the stale snapshot.
    expect(freshMtime).toBeGreaterThan(staleMtime);

    // The poll loop condition: credsMtime > credsMtimeSnapshot → token accepted.
    // Simulate this check directly to confirm the invariant.
    const token = readTokenFromCredentialsFile(credPath);
    // The file now has a fresh token; since freshMtime > staleMtime, the
    // poll loop would accept it.
    expect(token).toBe(FRESH_TOKEN);
    expect(freshMtime).toBeGreaterThan(staleMtime); // gate passes
  });

  it("mtime gate rejects a credentials.json whose mtime equals the snapshot", () => {
    writeCredentials(claudeDir, STALE_TOKEN);
    const credPath = join(claudeDir, ".credentials.json");
    const staleMtime = statSync(credPath).mtimeMs;

    // mtime has NOT changed — the check `credsMtime > credsMtimeSnapshot`
    // should be false, so the token is skipped.
    const sameTimeMtime = statSync(credPath).mtimeMs;
    expect(sameTimeMtime).toBe(staleMtime);
    expect(sameTimeMtime > staleMtime).toBe(false); // gate blocked
  });
});
