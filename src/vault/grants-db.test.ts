/**
 * Tests for the grants-DB opener (grants-db.ts) — durability path.
 *
 * Uses real on-disk SQLite files in an isolated tmpdir (the quarantine-and-
 * recreate behaviour is inherently about the on-disk file, so :memory: won't
 * exercise it).
 *
 * Covers:
 *   - a valid grants DB is opened untouched (no spurious quarantine)
 *   - a genuinely corrupt DB is quarantined to a timestamped .corrupt-* copy
 *     and a fresh, usable, empty DB is recreated in its place
 *   - the quarantined file is preserved (never deleted) for forensics
 *   - isGrantsDbCorruption only classifies SQLite corruption error classes
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Database } from "bun:sqlite";
import { openGrantsDb, isGrantsDbCorruption } from "./grants-db.js";
import { mintGrant, listGrants } from "./grants.js";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "grants-db-test-"));
  dbPath = path.join(tmpDir, "vault-grants.db");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("openGrantsDb — valid DB", () => {
  it("opens a fresh DB and preserves grants across reopen (no quarantine)", async () => {
    const db = openGrantsDb(dbPath);
    await mintGrant(db, "alice", ["svc/key"], 3600);
    db.close();

    const reopened = openGrantsDb(dbPath);
    expect(listGrants(reopened, "alice").length).toBe(1);
    reopened.close();

    // No corruption ⇒ no quarantine copy should exist.
    const quarantined = fs
      .readdirSync(tmpDir)
      .filter((f) => f.includes(".corrupt-"));
    expect(quarantined).toEqual([]);
  });
});

/**
 * Build a genuinely on-disk-corrupt SQLite file at `p`: create a real DB with
 * data, then overwrite interior page bytes so SQLite raises SQLITE_CORRUPT
 * ("database disk image is malformed") — the real signal for a damaged image,
 * as opposed to SQLITE_NOTADB (which we deliberately treat as recoverable).
 */
function writeCorruptDb(p: string): void {
  const seed = new Database(p, { create: true });
  seed.run("PRAGMA journal_mode=DELETE");
  seed.run("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
  for (let i = 0; i < 200; i++) {
    seed.run("INSERT INTO t (v) VALUES (?)", ["corrupt-marker-".repeat(6) + i]);
  }
  seed.close();
  const buf = fs.readFileSync(p);
  // Leave the header intact so it opens as a DB, but shred interior pages.
  for (let i = 2000; i < 6000 && i < buf.length; i++) buf[i] = 0xff;
  fs.writeFileSync(p, buf);
}

describe("openGrantsDb — corrupt DB", () => {
  it("quarantines a corrupt DB and recreates a fresh, usable one", async () => {
    writeCorruptDb(dbPath);
    const original = fs.readFileSync(dbPath);

    const db = openGrantsDb(dbPath);

    // The recreated DB must be empty and usable.
    expect(listGrants(db, "alice").length).toBe(0);
    await mintGrant(db, "alice", ["svc/key"], 3600);
    expect(listGrants(db, "alice").length).toBe(1);
    db.close();

    // The corrupt bytes must be preserved in a timestamped quarantine copy.
    const quarantined = fs
      .readdirSync(tmpDir)
      .filter((f) => f.startsWith("vault-grants.db.corrupt-"));
    expect(quarantined.length).toBe(1);
    const preserved = fs.readFileSync(path.join(tmpDir, quarantined[0]));
    expect(Buffer.compare(preserved, original)).toBe(0);
  });
});

describe("openGrantsDb — non-corruption failure", () => {
  it("propagates a non-corruption open error without touching the DB or quarantining", () => {
    // A pre-existing, VALID grants DB on disk. A NON-corruption failure from
    // the opener (e.g. EACCES, ENOSPC, or a recoverable NOTADB / missing-key
    // condition) must NOT trigger the destructive quarantine-and-recreate path.
    const seed = openGrantsDb(dbPath);
    seed.close();
    const original = fs.readFileSync(dbPath);

    const opError = Object.assign(new Error("permission denied"), {
      code: "EACCES",
    });
    let calls = 0;
    const throwingOpener = () => {
      calls += 1;
      throw opError;
    };

    expect(() => openGrantsDb(dbPath, throwingOpener)).toThrow(opError);

    // Opener called exactly once — no recreate attempt after a non-corruption
    // throw.
    expect(calls).toBe(1);

    // The original DB bytes are untouched.
    expect(Buffer.compare(fs.readFileSync(dbPath), original)).toBe(0);

    // No quarantine copy was created.
    const quarantined = fs
      .readdirSync(tmpDir)
      .filter((f) => f.includes(".corrupt-"));
    expect(quarantined).toEqual([]);
  });

  it("also does NOT quarantine on a NOTADB / recoverable key condition", () => {
    const seed = openGrantsDb(dbPath);
    seed.close();
    const original = fs.readFileSync(dbPath);

    const notAdb = Object.assign(
      new Error("file is encrypted or is not a database"),
      { code: "SQLITE_NOTADB" },
    );
    const throwingOpener = () => {
      throw notAdb;
    };

    expect(() => openGrantsDb(dbPath, throwingOpener)).toThrow(notAdb);
    expect(Buffer.compare(fs.readFileSync(dbPath), original)).toBe(0);
    const quarantined = fs
      .readdirSync(tmpDir)
      .filter((f) => f.includes(".corrupt-"));
    expect(quarantined).toEqual([]);
  });
});

describe("isGrantsDbCorruption", () => {
  it("classifies genuine on-disk corruption error classes as corruption", () => {
    expect(isGrantsDbCorruption({ code: "SQLITE_CORRUPT" })).toBe(true);
    expect(isGrantsDbCorruption({ code: "SQLITE_CORRUPT_VTAB" })).toBe(true);
    expect(
      isGrantsDbCorruption({ message: "database disk image is malformed" }),
    ).toBe(true);
    expect(isGrantsDbCorruption({ message: "database is corrupt" })).toBe(true);
  });

  it("does NOT classify NOTADB / recoverable key conditions as corruption", () => {
    // SQLITE_NOTADB from a wrong/missing encryption key is a recoverable
    // key-availability condition, not on-disk corruption — quarantining here
    // would wipe legitimate grants. It must be re-thrown, not quarantined.
    expect(isGrantsDbCorruption({ code: "SQLITE_NOTADB" })).toBe(false);
    expect(
      isGrantsDbCorruption({ message: "file is not a database" }),
    ).toBe(false);
    expect(
      isGrantsDbCorruption({
        code: "SQLITE_NOTADB",
        message: "file is encrypted or is not a database",
      }),
    ).toBe(false);
  });

  it("does NOT classify operational errors as corruption", () => {
    expect(isGrantsDbCorruption({ code: "EACCES", message: "permission denied" })).toBe(
      false,
    );
    expect(isGrantsDbCorruption({ code: "ENOSPC" })).toBe(false);
    expect(isGrantsDbCorruption(new Error("some unrelated failure"))).toBe(false);
    expect(isGrantsDbCorruption(null)).toBe(false);
    expect(isGrantsDbCorruption(undefined)).toBe(false);
  });
});
