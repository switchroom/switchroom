import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readTokenFromCredentialsFile,
  submitAuthCode,
} from "../src/auth/manager";

/**
 * 2026-04-22 silent-success bug.
 *
 * `claude setup-token` (CLI 2.1+) no longer prints the OAuth token to
 * stdout on success. Inspecting the claude binary's bundled JS
 * confirmed the success render for `setup-token` mode with a token
 * explicitly returns `null` to the UI renderer and relies on the
 * credentials.json write alone. Switchroom's log-scan for
 * `sk-ant-oat\d+-...` therefore never matched, and every auth timed
 * out with "no token was found after 20s" even though the exchange
 * had succeeded and the token was saved to
 * `<configDir>/.credentials.json`.
 *
 * Fix: add `readTokenFromCredentialsFile()` and wire it as the PRIMARY
 * success-detection channel in `submitAuthCode`. Log-scan stays as
 * a fallback for older CLI versions and debug modes.
 *
 * These tests pin the new behaviour:
 *   - credentials.json parser handles the real file shape
 *   - malformed / missing / wrong-shape files don't crash or return
 *     bogus tokens
 *   - the token regex matches the same format parseSetupTokenValue
 *     recognises (no drift between the two channels)
 */

// Assembled at runtime so the source file never contains a contiguous
// `sk-ant-oat\d+-...` pattern that GitHub Push Protection (or Anthropic's
// secret-scanning peers) would treat as a leaked OAuth token. The shape
// still passes the regex `parseSetupTokenValue` and `readTokenFromCreden-
// tialsFile` use, so the test exercises the real success contract.
// See CLAUDE.md "Secrets in tests" + telegram-plugin/tests/secret-detect-
// secretlint.test.ts for the established pattern.
const VALID_TOKEN = [
  "sk-ant-oat01-",
  "FIXTURE0NOTAREALTOKEN",
  "_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
].join("");

describe("readTokenFromCredentialsFile", () => {
  let tempDir: string;
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "cred-test-"));
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns token from real-shape credentials.json", () => {
    const credPath = join(tempDir, ".credentials.json");
    const payload = {
      claudeAiOauth: {
        accessToken: VALID_TOKEN,
        refreshToken: "sk-ant-ort01-refresh-token-value",
        expiresAt: 1776828935893,
        scopes: ["user:inference"],
        subscriptionType: "max",
        rateLimitTier: "default_claude_max_20x",
      },
    };
    writeFileSync(credPath, JSON.stringify(payload));
    expect(readTokenFromCredentialsFile(credPath)).toBe(VALID_TOKEN);
  });

  it("returns null when file doesn't exist", () => {
    const credPath = join(tempDir, "nonexistent.json");
    expect(readTokenFromCredentialsFile(credPath)).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    const credPath = join(tempDir, ".credentials.json");
    writeFileSync(credPath, "{not valid json");
    expect(readTokenFromCredentialsFile(credPath)).toBeNull();
  });

  it("returns null when claudeAiOauth key is missing", () => {
    const credPath = join(tempDir, ".credentials.json");
    writeFileSync(credPath, JSON.stringify({ someOtherKey: "value" }));
    expect(readTokenFromCredentialsFile(credPath)).toBeNull();
  });

  it("returns null when accessToken is missing", () => {
    const credPath = join(tempDir, ".credentials.json");
    writeFileSync(
      credPath,
      JSON.stringify({ claudeAiOauth: { refreshToken: "x" } }),
    );
    expect(readTokenFromCredentialsFile(credPath)).toBeNull();
  });

  it("returns null when accessToken is not a string", () => {
    const credPath = join(tempDir, ".credentials.json");
    writeFileSync(
      credPath,
      JSON.stringify({ claudeAiOauth: { accessToken: 12345 } }),
    );
    expect(readTokenFromCredentialsFile(credPath)).toBeNull();
  });

  it("rejects accessToken that doesn't match sk-ant-oat format", () => {
    // Protects against bizarre CLI regressions where a different
    // string type ends up in accessToken (e.g. an API key, or a
    // half-written token).
    const credPath = join(tempDir, ".credentials.json");
    writeFileSync(
      credPath,
      JSON.stringify({ claudeAiOauth: { accessToken: "not-a-valid-token" } }),
    );
    expect(readTokenFromCredentialsFile(credPath)).toBeNull();
  });

  it("handles a partially-written file (empty string)", () => {
    // claude CLI could theoretically crash mid-write. Reader must not
    // throw \u2014 just return null and let the caller keep polling.
    const credPath = join(tempDir, ".credentials.json");
    writeFileSync(credPath, "");
    expect(readTokenFromCredentialsFile(credPath)).toBeNull();
  });

  it("accepts token with the same format regex as parseSetupTokenValue", () => {
    // Pins the success contract: credentials-file reader and log-scan
    // recognise the same token shape. If someone tightens one regex
    // without the other, this test catches the drift.
    const credPath = join(tempDir, ".credentials.json");
    // Variations: different oat version digit, different length body.
    const samples = [
      "sk-ant-oat01-abcDEF123_xyz-XYZ.abc",
      "sk-ant-oat2-abc",
      "sk-ant-oat10-" + "A".repeat(200),
    ];
    for (const tok of samples) {
      writeFileSync(
        credPath,
        JSON.stringify({ claudeAiOauth: { accessToken: tok } }),
      );
      expect(readTokenFromCredentialsFile(credPath)).toBe(tok);
    }
  });
});

describe("submitAuthCode falls through to 'no session' without a live tmux", () => {
  // We can't fully exercise the submitAuthCode happy-path in unit
  // tests without a real tmux + claude CLI running. But we can pin
  // the early-exit behaviour: if no tmux session exists, the
  // credentials-file path is not polled, and the user gets the
  // expected instructions. This prevents a regression where someone
  // accidentally reads the credentials file and succeeds with a
  // stale token from a previous login.

  let tempDir: string;
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "submit-test-"));
    mkdirSync(join(tempDir, ".claude"), { recursive: true });
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("does NOT read credentials.json when tmux session is absent", () => {
    // Pre-populate credentials.json with what would look like a valid
    // token. If submitAuthCode skips the tmux check and naively reads
    // the file, it'd falsely report success.
    const credPath = join(tempDir, ".claude", ".credentials.json");
    writeFileSync(
      credPath,
      JSON.stringify({ claudeAiOauth: { accessToken: VALID_TOKEN } }),
    );
    const result = submitAuthCode("ghost-agent", tempDir, "FAKECODE");
    expect(result.completed).toBe(false);
    expect(result.tokenSaved).toBe(false);
    expect(result.instructions.join(" ")).toMatch(/No pending auth session/);
  });
});
