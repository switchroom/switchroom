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
   * checkpoint, so at most ONE destructive syscall proceeds unserialized —
   * WHENEVER THE GUARD CAN VERIFY ANYTHING AT ALL. If the `fstat` on our
   * own lock fd failed, `ourIno` is null, `stillHeld()` returns true
   * forever, and NO lock checkpoint fires at any of the four sites: the
   * oldest-generation unlink and every shift rename then run unserialized,
   * and only the data-based gates named below still bite — and those are
   * silent too whenever the peer finished before our entry stat, which is
   * exactly the interleaving that test drives. That
   * carve-out is not a footnote to the "at most one" claim, it is an
   * exception to it, and it is asserted in `log-rotation-race.test.ts`,
   * "an unverifiable lock fd drops every lock checkpoint" (#3600 round-7,
   * L1).
   *
   * That bounds the COUNT, not the damage. Every destructive step —
   * the oldest-generation unlink, each shift rename, the `copyFileSync`
   * that overwrites `.1`, and the `truncateSync` that empties the active
   * file — therefore carries a SECOND gate that
   * depends on no lock at all: an append-only log only grows, so an active
   * file that SHRANK below the size we measured is positive evidence that
   * a peer rotated under us, and all of them decline on it (#3600 round-6
   * H2 for the truncate, round-7 H1 for the copy and, by the sibling
   * sweep that finding required, for the unlink and the shifts). That is what removes
   * the worst outcome — a quiet peer's freshly-truncated zero bytes copied
   * over its own fresh snapshot, `.1` empty, prior generation gone, active
   * empty, i.e. the empty-copy outcome named two paragraphs up reached
   * WITH the lock held — from every landing up to each gate's own stat.
   * What it does not remove is that gate's own stat→syscall gap. See
   * {@link withRotateLock}'s residual, which enumerates all four gaps and
   * what each still destroys (#3600 round-6 H1/H2, round-7 H1).
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
 *      it cannot clobber a lock taken meanwhile) and decline — unlinking
 *      the park only if that restore SUCCEEDED, for the reason spelled out
 *      under the release's step 3 below (#3600 round-8, M1): a failed
 *      restore leaves `parked` as the peer's only name for a LIVE lock.
 *      Only on a match do we unlink the stale file and take the lock
 *      normally, which can still lose EEXIST to a fresh arrival —
 *      correct, that arrival holds it.
 *
 * Release is identity-guarded for the same reason, and by the SAME
 * primitive, for the same reason again: `statSync(lockPath).ino ===
 * ourIno` followed by a separate `unlinkSync(lockPath)` is two syscalls,
 * so a peer that reclaims BETWEEN them is handed a verdict about a file it
 * no longer owns and has its brand-new LIVE lock deleted unconditionally —
 * the log left unlocked while the peer believes it holds it. That claim
 * ("we cannot delete the new holder's lock on the way out") stood here
 * false for five rounds and was reproduced in round 7 (#3600, H2); the
 * round-6 H3 ordering fix made the inode NUMBER meaningful, it did not
 * make stat+unlink atomic, and no ordering can.
 *
 * So release is filter-park-verify-unlink:
 *
 *   0. `stat(lockPath).ino === ourIno`, and RETURN TOUCHING NOTHING if it
 *      is not (#3600 round-8, H2). This stat cannot prove the lock is
 *      ours — that is the entire reason steps 1-3 exist — but it can prove
 *      it is NOT, and that direction has no race in it: `fd` is still open,
 *      so our inode cannot be freed or reissued, and nothing ever puts our
 *      inode back at `lockPath` once ANOTHER FILE is there (the only
 *      restore in this file is `link(2)`, which fails EEXIST against it).
 *      A different inode is therefore a final answer. ENOENT is not — our
 *      lock may be parked mid-restore by a peer's release — and it is read
 *      as "not ours" anyway; the cost of that reading is the MISSED
 *      RELEASE in the residual below, and it is bounded. This is a filter,
 *      not a guard, and it exists because the park below has a cost that
 *      is NOT private to us — see the residual.
 *   1. `rename(lockPath -> lockPath.stale.<pid>.<rand>)` — atomic, and the
 *      park name is unique to us, so the file we are about to judge is
 *      unambiguously the one we took. This is the step that closes the
 *      gap: identity is decided about a file nobody else can name.
 *   2. compare the parked inode against `ourIno`. A match means the park
 *      IS our lock and unlinking it is the release, so we unlink it and
 *      stop. A peer's lock, reclaimed at any instant before the rename,
 *      fails the comparison and is never unlinked as a release — step 3
 *      restores it, and drops the park name only once the restore has put
 *      the inode back at `lockPath`. If the stat itself fails, a peer's
 *      sweep already reaped the park — which IS our release — and we touch
 *      nothing further.
 *   3. on mismatch, `link(2)` it back (create-if-absent, so it cannot
 *      clobber a lock taken meanwhile). The cleanup unlink then runs ONLY
 *      if that restore SUCCEEDED, i.e. only while `parked` is a second
 *      name for an inode that is also back at `lockPath`. The restore has
 *      three failure modes, not one — EEXIST (a third arrival holds the
 *      path), EPERM/ENOSYS (a filesystem without hardlinks), ENOENT (our
 *      park reaped under us) — and after the first two `parked` is the
 *      peer's ONLY remaining name for its LIVE lock. Unlinking there
 *      destroys the lock of a process that believes it holds it, which is
 *      not "conservative" and is strictly worse than the unconditional
 *      delete this replaced; reproduced with `link` throwing EPERM (#3600
 *      round-8, M1). So we leave the park and let `sweepStaleParks` reap
 *      it: a named file of debris instead of a destroyed lock.
 *
 *      Be exact about what that does and does not recover. It saves the
 *      peer's INODE, not the peer's lock: `lockPath` stays absent, the
 *      peer declines at its next checkpoint, and a later arrival may take
 *      the lock. On a filesystem with no hardlinks there is no atomic
 *      create-if-absent to restore with, and `rename`-ing the park back
 *      would clobber whatever arrived meanwhile — deleting a live lock,
 *      the one outcome every guard in this file exists to prevent — so it
 *      is NOT done. Asserted, both halves, in "a restore that fails does
 *      not destroy the peer's lock inode".
 *
 * ── Release residual, stated honestly ────────────────────────────────
 * Between the park `rename` and the restoring `link` the lock path does
 * not exist. That absence is NOT private: `stillHeld()` reads a missing
 * `lockPath` as "we lost the lock" (it cannot do otherwise — see below),
 * so any legitimate holder that checkpoints inside it declines the rest of
 * its rotation. Step 0 is what makes that window rare instead of routine.
 * Without it, EVERY mismatched release opened one, and the damaging case
 * needed no third party and no contention at all (#3600 round-8, H2,
 * reproduced): A releases after its lock was reclaimed by V, parks V's
 * LIVE lock, V's next `held()` reads ENOENT and aborts a rotation it was
 * legitimately performing — after its oldest-generation unlink has already
 * run. Cost: one full generation of history destroyed and zero rotation
 * performed. That was a REGRESSION introduced with park-verify (round 7):
 * before it, a mismatched release did nothing, so no peer's release ever
 * made `lockPath` transiently absent.
 *
 * What step 0 leaves is a one-syscall gap: we stat and see our own inode,
 * a peer reclaims us as stale between that stat and our `rename`, and we
 * park its brand-new live lock. Then the absence window is real and the
 * cost above is real — but reaching it now requires the peer to have
 * judged us stale and to land inside a single syscall, not merely to have
 * reclaimed us at some point. The lock survives it (step 3), the peer
 * declines at its next checkpoint, and nothing is deleted.
 *
 * The other new residual is a MISSED release: if a peer's release parked
 * our live lock and is mid-restore when our step 0 stats, we read ENOENT,
 * conclude "not ours" and leave without unlinking. The lockfile is then
 * restored with nobody holding it, and rotations skip until it ages past
 * {@link ROTATE_LOCK_STALE_MS} and is reclaimed. Bounded, non-destructive,
 * and it trades a delayed rotation for the destroyed generation above.
 *
 * Teaching `stillHeld()` to tolerate the absence — ENOENT plus
 * `fstat(fd).nlink > 0` means our inode still has SOME name, i.e. we are
 * parked rather than deleted — was considered and NOT taken: the stale
 * RECLAIM parks the same way and then unlinks, so that predicate returns
 * true for a holder that is about to be legitimately displaced, and would
 * let a destructive syscall through in exactly the H1 interleaving the
 * checkpoints exist to stop. Trading a rare spurious decline for a rare
 * spurious proceed is the wrong direction.
 *
 * Pinned by `log-rotation-race.test.ts`: "release does not delete a peer's
 * lock that arrived after our identity check" (the step-0-to-rename gap),
 * "a mismatched release does not park a peer's live lock" (#3600 round-8,
 * H2), "release leaves the peer's lock alone even where the restore would
 * fail" and "a restore that fails does not destroy the peer's lock inode"
 * (#3600 round-8, M1) — plus its reclaim-side twin, "a RECLAIM whose
 * restore fails does not destroy the peer's lock inode". Those names are
 * checked mechanically, not by eye: "every test name this file cites
 * exists" fails if a citation here names no test (#3600 round-8, L2).
 *
 * Note precisely what step 0 is and is not. It is NOT a `stillHeld()`-style
 * re-check that the release then trusts: a stat saying "ours" is exactly
 * the claim rounds 6 and 7 proved unusable, and nothing below relies on it.
 * The rename still decides ownership. Step 0 is a one-directional filter —
 * its only load-bearing verdict is "NOT ours", which is unfalsifiable while
 * `fd` is open — and its only job is to keep us from parking at all in the
 * case where we already know the answer.
 *
 * The release guard and `stillHeld()` both rest on a PREMISE the type system
 * cannot state: the lock `fd` is still open when the inode comparison
 * happens. An open fd pins the inode, which is the only reason "same
 * inode number" means "same lock" — see the comment at the `ourIno`
 * capture for the measurement and for the test that fails if a refactor
 * closes it early.
 *
 * For `stillHeld()` the premise holds by position — every call is inside
 * `fn()`. For the RELEASE guard it holds only because the `finally` below
 * runs the whole park-verify-unlink BEFORE it closes, and until round 6 it
 * did not: the close came first, and the guard then compared a number
 * nothing was holding. Reproduced on ext4 (#3600 round-6, H3) — a peer's
 * park→unlink→`open(wx)` landing in that window was handed our inode
 * number, our guard matched, and we deleted the peer's LIVE lock, leaving
 * the log unlocked in exactly the scenario the lock exists for. Park-verify
 * does not retire that requirement, it inherits it: if `fd` were closed,
 * the peer's new lock could carry `ourIno`, we would park it, match, and
 * unlink it. That is why the ordering in the `finally` is annotated rather
 * than left to look arbitrary, and why the release is one of the sites the
 * round-5 mechanism test tags.
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
 * fires once per loop iteration), each paired with a data-based gate —
 * the shrank-under-us predicate on the drop, the shifts and the copy,
 * and the snapshot-relative one on the truncate — plus one further
 * `stillHeld()` read AFTER the
 * truncate that guards nothing and only decides whether to log that we
 * destroyed the peer's rows. An overrun rotator that lost its lock stops
 * at the next checkpoint instead of running the rotation to completion.
 *
 * ── What that does and does NOT buy ──────────────────────────────────
 * The lock checkpoints buy ONE thing, stated exactly: at most one
 * destructive syscall proceeds unserialized, instead of the whole
 * rotation — and even that holds only while `ourIno !== null`. With a
 * null `ourIno` (an `fstat` that failed on our own lock fd) `stillHeld()`
 * is a constant `true`, every one of the four checkpoints is a no-op, and
 * the unlink and the shifts run unserialized together; the data-based
 * gates are then the only thing between us and the peer's bytes — and
 * they are silent whenever the peer finished BEFORE our entry stat, since
 * `entryBytes` then already records the peer's truncated file and nothing
 * shrinks relative to it. That
 * exception is asserted, not merely mentioned, in "an unverifiable lock fd
 * drops every lock checkpoint" (#3600 round-7, L1).
 *
 * They do not bound the DAMAGE of the syscall that gets through, and
 * specifically they do not bound it to "one generation". Rounds 3-7 of the
 * #3600 review each caught a sentence here claiming more than the code
 * does; every claim in this block is pinned by a named test in
 * `log-rotation-race.test.ts`, and the tests, not the prose, are the
 * record.
 *
 * When the reclaim lands BEFORE our first destructive syscall we touch
 * nothing ("declines outright when the peer rotated before we touched
 * anything" — `.1` the peer's snapshot, `.2` the shifted history, active
 * untouched). A landing anywhere else is caught by the NEXT checkpoint
 * and costs nothing either — except in the FOUR check→syscall gaps, one
 * per destructive syscall in {@link rotateLogFile}, where that syscall is
 * already committed. (The lockfile's own release unlink was a FIFTH site
 * of the same shape and is NOT in this list because it no longer has the
 * shape: the unlink now names a park nobody else can reach, and identity
 * is decided by the atomic `rename` that produced that name, not by a
 * stat of `lockPath`. Release does open with a stat, but a mismatch there
 * only ever STOPS us — no destructive syscall runs on its say-so — so it
 * is not a check→syscall gap. #3600 round-7 H2, round-8 H2, above.) Those
 * four are not equivalent; each destroys something different:
 *
 *   1. check→`unlinkSync(<log>.<keep>)` — the oldest-generation drop.
 *      The peer's rotation has just shifted real history into that slot;
 *      our unlink deletes it. `.1` the peer's snapshot, `.2` GONE.
 *      ("does not shift the peer's fresh .1 off the end — but the unlink
 *      gap destroys its shifted history". Before round 6 the in-tree
 *      test seeded no `.1`, so the peer's own rotation had already
 *      removed `.2` and our unlink merely failed ENOENT — it passed on
 *      an error path and asserted nothing about this gap.) Round 7's
 *      copy-gate fix was swept onto this syscall too rather than
 *      point-fixed at the copy: the shrank-under-us evidence is the
 *      same evidence here, so a landing anywhere from the `held()` stat
 *      up to the GATE's stat now costs nothing ("declines the
 *      oldest-generation drop when the peer rotated after our lock
 *      check"). The residual is the gate's own stat→`unlink` window,
 *      with the outcome above.
 *   2. check→shift-`rename` — our rename moves the peer's fresh `.1`
 *      onto `.2`, over the history that was there. `.1` absent, `.2` the
 *      peer's snapshot. ("does not copy over the peer's .1") Gated the
 *      same way and for the same reason, once per loop iteration
 *      ("declines the shift when the peer rotated after our lock
 *      check"); residual likewise the gate's own stat→`rename` window.
 *   3. check→`copyFileSync` — the gap that WAS the worst of the four, and
 *      the one round 7 closed for every landing up to the gate's own stat
 *      (#3600 round-7, H1). The copy now carries a data-based gate
 *      symmetric to the truncate's: {@link rotateLogFile} measures the
 *      active file on ENTRY, re-stats it immediately before the copy, and
 *      declines if it SHRANK below that ("declines the copy when the peer
 *      rotated after our lock check"). Appends only grow an append-only
 *      log, so a shrink is someone else's truncate and nothing else.
 *      Round 6 declined this fix arguing it recovers no data because the
 *      peer's snapshot has already been overwritten by our copy; that is
 *      circular — the copy is the thing the gate skips. Driven at the
 *      START of the gap with a quiet peer, the gate turns `.1` empty /
 *      `.2` absent / active empty into `.1` carrying the peer's full
 *      snapshot: total loss → zero loss.
 *
 *      What survives is the gate's own stat→`copyFileSync` gap, where the
 *      severity still depends on the peer, not on us:
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
 *          held. The worst case inside this residual window does not
 *          shrink from "all history" to "one generation": it is still
 *          total loss. What the gate shrank is the window that reaches
 *          it — from [`held()` stat → copy] to [gate stat → copy] — not
 *          what it costs when it is reached.
 *   4. check→`truncateSync` — the only gap where WE destroy rows in the
 *      ACTIVE file (the quiet copy gap costs the same rows, but by
 *      overwriting the snapshot they had been moved to), and the only
 *      one with no next checkpoint behind it, because the truncate IS
 *      the last one. The
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
 *      it is a LENGTH test with a STRICT comparison (`liveBytes <
 *      snapshotBytes`), so a peer that rotates and then re-appends AT
 *      LEAST as many bytes as we snapshotted — exactly as many is enough,
 *      not merely more — is invisible to it. The boundary is deliberate:
 *      `<=` would decline the ordinary rotation, where nothing was
 *      appended between our copy and our truncate and the two sizes are
 *      equal by construction. It is asserted from both sides: "rotates
 *      normally when the lock is still ours" fails if the comparison is
 *      loosened, and "the truncate gate is blind to a peer that re-appends
 *      exactly what we snapshotted" (#3600 round-7, L2) fails if this
 *      sentence is. What the gate does cover is the ordinary shape of the
 *      landing: a peer that rotated leaves the active file shorter than
 *      our snapshot.
 *
 * So: the window shrinks from "the whole rotation" to "between two
 * adjacent syscalls", and reaching it needs a rotation that overruns
 * {@link ROTATE_LOCK_STALE_MS} AND a peer completing a full
 * reclaim-and-rotate inside a sub-microsecond inter-syscall gap. That is
 * why this is documented rather than closed. It is a narrowing of
 * PROBABILITY, not of consequence.
 *
 * One more residual, unrelated to the gaps and BROADER than them: if
 * `fstat` on our own lock fd failed, `ourIno` is null and `stillHeld()`
 * returns true unconditionally — we cannot verify, and refusing to ever
 * rotate is the worse failure. Note what that costs, because it is not
 * "one more gap": with a null `ourIno` there are no gaps because there
 * are no checks. All four `held()` sites pass, so the oldest-generation
 * unlink and every shift rename proceed unserialized in the same
 * rotation, and only the data-based gates can decline anything — and in
 * the interleaving that test drives, where the peer's rotation completes
 * before our entry stat, they see nothing shrink and decline nothing, so
 * the whole rotation runs unserialized. Release is affected too — it takes no park and
 * unlinks nothing, so our lock is left behind for the next arrival to
 * reclaim as stale. "At most ONE destructive syscall proceeds
 * unserialized", stated anywhere in this file, is a claim about the
 * `ourIno !== null` path only. Asserted in "an unverifiable lock fd drops
 * every lock checkpoint" (#3600 round-7, L1).
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
    let vanished = false;
    try {
      const p = fs.statSync(parked);
      mine =
        p.ino === observed.ino &&
        Date.now() - p.mtimeMs >= ROTATE_LOCK_STALE_MS;
    } catch {
      vanished = true; // a peer's sweep reaped our park — nothing to put back
    }
    if (vanished) return null;
    if (!mine) {
      // We parked a LIVE lock (a peer reclaimed between our stat and our
      // rename). Put it back without clobbering whatever is there now —
      // and unlink the park ONLY if that restore actually succeeded. The
      // release below carries the identical branch for the identical
      // reason (#3600 round-8, M1, swept here): `link` has three failure
      // modes, not one — EEXIST, EPERM/ENOSYS (a filesystem with no
      // hardlinks), ENOENT — and after the first two `parked` is the
      // peer's ONLY remaining name for its LIVE lock, so unlinking it
      // deletes a lock its holder still believes in. Leaving it is a named
      // file `sweepStaleParks` reaps.
      let restored = false;
      try {
        fs.linkSync(parked, lockPath);
        restored = true;
      } catch {
        /* EEXIST: a lock already exists at the path — that holder is
           covered. EPERM/ENOSYS: no hardlinks here. ENOENT: reaped. */
      }
      if (restored) {
        try {
          fs.unlinkSync(parked);
        } catch {
          /* best-effort */
        }
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
  }
  // Sweep only once the lock is HELD (#3600 round-4, L1) — but on EVERY
  // path that holds it, not just the reclaim (#3600 round-8, L1). Before
  // the reclaim's `open(wx)` we hold nothing — `lockPath` does not exist —
  // and a readdir plus N stat/unlink there would widen the rename→claim
  // interval the doc comment names as the breach, from ~2 syscalls to
  // 2 + O(parks). Here the path is locked either way and the sweep is free.
  //
  // It sits AFTER the whole acquire, not inside the EEXIST branch, because
  // the RELEASE park leaks a different shape: a crash between the release
  // `rename` and its cleanup `unlink` leaves NOTHING at `lockPath`, so the
  // next arrival's `open(wx)` SUCCEEDS and never enters the reclaim branch.
  // With the sweep reachable only from that branch, a release park could
  // survive every subsequent acquisition — an unbounded leak, which is
  // exactly what this function exists to rule out.
  sweepStaleParks(lockPath);
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
      // ENOENT. NOT the same as "our lock was destroyed": a park — ours,
      // a reclaimer's, or a releaser's — makes `lockPath` absent for a
      // syscall or two while our inode is alive and named elsewhere, so
      // this can be a SPURIOUS loss (#3600 round-8, H2). It is reported as
      // a loss anyway, deliberately: the alternative test (`fstat(fd).
      // nlink > 0` ⇒ "parked, not deleted") returns true for a holder a
      // stale reclaim is about to displace legitimately, which would let a
      // destructive syscall through in exactly the H1 interleaving these
      // checkpoints exist to stop. A spurious decline costs a rotation
      // cycle; a spurious proceed costs a generation.
      return false;
    }
  };
  try {
    return fn(stillHeld);
  } finally {
    // ORDER IS LOAD-BEARING: release under the guard FIRST, close after
    // (#3600 round-6, H3). The guard's whole content is "this inode is
    // ours", and that only means "our lock" while `fd` pins the inode.
    // Closing first frees it, and a peer's reclaim — park (`rename`),
    // unlink, `open(wx)` — is exactly the sequence that gets the number
    // handed straight back on a reusing filesystem. Reproduced on ext4
    // with the close first: the peer's brand-new LIVE lock carried our
    // inode number, the guard matched, and we unlinked it, leaving the log
    // with no lock at all. `log-rotation-race.test.ts`, "holds the lock fd
    // open through every destructive syscall", pins the ordering on any
    // filesystem by tagging the release syscalls with the fd's state.
    //
    // AND THE GUARD IS A PARK, NOT A STAT (#3600 round-7, H2). It used to
    // be `statSync(lockPath).ino === ourIno` followed by a separate
    // `unlinkSync(lockPath)` — two syscalls, so a peer reclaiming between
    // them had its brand-new LIVE lock deleted on our verdict about a file
    // that was no longer there. Reproduced on ext4 by firing the peer's
    // park→claim right after that stat: `existsSync(lock) === false`, the
    // log unlocked while the peer believed it held it — the same
    // observable failure H3 was fixed for. Ordering could not close it;
    // only deciding identity about a file NOBODY ELSE CAN NAME does.
    // `rename` gives us that atomically, so we take the file first and
    // judge it second, exactly as the stale reclaim above does. (The stat
    // in step 0 below does not walk that back: nothing destructive runs on
    // a match there — a match only means we go on to park and judge.)
    if (ourIno !== null) {
      // STEP 0 — a stat that can only rule the release OUT (#3600 round-8,
      // H2). A stat cannot prove the lock is still ours (that is the whole
      // reason for the park), but it CAN prove it is not: our own `fd` is
      // still open, so our inode cannot be freed and cannot be handed to
      // anything else, and nothing puts our inode back at `lockPath` once
      // something else is there. A mismatch here is therefore final, and we
      // return having touched NOTHING — no rename, so no window in which
      // `lockPath` is absent. That matters because the park's absence window
      // is not private to us: a legitimate holder's `stillHeld()` reads
      // ENOENT there and declines mid-rotation, and before this stat every
      // mismatched release — the ordinary outcome after our lock was
      // reclaimed, needing no third party at all — opened one under a peer
      // that was doing nothing wrong.
      let looksOurs = false;
      try {
        looksOurs = fs.statSync(lockPath).ino === ourIno;
      } catch {
        /* nothing at the path — nothing of ours left to release */
      }
      if (looksOurs) {
        const parked = `${lockPath}.stale.${process.pid}.${Math.random().toString(36).slice(2, 10)}`;
        let took = false;
        try {
          fs.renameSync(lockPath, parked);
          took = true;
        } catch {
          /* nothing at the path, or a peer parked it first — not ours */
        }
        if (took) {
          let mine = false;
          let vanished = false;
          try {
            mine = fs.statSync(parked).ino === ourIno;
          } catch {
            vanished = true; // a peer's sweep reaped our park — already gone
          }
          if (vanished) {
            // Nothing to restore and nothing to unlink: the sweep that
            // reaped it performed exactly the release we came here to do.
          } else if (mine) {
            try {
              fs.unlinkSync(parked);
            } catch {
              /* best-effort — the park name is unique to us */
            }
          } else {
            // We parked someone ELSE's live lock (a peer reclaimed in the
            // one-syscall gap above). Put it back without clobbering
            // whatever may have been created at the path since.
            let restored = false;
            try {
              fs.linkSync(parked, lockPath);
              restored = true;
            } catch {
              /* EEXIST: a lock already exists there — that holder is
                 covered. EPERM/ENOSYS: no hardlinks on this filesystem.
                 ENOENT: our park was reaped under us. */
            }
            if (restored) {
              // `parked` is now a second name for the peer's inode; drop it.
              try {
                fs.unlinkSync(parked);
              } catch {
                /* best-effort — the park name is unique to us */
              }
            }
            // NOT restored: `parked` is the peer's ONLY remaining name for
            // its live lock inode, so unlinking it here would destroy the
            // lock of a process that believes it holds it — the exact
            // damage park-verify exists to prevent, and worse than the
            // unconditional delete it replaced (#3600 round-8, M1). We
            // leave the park; `sweepStaleParks` reaps it.
          }
        }
      }
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
 * taken. There is no "keep ours" exemption: the caller runs this AFTER
 * unlinking its own park and after taking the lock, so our park is gone —
 * and in the one case it is not (that unlink failed), it IS a leak and
 * reaping it is correct. A peer mid-reclaim WILL hold an eligible
 * park, not merely can: `rename(2)` does not touch the file's mtime (it
 * modifies the directory, not the inode), so a park always carries the
 * mtime of the ancient lock it was made from and is therefore always
 * already past the cutoff. Reaping a concurrent reclaimer's park is the
 * common case, not an edge — the consequences below are what make that
 * acceptable, not its rarity. Reaping it makes that peer's step-2 stat
 * fail, so it declines and takes no lock. That is a missed rotation cycle
 * at worst; it cannot wedge the path or produce two rotators.
 *
 * The RELEASE park (#3600 round-7, H2) carries the same name shape on
 * purpose and leaks the same way on a crash — but it is NOT reached by the
 * same acquisition path, and for one round the reaping claim here was
 * simply false (#3600 round-8, L1). A crash between the release `rename`
 * and its cleanup `unlink` leaves NOTHING at `lockPath`, so the next
 * arrival's `open(wx)` SUCCEEDS and never takes the EEXIST reclaim branch
 * this sweep used to be nested in — the park survived every subsequent
 * acquisition, unbounded. The call site is therefore after the whole
 * acquire, on both paths, which is what makes "reaped the same way" true.
 *
 * Reaping a LIVE release park is harmless in a second way: that park IS
 * the releasing process's own lock inode, so unlinking it is precisely the
 * release that process was about to perform. Its `statSync(parked)` then
 * throws, which it reads as "vanished" — a case distinct from a mismatch,
 * so it attempts no restore and no unlink — and both agree the lock is
 * released. (The release's OTHER park — a peer's live lock, mismatched —
 * can also be reaped here, from the branch where its restore failed and it
 * deliberately left the file. That is the leak this sweep is for.)
 *
 * Entirely best-effort: every failure is swallowed, so this can never
 * throw out of the acquisition it runs inside.
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
 * `fsync` the freshly written snapshot and return its size, or `null` if
 * any step failed — in which case the caller must leave the active log
 * intact (#3600 round-7, L3).
 *
 * The `step` label is what makes the diagnostic honest: `open`, `fsync`
 * and `fstat` fail for different reasons (a vanished snapshot, a
 * filesystem that cannot flush, a bad fd), and reporting all three as
 * "could not fsync" sends the operator after the wrong one.
 */
function fsyncAndMeasure(
  snapshotPath: string,
  logPath: string,
  tag: string,
): number | null {
  let step = "open";
  try {
    const fd = fs.openSync(snapshotPath, "r");
    try {
      step = "fsync";
      fs.fsyncSync(fd);
      step = "measure";
      const size = fs.fstatSync(fd).size;
      // Reached only if both steps above succeeded, so if the `closeSync`
      // in the `finally` throws it replaces this return and "close" is the
      // right label. A throw from above skips this line and keeps its own.
      step = "close";
      return size;
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    process.stderr.write(
      `[${tag}] ERROR: could not ${step} snapshot ${snapshotPath}; leaving active log ${logPath} intact to avoid data loss: ${(err as Error).message}\n`,
    );
    return null;
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
 * H2).
 *
 * That is survivable ONLY because nothing acts on the boolean, so the
 * callers are enumerated here rather than gestured at (#3600 round-7, L4).
 * Three call sites reach this function and all three discard the result:
 * `src/host-control/server.ts` (`maybeRotateAuditLog`),
 * `src/web/webhook-gateway-record.ts` and `src/web/webhook-handler.ts`
 * (both via `rotateWebhookLogIfNeeded`). Two module-level wrappers sit in
 * between, and NEITHER propagates the value any more:
 * `rotateAuditLog` in `src/vault/broker/audit-log.ts` — a fourth caller,
 * missing from this list until round 7, and the only one that calls
 * `rotateLogFile` directly rather than through {@link maybeRotateLogFile},
 * i.e. on the unlocked path — has always returned `void`, and
 * `rotateWebhookLogIfNeeded` was changed to return `void` in round 7 for
 * the same reason. A wrapper that returns the boolean is an invitation for
 * some future `if (rotated)` to inherit a value this doc block spends a
 * paragraph explaining you cannot trust; making the type `void` stops that
 * deterministically instead of asking a later reader to re-derive it.
 *
 * `stillHeld`, when supplied by {@link withRotateLock}, is re-asserted
 * immediately before EVERY destructive syscall — the oldest-generation
 * unlink, each shift rename, the `copyFileSync` that overwrites `.1`, and
 * the `truncate` that destroys live rows (#3600 round-4, H1) — and EVERY
 * one of those four carries a second, data-based gate on top: the shared
 * `notRotatedUnderUs` shrank-since-entry check on the unlink, the shifts
 * and the copy (round-7 H1 and its sibling sweep), and the tighter
 * shrank-since-the-snapshot check on the truncate (round-6 H2).
 * A holder that overran the stale threshold can
 * have its live lock legitimately reclaimed by a peer; if that happened we
 * are no longer serialized against that peer, and continuing would rename
 * its fresh `.1` off the end of the window, copy a truncated active file
 * over it, and truncate rows written after its rotation.
 *
 * Per-syscall rather than once at the top because a reclaim can land at
 * any point inside the rotation, and each check is one `stat` against a
 * handful of syscalls. It is a narrowing, not a proof — a reclaim landing
 * between a check and the syscall it guards is uncaught for that syscall,
 * so at most ONE proceeds unserialized, WHEN `stillHeld` can verify
 * anything: {@link withRotateLock} hands us a predicate that is a constant
 * `true` if the `fstat` on its lock fd failed, and then all four checks
 * are no-ops and the count is unbounded (#3600 round-7, L1 — asserted in
 * "an unverifiable lock fd drops every lock checkpoint"). "At most one
 * syscall" bounds the COUNT and nothing else: depending on which of the
 * four gaps it lands in, that one syscall costs a generation of history,
 * the peer's live rows, or — the residual copy gap with a quiet peer —
 * every byte the log has. {@link withRotateLock} enumerates all four with
 * the test that asserts each.
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
  // The size of the active file as we FOUND it, measured before we touch
  // anything. This is the baseline for the data gate below (#3600 round-7,
  // H1) and it has to be taken here, on entry: by the time we reach the
  // copy we have already spent the whole unlink-and-shift sequence, which
  // is exactly the interval a peer's rotation lands in.
  //
  // A stat that fails here means we cannot read the file we are about to
  // snapshot; the copy would fail anyway, and declining now keeps the
  // guarantee `false` carries — the active file is exactly as we found it —
  // while touching no generation at all.
  let entryBytes: number;
  try {
    entryBytes = fs.statSync(logPath).size;
  } catch (err) {
    process.stderr.write(
      `[${tag}] ERROR: could not stat active log ${logPath} before rotating it: ${(err as Error).message}\n`,
    );
    return false;
  }
  /**
   * True iff the active file has not SHRUNK since we entered — i.e. no
   * peer has rotated it under us (#3600 round-7, H1 and its sibling
   * sweep). Warns once per refusal.
   *
   * This is the data-based half of every checkpoint, and it is deliberately
   * NOT limited to the copy the review asked for: the unlink, the shifts
   * and the copy each destroy something a peer's completed rotation just
   * put there, and one observable — an append-only log that got shorter —
   * is evidence of exactly that for all three. Applying it at one site and
   * not the other two would leave the same class of loss (the peer's
   * shifted history at `<log>.<keep>`, the peer's fresh `.1`) behind a
   * lock check that provably does not cover it.
   *
   * It is evidence, not proof, and it fails in one direction only: a peer
   * that rotated and then re-appended at least `entryBytes` is invisible,
   * and a file that shrank for any other reason (an operator truncating
   * the log by hand) makes us decline a rotation, which costs nothing but
   * a cycle. The truncate has its own, TIGHTER version of this gate below,
   * comparing against the snapshot we actually wrote rather than against
   * the entry size.
   */
  const notRotatedUnderUs = (what: string): boolean => {
    let live: number;
    try {
      live = fs.statSync(logPath).size;
    } catch (err) {
      process.stderr.write(
        `[${tag}] ERROR: could not re-stat active log ${logPath}; declining to ${what}: ${(err as Error).message}\n`,
      );
      return false;
    }
    if (live < entryBytes) {
      process.stderr.write(
        `[${tag}] WARN: active log ${logPath} shrank from ${entryBytes} to ${live} bytes while we were rotating it; another rotator snapshotted it and these generations are its, not ours — declining to ${what}\n`,
      );
      return false;
    }
    return true;
  };
  // Delete the oldest retained generation — it falls off the window.
  const oldest = `${logPath}.${keep}`;
  if (fs.existsSync(oldest)) {
    if (!held(`drop ${oldest}`)) return false;
    if (!notRotatedUnderUs(`drop ${oldest}`)) return false;
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
    if (!notRotatedUnderUs(`shift ${from} → ${to}`)) return false;
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
  // A SECOND, DATA-BASED checkpoint on the copy (#3600 round-7, H1),
  // exactly symmetric to the one on the truncate below and justified the
  // same way: an append-only log only GROWS, so an active file that has
  // shrunk since we entered is not our file getting shorter, it is a peer
  // having rotated it under us. Its `.1` is that peer's snapshot and its
  // active file is that peer's freshly-truncated zero bytes; copying now
  // writes those zero bytes over the snapshot and loses every byte the log
  // has ("loses EVERY byte…", round-6 H1).
  //
  // Round 6 rejected a fix here on the reasoning that it recovers no data
  // because the peer's snapshot is already overwritten by our copy. That
  // reasoning is circular — the copy is the thing this declines — and it
  // only ever refuted the shape it considered (snapshot to a temp name and
  // rename it into place, which still lands zero bytes on `.1`). Skipping
  // the copy leaves `.1` holding the peer's full snapshot: total loss
  // becomes zero loss, asserted in "declines the copy when the peer
  // rotated after our lock check" and its quiet-peer twin.
  //
  // Same two residuals as the truncate gate, for the same two reasons: it
  // is a stat followed by a separate `copyFileSync`, so a landing in THAT
  // gap is caught by nothing ("loses a generation…" / "loses EVERY
  // byte…"), and it is a strict length comparison, so a peer that rotates
  // and re-appends at least `entryBytes` is invisible to it.
  if (!notRotatedUnderUs(`overwrite ${snapshotPath}`)) return false;
  try {
    fs.copyFileSync(logPath, snapshotPath);
  } catch (err) {
    process.stderr.write(
      `[${tag}] ERROR: could not snapshot active log ${logPath} → ${snapshotPath}: ${(err as Error).message}\n`,
    );
    return false;
  }
  // Durably persist the snapshot before destroying the source, and measure
  // it — the truncate gate below needs its size.
  //
  // Three syscalls, three different causes, ONE diagnostic, so the
  // diagnostic names which one failed (#3600 round-7, L3: an `fstat`
  // failure used to be reported as "could not fsync", pointing an operator
  // at durability when the problem was measurement). Returning `null`
  // rather than a sentinel size is the other half of that finding: a
  // `-1` that every failure path skips over is a degraded mode that cannot
  // occur, and a `snapshotBytes >= 0` test downstream reads as a guard
  // against something reachable. It is not, so there is no such test and
  // no such value — a failure returns here.
  const snapshotBytes = fsyncAndMeasure(snapshotPath, logPath, tag);
  if (snapshotBytes === null) return false;
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
  // round-6, H2), the twin of the pre-copy gate above. It narrows the
  // truncate gap; it does not close it — nothing here can, and the tests
  // pin both halves of that.
  //
  // Why a second one at all: the truncate gap is the only gap with no
  // NEXT checkpoint to catch what slipped through, because this is the
  // last one, and the only one where WE destroy rows in the active file
  // itself. A peer that reclaims after `held()`'s stat, rotates,
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
  //   · a peer that rotates AND re-appends AT LEAST `snapshotBytes` before
  //     we stat is invisible to a length test — the comparison below is
  //     strict, so landing on exactly `snapshotBytes` passes too, not only
  //     overshooting it (#3600 round-7, L2). Strict is the correct
  //     comparison, not an oversight: in the ordinary rotation nothing is
  //     appended between the copy and here and the two sizes are EQUAL, so
  //     `<=` would decline every rotation this module performs. Both sides
  //     are asserted — "rotates normally when the lock is still ours"
  //     fails if this becomes `<=`, and "the truncate gate is blind to a
  //     peer that re-appends exactly what we snapshotted" fails if this
  //     bullet is written as "more than".
  let liveBytes: number;
  try {
    liveBytes = fs.statSync(logPath).size;
  } catch (err) {
    process.stderr.write(
      `[${tag}] ERROR: could not re-stat active log ${logPath} before truncating; leaving it intact to avoid data loss: ${(err as Error).message}\n`,
    );
    return false;
  }
  if (liveBytes < snapshotBytes) {
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
  // worse one. Every caller discards the value and no wrapper propagates
  // it any more (enumerated in this function's doc block, #3600 round-7,
  // L4), so this stderr line, not the boolean, is the operator-visible
  // channel.
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
