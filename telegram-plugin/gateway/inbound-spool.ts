/**
 * inbound-spool.ts — durable, crash-tolerant spool for buffered inbound.
 *
 * Why this exists: `pending-inbound-buffer.ts` is in-memory only. A
 * gateway/container restart (switchroom update, agent restart, a
 * self-restart, an OOM) destroys it — so the user-facing promise
 * "⏳ your message is queued and will be processed when it reconnects"
 * (gateway.ts) is a lie across a restart. Proven twice: finn and
 * carrie (2026-05-19) lost the user's message on restart and the user
 * had to resend. #1546/#1549 only shrank the in-memory delivery
 * window; they cannot survive process death.
 *
 * This module makes the promise DETERMINISTIC: every buffered inbound
 * is also appended to a JSONL spool on the persistent per-agent volume
 * (`/state/agent/telegram/…`, survives container recreate). On boot the
 * gateway replays un-acked entries back into the in-memory buffer, so
 * the existing drain machinery delivers them. An entry is acked (and
 * tombstoned) ONLY on confirmed delivery to a live registered bridge.
 * Un-acked entries older than `escalateAfterMs` are surfaced to the
 * user via an explicit "couldn't deliver — resend?" callback and then
 * dropped: the promise is then ALWAYS resolved — kept, or visibly
 * retracted — never silently lost.
 *
 * Scope (v1): the ack is "delivered to a live registered bridge", not
 * "claude consumed it". A true claude→gateway consumption-ack needs a
 * new bidirectional bridge protocol (high blast radius) and is a
 * documented follow-up. v1 already eliminates the silent-loss-on-
 * restart class — the actual incident class.
 *
 * Crash-consistency: append-only JSONL, one self-contained JSON object
 * per line, written with a trailing newline in a single `appendFileSync`
 * (atomic for small writes on local fs). A torn final line on a crash
 * mid-write is tolerated: replay skips any line that does not
 * round-trip `JSON.parse` + shape-check. Acks are themselves appended
 * as tombstone lines (`{t:"ack",id}`) rather than rewriting the file;
 * a bounded `compact()` rewrites the file dropping acked/escalated ids
 * when it grows past `compactAtBytes`.
 *
 * This module is PURE w.r.t. its injected fs + clock seams so the
 * crash/dedup/replay/escalation logic is unit-tested without a real
 * gateway (mirrors the #1544/#1546/#1549 pure-seam idiom).
 */

import { dirname } from 'node:path'
import type { InboundMessage } from './ipc-protocol.js'

/** Stable dedup id for an inbound. Real Telegram messages have a
 *  unique (chatId, messageId). Synthetic/cron inbounds use messageId
 *  0 — fall back to a deterministic id from source+ts so retried
 *  synthetics of the SAME logical event dedup, but distinct events
 *  (different ts) do not collapse. */
export function spoolId(msg: InboundMessage): string {
  // Subagent handbacks (#1719): the JSONL agent id is unique per
  // Claude Code spawn, so use it as the dedup key. This makes the id
  // stable across the watcher's onFinish race AND across a
  // gateway/container restart — so a re-built handback envelope for
  // the same finished sub-agent collapses against the live spool
  // entry (or its tombstone) instead of minting a fresh ts-derived
  // id and re-firing the turn. See issue #1719.
  if (
    msg.meta?.source === 'subagent_handback' &&
    typeof msg.meta?.subagent_jsonl_id === 'string' &&
    msg.meta.subagent_jsonl_id.length > 0
  ) {
    return `s:handback:${msg.meta.subagent_jsonl_id}`
  }
  // Subagent progress envelopes (#1720): deterministic per (jsonl id,
  // bucket idx) — every elapsed bucket collapses to one live entry, so
  // a re-fire within the same bucket window (or after a gateway
  // restart) is a structural no-op. The bucket idx is computed by the
  // gateway from `floor(elapsedMs / progressIntervalMs)` so a worker
  // that emits narrative lines every 30s only produces one envelope
  // per bucket. Mirrors the #1719 handback-spoolId pattern.
  if (
    msg.meta?.source === 'subagent_progress' &&
    typeof msg.meta?.subagent_jsonl_id === 'string' &&
    msg.meta.subagent_jsonl_id.length > 0 &&
    typeof msg.meta?.bucket_idx === 'string' &&
    msg.meta.bucket_idx.length > 0
  ) {
    return `s:progress:${msg.meta.subagent_jsonl_id}:${msg.meta.bucket_idx}`
  }
  // Boot-resume inbounds (honest-restart-resume): deterministic per
  // interrupted turn so a multi-restart sequence (operator restarts again
  // before the agent drains the first resume) collapses to ONE resume of
  // a given turn instead of stacking N. Keyed on the synthetic messageId
  // (=ts, fresh every boot) would re-fire each boot; the turn_key is the
  // stable identity. Both resume sources share the namespace because a
  // given turn can only be one or the other.
  if (
    (msg.meta?.source === 'resume_interrupted' ||
      msg.meta?.source === 'resume_watchdog_timeout' ||
      msg.meta?.source === 'resume_deferred') &&
    typeof msg.meta?.resume_turn_key === 'string' &&
    msg.meta.resume_turn_key.length > 0
  ) {
    return `s:resume:${msg.meta.resume_turn_key}`
  }
  // Gateway boot briefing (session_continuity.briefing: gateway): keyed
  // per chat, NOT per boot — the synthetic messageId is the boot's ts, so
  // without this a multi-restart sequence would stack one briefing per
  // boot. One live briefing per chat at a time; once delivered (acked) a
  // later boot can mint a fresh one. Staleness is separately bounded by
  // the entry's meta.expiresAt TTL (see liveEntries).
  if (msg.meta?.source === 'boot_briefing') {
    return `s:boot-briefing:${msg.chatId}`
  }
  // Cron BOOT-REPLAY (#2793 part B): a scheduled fire that the boot
  // replay re-injects because it was missed across a restart. Keyed on
  // the minute-aligned fire it is replaying (`replay_fire_ms`) plus the
  // schedule index, NOT the fresh synthetic `messageId` (=ts, minted per
  // replay attempt) — so a re-replay of the SAME missed fire across a
  // subsequent gateway restart collapses to ONE live spool entry instead
  // of stacking a fresh one each boot. This is what makes routing cron
  // replays through the durable spool at-least-once WITH dedup, mirroring
  // the resume/handback stable-id idiom above. Live (non-replay) cron
  // ticks never set `replay_fire_ms`, so they are unaffected and keep
  // their per-fire identity.
  if (
    msg.meta?.source === 'cron' &&
    typeof msg.meta?.replay_fire_ms === 'string' &&
    msg.meta.replay_fire_ms.length > 0
  ) {
    const idx =
      typeof msg.meta?.schedule_index === 'string' && msg.meta.schedule_index.length > 0
        ? msg.meta.schedule_index
        : '-'
    return `s:cron-replay:${msg.chatId}:${idx}:${msg.meta.replay_fire_ms}`
  }
  if (typeof msg.messageId === 'number' && msg.messageId > 0) {
    return `m:${msg.chatId}:${msg.messageId}`
  }
  const src = msg.meta?.source ?? '-'
  return `s:${msg.chatId}:${src}:${msg.ts}`
}

interface SpoolRecord {
  t: 'put' | 'ack' | 'esc'
  /** Present on `put`/`ack` (spoolId). Absent on `esc`. */
  id?: string
  /** Present only on `put`. The full inbound to replay. */
  msg?: InboundMessage
  /** Present only on `put`. Owning agent (replay re-pushes per agent). */
  agent?: string
  /** Present only on `put`. ms epoch first-spooled — drives escalation. */
  firstAt?: number
  /** Present only on `esc` — the chat the give-up notice was/would be
   *  posted to, and when. Durably records the per-chat escalation-notice
   *  window so a burst of undeliverable inbounds (or a multi-restart
   *  outage) produces ONE "couldn't deliver" notice per chat, not one
   *  per dropped entry. */
  chat?: string | number
  thread?: string
  at?: number
}

/** Stable per-(chat,thread) key for coalescing give-up notices. */
function escChatKey(msg: InboundMessage): string {
  const threadRaw = msg.meta?.threadId
  const thread =
    typeof threadRaw === 'string' && threadRaw.length > 0 ? threadRaw : '-'
  return `${msg.chatId}:${thread}`
}

export interface InboundSpoolFsSeam {
  appendFileSync: (path: string, data: string) => void
  readFileSync: (path: string) => string
  writeFileSync: (path: string, data: string) => void
  /** Atomic same-dir replace (POSIX rename). Used so compaction can't
   *  lose entries to a crash mid-rewrite. */
  renameSync: (from: string, to: string) => void
  existsSync: (path: string) => boolean
  statSizeSync: (path: string) => number
  /** fsync the FILE at `path` — flush its bytes to stable storage.
   *  `appendFileSync` returning only means the page cache took the write;
   *  without this a host power cut loses the record even though every
   *  syscall succeeded. */
  fsyncFileSync: (path: string) => void
  /** fsync the DIRECTORY at `path` — makes a completed `renameSync`
   *  durable. rename(2) is atomic (never a torn file) but that is an
   *  ordering guarantee, not a durability one: the new directory entry
   *  lives in the parent's own cached metadata and can vanish in a power
   *  cut. Call AFTER the rename. */
  fsyncDirSync: (path: string) => void
}

export interface InboundSpoolOptions {
  path: string
  fs: InboundSpoolFsSeam
  now?: () => number
  log?: (line: string) => void
  /** Un-acked entries older than this are escalated then dropped.
   *  Default 15 min — comfortably past the 5-min silence-poke ladder
   *  so self-heal gets every chance before we retract the promise. */
  escalateAfterMs?: number
  /** Rewrite-compact the JSONL once it exceeds this. Default 256 KiB. */
  compactAtBytes?: number
  /** Coalescing window for the user-facing "couldn't deliver" notice,
   *  per chat. The window SLIDES on every escalation attempt (posted or
   *  suppressed), so a sustained burst posts exactly one notice and only
   *  re-notifies after the burst goes quiet for this long. Must exceed
   *  the rate at which undeliverable entries age out (the 15-min
   *  `escalateAfterMs` here) or back-to-back attempts wouldn't coalesce.
   *  Default 30 min. */
  escalateNoticeCooldownMs?: number
  /**
   * #2789 B: fired whenever spool durability changes state — an append
   * fails (durability has silently degraded to in-memory-only, so a
   * later crash loses those messages) or recovers. Latches: called once
   * on the transition into degraded and once on the transition back to
   * healthy, not on every append. Lets the gateway raise a health
   * signal instead of quietly continuing as if the durable promise
   * still held. Best-effort — a throw here never breaks delivery.
   */
  onDegraded?: (info: {
    degraded: boolean
    consecutiveFailures: number
    path: string
    error?: string
  }) => void
}

export interface ReplayEntry {
  agent: string
  msg: InboundMessage
}

export interface InboundSpool {
  /** Durably record `msg` for `agent`. Idempotent by spoolId: a
   *  re-spool of an already-live id is a no-op (returns false). */
  put: (agent: string, msg: InboundMessage) => boolean
  /** Tombstone `id` — call ONLY on confirmed delivery to a live
   *  registered bridge. Idempotent. */
  ack: (msg: InboundMessage) => void
  /** Live (un-acked) entries, oldest first. Used at boot to re-push
   *  into the in-memory buffer. Pure read — does not mutate.
   *
   *  TTL (#1720): an entry whose `msg.meta.expiresAt` is a numeric ms
   *  epoch in the past is OMITTED from the result. Progress envelopes
   *  carry a TTL because stale progress lies ("still working (5m)"
   *  delivered 4h after the worker finished is worse than no progress);
   *  handback envelopes never set `expiresAt` so this is a no-op for
   *  them. */
  liveEntries: () => ReplayEntry[]
  /** Drop every live entry whose spool id matches the predicate. Used
   *  by the handback path (#1720) to sweep stale progress envelopes
   *  for the same sub-agent at the moment the handback is queued —
   *  otherwise a progress envelope queued moments before the worker
   *  finished could land on top of the handback turn. Tombstones the
   *  dropped entries durably. */
  dropMatching: (predicate: (id: string) => boolean) => number
  /** Escalate+drop entries older than `escalateAfterMs`. Every dropped
   *  entry is tombstoned (the promise is retracted deterministically),
   *  but the user-facing notice is COALESCED per chat: `onEscalate` is
   *  called for every dropped entry with `postNotice` indicating whether
   *  to actually post the "couldn't deliver" card. `postNotice` is true
   *  only for the first escalation to a given chat within
   *  `escalateNoticeCooldownMs` — a burst of undeliverable inbounds (e.g.
   *  a synthetic re-created every 15 min while the agent is down, across
   *  restarts) yields ONE notice, not one per entry. The window is
   *  persisted, so it holds across a gateway restart. `droppedCount` is
   *  the real number of entries dropped for that entry's chat in THIS
   *  sweep, so the coalesced notice reports the true multi-message loss
   *  count instead of under-reporting it as one (#2789 C). Returns the
   *  total count of entries dropped. Safe to call on a timer. */
  sweepEscalations: (
    onEscalate: (
      e: ReplayEntry,
      opts: { postNotice: boolean; droppedCount: number },
    ) => void,
  ) => number
  /** Test/observability: count of live (un-acked) ids. */
  liveCount: () => number
  /** #2789 B: true while spool appends are failing — durability has
   *  degraded to in-memory-only. A health signal the gateway can surface
   *  instead of quietly dropping the durability guarantee. */
  isDegraded: () => boolean
  /** #2789 B: consecutive append failures since the last success. */
  appendFailureCount: () => number
}

export function createInboundSpool(opts: InboundSpoolOptions): InboundSpool {
  const { path, fs } = opts
  const now = opts.now ?? Date.now
  const log = opts.log ?? ((l: string) => process.stderr.write(l))
  const escalateAfterMs = opts.escalateAfterMs ?? 15 * 60 * 1000
  const compactAtBytes = opts.compactAtBytes ?? 256 * 1024
  const escalateNoticeCooldownMs = opts.escalateNoticeCooldownMs ?? 30 * 60 * 1000

  // In-memory projection of the on-disk log, rebuilt from the file at
  // construction. `live` maps spoolId → the put record (insertion order
  // preserved via the Map). An `ack` deletes from `live`.
  const live = new Map<string, { agent: string; msg: InboundMessage; firstAt: number }>()
  // Per-chat last escalation-ATTEMPT time (posted or suppressed). Drives
  // the sliding coalescing window so a burst of give-up escalations posts
  // one notice. Rebuilt from durable `esc` records at construction so the
  // window survives a gateway restart (the actual 2026-06-09 spam: a
  // synthetic re-aged into the bound every 15 min across many restarts).
  const escAttemptByChat = new Map<string, number>()

  // #2789 B: append-durability health. `consecutiveAppendFailures`
  // counts failed appends since the last success; `degraded` latches so
  // the onDegraded callback fires exactly once per state transition
  // (into degraded / back to healthy) rather than on every append.
  let consecutiveAppendFailures = 0
  let degraded = false

  function parseLine(line: string): SpoolRecord | null {
    const s = line.trim()
    if (!s) return null
    let rec: unknown
    try {
      rec = JSON.parse(s)
    } catch {
      return null // torn / partial line from a crash mid-append — skip
    }
    if (rec == null || typeof rec !== 'object') return null
    const r = rec as Record<string, unknown>
    if (r.t !== 'put' && r.t !== 'ack' && r.t !== 'esc') return null
    if (r.t === 'esc') {
      // esc records key on chat, not a spoolId.
      if (typeof r.chat !== 'string' && typeof r.chat !== 'number') return null
      if (typeof r.at !== 'number') return null
      return r as unknown as SpoolRecord
    }
    if (typeof r.id !== 'string' || r.id.length === 0) return null
    if (r.t === 'put') {
      if (r.msg == null || typeof r.msg !== 'object') return null
      if (typeof r.agent !== 'string' || r.agent.length === 0) return null
      if (typeof r.firstAt !== 'number') return null
    }
    return r as unknown as SpoolRecord
  }

  // Rebuild `live` from the file. Tolerates a torn last line.
  function hydrate(): void {
    live.clear()
    escAttemptByChat.clear()
    if (!fs.existsSync(path)) return
    let raw = ''
    try {
      raw = fs.readFileSync(path)
    } catch {
      return
    }
    for (const line of raw.split('\n')) {
      const rec = parseLine(line)
      if (rec == null) continue
      if (rec.t === 'put') {
        // Last put for an id wins; an ack later removes it.
        live.set(rec.id as string, {
          agent: rec.agent as string,
          msg: rec.msg as InboundMessage,
          firstAt: rec.firstAt as number,
        })
      } else if (rec.t === 'esc') {
        // Last escalation-attempt time per chat wins (records are in
        // append order). Restores the sliding window across a restart.
        escAttemptByChat.set(`${rec.chat}:${rec.thread ?? '-'}`, rec.at as number)
      } else {
        live.delete(rec.id as string)
      }
    }
  }

  function appendRecord(rec: SpoolRecord): void {
    try {
      fs.appendFileSync(path, JSON.stringify(rec) + '\n')
      // Durability barrier. The whole point of this file is that the
      // record survives the process dying, and `appendFileSync` alone
      // only guarantees the page cache holds it — enough for a SIGKILL,
      // not for a host power cut. fsync before we report success, so a
      // failure here is treated as the durability loss it is (latched
      // `degraded`) rather than a silent downgrade to in-memory.
      fs.fsyncFileSync(path)
      // #2789 B: a successful append after a failure run means the spool
      // is durable again — un-latch degraded state and surface recovery
      // so the health signal clears.
      if (consecutiveAppendFailures > 0) {
        log(
          `inbound-spool: append recovered path=${path} after ` +
          `${consecutiveAppendFailures} failure(s) — durability restored\n`,
        )
        consecutiveAppendFailures = 0
        if (degraded) {
          degraded = false
          try {
            opts.onDegraded?.({ degraded: false, consecutiveFailures: 0, path })
          } catch {
            /* health signal is best-effort; never break delivery */
          }
        }
      }
    } catch (err) {
      // Durability is best-effort relative to fs availability; a spool
      // write failure must NOT break live delivery. But it must NOT be
      // SILENT either (#2789 B) — a persistently failing spool means
      // we're back to in-memory-only semantics and a later crash loses
      // the message. Log loudly on every failure AND raise a latched
      // health signal on the transition into degraded so the operator /
      // health surface knows the durability guarantee is gone.
      consecutiveAppendFailures++
      const message = (err as Error).message
      log(
        `inbound-spool: append FAILED path=${path} id=${rec.id} t=${rec.t}: ` +
        `${message} — durability degraded to in-memory ` +
        `(consecutive failures=${consecutiveAppendFailures})\n`,
      )
      if (!degraded) {
        degraded = true
        try {
          opts.onDegraded?.({
            degraded: true,
            consecutiveFailures: consecutiveAppendFailures,
            path,
            error: message,
          })
        } catch {
          /* health signal is best-effort; never break delivery */
        }
      }
    }
  }

  function maybeCompact(): void {
    let size = 0
    try {
      size = fs.existsSync(path) ? fs.statSizeSync(path) : 0
    } catch {
      return
    }
    if (size <= compactAtBytes) return
    // Rewrite the file as exactly the current live set (one put per
    // live id, no acks). ATOMIC: write a sibling tmp then rename over
    // the real path. rename(2) is atomic within a filesystem, so a
    // crash at any point leaves EITHER the full pre-compaction log OR
    // the full compacted log on disk — never a truncated/torn file
    // that loses live entries after the tear. (Plain writeFileSync is
    // not atomic; a crash mid-write of a >256 KiB rewrite could drop
    // entries past the tear — the residual the reviewer flagged.)
    const lines: string[] = []
    for (const [id, e] of live) {
      lines.push(
        JSON.stringify({ t: 'put', id, agent: e.agent, msg: e.msg, firstAt: e.firstAt } satisfies SpoolRecord),
      )
    }
    // Preserve the latest escalation-attempt time per chat so the sliding
    // coalescing window isn't reset by compaction (which would let the next
    // burst re-spam). One record per chat — bounded by the chat count.
    for (const [key, at] of escAttemptByChat) {
      const sep = key.lastIndexOf(':')
      const chat = key.slice(0, sep)
      const thread = key.slice(sep + 1)
      lines.push(
        JSON.stringify({
          t: 'esc',
          chat,
          ...(thread !== '-' ? { thread } : {}),
          at,
        } satisfies SpoolRecord),
      )
    }
    const tmp = path + '.compact.tmp'
    try {
      fs.writeFileSync(tmp, lines.length ? lines.join('\n') + '\n' : '')
      // fsync the tmp file BEFORE publishing it: rename orders the
      // metadata, it does not put the DATA on the platter. Renaming an
      // unsynced tmp over the log can leave the spool naming a file whose
      // contents were never written — worse than not compacting at all.
      fs.fsyncFileSync(tmp)
      fs.renameSync(tmp, path)
      log(`inbound-spool: compacted path=${path} live=${live.size}\n`)
    } catch (err) {
      // Compaction is opportunistic — a failure keeps the (larger but
      // correct) append-only log; never lose data trying to shrink it.
      log(`inbound-spool: compact FAILED path=${path}: ${(err as Error).message}\n`)
      return
    }
    // ...then fsync the containing DIRECTORY, which is what makes the rename
    // itself survive a power cut. Separate try: the rename has already
    // landed, so this failing is a weaker durability claim, NOT a failed
    // compaction — logging it as one would send an operator hunting a
    // rewrite that actually worked.
    try {
      fs.fsyncDirSync(dirname(path))
    } catch (err) {
      log(
        `inbound-spool: compact directory fsync FAILED path=${path}: ` +
        `${(err as Error).message} — compacted log written but the rename ` +
        `may not survive a power cut\n`,
      )
    }
  }

  hydrate()

  return {
    put(agent, msg) {
      const id = spoolId(msg)
      if (live.has(id)) return false // dedup: already spooled & un-acked
      const firstAt = now()
      live.set(id, { agent, msg, firstAt })
      appendRecord({ t: 'put', id, agent, msg, firstAt })
      maybeCompact()
      return true
    },
    ack(msg) {
      const id = spoolId(msg)
      if (!live.has(id)) return // idempotent / unknown id
      live.delete(id)
      appendRecord({ t: 'ack', id })
      maybeCompact()
    },
    liveEntries() {
      // Insertion order = Map iteration order = oldest first.
      // TTL filter (#1720): skip entries whose meta.expiresAt is in the
      // past. The on-disk log keeps them (cheap); compaction sweeps.
      const cutoff = now()
      const out: ReplayEntry[] = []
      for (const e of live.values()) {
        const expRaw = e.msg.meta?.expiresAt
        if (typeof expRaw === 'string' && expRaw.length > 0) {
          const exp = Number(expRaw)
          if (Number.isFinite(exp) && exp <= cutoff) continue
        }
        out.push({ agent: e.agent, msg: e.msg })
      }
      return out
    },
    dropMatching(predicate) {
      let n = 0
      for (const [id, _e] of [...live.entries()]) {
        if (!predicate(id)) continue
        live.delete(id)
        appendRecord({ t: 'ack', id })
        n++
      }
      if (n > 0) maybeCompact()
      return n
    },
    sweepEscalations(onEscalate) {
      const tNow = now()
      const cutoff = tNow - escalateAfterMs
      // First pass (#2789 C): identify the entries to drop and count them
      // per chat so the (coalesced) notice reports the REAL number of
      // dropped messages instead of under-counting a multi-message drop
      // as a single one. Iteration order is preserved so the tombstone /
      // esc append order is unchanged.
      const toDrop: {
        id: string
        e: { agent: string; msg: InboundMessage; firstAt: number }
      }[] = []
      const perChatCount = new Map<string, number>()
      for (const [id, e] of live.entries()) {
        if (e.firstAt > cutoff) continue
        toDrop.push({ id, e })
        const key = escChatKey(e.msg)
        perChatCount.set(key, (perChatCount.get(key) ?? 0) + 1)
      }
      let dropped = 0
      let posted = 0
      for (const { id, e } of toDrop) {
        live.delete(id)
        appendRecord({ t: 'ack', id }) // tombstone — promise retracted
        // Coalesce the user-facing notice per chat on a SLIDING window:
        // post only when the last attempt to this chat was longer ago than
        // the cooldown; every attempt (posted or not) slides the window, so
        // a sustained burst stays quiet after the first notice and only
        // re-notifies once the burst goes quiet. Durable via `esc` records.
        const key = escChatKey(e.msg)
        const lastAttempt = escAttemptByChat.get(key)
        const postNotice =
          lastAttempt === undefined || tNow - lastAttempt >= escalateNoticeCooldownMs
        escAttemptByChat.set(key, tNow)
        const threadRaw = e.msg.meta?.threadId
        const thread =
          typeof threadRaw === 'string' && threadRaw.length > 0 ? threadRaw : undefined
        appendRecord({ t: 'esc', chat: e.msg.chatId, thread, at: tNow })
        try {
          // #2789 C: hand the caller the real per-chat drop count for
          // THIS sweep so the notice it posts can say "N messages" rather
          // than under-reporting a multi-message drop as a single one.
          onEscalate(
            { agent: e.agent, msg: e.msg },
            { postNotice, droppedCount: perChatCount.get(key) ?? 1 },
          )
        } catch (err) {
          log(`inbound-spool: onEscalate threw id=${id}: ${(err as Error).message}\n`)
        }
        if (postNotice) posted++
        dropped++
      }
      if (dropped > 0) {
        const suppressed = dropped - posted
        log(
          `inbound-spool: escalated+dropped ${dropped} undelivered entr${dropped === 1 ? 'y' : 'ies'} ` +
          `(older than ${escalateAfterMs}ms; ${posted} notice${posted === 1 ? '' : 's'} posted` +
          `${suppressed > 0 ? `, ${suppressed} coalesced` : ''})\n`,
        )
        maybeCompact()
      }
      return dropped
    },
    liveCount() {
      return live.size
    },
    isDegraded() {
      return degraded
    },
    appendFailureCount() {
      return consecutiveAppendFailures
    },
  }
}
