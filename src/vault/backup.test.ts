/**
 * Unit tests for vault backup helpers (#1562).
 *
 * Hermetic per the gate at #1561: every IO test uses a tmpdir and sets
 * `process.env.HOME = tmpDir` BEFORE invoking any backup function, so
 * `os.homedir()`-derived paths resolve into the tmpdir.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  backupVault,
  computeBackupFilename,
  defaultHome,
  findAutoUnlockSibling,
  LATEST_SYMLINK,
  listBackupFiles,
  MANIFEST_FILE,
  parseBackupFilename,
  readManifest,
  resolveBackupDestination,
  selectBackupsToPrune,
  validateVaultEnvelopeFile,
} from "./backup.js";

const VALID_VAULT_JSON = JSON.stringify({
  salt: "0123456789abcdef0123456789abcdef",
  iv: "0123456789ab0123456789ab",
  data: "deadbeefcafe1234",
  tag: "fedcba9876543210fedcba9876543210",
  kdf: { N: 32768, r: 8, p: 1 },
});

describe("computeBackupFilename", () => {
  it("renders UTC date+time, lex-sortable", () => {
    // Use UTC explicitly so the test is timezone-independent
    const t = new Date(Date.UTC(2026, 4, 20, 8, 9, 4));
    expect(computeBackupFilename(t)).toBe("vault.enc.20260520-080904.bak");
  });

  it("pads single-digit components", () => {
    const t = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
    expect(computeBackupFilename(t)).toBe("vault.enc.20260101-000000.bak");
  });
});

describe("parseBackupFilename", () => {
  it("accepts the canonical shape", () => {
    expect(parseBackupFilename("vault.enc.20260520-080904.bak")).toBe("20260520-080904");
  });
  it("rejects the manifest, symlink, and unrelated files", () => {
    expect(parseBackupFilename("manifest.jsonl")).toBe(null);
    expect(parseBackupFilename("vault.enc.latest.bak")).toBe(null);
    expect(parseBackupFilename("vault.enc.divergent.bak")).toBe(null); // migration's bak, not ours
    expect(parseBackupFilename("README.md")).toBe(null);
  });
  it("rejects malformed dates", () => {
    expect(parseBackupFilename("vault.enc.notadate.bak")).toBe(null);
    expect(parseBackupFilename("vault.enc.2026-05-20-080904.bak")).toBe(null); // wrong separator
  });
});

describe("validateVaultEnvelopeFile", () => {
  let dir: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vault-backup-validate-"));
    prevHome = process.env.HOME;
    process.env.HOME = dir;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(dir, { recursive: true, force: true });
  });

  it("accepts a well-formed envelope", () => {
    const p = join(dir, "v.enc");
    writeFileSync(p, VALID_VAULT_JSON);
    expect(validateVaultEnvelopeFile(p)).toBe(null);
  });

  it("rejects an empty file", () => {
    const p = join(dir, "v.enc");
    writeFileSync(p, "");
    expect(validateVaultEnvelopeFile(p)).toMatch(/empty/i);
  });

  it("rejects non-JSON", () => {
    const p = join(dir, "v.enc");
    writeFileSync(p, "garbage");
    expect(validateVaultEnvelopeFile(p)).toMatch(/JSON/);
  });

  it("rejects JSON missing required fields", () => {
    const p = join(dir, "v.enc");
    writeFileSync(p, JSON.stringify({ salt: "x", iv: "y" })); // no data/tag
    expect(validateVaultEnvelopeFile(p)).toMatch(/missing or empty required field/);
  });

  it("rejects a malformed kdf field", () => {
    const p = join(dir, "v.enc");
    writeFileSync(p, JSON.stringify({
      salt: "x", iv: "y", data: "z", tag: "t", kdf: { N: "not-a-number", r: 8, p: 1 },
    }));
    expect(validateVaultEnvelopeFile(p)).toMatch(/malformed kdf/);
  });

  it("rejects nonexistent file with the underlying error", () => {
    expect(validateVaultEnvelopeFile(join(dir, "nope"))).toMatch(/cannot read/);
  });
});

describe("resolveBackupDestination (pure)", () => {
  it("--to flag wins absolutely", () => {
    expect(resolveBackupDestination({
      cliToFlag: "/explicit/path",
      configDestination: "/cfg",
      home: "/h",
      hasSwitchroomConfigRepo: true,
    })).toBe("/explicit/path");
  });

  it("config destination wins over defaults when no --to", () => {
    expect(resolveBackupDestination({
      configDestination: "/cfg/place",
      home: "/h",
      hasSwitchroomConfigRepo: true,
    })).toBe("/cfg/place");
  });

  it("falls back to ~/.switchroom-config/vault-backups/ when that repo exists", () => {
    expect(resolveBackupDestination({
      home: "/home/op",
      hasSwitchroomConfigRepo: true,
    })).toBe("/home/op/.switchroom-config/vault-backups");
  });

  it("falls back to ~/.switchroom/vault-backups/ when no config repo", () => {
    expect(resolveBackupDestination({
      home: "/home/op",
      hasSwitchroomConfigRepo: false,
    })).toBe("/home/op/.switchroom/vault-backups");
  });
});

describe("findAutoUnlockSibling (defense-in-depth)", () => {
  it("returns null on an empty dir listing", () => {
    expect(findAutoUnlockSibling([])).toBe(null);
  });

  it("returns null on only backup files + known artifacts", () => {
    expect(findAutoUnlockSibling([
      "vault.enc.20260520-080904.bak",
      "vault.enc.20260520-093000.bak",
      "manifest.jsonl",
      "vault.enc.latest.bak",
      "README.md",
      ".git",
      ".gitignore",
    ])).toBe(null);
  });

  it("flags a vault-auto-unlock file", () => {
    expect(findAutoUnlockSibling(["vault-auto-unlock"])).toBe("vault-auto-unlock");
  });

  it("flags any 'auto-unlock' substring (case-insensitive)", () => {
    expect(findAutoUnlockSibling(["Auto-Unlock.bin"])).toBe("Auto-Unlock.bin");
    expect(findAutoUnlockSibling(["fleet.auto-unlock.creds"])).toBe("fleet.auto-unlock.creds");
  });

  it("flags a dotfile auto-unlock variant", () => {
    expect(findAutoUnlockSibling([".vault-auto"])).toBe(".vault-auto");
  });
});

describe("selectBackupsToPrune", () => {
  it("returns nothing when count <= retain", () => {
    expect(selectBackupsToPrune(["a", "b"], 30)).toEqual([]);
    expect(selectBackupsToPrune(["a", "b"], 2)).toEqual([]);
  });
  it("prunes the oldest beyond retain (input is newest-first)", () => {
    const xs = ["new3", "new2", "new1", "old3", "old2", "old1"];
    expect(selectBackupsToPrune(xs, 3)).toEqual(["old3", "old2", "old1"]);
  });
  it("retain=0 prunes everything", () => {
    expect(selectBackupsToPrune(["a", "b", "c"], 0)).toEqual(["a", "b", "c"]);
  });
  it("throws on negative retain", () => {
    expect(() => selectBackupsToPrune([], -1)).toThrow();
  });
});

describe("backupVault (IO orchestrator)", () => {
  let dir: string;
  let vaultPath: string;
  let destDir: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vault-backup-io-"));
    prevHome = process.env.HOME;
    process.env.HOME = dir; // hermetic per #1561

    // Lay out a fake ~/.switchroom/vault/vault.enc + a backup dest dir.
    const switchroomDir = join(dir, ".switchroom");
    mkdirSync(join(switchroomDir, "vault"), { recursive: true, mode: 0o700 });
    vaultPath = join(switchroomDir, "vault", "vault.enc");
    writeFileSync(vaultPath, VALID_VAULT_JSON, { mode: 0o600 });

    destDir = join(dir, "backups");
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes a dated backup + symlink + manifest row", () => {
    const fixedNow = new Date(Date.UTC(2026, 4, 20, 8, 9, 4));
    const r = backupVault({ vaultPath, destDir, now: fixedNow });

    expect(r.filename).toBe("vault.enc.20260520-080904.bak");
    expect(existsSync(r.fullPath)).toBe(true);
    expect(readFileSync(r.fullPath, "utf8")).toBe(VALID_VAULT_JSON);

    // Manifest row
    const rows = readManifest(destDir);
    expect(rows).toHaveLength(1);
    expect(rows[0].file).toBe(r.filename);
    expect(rows[0].size_bytes).toBe(statSync(r.fullPath).size);
    expect(rows[0].sha256).toMatch(/^[0-9a-f]{64}$/);

    // Symlink
    expect(existsSync(join(destDir, LATEST_SYMLINK))).toBe(true);
  });

  it("refuses if source is not a valid envelope", () => {
    writeFileSync(vaultPath, "not json");
    expect(() => backupVault({ vaultPath, destDir })).toThrow(/not a valid vault envelope/);
    // and didn't create the dest dir on a refusal? — actually we DO mkdir the
    // dest first (idempotent), so just assert no .bak landed:
    expect(listBackupFiles(destDir)).toEqual([]);
  });

  it("refuses if destination contains an auto-unlock sibling", () => {
    mkdirSync(destDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(destDir, "vault-auto-unlock"), "machine-bound-blob-here");
    expect(() => backupVault({ vaultPath, destDir })).toThrow(/auto-unlock credential/);
    expect(listBackupFiles(destDir)).toEqual([]); // no backup written
  });

  it("rotates beyond retain budget (oldest pruned)", () => {
    // Lay 5 backups; retain=2.
    for (let h = 0; h < 5; h++) {
      const t = new Date(Date.UTC(2026, 4, 20, h, 0, 0));
      backupVault({ vaultPath, destDir, now: t, retain: 99 });
    }
    expect(listBackupFiles(destDir)).toHaveLength(5);

    // Now do one more with retain=2 → keep 2 newest, prune 4 older.
    const r = backupVault({
      vaultPath, destDir,
      now: new Date(Date.UTC(2026, 4, 20, 10, 0, 0)),
      retain: 2,
    });
    const remaining = listBackupFiles(destDir);
    expect(remaining).toHaveLength(2);
    // newest-first: the just-written one + the previous-newest
    expect(remaining[0]).toBe(r.filename);
    expect(r.pruned.length).toBeGreaterThan(0);
  });

  it("manifest accumulates across multiple backups", () => {
    backupVault({ vaultPath, destDir, now: new Date(Date.UTC(2026, 4, 20, 1, 0, 0)) });
    backupVault({ vaultPath, destDir, now: new Date(Date.UTC(2026, 4, 20, 2, 0, 0)) });
    backupVault({ vaultPath, destDir, now: new Date(Date.UTC(2026, 4, 20, 3, 0, 0)) });
    const rows = readManifest(destDir);
    expect(rows).toHaveLength(3);
  });

  it("atomic tmp file does NOT live inside ~/.switchroom/vault/ (apply.ts safety)", () => {
    // After a backup, the broker bind-mount dir must contain ONLY
    // vault.enc + nothing else. The atomic tmp lives in destDir.
    backupVault({ vaultPath, destDir });
    const vaultDirEntries = readdirSync(join(dir, ".switchroom", "vault"));
    expect(vaultDirEntries).toEqual(["vault.enc"]);
  });

  it("destination dir gets mode 0700 on creation", () => {
    backupVault({ vaultPath, destDir });
    expect(statSync(destDir).mode & 0o777).toBe(0o700);
  });
});

describe("defaultHome", () => {
  // The function returns process.env.HOME (if set) or os.homedir().
  // This test just pins that contract — used by the CLI to construct
  // ResolveDestinationInput without re-reaching for the env each time.
  it("returns process.env.HOME when set", () => {
    const prev = process.env.HOME;
    process.env.HOME = "/tmp/forced-home";
    try {
      expect(defaultHome()).toBe("/tmp/forced-home");
    } finally {
      if (prev === undefined) delete process.env.HOME;
      else process.env.HOME = prev;
    }
  });
});
