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
 * File format + fault-tolerance mirrors `missed-approvals-store.ts`: a
 * single bounded JSON array, written synchronously, mode 0o600. No file
 * I/O failure here may throw into the caller — writes/reads degrade to
 * a no-op/empty-list rather than crashing the gateway.
 */

import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

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
   * than duplicated. */
  enqueue(entry: {
    agentName: string
    rule: string
    grantPhrase: string
    chatId?: string
    threadId?: number | null
    error?: string
  }): void
  /** All entries currently due for a retry attempt (nextAttemptAt <= now),
   * oldest first. Does NOT filter by attempts/age — callers should apply
   * {@link isExhausted} to decide terminal-failure vs. retry. */
  listDue(now?: number): AlwaysAllowPersistEntry[]
  /** Every entry in the queue, regardless of due-ness. */
  listAll(): AlwaysAllowPersistEntry[]
  /** Record the outcome of a retry attempt for `id`.
   *  - `success: true` → dequeue.
   *  - `success: false` → increment attempts, compute the next backoff
   *    (honoring `retryAfterMs` when supplied), and re-persist — UNLESS
   *    the entry is now exhausted (see {@link isExhausted}), in which case
   *    it is dropped and the caller should have already emitted the
   *    terminal-failure notice.
   */
  recordAttempt(
    id: string,
    outcome: { success: true } | { success: false; error: string; retryAfterMs?: number },
  ): void
  /** Remove an entry outright (e.g. after emitting its terminal notice). */
  remove(id: string): void
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

export function createAlwaysAllowPersistQueue(stateDir: string): AlwaysAllowPersistQueue {
  const filePath = join(stateDir, 'always-allow-persist-queue.json')

  function read(): FileShape {
    try {
      const raw = readFileSync(filePath, 'utf-8')
      const parsed = JSON.parse(raw) as Partial<FileShape>
      return { entries: Array.isArray(parsed?.entries) ? parsed.entries : [] }
    } catch {
      return { entries: [] }
    }
  }

  function write(f: FileShape): void {
    try {
      writeFileSync(filePath, JSON.stringify(f), { encoding: 'utf-8', mode: 0o600 })
    } catch (err) {
      process.stderr.write(
        `telegram gateway: always-allow-persist-queue write failed: ${(err as Error).message}\n`,
      )
    }
  }

  return {
    enqueue(args) {
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
    },

    remove(id) {
      const f = read()
      const filtered = f.entries.filter(e => e.id !== id)
      if (filtered.length !== f.entries.length) {
        f.entries = filtered
        write(f)
      }
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
        queue.recordAttempt(entry.id, { success: true })
        continue
      }

      const diff = deps.synthesizeDiff(entry.agentName, entry.rule, configText)
      if (diff == null) {
        recordFailure(entry, 'could not re-synthesize diff from fresh config read')
        continue
      }

      const result = await deps.dispatchConfigEdit(entry, diff)
      if (result.ok) {
        log(
          `always-allow-persist-queue: retry succeeded agent=${entry.agentName} rule=${entry.rule} attempts=${entry.attempts}\n`,
        )
        queue.recordAttempt(entry.id, { success: true })
      } else {
        recordFailure(entry, result.error, result.retryAfterMs)
      }
    } catch (err) {
      // Never let one entry's unexpected throw take down the drain pass.
      recordFailure(entry, `unexpected error: ${(err as Error).message}`)
    }
  }

  function recordFailure(entry: AlwaysAllowPersistEntry, error: string, retryAfterMs?: number): void {
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
    queue.recordAttempt(entry.id, { success: false, error, retryAfterMs })
  }
}
