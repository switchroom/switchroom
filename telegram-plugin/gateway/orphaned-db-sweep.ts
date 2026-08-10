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
 * `*.db*` file inside the gateway's state dir marked `(deleted)`. On a hit:
 *
 *   - Log LOUDLY that rows written since the last checkpoint are LOST. Silent
 *     data loss becomes a visible operator signal bounded to one sweep interval.
 *   - `history.db`: hard-close-drop-reopen via `reopenHistory()`. Read the long
 *     note there before touching it — a plain `close()` is NOT enough (it does
 *     not release the fds, and the reopen then fails `SQLITE_IOERR_SHORT_READ`),
 *     and there is deliberately no salvage checkpoint through the orphaned
 *     handle. If the reopen throws, we say so and ask for a restart rather than
 *     claim a recovery that did not happen.
 *   - `registry.db`: alarm only, RESTART REQUIRED. The registry handle
 *     (`turnsDb`) is captured BY VALUE into long-lived wiring in `gateway.ts`
 *     (the subagent-watcher options object among others), so a close-and-
 *     reassign would leave those consumers holding a CLOSED handle — strictly
 *     worse than the orphaned one. Detection without action is the honest
 *     behaviour here; the operator restarts.
 *
 * Dependency-free on purpose (`fs` + `path` only) so it loads identically under
 * `bun test` and vitest, and so the recovery path cannot itself be broken by a
 * transitive import that touches the DB.
 */

import { readdirSync, readlinkSync } from 'fs'
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
 * Scan `/proc/self/fd` for handles onto deleted DB files under `stateDir`.
 *
 * Returns `[]` — never throws — on non-Linux (no `/proc`), on an unreadable
 * `/proc/self/fd`, and for any individual fd that races closed between the
 * `readdir` and the `readlink`.
 *
 * A match requires ALL THREE of:
 *   1. the target is inside `stateDir` (so an unrelated deleted DB elsewhere on
 *      the box is not our problem),
 *   2. the target ends with ` (deleted)` (a healthy open WAL is NOT an orphan),
 *   3. the basename contains `.db` (an unrelated deleted temp file in the state
 *      dir must not raise a data-loss alarm).
 */
export function detectOrphanedDbFds(stateDir: string): OrphanedFd[] {
  if (process.platform !== 'linux') return []
  let entries: string[]
  try {
    entries = readdirSync('/proc/self/fd')
  } catch {
    return []
  }
  const prefix = stateDir.endsWith('/') ? stateDir : stateDir + '/'
  const found: OrphanedFd[] = []
  for (const entry of entries) {
    let target: string
    try {
      target = readlinkSync(`/proc/self/fd/${entry}`)
    } catch {
      // The fd closed underneath us (including the readdir's own fd). Not an
      // orphan; just gone.
      continue
    }
    // Parse FIRST, then filter. Doing the `slice` inside the deleted-check
    // would make the `.db` test below silently do the deleted-check's job too
    // (slicing 10 chars off a healthy `…/history.db-wal` yields `…/hist`,
    // which fails `.includes('.db')` by accident) — and an accidental guard is
    // one nobody can mutation-test or safely refactor.
    const deleted = target.endsWith(DELETED_SUFFIX)
    const bare = deleted ? target.slice(0, -DELETED_SUFFIX.length) : target
    if (!bare.startsWith(prefix)) continue
    if (!deleted) continue
    if (!basename(bare).includes('.db')) continue
    found.push({ fd: Number(entry), target })
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
  /** Log sink. The gateway passes `(l) => process.stderr.write(l)`. */
  log: (line: string) => void
}

/**
 * One sweep tick: detect, alarm, and recover. Returns the orphans found (empty
 * on the healthy path, which is every tick but the incident one).
 *
 * Never throws — a failed reopen is logged and the next tick retries.
 */
export function runOrphanedDbSweepTick(opts: OrphanedDbSweepOptions): OrphanedFd[] {
  const orphans = detectOrphanedDbFds(opts.stateDir)
  if (orphans.length === 0) return orphans

  const names = orphans.map((o) => orphanBasename(o.target))
  opts.log(
    `telegram gateway: orphaned-db-sweep DETECTED ${orphans.length} deleted-inode DB handle(s): `
    + orphans.map((o) => `fd=${o.fd} ${o.target}`).join(', ')
    + ` — another process unlinked these files while we held them open; every row written`
    + ` since the last checkpoint is LOST and further writes would be lost too.\n`,
  )

  if (names.some((n) => n.startsWith('history.db'))) {
    if (opts.reopenHistory) {
      try {
        opts.reopenHistory()
        opts.log(
          `telegram gateway: orphaned-db-sweep reopened history.db — writes are durable again;`
          + ` rows written since the last checkpoint are NOT recoverable.\n`,
        )
      } catch (err) {
        opts.log(
          `telegram gateway: orphaned-db-sweep FAILED to reopen history.db: ${(err as Error).message}`
          + ` — history writes are still going to a deleted inode; RESTART the gateway.\n`,
        )
      }
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

  return orphans
}

/** Default cadence: bounds silent loss to 5 minutes without polling cost. */
const DEFAULT_INTERVAL_MS = 5 * 60_000

/**
 * Start the periodic sweep. Returns a `stop()` so tests can tear it down;
 * production never stops it (matches every sibling gateway interval).
 *
 * `unref()`s so the timer cannot hold the process alive past shutdown.
 */
export function startOrphanedDbSweep(
  opts: OrphanedDbSweepOptions & { intervalMs?: number },
): () => void {
  const timer = setInterval(() => {
    try {
      runOrphanedDbSweepTick(opts)
    } catch {
      /* a sweep must never take the gateway down; next tick retries */
    }
  }, opts.intervalMs ?? DEFAULT_INTERVAL_MS)
  timer.unref?.()
  return () => clearInterval(timer)
}
