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
 * here; on boot the gateway loads the persisted set and unpins each
 * work-scoped entry (a status pin from a PRIOR session is stale by definition
 * — the turn it represented is over or crashed), dropping rows only after a
 * successful unpin (failed ones are retained with an attempt counter for a
 * next-boot retry — see runStatusPinBootCleanup). Time-scoped `tool:` rows
 * (legacy pins from the retired `pin_message` MCP tool, #3001 / #4452 — no new
 * ones are written) survive boots until their `expiresAt`.
 * It does NOT re-adopt or re-pin — it only cleans up.
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
 *  message id (so boot cleanup can unpin exactly that message).
 *
 *  Concurrency note: there is NO turn/worker-id dimension on the ownership guard
 *  because the single-gateway startup mutex (acquireStartupLock) guarantees
 *  exactly one live gateway per agent owns this shared file at a time — so a
 *  pinKey (`fg:`/`wk:`) is unambiguous within the one owning process, and boot
 *  cleanup only ever runs after winning that mutex.
 *
 *  `pending` marks a record written BEFORE the pin API call landed (persist-
 *  intent-first). A crash in the window between the pin API call and the
 *  confirming rewrite leaves a pending record on disk; next-boot cleanup unpins
 *  pending records too, closing the persist-after-pin leak. Absent/false means
 *  the pin was confirmed applied. Optional so a v1 snapshot (no field) still
 *  loads fail-open as a confirmed pin. */
export interface PersistedStatusPin {
  pinKey: string
  chatId: string
  /**
   * Forum topic the pinned message lives in, when the caller knows it.
   *
   * The durable claim is keyed by `(chat, thread)`, not by chat alone. Telegram's
   * pin stack is CHAT-WIDE — a "topic pin" is a chat-level pin whose message
   * happens to sit in that thread, and `pinChatMessage`/`unpinChatMessage` take
   * no `message_thread_id` at all. So the thread is NOT needed to unpin one
   * known message; it is needed to DRAIN a topic, because the only topic-scoped
   * pin verb a bot has is `unpinAllForumTopicMessages(chat_id, message_thread_id)`.
   *
   * Without this field a row records "there were orphan pins in forum chat X"
   * and nothing more, so a boot after a crash cannot aim the one verb that would
   * clear them — which is how a chat-wide stack grows on every restart. Optional
   * so a v1–v3 snapshot still loads; a row without it degrades to the
   * chat-level path.
   */
  threadId?: number
  messageId: number
  /** True while the pin API call is in-flight / unconfirmed (see above). */
  pending?: boolean
  /** Wall-clock ms after which this pin is stale and boot cleanup unpins it.
   *  Rows WITHOUT this field are work-scoped (fg:/wk:/banner:) — stale the
   *  moment their owning session dies, so boot cleanup unpins them
   *  unconditionally. Rows WITH it (legacy `tool:` pins from the retired
   *  `pin_message` MCP tool, #3001 / #4452 — no new ones are written)
   *  represented deliberate agent pins with no "work finished" event: they
   *  SURVIVE restarts and are only swept once expired. */
  expiresAt?: number
  /** Boot-cleanup unpin retry counter (#3001). Incremented each boot the
   *  unpin fails (flood-wait exhausted / transient 5xx); the row is retained
   *  for retry until BOOT_UNPIN_MAX_ATTEMPTS, then forfeited. Absent = 0. */
  attempts?: number
  /**
   * Wall-clock ms the pin was FIRST claimed for this key+message (#3810).
   *
   * Why the store needs it: the mid-session `wk:` reaper folds in rows that
   * exist on disk but have NO in-memory claim (`storeOnlyWorkerPinCandidates`).
   * The store used to persist no timestamp, so those candidates were stamped
   * `pinnedAt = now` on every pass — deliberately, to avoid a spurious unpin of
   * a pin whose real age was unknown, but with the side effect that the TTL
   * gate could NEVER fire for a store orphan. Combined with a `wk:<agentId>`
   * whose turnsDb row is gone (verdict `'unknown'`, never `'terminal'`), such a
   * row was never mid-session reaped AT ALL — it waited for the next boot, the
   * exact "stale pin glued to the top of the chat" failure the reaper exists to
   * prevent.
   *
   * Recording the real claim time removes the guess: a store orphan now ages
   * honestly and the ordinary TTL applies. Optional so a v1/v2 snapshot still
   * loads; a row without it keeps the old conservative `now` stamp (terminal-
   * only reaping), which self-clears within one restart since every write from
   * this version onward carries the field.
   */
  pinnedAt?: number
}

/** How many boots may retry a failing boot-cleanup unpin before the row is
 *  forfeited. Unpins are idempotent (unpinning an already-unpinned or deleted
 *  message no-ops), so retrying across boots is safe; the cap only bounds a
 *  permanently-undeliverable unpin (chat gone, bot removed) so it cannot
 *  re-fail on every boot forever. */
export const BOOT_UNPIN_MAX_ATTEMPTS = 5

/**
 * Envelope version. v1 had no `pending` field; a v1 row loads as a confirmed
 * pin (pending undefined). v2 adds the optional `pending` flag. v3 adds the
 * optional `pinnedAt` claim timestamp (#3810). v4 adds the optional `threadId`
 * so the claim is keyed by (chat, thread) and a forum topic can be drained
 * after a crash.
 *
 * ── The bump rule, which the reader depends on (#3957) ───────────────────────
 *
 * EVERY field added since v1 is OPTIONAL, and every future bump must keep that
 * property. That is what makes the versions mutually readable in both
 * directions, and {@link loadStatusPins} now cashes it in: an envelope whose
 * version this build does not know is still READ, row by row, through the same
 * structural validator. Rows it cannot validate are dropped; rows it can are
 * kept.
 *
 * Why that matters more than it looks: this file is the boot cleanup's only
 * record of which messages the gateway pinned. A reader that discarded the
 * whole file on an unfamiliar version turned every pin taken by the newer build
 * into a permanent orphan the moment an operator rolled back — manufacturing
 * exactly the bug this subsystem exists to prevent. Degrading (keep what
 * validates) is strictly safer than failing open to `[]` here, because the
 * fail-open outcome is not "do nothing", it is "forget an obligation".
 *
 * A bump that ever needs to be NON-additive — a field whose absence changes the
 * meaning of a row — must therefore change the FILENAME, not just `v`, so old
 * readers see "no file" rather than misreading rows. Do not quietly break the
 * additive rule and leave `v` to carry it.
 */
interface SnapshotEnvelope {
  v: number
  pins: PersistedStatusPin[]
}

/** The version THIS build writes. Reading is deliberately version-tolerant
 *  (see above); only the writer is pinned. */
const SNAPSHOT_VERSION = 4

function isPinRow(x: unknown): x is PersistedStatusPin {
  if (x == null || typeof x !== 'object') return false
  const o = x as Record<string, unknown>
  return (
    typeof o.pinKey === 'string' &&
    o.pinKey.length > 0 &&
    typeof o.chatId === 'string' &&
    o.chatId.length > 0 &&
    (o.threadId === undefined || typeof o.threadId === 'number') &&
    typeof o.messageId === 'number' &&
    (o.pending === undefined || typeof o.pending === 'boolean') &&
    (o.expiresAt === undefined || typeof o.expiresAt === 'number') &&
    (o.attempts === undefined || typeof o.attempts === 'number') &&
    (o.pinnedAt === undefined || typeof o.pinnedAt === 'number')
  )
}

/**
 * Load the persisted pin set. Returns [] on a missing, unreadable, or malformed
 * file (fail-open to empty: a corrupt snapshot must never crash boot — worst
 * case an orphaned pin isn't cleaned up this boot, strictly no worse than the
 * pre-persistence behaviour).
 *
 * An UNRECOGNISED envelope version is NOT malformed and does not fail open
 * (#3957). Any positive-integer `v` with an array of `pins` is read, and each
 * row is kept iff {@link isPinRow} can structurally validate it. A row written
 * by a newer build therefore survives a downgrade instead of being discarded
 * into a permanent orphan — see the {@link SnapshotEnvelope} bump rule for the
 * additive-fields property this relies on.
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
  // Version-TOLERANT, structurally strict: an unknown `v` still yields the rows
  // that validate. Only a shape that is not an envelope at all fails open.
  if (!Number.isInteger(env.v) || (env.v as number) < 1 || !Array.isArray(env.pins)) return []
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
  const env: SnapshotEnvelope = { v: SNAPSHOT_VERSION, pins: [...snapshot] }
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
 * The restart rule (#3001): a WORK-SCOPED pin persisted by a PRIOR session
 * (fg:/wk:/banner: — any row without `expiresAt`) is stale by definition — its
 * work ended or the session crashed before its unpin reconcile ran, so
 * restart = reset: it is unpinned here. This includes records left `pending`
 * (the persist-intent-first write from `reconcileAndPersistStatusPin`): a
 * crash between the pin API call and its confirming rewrite leaves a pending
 * record whose pin MAY have landed in Telegram, so we must treat it exactly
 * like a confirmed one and unpin it.
 *
 * TIME-SCOPED rows (legacy `tool:` pins from the retired `pin_message` MCP
 * tool, #4452, carrying `expiresAt`) have no "work finished" event, so a
 * restart does NOT reset them: an unexpired row is RETAINED untouched across
 * boots and only unpinned once `now >= expiresAt`.
 *
 * RETRY-SAFETY (#3001): a row is dropped only AFTER its unpin resolves. A
 * failing unpin (flood-wait exhausted / transient 5xx) retains the row with an
 * incremented `attempts` counter so the NEXT boot retries, up to
 * BOOT_UNPIN_MAX_ATTEMPTS — then the row is forfeited (a permanently-
 * undeliverable unpin must not re-fail on every boot forever). Unpins are
 * idempotent, so the retry can never double-unpin harmfully. We do NOT
 * re-adopt or re-pin. Returns the counts for logging/testing.
 *
 * CRITICAL: the caller MUST only invoke this AFTER winning the startup mutex.
 * The store is a shared per-agent file; on a double-boot a losing gateway
 * running this would unpin the still-alive holder's legitimate pins.
 */
export async function runStatusPinBootCleanup(args: {
  path: string
  fs: StatusPinStoreFsSeam
  unpin: (chatId: string, messageId: number) => Promise<unknown>
  now?: number
  log?: (line: string) => void
}): Promise<{ cleared: number; retained: number; kept: number; total: number }> {
  const log = args.log ?? ((l: string) => process.stderr.write(l))
  const now = args.now ?? Date.now()
  const persisted = loadStatusPins(args.path, args.fs)
  if (persisted.length === 0) return { cleared: 0, retained: 0, kept: 0, total: 0 }
  let cleared = 0
  let retained = 0
  let kept = 0
  const next: PersistedStatusPin[] = []
  for (const pin of persisted) {
    // Unexpired time-scoped row (tool: pin): deliberately survives the
    // restart — keep it as-is, no unpin.
    if (pin.expiresAt != null && pin.expiresAt > now) {
      next.push(pin)
      kept++
      continue
    }
    try {
      await args.unpin(pin.chatId, pin.messageId)
      cleared++
    } catch (err) {
      const attempts = (pin.attempts ?? 0) + 1
      log(
        `status-pin-store: boot cleanup unpin failed ` +
          `(chat=${pin.chatId} msg=${pin.messageId} attempt=${attempts}): ` +
          `${(err as Error).message}\n`,
      )
      if (attempts < BOOT_UNPIN_MAX_ATTEMPTS) {
        // Retain for a retry on the next boot instead of forfeiting the
        // orphan permanently (retry-safe boot sweep, #3001).
        next.push({ ...pin, attempts })
        retained++
      } else {
        log(
          `status-pin-store: boot cleanup FORFEITING pin after ` +
            `${attempts} failed unpin attempts ` +
            `(key=${pin.pinKey} chat=${pin.chatId} msg=${pin.messageId}) — ` +
            `will not retry again\n`,
        )
      }
    }
  }
  persistStatusPins(args.path, args.fs, next, log)
  return { cleared, retained, kept, total: persisted.length }
}

/**
 * The pin action the gateway wants to take for one key, distilled from
 * `decidePinAction`. `pin` carries the target message id; `clear` covers both
 * unpin and no-longer-pinned. The gateway's reconcile computes this and hands
 * it here so the persist-BEFORE-pin ordering lives in one testable place.
 */
export type StatusPinPersistOp =
  | { kind: 'pin'; messageId: number }
  | { kind: 'clear' }

/**
 * Per-PATH async serial lock. status-pins.json has multiple concurrent writers
 * (the fg:/wk: status-pin reconciles AND the banner:owner row), each of which
 * is a read-modify-write against the shared file. Without serialisation two
 * writers can interleave their load→persist and clobber each other's rows.
 *
 * `withStoreLock(path, fn)` chains `fn` after the current tail promise for that
 * path and returns fn's result. The stored tail NEVER rejects (a failing op
 * can't wedge the chain), and `fn` runs regardless of whether the prior op
 * resolved or rejected.
 */
const storeLockTails = new Map<string, Promise<unknown>>()

export function withStoreLock<T>(
  path: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = storeLockTails.get(path) ?? Promise.resolve()
  // Run fn after prev settles either way (fn ignores the settled value).
  const run = prev.then(fn, fn)
  // Keep a non-rejecting tail so one failed op can't poison every later one.
  storeLockTails.set(
    path,
    run.then(
      () => undefined,
      () => undefined,
    ),
  )
  return run
}

/**
 * Per-pinKey async serial lock (F2, invisible-worker-cards review).
 *
 * The gateway's status-pin reconcile reads its `prev` claim from an in-memory
 * map at the TOP of the reconcile, then awaits the persist+pin. Two overlapping
 * reconciles for the SAME key could each capture a stale `prev`: a turn-end
 * `{pinned:false}` reading prev=null no-ops and clears the durable row while a
 * flood-delayed open-pin lands right after — a stuck pin with NO on-disk record.
 *
 * Chaining every reconcile for one pinKey through this tail map guarantees the
 * NEXT reconcile reads `prev` only after the prior one for that key has fully
 * settled (its in-memory Maps updated), so the pin decision always sees the true
 * current claim. Different keys never contend. Same non-rejecting-tail contract
 * as `withStoreLock`. Keyed by pinKey, held by the gateway around the WHOLE
 * read-prev → decide → reconcileAndPersistStatusPin → update-Maps sequence.
 */
const pinReconcileTails = new Map<string, Promise<unknown>>()

export function withPinReconcileLock<T>(
  pinKey: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = pinReconcileTails.get(pinKey) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  pinReconcileTails.set(
    pinKey,
    run.then(
      () => undefined,
      () => undefined,
    ),
  )
  return run
}

/**
 * READ-MODIFY-WRITE for exactly ONE pinKey's row, against the authoritative
 * on-disk file. Loads the current snapshot from disk, drops any row for
 * `pinKey`, appends `row` (unless null = removal), and persists atomically.
 *
 * Crucially the OTHER rows come from disk, never from an in-memory map that may
 * lag disk — so a writer can never drop another key's pending/confirmed row.
 * NOT locked itself; callers run it inside `withStoreLock`.
 */
function applyStatusPinRow(
  path: string,
  fs: StatusPinStoreFsSeam,
  pinKey: string,
  row: PersistedStatusPin | null,
  log: (line: string) => void,
): void {
  const current = loadStatusPins(path, fs)
  const others = current.filter((p) => p.pinKey !== pinKey)
  const next = row == null ? others : [...others, row]
  persistStatusPins(path, fs, next, log)
}

/**
 * Public single-key mutation, serialised through the per-path lock. Upserts (or
 * removes, when `row` is null) ONLY `pinKey`'s row, preserving every other row
 * as it currently is ON DISK. This is the write path for pin kinds that don't
 * need the pending→confirm dance (e.g. the banner:owner row); the status-pin
 * reconcile uses `reconcileAndPersistStatusPin`, which holds the same lock
 * across its whole pending→pin→confirm sequence.
 */
export function mutateStatusPinRow(
  path: string,
  fs: StatusPinStoreFsSeam,
  pinKey: string,
  row: PersistedStatusPin | null,
  log: (line: string) => void = (l) => process.stderr.write(l),
): Promise<void> {
  return withStoreLock(path, async () => {
    applyStatusPinRow(path, fs, pinKey, row, log)
  })
}

/**
 * Persist-ordering wrapper closing the persist-AFTER-pin leak window.
 *
 * THE BUG this fixes: previously the gateway pinned the Telegram message FIRST,
 * then snapshotted the claim set to disk. A SIGKILL landing between the pin API
 * call succeeding and the snapshot rename left a pin live in Telegram with NO
 * on-disk record — so next-boot cleanup couldn't see it and the pin lingered
 * forever.
 *
 * THE FIX: for a `pin`, write a `pending` record to disk BEFORE issuing the pin
 * API call, then rewrite it as confirmed (pending cleared) once the pin lands
 * — or drop it if the pin failed. Now a crash anywhere in the window leaves a
 * pending record on disk, and boot cleanup unpins pending records too (see
 * runStatusPinBootCleanup), so the orphan is recovered next boot.
 *
 * CONCURRENCY: the ENTIRE op (pending write → await applyPin → confirm/clear
 * write) runs under the per-path `withStoreLock`, so no other writer can
 * interleave during the applyPin await window. Each disk write is a
 * read-modify-write (`applyStatusPinRow`) keyed on THIS pinKey against the
 * on-disk file — the other keys' rows (including a banner row, or another
 * concurrent key's pending row) come from disk and are always preserved. This
 * closes the race where a snapshot rebuilt from the (lagging) in-memory map
 * dropped an in-flight key's row.
 *
 * `applyPin` performs the real Telegram pin/unpin (the gateway binds
 * `reconcilePin`) and returns the next in-memory state so the caller can update
 * its Map. Never throws — persistence is best-effort/fail-open and pin errors
 * are already swallowed by `applyPin` (reconcilePin).
 */
export function reconcileAndPersistStatusPin(args: {
  path: string
  fs: StatusPinStoreFsSeam
  pinKey: string
  chatId: string
  /** Forum topic the pinned message lives in, when known — persisted so a boot
   *  after a crash can aim `unpinAllForumTopicMessages` at the right topic. */
  threadId?: number
  op: StatusPinPersistOp
  /** Execute the real pin/unpin; returns the confirmed message id (pin) or
   *  null (cleared). Must never throw — API errors are swallowed inside. */
  applyPin: () => Promise<{ messageId: number } | null>
  /** Clock for the `pinnedAt` stamp (#3810). Defaults to wall clock. */
  now?: number
  log?: (line: string) => void
}): Promise<{ messageId: number } | null> {
  const { path, fs, pinKey, chatId, threadId, op } = args
  const log = args.log ?? ((l: string) => process.stderr.write(l))
  const now = args.now ?? Date.now()

  /**
   * The claim age to persist for `messageId`. Carried forward from the row
   * already on disk when it names the SAME message (a steady-state re-write
   * must not reset the age and hand a stale pin a fresh TTL lease); stamped
   * `now` for a genuinely new pin. Mirrors the in-memory `pinnedAt` rule in
   * `status-pin-retarget.ts` so disk and memory can't disagree about age.
   */
  const claimAge = (messageId: number): number => {
    const existing = loadStatusPins(path, fs).find((p) => p.pinKey === pinKey)
    return existing?.messageId === messageId && existing.pinnedAt != null
      ? existing.pinnedAt
      : now
  }

  // Hold the per-path lock across the WHOLE op so no other writer (a banner
  // persist, or another key's reconcile) can rebuild/overwrite the file during
  // the applyPin await window and drop this key's pending/confirmed row.
  return withStoreLock(path, async () => {
    if (op.kind === 'pin') {
      const pinnedAt = claimAge(op.messageId)
      // Persist INTENT first, marked pending — BEFORE the pin API call. If we
      // crash after the pin lands but before the confirm rewrite, this pending
      // record is what boot cleanup uses to unpin the orphan.
      applyStatusPinRow(
        path,
        fs,
        pinKey,
        { pinKey, chatId, threadId, messageId: op.messageId, pending: true, pinnedAt },
        log,
      )
      const next = await args.applyPin()
      if (next == null) {
        // Pin failed (claim NOT taken by reconcilePin). Clear the pending
        // record so we don't leave a phantom claim for a pin that never landed.
        applyStatusPinRow(path, fs, pinKey, null, log)
        return null
      }
      // Pin confirmed — rewrite the record without the pending flag.
      applyStatusPinRow(
        path,
        fs,
        pinKey,
        { pinKey, chatId, threadId, messageId: next.messageId, pinnedAt: claimAge(next.messageId) },
        log,
      )
      return next
    }

    // clear: unpin (best-effort) THEN reconcile the record with the OUTCOME.
    //
    // F1 (invisible-worker-cards review): a `clear` op covers BOTH a genuine
    // unpin AND a `noop: already pinned` — the pin decision maps every non-`pin`
    // action here (see decidePinAction → the gateway's op mapping). For a real
    // unpin, applyPin drops the claim and returns null → we remove the row. But
    // for a noop-already-pinned, reconcilePin returns the LIVE claim unchanged
    // (non-null) and issues NO Telegram call — the pin is still up. The worker
    // feed calls syncPin on EVERY steady-state edit, so a noop-clear fires
    // constantly; unconditionally deleting the row there erased the durable
    // status-pins.json entry for a still-live pin. A crash after that left a
    // stuck pinned card boot cleanup could never see. So: only drop the row when
    // the claim is actually gone (next == null); when applyPin returns a live
    // claim, PRESERVE the row (rewritten confirmed) so the durable record keeps
    // tracking the pin that is genuinely still up. No extra Telegram API call is
    // added — applyPin already ran; this only changes the disk write's content.
    // Ordering for the real-unpin case is safe: if we crash after the unpin but
    // before the rewrite, the stale record just gets unpinned again next boot
    // (idempotent), never a lingering pin.
    const next = await args.applyPin()
    if (next == null) {
      applyStatusPinRow(path, fs, pinKey, null, log)
    } else {
      // Steady-state noop-clear (the worker feed calls syncPin on every edit):
      // the pin is still up, so the row is preserved AND so is its original
      // claim age — re-stamping it here would hand a genuinely old pin a fresh
      // TTL lease on every feed edit and make it immortal (#3810).
      applyStatusPinRow(
        path,
        fs,
        pinKey,
        { pinKey, chatId, threadId, messageId: next.messageId, pinnedAt: claimAge(next.messageId) },
        log,
      )
    }
    return next
  })
}
