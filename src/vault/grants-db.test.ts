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

describe("openGrantsDb — corrupt DB", () => {
  it("quarantines a corrupt DB and recreates a fresh, usable one", async () => {
    // Write garbage that is not a valid SQLite file, but has the tell-tale
    // header so it's opened as a DB and fails on first query.
    fs.writeFileSync(dbPath, "SQLite format 3\0" + "this-is-not-a-real-db".repeat(64));

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
    const preserved = fs.readFileSync(path.join(tmpDir, quarantined[0]), "utf8");
    expect(preserved).toContain("this-is-not-a-real-db");
  });
});

describe("isGrantsDbCorruption", () => {
  it("classifies SQLite corruption error codes as corruption", () => {
    expect(isGrantsDbCorruption({ code: "SQLITE_CORRUPT" })).toBe(true);
    expect(isGrantsDbCorruption({ code: "SQLITE_NOTADB" })).toBe(true);
    expect(
      isGrantsDbCorruption({ message: "database disk image is malformed" }),
    ).toBe(true);
    expect(
      isGrantsDbCorruption({ message: "file is not a database" }),
    ).toBe(true);
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
