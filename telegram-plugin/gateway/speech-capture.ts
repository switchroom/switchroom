/**
 * Raw pre-normalisation speech-text capture (TTS normalisation redesign,
 * PR-0 — `/tmp/claude-0/tts/out/fable-plan-v2.md` §9).
 *
 * Flag-gated on `SWITCHROOM_SPEECH_CAPTURE=1`, OFF by default: unset (or any
 * value other than `"1"`) is a true no-op — `captureSpeechText` returns
 * immediately without touching the filesystem, so the send path pays zero
 * cost. When enabled, appends exactly one JSON line `{ts, text}` — where
 * `text` is the EXACT string about to be passed to `resolveVoiceOutPlan`,
 * byte-for-byte, no re-encoding — to `$TELEGRAM_STATE_DIR/speech-capture.jsonl`
 * before that call (fable-plan-v2.md §0 C-4: that string IS Stage A's future
 * input, the same string the visible rich render parses).
 *
 * Why this exists: `corpus.json` (the existing replay corpus) was captured
 * downstream of the legacy pass-1 normaliser, so it carries zero tables,
 * fences, pipes, or emoji (fable-plan-v2.md §0 C-3) — useless for validating
 * the new Stage-A renderer beyond synthetic fixtures. `telegram/history.db`
 * is also unusable: it stores text as Telegram echoed it back (rendered),
 * not the pre-render markdown. Capture must happen in-process, here.
 *
 * Write failures are swallowed unconditionally — capture must never break a
 * send. Deliberately does NOT bound or rotate the capture file: the spec
 * (§9 PR-0) describes a plain unbounded append for a time-boxed 7-day
 * fleet-wide capture window, after which the file is reviewed, secrets-
 * scrubbed, and checked into the repo as a static fixture — it is not a
 * long-lived production log.
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export const SPEECH_CAPTURE_FILE_NAME = 'speech-capture.jsonl'

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

function isCaptureEnabled(override: boolean | undefined): boolean {
  if (override !== undefined) return override
  return process.env.SWITCHROOM_SPEECH_CAPTURE === '1'
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
  try {
    const stateDir = opts.stateDir ?? process.env.TELEGRAM_STATE_DIR
    if (stateDir == null || stateDir.length === 0) return
    const now = opts.now ?? Date.now
    const line = `${JSON.stringify({ ts: now(), text })}\n`
    mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    appendFileSync(join(stateDir, SPEECH_CAPTURE_FILE_NAME), line, 'utf8')
  } catch {
    // Capture must never break the send path.
  }
}
