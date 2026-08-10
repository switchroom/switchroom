/**
 * Outcome coverage for the orphaned-DB-fd sweep
 * (`gateway/orphaned-db-sweep.ts` + `history.reopenHistory`).
 *
 * The core test REPRODUCES THE INCIDENT rather than mocking it: it opens a real
 * history.db, checkpoints (standing in for the foreign process's exit
 * checkpoint), unlinks the `-wal`/`-shm` out from under the live connection,
 * and then proves both halves of the defect — the write still "succeeds", and
 * the row is NOT in the on-disk database. No timers, no sleeps, no timing
 * dependence.
 *
 * TWO MEASURED FACTS THIS TEST IS BUILT AROUND (both verified on bun 1.3.13,
 * both of which invalidate the obvious way to write it):
 *
 *  1. During the orphan window a SECOND live connection to the same file cannot
 *     be opened at all — it fails `SQLITE_IOERR_SHORT_READ`, because SQLite's
 *     unix VFS keeps per-inode WAL-index state shared across connections in the
 *     process. So the "is it on disk?" probe CANNOT be a second `new Database`
 *     on the live path. It is instead a `snapshotOnDisk()` that copies
 *     `history.db` (+ `-wal` when one exists) to a scratch dir and opens the
 *     COPY — a different inode, and a faithful reading of what is durably on
 *     disk. A separate PROCESS opening the original reads the same thing, which
 *     is how we know the on-disk DB is not corrupt.
 *
 *  2. bun:sqlite's plain `db.close()` is a SOFT close that does not release the
 *     fds while per-call prepared statements are un-finalized. `reopenHistory`
 *     therefore does a hard close (`Bun.gc(true)` + `close(true)`); the
 *     regression assertion for that is `detectOrphanedDbFds(stateDir)` being
 *     EMPTY after recovery. A soft-close implementation leaves the deleted-inode
 *     fds open and fails that assertion.
 *
 * WHAT CANNOT BE TESTED DETERMINISTICALLY HERE, and what covers it instead:
 *
 *  - The non-Linux early return in `detectOrphanedDbFds`. `/proc/self/fd` only
 *    exists on Linux; the guard is a platform branch a Linux CI runner cannot
 *    enter. Covered by code shape (a single `process.platform` check).
 *  - The 5-minute production cadence. Asserted only as "the interval can be
 *    started and stopped"; waiting 5 minutes would be a timing dependence, not
 *    a proof.
 *  - The `gateway.ts` wiring line. gateway.ts boots a live gateway on import
 *    and is not unit-importable. Covered by `tsc --noEmit` for the call shape
 *    and `check-gateway-line-ratchet` for the size budget.
 *  - The no-corrupting-checkpoint property (that recovery never issues an
 *    explicit WAL checkpoint through the orphaned handle). Enforced by CODE
 *    SHAPE — there is no `wal_checkpoint` anywhere in `reopenHistory` — not by
 *    an assertion. A test cannot distinguish a safe checkpoint from a
 *    corrupting one without provoking real corruption.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, unlinkSync, copyFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
// bun-only (this file is vitest-excluded and runs under `bun test`): the
// on-disk snapshot probe, and the raw registry.db handle for the
// detection-only lane.
import { Database } from 'bun:sqlite'
import {
  initHistory,
  reopenHistory,
  recordInbound,
  checkpointWal,
  query,
  verifyHistoryWritable,
  _resetForTests,
} from '../history.js'
import {
  detectOrphanedDbFds,
  runOrphanedDbSweepTick,
  startOrphanedDbSweep,
} from '../gateway/orphaned-db-sweep.js'

let stateDir: string
const scratchDirs: string[] = []

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'orphaned-db-sweep-test-'))
})

afterEach(() => {
  try { _resetForTests() } catch { /* an orphaned handle may refuse to close */ }
  for (const d of scratchDirs.splice(0)) rmSync(d, { recursive: true, force: true })
  if (existsSync(stateDir)) rmSync(stateDir, { recursive: true, force: true })
})

/**
 * What a RESTART would see: copy the durable files to a scratch dir (a fresh
 * inode, sidestepping the in-process WAL-index poisoning documented above) and
 * read the copy. Deliberately does NOT go through the module singleton, whose
 * writes may be landing in a deleted inode.
 */
function snapshotOnDisk(): number[] {
  const dir = mkdtempSync(join(tmpdir(), 'orphaned-db-sweep-snap-'))
  scratchDirs.push(dir)
  const src = join(stateDir, 'history.db')
  const dst = join(dir, 'history.db')
  copyFileSync(src, dst)
  if (existsSync(src + '-wal')) copyFileSync(src + '-wal', dst + '-wal')
  const probe = new Database(dst)
  try {
    const rows = probe.prepare('SELECT message_id FROM messages ORDER BY message_id').all() as {
      message_id: number
    }[]
    return rows.map((r) => r.message_id)
  } finally {
    probe.close()
  }
}

/**
 * `ts` must be recent — `initHistory`'s retention prune runs on every (re)open
 * and would delete rows backdated past the retention window, which would make
 * the post-reopen assertions lie.
 */
function inbound(messageId: number, text: string): void {
  recordInbound({
    chat_id: '900001',
    thread_id: null,
    message_id: messageId,
    user: 'tester',
    user_id: '900001',
    ts: Math.floor(Date.now() / 1000),
    text,
  })
}

/** Unlink the WAL sidecars out from under the live connection, as the incident did. */
function unlinkSidecars(dbFile: string): void {
  for (const suffix of ['-wal', '-shm']) {
    const f = dbFile + suffix
    expect(existsSync(f)).toBe(true)
    unlinkSync(f)
  }
}

describe('orphaned-db-sweep — history.db recovery', () => {
  it('reproduces the deleted-inode data loss and restores durable writes', () => {
    const dbFile = join(stateDir, 'history.db')
    initHistory(stateDir, 30)

    // 1. A row that reaches the main DB via a checkpoint. The checkpoint stands
    //    in for the foreign process's checkpoint-on-last-close.
    inbound(1001, 'row A — before the unlink')
    expect(checkpointWal()).toBe(true)

    // 2. That foreign process's exit ALSO unlinked the sidecars. Our live
    //    connection keeps the deleted inodes mapped.
    unlinkSidecars(dbFile)

    // 3. THE DEFECT, half one: the write path still reports success.
    expect(() => inbound(1002, 'row B — into the deleted inode')).not.toThrow()

    // 4. THE DEFECT, half two: row B never reached disk. What a restart would
    //    see is A and NOT B. If SQLite's behaviour ever changes, the test's
    //    premise fails loudly right here instead of passing vacuously.
    expect(snapshotOnDisk()).toEqual([1001])

    // 5. Detection sees the orphaned WAL handle.
    const orphans = detectOrphanedDbFds(stateDir)
    expect(orphans.length).toBeGreaterThan(0)
    expect(orphans.some((o) => o.target.includes('history.db-wal'))).toBe(true)

    // 6. The tick alarms loudly and reopens.
    const lines: string[] = []
    runOrphanedDbSweepTick({
      stateDir,
      reopenHistory: () => reopenHistory(stateDir, 30),
      log: (l) => lines.push(l),
    })
    const log = lines.join('')
    expect(log).toContain('LOST')
    expect(log).toContain(`${dbFile}-wal`)
    expect(log).toContain('reopened history.db')

    // 7. THE FIX, half one: the deleted-inode handles are actually GONE. A soft
    //    `close()` leaves them open (measured), so this is the assertion that
    //    pins the hard close.
    expect(detectOrphanedDbFds(stateDir)).toEqual([])

    // 8. THE FIX, half two: writes are durable again — on disk, and visible to
    //    a restart.
    inbound(1003, 'row C — after the reopen')
    expect(snapshotOnDisk()).toContain(1003)
    expect(verifyHistoryWritable().ok).toBe(true)

    // …and through the module's own read path after a full re-init, which is
    // what `get_recent_messages` does on the next boot.
    _resetForTests()
    initHistory(stateDir, 30)
    const texts = query({ chat_id: '900001', limit: 50 }).map((m) => m.text)
    expect(texts).toContain('row C — after the reopen')
  })

  it('does not alarm on a healthy open DB with a live WAL', () => {
    initHistory(stateDir, 30)
    inbound(2001, 'healthy row')
    // A live WAL exists and is held open — the ONLY difference from the orphan
    // case is that it has not been unlinked.
    expect(existsSync(join(stateDir, 'history.db-wal'))).toBe(true)
    expect(detectOrphanedDbFds(stateDir)).toEqual([])

    const lines: string[] = []
    const orphans = runOrphanedDbSweepTick({ stateDir, log: (l) => lines.push(l) })
    expect(orphans).toEqual([])
    expect(lines).toEqual([])
  })
})

describe('orphaned-db-sweep — registry.db lane', () => {
  it('alarms and demands a restart without touching the registry handle', () => {
    const registryFile = join(stateDir, 'registry.db')
    const raw = new Database(registryFile, { create: true })
    try {
      raw.exec('PRAGMA journal_mode = WAL')
      raw.exec('CREATE TABLE turns (id INTEGER PRIMARY KEY, note TEXT)')
      raw.prepare('INSERT INTO turns (id, note) VALUES (?, ?)').run(1, 'before')
      unlinkSidecars(registryFile)

      const lines: string[] = []
      // No reopenHistory wired: this lane must alarm off the state-dir prefix,
      // not off the history.db filename.
      const orphans = runOrphanedDbSweepTick({ stateDir, log: (l) => lines.push(l) })
      expect(orphans.some((o) => o.target.includes('registry.db'))).toBe(true)
      const log = lines.join('')
      expect(log).toContain('registry.db')
      expect(log).toContain('RESTART')

      // Detection ONLY: the raw handle is left alone, so its consumers (the
      // by-value `turnsDb` captures in gateway.ts) are never handed a closed DB.
      expect(() =>
        raw.prepare('INSERT INTO turns (id, note) VALUES (?, ?)').run(2, 'after'),
      ).not.toThrow()
    } finally {
      raw.close()
    }
  })
})

describe('startOrphanedDbSweep', () => {
  it('returns a stop() that clears the interval', () => {
    const lines: string[] = []
    const stop = startOrphanedDbSweep({ stateDir, log: (l) => lines.push(l), intervalMs: 5 })
    expect(typeof stop).toBe('function')
    expect(() => stop()).not.toThrow()
  })
})
