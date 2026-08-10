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
 *     be READ from — SQLite's unix VFS keeps per-inode WAL-index state shared
 *     across connections in the process. So the "is it on disk?" probe CANNOT
 *     be a second `new Database` on the live path. It is instead a
 *     `snapshotOnDisk()` that copies `history.db` (+ `-wal` when one exists) to
 *     a scratch dir and opens the COPY — a different inode, and a faithful
 *     reading of what is durably on disk. A separate PROCESS opening the
 *     original reads the same thing, which is how we know the on-disk DB is not
 *     corrupt.
 *
 *  2. bun:sqlite's plain `db.close()` is a SOFT close that does not release the
 *     fds while prepared statements are un-finalized. `hardCloseDb` therefore
 *     FINALIZES every cached statement and then calls `close(true)`; the
 *     regression assertion for that is `detectOrphanedDbFds(stateDir)` being
 *     EMPTY after recovery.
 *
 * WHY THERE IS A DETERMINISM TEST UNDER AN ADVERSARIAL HEAP
 * --------------------------------------------------------
 * The first cut of this recovery leaned on `Bun.gc(true)` to make the
 * un-finalized per-call statements collectable before `close(true)`. Measured
 * on bun 1.3.13, that is NOT deterministic: with an essentially empty heap a
 * single gc+close failed 13 times in 20, and with an ordinary arithmetic loop
 * running between the writes and the close it failed 30 times in 30. The fix is
 * the module-level statement cache in `history.ts`, whose entries are explicitly
 * `.finalize()`d by `hardCloseDb`; with it, the same 30-iteration adversarial
 * shape fails 0 times in 30 — and still 0 in 30 with `Bun.gc(true)` deleted
 * entirely, which is the proof that the cache and not the gc is what makes the
 * close deterministic. `'reopens deterministically under the heap shape that
 * broke the gc-only version'` below is that measurement, pinned.
 *
 * NOTE ON THE `close(true)` ARGUMENT. A mutation of `close(true)` →
 * `close()` inside `hardCloseDb` SURVIVES the incident-reproduction test: once
 * every statement is finalized the soft close releases the fds too, so the
 * integration test genuinely cannot see the difference. The `true` (throw on a
 * still-busy handle) is an HONESTY property — never report a recovery that did
 * not happen — so it is pinned one level down, on `hardCloseDb` itself, in the
 * `describe('hardCloseDb')` block with a handle double.
 *
 * WHAT CANNOT BE TESTED DETERMINISTICALLY HERE, and what covers it instead:
 *
 *  - The non-Linux early return in `detectOrphanedDbFds`. `/proc/self/fd` only
 *    exists on Linux; the guard is a platform branch a Linux CI runner cannot
 *    enter. Every `/proc`-dependent block below is `describe.skipIf`-guarded so
 *    a macOS developer gets a skip, not a spurious pass.
 *  - The 5-minute production cadence. The interval itself IS asserted (see
 *    `describe('startOrphanedDbSweep')`, which samples log output before and
 *    after `stop()` at a 5ms cadence); only the specific 5-minute default is
 *    left to code shape, since waiting for it would be a timing dependence.
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
import {
  mkdtempSync,
  rmSync,
  existsSync,
  unlinkSync,
  copyFileSync,
  openSync,
  closeSync,
  writeFileSync,
  symlinkSync,
} from 'fs'
import { tmpdir } from 'os'
import { basename, join } from 'path'
// bun-only (this file is vitest-excluded and runs under `bun test`): the
// on-disk snapshot probe, and the raw registry.db handle for the
// detection-only lane.
import { Database } from 'bun:sqlite'
import {
  initHistory,
  reopenHistory,
  hardCloseDb,
  getHistoryReopenFailure,
  recordInbound,
  recordOutbound,
  checkpointWal,
  query,
  lookupMessageRoleAndText,
  verifyHistoryWritable,
  _resetForTests,
} from '../history.js'
import {
  detectOrphanedDbFds,
  runOrphanedDbSweepTick,
  startOrphanedDbSweep,
} from '../gateway/orphaned-db-sweep.js'
import { GATEWAY_SIGNATURES } from '../../src/fleet-health/detect.js'

/**
 * `/proc/self/fd` is Linux-only. Without this guard every detection test would
 * pass VACUOUSLY on macOS — `detectOrphanedDbFds` returns `[]` there by design,
 * so `expect(...).toEqual([])` is satisfied by the platform, not the code.
 */
const onLinux = process.platform === 'linux'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let stateDir: string
const scratchDirs: string[] = []
const openFds: number[] = []

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'orphaned-db-sweep-test-'))
})

afterEach(() => {
  try { _resetForTests() } catch { /* an orphaned handle may refuse to close */ }
  for (const fd of openFds.splice(0)) {
    try { closeSync(fd) } catch { /* already gone */ }
  }
  for (const d of scratchDirs.splice(0)) rmSync(d, { recursive: true, force: true })
  if (existsSync(stateDir)) rmSync(stateDir, { recursive: true, force: true })
})

/** A second temp dir, torn down with the test. */
function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratchDirs.push(dir)
  return dir
}

/**
 * What a RESTART would see: copy the durable files to a scratch dir (a fresh
 * inode, sidestepping the in-process WAL-index poisoning documented above) and
 * read the copy. Deliberately does NOT go through the module singleton, whose
 * writes may be landing in a deleted inode.
 */
function snapshotOnDisk(): number[] {
  const dir = scratch('orphaned-db-sweep-snap-')
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

/**
 * Create a file, hold an fd on it, and unlink it — a deleted-inode fd that is
 * NOT a database. The sweep must ignore it.
 */
function orphanNonDbFile(path: string): void {
  writeFileSync(path, 'x')
  openFds.push(openSync(path, 'r'))
  unlinkSync(path)
}

/**
 * Seed a `history.db` whose schema is entirely valid — every DDL statement,
 * migration and index in `initHistory` succeeds against it — but whose
 * `messages` table REJECTS the writer self-check's sentinel row.
 *
 * This is the only shape that separates "the DB opened and the schema is
 * there" from "a row can actually be persisted", which is exactly the gap the
 * post-reopen self-check exists to close: `initHistory` only WARNS when its own
 * self-check fails and returns normally, so without the gate `reopenHistory`
 * returns success on a DB that cannot take a write and the sweep logs "writes
 * are durable again" on top of "WRITER SELF-CHECK FAILED". Uses a CHECK
 * constraint rather than filesystem permissions deliberately: the test suite
 * runs as root in some containers, where a chmod-based read-only fixture is
 * silently bypassed and the test passes for the wrong reason.
 */
function seedSelfCheckPoisonedDb(): void {
  const raw = new Database(join(stateDir, 'history.db'), { create: true })
  try {
    raw.exec(`
      CREATE TABLE messages (
        chat_id        TEXT    NOT NULL,
        thread_id      INTEGER,
        message_id     INTEGER NOT NULL,
        role           TEXT    NOT NULL,
        user           TEXT,
        user_id        TEXT,
        ts             INTEGER NOT NULL,
        text           TEXT    NOT NULL,
        attachment_kind TEXT,
        group_id       INTEGER,
        reply_to_message_id INTEGER,
        reply_to_text  TEXT,
        kind           TEXT,
        PRIMARY KEY (chat_id, thread_id, message_id),
        CHECK (text <> 'selfcheck')
      )
    `)
  } finally {
    raw.close(false)
  }
}

/** The sorted bare file names behind a set of orphans, for exact-set assertions. */
function orphanNames(orphans: { target: string }[]): string[] {
  return orphans
    .map((o) => basename(o.target.replace(/ \(deleted\)$/, '')))
    .sort()
}

describe.skipIf(!onLinux)('orphaned-db-sweep — history.db recovery', () => {
  it('reproduces the deleted-inode data loss and restores durable writes', async () => {
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

    // 5. Detection sees BOTH orphaned handles. The real incident had two
    //    (`-wal` and `-shm`); asserting the exact set means a detector that
    //    returns only the first one fails here.
    const orphans = await detectOrphanedDbFds(stateDir)
    expect(orphanNames(orphans)).toEqual(['history.db-shm', 'history.db-wal'])

    // 6. The tick alarms loudly and reopens.
    const lines: string[] = []
    await runOrphanedDbSweepTick({
      stateDir,
      reopenHistory: () => reopenHistory(stateDir, 30),
      log: (l) => lines.push(l),
    })
    const log = lines.join('')
    expect(log).toContain('LOST')
    expect(log).toContain(`${dbFile}-wal`)
    expect(log).toContain('reopened history.db')

    // …and the fleet-health L0 detector actually matches that alarm. Without
    // this the signature and the log line drift apart silently and the
    // alarm has no consumer.
    expect(GATEWAY_SIGNATURES['orphaned-db-handle'].test(log)).toBe(true)

    // 7. THE FIX, half one: the deleted-inode handles are actually GONE. A
    //    close that leaves un-finalized statements behind leaves them open
    //    (measured), so this is the assertion that pins the hard close.
    expect(await detectOrphanedDbFds(stateDir)).toEqual([])

    // 8. THE FIX, half two: writes are durable again — on disk, and visible to
    //    a restart. And nothing is stuck.
    inbound(1003, 'row C — after the reopen')
    expect(snapshotOnDisk()).toContain(1003)
    expect(verifyHistoryWritable().ok).toBe(true)
    expect(getHistoryReopenFailure()).toBeNull()

    // …and through the module's own read path after a full re-init, which is
    // what `get_recent_messages` does on the next boot.
    _resetForTests()
    initHistory(stateDir, 30)
    const texts = query({ chat_id: '900001', limit: 50 }).map((m) => m.text)
    expect(texts).toContain('row C — after the reopen')
  })

  it('does not alarm on a healthy open DB with a live WAL', async () => {
    initHistory(stateDir, 30)
    inbound(2001, 'healthy row')
    // A live WAL exists and is held open — the ONLY difference from the orphan
    // case is that it has not been unlinked.
    expect(existsSync(join(stateDir, 'history.db-wal'))).toBe(true)
    expect(await detectOrphanedDbFds(stateDir)).toEqual([])

    const lines: string[] = []
    const orphans = await runOrphanedDbSweepTick({ stateDir, log: (l) => lines.push(l) })
    expect(orphans).toEqual([])
    expect(lines).toEqual([])
  })

  it('reopens deterministically under the heap shape that broke the gc-only version', () => {
    // The measured adversarial shape: real writes (which leave statements
    // behind) plus ordinary arithmetic between the writes and the close. The
    // gc-only implementation failed this 30/30; the statement cache passes it
    // even with the gc removed. Twelve iterations keeps the test under a second
    // while still being far past the 13/20 failure rate of the empty-heap case
    // — a regression to gc-dependence cannot survive twelve rolls.
    for (let i = 0; i < 12; i++) {
      initHistory(stateDir, 30)
      inbound(3000 + i, `row ${i}`)
      recordOutbound({
        chat_id: '900001',
        thread_id: null,
        message_ids: [4000 + i],
        texts: [`reply ${i}`],
      })
      checkpointWal()
      let churn = 0
      for (let j = 0; j < 500_000; j++) churn += j % 7
      expect(churn).toBeGreaterThan(0)
      expect(() => reopenHistory(stateDir, 30)).not.toThrow()
      expect(verifyHistoryWritable().ok).toBe(true)
    }
  })
})

describe.skipIf(!onLinux)('orphaned-db-sweep — detection filters', () => {
  it('ignores deleted non-DB files in the state dir', async () => {
    // `basename.includes('.db')` matched every one of these.
    orphanNonDbFile(join(stateDir, 'scratch.tmp'))
    orphanNonDbFile(join(stateDir, 'notes.dbg'))
    orphanNonDbFile(join(stateDir, 'dump.dbf'))
    orphanNonDbFile(join(stateDir, 'history.db.bak'))
    orphanNonDbFile(join(stateDir, 'session.dbus'))

    expect(await detectOrphanedDbFds(stateDir)).toEqual([])

    const lines: string[] = []
    await runOrphanedDbSweepTick({ stateDir, log: (l) => lines.push(l) })
    expect(lines).toEqual([])
  })

  it('ignores a deleted DB outside the state dir', async () => {
    // A SECOND temp dir, so the filtering is done by the prefix test and not
    // by "there happen to be no orphaned fds at all".
    const elsewhere = scratch('orphaned-db-sweep-elsewhere-')
    const foreign = join(elsewhere, 'foreign.db')
    const raw = new Database(foreign, { create: true })
    try {
      raw.exec('PRAGMA journal_mode = WAL')
      raw.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)')
      raw.prepare('INSERT INTO t (id) VALUES (?)').run(1)
      unlinkSidecars(foreign)

      // The orphan is real and detectable — from its OWN dir…
      expect(orphanNames(await detectOrphanedDbFds(elsewhere)))
        .toEqual(['foreign.db-shm', 'foreign.db-wal'])
      // …and invisible from ours.
      expect(await detectOrphanedDbFds(stateDir)).toEqual([])
    } finally {
      raw.close(false)
    }
  })

  it('detects through a symlinked state dir', async () => {
    // `/proc/self/fd` targets are always fully resolved. Comparing them
    // against an unresolved `TELEGRAM_STATE_DIR` disables detection silently
    // and forever — the worst possible failure for a data-loss detector.
    const linkParent = scratch('orphaned-db-sweep-link-')
    const link = join(linkParent, 'state-link')
    symlinkSync(stateDir, link)

    initHistory(stateDir, 30)
    inbound(5001, 'row via symlink')
    checkpointWal()
    unlinkSidecars(join(stateDir, 'history.db'))

    expect(orphanNames(await detectOrphanedDbFds(link)))
      .toEqual(['history.db-shm', 'history.db-wal'])
  })

  it('warns rather than reporting healthy when the state dir cannot be resolved', async () => {
    const missing = join(stateDir, 'does-not-exist')
    const lines: string[] = []
    const orphans = await runOrphanedDbSweepTick({ stateDir: missing, log: (l) => lines.push(l) })
    expect(orphans).toEqual([])
    const log = lines.join('')
    expect(log).toContain('cannot resolve stateDir')
    expect(log).toContain('DISABLED')
  })
})

describe.skipIf(!onLinux)('orphaned-db-sweep — registry.db and unowned lanes', () => {
  it('alarms and demands a restart without touching the registry handle', async () => {
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
      const orphans = await runOrphanedDbSweepTick({ stateDir, log: (l) => lines.push(l) })
      expect(orphanNames(orphans)).toEqual(['registry.db-shm', 'registry.db-wal'])
      const log = lines.join('')
      expect(log).toContain('registry.db')
      expect(log).toContain('RESTART')
      expect(GATEWAY_SIGNATURES['orphaned-db-handle'].test(log)).toBe(true)

      // Detection ONLY: the raw handle is left alone, so its consumers (the
      // by-value `turnsDb` captures in gateway.ts) are never handed a closed DB.
      expect(() =>
        raw.prepare('INSERT INTO turns (id, note) VALUES (?, ?)').run(2, 'after'),
      ).not.toThrow()
    } finally {
      raw.close(false)
    }
  })

  it('names an unowned state-dir DB instead of raising a lane-less data-loss alarm', async () => {
    const grants = join(stateDir, 'grants.db')
    const raw = new Database(grants, { create: true })
    try {
      raw.exec('PRAGMA journal_mode = WAL')
      raw.exec('CREATE TABLE g (id INTEGER PRIMARY KEY)')
      raw.prepare('INSERT INTO g (id) VALUES (?)').run(1)
      unlinkSidecars(grants)

      const lines: string[] = []
      await runOrphanedDbSweepTick({
        stateDir,
        reopenHistory: () => { throw new Error('history lane must not run') },
        log: (l) => lines.push(l),
      })
      const log = lines.join('')
      expect(log).toContain('grants.db-wal')
      expect(log).toContain('no recovery lane owns')
      expect(log).toContain('RESTART')
      // The history lane is wired but must NOT have fired for a foreign DB.
      expect(log).not.toContain('history.db')
    } finally {
      raw.close(false)
    }
  })
})

describe.skipIf(!onLinux)('orphaned-db-sweep — reopen failure lanes', () => {
  it('reports a failed reopen honestly instead of claiming recovery', async () => {
    initHistory(stateDir, 30)
    inbound(6001, 'row before the unlink')
    checkpointWal()
    unlinkSidecars(join(stateDir, 'history.db'))

    const lines: string[] = []
    await runOrphanedDbSweepTick({
      stateDir,
      reopenHistory: () => { throw new Error('boom') },
      log: (l) => lines.push(l),
    })
    const log = lines.join('')
    expect(log).toContain('FAILED to reopen history.db')
    expect(log).toContain('boom')
    expect(log).toContain('RESTART')
    // The success line must be gated on the reopen actually succeeding.
    expect(log).not.toContain('writes are durable again')
  })

  it('says a history reopen is not wired when history is disabled', async () => {
    initHistory(stateDir, 30)
    inbound(6101, 'row before the unlink')
    checkpointWal()
    unlinkSidecars(join(stateDir, 'history.db'))

    const lines: string[] = []
    await runOrphanedDbSweepTick({ stateDir, reopenHistory: undefined, log: (l) => lines.push(l) })
    const log = lines.join('')
    expect(log).toContain('no reopen')
    expect(log).toContain('RESTART')
    expect(log).not.toContain('writes are durable again')
  })

  it('keeps alarming on a sticky reopen failure after the fds are gone', async () => {
    // The nastiest shape: the close SUCCEEDED (fds released) and the re-init
    // FAILED. There is no fd evidence left, so a purely fd-driven sweep would
    // report healthy forever while every history read and write is dead.
    let stuck: string | null = 'disk full'
    const lines: string[] = []
    const opts = {
      stateDir,
      reopenHistory: () => { throw new Error('still broken') },
      historyReopenFailure: () => stuck,
      log: (l: string) => lines.push(l),
    }
    expect(await detectOrphanedDbFds(stateDir)).toEqual([])

    await runOrphanedDbSweepTick(opts)
    await runOrphanedDbSweepTick(opts)
    const log = lines.join('')
    expect(log.match(/history\.db is CLOSED/g)?.length).toBe(2)
    expect(log).toContain('disk full')

    // …and goes quiet the moment the flag clears, so it cannot become noise
    // the operator learns to ignore.
    stuck = null
    lines.length = 0
    await runOrphanedDbSweepTick(opts)
    expect(lines).toEqual([])
  })

  it('recovers off the sticky flag with no orphaned fd to trigger it', async () => {
    initHistory(stateDir, 30)
    const lines: string[] = []
    await runOrphanedDbSweepTick({
      stateDir,
      reopenHistory: () => reopenHistory(stateDir, 30),
      historyReopenFailure: () => 'previous reopen failed',
      log: (l) => lines.push(l),
    })
    const log = lines.join('')
    expect(log).toContain('history.db is CLOSED')
    expect(log).toContain('recovered history.db')
    expect(log).toContain('writes are durable again')
    expect(getHistoryReopenFailure()).toBeNull()
    expect(verifyHistoryWritable().ok).toBe(true)
  })

  it('refuses to call a reopen successful when the reopened DB cannot take a write', async () => {
    seedSelfCheckPoisonedDb()
    initHistory(stateDir, 30) // warns about the self-check, returns normally

    expect(() => reopenHistory(stateDir, 30)).toThrow('post-reopen writer self-check failed')

    // …and the sweep repeats that honestly rather than announcing durability.
    const lines: string[] = []
    await runOrphanedDbSweepTick({
      stateDir,
      reopenHistory: () => reopenHistory(stateDir, 30),
      historyReopenFailure: getHistoryReopenFailure,
      log: (l) => lines.push(l),
    })
    const log = lines.join('')
    expect(log).toContain('FAILED to reopen history.db')
    expect(log).not.toContain('writes are durable again')
  })

  it('clears the sticky failure once a later reopen genuinely succeeds', async () => {
    seedSelfCheckPoisonedDb()
    initHistory(stateDir, 30)
    expect(() => reopenHistory(stateDir, 30)).toThrow()
    expect(getHistoryReopenFailure()).toContain('post-reopen writer self-check failed')

    // Repair the underlying cause (drop the poisoned file; the still-open
    // handle onto it becomes an orphan, which is the sweep's other trigger)
    // and let a tick recover.
    for (const suffix of ['', '-wal', '-shm']) {
      const f = join(stateDir, 'history.db' + suffix)
      if (existsSync(f)) unlinkSync(f)
    }
    const lines: string[] = []
    await runOrphanedDbSweepTick({
      stateDir,
      reopenHistory: () => reopenHistory(stateDir, 30),
      historyReopenFailure: getHistoryReopenFailure,
      log: (l) => lines.push(l),
    })
    expect(lines.join('')).toContain('writes are durable again')

    // A flag that never clears turns the recovered state into a permanent
    // alarm — the operator learns to ignore it, and the next real outage is
    // invisible. The next tick must be silent.
    expect(getHistoryReopenFailure()).toBeNull()
    lines.length = 0
    await runOrphanedDbSweepTick({
      stateDir,
      reopenHistory: () => reopenHistory(stateDir, 30),
      historyReopenFailure: getHistoryReopenFailure,
      log: (l) => lines.push(l),
    })
    expect(lines).toEqual([])
  })

  it('degrades reads to empty instead of throwing when history is dead', () => {
    initHistory(stateDir, 30)
    inbound(6201, 'row before the outage')

    // Make the re-init genuinely impossible: replace the state DIR with a FILE
    // so `initHistory`'s mkdir throws. The close still succeeds, so this is the
    // real end-to-end shape of the sticky failure, not a stub.
    rmSync(stateDir, { recursive: true, force: true })
    writeFileSync(stateDir, 'not a directory')

    expect(() => reopenHistory(stateDir, 30)).toThrow()
    expect(getHistoryReopenFailure()).not.toBeNull()

    // The read paths degrade instead of exploding through their callers.
    expect(query({ chat_id: '900001', limit: 10 })).toEqual([])
    expect(lookupMessageRoleAndText('900001', 6201)).toBeNull()

    unlinkSync(stateDir)
  })
})

describe('hardCloseDb', () => {
  /**
   * A `Database` double with bun's close semantics: `close(true)` throws when
   * statements are still outstanding, `close()` (soft) never does. This is
   * where the `true` argument is pinned — see the note in the file header for
   * why the integration test cannot see it.
   */
  function fakeHandle(busy: boolean) {
    const calls: (boolean | undefined)[] = []
    return {
      calls,
      close(throwOnError?: boolean) {
        calls.push(throwOnError)
        if (throwOnError === true && busy) throw new Error('database is locked')
      },
      prepare() { throw new Error('unused') },
      exec() { throw new Error('unused') },
    }
  }

  it('closes with throwOnError so a stuck handle cannot be reported as recovered', () => {
    const handle = fakeHandle(false)
    hardCloseDb(handle as never)
    // `close()` / `close(false)` would silently leave a busy handle behind and
    // let the caller log "writes are durable again".
    expect(handle.calls).toEqual([true])
  })

  it('propagates a close failure rather than swallowing it', () => {
    const handle = fakeHandle(true)
    expect(() => hardCloseDb(handle as never)).toThrow('database is locked')
  })

  it('finalizes every cached statement before closing', () => {
    // The real determinism proof: after a hard close, re-opening and writing
    // must work, which requires the cache to have been dropped along with the
    // finalized statements. A cache that survived the close would hand the new
    // connection statements bound to the old one.
    initHistory(stateDir, 30)
    inbound(7001, 'cached statement holder')
    expect(verifyHistoryWritable().ok).toBe(true)
    expect(() => reopenHistory(stateDir, 30)).not.toThrow()
    expect(verifyHistoryWritable().ok).toBe(true)
    expect(query({ chat_id: '900001', limit: 10 }).map((m) => m.message_id)).toEqual([7001])
  })
})

describe('startOrphanedDbSweep', () => {
  it('stops ticking after stop() is called', async () => {
    // A sticky failure with no reopen wired makes every tick emit exactly one
    // line, so the log line count IS the tick count — an observable the
    // interval must actually drive.
    const lines: string[] = []
    const stop = startOrphanedDbSweep({
      stateDir,
      historyReopenFailure: () => 'stuck',
      log: (l) => lines.push(l),
      intervalMs: 5,
    })
    // Poll to a generous deadline rather than sampling a fixed window: under a
    // loaded CI runner a 5ms interval can be starved, and a flaky assertion on
    // a real property is worse than a slow one.
    const deadline = Date.now() + 5_000
    while (lines.length < 3 && Date.now() < deadline) await sleep(5)
    // Multiple ticks: proves the interval repeats, not just fires once.
    expect(lines.length).toBeGreaterThan(1)

    const atStop = lines.length
    stop()
    // The property under test is "no NEW ticks start", not "no line is ever
    // appended after stop() returns": the tick body is async, so one tick can
    // already be in flight when stop() lands and will still emit its line.
    //
    // The sweep's own `running` guard means AT MOST ONE can be in flight, so
    // the tolerance is exactly one line — assert that, rather than trying to
    // out-wait the in-flight tick and then demanding exact equality. Every
    // fixed settle window is a guess a loaded runner beats: 60ms flaked two of
    // three consecutive merge-queue passes and a 40ms quiescence poll flaked
    // again on the very next one (#4601), because a tick that has not yet
    // resolved looks identical to quiescence.
    await sleep(400)
    // Not a weakening: an uncleared 5ms interval adds dozens of lines here, so
    // this still fails hard on a stop() that does not clear the timer.
    expect(lines.length - atStop).toBeLessThanOrEqual(1)
  })
})
