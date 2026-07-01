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
