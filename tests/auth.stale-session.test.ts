import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractCodeChallenge, isSessionStale } from "../src/auth/manager";
import { execSync } from "node:child_process";

/**
 * PR B — stale-session detection.
 *
 * Closes the 2026-04-22 incident: claude setup-token restarts internally
 * while the user is completing the browser OAuth flow, so the tmux pane
 * ends up showing a URL with a DIFFERENT PKCE code_challenge than the
 * one on the URL the user actually used in their browser. When the user
 * pastes their code, it doesn't match the current challenge and
 * silently fails.
 *
 * The fix: save the initial `code_challenge` at session-start time in
 * the session meta file; on retry, compare against the tmux pane's
 * current challenge and kill+recreate if they differ.
 */

// ── extractCodeChallenge ─────────────────────────────────────────────────

describe("extractCodeChallenge", () => {
  it("pulls the code_challenge from a valid authorize URL", () => {
    const url =
      "https://claude.com/cai/oauth/authorize?code=true&client_id=abc" +
      "&response_type=code&code_challenge=abc123XYZ-_&code_challenge_method=S256" +
      "&state=xyz";
    expect(extractCodeChallenge(url)).toBe("abc123XYZ-_");
  });

  it("handles code_challenge anywhere in the query string", () => {
    expect(
      extractCodeChallenge(
        "https://claude.com/cai/oauth/authorize?state=abc&code_challenge=LEADINGPARAM",
      ),
    ).toBe("LEADINGPARAM");
  });

  it("returns null when no code_challenge present", () => {
    expect(extractCodeChallenge("https://claude.com/cai/oauth/authorize?state=x")).toBeNull();
    expect(extractCodeChallenge("")).toBeNull();
    expect(extractCodeChallenge("not a url at all")).toBeNull();
  });

  it("accepts URL-safe base64 characters (letters, digits, hyphen, underscore)", () => {
    const url = "https://x/?code_challenge=D6sdq2JBRuSvfBJcJWOr9AciaSIY8f4NWTH2LTMzVQE";
    expect(extractCodeChallenge(url)).toBe("D6sdq2JBRuSvfBJcJWOr9AciaSIY8f4NWTH2LTMzVQE");
  });

  it("stops at the next query param boundary", () => {
    const url = "https://x/?code_challenge=ABC123&foo=bar&baz=qux";
    expect(extractCodeChallenge(url)).toBe("ABC123");
  });
});

// ── isSessionStale ────────────────────────────────────────────────────────
//
// These tests require a real tmux session so captureTmuxPane() has
// something to read. The test suite creates + tears down a disposable
// tmux session per test.

function tmuxAvailable(): boolean {
  try {
    execSync("command -v tmux", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe.runIf(tmuxAvailable())("isSessionStale — tmux-based tests", () => {
  let tmpRoot: string;
  let agentDir: string;
  let sessionName: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "switchroom-stale-test-"));
    agentDir = join(tmpRoot, "agent");
    mkdirSync(join(agentDir, ".claude"), { recursive: true });
    // Unique session name per test so parallel runs don't collide.
    sessionName = `switchroom-stale-test-${process.pid}-${Date.now()}`;
  });

  afterEach(() => {
    try {
      execSync(`tmux kill-session -t ${sessionName}`, { stdio: "ignore" });
    } catch {
      // already gone
    }
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writeMeta(meta: Record<string, unknown>) {
    writeFileSync(
      join(agentDir, ".claude", ".setup-token.session.json"),
      JSON.stringify(meta, null, 2),
    );
  }

  function startTmuxWithUrl(url: string) {
    // Start a tmux session that echoes the URL. captureTmuxPane reads
    // this back to pretend it's a live setup-token pane.
    execSync(`tmux new-session -d -s ${sessionName} "echo '${url}'; sleep 60"`);
    // Give tmux a moment to render the URL.
    execSync("sleep 0.3");
  }

  it("returns true when meta file is missing entirely", () => {
    // No meta file on disk. Session exists in tmux. Should treat as stale.
    startTmuxWithUrl("https://claude.com/cai/oauth/authorize?code_challenge=ABC");
    expect(isSessionStale(agentDir, sessionName)).toBe(true);
  });

  it("returns true when meta's sessionName doesn't match passed sessionName (defensive)", () => {
    startTmuxWithUrl("https://claude.com/cai/oauth/authorize?code_challenge=ABC");
    writeMeta({
      sessionName: "different-session-name",
      logPath: "/tmp/log",
      startedAt: Date.now(),
      initialCodeChallenge: "ABC",
    });
    expect(isSessionStale(agentDir, sessionName)).toBe(true);
  });

  it("returns true when meta lacks initialCodeChallenge (legacy upgrade path)", () => {
    startTmuxWithUrl("https://claude.com/cai/oauth/authorize?code_challenge=ABC");
    writeMeta({
      sessionName,
      logPath: "/tmp/log",
      startedAt: Date.now(),
      // no initialCodeChallenge \u2014 mimic meta from a pre-fix session
    });
    expect(isSessionStale(agentDir, sessionName)).toBe(true);
  });

  it("returns true when tmux pane shows a DIFFERENT code_challenge than saved", () => {
    // This is the core incident condition from 2026-04-22.
    startTmuxWithUrl(
      "https://claude.com/cai/oauth/authorize?code_challenge=NEW_CHALLENGE_123&state=x",
    );
    writeMeta({
      sessionName,
      logPath: "/tmp/log",
      startedAt: Date.now(),
      initialCodeChallenge: "OLD_CHALLENGE_xyz",
    });
    expect(isSessionStale(agentDir, sessionName)).toBe(true);
  });

  it("returns false when tmux pane shows the same challenge as saved", () => {
    startTmuxWithUrl(
      "https://claude.com/cai/oauth/authorize?code_challenge=MATCHING_CHAL&state=x",
    );
    writeMeta({
      sessionName,
      logPath: "/tmp/log",
      startedAt: Date.now(),
      initialCodeChallenge: "MATCHING_CHAL",
    });
    expect(isSessionStale(agentDir, sessionName)).toBe(false);
  });

  it("returns true when tmux pane has no parseable URL (setup-token not ready)", () => {
    execSync(`tmux new-session -d -s ${sessionName} "echo 'no url here'; sleep 60"`);
    execSync("sleep 0.3");
    writeMeta({
      sessionName,
      logPath: "/tmp/log",
      startedAt: Date.now(),
      initialCodeChallenge: "ABC",
    });
    expect(isSessionStale(agentDir, sessionName)).toBe(true);
  });
});

describe.runIf(!tmuxAvailable())("isSessionStale — tmux unavailable", () => {
  it("skipped because tmux is not installed", () => {
    expect(true).toBe(true);
  });
});
