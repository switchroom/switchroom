/**
 * Shared read side for the gateway's small JSON state stores
 * (`pending-card-store.ts`, `scoped-grant-store.ts`,
 * `missed-approvals-store.ts`, `always-allow-persist-queue.ts`).
 *
 * Problem: each of those stores read its backing file with a bare
 * `try { JSON.parse(readFileSync(...)) } catch { return [] }`. Combined
 * with a non-atomic `writeFileSync` straight over the destination (fixed
 * separately — every writer now goes through `atomicWriteFileSync`), a
 * crash between truncate and write left a TORN file. On the next boot the
 * parse threw, the catch swallowed it, and the store came up EMPTY: every
 * pending approval card and every live scoped grant silently forgotten,
 * with nothing in the logs. The operator just saw dead buttons.
 *
 * Losing security state must be OBSERVABLE. So a parse failure here is
 * never silent:
 *   - the corrupt bytes are preserved by renaming them aside to
 *     `<file>.corrupt-<epoch-ms>-<seq>-<rand>` (never deleted while they are the
 *     newest few — they're the forensic record of what was lost, and the
 *     only chance of manual recovery);
 *   - a loud `telegram gateway: <store> CORRUPT …` line goes to stderr,
 *     the same channel the surrounding stores already log write failures
 *     on (the gateway's stderr is captured in the agent's runtime log);
 *   - the caller gets a non-`ok` result and starts from an empty store —
 *     the process still boots, it just no longer does so in silence.
 *
 * Three read outcomes, deliberately distinguished:
 *   - `missing`     — the normal cold start. Silent, no quarantine.
 *   - `corrupt`     — unparseable JSON (or a shape the store rejects, via
 *                     `quarantineCorruptStoreFile`). Quarantine + loud log.
 *   - `unreadable`  — any other fs error (EACCES, EIO, EISDIR, …). Loud log,
 *                     but NO quarantine: renaming a file we merely failed to
 *                     read would destroy good state over a transient fault.
 *                     Instead the caller FAILS CLOSED on its next write —
 *                     see `preserveUnreadableStoreFile` below.
 *
 * ── Known hazard: two writers ──────────────────────────────────────────
 * Quarantine is a destructive-looking move (it renames the destination
 * away), and it is NOT safe against a second process writing the same
 * file: process A can parse-fail on a torn file, process B can then
 * atomically rename GOOD state into place, and A's quarantine would move
 * B's good file aside. Pre-fix a parse failure was inert, so this hazard is
 * introduced here. It is accepted because the gateway is (near-)singleton
 * per agent — see the `withLock` note in `always-allow-persist-queue.ts`
 * for why "near", and note the window is the few microseconds between the
 * failed parse and the rename. If a genuine multi-writer arrangement ever
 * appears, quarantine must become an flock-guarded compare-and-rename.
 */

import { randomBytes } from 'node:crypto'
import { readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/** Default sink — matches the stores' existing `process.stderr.write` use. */
const defaultLog = (line: string): void => {
  process.stderr.write(line)
}

/**
 * How many `<file>.corrupt-*` forensic copies to keep per store file.
 * They're tiny, but a store that corrupts on a loop must not fill the
 * state dir — so the oldest are reaped past this cap. Newest wins.
 */
export const MAX_QUARANTINED_COPIES = 5

/** Outcome of a store-file read. See the module docblock. */
export type StoreReadResult =
  | { status: 'ok'; value: unknown }
  | { status: 'missing' }
  | { status: 'corrupt' }
  | { status: 'unreadable' }

/**
 * Monotonic within this process, so two quarantines in the SAME millisecond
 * still sort in creation order. Without it the name's tail is random and the
 * reaper below — which sorts lexicographically — could drop the NEWEST
 * forensic copy instead of the oldest.
 */
let quarantineSeq = 0

/**
 * `<file>.corrupt-<epoch-ms>-<seq>-<rand>`.
 *
 * `<epoch-ms>` then zero-padded `<seq>` makes lexicographic order equal
 * chronological order. `<rand>` makes the name unique: two quarantines in
 * the same millisecond (or from two processes) would otherwise collide and
 * the second `renameSync` would silently clobber the first forensic copy —
 * same reasoning as the tempfile naming in `src/util/atomic.ts`.
 */
function quarantinePath(filePath: string): string {
  const seq = String(quarantineSeq++).padStart(6, '0')
  return `${filePath}.corrupt-${Date.now()}-${seq}-${randomBytes(4).toString('hex')}`
}

/** Reap all but the newest {@link MAX_QUARANTINED_COPIES} forensic copies. */
function reapOldQuarantines(filePath: string, log: (line: string) => void): void {
  const dir = dirname(filePath)
  const prefix = `${basename(filePath)}.corrupt-`
  try {
    const copies = readdirSync(dir)
      .filter(f => f.startsWith(prefix))
      .sort() // `<epoch-ms>-<seq>` prefix ⇒ lexicographic == chronological
    for (const stale of copies.slice(0, Math.max(0, copies.length - MAX_QUARANTINED_COPIES))) {
      rmSync(join(dir, stale), { force: true })
    }
  } catch (err) {
    // Reaping is opportunistic — never let it mask the corruption itself.
    log(`telegram gateway: quarantine reap failed dir=${dir}: ${(err as Error).message}\n`)
  }
}

/**
 * Move a corrupt/unusable store file aside so its bytes survive, and log
 * loudly. Exported for stores whose corruption is a SHAPE failure (valid
 * JSON, wrong structure) that only the store itself can detect.
 */
export function quarantineCorruptStoreFile(
  filePath: string,
  store: string,
  reason: string,
  log: (line: string) => void = defaultLog,
): void {
  const target = quarantinePath(filePath)
  let preserved = target
  try {
    renameSync(filePath, target)
  } catch (err) {
    preserved = `NOT preserved (${(err as Error).message})`
  }
  log(
    `telegram gateway: ${store} CORRUPT — ${reason}. ` +
      `Persisted state was LOST and the store is starting EMPTY; ` +
      `corrupt file ${preserved}\n`,
  )
  reapOldQuarantines(filePath, log)
}

/**
 * FAIL-CLOSED guard for the `unreadable` read outcome.
 *
 * A read that failed for a non-ENOENT reason (a flaky mount returning EIO,
 * a transient EACCES) leaves the store in memory EMPTY while the on-disk
 * file may still hold perfectly good state. The next `save()` would then
 * rename a fresh, near-empty file over it and destroy that state
 * permanently — quietly, and for a fault that may have lasted one syscall.
 *
 * So the stores call this immediately BEFORE their first write following an
 * unreadable read: the existing bytes are renamed aside (same
 * `.corrupt-<ts>-<seq>-<rand>` forensic convention) so the overwrite can never be
 * the thing that loses them. If the rename itself fails the write is
 * ABORTED by throwing — better a loud failed write than a silent
 * destruction of the only copy.
 */
export function preserveUnreadableStoreFile(
  filePath: string,
  store: string,
  log: (line: string) => void = defaultLog,
): void {
  const target = quarantinePath(filePath)
  try {
    renameSync(filePath, target)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // Nothing there to lose — the read failure wasn't about existing bytes.
      return
    }
    log(
      `telegram gateway: ${store} REFUSING to overwrite an unreadable file at ` +
        `${filePath} — could not preserve it first: ${(err as Error).message}\n`,
    )
    throw err
  }
  log(
    `telegram gateway: ${store} could not READ its file but is about to write it. ` +
      `Preserved the previous (unreadable) bytes as ${target} rather than ` +
      `overwriting them; the store continues from EMPTY\n`,
  )
  reapOldQuarantines(filePath, log)
}

/**
 * Read + parse a store's backing JSON file. See {@link StoreReadResult} and
 * the module docblock for what each outcome means and what it triggers.
 */
export function readStoreJsonSync(
  filePath: string,
  store: string,
  log: (line: string) => void = defaultLog,
): StoreReadResult {
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' }
    log(
      `telegram gateway: ${store} read FAILED path=${filePath}: ` +
        `${(err as Error).message} — starting EMPTY for this read; the next write ` +
        `will preserve the unreadable file rather than overwrite it\n`,
    )
    return { status: 'unreadable' }
  }
  try {
    return { status: 'ok', value: JSON.parse(raw) }
  } catch (err) {
    quarantineCorruptStoreFile(
      filePath,
      store,
      `unparseable JSON (${(err as Error).message}) — likely a torn write from a crash mid-persist`,
      log,
    )
    return { status: 'corrupt' }
  }
}
