/**
 * Security-hardening pins for the Anthropic account store (2026-07-11 review).
 *
 *   - F2: credential/meta writes MUST route through the shared hardened atomic
 *     primitive (`../util/atomic.js:atomicWriteJsonSync`) — fsync +
 *     O_NOFOLLOW|O_EXCL tempfile open — instead of the old local
 *     `writeFileSync('w') + rename` (no fsync, followed symlinks, no O_EXCL).
 *   - F5: account dirs MUST be created 0700 (not the default ~0755), so a
 *     co-resident local UID can't traverse to the OAuth-secret inodes.
 *
 * The atomic primitive's own no-symlink-follow guarantee is proven in
 * `src/util/atomic.test.ts`; here we prove the account store ROUTES through it
 * (bites a revert of F2) and that the dir mode is 0700 (bites a revert of F5).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Wrap the hardened primitive so we can assert the account store calls it,
// while still delegating to the REAL implementation (so file contents, mode,
// and symlink-safety behaviour are exercised for real).
vi.mock("../util/atomic.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../util/atomic.js")>();
  return { ...actual, atomicWriteJsonSync: vi.fn(actual.atomicWriteJsonSync) };
});

import { atomicWriteJsonSync } from "../util/atomic.js";
import {
  writeAccountCredentials,
  writeAccountMeta,
  accountDir,
  accountCredentialsPath,
} from "./account-store.js";

const CREDS = {
  claudeAiOauth: {
    accessToken: "at",
    refreshToken: "rt",
    expiresAt: Date.now() + 3_600_000,
  },
};

describe("account-store hardening (sec F2/F5)", () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(join(tmpdir(), "acct-store-hardening-"));
    vi.mocked(atomicWriteJsonSync).mockClear();
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("F5: account dir is created 0700 on credential write", () => {
    writeAccountCredentials("acct@example.com", CREDS, home);
    const mode = fs.statSync(accountDir("acct@example.com", home)).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it("F5: account dir is created 0700 on meta write", () => {
    writeAccountMeta("m@example.com", { createdAt: Date.now() }, home);
    const mode = fs.statSync(accountDir("m@example.com", home)).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it("F2: credential write routes through the hardened atomicWriteJsonSync", () => {
    writeAccountCredentials("s@example.com", CREDS, home);
    expect(vi.mocked(atomicWriteJsonSync)).toHaveBeenCalled();
    expect(vi.mocked(atomicWriteJsonSync).mock.calls[0]![0]).toBe(
      accountCredentialsPath("s@example.com", home),
    );
  });

  it("F2: meta write routes through the hardened atomicWriteJsonSync", () => {
    writeAccountMeta("m2@example.com", { createdAt: Date.now() }, home);
    expect(vi.mocked(atomicWriteJsonSync)).toHaveBeenCalled();
  });

  it("F2: credentials.json lands at 0600, a real file, no tempfile leak", () => {
    writeAccountCredentials("f@example.com", CREDS, home);
    const p = accountCredentialsPath("f@example.com", home);
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
    expect(fs.lstatSync(p).isSymbolicLink()).toBe(false);
    const leaks = fs
      .readdirSync(accountDir("f@example.com", home))
      .filter((n) => n.includes(".tmp-"));
    expect(leaks).toHaveLength(0);
  });

  it("F2: a symlink pre-planted at credentials.json is NOT written through", () => {
    const dir = accountDir("v@example.com", home);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const victim = join(home, "victim-secret");
    fs.writeFileSync(victim, "UNTOUCHED");
    const dest = accountCredentialsPath("v@example.com", home);
    fs.symlinkSync(victim, dest);

    writeAccountCredentials("v@example.com", CREDS, home);

    // rename(2) replaced the symlink with a real file; the victim the symlink
    // pointed at was never written through.
    expect(fs.readFileSync(victim, "utf8")).toBe("UNTOUCHED");
    expect(fs.lstatSync(dest).isSymbolicLink()).toBe(false);
    expect(JSON.parse(fs.readFileSync(dest, "utf8")).claudeAiOauth.accessToken).toBe("at");
  });
});
