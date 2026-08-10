/**
 * Orphaned-DB-fd sweep — detect and recover from a SQLite handle that is
 * still writing into DELETED inodes.
 *
 * THE FAILURE MODE
 * ----------------
 * The gateway holds `history.db` (bun:sqlite, WAL) open for the process
 * lifetime. A FOREIGN process rw-opened the same DB, and on exit — as the
 * last connection — SQLite checkpointed and UNLINKED `history.db-wal` and
 * `history.db-shm`. Our long-lived connection kept the deleted inodes mapped
 * and kept writing into them for 3h06m, logging success on every insert. The
 * rows were never on disk; they vanished at the next restart. The signature is
 * visible from the process itself:
 *
 *     /proc/<pid>/fd/13 -> /…/history.db-wal (deleted)
 *
 * Nothing in the write path can notice this: `INSERT` returns success, the
 * boot-time `verifyHistoryWritable()` self-check already ran hours earlier, and
 * a WAL checkpoint through the stale mapping "succeeds" too. The only in-process
 * evidence is the fd table, so that is what we poll.
 *
 * WHAT THIS DOES
 * --------------
 * Every 5 minutes, walk `/proc/self/fd` and look for a link whose target is a
 * `*.db` (or `-wal`/`-shm`/`-journal` sidecar) file inside the gateway's state
 * dir marked `(deleted)`. On a hit:
 *
 *   - Log LOUDLY that rows written since the last checkpoint are LOST. Silent
 *     data loss becomes a visible operator signal bounded to one sweep interval.
 *   - `history.db`: hard-close-drop-reopen via `reopenHistory()`. Read the long
 *     note there before touching it — a plain `close()` is NOT enough (it does
 *     not release the fds, and the reopened connection then throws on the first
 *     WRITE), and there is deliberately no salvage checkpoint through the
 *     orphaned handle. If the reopen throws, we say so and ask for a restart
 *     rather than claim a recovery that did not happen.
 *   - `registry.db`: alarm only, RESTART REQUIRED. The registry handle
 *     (`turnsDb`) is captured BY VALUE into long-lived wiring in `gateway.ts`
 *     (the subagent-watcher options object among others), so a close-and-
 *     reassign would leave those consumers holding a CLOSED handle — strictly
 *     worse than the orphaned one. Detection without action is the honest
 *     behaviour here; the operator restarts.
 *   - anything else `*.db` in the state dir: alarm only, RESTART REQUIRED. No
 *     lane owns it, so the honest answer is to name the file and say so rather
 *     than raise a data-loss alarm with no instruction attached.
 *
 * AND ONE THING THAT IS NOT FD-DRIVEN
 * -----------------------------------
 * A reopen that hard-closes the old handle and then fails to re-init leaves
 * history NULL and the orphaned fds GONE — so fd detection can never fire
 * again, and a "FAILED to reopen" line printed once at 03:00 would be the only
 * record of a permanent outage. Every tick therefore also checks the sticky
 * `getHistoryReopenFailure()` flag, alarms on it, and retries the reopen,
 * independently of what the fd table says.
 *
 * WHY THE SCAN IS ASYNC
 * ---------------------
 * The walk is O(open fds) — measured at 10-13ms against a live gateway holding
 * 3366 fds, and `RLIMIT_NOFILE` on the fleet is 524288, so the cost is
 * unbounded by anything we control. A synchronous readdir+readlink loop of that
 * shape blocks the event loop, i.e. stalls inbound Telegram handling, for a
 * check that finds nothing 99.99% of the time. `fs/promises` `opendir` +
 * `readlink` yields between entries, so a long scan costs latency on the sweep
 * (which nobody is waiting for) instead of on the gateway. The alternative —
 * probing only the known DB paths — was rejected: it cannot tell "the file is
 * gone" from "we still hold the gone file open", which is the entire signal.
 *
 * Dependency-free on purpose (`fs` + `path` only) so it loads identically under
 * `bun test` and vitest, and so the recovery path cannot itself be broken by a
 * transitive import that touches the DB.
 */

import { realpathSync } from 'fs'
import { opendir, readlink } from 'fs/promises'
import { basename } from 'path'

/** A `/proc/self/fd` entry pointing at a deleted DB file in the state dir. */
export interface OrphanedFd {
  fd: number
  /** The raw readlink target, including the trailing ` (deleted)` marker. */
  target: string
}

/** Linux marks an unlinked-but-open fd's readlink target with this suffix. */
const DELETED_SUFFIX = ' (deleted)'

/**
 * A SQLite database file or one of its sidecars, and nothing else.
 *
 * The previous `basename.includes('.db')` test also matched `notes.dbg`,
 * `dump.dbf`, `history.db.bak` and `x.dbus` — an unrelated deleted temp file in
 * the state dir would have raised a "rows are LOST" alarm. Anchored to the end
 * of the basename so only a real `*.db` / `*.db-wal` / `*.db-shm` /
 * `*.db-journal` matches.
 */
const DB_BASENAME_RE = /\.db(-wal|-shm|-journal)?$/

/**
 * Canonicalise the state dir for prefix matching against `/proc` targets.
 *
 * `/proc/self/fd` targets are ALWAYS fully resolved, so comparing them against
 * a `TELEGRAM_STATE_DIR` that is a symlink (or relative) makes every
 * `startsWith` fail and disables detection permanently — with no error, no log,
 * and a sweep that reports "healthy" forever. Returns null when the path cannot
 * be resolved at all, which callers surface as a warning rather than silence.
 */
export function resolveStateDirPrefix(stateDir: string): string | null {
  let resolved: string
  try {
    resolved = realpathSync(stateDir)
  } catch {
    return null
  }
  return resolved.endsWith('/') ? resolved : resolved + '/'
}

/**
 * Scan `/proc/self/fd` for handles onto deleted DB files under `stateDir`.
 *
 * Returns `[]` — never throws — on non-Linux (no `/proc`), on an unreadable or
 * unresolvable `stateDir`, on an unreadable `/proc/self/fd`, and for any
 * individual fd that races closed between the directory read and the
 * `readlink`.
 *
 * A match requires ALL THREE of:
 *   1. the target is inside the CANONICAL `stateDir` (so an unrelated deleted
 *      DB elsewhere on the box is not our problem),
 *   2. the target ends with ` (deleted)` (a healthy open WAL is NOT an orphan),
 *   3. the basename is a SQLite file or sidecar (an unrelated deleted temp file
 *      in the state dir must not raise a data-loss alarm).
 */
export async function detectOrphanedDbFds(stateDir: string): Promise<OrphanedFd[]> {
  if (process.platform !== 'linux') return []
  const prefix = resolveStateDirPrefix(stateDir)
  if (prefix == null) return []
  const found: OrphanedFd[] = []
  try {
    const dir = await opendir('/proc/self/fd')
    for await (const entry of dir) {
      let target: string
      try {
        target = await readlink(`/proc/self/fd/${entry.name}`)
      } catch {
        // The fd closed underneath us (including the directory handle's own
        // fd). Not an orphan; just gone.
        continue
      }
      // Parse FIRST, then filter. Doing the `slice` inside the deleted-check
      // would make the basename test below silently do the deleted-check's job
      // too (slicing 10 chars off a healthy `…/history.db-wal` yields `…/hist`,
      // which fails the DB test by accident) — and an accidental guard is one
      // nobody can mutation-test or safely refactor.
      const deleted = target.endsWith(DELETED_SUFFIX)
      const bare = deleted ? target.slice(0, -DELETED_SUFFIX.length) : target
      if (!bare.startsWith(prefix)) continue
      if (!deleted) continue
      if (!DB_BASENAME_RE.test(basename(bare))) continue
      found.push({ fd: Number(entry.name), target })
    }
  } catch {
    return found
  }
  return found
}

/** Strip the ` (deleted)` marker and return the bare file name. */
function orphanBasename(target: string): string {
  return basename(target.endsWith(DELETED_SUFFIX) ? target.slice(0, -DELETED_SUFFIX.length) : target)
}

export interface OrphanedDbSweepOptions {
  /** The gateway state dir whose DB files we own. */
  stateDir: string
  /**
   * Recovery for `history.db`. Omit when history is disabled — detection and
   * the loud log still run, only the reopen is skipped.
   */
  reopenHistory?: () => void
  /**
   * The sticky "history is dead" flag (`history.getHistoryReopenFailure`).
   * Checked on EVERY tick, not only when an orphaned fd is found: once a
   * reopen has closed the old handle the fds are released, so fd detection can
   * no longer see the outage it caused. Omit only where history is not wired.
   */
  historyReopenFailure?: () => string | null
  /** Log sink. The gateway passes `(l) => process.stderr.write(l)`. */
  log: (line: string) => void
}

/**
 * One sweep tick: detect, alarm, and recover. Returns the orphans found (empty
 * on the healthy path, which is every tick but the incident one).
 *
 * Never throws — a failed reopen is logged and the next tick retries. That
 * promise is only meaningful because of the sticky-failure lane below: a reopen
 * whose close succeeded but whose re-init failed releases the very fds that
 * would have triggered the next retry.
 */
export async function runOrphanedDbSweepTick(
  opts: OrphanedDbSweepOptions,
): Promise<OrphanedFd[]> {
  if (process.platform === 'linux' && resolveStateDirPrefix(opts.stateDir) == null) {
    opts.log(
      `telegram gateway: orphaned-db-sweep cannot resolve stateDir=${opts.stateDir} —`
      + ` deleted-inode DB detection is DISABLED until it exists and is readable.\n`,
    )
  }
  const orphans = await detectOrphanedDbFds(opts.stateDir)
  let historyHandled = false

  if (orphans.length > 0) {
    const names = orphans.map((o) => orphanBasename(o.target))
    opts.log(
      `telegram gateway: orphaned-db-sweep DETECTED ${orphans.length} deleted-inode DB handle(s): `
      + orphans.map((o) => `fd=${o.fd} ${o.target}`).join(', ')
      + ` — another process unlinked these files while we held them open; every row written`
      + ` since the last checkpoint is LOST and further writes would be lost too.\n`,
    )

    if (names.some((n) => n.startsWith('history.db'))) {
      historyHandled = true
      if (opts.reopenHistory) {
        attemptHistoryReopen(opts, 'reopened history.db')
      } else {
        opts.log(
          `telegram gateway: orphaned-db-sweep found an orphaned history.db handle but no reopen`
          + ` is wired (history disabled) — RESTART the gateway to recover.\n`,
        )
      }
    }

    if (names.some((n) => n.startsWith('registry.db'))) {
      opts.log(
        `telegram gateway: orphaned-db-sweep found an orphaned registry.db handle. An in-process`
        + ` reopen is NOT safe here — the turnsDb handle is captured by value into long-lived`
        + ` wiring, so closing it would leave those consumers on a closed handle. RESTART the`
        + ` gateway to recover; subagent/turn rows written since the last checkpoint are LOST.\n`,
      )
    }

    // Anything else under the state dir has no lane. Say so explicitly: an
    // unnamed data-loss alarm with no recovery instruction is worse than none.
    const unowned = [...new Set(names.filter(
      (n) => !n.startsWith('history.db') && !n.startsWith('registry.db'),
    ))]
    if (unowned.length > 0) {
      opts.log(
        `telegram gateway: orphaned-db-sweep found orphaned handle(s) on ${unowned.join(', ')},`
        + ` which no recovery lane owns — the gateway cannot reopen them in place. RESTART the`
        + ` gateway to recover; rows written to those files since the last checkpoint are LOST.\n`,
      )
    }
  }

  // The fd table cannot see a history DB that is already closed and failed to
  // re-open, so this lane runs whether or not anything was detected.
  if (!historyHandled) {
    const stuck = opts.historyReopenFailure?.()
    if (stuck != null && stuck !== '') {
      opts.log(
        `telegram gateway: orphaned-db-sweep history.db is CLOSED and a previous reopen failed`
        + ` (${stuck}) — every history read and write is dead and no fd evidence remains.`
        + ` Retrying the reopen; RESTART the gateway if this keeps repeating.\n`,
      )
      if (opts.reopenHistory) attemptHistoryReopen(opts, 'recovered history.db')
    }
  }

  return orphans
}

/**
 * Run the wired reopen, logging honestly either way. `successVerb` distinguishes
 * the first-detection recovery from the sticky-failure retry in the log.
 */
function attemptHistoryReopen(opts: OrphanedDbSweepOptions, successVerb: string): void {
  try {
    opts.reopenHistory?.()
    opts.log(
      `telegram gateway: orphaned-db-sweep ${successVerb} — writes are durable again`
      + ` (proved by the post-reopen writer self-check); rows written since the last`
      + ` checkpoint are NOT recoverable.\n`,
    )
  } catch (err) {
    opts.log(
      `telegram gateway: orphaned-db-sweep FAILED to reopen history.db: ${(err as Error).message}`
      + ` — history writes are NOT durable; RESTART the gateway.\n`,
    )
  }
}

/** Default cadence: bounds silent loss to 5 minutes without polling cost. */
const DEFAULT_INTERVAL_MS = 5 * 60_000

/**
 * Start the periodic sweep. Returns a `stop()` so tests can tear it down;
 * production never stops it (matches every sibling gateway interval).
 *
 * `unref()`s so the timer cannot hold the process alive past shutdown. Ticks do
 * not overlap: the scan is async, so a slow `/proc` walk on a process holding
 * hundreds of thousands of fds must not stack up behind itself.
 */
export function startOrphanedDbSweep(
  opts: OrphanedDbSweepOptions & { intervalMs?: number },
): () => void {
  let running = false
  const timer = setInterval(() => {
    if (running) return
    running = true
    void runOrphanedDbSweepTick(opts)
      .catch(() => { /* a sweep must never take the gateway down; next tick retries */ })
      .finally(() => { running = false })
  }, opts.intervalMs ?? DEFAULT_INTERVAL_MS)
  timer.unref?.()
  return () => clearInterval(timer)
}
