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
      msg.meta?.source === 'resume_watchdog_timeout') &&
    typeof msg.meta?.resume_turn_key === 'string' &&
    msg.meta.resume_turn_key.length > 0
  ) {
    return `s:resume:${msg.meta.resume_turn_key}`
  }
  if (typeof msg.messageId === 'number' && msg.messageId > 0) {
    return `m:${msg.chatId}:${msg.messageId}`
  }
  const src = msg.meta?.source ?? '-'
  return `s:${msg.chatId}:${src}:${msg.ts}`
}

interface SpoolRecord {
  t: 'put' | 'ack'
  id: string
  /** Present only on `put`. The full inbound to replay. */
  msg?: InboundMessage
  /** Present only on `put`. Owning agent (replay re-pushes per agent). */
  agent?: string
  /** Present only on `put`. ms epoch first-spooled — drives escalation. */
  firstAt?: number
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
  /** Escalate+drop entries older than `escalateAfterMs`. Calls
   *  `onEscalate` once per dropped entry (post the "couldn't deliver"
   *  card there). Returns the count escalated. Safe to call on a timer. */
  sweepEscalations: (onEscalate: (e: ReplayEntry) => void) => number
  /** Test/observability: count of live (un-acked) ids. */
  liveCount: () => number
}

export function createInboundSpool(opts: InboundSpoolOptions): InboundSpool {
  const { path, fs } = opts
  const now = opts.now ?? Date.now
  const log = opts.log ?? ((l: string) => process.stderr.write(l))
  const escalateAfterMs = opts.escalateAfterMs ?? 15 * 60 * 1000
  const compactAtBytes = opts.compactAtBytes ?? 256 * 1024

  // In-memory projection of the on-disk log, rebuilt from the file at
  // construction. `live` maps spoolId → the put record (insertion order
  // preserved via the Map). An `ack` deletes from `live`.
  const live = new Map<string, { agent: string; msg: InboundMessage; firstAt: number }>()

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
    if (r.t !== 'put' && r.t !== 'ack') return null
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
        live.set(rec.id, {
          agent: rec.agent as string,
          msg: rec.msg as InboundMessage,
          firstAt: rec.firstAt as number,
        })
      } else {
        live.delete(rec.id)
      }
    }
  }

  function appendRecord(rec: SpoolRecord): void {
    try {
      fs.appendFileSync(path, JSON.stringify(rec) + '\n')
    } catch (err) {
      // Durability is best-effort relative to fs availability; a spool
      // write failure must NOT break live delivery. Log loudly — a
      // persistently failing spool means we're back to in-memory-only
      // semantics and the operator should know.
      log(
        `inbound-spool: append FAILED path=${path} id=${rec.id} t=${rec.t}: ` +
        `${(err as Error).message} — durability degraded to in-memory\n`,
      )
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
    const tmp = path + '.compact.tmp'
    try {
      fs.writeFileSync(tmp, lines.length ? lines.join('\n') + '\n' : '')
      fs.renameSync(tmp, path)
      log(`inbound-spool: compacted path=${path} live=${live.size}\n`)
    } catch (err) {
      // Compaction is opportunistic — a failure keeps the (larger but
      // correct) append-only log; never lose data trying to shrink it.
      log(`inbound-spool: compact FAILED path=${path}: ${(err as Error).message}\n`)
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
      const cutoff = now() - escalateAfterMs
      let n = 0
      for (const [id, e] of [...live.entries()]) {
        if (e.firstAt > cutoff) continue
        live.delete(id)
        appendRecord({ t: 'ack', id }) // tombstone — promise retracted
        try {
          onEscalate({ agent: e.agent, msg: e.msg })
        } catch (err) {
          log(`inbound-spool: onEscalate threw id=${id}: ${(err as Error).message}\n`)
        }
        n++
      }
      if (n > 0) {
        log(`inbound-spool: escalated+dropped ${n} undelivered entr${n === 1 ? 'y' : 'ies'} (older than ${escalateAfterMs}ms)\n`)
        maybeCompact()
      }
      return n
    },
    liveCount() {
      return live.size
    },
  }
}
