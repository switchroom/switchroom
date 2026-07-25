/**
 * log-rotation — one size-based rotation primitive for every append-only
 * log this codebase owns.
 *
 * Extracted from `src/vault/broker/audit-log.ts` (issue #2792 item B /
 * #2953 / #2955), which had the only correct implementation. Two other
 * TypeScript logs were appending without ANY bound:
 *
 *   - `<agent>/telegram/webhook-events.jsonl` (src/web/webhook-gateway-record.ts)
 *   - `~/.switchroom/host-control-audit.log` (src/host-control/server.ts)
 *
 * Rather than grow a second and third copy of the copy/fsync/truncate
 * dance, both now call into here, and the vault broker delegates to it.
 *
 * The sidecar supervisor log is bounded as well, but NOT by this module:
 * it is rotated in shell by the container entrypoint
 * (`profiles/_base/start.sh.hbs`, the `cp` + `: >` copytruncate block),
 * because no TypeScript runs on that path. It appears in the rename
 * rationale below because it constrains the technique, not because it
 * calls in here.
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
   * The lock closes THAT interleaving twice over: only one rotator runs
   * at a time, AND the size is re-checked while holding the lock, so the
   * loser sees the freshly-truncated file and declines.
   *
   * It is NOT unconditional mutual exclusion, at any writer count. A
   * holder that overruns {@link ROTATE_LOCK_STALE_MS} is indistinguishable
   * from a dead one, so a peer can legitimately reclaim a LIVE lock and
   * enter `fn()` alongside it — reproduced at two writers (#3600 round-4,
   * H1). The in-critical-section inode guard bounds how much of the
   * rotation such a rotator can still run: it aborts at the next
   * checkpoint, so at most ONE destructive syscall proceeds unserialized.
   *
   * That bounds the COUNT, not the damage, and the distinction is not
   * academic — the syscall that gets through can be the `copyFileSync`,
   * and if the peer has not appended since rotating (a low-traffic log,
   * most of the time) the bytes it copies over the peer's snapshot are
   * zero. `.1` empty, prior generation gone, active file empty: the
   * empty-copy outcome named two paragraphs up, reached WITH the lock
   * held. See {@link withRotateLock}'s residual, which enumerates all four
   * gaps and what each destroys (#3600 round-6, H1/H2).
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
 * That guard and `stillHeld()` both rest on a PREMISE the type system
 * cannot state: the lock `fd` is still open when the inode comparison
 * happens. An open fd pins the inode, which is the only reason "same
 * inode number" means "same lock" — see the comment at the `ourIno`
 * capture for the measurement and for the test that fails if a refactor
 * closes it early.
 *
 * For `stillHeld()` the premise holds by position — every call is inside
 * `fn()`. For the RELEASE guard it holds only because the `finally` below
 * unlinks BEFORE it closes, and until round 6 it did not: the close came
 * first, and the guard then compared a number nothing was holding.
 * Reproduced on ext4 (#3600 round-6, H3) — a peer's park→unlink→`open(wx)`
 * landing in that window was handed our inode number, our guard matched,
 * and we deleted the peer's LIVE lock, leaving the log unlocked in exactly
 * the scenario the lock exists for. That is why the ordering in the
 * `finally` is annotated rather than left to look arbitrary, and why the
 * release unlink is one of the sites the round-5 mechanism test now tags.
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
 * but to make the loser cheaper in the COMMON case. `fn` receives a
 * `stillHeld()` predicate that re-asserts the same inode identity the
 * release guard uses, and {@link rotateLogFile} calls it immediately
 * before every destructive syscall (four `held()` sites; the shift one
 * fires once per loop iteration), plus a data-based gate on the truncate
 * and one further `stillHeld()` read AFTER the truncate that guards
 * nothing and only decides whether to log that we destroyed the peer's
 * rows. An overrun rotator that lost its lock stops at the next
 * checkpoint instead of running the rotation to completion.
 *
 * ── What that does and does NOT buy ──────────────────────────────────
 * It buys ONE thing, stated exactly: at most one destructive syscall
 * proceeds unserialized, instead of the whole rotation. It does not
 * bound the DAMAGE of that one syscall, and specifically it does not
 * bound it to "one generation" — the copy gap below loses everything.
 * Rounds 3-6 of the #3600 review each caught a sentence here claiming
 * otherwise; every claim in this block is pinned by a named test in
 * `log-rotation-race.test.ts`, and the tests, not the prose, are the
 * record.
 *
 * When the reclaim lands BEFORE our first destructive syscall we touch
 * nothing ("declines outright when the peer rotated before we touched
 * anything" — `.1` the peer's snapshot, `.2` the shifted history, active
 * untouched). A landing anywhere else is caught by the NEXT checkpoint
 * and costs nothing either — except in the FOUR check→syscall gaps, one
 * per destructive syscall, where that syscall is already committed. Those
 * four are not equivalent; each destroys something different:
 *
 *   1. check→`unlinkSync(<log>.<keep>)` — the oldest-generation drop.
 *      The peer's rotation has just shifted real history into that slot;
 *      our unlink deletes it. `.1` the peer's snapshot, `.2` GONE.
 *      ("does not shift the peer's fresh .1 off the end — but the unlink
 *      gap destroys its shifted history". Before round 6 the in-tree
 *      test seeded no `.1`, so the peer's own rotation had already
 *      removed `.2` and our unlink merely failed ENOENT — it passed on
 *      an error path and asserted nothing about this gap.)
 *   2. check→shift-`rename` — our rename moves the peer's fresh `.1`
 *      onto `.2`, over the history that was there. `.1` absent, `.2` the
 *      peer's snapshot. ("does not copy over the peer's .1")
 *   3. check→`copyFileSync` — the worst of the four, and its severity
 *      depends on the peer, not on us:
 *        · peer appended after rotating → `.1` becomes a byte-copy of
 *          the live file, `.2` absent: the peer's snapshot and the prior
 *          generation are both gone, the live rows survive. ("loses a
 *          generation when the reclaim lands in the copy gap")
 *        · peer QUIET after rotating — the ordinary state of a
 *          low-traffic log — the file we copy is the peer's
 *          freshly-truncated ZERO bytes. `.1` empty, `.2` gone, active
 *          empty: EVERY byte, history and live rows alike, is lost.
 *          ("loses EVERY byte when the reclaim lands in the copy gap and
 *          the peer is quiet", #3600 round-6, H1.) This is verbatim the
 *          outcome {@link RotateOptions.lock} calls strictly worse than
 *          the ordinary copy/truncate race window, reached WITH the lock
 *          held. The worst case does not shrink from "all history" to
 *          "one generation": it is still total loss. What shrinks is how
 *          much has to go wrong to reach it, not what it costs.
 *   4. check→`truncateSync` — the only gap that destroys LIVE rows
 *      rather than history depth, and the only one with no next
 *      checkpoint behind it, because the truncate IS the last one. The
 *      peer rotates and appends; we truncate its rows away and return
 *      `true`, telling the caller the rotation succeeded. This is the
 *      one gap that got a code change rather than a paragraph (#3600
 *      round-6, H2): {@link rotateLogFile} now re-stats the active file
 *      immediately before the truncate and declines if it SHRANK below
 *      the snapshot we just wrote ("declines the truncate when the peer
 *      rotated after our lock check"). Two things it does not do, both
 *      deliberate. It does not catch a landing between its own stat and
 *      the `truncateSync` — that check is itself a stat followed by a
 *      separate syscall, so the gap moves, it does not close; the
 *      surviving window is asserted, return value and all, in "destroys
 *      the peer's rows when the reclaim lands in the truncate gap". And
 *      it is a LENGTH test, so a peer that rotates and then re-appends
 *      more bytes than we snapshotted is invisible to it. What it does
 *      cover is the ordinary shape of the landing: a peer that rotated
 *      leaves the active file shorter than our snapshot.
 *
 * So: the window shrinks from "the whole rotation" to "between two
 * adjacent syscalls", and reaching it needs a rotation that overruns
 * {@link ROTATE_LOCK_STALE_MS} AND a peer completing a full
 * reclaim-and-rotate inside a sub-microsecond inter-syscall gap. That is
 * why this is documented rather than closed. It is a narrowing of
 * PROBABILITY, not of consequence.
 *
 * One more residual, unrelated to the gaps: if `fstat` on our own lock fd
 * failed, `ourIno` is null and `stillHeld()` returns true — we cannot
 * verify, and refusing to ever rotate is the worse failure.
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
  //
  // LOAD-BEARING PREMISE: `fd` must stay OPEN for the whole critical
  // section — from the `open(wx)` above through the `finally` below
  // (#3600 round-5, M3). Inode numbers are only unique among LIVE inodes;
  // a filesystem is free to hand our number straight back to the next
  // create once nothing references it. An open fd is a reference, so
  // holding `fd` is what makes `ino === ourIno` mean "the same lock"
  // rather than "some file that got our number". Close it early and the
  // reclaim sequence a peer actually performs — park (`rename`), unlink,
  // `open(wx)` — hands the peer's brand-new lock our exact inode, at
  // which point `stillHeld()` returns true against a lock we do not hold
  // and the whole H1 guard silently inverts.
  //
  // Measured on Linux/Node 22, 200 park→unlink→recreate cycles per cell:
  //
  //     fd closed  ext4  200/200 collisions      fd closed  tmpfs  0/200
  //     fd open    ext4    0/200 collisions      fd open    tmpfs  0/200
  //
  // Note the tmpfs column: the race suite runs under `os.tmpdir()`, which
  // is tmpfs on these machines and never reuses — so no outcome-level
  // race test can detect an early close. The real logs live on ext4
  // (`~/.switchroom/**`), i.e. on the reusing side. The guard is
  // therefore mechanical, not observational: `log-rotation-race.test.ts`,
  // "holds the lock fd open through every destructive syscall", watches
  // `closeSync` and fails if `fd` is closed before the last destructive
  // syscall — on any filesystem.
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
    // ORDER IS LOAD-BEARING: unlink under the guard FIRST, close after
    // (#3600 round-6, H3). The guard's whole content is "the inode number
    // at `lockPath` is still ours", and that only means "still our lock"
    // while `fd` pins the inode. Closing first frees it, and a peer's
    // reclaim — park (`rename`), unlink, `open(wx)` — is exactly the
    // sequence that gets the number handed straight back on a reusing
    // filesystem. Reproduced on ext4 with the close first: the peer's
    // brand-new LIVE lock carried our inode number, the guard matched,
    // and we unlinked it, leaving the log with no lock at all — the
    // failure this guard exists to prevent. Same reproduction with the
    // close last: different inode, guard declines, peer's lock intact.
    // `log-rotation-race.test.ts`, "holds the lock fd open through every
    // destructive syscall", pins the ordering on any filesystem by
    // tagging the release unlink itself with the fd's open/closed state.
    try {
      if (ourIno !== null && fs.statSync(lockPath).ino === ourIno) {
        fs.unlinkSync(lockPath);
      }
    } catch {
      /* gone already, or someone else's — either way not ours to remove */
    }
    try {
      fs.closeSync(fd);
    } catch {
      /* best-effort */
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
 * and reaping it is correct. A peer mid-reclaim WILL hold an eligible
 * park, not merely can: `rename(2)` does not touch the file's mtime (it
 * modifies the directory, not the inode), so a park always carries the
 * mtime of the ancient lock it was made from and is therefore always
 * already past the cutoff. Reaping a concurrent reclaimer's park is the
 * common case, not an edge — the consequences below are what make that
 * acceptable, not its rarity. Reaping it makes that peer's step-2 stat
 * fail, so it declines and takes no lock. That is a missed rotation cycle
 * at worst; it cannot wedge the path or produce two rotators.
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
 * rotation could not complete. `false` says the ACTIVE file is exactly as
 * we found it — that holds on every return path here, and it is the whole
 * of what it says. It does NOT say the generations are untouched: a
 * mid-rotation decline can already have dropped `<path>.<maxFiles>` or
 * shifted a generation. Never throws.
 *
 * The converse is worth stating too, because one interleaving makes it
 * bite: `true` says we snapshotted and truncated, NOT that the result is
 * coherent. If a peer reclaimed the lock in the gap between the pre-truncate
 * size check and the `truncateSync`, we return `true` having destroyed the
 * peer's rows. There is no return value that describes that honestly —
 * `false` would assert the active file is untouched, which is worse — so
 * the case is reported on stderr instead ("rows another rotator wrote …
 * are LOST") and asserted in `log-rotation-race.test.ts`, "destroys the
 * peer's rows when the reclaim lands in the truncate gap" (#3600 round-6,
 * H2). Neither live caller (`src/host-control/server.ts`,
 * `src/web/webhook-handler.ts`) reads the boolean.
 *
 * `stillHeld`, when supplied by {@link withRotateLock}, is re-asserted
 * immediately before EVERY destructive syscall — the oldest-generation
 * unlink, each shift rename, the `copyFileSync` that overwrites `.1`, and
 * the `truncate` that destroys live rows (#3600 round-4, H1) — and the
 * truncate carries a second, data-based gate on top (round-6, H2). A
 * holder that overran the stale threshold can have its live lock
 * legitimately reclaimed by a peer; if that happened we are no longer
 * serialized against that peer, and continuing would rename its fresh
 * `.1` off the end of the window, copy a truncated active file over it,
 * and truncate rows written after its rotation.
 *
 * Per-syscall rather than once at the top because a reclaim can land at
 * any point inside the rotation, and each check is one `stat` against a
 * handful of syscalls. It is a narrowing, not a proof — a reclaim landing
 * between a check and the syscall it guards is uncaught for that syscall,
 * so at most ONE proceeds unserialized. "At most one syscall" bounds the
 * COUNT and nothing else: depending on which of the four gaps it lands
 * in, that one syscall costs a generation of history, the peer's live
 * rows, or — the copy gap with a quiet peer — every byte the log has.
 * {@link withRotateLock} enumerates all four with the test that asserts
 * each.
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
  let snapshotBytes = -1;
  try {
    const fd = fs.openSync(snapshotPath, "r");
    try {
      fs.fsyncSync(fd);
      snapshotBytes = fs.fstatSync(fd).size;
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
  // A SECOND, DATA-BASED checkpoint on the one irreversible step (#3600
  // round-6, H2). It narrows the truncate gap; it does not close it —
  // nothing here can, and the tests pin both halves of that.
  //
  // Why a second one at all: the truncate gap is the only gap with no
  // NEXT checkpoint to catch what slipped through, because this is the
  // last one, and it is the only gap that destroys LIVE rows rather than
  // history depth. A peer that reclaims after `held()`'s stat, rotates,
  // and appends leaves us truncating rows that belong entirely to its
  // completed cycle (reproduced, #3600 round-6).
  //
  // What it tests is the DATA, not the lock: a truncate is only correct
  // if the active file still begins with the bytes now sitting in `.1`,
  // and the one observable that changes when someone else rotates under
  // us is that the active file got SHORTER than that snapshot. Appends
  // only grow it, so this cannot false-positive on the ordinary
  // copy-then-truncate window (rows appended between our copy and our
  // truncate are lost either way — the technique's baseline race,
  // documented at the top of this file, and NOT what this guards).
  //
  // Residual, precisely — two ways past it, and both are real:
  //   · this check is itself a `stat` followed by a separate
  //     `truncateSync`, so a reclaim landing in THAT gap is caught by
  //     nothing. The window shrinks from [`held()` stat → truncate] to
  //     [this stat → truncate]; it does not vanish. Asserted, with the
  //     honest outcome including the `true` return, in
  //     `log-rotation-race.test.ts`, "destroys the peer's rows when the
  //     reclaim lands in the truncate gap".
  //   · a peer that rotates AND re-appends more than `snapshotBytes`
  //     before we stat is invisible to a length test.
  let liveBytes: number;
  try {
    liveBytes = fs.statSync(logPath).size;
  } catch (err) {
    process.stderr.write(
      `[${tag}] ERROR: could not re-stat active log ${logPath} before truncating; leaving it intact to avoid data loss: ${(err as Error).message}\n`,
    );
    return false;
  }
  if (snapshotBytes >= 0 && liveBytes < snapshotBytes) {
    process.stderr.write(
      `[${tag}] WARN: active log ${logPath} shrank from ${snapshotBytes} to ${liveBytes} bytes after we snapshotted it; another rotator truncated it and these rows are its, not ours — declining to truncate\n`,
    );
    return false;
  }
  try {
    fs.truncateSync(logPath, 0);
  } catch (err) {
    process.stderr.write(
      `[${tag}] ERROR: could not truncate active log ${logPath}: ${(err as Error).message}\n`,
    );
    return false;
  }
  // The truncate succeeded. If the lock is no longer ours, the reclaim
  // landed in the one gap nothing above can cover — and we have just
  // destroyed rows written after the reclaimer's own rotation. There is
  // no undo, so the only thing left is to SAY SO (#3600 round-6, H2).
  //
  // The return value deliberately stays `true`: this function's `false`
  // means "the rotation did not happen and the active file is exactly as
  // it was" (every other decline path, and the tests on them, depend on
  // that reading), and neither half is true here — we did snapshot and we
  // did truncate. Returning `false` would trade one wrong answer for a
  // worse one. Both live callers discard the value
  // (`src/host-control/server.ts`, `src/web/webhook-handler.ts`), so this
  // stderr line, not the boolean, is the operator-visible channel.
  if (stillHeld && !stillHeld()) {
    process.stderr.write(
      `[${tag}] ERROR: truncated ${logPath} after our rotation lock was reclaimed; rows another rotator wrote between our size check and our truncate are LOST\n`,
    );
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
