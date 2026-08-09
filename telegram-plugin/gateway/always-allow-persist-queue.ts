/**
 * Durable retry queue for the "🔁 Always allow" durable-persist flow
 * (#1977, hardened in #2973).
 *
 * Problem (#2973): a `config_propose_edit` dispatch for an always-allow
 * rule can fail for RETRYABLE reasons (a transient hostd error, a stale
 * container-side config view producing `E_PATCH_APPLY_FAILED`, a rate
 * limit with a structured `retry_after`) — today that failure is simply
 * reported to the operator ("did NOT save") and the tap is lost; the rule
 * only lands if the operator notices and re-taps after the next restart.
 *
 * Fix: on a retryable dispatch failure, enqueue `{agent, rule, ...}` here
 * BEFORE giving up. The gateway drains this queue at boot (so a restart
 * mid-persist doesn't lose the entry) and on a periodic timer. Each drain
 * pass:
 *   1. re-checks `isRulePersisted` against a FRESH config read first — if
 *      the rule already landed (e.g. the original attempt actually
 *      succeeded server-side but the ack was lost), dequeue as a no-op;
 *   2. otherwise re-synthesizes the diff from that fresh read (fixes the
 *      stale-view failure class) and redispatches;
 *   3. on success, dequeues; on failure, backs off exponentially (honoring
 *      a structured `retryAfterMs` when the failure supplies one) and
 *      re-tries later;
 *   4. once `attempts` reaches {@link MAX_ATTEMPTS} or the entry has aged
 *      past {@link MAX_AGE_MS}, the entry is dropped and the caller is
 *      told to post a LOUD terminal-failure notice (a new message, not a
 *      card edit — card edits don't ping).
 *
 * HARD RULE (standing fleet rule, restated in #2973): nothing here may
 * retry indefinitely. Bounds are enforced structurally, not just by
 * convention — see {@link MAX_ATTEMPTS}, {@link MAX_AGE_MS}, and
 * {@link MAX_QUEUE_SIZE} below, and the tests that pin them.
 *
 * File format mirrors `missed-approvals-store.ts`: a single bounded JSON
 * array, written synchronously and ATOMICALLY (tmp + fsync + rename),
 * mode 0o600 — a crash mid-persist leaves the previous queue intact
 * instead of a torn file. NOTE: atomic REPLACEMENT only —
 * whole-old-or-whole-new, not power-loss durability; the missing
 * parent-directory fsync is tracked in #3603.
 *
 * Failure semantics (hardened post-#2973 adversarial review): a failed
 * READ degrades to an empty list so the gateway still boots — but a
 * CORRUPT file is no longer silent: the bytes are quarantined to
 * `<file>.corrupt-<ts>` and a loud line goes to the log (see
 * `store-file.ts`), because "queue silently came up empty" is exactly
 * how queued retries disappeared unnoticed. A failed WRITE is a
 * different story: silently swallowing it would mean `enqueue()` tells
 * its caller "queued for retry" when nothing was actually persisted to
 * disk, and a concurrent `recordAttempt()`/`remove()` would silently
 * fail to advance the queue's on-disk state. So `write()` PROPAGATES
 * (throws) on failure, and `enqueue()` / `recordAttempt()` / `remove()`
 * let that throw reach their own caller rather than pretending the
 * mutation landed. `drainAlwaysAllowPersistQueue` below catches around
 * each entry so one entry's write failure can't take down the rest of
 * the drain pass; callers in the gateway (the interactive "Always
 * allow" tap path) are responsible for catching enqueue() failures and
 * reflecting them in the operator-facing message rather than claiming
 * success.
 */

import { writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteStateFileSync } from '../../src/util/state-owner.js'
import {
  preserveUnreadableStoreFile,
  quarantineCorruptStoreFile,
  readStoreJsonSync,
} from './store-file.js'

/** Hard cap on retry attempts per entry — never retry indefinitely. */
export const MAX_ATTEMPTS = 5

/** Hard cap on how long an entry may live in the queue before being
 * dropped as terminally failed, regardless of attempts made. */
export const MAX_AGE_MS = 24 * 60 * 60 * 1000 // 24h

/** Bound the on-disk file even under a pathological failure storm. */
export const MAX_QUEUE_SIZE = 50

/** Base backoff for attempt 1; doubles each subsequent attempt (capped). */
export const BASE_BACKOFF_MS = 60_000 // 1 minute

/** Ceiling on the computed backoff, independent of attempt count. */
export const MAX_BACKOFF_MS = 30 * 60_000 // 30 minutes

export interface AlwaysAllowPersistEntry {
  /** Dedup key — one live queue entry per (agent, rule) pair. */
  id: string
  agentName: string
  rule: string
  /** Human-readable grant description, for the terminal-failure notice. */
  grantPhrase: string
  /** Origin chat/thread, so a terminal-failure notice can be targeted
   * (falls back to the operator broadcast allowlist if absent). */
  chatId?: string
  threadId?: number | null
  attempts: number
  createdAt: number
  nextAttemptAt: number
  lastError?: string
}

interface FileShape {
  entries: AlwaysAllowPersistEntry[]
}

export interface AlwaysAllowPersistQueue {
  /** Enqueue (or refresh) a failed persist for retry. Idempotent on
   * `(agentName, rule)` — an existing entry is updated in place rather
   * than duplicated. Serialized (via an in-process lock) relative to
   * every other read-modify-write on the queue file, and REJECTS if the
   * underlying write fails — callers must not treat a settled promise
   * as "persisted" without checking for rejection. */
  enqueue(entry: {
    agentName: string
    rule: string
    grantPhrase: string
    chatId?: string
    threadId?: number | null
    error?: string
  }): Promise<void>
  /** All entries currently due for a retry attempt (nextAttemptAt <= now),
   * oldest first. Does NOT filter by attempts/age — callers should apply
   * {@link isExhausted} to decide terminal-failure vs. retry. */
  listDue(now?: number): AlwaysAllowPersistEntry[]
  /** Every entry in the queue, regardless of due-ness. */
  listAll(): AlwaysAllowPersistEntry[]
  /** Record the outcome of a retry attempt for `id`. Serialized relative
   * to `enqueue`/`remove`/other `recordAttempt` calls on the same queue
   * file — never races a concurrent mutation into a lost update.
   *  - `success: true` → dequeue.
   *  - `success: false` → increment attempts, compute the next backoff
   *    (honoring `retryAfterMs` when supplied), and re-persist — UNLESS
   *    the entry is now exhausted (see {@link isExhausted}), in which case
   *    it is dropped and the caller should have already emitted the
   *    terminal-failure notice.
   * REJECTS if the underlying write fails — the caller must not assume
   * the state change was durably persisted just because this returned.
   */
  recordAttempt(
    id: string,
    outcome: { success: true } | { success: false; error: string; retryAfterMs?: number },
  ): Promise<void>
  /** Remove an entry outright (e.g. after emitting its terminal notice).
   * Serialized like the other mutators; REJECTS if the write fails. */
  remove(id: string): Promise<void>
  /** Delete the backing file entirely. */
  clear(): void
}

/** Stable id for a (agent, rule) pair — one live retry entry per pair. */
export function makeEntryId(agentName: string, rule: string): string {
  return `${agentName}::${rule}`
}

/** True when `entry` has exhausted its retry budget — attempts maxed OR
 * aged out — and should be dropped with a terminal-failure notice rather
 * than retried again. Pure so callers/tests can reason about the bound
 * without needing the store. */
export function isExhausted(entry: Pick<AlwaysAllowPersistEntry, 'attempts' | 'createdAt'>, now = Date.now()): boolean {
  return entry.attempts >= MAX_ATTEMPTS || now - entry.createdAt >= MAX_AGE_MS
}

/**
 * Exponential backoff with a hard ceiling, honoring a structured
 * `retry_after` hint when the failure supplied one (never retries SOONER
 * than that hint, but still respects {@link MAX_BACKOFF_MS}).
 */
export function computeBackoffMs(attempts: number, retryAfterMs?: number): number {
  const exp = Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_MS)
  if (retryAfterMs != null && retryAfterMs > 0) {
    return Math.min(Math.max(exp, retryAfterMs), MAX_BACKOFF_MS)
  }
  return exp
}

/**
 * The real writer: `atomicWriteFileSync` (tmp + fsync + rename) behind a
 * `writeFileSync`-shaped signature, so the injectable seam below keeps its
 * existing type and the fault-injection tests are unaffected. Only `mode`
 * from the options bag is meaningful here; the store always passes 0o600.
 */
export const atomicWriteSeam = ((path, data, opts) => {
  const mode = typeof opts === 'object' && opts !== null && typeof opts.mode === 'number' ? opts.mode : 0o600
  atomicWriteStateFileSync(path as string, data as string, mode)
}) as typeof writeFileSync

export function createAlwaysAllowPersistQueue(
  stateDir: string,
  /** Injectable for tests to force a write failure (disk full / permissions /
   * read-only fs) without real filesystem faults — we run as root in CI/
   * containers, so chmod-based permission tricks don't reliably fail, and
   * bun's test runner doesn't support mocking node:fs built-ins.
   *
   * CAUTION: a test that injects a seam replaces the ATOMIC writer. Such a
   * test proves failure PROPAGATION, never atomicity — the injected function
   * is whatever the test supplies (typically a plain `writeFileSync`, which
   * is exactly the non-atomic writer this store moved off). Tests that mean
   * to exercise the real write path must either leave this defaulted or wrap
   * the exported {@link atomicWriteSeam}. */
  writeFileSyncFn: typeof writeFileSync = atomicWriteSeam,
  /** Log sink — defaults to stderr (the gateway's runtime log). */
  log: (line: string) => void = l => process.stderr.write(l),
): AlwaysAllowPersistQueue {
  const filePath = join(stateDir, 'always-allow-persist-queue.json')

  // ── In-process mutex ──────────────────────────────────────────────────
  // enqueue / recordAttempt / remove are each a read-modify-write cycle
  // against the SAME file. Node is single-threaded, but these operations
  // are exposed as async (their callers `await` a hostd round trip, a
  // drain pass, etc.), so two calls CAN interleave across a microtask/
  // macrotask boundary — a naive "read, mutate, write" per call is a
  // classic lost-update race (#2973 pt.3): call A reads, call B reads the
  // same pre-A-write snapshot, B writes, A writes — B's update vanishes.
  // Fix: every read-modify-write against `filePath` is queued through this
  // single promise chain, so at most one is ever in flight at a time,
  // regardless of how many callers invoke enqueue/recordAttempt/remove
  // "concurrently".
  //
  // SCOPE (verified, not assumed): this is an IN-PROCESS promise chain, not
  // an OS file lock. It serializes callers inside ONE gateway process only.
  // Two gateway processes sharing a STATE_DIR WOULD still lose updates to
  // each other, and that is not impossible — only rare. `startup-mutex.ts`
  // makes concurrent gateways UNLIKELY, not unreachable: its bootMismatch
  // path steals the lock with NO liveness check when the holder's bootId
  // differs from the current one (exactly the restart-overlap case on a
  // shared STATE_DIR — see the `boot.lock_stale_recovered_boot_mismatch`
  // revert referenced at gateway.ts), `readCurrentBootId()` returns null
  // off-Linux which disables the gate entirely, the lock is taken once at
  // boot and never revalidated, and `isGatewayMain` lets harnesses bypass
  // it. So: rare, not guaranteed.
  //
  // Cross-process mutual exclusion is deliberately OUT OF SCOPE for this
  // change (which is about torn writes, not lost updates), and every write
  // here is now atomic so an overlap can lose an update but can never
  // corrupt the file. A real `flock` (cf. src/vault/flock-concurrent.test.ts)
  // is the durable fix — tracked as follow-up. Do not read the startup mutex
  // as a hard singleton invariant.
  let lock: Promise<unknown> = Promise.resolve()
  function withLock<T>(fn: () => T): Promise<T> {
    const result = lock.then(fn, fn) // run fn even if the previous link rejected
    // Swallow the rejection on the CHAIN (not on `result`) so one failed
    // mutation doesn't wedge the lock for everything queued after it.
    lock = result.catch(() => {})
    return result
  }

  /** Set when the last read failed for a non-ENOENT reason — the next write
   * must preserve the file it could not read instead of clobbering it. */
  let unreadable = false

  function read(): FileShape {
    const result = readStoreJsonSync(filePath, 'always-allow-persist-queue', log)
    unreadable = result.status === 'unreadable'
    if (result.status !== 'ok') return { entries: [] }
    const parsed = result.value as Partial<FileShape>
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      quarantineCorruptStoreFile(
        filePath,
        'always-allow-persist-queue',
        'parsed to a non-object — not a persist-queue file',
        log,
      )
      return { entries: [] }
    }
    // A PRESENT-but-non-array `entries` is corruption, not "empty queue".
    // Coercing it to [] would resurrect the silent-loss bug: a half-written
    // `{"entries": {}}` parses fine, so quarantine would never fire and the
    // queued retries would vanish unnoticed. An ABSENT `entries` is the
    // legitimate cold-start/partial-shape case and stays silent.
    if (parsed.entries !== undefined && !Array.isArray(parsed.entries)) {
      quarantineCorruptStoreFile(
        filePath,
        'always-allow-persist-queue',
        '`entries` is present but not an array — truncated or malformed write',
        log,
      )
      return { entries: [] }
    }
    return { entries: parsed.entries ?? [] }
  }

  /** Unlike `read()`, a write failure is NOT swallowed — it propagates so
   * the caller (enqueue/recordAttempt/remove) finds out its mutation did
   * not actually land on disk (disk full, permissions, etc.) instead of
   * silently proceeding as if it had. */
  function write(f: FileShape): void {
    // Fail closed: never let an overwrite be what destroys a queue we merely
    // failed to READ (flaky mount, transient EACCES) — this throws if the
    // previous bytes can't be preserved, and that throw is exactly the
    // propagate-don't-swallow contract above.
    if (unreadable) {
      preserveUnreadableStoreFile(filePath, 'always-allow-persist-queue', log)
      unreadable = false
    }
    writeFileSyncFn(filePath, JSON.stringify(f), { encoding: 'utf-8', mode: 0o600 })
  }

  return {
    enqueue(args) {
      return withLock(() => {
        const id = makeEntryId(args.agentName, args.rule)
        const f = read()
        const now = Date.now()
        const idx = f.entries.findIndex(e => e.id === id)
        if (idx >= 0) {
          // Already queued (e.g. a second tap failed the same way) — keep
          // its attempt history/createdAt (age bound is from FIRST failure),
          // just refresh the description fields and last error.
          f.entries[idx] = {
            ...f.entries[idx]!,
            grantPhrase: args.grantPhrase,
            chatId: args.chatId,
            threadId: args.threadId,
            lastError: args.error,
          }
        } else {
          if (f.entries.length >= MAX_QUEUE_SIZE) {
            // Bounded — drop the oldest to make room rather than growing
            // without limit under a failure storm.
            f.entries.sort((a, b) => a.createdAt - b.createdAt)
            f.entries = f.entries.slice(f.entries.length - MAX_QUEUE_SIZE + 1)
          }
          f.entries.push({
            id,
            agentName: args.agentName,
            rule: args.rule,
            grantPhrase: args.grantPhrase,
            chatId: args.chatId,
            threadId: args.threadId,
            attempts: 1,
            createdAt: now,
            nextAttemptAt: now + computeBackoffMs(1),
            lastError: args.error,
          })
        }
        write(f)
      })
    },

    listDue(now = Date.now()) {
      return read()
        .entries.filter(e => e.nextAttemptAt <= now)
        .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt)
    },

    listAll() {
      return read().entries
    },

    recordAttempt(id, outcome) {
      return withLock(() => {
        const f = read()
        const idx = f.entries.findIndex(e => e.id === id)
        if (idx === -1) return
        if (outcome.success) {
          f.entries.splice(idx, 1)
          write(f)
          return
        }
        const entry = f.entries[idx]!
        const attempts = entry.attempts + 1
        const updated: AlwaysAllowPersistEntry = {
          ...entry,
          attempts,
          lastError: outcome.error,
          nextAttemptAt: Date.now() + computeBackoffMs(attempts, outcome.retryAfterMs),
        }
        if (isExhausted(updated)) {
          // Exhausted — drop it. The caller is responsible for having
          // emitted (or being about to emit) the terminal-failure notice;
          // this store only owns the bounded-retry bookkeeping.
          f.entries.splice(idx, 1)
        } else {
          f.entries[idx] = updated
        }
        write(f)
      })
    },

    remove(id) {
      return withLock(() => {
        const f = read()
        const filtered = f.entries.filter(e => e.id !== id)
        if (filtered.length !== f.entries.length) {
          f.entries = filtered
          write(f)
        }
      })
    },

    clear() {
      try {
        unlinkSync(filePath)
      } catch {
        // File may not exist — fine.
      }
    },
  }
}

// ─── Drain ──────────────────────────────────────────────────────────────────

/** Injected dependencies for {@link drainAlwaysAllowPersistQueue} — kept
 * abstract so the drain loop is unit-testable without gateway/network/hostd
 * deps. The gateway wires the real implementations at call sites. */
export interface AlwaysAllowDrainDeps {
  /** Read the CURRENT (fresh, not cached) config file text. Throwing here
   * is treated as a retryable failure for the entry being processed. */
  readConfigText(): string
  /** Resolve the agent's current, fully-merged `tools.allow` list from the
   * freshly-read config — used to no-op a retry whose rule already
   * landed (e.g. the original dispatch actually succeeded). */
  resolveAllowList(configText: string, agentName: string): string[]
  isRulePersisted(allowList: string[], rule: string): boolean
  /** Re-synthesize the diff from the fresh config text. Returns null if
   * the agent block can no longer be located (treated as retryable —
   * config may be mid-edit). */
  synthesizeDiff(agentName: string, rule: string, configText: string): string | null
  /** Dispatch the (re-synthesized) diff for durable persistence. */
  dispatchConfigEdit(
    entry: AlwaysAllowPersistEntry,
    unifiedDiff: string,
  ): Promise<{ ok: true } | { ok: false; error: string; retryAfterMs?: number }>
  /** Called once for an entry that has exhausted its retry budget — the
   * "loud terminal failure" requirement (#2973 pt.3). Must not throw. */
  notifyTerminalFailure(entry: AlwaysAllowPersistEntry, reason: string): void
  /** Optional logger sink (defaults to a no-op) — kept separate from
   * stderr writes so tests can assert on it without capturing stdio. */
  log?(line: string): void
}

/**
 * Process every currently-due entry once. Safe to call at gateway boot
 * (drains anything left over from a mid-persist restart) and on a
 * periodic timer (~10 min in the gateway). Each entry is handled
 * independently — one entry's dispatch throwing never blocks its
 * siblings, and this function itself never throws.
 */
export async function drainAlwaysAllowPersistQueue(
  queue: AlwaysAllowPersistQueue,
  deps: AlwaysAllowDrainDeps,
): Promise<void> {
  const log = deps.log ?? (() => {})
  const due = queue.listDue()
  for (const entry of due) {
    try {
      let configText: string
      try {
        configText = deps.readConfigText()
      } catch (err) {
        recordFailure(entry, `config read failed: ${(err as Error).message}`)
        continue
      }

      // Re-check FIRST: if the rule already landed (original attempt
      // actually succeeded, or a concurrent tap persisted it), this is a
      // no-op dequeue — never re-append and risk a duplicate rule.
      const allowList = deps.resolveAllowList(configText, entry.agentName)
      if (deps.isRulePersisted(allowList, entry.rule)) {
        log(
          `always-allow-persist-queue: rule already persisted, no-op dequeue agent=${entry.agentName} rule=${entry.rule}\n`,
        )
        await recordAttemptSafely(entry, { success: true })
        continue
      }

      const diff = deps.synthesizeDiff(entry.agentName, entry.rule, configText)
      if (diff == null) {
        await recordFailure(entry, 'could not re-synthesize diff from fresh config read')
        continue
      }

      const result = await deps.dispatchConfigEdit(entry, diff)
      if (result.ok) {
        log(
          `always-allow-persist-queue: retry succeeded agent=${entry.agentName} rule=${entry.rule} attempts=${entry.attempts}\n`,
        )
        await recordAttemptSafely(entry, { success: true })
      } else {
        await recordFailure(entry, result.error, result.retryAfterMs)
      }
    } catch (err) {
      // Never let one entry's unexpected throw take down the drain pass.
      await recordFailure(entry, `unexpected error: ${(err as Error).message}`)
    }
  }

  /** `queue.recordAttempt` now REJECTS on a write failure (disk full,
   * permissions, …) rather than silently pretending the state change
   * persisted. The drain loop must not let that reject take down the
   * whole pass (or the other due entries) — log it and move on; the
   * entry stays in whatever state the last successful write left it in,
   * and will be picked up again on the next drain pass. */
  async function recordAttemptSafely(
    entry: AlwaysAllowPersistEntry,
    outcome: { success: true } | { success: false; error: string; retryAfterMs?: number },
  ): Promise<void> {
    try {
      await queue.recordAttempt(entry.id, outcome)
    } catch (err) {
      log(
        `always-allow-persist-queue: recordAttempt write failed (state change NOT persisted) agent=${entry.agentName} rule=${entry.rule}: ${(err as Error).message}\n`,
      )
    }
  }

  async function recordFailure(entry: AlwaysAllowPersistEntry, error: string, retryAfterMs?: number): Promise<void> {
    const willBeExhausted = isExhausted({ attempts: entry.attempts + 1, createdAt: entry.createdAt })
    log(
      `always-allow-persist-queue: retry failed agent=${entry.agentName} rule=${entry.rule} attempts=${entry.attempts + 1} exhausted=${willBeExhausted} error=${error}\n`,
    )
    if (willBeExhausted) {
      try {
        deps.notifyTerminalFailure(entry, error)
      } catch (notifyErr) {
        log(
          `always-allow-persist-queue: notifyTerminalFailure threw agent=${entry.agentName} rule=${entry.rule}: ${(notifyErr as Error).message}\n`,
        )
      }
    }
    await recordAttemptSafely(entry, { success: false, error, retryAfterMs })
  }
}
