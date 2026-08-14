/**
 * Raw pre-normalisation speech-text capture (TTS normalisation redesign,
 * PR-0 — `/tmp/claude-0/tts/out/fable-plan-v2.md` §9).
 *
 * Flag-gated on `SWITCHROOM_SPEECH_CAPTURE=1` (or `=true`), OFF by default:
 * unset (or any other value) is a true no-op — `captureSpeechText` returns
 * immediately without touching the filesystem, so the send path pays zero
 * cost. When enabled, appends exactly one JSON line `{ts, text}` — where
 * `text` is the EXACT string about to be passed to `resolveVoiceOutPlan`,
 * byte-for-byte, no re-encoding — to `$TELEGRAM_STATE_DIR/speech-capture.jsonl`
 * before that call (fable-plan-v2.md §0 C-4: that string IS Stage A's future
 * input). NOT the same string the visible rich render displays — the render
 * path additionally runs `computeEffectiveText`/`addParagraphSpacers` (U+00A0
 * paragraph spacers) downstream of this capture point; this captures the
 * plain pre-spacer prose Stage A will actually consume.
 *
 * Why this exists: `corpus.json` (the existing replay corpus) was captured
 * downstream of the legacy pass-1 normaliser, so it carries zero tables,
 * fences, pipes, or emoji (fable-plan-v2.md §0 C-3) — useless for validating
 * the new Stage-A renderer beyond synthetic fixtures. `telegram/history.db`
 * is also unusable: it stores text as Telegram echoed it back (rendered),
 * not the pre-render markdown. Capture must happen in-process, here.
 *
 * Privacy: the capture file holds the full plaintext body of every outbound
 * reply while the flag is on, so it is created `0o600` (owner-only) — NOT
 * the default-umask `0o644` `appendFileSync` would otherwise produce, which
 * would leave it world-readable in a directory where `access.json` (the chat
 * allowlist) is deliberately `0o600`. Mode only applies at file CREATION
 * (Node ignores `mode` on an append to an existing file), matching the
 * established pattern in this codebase (`shown-ledger.ts`, `outbox.ts`).
 *
 * Write failures are swallowed — capture must never break a send — but never
 * silently: the first write failure (and, rate-limited, subsequent ones)
 * logs one stderr line, because a foreign-uid EACCES on this file (the #4371
 * failure class: some other process touches it, it becomes root-owned, the
 * agent uid EACCESes on every append thereafter) must be observable across a
 * 7-day unattended capture window, not discovered after the fact from an
 * empty corpus.
 *
 * Deliberately does NOT bound or rotate the capture file: the spec (§9 PR-0)
 * describes a plain unbounded append for a time-boxed 7-day fleet-wide
 * capture window (measured fleet-wide: ~2.9 MB over 7 days), after which the
 * file is reviewed, secrets-scrubbed, and checked into the repo as a static
 * fixture — it is not a long-lived production log.
 *
 * The enabled check reads `process.env` on every call (deliberately NOT
 * cached at module scope, unlike `current-turn-map.ts`'s
 * `EMISSION_AUTHORITY_ENABLED` kill-switch convention): the read is a single
 * property lookup, not the per-turn state-store cost that convention exists
 * to avoid, and caching it would make the flag un-togglable within a single
 * test process — which the load-bearing "a capture write failure never
 * breaks the reply" guarantee needs to exercise against the REAL `sendReply`
 * wiring (see `send-reply-golden.test.ts`), not a synthetic call.
 */

import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

export const SPEECH_CAPTURE_FILE_NAME = 'speech-capture.jsonl'

/** File created owner-read-write only (see the Privacy note above). */
const SPEECH_CAPTURE_FILE_MODE = 0o600

export interface CaptureSpeechTextOptions {
  /** Override the enabled flag (tests only); default reads
   *  `SWITCHROOM_SPEECH_CAPTURE` from the environment. */
  enabled?: boolean
  /** Override the destination directory (tests only); default
   *  `process.env.TELEGRAM_STATE_DIR`. */
  stateDir?: string
  /** Override the clock (tests only). */
  now?: () => number
}

function envFlagEnabled(): boolean {
  const v = process.env.SWITCHROOM_SPEECH_CAPTURE
  return v === '1' || v === 'true'
}

function isCaptureEnabled(override: boolean | undefined): boolean {
  if (override !== undefined) return override
  return envFlagEnabled()
}

// One-shot "capture is live" log line, latched the first time capture
// actually fires (not at module import — importing this module must stay a
// true no-op regardless of whether the flag ends up used) — and a
// rate-limited write-error log so a foreign-uid EACCES (#4371 class) is
// observable within the window, not just discoverable from an empty corpus
// after the fact.
let loggedEnabledOnce = false
// `null`, not `0`: a real failure at `Date.now() === 0` (or in a test driven
// by `vi.setSystemTime(0)`) must still log — `0` is a valid past timestamp,
// not "never logged", so it cannot double as the sentinel.
let lastWriteErrorLoggedAt: number | null = null
const WRITE_ERROR_LOG_INTERVAL_MS = 5 * 60_000

function logEnabledOnce(): void {
  if (loggedEnabledOnce) return
  loggedEnabledOnce = true
  try {
    process.stderr.write(
      `telegram gateway: speech-capture: enabled — writing $TELEGRAM_STATE_DIR/${SPEECH_CAPTURE_FILE_NAME}\n`,
    )
  } catch {
    // Logging must never break the send path.
  }
}

function logWriteErrorRateLimited(err: unknown, nowMs: number): void {
  if (lastWriteErrorLoggedAt !== null && nowMs - lastWriteErrorLoggedAt < WRITE_ERROR_LOG_INTERVAL_MS) return
  lastWriteErrorLoggedAt = nowMs
  try {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(
      `telegram gateway: speech-capture: write failed (further failures rate-limited ` +
        `${Math.round(WRITE_ERROR_LOG_INTERVAL_MS / 60_000)}m) err=${msg}\n`,
    )
  } catch {
    // Logging must never break the send path.
  }
}

/**
 * Append one `{ts, text}` JSON line to the raw-corpus capture file when
 * capture is enabled. `text` must be the EXACT string about to be passed to
 * `resolveVoiceOutPlan` — no trimming, no re-encoding, byte-for-byte
 * preservation of markdown (tables, fences, pipes, emoji, backticks, ...).
 * Off by default; a true no-op when the flag is unset. Never throws.
 */
export function captureSpeechText(text: string, opts: CaptureSpeechTextOptions = {}): void {
  if (!isCaptureEnabled(opts.enabled)) return
  logEnabledOnce()
  try {
    const stateDir = opts.stateDir ?? process.env.TELEGRAM_STATE_DIR
    if (stateDir == null || stateDir.length === 0) return
    const now = opts.now ?? Date.now
    const line = `${JSON.stringify({ ts: now(), text })}\n`
    appendFileSync(join(stateDir, SPEECH_CAPTURE_FILE_NAME), line, {
      encoding: 'utf8',
      mode: SPEECH_CAPTURE_FILE_MODE,
    })
  } catch (err) {
    // Capture must never break the send path — but never silently either
    // (M2/#4371 class).
    logWriteErrorRateLimited(err, Date.now())
  }
}

/**
 * Test-only: reset the one-shot enable log and the write-error rate limiter,
 * so a test asserting stderr output is independent of import/call order
 * versus every other test sharing this module instance.
 */
export function __resetSpeechCaptureLogStateForTests(): void {
  loggedEnabledOnce = false
  lastWriteErrorLoggedAt = null
}
