/**
 * Tests for microsoft-storage — RFC #1873 PR 1.
 *
 * Mirrors `google-storage.test.ts` shape: tmpdir stateDir, real
 * filesystem (no mocking). Covers normalize / validate / read / write /
 * remove / list.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  listMicrosoftAccounts,
  microsoftAccountCredentialsPath,
  microsoftAccountDir,
  microsoftAccountExists,
  normalizeMicrosoftAccountForStorage,
  readMicrosoftAccountCredentials,
  removeMicrosoftAccount,
  validateMicrosoftAccountLabel,
  writeMicrosoftAccountCredentials,
} from "./microsoft-storage.js";
import type { MicrosoftCredentialsShape } from "./protocol.js";

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "microsoft-storage-test-"));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

const PERSONAL_MSA_TID = "9188040d-6c67-4c5b-b112-36a304b66dad";

const sampleCreds: MicrosoftCredentialsShape = {
  microsoftOauth: {
    accessToken: "at-x",
    refreshToken: "rt-x",
    expiresAt: Date.now() + 3600_000,
    scope: "openid profile email offline_access User.Read Mail.ReadWrite",
    clientId: "client-id-x",
    accountEmail: "alice@outlook.com",
    tokenType: "Bearer",
    tenantId: PERSONAL_MSA_TID,
    accountType: "personal",
    homeAccountId: `oid-x.${PERSONAL_MSA_TID}`,
  },
};

describe("normalizeMicrosoftAccountForStorage", () => {
  it("lowercases + trims", () => {
    expect(normalizeMicrosoftAccountForStorage("  Alice@Outlook.COM "))
      .toBe("alice@outlook.com");
  });
});

describe("paths", () => {
  it("microsoftAccountDir is <stateDir>/microsoft/<normalized-account>/", () => {
    const dir = microsoftAccountDir(stateDir, "Alice@Outlook.com");
    expect(dir).toBe(join(stateDir, "microsoft", "alice@outlook.com"));
  });

  it("microsoftAccountCredentialsPath appends credentials.json", () => {
    const path = microsoftAccountCredentialsPath(stateDir, "alice@outlook.com");
    expect(path).toBe(join(stateDir, "microsoft", "alice@outlook.com", "credentials.json"));
  });
});

describe("write + read round-trip", () => {
  it("write creates the dir + file, read returns the credentials verbatim", () => {
    const path = writeMicrosoftAccountCredentials(stateDir, "alice@outlook.com", sampleCreds);
    expect(existsSync(path)).toBe(true);
    const back = readMicrosoftAccountCredentials(stateDir, "alice@outlook.com");
    expect(back).toEqual(sampleCreds);
  });

  it("writes credentials.json with mode 0600", () => {
    const path = writeMicrosoftAccountCredentials(stateDir, "alice@outlook.com", sampleCreds);
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("normalization makes case-variant reads hit the same file", () => {
    writeMicrosoftAccountCredentials(stateDir, "ALICE@OUTLOOK.COM", sampleCreds);
    const back = readMicrosoftAccountCredentials(stateDir, "alice@outlook.com");
    expect(back).toEqual(sampleCreds);
  });

  it("overwrites existing credentials atomically", () => {
    writeMicrosoftAccountCredentials(stateDir, "alice@outlook.com", sampleCreds);
    const newer: MicrosoftCredentialsShape = {
      microsoftOauth: {
        ...sampleCreds.microsoftOauth,
        accessToken: "at-new",
        refreshToken: "rt-new",
      },
    };
    writeMicrosoftAccountCredentials(stateDir, "alice@outlook.com", newer);
    const back = readMicrosoftAccountCredentials(stateDir, "alice@outlook.com");
    expect(back?.microsoftOauth.accessToken).toBe("at-new");
    expect(back?.microsoftOauth.refreshToken).toBe("rt-new");
  });
});

describe("read returns null for missing/malformed", () => {
  it("returns null when credentials.json is absent", () => {
    expect(readMicrosoftAccountCredentials(stateDir, "missing@outlook.com"))
      .toBeNull();
  });

  it("returns null when JSON is malformed", () => {
    const path = microsoftAccountCredentialsPath(stateDir, "broken@outlook.com");
    mkdirSync(microsoftAccountDir(stateDir, "broken@outlook.com"), { recursive: true });
    writeFileSync(path, "{ not valid json");
    expect(readMicrosoftAccountCredentials(stateDir, "broken@outlook.com"))
      .toBeNull();
  });

  it("returns null when shape lacks microsoftOauth.accessToken", () => {
    const path = microsoftAccountCredentialsPath(stateDir, "noshape@outlook.com");
    mkdirSync(microsoftAccountDir(stateDir, "noshape@outlook.com"), { recursive: true });
    writeFileSync(path, JSON.stringify({ microsoftOauth: { refreshToken: "rt" } }));
    expect(readMicrosoftAccountCredentials(stateDir, "noshape@outlook.com"))
      .toBeNull();
  });
});

describe("microsoftAccountExists", () => {
  it("false before write, true after, false after remove", () => {
    expect(microsoftAccountExists(stateDir, "alice@outlook.com")).toBe(false);
    writeMicrosoftAccountCredentials(stateDir, "alice@outlook.com", sampleCreds);
    expect(microsoftAccountExists(stateDir, "alice@outlook.com")).toBe(true);
    removeMicrosoftAccount(stateDir, "alice@outlook.com");
    expect(microsoftAccountExists(stateDir, "alice@outlook.com")).toBe(false);
  });
});

describe("removeMicrosoftAccount", () => {
  it("removes the per-account directory", () => {
    writeMicrosoftAccountCredentials(stateDir, "alice@outlook.com", sampleCreds);
    expect(existsSync(microsoftAccountDir(stateDir, "alice@outlook.com"))).toBe(true);
    removeMicrosoftAccount(stateDir, "alice@outlook.com");
    expect(existsSync(microsoftAccountDir(stateDir, "alice@outlook.com"))).toBe(false);
  });

  it("idempotent — removing absent account is a no-op", () => {
    expect(() => removeMicrosoftAccount(stateDir, "ghost@outlook.com")).not.toThrow();
  });
});

describe("listMicrosoftAccounts", () => {
  it("returns [] when state dir doesn't have a microsoft subdir", () => {
    expect(listMicrosoftAccounts(stateDir)).toEqual([]);
  });

  it("returns all accounts that have credentials.json", () => {
    writeMicrosoftAccountCredentials(stateDir, "alice@outlook.com", sampleCreds);
    writeMicrosoftAccountCredentials(stateDir, "bob@contoso.com", sampleCreds);
    const list = listMicrosoftAccounts(stateDir).sort();
    expect(list).toEqual(["alice@outlook.com", "bob@contoso.com"]);
  });

  it("excludes dirs without credentials.json (defensive against half-removed state)", () => {
    writeMicrosoftAccountCredentials(stateDir, "alice@outlook.com", sampleCreds);
    // Create empty dir for an unwritten account
    mkdirSync(join(stateDir, "microsoft", "half-removed@outlook.com"), { recursive: true });
    const list = listMicrosoftAccounts(stateDir);
    expect(list).toContain("alice@outlook.com");
    expect(list).not.toContain("half-removed@outlook.com");
  });
});

describe("validateMicrosoftAccountLabel", () => {
  it("accepts valid email-shaped labels", () => {
    expect(() => validateMicrosoftAccountLabel("alice@outlook.com")).not.toThrow();
    expect(() => validateMicrosoftAccountLabel("bob.smith@contoso.com")).not.toThrow();
    expect(() => validateMicrosoftAccountLabel("a@b.c")).not.toThrow();
  });

  it("rejects empty string", () => {
    expect(() => validateMicrosoftAccountLabel("")).toThrow(/non-empty/);
  });

  it("rejects path-traversal sequences", () => {
    expect(() => validateMicrosoftAccountLabel("../etc/passwd")).toThrow(/email shape/);
    expect(() => validateMicrosoftAccountLabel("alice@../escape.com")).toThrow(/email shape/);
  });

  it("rejects forward and back slashes", () => {
    expect(() => validateMicrosoftAccountLabel("alice/bob@outlook.com")).toThrow(/email shape/);
    expect(() => validateMicrosoftAccountLabel("alice\\bob@outlook.com")).toThrow(/email shape/);
  });

  it("rejects leading/trailing whitespace", () => {
    expect(() => validateMicrosoftAccountLabel(" alice@outlook.com")).toThrow(/whitespace/);
    expect(() => validateMicrosoftAccountLabel("alice@outlook.com\t")).toThrow(/whitespace/);
  });

  it("rejects colons (broker slot-key separator)", () => {
    expect(() => validateMicrosoftAccountLabel("alice:bob@outlook.com")).toThrow(/email shape/);
  });

  it("rejects null bytes", () => {
    expect(() => validateMicrosoftAccountLabel("alice\0@outlook.com")).toThrow(/control characters/);
  });

  it("rejects non-string input", () => {
    expect(() => validateMicrosoftAccountLabel(null as unknown as string)).toThrow(/non-empty/);
    expect(() => validateMicrosoftAccountLabel(42 as unknown as string)).toThrow(/non-empty/);
  });
});
