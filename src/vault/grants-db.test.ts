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
import {
  openGrantsDb,
  isGrantsDbCorruption,
  migrateLegacyGrantsDbLocation,
  getGrantsDbPath,
  getGrantsDbDir,
  getLegacyGrantsDbPath,
} from "./grants-db.js";
import { mintGrant, listGrants, revokeGrant } from "./grants.js";

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

describe("migrateLegacyGrantsDbLocation — #3289 WAL-durability relocation", () => {
  // Treat tmpDir as a fake $HOME. Legacy DB sits at <home>/.switchroom/
  // vault-grants.db; the new location is <home>/.switchroom/vault-broker/
  // vault-grants.db.
  it("moves the legacy DB (and its WAL sidecars) into the dedicated dir, preserving grants", async () => {
    const home = tmpDir;
    const legacyPath = getLegacyGrantsDbPath(getGrantsDbPath(home));
    const newPath = getGrantsDbPath(home);
    expect(legacyPath).toBe(path.join(home, ".switchroom", "vault-grants.db"));

    // Seed a populated legacy DB. openGrantsDb(legacyPath) is a no-op-migrate
    // (its computed legacy-of-legacy doesn't exist), so it just opens+seeds.
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    const seed = openGrantsDb(legacyPath);
    await mintGrant(seed, "alice", ["svc/key"], 3600);
    seed.close();
    // Simulate an un-checkpointed WAL sidecar left beside the legacy file.
    fs.writeFileSync(`${legacyPath}-wal`, "wal-bytes");
    fs.writeFileSync(`${legacyPath}-shm`, "shm-bytes");

    const res = migrateLegacyGrantsDbLocation(newPath);
    expect(res.migrated).toBe(true);
    expect(res.from).toBe(legacyPath);
    expect(res.to).toBe(newPath);

    // Legacy main + sidecars gone; new main + sidecars present.
    expect(fs.existsSync(legacyPath)).toBe(false);
    expect(fs.existsSync(`${legacyPath}-wal`)).toBe(false);
    expect(fs.existsSync(`${legacyPath}-shm`)).toBe(false);
    expect(fs.existsSync(newPath)).toBe(true);
    expect(fs.existsSync(`${newPath}-wal`)).toBe(true);
    expect(fs.readFileSync(`${newPath}-wal`, "utf8")).toBe("wal-bytes");

    // The relocated DB still holds the grant.
    const reopened = openGrantsDb(newPath);
    expect(listGrants(reopened, "alice").length).toBe(1);
    reopened.close();
  });

  it("is a no-op on greenfield (no legacy file)", () => {
    const home = tmpDir;
    const res = migrateLegacyGrantsDbLocation(getGrantsDbPath(home));
    expect(res.migrated).toBe(false);
    expect(fs.existsSync(getGrantsDbPath(home))).toBe(false);
  });

  it("is a no-op when the new DB already exists (already migrated)", async () => {
    const home = tmpDir;
    const legacyPath = getLegacyGrantsDbPath(getGrantsDbPath(home));
    const newPath = getGrantsDbPath(home);

    // Seed the live NEW DB first (no legacy present yet, so no auto-migrate),
    // THEN drop a stale legacy file beside it — the "already migrated but the
    // old file was never cleaned up" state.
    const live = openGrantsDb(newPath);
    await mintGrant(live, "bob", ["svc/key"], 3600);
    live.close();
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, "legacy-bytes");

    const res = migrateLegacyGrantsDbLocation(newPath);
    expect(res.migrated).toBe(false);
    // Legacy untouched, new DB intact.
    expect(fs.existsSync(legacyPath)).toBe(true);
    const reopened = openGrantsDb(newPath);
    expect(listGrants(reopened, "bob").length).toBe(1);
    reopened.close();
  });

  it("openGrantsDb auto-migrates a legacy DB on first boot at the new path", async () => {
    const home = tmpDir;
    const legacyPath = getLegacyGrantsDbPath(getGrantsDbPath(home));
    const newPath = getGrantsDbPath(home);

    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    const seed = openGrantsDb(legacyPath);
    await mintGrant(seed, "carol", ["svc/key"], 3600);
    seed.close();

    // Boot the broker against the NEW path — it should relocate the legacy DB.
    const db = openGrantsDb(newPath);
    expect(listGrants(db, "carol").length).toBe(1);
    db.close();
    expect(fs.existsSync(legacyPath)).toBe(false);
    expect(fs.existsSync(newPath)).toBe(true);
  });

  it("aborts with the legacy pair INTACT when a -wal sidecar move fails (M1)", () => {
    const home = tmpDir;
    const legacyPath = getLegacyGrantsDbPath(getGrantsDbPath(home));
    const newPath = getGrantsDbPath(home);

    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, "main-bytes");
    fs.writeFileSync(`${legacyPath}-wal`, "wal-bytes");
    fs.writeFileSync(`${legacyPath}-shm`, "shm-bytes");

    // Force the -shm move to fail AFTER the -wal already moved, so the
    // rollback path is exercised too.
    const failingRename = (from: string, to: string) => {
      if (from.endsWith("-shm") && to.startsWith(path.dirname(newPath))) {
        throw Object.assign(new Error("EXDEV: cross-device link"), {
          code: "EXDEV",
        });
      }
      fs.renameSync(from, to);
    };

    expect(() =>
      migrateLegacyGrantsDbLocation(newPath, { rename: failingRename }),
    ).toThrow(/failed to move WAL sidecar/);

    // The legacy main + BOTH sidecars must still be intact (the -wal that
    // moved first was rolled back), and nothing landed at the new main path.
    expect(fs.readFileSync(legacyPath, "utf8")).toBe("main-bytes");
    expect(fs.readFileSync(`${legacyPath}-wal`, "utf8")).toBe("wal-bytes");
    expect(fs.readFileSync(`${legacyPath}-shm`, "utf8")).toBe("shm-bytes");
    expect(fs.existsSync(newPath)).toBe(false);
    expect(fs.existsSync(`${newPath}-wal`)).toBe(false);

    // And a plain retry (no failure injection) completes the migration —
    // committed WAL bytes travel with the main file.
    const res = migrateLegacyGrantsDbLocation(newPath);
    expect(res.migrated).toBe(true);
    expect(fs.readFileSync(`${newPath}-wal`, "utf8")).toBe("wal-bytes");
  });

  it("treats losing the main-rename race to a concurrent migrator as already-migrated (L1)", () => {
    const home = tmpDir;
    const legacyPath = getLegacyGrantsDbPath(getGrantsDbPath(home));
    const newPath = getGrantsDbPath(home);

    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, "main-bytes");

    // Simulate the TOCTOU: between the existsSync gates and the main rename,
    // a concurrent migrator (broker boot) moves the file itself. Our rename
    // then throws ENOENT — but the new path exists and the legacy is gone.
    const racingRename = (from: string, to: string) => {
      if (from === legacyPath) {
        fs.renameSync(legacyPath, newPath); // the "other" migrator wins
        throw Object.assign(new Error("ENOENT: no such file or directory"), {
          code: "ENOENT",
        });
      }
      fs.renameSync(from, to);
    };

    const res = migrateLegacyGrantsDbLocation(newPath, {
      rename: racingRename,
    });
    expect(res.migrated).toBe(false);
    expect(fs.existsSync(newPath)).toBe(true);
    expect(fs.readFileSync(newPath, "utf8")).toBe("main-bytes");
    expect(fs.existsSync(legacyPath)).toBe(false);
  });

  it("rethrows a GENUINE main-rename failure and rolls the sidecars back (L1 guard is not a blanket swallow)", () => {
    const home = tmpDir;
    const legacyPath = getLegacyGrantsDbPath(getGrantsDbPath(home));
    const newPath = getGrantsDbPath(home);

    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, "main-bytes");
    fs.writeFileSync(`${legacyPath}-wal`, "wal-bytes");

    const failingMainRename = (from: string, to: string) => {
      if (from === legacyPath) {
        throw Object.assign(new Error("EACCES: permission denied"), {
          code: "EACCES",
        });
      }
      fs.renameSync(from, to);
    };

    expect(() =>
      migrateLegacyGrantsDbLocation(newPath, { rename: failingMainRename }),
    ).toThrow(/EACCES/);

    // Sidecar rolled back beside the untouched legacy main.
    expect(fs.readFileSync(legacyPath, "utf8")).toBe("main-bytes");
    expect(fs.readFileSync(`${legacyPath}-wal`, "utf8")).toBe("wal-bytes");
    expect(fs.existsSync(newPath)).toBe(false);
    expect(fs.existsSync(`${newPath}-wal`)).toBe(false);
  });
});

describe("grants durability — survives simulated container recreate", () => {
  it("grants persist when the DB is reopened from the persisted directory only", async () => {
    const home = tmpDir;
    const newPath = getGrantsDbPath(home);

    const db = openGrantsDb(newPath);
    const { id } = await mintGrant(db, "alice", ["svc/key"], 3600);
    db.close();

    // Simulate a container recreate: everything ephemeral is discarded; only
    // the bind-mounted directory (getGrantsDbDir) survives. Assert the file
    // lives under that directory and reopening from it alone recovers the grant.
    expect(path.dirname(newPath)).toBe(getGrantsDbDir(home));
    expect(fs.existsSync(newPath)).toBe(true);

    const reopened = openGrantsDb(newPath);
    const grants = listGrants(reopened, "alice");
    expect(grants.length).toBe(1);
    expect(grants[0].id).toBe(id);
    reopened.close();
  });

  it("checkpoint-after-mutation leaves the MAIN db file current (no grant stranded in WAL)", async () => {
    const home = tmpDir;
    const newPath = getGrantsDbPath(home);

    const db = openGrantsDb(newPath);
    await mintGrant(db, "alice", ["svc/key"], 3600);

    // Copy ONLY the main DB file (not the -wal/-shm sidecars) to a fresh path
    // and open it. If the checkpoint-after-mutation defense did not run, the
    // grant would live only in the -wal and this main-file-only copy would be
    // empty. A present grant proves the main file is current.
    const copyPath = path.join(tmpDir, "main-only-copy.db");
    fs.copyFileSync(newPath, copyPath);
    db.close();

    const copy = new Database(copyPath, { readonly: true });
    try {
      const rows = copy
        .query("SELECT id FROM vault_grants WHERE agent_slug = 'alice'")
        .all();
      expect(rows.length).toBe(1);
    } finally {
      copy.close();
    }

    // The live WAL sidecar, if present, must be truncated (0 bytes) after the
    // TRUNCATE checkpoint.
    const walPath = `${newPath}-wal`;
    if (fs.existsSync(walPath)) {
      expect(fs.statSync(walPath).size).toBe(0);
    }
  });

  it("revoke is also checkpointed into the main file", async () => {
    const home = tmpDir;
    const newPath = getGrantsDbPath(home);
    const db = openGrantsDb(newPath);
    const { id } = await mintGrant(db, "alice", ["svc/key"], 3600);
    expect(revokeGrant(db, id)).toBe(true);

    const copyPath = path.join(tmpDir, "after-revoke-copy.db");
    fs.copyFileSync(newPath, copyPath);
    db.close();

    const copy = new Database(copyPath, { readonly: true });
    try {
      const row = copy
        .query("SELECT revoked_at FROM vault_grants WHERE id = ?")
        .get(id) as { revoked_at: number | null } | undefined;
      expect(row).toBeTruthy();
      expect(row!.revoked_at).not.toBeNull();
    } finally {
      copy.close();
    }
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
