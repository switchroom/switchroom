/**
 * Vault backup helpers (#1562 — vault backup/restore for future-proofing).
 *
 * Motivation (incident 2026-05-20): a non-hermetic broker test (now
 * fixed by #1560) corrupted the operator's live `~/.switchroom/vault/
 * vault.enc` on a shared production-treated host. Recovery worked only
 * because the May-11 vault-layout migration had preserved a
 * `vault.enc.divergent.bak` on disk — luck, not design. This module
 * makes that backup deliberate, dated, rotatable, and trackable in the
 * operator's existing private config repo.
 *
 * v1 scope (this file + the matching `switchroom vault backup` CLI verb):
 *   - Copy `~/.switchroom/vault/vault.enc` to a configured destination.
 *   - Dated filename `vault.enc.YYYYMMDD-HHMMSS.bak` (UTC, lex-sortable).
 *   - Rotation: keep last N (default 30).
 *   - Manifest: one JSONL row per backup with sha256 of the ciphertext
 *     (integrity-check without decrypt; encrypted blob, so safe to track
 *     in git or sync to private repo).
 *
 * v2 (separate design review) will add `vault restore` — deliberately
 * scoped out here because the reviewer raised three genuine
 * restore-safety questions (broker-quiesce mid-mint, force-flag
 * semantics, pre-restore-bak rotation) that deserve their own design
 * pass. Proven manual recovery (`cp <bak> vault/vault.enc + docker
 * restart broker`) still works today.
 *
 * Hard rules:
 *   - NEVER copies `~/.switchroom/vault-auto-unlock` (machine-bound; if
 *     leaked, gives the passphrase — and is useless off-host anyway).
 *   - NEVER copies the grants DB (`vault-broker/vault-grants.db`; per-agent
 *     grant tokens; different threat model).
 *   - REFUSES to write backups into a directory that already contains an
 *     `auto-unlock`-shaped sibling — defense-in-depth against an operator
 *     one day pointing `--to ~/.switchroom/` and bulk-syncing the
 *     whole dir.
 *   - Atomic tmp file lives INSIDE the destination dir (not inside
 *     `~/.switchroom/vault/`, which is the broker bind-mount validated
 *     by `apply.ts` against `KNOWN_VAULT_ARTIFACT_NAMES`).
 *
 * All path-resolution is a pure function of (config, env, fs-existence)
 * — testable without touching real `$HOME` (per the hermeticity lint
 * gate, #1561).
 */

import {
  createHash,
  randomBytes,
} from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";

/** Sentinel filename written next to every backup; pruning skips it. */
export const LATEST_SYMLINK = "vault.enc.latest.bak";

/** Manifest filename. */
export const MANIFEST_FILE = "manifest.jsonl";

/** Default rotation depth. */
export const DEFAULT_RETAIN = 30;

/** Filename prefix used by `computeBackupFilename` AND `listBackupFiles`. */
const FILENAME_PREFIX = "vault.enc.";
const FILENAME_SUFFIX = ".bak";

/** Filenames inside the destination dir that look like an auto-unlock blob.
 *  ANY match here causes `backup` to refuse, per the design-reviewer's
 *  defense-in-depth ask: never let an operator one-day point `--to` at a
 *  dir that also holds the machine-bound passphrase blob. */
const AUTO_UNLOCK_FILENAME_PATTERNS = [
  /auto-unlock/i,
  /^\.?vault-auto/i,
];

/** Whitelisted artifact names that may live next to a backup file in
 *  the destination dir without tripping the auto-unlock-sibling check.
 *  Symlink + manifest are produced by THIS module; pre-existing backup
 *  files are obviously fine. */
const KNOWN_BACKUP_DIR_ARTIFACTS: ReadonlySet<string> = new Set([
  LATEST_SYMLINK,
  MANIFEST_FILE,
  ".git",
  ".gitignore",
  "README.md",
]);

/** A single manifest row. JSONL: one row appended per `backup()`. */
export interface ManifestRow {
  /** ISO-8601 UTC. */
  ts: string;
  /** Basename only (no dir). */
  file: string;
  /** Byte size of the file. */
  size_bytes: number;
  /** Hex sha256 of the encrypted-vault file (= the .enc ciphertext as
   *  written — integrity check without decrypt). */
  sha256: string;
}

/** Result of a successful backup. */
export interface BackupResult {
  destDir: string;
  filename: string;
  fullPath: string;
  bytes: number;
  sha256: string;
  pruned: string[];
}

/** Compute the dated backup filename from a Date (UTC).
 *  Lex-sortable, distinct per second. */
export function computeBackupFilename(now: Date): string {
  const Y = now.getUTCFullYear().toString().padStart(4, "0");
  const M = (now.getUTCMonth() + 1).toString().padStart(2, "0");
  const D = now.getUTCDate().toString().padStart(2, "0");
  const h = now.getUTCHours().toString().padStart(2, "0");
  const m = now.getUTCMinutes().toString().padStart(2, "0");
  const s = now.getUTCSeconds().toString().padStart(2, "0");
  return `${FILENAME_PREFIX}${Y}${M}${D}-${h}${m}${s}${FILENAME_SUFFIX}`;
}

/** Match a backup filename and extract its timestamp segment (for sort).
 *  Returns null on non-matching names so callers can skip the symlink,
 *  manifest, README, etc., when listing backups for rotation. */
export function parseBackupFilename(name: string): string | null {
  if (!name.startsWith(FILENAME_PREFIX)) return null;
  if (!name.endsWith(FILENAME_SUFFIX)) return null;
  const inner = name.slice(FILENAME_PREFIX.length, -FILENAME_SUFFIX.length);
  if (!/^\d{8}-\d{6}$/.test(inner)) return null;
  return inner;
}

/** Validate that the file at `path` is a syntactically well-formed
 *  switchroom vault envelope (no decrypt — that needs the passphrase).
 *  Returns null on success, an explanation string on failure.
 *
 *  Same shape as `VaultFile` at src/vault/vault.ts:176-183 — kept
 *  duplicated here intentionally to avoid pulling in vault.ts's crypto
 *  dependencies, and because the validation surface for backup is
 *  intentionally narrower (we never re-encrypt, only memcpy). */
export function validateVaultEnvelopeFile(path: string): string | null {
  let buf: Buffer;
  try {
    buf = readFileSync(path);
  } catch (err) {
    return `cannot read ${path}: ${(err as Error).message}`;
  }
  if (buf.length === 0) {
    return `${path} is empty`;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(buf.toString("utf8"));
  } catch {
    return `${path} is not valid JSON (vault envelope is JSON)`;
  }
  if (!parsed || typeof parsed !== "object") {
    return `${path} is not a JSON object`;
  }
  const obj = parsed as Record<string, unknown>;
  for (const required of ["salt", "iv", "data", "tag"] as const) {
    if (typeof obj[required] !== "string" || (obj[required] as string).length === 0) {
      return `${path} is missing or empty required field '${required}'`;
    }
  }
  // kdf is optional (legacy vaults omit), but if present must shape-match.
  if (obj.kdf !== undefined) {
    const k = obj.kdf as Record<string, unknown>;
    if (typeof k.N !== "number" || typeof k.r !== "number" || typeof k.p !== "number") {
      return `${path} has malformed kdf field`;
    }
  }
  return null;
}

/** Inputs to `resolveBackupDestination`. Pure: caller provides everything,
 *  no real-fs / real-$HOME assumptions. Tests can construct any state. */
export interface ResolveDestinationInput {
  /** Result of the operator-supplied `--to` arg (highest precedence). */
  cliToFlag?: string;
  /** Result of `switchroom.yaml`'s `vault.backup.destination` setting. */
  configDestination?: string;
  /** Operator HOME (defaults to `os.homedir()`); injectable for tests. */
  home: string;
  /** Whether `<home>/.switchroom-config/` exists (= operator uses the
   *  private-config-repo pattern). Caller pre-resolves to keep this
   *  function pure. */
  hasSwitchroomConfigRepo: boolean;
}

/** Pick the backup destination directory.
 *
 *  Precedence (highest first):
 *    1. `--to` CLI flag
 *    2. `vault.backup.destination` config setting
 *    3. `<home>/.switchroom-config/vault-backups/` if that config repo
 *       exists (operator's existing private-repo pattern)
 *    4. `<home>/.switchroom/vault-backups/` fallback
 *
 *  Path is resolved (no `~` expansion needed — caller passes `home`).
 *  Pure: returns the chosen path; does NOT create the directory. */
export function resolveBackupDestination(input: ResolveDestinationInput): string {
  if (input.cliToFlag) return resolvePath(input.cliToFlag);
  if (input.configDestination) return resolvePath(input.configDestination);
  if (input.hasSwitchroomConfigRepo) {
    return join(input.home, ".switchroom-config", "vault-backups");
  }
  return join(input.home, ".switchroom", "vault-backups");
}

/** Defense-in-depth: refuse to write into a dir that contains an
 *  auto-unlock-shaped sibling. Pure: takes a list of filenames (caller
 *  reads the directory), returns null on safe or an offending name on
 *  unsafe. The check considers only direct children, not subdirs. */
export function findAutoUnlockSibling(
  entries: string[],
): string | null {
  for (const name of entries) {
    if (KNOWN_BACKUP_DIR_ARTIFACTS.has(name)) continue;
    if (AUTO_UNLOCK_FILENAME_PATTERNS.some((re) => re.test(name))) {
      return name;
    }
  }
  return null;
}

/** Compute the list of pruning victims given a sorted-newest-first list
 *  of backup filenames and a retain budget. Pure. */
export function selectBackupsToPrune(
  sortedNewestFirst: string[],
  retain: number,
): string[] {
  if (retain < 0) throw new Error("retain must be >= 0");
  return sortedNewestFirst.slice(retain);
}

/** List backup files in `dir`, sorted newest-first. Tolerates a
 *  non-existent dir (returns []). */
export function listBackupFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((n) => parseBackupFilename(n) !== null)
    .sort((a, b) => {
      const ka = parseBackupFilename(a)!;
      const kb = parseBackupFilename(b)!;
      return kb.localeCompare(ka);
    });
}

/** SHA-256 of a file's contents. Streaming would be lower-memory but
 *  vault.enc is ~40 KB; a single read is simpler and the API is sync. */
export function sha256OfFile(path: string): string {
  const h = createHash("sha256");
  h.update(readFileSync(path));
  return h.digest("hex");
}

/** Perform the backup. IO orchestrator over the pure helpers above. */
export function backupVault(opts: {
  vaultPath: string;
  destDir: string;
  retain?: number;
  now?: Date;
}): BackupResult {
  const now = opts.now ?? new Date();
  const retain = opts.retain ?? DEFAULT_RETAIN;

  // 1. Validate the source is a real vault envelope before we copy
  //    anything — better to fail fast than write a corrupt backup.
  const validationError = validateVaultEnvelopeFile(opts.vaultPath);
  if (validationError) {
    throw new Error(
      `vault backup refused: source is not a valid vault envelope: ${validationError}`,
    );
  }

  // 2. Ensure destination dir exists with strict perms (0700).
  mkdirSync(opts.destDir, { recursive: true, mode: 0o700 });

  // 3. Defense-in-depth: scan dir for an auto-unlock-shaped sibling.
  //    If any non-whitelisted, non-backup file matches the pattern,
  //    refuse — the operator is about to commit the machine-bound
  //    passphrase blob into version control.
  const dirEntries = readdirSync(opts.destDir);
  const offender = findAutoUnlockSibling(dirEntries);
  if (offender) {
    throw new Error(
      `vault backup refused: destination '${opts.destDir}' contains a file ` +
      `that looks like an auto-unlock credential ('${offender}'). The ` +
      `machine-bound auto-unlock blob MUST NOT be co-located with the ` +
      `encrypted vault — if they're together in version control, the ` +
      `passphrase gate is bypassed. Move/remove that file and retry.`,
    );
  }

  // 4. Atomic write into the destination dir (tmp source MUST be in the
  //    dest dir, NOT in ~/.switchroom/vault/ — that's the broker
  //    bind-mount validated by `apply.ts` against KNOWN_VAULT_ARTIFACT_NAMES).
  const filename = computeBackupFilename(now);
  const fullPath = join(opts.destDir, filename);
  const tmpName = `.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
  const tmpPath = join(opts.destDir, tmpName);

  // Copy + fsync + rename. Read source, write atomic tmp, fsync, rename.
  const src = readFileSync(opts.vaultPath);
  const fd = openSync(tmpPath, "wx", 0o600);
  try {
    writeSync(fd, src);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  // Refuse on sub-second collision: two backups in the same UTC second
  // would otherwise silently overwrite each other (renameSync replaces
  // an existing target with no warning) while the manifest appends two
  // rows pointing at the same filename with different sha256s — confusing
  // and a silent data-loss path. Operator-facing error tells them to
  // retry in 1s. Sub-second backup invocations only happen with concurrent
  // operator scripts; daily-cron usage never hits this.
  if (existsSync(fullPath)) {
    try { unlinkSync(tmpPath); } catch { /* tolerate cleanup failure */ }
    throw new Error(
      `vault backup refused: '${fullPath}' already exists ` +
      `(sub-second collision with another backup). Retry in 1 second, ` +
      `or check for a concurrent backup process.`,
    );
  }
  renameSync(tmpPath, fullPath);
  const stat = statSync(fullPath);
  const sha256 = sha256OfFile(fullPath);

  // 5. Manifest row.
  const row: ManifestRow = {
    ts: now.toISOString(),
    file: filename,
    size_bytes: stat.size,
    sha256,
  };
  appendFileSync(join(opts.destDir, MANIFEST_FILE), JSON.stringify(row) + "\n", { mode: 0o600 });

  // 6. Update the "latest" symlink for convenience.
  const latestPath = join(opts.destDir, LATEST_SYMLINK);
  try { unlinkSync(latestPath); } catch { /* not present */ }
  try { symlinkSync(filename, latestPath); } catch { /* best-effort */ }

  // 7. Durability: fsync the destination directory so the new dirent
  //    (the backup file, the manifest entry update, the new symlink) is
  //    persisted to stable storage. WITHOUT this, POSIX permits the
  //    kernel to defer the directory-entry write — a host crash
  //    post-rename can lose the backup file even though renameSync
  //    returned. For a feature whose raison d'être is "don't lose the
  //    vault on incident", this is load-bearing. One fsync at the end
  //    is sufficient: it makes ALL changes-to-this-dir-since-last-fsync
  //    durable atomically.
  try {
    const dirFd = openSync(opts.destDir, "r");
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } catch {
    // Best-effort: some filesystems (FAT, tmpfs in some configs) refuse
    // fsync on directories. Don't fail the backup if the fs doesn't
    // support it — the file is still written; durability is degraded
    // but not catastrophically lost.
  }

  // 8. Rotate.
  const sorted = listBackupFiles(opts.destDir);
  const pruneNames = selectBackupsToPrune(sorted, retain);
  for (const old of pruneNames) {
    try { unlinkSync(join(opts.destDir, old)); } catch { /* tolerate */ }
  }
  // Fsync again after pruning so the unlinks are durable. Same best-effort.
  if (pruneNames.length > 0) {
    try {
      const dirFd = openSync(opts.destDir, "r");
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    } catch { /* best-effort */ }
  }

  return {
    destDir: opts.destDir,
    filename,
    fullPath,
    bytes: stat.size,
    sha256,
    pruned: pruneNames,
  };
}

/** Convenience: read manifest as an array (for `vault backup list` UI
 *  in v2, and for tests). Returns rows in append-order. */
export function readManifest(destDir: string): ManifestRow[] {
  const p = join(destDir, MANIFEST_FILE);
  if (!existsSync(p)) return [];
  const lines = readFileSync(p, "utf8").split("\n").filter((l) => l.length > 0);
  const out: ManifestRow[] = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line) as ManifestRow);
    } catch {
      // tolerate a corrupt line — best-effort; the file is operator-readable
      // and a corrupt row is recoverable by hand.
    }
  }
  return out;
}

/** Default `home` resolution for non-test callers — extracted so tests
 *  can construct `ResolveDestinationInput` without touching real $HOME. */
export function defaultHome(): string {
  return process.env.HOME ?? homedir();
}

