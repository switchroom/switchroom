import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { diagnoseAuthState } from "../src/cli/auth.js";

/**
 * Tests for the `switchroom auth heal` diagnoser. The pure-function
 * shape (input: claudeConfigDir, output: AuthDiagnosis) lets us cover
 * every state transition without spawning subprocesses.
 *
 * Severity rules under test:
 *   - everything missing on disk           → error
 *   - .credentials.json missing, .oauth-token present → warn
 *   - .credentials.json malformed/corrupt  → error
 *   - access token expired                 → error
 *   - refreshToken missing                 → warn
 *   - everything healthy + future expiry   → ok
 */

let configDir: string;

function writeCreds(payload: object): void {
  writeFileSync(join(configDir, ".credentials.json"), JSON.stringify(payload));
}

function writeOauthToken(value: string): void {
  writeFileSync(join(configDir, ".oauth-token"), value);
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "auth-heal-"));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

describe("diagnoseAuthState", () => {
  it("flags both files missing as error/credentials_missing", () => {
    const r = diagnoseAuthState(configDir);
    expect(r.severity).toBe("error");
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({
      code: "credentials_missing",
      severity: "error",
    });
    // Summary is the user-facing string surfaced in the Telegram
    // boot-self-test issue card. It must point users at the inline
    // /auth dashboard — the agent's chat is the only surface a
    // Telegram-only user has, so a "switchroom auth reauth"
    // terminal command is wrong place. See reference/principles.md
    // "docs test."
    expect(r.findings[0].summary).toMatch(/\/auth/);
    expect(r.findings[0].summary).toMatch(/this chat/);
    expect(r.recommendation.join("\n")).toContain("switchroom auth reauth");
  });

  it("treats .oauth-token-only as OK — switchroom's intended steady state", () => {
    // Regression for the unfixable-warning UX dead end (klanker
    // screenshot 2026-05-02): the user followed the boot-self-test
    // recommendation ("send /auth in this chat to refresh
    // credentials"), the auth flow completed, and the warning still
    // showed because `/auth` writes only `.oauth-token` (deliberate —
    // see auth/manager.ts:922 rmSync of credentialsPath). Telling
    // users to do something that won't fix the problem violates the
    // docs-test principle. Switchroom's hooks get the token via
    // CLAUDE_CODE_OAUTH_TOKEN env injection at start.sh, NOT via
    // .credentials.json self-refresh.
    writeOauthToken("sk-ant-oat01-something");
    const r = diagnoseAuthState(configDir);
    expect(r.severity).toBe("ok");
    expect(r.findings).toHaveLength(0);
    expect(r.recommendation).toHaveLength(0);
  });

  it("flags malformed JSON as error/credentials_malformed", () => {
    writeFileSync(join(configDir, ".credentials.json"), "this is not { json");
    const r = diagnoseAuthState(configDir);
    expect(r.severity).toBe("error");
    expect(r.findings.find((f) => f.code === "credentials_malformed")).toBeDefined();
  });

  it("flags missing accessToken in valid JSON as error/credentials_malformed", () => {
    writeCreds({ claudeAiOauth: {} });
    const r = diagnoseAuthState(configDir);
    expect(r.severity).toBe("error");
    expect(r.findings.find((f) => f.code === "credentials_malformed")).toBeDefined();
  });

  it("flags expired access token as error/token_expired", () => {
    writeCreds({
      claudeAiOauth: {
        accessToken: "tok",
        refreshToken: "rt",
        expiresAt: Date.now() - 86_400_000, // 1 day ago
      },
    });
    const r = diagnoseAuthState(configDir);
    expect(r.severity).toBe("error");
    const expired = r.findings.find((f) => f.code === "token_expired");
    expect(expired).toBeDefined();
    expect(expired!.summary).toMatch(/expired \d+d ago/);
    expect(expired!.summary).toMatch(/\/auth/);
  });

  it("flags missing refreshToken as warn/refresh_token_missing", () => {
    writeCreds({
      claudeAiOauth: {
        accessToken: "tok",
        refreshToken: "",
        expiresAt: Date.now() + 3_600_000,
      },
    });
    const r = diagnoseAuthState(configDir);
    expect(r.severity).toBe("warn");
    expect(
      r.findings.find((f) => f.code === "refresh_token_missing"),
    ).toBeDefined();
  });

  it("returns ok with no findings when state is fully healthy", () => {
    writeCreds({
      claudeAiOauth: {
        accessToken: "tok",
        refreshToken: "rt",
        expiresAt: Date.now() + 3_600_000,
      },
    });
    const r = diagnoseAuthState(configDir);
    expect(r.severity).toBe("ok");
    expect(r.findings).toHaveLength(0);
    expect(r.recommendation).toHaveLength(0);
  });

  it("aggregates max severity across multiple findings (klanker repro)", () => {
    // klanker's actual production state: expired token + no refreshToken.
    // Two findings: one error, one warn. Aggregate must be error.
    writeCreds({
      claudeAiOauth: {
        accessToken: "tok",
        refreshToken: "",
        expiresAt: Date.now() - 9 * 86_400_000,
      },
    });
    const r = diagnoseAuthState(configDir);
    expect(r.severity).toBe("error");
    expect(r.findings).toHaveLength(2);
    expect(r.findings.map((f) => f.code).sort()).toEqual([
      "refresh_token_missing",
      "token_expired",
    ]);
  });

  it("recommendation is empty for ok and non-empty for non-ok", () => {
    writeCreds({
      claudeAiOauth: {
        accessToken: "tok",
        refreshToken: "rt",
        expiresAt: Date.now() + 3_600_000,
      },
    });
    expect(diagnoseAuthState(configDir).recommendation).toHaveLength(0);

    rmSync(join(configDir, ".credentials.json"));
    const r = diagnoseAuthState(configDir);
    expect(r.recommendation.length).toBeGreaterThan(0);
    expect(r.recommendation.join("\n")).toContain("switchroom auth reauth");
  });

  it("recommendation prose differs for credentials_missing vs token_expired (so the user knows what's wrong)", () => {
    const empty = diagnoseAuthState(configDir);
    expect(empty.recommendation.join("\n")).toMatch(/never been authenticated/);

    writeCreds({
      claudeAiOauth: {
        accessToken: "tok",
        refreshToken: "rt",
        expiresAt: Date.now() - 86_400_000,
      },
    });
    const expired = diagnoseAuthState(configDir);
    expect(expired.recommendation.join("\n")).toMatch(/expired and can't be refreshed/);
  });
});
