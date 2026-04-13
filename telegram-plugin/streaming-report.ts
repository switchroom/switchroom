#!/usr/bin/env node
/**
 * Standalone analyzer for streaming-metrics JSONL.
 *
 * Reads JSONL from stdin or a file argument. Each line is one of:
 *   [streaming-metrics] {"ts":..,"kind":"...",...}
 *
 * The bracketed prefix is optional — we strip it if present so this works
 * on raw captures and on grep'd service.log lines alike.
 *
 * Emits a summary covering the 5 hypotheses from the streaming-deterministic
 * design doc:
 *   H1: `reply_called` >> `stream_reply_called` per turn
 *   H3: `pty_partial_received` with bufferedWithoutChatId
 *   H4: `pty_partial_received` suppressed after first reply in a turn
 *   Throughput: draft_edit histogram per turn
 *   Latency: first PTY partial → turn_end duration
 */

import { readFileSync } from 'fs'

type StreamingEvent = {
  ts: number
  kind: string
  chatId?: string | null
  [k: string]: unknown
}

interface Turn {
  chatId: string | null
  firstPtyTs: number | null
  turnEndTs: number | null
  durationMs: number | null
  replyCalled: number
  streamReplyCalled: number
  draftSends: number
  draftEdits: number
  ptyPartials: number
  ptyBufferedNoChatId: number
  ptySuppressedAfterReply: number
}

function parseLines(raw: string): StreamingEvent[] {
  const out: StreamingEvent[] = []
  for (const line of raw.split('\n')) {
    const m = line.match(/\{.*\}$/)
    if (!m) continue
    try {
      const ev = JSON.parse(m[0]) as StreamingEvent
      if (typeof ev.kind === 'string' && typeof ev.ts === 'number') out.push(ev)
    } catch {
      // Skip malformed lines silently — real logs have noise.
    }
  }
  return out
}

/**
 * Partition events into turns. A turn starts at the first event whose
 * chatId is non-null AND differs from the current turn's chatId, and ends
 * on the next `turn_end` (or end-of-stream).
 *
 * This is a coarse heuristic — the true turn boundary is the session JSONL
 * `enqueue` event, which we don't emit. In practice `reply_called` /
 * `stream_reply_called` / `pty_partial_received` (with a chatId) cluster
 * tightly per turn, so grouping on chatId changes + turn_end is accurate
 * enough for H-evidence counting.
 */
function partitionTurns(events: StreamingEvent[]): Turn[] {
  const turns: Turn[] = []
  let cur: Turn | null = null

  function open(chatId: string | null): Turn {
    const t: Turn = {
      chatId,
      firstPtyTs: null,
      turnEndTs: null,
      durationMs: null,
      replyCalled: 0,
      streamReplyCalled: 0,
      draftSends: 0,
      draftEdits: 0,
      ptyPartials: 0,
      ptyBufferedNoChatId: 0,
      ptySuppressedAfterReply: 0,
    }
    turns.push(t)
    return t
  }

  let turnSawReply = false
  for (const ev of events) {
    const chatId = (ev.chatId as string | null | undefined) ?? null
    if (cur == null) cur = open(chatId)

    switch (ev.kind) {
      case 'pty_partial_received': {
        cur.ptyPartials++
        if (ev.bufferedWithoutChatId === true) cur.ptyBufferedNoChatId++
        if (cur.firstPtyTs == null) cur.firstPtyTs = ev.ts
        if (ev.suppressed === true && turnSawReply) cur.ptySuppressedAfterReply++
        break
      }
      case 'reply_called':
        cur.replyCalled++
        turnSawReply = true
        break
      case 'stream_reply_called':
        cur.streamReplyCalled++
        break
      case 'draft_send':
        cur.draftSends++
        break
      case 'draft_edit':
        cur.draftEdits++
        break
      case 'turn_end':
        cur.turnEndTs = ev.ts
        cur.durationMs = typeof ev.durationMs === 'number' ? ev.durationMs : null
        cur = null
        turnSawReply = false
        break
    }
  }
  return turns
}

function histogram(values: number[]): string {
  if (values.length === 0) return '(none)'
  const buckets = new Map<number, number>()
  for (const v of values) buckets.set(v, (buckets.get(v) ?? 0) + 1)
  const keys = [...buckets.keys()].sort((a, b) => a - b)
  return keys.map(k => `${k}: ${'#'.repeat(buckets.get(k)!)} (${buckets.get(k)})`).join('\n  ')
}

function summarize(turns: Turn[]): string {
  const lines: string[] = []
  lines.push(`turns analyzed: ${turns.length}`)
  lines.push('')

  const replies = turns.reduce((a, t) => a + t.replyCalled, 0)
  const streams = turns.reduce((a, t) => a + t.streamReplyCalled, 0)
  lines.push(`H1 — tool-use ratio:`)
  lines.push(`  reply_called total:        ${replies}`)
  lines.push(`  stream_reply_called total: ${streams}`)
  lines.push(`  stream_reply share:        ${replies + streams > 0 ? ((streams / (replies + streams)) * 100).toFixed(1) + '%' : 'n/a'}`)
  lines.push('')

  const buffered = turns.reduce((a, t) => a + t.ptyBufferedNoChatId, 0)
  lines.push(`H3 — pty_partial with bufferedWithoutChatId: ${buffered}`)
  lines.push('')

  const suppressedPostReply = turns.reduce((a, t) => a + t.ptySuppressedAfterReply, 0)
  lines.push(`H4 — pty_partial suppressed after first reply in turn: ${suppressedPostReply}`)
  lines.push('')

  lines.push(`draft_edit count per turn histogram:`)
  lines.push(`  ${histogram(turns.map(t => t.draftEdits))}`)
  lines.push('')

  const latencies = turns
    .filter(t => t.firstPtyTs != null && t.turnEndTs != null)
    .map(t => (t.turnEndTs as number) - (t.firstPtyTs as number))
  if (latencies.length > 0) {
    const mean = latencies.reduce((a, b) => a + b, 0) / latencies.length
    const sorted = [...latencies].sort((a, b) => a - b)
    const p50 = sorted[Math.floor(sorted.length / 2)]
    const p95 = sorted[Math.floor(sorted.length * 0.95)]
    lines.push(`first pty_partial → turn_end (ms):`)
    lines.push(`  n=${latencies.length}  mean=${mean.toFixed(0)}  p50=${p50.toFixed(0)}  p95=${p95.toFixed(0)}`)
  } else {
    lines.push(`first pty_partial → turn_end: no complete turns`)
  }

  return lines.join('\n')
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

async function main(): Promise<void> {
  const arg = process.argv[2]
  const raw = arg ? readFileSync(arg, 'utf8') : await readStdin()
  const events = parseLines(raw)
  const turns = partitionTurns(events)
  process.stdout.write(summarize(turns) + '\n')
}

// Only run when invoked directly, not when imported by tests.
const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] != null &&
  (process.argv[1].endsWith('streaming-report.ts') || process.argv[1].endsWith('streaming-report.js'))
if (isMain) {
  void main().catch(e => {
    process.stderr.write(`streaming-report failed: ${(e as Error).message}\n`)
    process.exit(1)
  })
}

export { parseLines, partitionTurns, summarize }
