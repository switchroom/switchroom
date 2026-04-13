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
 * that contains `● clerk-telegram - reply (MCP)` or
 * `● clerk-telegram - stream_reply (MCP)`. Once found, locate the
 * `text: "` literal and extract the value using an escape-aware
 * character walk that terminates at the first UNESCAPED closing `"`.
 *
 * This matters because the model frequently passes `text` as a
 * non-final parameter (e.g. `chat_id: "123", text: "hello", reply_to: "456"`).
 * Earlier versions of this extractor looked for the `")` close-paren
 * sequence, which terminated at the END of the whole tool call rather
 * than the end of the text string — causing everything after the real
 * `text` value (e.g. `, reply_to: "456"`) to leak into the "extracted"
 * preview and ultimately surface as a garbled duplicate Telegram message.
 *
 * The walk also handles Claude Code's JSON escapes (`\"`, `\n`, `\t`,
 * `\\`) so a text value that contains literal quotes renders correctly
 * in the preview instead of truncating at the first inner quote.
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

    // Escape-aware string walk. Starting right after the opening quote
    // of the text parameter, consume characters one at a time. A `\`
    // byte escapes the next char (`\"` → `"`, `\n` → newline, `\\` →
    // backslash, and any unknown sequence is preserved verbatim). An
    // UNESCAPED `"` terminates the string — this is the real end of
    // the text parameter value, regardless of whether it's followed by
    // `)` (text was last) or `,` (text was followed by another param).
    // If we exhaust the buffer without finding the terminator, the
    // model is mid-stream and we return everything captured so far.
    let extracted = ''
    let pos = afterOpen
    while (pos < joined.length) {
      const ch = joined[pos]
      if (ch === '\\' && pos + 1 < joined.length) {
        const next = joined[pos + 1]
        if (next === '"') extracted += '"'
        else if (next === 'n') extracted += '\n'
        else if (next === 't') extracted += '\t'
        else if (next === 'r') extracted += '\r'
        else if (next === '\\') extracted += '\\'
        else extracted += '\\' + next
        pos += 2
        continue
      }
      if (ch === '"') {
        // Unescaped closing quote — end of the text parameter value.
        break
      }
      extracted += ch
      pos++
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

// ─── ToolActivityExtractor ────────────────────────────────────────────────
//
// Design note (2026-04-13): during tool-heavy turns that end with a single
// `reply` call, the V1Extractor above emits nothing until the very end —
// the user sees a gap, which reads as "the bot is hung". We fix that by
// ALSO surfacing tool-call activity ("Bash: git status", "Read: foo.ts",
// "Grep: pattern") as short one-liners, so the plugin can push a live
// status via stream_reply on a separate lane.
//
// Chosen lane approach (docs were ambiguous — picking what's cleaner given
// the stream-reply-handler `lane` parameter that landed 2026-04-13): emit
// activity lines OUT-OF-BAND via a second callback (`onActivity`), separate
// from the reply-text `onPartial`. The consumer (server.ts) routes these
// to a dedicated `"activity"` lane via stream_reply(lane: "activity"). This
// keeps the existing reply/stream_reply path untouched (all current tests
// still pass unmodified), and avoids mixing status noise into the answer
// text buffer.

export interface ToolActivityExtractor {
  readonly version: string
  /**
   * Return a SHORT (<100 char) human-readable status string for the most
   * recent tool-call bullet in the buffer, or null if none / the same as
   * the last extraction (dedup is the consumer's job — extractor just
   * surfaces the current top-of-stack activity).
   */
  extract(terminal: Terminal): string | null
}

/**
 * v1 activity extractor. Scans the buffer bottom-up for Claude Code's Ink
 * tool-call bullet pattern:
 *
 *     ● Bash(git status)
 *     ● Read(/path/to/file.ts)
 *     ● Grep(pattern, path: "...")
 *     ● Glob(**\/*.ts)
 *     ● clerk-telegram - reply (MCP)(...)
 *
 * For the core tools we render a short verbed one-liner ("Running Bash:
 * git status", "Reading file.ts", "Searching with Grep: pattern"). For
 * clerk-telegram tool calls we return null — those are already surfaced
 * by V1Extractor on the main lane, and echoing them on the activity lane
 * would be confusing.
 */
export class V1ToolActivityExtractor implements ToolActivityExtractor {
  readonly version = 'v1-tool-activity'

  extract(terminal: Terminal): string | null {
    const buf = terminal.buffer.active
    for (let i = buf.length - 1; i >= 0; i--) {
      const raw = buf.getLine(i)?.translateToString(true) ?? ''
      // Find a bullet anywhere on the line (Ink may indent).
      const bulletIdx = raw.indexOf('●')
      if (bulletIdx < 0) continue
      const after = raw.slice(bulletIdx + 1).trimStart()
      if (after === '') continue

      // Skip clerk-telegram tool calls — V1Extractor owns those.
      if (after.startsWith('clerk-telegram')) return null

      // Match `ToolName(` or `ToolName -` patterns. Accept the conventional
      // Claude Code tool names; anything else is "Running <Tool>".
      const m = after.match(/^([A-Za-z_][A-Za-z0-9_-]*)[\s(]/)
      if (!m) continue
      const tool = m[1]

      // Grab the inside of the first (...) group if present, keeping only
      // up to the first comma for a short preview.
      const parenOpen = after.indexOf('(')
      let inner = ''
      if (parenOpen >= 0) {
        // Simple depth-aware walk: stop at the matching close paren. Good
        // enough for a short status preview.
        let depth = 0
        let end = -1
        for (let j = parenOpen; j < after.length; j++) {
          const ch = after[j]
          if (ch === '(') depth++
          else if (ch === ')') {
            depth--
            if (depth === 0) { end = j; break }
          }
        }
        inner = end > parenOpen ? after.slice(parenOpen + 1, end) : after.slice(parenOpen + 1)
        // Trim to first meaningful arg (up to first ", " at depth 0).
        const commaIdx = inner.indexOf(', ')
        if (commaIdx > 0) inner = inner.slice(0, commaIdx)
        inner = inner.trim()
        // Strip surrounding quotes from a single-arg string.
        if (inner.startsWith('"') && inner.endsWith('"') && inner.length >= 2) {
          inner = inner.slice(1, -1)
        }
      }

      // Truncate overlong inner strings.
      const MAX = 80
      if (inner.length > MAX) inner = inner.slice(0, MAX - 1) + '…'

      // Verbed phrasing per tool.
      const verb = activityVerb(tool)
      const phrase = inner.length > 0 ? `${verb}: ${inner}` : verb
      // Final guardrail: one line, no control chars.
      return phrase.replace(/\s+/g, ' ').trim().slice(0, 120)
    }
    return null
  }
}

/**
 * Activity-line prefixes produced by the noisy core tools (Bash, Read,
 * Write, Edit, Grep, Glob). The PTY tail extracts an activity line per
 * tool call, but surfacing each one to the user is noise — the user
 * wants human-meaningful rollups ("Running sub-agent...",
 * "Fetching URL...") not per-tool narration of "Running Bash: cd ...".
 *
 * Used by `shouldSuppressToolActivity` to filter at the consumer layer.
 * The extractor itself still returns these lines unchanged, so anything
 * that wants the raw stream (tests, telemetry) keeps working.
 */
export const NOISY_TOOL_ACTIVITY_PREFIXES: readonly string[] = [
  'Running Bash',
  'Reading file',
  'Writing file',
  'Editing file',
  'Searching with Grep',
  'Searching with Glob',
]

/**
 * True if an activity line is per-tool narration for a noisy core tool
 * (Bash/Read/Write/Edit/Grep/Glob) that should NOT be surfaced to the
 * Telegram activity lane. Human-meaningful rollups ("Running sub-agent",
 * "Fetching URL", "Searching the web", and anything unknown mapped to
 * "Running <CustomTool>") pass through.
 */
export function shouldSuppressToolActivity(line: string): boolean {
  for (const prefix of NOISY_TOOL_ACTIVITY_PREFIXES) {
    if (line === prefix) return true
    if (line.startsWith(prefix + ':')) return true
  }
  return false
}

function activityVerb(tool: string): string {
  switch (tool) {
    case 'Bash': return 'Running Bash'
    case 'Read': return 'Reading file'
    case 'Write': return 'Writing file'
    case 'Edit': return 'Editing file'
    case 'Grep': return 'Searching with Grep'
    case 'Glob': return 'Searching with Glob'
    case 'WebFetch': return 'Fetching URL'
    case 'WebSearch': return 'Searching the web'
    case 'Task': return 'Running sub-agent'
    default: return `Running ${tool}`
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
  /**
   * Optional second extractor that surfaces tool-call activity ("Running
   * Bash: ls", "Reading file: foo.ts"). When provided, the tail runs both
   * extractors on every byte batch and fires `onActivity` (deduped + same
   * throttle) when the activity line changes. Independent of onPartial —
   * the consumer chooses how to route it (typically a separate lane).
   */
  activityExtractor?: ToolActivityExtractor
  /** Called when the activity extractor's output changes (deduped + throttled). */
  onActivity?: (text: string) => void
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
  const activityExtractor = config.activityExtractor ?? null
  const onActivity = config.onActivity ?? null
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
  let lastEmittedActivity: string | null = null
  let lastEmitAt = 0
  let lastActivityEmitAt = 0
  let pendingEmit: ReturnType<typeof setTimeout> | null = null
  let pendingActivity: ReturnType<typeof setTimeout> | null = null
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

  function emitActivityIfChanged(): void {
    if (stopped) return
    if (activityExtractor == null || onActivity == null) return
    const text = activityExtractor.extract(term)
    if (text == null) return
    // Dedup: identical to last emission → skip.
    if (text === lastEmittedActivity) return
    lastEmittedActivity = text
    lastActivityEmitAt = Date.now()
    try {
      onActivity(text)
    } catch (err) {
      log?.(`pty-tail: onActivity threw: ${(err as Error).message}`)
    }
  }

  function scheduleActivityEmit(): void {
    if (activityExtractor == null || onActivity == null) return
    if (pendingActivity != null) return
    const sinceLast = Date.now() - lastActivityEmitAt
    if (sinceLast >= throttleMs) {
      emitActivityIfChanged()
      return
    }
    pendingActivity = setTimeout(() => {
      pendingActivity = null
      emitActivityIfChanged()
    }, Math.max(0, throttleMs - sinceLast))
  }

  function scheduleEmit(): void {
    // Always try to surface tool activity alongside reply text. Independent
    // throttle/dedup — activity changes on every new tool-call bullet, while
    // reply text grows character-by-character.
    scheduleActivityEmit()
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
      if (pendingActivity) {
        clearTimeout(pendingActivity)
        pendingActivity = null
      }
      try { term.dispose() } catch { /* ignore */ }
    },
    getCurrentText(): string | null {
      return lastEmittedText
    },
  }
}
