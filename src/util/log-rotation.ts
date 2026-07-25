/**
 * log-rotation — one size-based rotation primitive for every append-only
 * log this codebase owns.
 *
 * Extracted from `src/vault/broker/audit-log.ts` (issue #2792 item B /
 * #2953 / #2955), which had the only correct implementation. Three other
 * logs were appending without ANY bound:
 *
 *   - `<agent>/telegram/webhook-events.jsonl` (src/web/webhook-gateway-record.ts)
 *   - `~/.switchroom/host-control-audit.log` (src/host-control/server.ts)
 *
 * Rather than grow a third and fourth copy of the copy/fsync/truncate
 * dance, both now call into here, and the vault broker delegates to it.
 *
 * ── Why copy-then-truncate rather than rename ────────────────────────
 * `rename` is wrong for every log this module serves — but for a
 * DIFFERENT reason per log. State them precisely, because "rename works
 * fine on the host" is true for the hostd log and will otherwise invite
 * an "optimisation" back to rename (#3600 review):
 *
 *   - Vault broker audit log: the active file is bind-mounted into the
 *     broker container as a SINGLE FILE, making the path a mount point in
 *     that namespace. `rename(2)` cannot replace an active mount point —
 *     it fails EBUSY on every attempt and the log grows forever (#2953).
 *
 *   - hostd audit log: hostd is the source-side writer, so EBUSY is NOT
 *     the operative constraint (rename would succeed on the host). The
 *     decisive reason is the READERS: every admin agent bind-mounts this
 *     file `:ro` as a single file — the mount is emitted at
 *     `src/agents/compose.ts:2529-2531` (`src/cli/apply.ts:1107-1116` only
 *     pre-creates the file so that mount source exists) — and hostd writes it
 *     through its own `/host-home` mount. A bind mount pins an INODE, not
 *     a path — renaming the active file would leave every one of those
 *     mounts permanently attached to the old, rotated inode. `/audit
 *     hostd` in each agent would silently freeze at the rotation instant,
 *     forever, with no error surfaced anywhere.
 *
 *   - Sidecar supervisor logs: the supervised child holds an open
 *     `O_APPEND` fd on the path; rename orphans that fd and the live file
 *     stops growing (the copytruncate rationale in start.sh.hbs).
 *
 * Copying the bytes out to `<path>.1` and then `ftruncate`-ing the
 * original back to zero keeps the active INODE — and therefore every
 * mount, every open fd, and the mode — in place, satisfying all three.
 *
 * The `.1 … .maxFiles` generations are ordinary files created by this
 * module, never mount points, so shifting THOSE with `rename` is fine.
 *
 * ── Durability ───────────────────────────────────────────────────────
 * `copyFileSync` returning does not mean the bytes are on stable storage.
 * Truncate is an explicitly data-destroying op, so the snapshot is
 * fsync'd (and its parent dir best-effort fsync'd) BEFORE the active file
 * is truncated. Every failure path leaves the active file intact — we
 * would rather keep growing than lose rows.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface RotateOptions {
  /** Rotate when the active file is >= this many bytes. <= 0 disables. */
  maxBytes: number;
  /** How many `<path>.N` generations to retain. Minimum 1. */
  maxFiles: number;
  /** Prefix for stderr diagnostics, e.g. "vault-audit". */
  tag: string;
  /**
   * Serialize rotation against OTHER PROCESSES via an `O_CREAT|O_EXCL`
   * lockfile at `<path>.rotate.lock` (#3600 review, finding 1).
   *
   * Required whenever two processes can append to the same log. The
   * webhook event log is exactly that: `handleWebhookIngest` runs in the
   * web container and `recordWebhookEvent` in the agent's gateway, both
   * writing `<agent>/telegram/webhook-events.jsonl`. Without a lock they
   * can both stat an over-cap file, A rotates (`.1` ← copy, active
   * truncated), then B rotates the NOW-EMPTY active file — shifting the
   * real `.1` to `.2` and copying zero bytes over `.1`. With maxFiles=2
   * that discards a whole generation of events; the empty-copy is
   * strictly worse than the ordinary copy/truncate race window.
   *
   * The lock closes it twice over: only one rotator runs at a time, AND
   * the size is re-checked while holding the lock, so the loser sees the
   * freshly-truncated file and declines.
   *
   * NOT unconditional mutual exclusion, at any writer count. A holder
   * that overruns {@link ROTATE_LOCK_STALE_MS} is indistinguishable from
   * a dead one, so a peer can legitimately reclaim a LIVE lock and enter
   * `fn()` alongside it — reproduced at two writers (#3600 round-4, H1).
   * What bounds the damage is the in-critical-section inode guard: a
   * rotator whose lock was reclaimed aborts before it destroys anything
   * (see {@link withRotateLock}'s residual for what remains).
   *
   * Single-writer logs (vault audit, hostd audit — both serialized
   * in-process, see `audit-hashchain.ts` single-writer-process contract)
   * do not need it and leave this false.
   */
  lock?: boolean;
}

/** Stale-lock threshold: a rotation is a copy + fsync + truncate, tens of
 *  ms even for 32 MiB. A lock older than this is a crashed holder. */
const ROTATE_LOCK_STALE_MS = 30_000;

/**
 * Run `fn` while holding an `O_CREAT|O_EXCL` lockfile beside the log.
 * Returns `null` if the lock could not be taken (another process is
 * mid-rotation) — the caller treats that as "someone else handled it".
 *
 * A lock left behind by a killed process (container stop, OOM kill) is
 * reclaimed after {@link ROTATE_LOCK_STALE_MS}. The reclaim must itself be
 * mutually exclusive, and `unlink` + `open(O_EXCL)` is NOT (#3600
 * re-review, finding 1): two reclaimers can interleave so that the
 * second's `unlink` removes the FIRST's freshly created lockfile, after
 * which its own exclusive create succeeds and both run. One stale lock
 * would degrade the lock to no lock, in exactly the crash scenario the
 * lock exists for.
 *
 * POSIX gives us no identity-checked `unlink`, so the reclaim is done as
 * park-verify-claim:
 *
 *   1. `rename(lockPath -> lockPath.stale.<pid>.<rand>)` — atomic, and the
 *      park name is unique to us, so the file we now hold is unambiguous.
 *   2. verify the parked file IS the stale lock we observed (same inode,
 *      still older than the threshold). A racer that reclaimed just before
 *      us parks as step 1 too — but what it parked is that racer's LIVE
 *      lock, which fails this check.
 *   3. on mismatch, put it back with `link(2)` (atomic create-if-absent, so
 *      it cannot clobber a lock taken meanwhile) and decline. Only on a
 *      match do we unlink the stale file and take the lock normally, which
 *      can still lose EEXIST to a fresh arrival — correct, that arrival
 *      holds it.
 *
 * Release is inode-guarded for the same reason: we only unlink the
 * lockfile if the path still resolves to the inode we created, so if our
 * own lock was reclaimed out from under us (we overran the threshold) we
 * cannot delete the new holder's lock on the way out.
 *
 * ── Residual, stated honestly ────────────────────────────────────────
 * The breach is at the STALENESS TEST. Step 2 can prove the parked file
 * is the same inode we judged stale and is still past the threshold; it
 * CANNOT distinguish "stale because the holder died" from "stale because
 * the holder is slow". The lock mtime is stamped once, by `open(wx)`,
 * and never refreshed, so a live holder whose rotation overruns
 * {@link ROTATE_LOCK_STALE_MS} ages into reclaimable. That needs only
 * TWO processes (#3600 round-4, H1, reproduced): A holds and overruns; D
 * EEXISTs, judges stale, parks, verifies `mine === true` — both clauses
 * are true of A's LIVE lock — claims, and is inside `fn()` alongside A.
 *
 * Left unguarded the outcome is the one {@link RotateOptions.lock} calls
 * strictly worse than the unlocked window: D rotates to completion, then
 * A's shift renames D's fresh `.1` over `.2` and A copies the
 * now-truncated active file over `.1`. `.1` zero bytes, prior generation
 * gone.
 *
 * The close is therefore NOT to prevent the double entry — POSIX has no
 * identity-checked reclaim and Node exposes no `flock`/`fcntl` lease —
 * but to make the loser HARMLESS. `fn` receives a `stillHeld()`
 * predicate that re-asserts the same inode identity the release guard
 * uses, and {@link rotateLogFile} calls it at the head of each of its
 * three destructive phases. An overrun rotator that lost its lock
 * declines instead of clobbering, so H1 leaves the reclaimer's `.1` and
 * the shifted history intact.
 *
 * What still remains, precisely — this is a narrowing, not a proof of
 * safety:
 *
 *   - `stillHeld()` is a `stat` and the destructive call after it is a
 *     separate syscall. A reclaim landing in that instruction-scale gap
 *     is not caught for the phase it guards — though the NEXT checkpoint
 *     does catch it, so at most one phase proceeds unserialized. The
 *     window shrinks from "the whole rotation" to "between two adjacent
 *     syscalls", but it is not zero.
 *   - If `fstat` on our own lock fd failed, `ourIno` is null and
 *     `stillHeld()` returns true — we cannot verify, and refusing to
 *     ever rotate is the worse failure.
 *
 * Refreshing the mtime from inside `fn()` was considered as a complement
 * and NOT taken. It cannot be periodic: rotation is entirely synchronous
 * `fs.*Sync` and blocks the loop, so no timer fires inside it. It would
 * be one or two fixed stamps, which narrows the aging window without
 * closing it (a copy slower than the threshold still ages past the last
 * stamp), while every second it defers staleness is a second a genuinely
 * crashed holder wedges the log. A heuristic layered on a deterministic
 * guard, buying nothing the guard does not already hold and costing a
 * `utimes` per rotation plus a worse crash-recovery bound.
 *
 * The under-lock size re-check in {@link maybeRotateLogFile} is the
 * second, independent guard against copying an already-rotated (empty)
 * file over a good `.1`.
 */
function withRotateLock<T>(
  logPath: string,
  tag: string,
  fn: (stillHeld: () => boolean) => T,
): T | null {
  const lockPath = `${logPath}.rotate.lock`;
  let fd: number;
  try {
    fd = fs.openSync(lockPath, "wx", 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      process.stderr.write(
        `[${tag}] ERROR: could not take rotation lock ${lockPath}: ${(err as Error).message}\n`,
      );
      return null;
    }
    // Held. Reclaim only if it is stale (holder died mid-rotation).
    let age = 0;
    try {
      age = Date.now() - fs.statSync(lockPath).mtimeMs;
    } catch {
      return null; // vanished under us — the holder just finished
    }
    if (age < ROTATE_LOCK_STALE_MS) return null;
    process.stderr.write(
      `[${tag}] WARN: reclaiming stale rotation lock ${lockPath} (${Math.round(age / 1000)}s old)\n`,
    );
    // Park-verify-claim (see the doc comment). `observed` is the identity
    // we judged stale; anything else at that path is someone's live lock.
    let observed: fs.Stats;
    try {
      observed = fs.statSync(lockPath);
    } catch {
      return null; // gone — a peer is mid-reclaim
    }
    const parked = `${lockPath}.stale.${process.pid}.${Math.random().toString(36).slice(2, 10)}`;
    try {
      fs.renameSync(lockPath, parked);
    } catch {
      return null; // a peer parked it first
    }
    let mine = false;
    try {
      const p = fs.statSync(parked);
      mine =
        p.ino === observed.ino &&
        Date.now() - p.mtimeMs >= ROTATE_LOCK_STALE_MS;
    } catch {
      mine = false;
    }
    if (!mine) {
      // We parked a LIVE lock (a peer reclaimed between our stat and our
      // rename). Put it back without clobbering whatever is there now.
      try {
        fs.linkSync(parked, lockPath);
      } catch {
        /* a lock already exists at the path — the holder is covered */
      }
      try {
        fs.unlinkSync(parked);
      } catch {
        /* best-effort */
      }
      return null;
    }
    try {
      fs.unlinkSync(parked);
    } catch {
      /* best-effort — the park name is unique to us */
    }
    try {
      fd = fs.openSync(lockPath, "wx", 0o600);
    } catch {
      return null; // a fresh arrival took the lock between our rename and this
    }
    // Sweep only once the claim has SUCCEEDED (#3600 round-4, L1). Before
    // the `open(wx)` above we hold nothing — `lockPath` does not exist —
    // and a readdir plus N stat/unlink there would widen the rename→claim
    // interval this comment names as the breach, from ~2 syscalls to
    // 2 + O(parks). Here the path is locked and the sweep is free.
    sweepStaleParks(lockPath);
  }
  // Identify the lock we hold, so release — and the critical section
  // itself — can prove it is still ours.
  let ourIno: number | null = null;
  try {
    ourIno = fs.fstatSync(fd).ino;
  } catch {
    /* leave null — release then falls back to not unlinking */
  }
  const stillHeld = (): boolean => {
    if (ourIno === null) return true; // unverifiable; see the residual
    try {
      return fs.statSync(lockPath).ino === ourIno;
    } catch {
      return false; // lock gone — we are certainly not holding it
    }
  };
  try {
    return fn(stillHeld);
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* best-effort */
    }
    try {
      if (ourIno !== null && fs.statSync(lockPath).ino === ourIno) {
        fs.unlinkSync(lockPath);
      }
    } catch {
      /* gone already, or someone else's — either way not ours to remove */
    }
  }
}

/**
 * Reap `<lockPath>.stale.<pid>.<rand>` files stranded by a crash between
 * the reclaim's `rename` and its cleanup `unlink` (#3600 round-3, L2).
 * Nothing else globs these names, so without this they accumulate one per
 * crash-in-window, forever, in the agent's telegram dir.
 *
 * Only parks whose mtime is already past {@link ROTATE_LOCK_STALE_MS} are
 * taken. There is no "keep ours" exemption: the sole caller runs this
 * AFTER unlinking its own park and after taking the lock, so our park is
 * gone — and in the one case it is not (that unlink failed), it IS a leak
 * and reaping it is correct. A peer mid-reclaim can hold an eligible park
 * — reaping it makes that peer's step-2 stat fail, so it declines and
 * takes no lock. That is a missed rotation cycle at worst; it cannot
 * wedge the path or produce two rotators.
 *
 * Entirely best-effort: every failure is swallowed, so this can never
 * throw out of the reclaim it runs inside.
 */
function sweepStaleParks(lockPath: string): void {
  try {
    const dir = path.dirname(lockPath);
    const prefix = `${path.basename(lockPath)}.stale.`;
    const cutoff = Date.now() - ROTATE_LOCK_STALE_MS;
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(prefix)) continue;
      const full = path.join(dir, name);
      try {
        if (fs.statSync(full).mtimeMs > cutoff) continue;
        fs.unlinkSync(full);
      } catch {
        /* raced with a peer's reclaim or another sweeper — leave it */
      }
    }
  } catch {
    /* unreadable dir — sweeping is housekeeping, never fatal */
  }
}

/**
 * Rotate `<path>` unconditionally: drop `<path>.<maxFiles>`, shift
 * `<path>.(n-1)` → `<path>.n`, snapshot `<path>` → `<path>.1`, truncate
 * `<path>` in place.
 *
 * Best-effort: returns `false` (and writes a diagnostic to stderr) if the
 * rotation could not complete, in which case the active file is left
 * exactly as it was. Never throws.
 *
 * `stillHeld`, when supplied by {@link withRotateLock}, is re-asserted
 * immediately before EVERY destructive syscall — the oldest-generation
 * unlink, each shift rename, the `copyFileSync` that overwrites `.1`, and
 * the `truncate` that destroys live rows (#3600 round-4, H1). A holder
 * that overran the stale threshold can have its live lock legitimately
 * reclaimed by a peer; if that happened we are no longer serialized
 * against that peer, and continuing would rename its fresh `.1` off the
 * end of the window, copy a truncated active file over it, and truncate
 * rows written after its rotation. Declining costs one rotation cycle;
 * continuing costs a generation of events.
 *
 * Per-syscall rather than once at the top because a reclaim can land at
 * any point inside the rotation, and each check is one `stat` against a
 * handful of syscalls. It is a narrowing, not a proof — a reclaim landing
 * between a check and the syscall it guards is still uncaught (the next
 * check catches it, so at most one syscall proceeds unserialized). See
 * {@link withRotateLock}'s residual.
 */
export function rotateLogFile(
  logPath: string,
  maxFiles: number,
  tag: string,
  stillHeld?: () => boolean,
): boolean {
  const keep = Math.max(1, Math.floor(maxFiles));
  /** True iff we may still destroy things; warns once per refusal. */
  const held = (what: string): boolean => {
    if (!stillHeld || stillHeld()) return true;
    process.stderr.write(
      `[${tag}] WARN: rotation lock for ${logPath} was reclaimed while we were inside it; declining to ${what}\n`,
    );
    return false;
  };
  // Delete the oldest retained generation — it falls off the window.
  const oldest = `${logPath}.${keep}`;
  if (fs.existsSync(oldest)) {
    if (!held(`drop ${oldest}`)) return false;
    try {
      fs.unlinkSync(oldest);
    } catch (err) {
      process.stderr.write(
        `[${tag}] ERROR: could not drop oldest rotation ${oldest}: ${(err as Error).message}\n`,
      );
    }
  }
  // Shift .(n-1) → .n. Ordinary files; rename is safe.
  for (let n = keep - 1; n >= 1; n--) {
    const from = `${logPath}.${n}`;
    const to = `${logPath}.${n + 1}`;
    if (!fs.existsSync(from)) continue;
    if (!held(`shift ${from} → ${to}`)) return false;
    try {
      fs.renameSync(from, to);
    } catch (err) {
      process.stderr.write(
        `[${tag}] ERROR: could not rotate ${from} → ${to}: ${(err as Error).message}\n`,
      );
      return false;
    }
  }
  const snapshotPath = `${logPath}.1`;
  // The copy OVERWRITES `.1` — if a peer reclaimed during the shift above,
  // that `.1` is the peer's fresh snapshot, not ours to replace.
  if (!held(`overwrite ${snapshotPath}`)) return false;
  try {
    fs.copyFileSync(logPath, snapshotPath);
  } catch (err) {
    process.stderr.write(
      `[${tag}] ERROR: could not snapshot active log ${logPath} → ${snapshotPath}: ${(err as Error).message}\n`,
    );
    return false;
  }
  // Durably persist the snapshot before destroying the source.
  try {
    const fd = fs.openSync(snapshotPath, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    process.stderr.write(
      `[${tag}] ERROR: could not fsync snapshot ${snapshotPath}; leaving active log intact to avoid data loss: ${(err as Error).message}\n`,
    );
    return false;
  }
  // Best-effort dirent persist — non-fatal, rotation is idempotent.
  try {
    const dirFd = fs.openSync(path.dirname(snapshotPath), "r");
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch {
    /* some filesystems refuse fsync on directories */
  }
  // Re-assert identity before the one irreversible step. A reclaim that
  // landed during the copy/fsync above means a peer already snapshotted
  // and truncated, and the rows here now are rows written AFTER that —
  // never ours to destroy. Leaving the active file intact is this
  // module's standing preference over losing rows.
  if (!held(`truncate ${logPath}`)) return false;
  try {
    fs.truncateSync(logPath, 0);
  } catch (err) {
    process.stderr.write(
      `[${tag}] ERROR: could not truncate active log ${logPath}: ${(err as Error).message}\n`,
    );
    return false;
  }
  return true;
}

/**
 * Stat `<path>` and rotate it if it has reached `maxBytes`. Returns true
 * iff a rotation actually happened. A missing file, a stat failure, or a
 * non-positive `maxBytes` are all no-ops (never throws) — rotation is a
 * housekeeping concern and must never break the write path it guards.
 */
export function maybeRotateLogFile(
  logPath: string,
  opts: RotateOptions,
): boolean {
  if (!(opts.maxBytes > 0)) return false;
  if (!overCap(logPath, opts.maxBytes)) return false;
  if (!opts.lock) {
    return rotateLogFile(logPath, opts.maxFiles, opts.tag);
  }
  // Multi-writer log: take the cross-process lock and RE-CHECK the size
  // under it. The recheck is the part that matters — a racing process may
  // have rotated between our stat above and our acquiring the lock, and
  // rotating the now-empty active file would copy zero bytes over a good
  // `.1` and shift the real history off the end of the window.
  const rotated = withRotateLock(logPath, opts.tag, (stillHeld) => {
    if (!overCap(logPath, opts.maxBytes)) return false;
    return rotateLogFile(logPath, opts.maxFiles, opts.tag, stillHeld);
  });
  return rotated === true;
}

/** True iff `logPath` exists and is at least `maxBytes` long. Never throws. */
function overCap(logPath: string, maxBytes: number): boolean {
  try {
    return fs.statSync(logPath).size >= maxBytes;
  } catch {
    return false; // not created yet (or unreadable) — nothing to rotate
  }
}

/**
 * Resolve a `{maxBytes, maxFiles}` pair from explicit options, then env
 * overrides, then defaults. `maxBytes === 0` means "unset" (fall through);
 * a NEGATIVE explicit/env value disables rotation entirely — the operator
 * escape hatch, matching the vault broker's long-standing semantics.
 */
export function resolveRotationConfig(args: {
  maxBytes?: number;
  maxFiles?: number;
  envBytesVar: string;
  envFilesVar: string;
  defaultBytes: number;
  defaultFiles: number;
  env?: NodeJS.ProcessEnv;
}): { maxBytes: number; maxFiles: number } {
  const env = args.env ?? process.env;
  const envBytes = Number(env[args.envBytesVar]);
  const envFiles = Number(env[args.envFilesVar]);
  const maxBytes =
    args.maxBytes !== undefined && args.maxBytes !== 0
      ? args.maxBytes
      : Number.isFinite(envBytes) && envBytes !== 0
        ? envBytes
        : args.defaultBytes;
  const maxFiles =
    args.maxFiles !== undefined && args.maxFiles > 0
      ? args.maxFiles
      : Number.isFinite(envFiles) && envFiles > 0
        ? envFiles
        : args.defaultFiles;
  return { maxBytes, maxFiles };
}
