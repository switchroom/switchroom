/**
 * status-pin-store.ts — durable snapshot for the status-pin claim set.
 *
 * Why this exists: the gateway tracks the messages it has SILENTLY pinned
 * (`channels.telegram.pin_status_while_working`) in an in-memory Map
 * (`statusPinState` keyed by pinKey → PinState, plus a companion chatId map).
 * A gateway/container restart empties that Map. If a session pins the per-turn
 * status / `🛠 Worker` message and then crashes BEFORE the unpin reconcile runs,
 * the message stays pinned in Telegram but the next boot has no record of it —
 * so it never unpins the orphan, and the service-message-deletion handler can't
 * recognise the orphan's pin as "ours" either. Result: a stale status pin from
 * a dead session lingers.
 *
 * This makes cleanup self-contained across restart: every pin claim persists
 * here; on boot the gateway loads the persisted set and unpins each entry
 * (a status pin from a PRIOR session is stale by definition — the turn it
 * represented is over or crashed), then clears the store. It does NOT re-adopt
 * or re-pin — it only cleans up.
 *
 * Shape choice — SNAPSHOT, not append-log, mirroring obligation-store.ts. The
 * claim set is tiny and bounded (one entry per in-flight pinned key, normally
 * 0–2). Rewriting the whole set on each change is trivially cheap and needs no
 * compaction. Crash-safety is write-tmp + atomic rename: a crash leaves EITHER
 * the prior complete snapshot OR the new one, never a torn file. PURE w.r.t.
 * the injected fs seam ⇒ unit-testable.
 */

export interface StatusPinStoreFsSeam {
  readFileSync: (path: string) => string
  writeFileSync: (path: string, data: string) => void
  /** Atomic same-dir replace (POSIX rename) so a crash mid-write can't tear
   *  the snapshot. */
  renameSync: (from: string, to: string) => void
  existsSync: (path: string) => boolean
}

/** One persisted pin claim: the pinKey, the chat it lives in, and the pinned
 *  message id (so boot cleanup can unpin exactly that message). */
export interface PersistedStatusPin {
  pinKey: string
  chatId: string
  messageId: number
}

interface SnapshotEnvelope {
  v: 1
  pins: PersistedStatusPin[]
}

function isPinRow(x: unknown): x is PersistedStatusPin {
  if (x == null || typeof x !== 'object') return false
  const o = x as Record<string, unknown>
  return (
    typeof o.pinKey === 'string' &&
    o.pinKey.length > 0 &&
    typeof o.chatId === 'string' &&
    o.chatId.length > 0 &&
    typeof o.messageId === 'number'
  )
}

/**
 * Load the persisted pin set. Returns [] on a missing, unreadable, or malformed
 * file (fail-open to empty: a corrupt snapshot must never crash boot — worst
 * case an orphaned pin isn't cleaned up this boot, strictly no worse than the
 * pre-persistence behaviour).
 */
export function loadStatusPins(
  path: string,
  fs: StatusPinStoreFsSeam,
): PersistedStatusPin[] {
  if (!fs.existsSync(path)) return []
  let raw = ''
  try {
    raw = fs.readFileSync(path)
  } catch {
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (parsed == null || typeof parsed !== 'object') return []
  const env = parsed as Record<string, unknown>
  if (env.v !== 1 || !Array.isArray(env.pins)) return []
  return env.pins.filter(isPinRow)
}

/**
 * Persist the pin set atomically (write sibling tmp → rename over the real
 * path). Best-effort relative to fs availability: a write failure is logged but
 * never thrown — a failing store degrades to in-memory-only (the pre-
 * persistence behaviour), it must not break live pinning.
 */
export function persistStatusPins(
  path: string,
  fs: StatusPinStoreFsSeam,
  snapshot: readonly PersistedStatusPin[],
  log: (line: string) => void = (l) => process.stderr.write(l),
): void {
  const env: SnapshotEnvelope = { v: 1, pins: [...snapshot] }
  const tmp = path + '.tmp'
  try {
    fs.writeFileSync(tmp, JSON.stringify(env))
    fs.renameSync(tmp, path)
  } catch (err) {
    log(
      `status-pin-store: persist FAILED path=${path}: ${(err as Error).message} — ` +
        `durability degraded to in-memory\n`,
    )
  }
}

/**
 * A single tracked live pin claim, as the gateway holds it in memory
 * (statusPinState keyed by pinKey → PinState.messageId, plus the companion
 * statusPinChatIds pinKey → chatId map). Flattened here so the ownership guard
 * is a pure, unit-testable function decoupled from the gateway's Maps.
 */
export interface TrackedStatusPin {
  chatId: string
  messageId: number
}

/**
 * CHAT-SCOPED ownership guard for a `pinned_message` service update.
 *
 * Telegram message_ids are per-chat small integers, and the gateway tracks
 * many simultaneous pins across different chats/topics. Matching on messageId
 * ALONE is a real bug: a pin update in chat B whose pinned id happens to equal
 * a status-pin id tracked in chat A would pass, and the gateway would delete
 * chat B's service message — including an operator's MANUAL pin notice. So the
 * match REQUIRES both the messageId AND that the tracked entry lives in the
 * SAME chat as the incoming update.
 */
export function pinnedMessageIsOurs(
  tracked: Iterable<TrackedStatusPin>,
  chatId: string,
  pinnedMessageId: number,
): boolean {
  for (const t of tracked) {
    if (t.messageId === pinnedMessageId && t.chatId === chatId) return true
  }
  return false
}

/**
 * Boot-time orphan cleanup, extracted as a pure routine over injected seams so
 * the ordering + best-effort contract is unit-testable against the REAL code
 * (the gateway's thin wrapper just binds the live fs / unpin api / logger).
 *
 * Any pin persisted by a PRIOR session is stale by definition — its turn ended
 * or the session crashed before its unpin reconcile ran. We best-effort unpin
 * each persisted entry (a failure is non-fatal) and then EMPTY the store
 * regardless, so a permanently-undeliverable unpin can't re-run on every boot.
 * We do NOT re-adopt or re-pin. Returns the counts for logging/testing.
 *
 * CRITICAL: the caller MUST only invoke this AFTER winning the startup mutex.
 * The store is a shared per-agent file; on a double-boot a losing gateway
 * running this would unpin the still-alive holder's legitimate pins.
 */
export async function runStatusPinBootCleanup(args: {
  path: string
  fs: StatusPinStoreFsSeam
  unpin: (chatId: string, messageId: number) => Promise<unknown>
  log?: (line: string) => void
}): Promise<{ cleared: number; total: number }> {
  const log = args.log ?? ((l: string) => process.stderr.write(l))
  const persisted = loadStatusPins(args.path, args.fs)
  if (persisted.length === 0) return { cleared: 0, total: 0 }
  let cleared = 0
  for (const pin of persisted) {
    try {
      await args.unpin(pin.chatId, pin.messageId)
      cleared++
    } catch (err) {
      log(
        `status-pin-store: boot cleanup unpin failed ` +
          `(chat=${pin.chatId} msg=${pin.messageId}): ${(err as Error).message}\n`,
      )
    }
  }
  // Empty the store regardless — these claims belong to a dead session; leaving
  // them would re-attempt the same (already-tried) unpins on every future boot.
  persistStatusPins(args.path, args.fs, [], log)
  return { cleared, total: persisted.length }
}
