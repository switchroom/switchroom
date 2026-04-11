/**
 * Real-time PTY tail with character-level model output extraction.
 *
 * The deep-research finding: Claude Code's --channels mode does NOT
 * support --output-format stream-json, and the session JSONL writes
 * whole assistant messages atomically (no per-token deltas). The only
 * way to get character-level streaming text out of a long-running
 * Claude Code daemon is to capture its PTY output (which we already
 * do via `script -qfc ... service.log`) and parse the rendered TUI.
 *
 * Critical observation from the live server's service.log: when the
 * model is generating a reply via the clerk-telegram MCP tool, Claude
 * Code's Ink TUI renders the in-progress tool call as:
 *
 *   ● clerk-telegram - reply (MCP)(chat_id: "...", text: "Yes — I can
 *                                 attach files to replies. Images send
 *                                 as inline photos...")
 *
 * The text parameter expands character-by-character as the model
 * streams. By tailing service.log, feeding the bytes into a headless
 * xterm.js, and scanning the resulting buffer for `● clerk-telegram -
 * reply` blocks, we can extract the streaming reply text in real time.
 *
 * Architecture:
 *
 *   ┌─────────────────┐    bytes    ┌─────────────────┐
 *   │  service.log    ├────────────▶│ @xterm/headless │
 *   │  (script -qfc)  │             │   Terminal      │
 *   └─────────────────┘             └────────┬────────┘
 *                                            │ rendered buffer
 *                                            ▼
 *                                   ┌─────────────────┐
 *                                   │ MessageRegion   │
 *                                   │ Extractor       │
 *                                   └────────┬────────┘
 *                                            │ partial text
 *                                            ▼
 *                                   ┌─────────────────┐
 *                                   │ throttled       │
 *                                   │ onPartial(text) │
 *                                   └─────────────────┘
 *
 * The extractor is isolated behind a versioned interface so that when
 * Claude Code's TUI layout changes (Ink upgrades, marker tweaks, etc.),
 * we can swap implementations without touching the tail loop. The
 * extractor returns null when it can't confidently identify the message
 * region; the consumer should treat null as "no streaming this turn,
 * fall back to JSONL-only progress signals".
 */

import { existsSync, readFileSync, statSync, watch, openSync, readSync, closeSync, type FSWatcher } from 'fs'
import { Terminal } from '@xterm/headless'

/**
 * How many trailing bytes of the log to replay into xterm.js at attach
 * time. Must be large enough to contain at least one full-screen Ink
 * redraw — Ink's renderer is differential and emits cursor-forward
 * escapes for unchanged cells, so without a baseline the terminal
 * ends up with blank cells where the "● clerk-telegram - stream_reply"
 * marker characters should be, and the v1 extractor's substring match
 * silently misses every partial. 1 MB is empirically ~15–30 s of
 * steady output, comfortably covering a full-frame redraw.
 */
const PRELOAD_BYTES = 1_000_000

// ─── MessageRegionExtractor interface ─────────────────────────────────────
//
// Versioned. When Claude Code's TUI changes break the v1 extractor, ship
// a v2 alongside and switch the default. The interface is intentionally
// minimal so each implementation can use its own internal heuristics.

export interface MessageRegionExtractor {
  /** Identifier for logging / version pinning. */
  readonly version: string
  /**
   * Inspect the terminal buffer and return the current in-flight reply
   * text the model is generating, or null if no reply is currently
   * being composed.
   *
   * Implementations should be cheap (called after every byte batch) and
   * deterministic (same buffer state → same return value).
   */
  extract(terminal: Terminal): string | null
}

/**
 * v1 extractor for Claude Code 2.1.x.
 *
 * Heuristic: scan the buffer from the bottom for the most recent line
 * that starts with `● clerk-telegram - reply (MCP)` or
 * `● clerk-telegram - stream_reply (MCP)`. Once found, locate the
 * `text: "` literal and extract everything between the opening quote and
 * the next unescaped closing `"`, handling line wraps where Ink
 * indents the continuation.
 *
 * Falls back to scanning for any `● clerk-telegram - reply` substring
 * even if it's not the very first character of the line — Ink sometimes
 * indents tool calls under thinking blocks.
 */
export class V1Extractor implements MessageRegionExtractor {
  readonly version = 'v1-claude-code-2.1.x'

  extract(terminal: Terminal): string | null {
    const buf = terminal.buffer.active
    // Walk from the bottom looking for the start of a reply block. We
    // care about the MOST RECENT one because earlier turns are stale.
    let startLine = -1
    for (let i = buf.length - 1; i >= 0; i--) {
      const text = buf.getLine(i)?.translateToString(true) ?? ''
      if (
        text.includes('clerk-telegram - reply') ||
        text.includes('clerk-telegram - stream_reply')
      ) {
        startLine = i
        break
      }
    }
    if (startLine < 0) return null

    // Concatenate the start line + continuation lines into one logical
    // string. Continuation lines from Ink for tool params are indented
    // by ~30 spaces; the exact count varies with terminal width. Use a
    // heuristic: a line is a continuation iff its first non-space char
    // appears later than column 5 AND it doesn't start with the bullet
    // `●` (which would mean a new entry).
    const lines: string[] = []
    for (let i = startLine; i < buf.length; i++) {
      const text = buf.getLine(i)?.translateToString(true) ?? ''
      if (i === startLine) {
        lines.push(text)
        continue
      }
      // Continuation: heavy indentation, no leading bullet
      const trimmed = text.replace(/^\s+/, '')
      if (trimmed === '') {
        // Empty line — probably end of the tool block
        break
      }
      // A bullet (●) or tool-result marker (⎿) anywhere in the leading
      // whitespace means a new section. Note Ink often indents bullets
      // by ~2 cols, so checking startsWith('●') would miss them — use
      // a regex that allows leading whitespace.
      if (/^\s*●/.test(text) || /^\s*⎿/.test(text)) {
        break
      }
      const leadingSpaces = text.length - trimmed.length
      if (leadingSpaces < 4) {
        // Not a continuation
        break
      }
      lines.push(text)
    }

    // Now find `text: "` in the concatenated content
    const joined = lines.join('\n')
    const textIdx = joined.indexOf('text: "')
    if (textIdx < 0) return null
    const afterOpen = textIdx + 'text: "'.length

    // Extract until closing `"` — but the rendered TUI doesn't escape
    // backslashes, so we just grab until we see a `")` (close paren-
    // close-quote sequence) or run out of buffer. The tool call always
    // ends with `")` because reply takes named params and text is one of them.
    let extracted: string
    const closeIdx = joined.indexOf('")', afterOpen)
    if (closeIdx >= 0) {
      extracted = joined.substring(afterOpen, closeIdx)
    } else {
      // Open-ended — model is still generating. Take everything to end.
      extracted = joined.substring(afterOpen)
    }

    // Strip Ink's continuation-line indentation. Each non-first line
    // has ~30 spaces of leading whitespace; collapse to a single space
    // (Ink visually flows the text, so newlines are not semantic).
    const cleaned = extracted
      .split('\n')
      .map((l, idx) => (idx === 0 ? l : l.replace(/^\s+/, '')))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()

    if (cleaned === '') return null
    return cleaned
  }
}

// ─── PTY tail ────────────────────────────────────────────────────────────

export interface PtyTailConfig {
  /** Absolute path to the file we tail. Usually `<agentDir>/service.log`. */
  logFile: string
  /** Throttle for partial text emission. Default 750 ms. */
  throttleMs?: number
  /** Terminal cols/rows the script wrapper uses. Default 132x40. */
  cols?: number
  rows?: number
  /** Pluggable extractor. Default V1Extractor. */
  extractor?: MessageRegionExtractor
  /** Optional logger. */
  log?: (msg: string) => void
  /** Called when extracted text changes. Receives the FULL current text. */
  onPartial: (text: string) => void
  /** Called when the model finishes a turn (extracted text reaches a stable terminal). */
  onFinal?: (text: string) => void
}

export interface PtyTailHandle {
  stop(): void
  /** Get the current cumulative extracted text, or null. */
  getCurrentText(): string | null
}

/**
 * Start tailing a PTY-captured log file. Re-feeds the terminal emulator
 * with new bytes as they arrive, runs the extractor on every batch, and
 * fires onPartial whenever the result changes.
 *
 * Robustness: if the log file doesn't exist yet, polls for it. If the
 * file is truncated/replaced (logrotate), resets the cursor. The
 * terminal emulator state persists across rotations — that's
 * intentional for now, since the typical case is no rotation. A
 * smarter version could reset the terminal on truncation but it adds
 * complexity for an edge case.
 */
export function startPtyTail(config: PtyTailConfig): PtyTailHandle {
  const throttleMs = config.throttleMs ?? 150
  const extractor = config.extractor ?? new V1Extractor()
  const log = config.log
  const cols = config.cols ?? 132
  const rows = config.rows ?? 40

  const term = new Terminal({
    cols,
    rows,
    scrollback: 5000,
    allowProposedApi: true,
  })

  let cursor = 0
  let lastEmittedText: string | null = null
  let lastEmitAt = 0
  let pendingEmit: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  let watcher: FSWatcher | null = null
  let pollTimer: ReturnType<typeof setInterval> | null = null

  function emitIfChanged(): void {
    if (stopped) return
    const text = extractor.extract(term)
    if (text === lastEmittedText) return
    if (text == null) {
      // Extractor lost the region — could mean turn ended. If we had a
      // last emitted text, keep it; the JSONL backstop will finalize.
      return
    }
    lastEmittedText = text
    lastEmitAt = Date.now()
    try {
      config.onPartial(text)
    } catch (err) {
      log?.(`pty-tail: onPartial threw: ${(err as Error).message}`)
    }
  }

  function scheduleEmit(): void {
    if (pendingEmit != null) return
    // Fire immediately if the throttle window is open (this is critical
    // for first-paint latency — without this, the very first emit waits
    // a full throttleMs even though there's nothing to throttle against).
    const sinceLastEmit = Date.now() - lastEmitAt
    if (sinceLastEmit >= throttleMs) {
      emitIfChanged()
      return
    }
    pendingEmit = setTimeout(() => {
      pendingEmit = null
      emitIfChanged()
    }, Math.max(0, throttleMs - sinceLastEmit))
  }

  function readNew(): void {
    if (stopped) return
    if (!existsSync(config.logFile)) return
    let stat
    try {
      stat = statSync(config.logFile)
    } catch {
      return
    }
    if (stat.size < cursor) {
      // Truncated/rotated — reset cursor
      cursor = 0
      log?.(`pty-tail: log file shrank from ${cursor} to ${stat.size} bytes — resetting cursor`)
    }
    if (stat.size === cursor) return

    const toRead = stat.size - cursor
    const buf = Buffer.alloc(toRead)
    let fd: number
    try {
      fd = openSync(config.logFile, 'r')
    } catch {
      return
    }
    try {
      readSync(fd, buf, 0, toRead, cursor)
    } finally {
      closeSync(fd)
    }
    cursor = stat.size

    // Feed into xterm. The Terminal.write() call queues bytes through
    // the parser; subsequent buffer.active reads see the new state.
    // Schedule the extraction on the throttle to coalesce rapid bursts.
    term.write(buf, () => {
      scheduleEmit()
    })
  }

  function attachWatcher(): void {
    if (!existsSync(config.logFile)) return
    if (watcher) return
    let size = 0
    try {
      size = statSync(config.logFile).size
    } catch {
      // File vanished between existsSync and statSync — bail out, pollTimer
      // will retry on the next tick.
      return
    }

    // Preload the tail end of the log into the terminal emulator BEFORE we
    // start tailing fresh bytes. Critical for Ink: its renderer uses
    // *differential* updates (cursor-forward escapes for unchanged cells),
    // so a fresh terminal starting at EOF sees `\e[1C` skipping over cells
    // that Ink assumes already contain characters from a prior full frame.
    // Without a baseline, marker strings like "clerk-telegram" render
    // with gaps (e.g. "clerk te egram") and the extractor's substring
    // check fails → no partials ever emit.
    //
    // 1 MB is deliberately generous: even a few seconds of steady Ink
    // output is enough to capture a full-frame redraw that initializes
    // every cell. We suppress the first onPartial by seeding
    // `lastEmittedText` from the post-preload extract result, so the
    // very next real extract (from a new tool call) is what actually
    // fires onPartial.
    const preloadBytes = Math.min(size, PRELOAD_BYTES)
    const preloadFrom = size - preloadBytes
    if (preloadBytes > 0) {
      try {
        const fd = openSync(config.logFile, 'r')
        try {
          const buf = Buffer.alloc(preloadBytes)
          readSync(fd, buf, 0, preloadBytes, preloadFrom)
          term.write(buf, () => {
            // Seed lastEmittedText with whatever the extractor sees after
            // the baseline is loaded. Any NEW render (newer than this
            // baseline) will produce a different extract result and fire
            // onPartial naturally.
            const seeded = extractor.extract(term)
            if (seeded != null) {
              lastEmittedText = seeded
              log?.(`pty-tail: preload seeded lastEmittedText (${seeded.length} chars)`)
            }
          })
        } finally {
          closeSync(fd)
        }
      } catch (err) {
        log?.(`pty-tail: preload failed: ${(err as Error).message}`)
      }
    }

    cursor = size
    log?.(`pty-tail: attached to ${config.logFile} (cursor=${cursor}, preloaded=${preloadBytes})`)
    try {
      watcher = watch(config.logFile, () => readNew())
    } catch (err) {
      log?.(`pty-tail: fs.watch failed (${(err as Error).message}), polling only`)
    }
  }

  // Initial scan + retry loop in case the log file doesn't exist yet.
  // Poll interval is 200ms — short enough that fs.watch misses don't
  // add visible latency, infrequent enough that idle CPU stays minimal.
  attachWatcher()
  pollTimer = setInterval(() => {
    if (!watcher) attachWatcher()
    readNew()
  }, 200)

  return {
    stop(): void {
      stopped = true
      if (watcher) {
        try { watcher.close() } catch { /* ignore */ }
        watcher = null
      }
      if (pollTimer) {
        clearInterval(pollTimer)
        pollTimer = null
      }
      if (pendingEmit) {
        clearTimeout(pendingEmit)
        pendingEmit = null
      }
      try { term.dispose() } catch { /* ignore */ }
    },
    getCurrentText(): string | null {
      return lastEmittedText
    },
  }
}
