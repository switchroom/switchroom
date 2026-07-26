/**
 * Tests for google-storage — RFC G Phase 3b.2c.
 *
 * Covers normalize / read / write / remove / list with a tmpdir
 * stateDir. No mocking — real filesystem.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  googleAccountCredentialsPath,
  googleAccountDir,
  googleAccountExists,
  listGoogleAccounts,
  normalizeGoogleAccountForStorage,
  readGoogleAccountCredentials,
  removeGoogleAccount,
  validateGoogleAccountLabel,
  writeGoogleAccountCredentials,
} from "./google-storage.js";
import type { GoogleCredentialsShape } from "./protocol.js";

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "google-storage-test-"));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

const sampleCreds: GoogleCredentialsShape = {
  googleOauth: {
    accessToken: "at-x",
    refreshToken: "rt-x",
    expiresAt: 99999,
    scope: "https://www.googleapis.com/auth/drive",
    clientId: "client-id-x",
    accountEmail: "alice@example.com",
    tokenType: "Bearer",
  },
};

describe("normalizeGoogleAccountForStorage", () => {
  it("lowercases + trims", () => {
    expect(normalizeGoogleAccountForStorage("  Alice@Example.COM ")).toBe("alice@example.com");
  });
});

describe("paths", () => {
  it("googleAccountDir is <stateDir>/google/<normalized-account>/", () => {
    expect(googleAccountDir(stateDir, "Alice@Example.COM")).toBe(
      join(stateDir, "google", "alice@example.com"),
    );
  });

  it("googleAccountCredentialsPath appends credentials.json", () => {
    expect(googleAccountCredentialsPath(stateDir, "alice@example.com")).toBe(
      join(stateDir, "google", "alice@example.com", "credentials.json"),
    );
  });
});

describe("write + read round-trip", () => {
  it("write creates the dir + file, read returns the credentials verbatim", () => {
    writeGoogleAccountCredentials(stateDir, "alice@example.com", sampleCreds);
    const read = readGoogleAccountCredentials(stateDir, "alice@example.com");
    expect(read).toEqual(sampleCreds);
  });

  it("writes credentials.json with mode 0600", () => {
    writeGoogleAccountCredentials(stateDir, "alice@example.com", sampleCreds);
    const path = googleAccountCredentialsPath(stateDir, "alice@example.com");
    const stat = statSync(path);
    // mask off the file-type bits, check perms
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("normalization makes case-variant reads hit the same file", () => {
    writeGoogleAccountCredentials(stateDir, "alice@example.com", sampleCreds);
    const read = readGoogleAccountCredentials(stateDir, "ALICE@EXAMPLE.COM");
    expect(read).toEqual(sampleCreds);
  });

  it("overwrites existing credentials atomically", () => {
    writeGoogleAccountCredentials(stateDir, "alice@example.com", sampleCreds);
    const updated = {
      googleOauth: { ...sampleCreds.googleOauth, accessToken: "at-NEW" },
    };
    writeGoogleAccountCredentials(stateDir, "alice@example.com", updated);
    expect(readGoogleAccountCredentials(stateDir, "alice@example.com")).toEqual(updated);
  });
});

describe("read returns null for missing/malformed", () => {
  it("returns null when credentials.json is absent", () => {
    expect(readGoogleAccountCredentials(stateDir, "nobody@example.com")).toBe(null);
  });

  it("returns null when JSON is malformed", () => {
    const path = googleAccountCredentialsPath(stateDir, "alice@example.com");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, "{not json", { mode: 0o600 });
    expect(readGoogleAccountCredentials(stateDir, "alice@example.com")).toBe(null);
  });

  it("returns null when shape lacks googleOauth.accessToken", () => {
    const path = googleAccountCredentialsPath(stateDir, "alice@example.com");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify({ googleOauth: {} }), { mode: 0o600 });
    expect(readGoogleAccountCredentials(stateDir, "alice@example.com")).toBe(null);
  });
});

describe("googleAccountExists", () => {
  it("false before write, true after, false after remove", () => {
    expect(googleAccountExists(stateDir, "alice@example.com")).toBe(false);
    writeGoogleAccountCredentials(stateDir, "alice@example.com", sampleCreds);
    expect(googleAccountExists(stateDir, "alice@example.com")).toBe(true);
    removeGoogleAccount(stateDir, "alice@example.com");
    expect(googleAccountExists(stateDir, "alice@example.com")).toBe(false);
  });
});

describe("removeGoogleAccount", () => {
  it("removes the per-account directory", () => {
    writeGoogleAccountCredentials(stateDir, "alice@example.com", sampleCreds);
    expect(existsSync(googleAccountDir(stateDir, "alice@example.com"))).toBe(true);
    removeGoogleAccount(stateDir, "alice@example.com");
    expect(existsSync(googleAccountDir(stateDir, "alice@example.com"))).toBe(false);
  });

  it("idempotent — removing absent account is a no-op", () => {
    expect(() => removeGoogleAccount(stateDir, "nobody@example.com")).not.toThrow();
  });
});

describe("listGoogleAccounts", () => {
  it("returns [] when state dir doesn't have a google subdir", () => {
    expect(listGoogleAccounts(stateDir)).toEqual([]);
  });

  it("returns all accounts that have credentials.json", () => {
    writeGoogleAccountCredentials(stateDir, "alice@example.com", sampleCreds);
    writeGoogleAccountCredentials(stateDir, "work@bigcorp.com", {
      googleOauth: { ...sampleCreds.googleOauth, accountEmail: "work@bigcorp.com" },
    });
    expect(listGoogleAccounts(stateDir).sort()).toEqual([
      "alice@example.com",
      "work@bigcorp.com",
    ]);
  });

  it("excludes dirs without credentials.json (defensive against half-removed state)", () => {
    writeGoogleAccountCredentials(stateDir, "alice@example.com", sampleCreds);
    // Create an empty dir that doesn't have credentials.json
    mkdirSync(join(stateDir, "google", "ghost@example.com"), {
      recursive: true,
      mode: 0o700,
    });
    expect(listGoogleAccounts(stateDir).sort()).toEqual(["alice@example.com"]);
  });
});

// ────────────────────────────────────────────────────────────────────────
// validateGoogleAccountLabel — defense-in-depth path-traversal guard
// per Phase 3b.2c reviewer feedback.
// ────────────────────────────────────────────────────────────────────────

describe("validateGoogleAccountLabel", () => {
  it("accepts valid email-shaped labels", () => {
    expect(() => validateGoogleAccountLabel("alice@example.com")).not.toThrow();
    expect(() => validateGoogleAccountLabel("alice+work@example.co.uk")).not.toThrow();
  });

  it("rejects empty string", () => {
    expect(() => validateGoogleAccountLabel("")).toThrow(/non-empty/);
  });

  it("rejects path-traversal sequences", () => {
    expect(() => validateGoogleAccountLabel("..")).toThrow(/email shape/);
    expect(() => validateGoogleAccountLabel("../../../etc/passwd")).toThrow();
  });

  it("rejects forward and back slashes", () => {
    expect(() => validateGoogleAccountLabel("alice/bob@example.com")).toThrow();
    expect(() => validateGoogleAccountLabel("alice\\bob@example.com")).toThrow();
  });

  it("rejects whitespace + leading/trailing whitespace", () => {
    expect(() => validateGoogleAccountLabel("alice bob@example.com")).toThrow();
    expect(() => validateGoogleAccountLabel("  alice@example.com  ")).toThrow();
    expect(() => validateGoogleAccountLabel("alice@example.com\n")).toThrow();
  });

  it("rejects colons (broker slot-key separator)", () => {
    expect(() => validateGoogleAccountLabel("alice:risky@example.com")).toThrow();
  });

  it("rejects null bytes", () => {
    expect(() => validateGoogleAccountLabel("alice\u0000@example.com")).toThrow();
  });

  it("rejects non-string input via type-narrowing", () => {
    expect(() => validateGoogleAccountLabel(undefined as unknown as string)).toThrow(
      /non-empty/,
    );
    expect(() => validateGoogleAccountLabel(null as unknown as string)).toThrow();
  });
});
