/**
 * On-demand voice send with Telegram file_id reuse.
 *
 * The Listen-button tap used to re-upload the audio bytes as a fresh InputFile
 * on EVERY send — an upload + server-side ingest round-trip each time, which is
 * the delay users felt on repeat taps. Telegram returns a reusable `file_id`
 * after the first upload; sending BY that id (a plain string, not an InputFile)
 * makes Telegram serve the already-stored bytes, which is near-instant and
 * skips the disk read entirely.
 *
 * {@link sendVoiceReusingFileId} is the dependency-free decision core so it can
 * be unit-tested without importing the 25k-line gateway (which has import-time
 * side effects) or grammy. The gateway supplies the concrete send closures.
 *
 * Contract:
 *   1. If a stored file_id exists → send BY id (no disk read, no upload). On
 *      success capture the returned id (Telegram may echo the same one).
 *   2. If the stored id send fails with ANY HTTP 400 → treat the id as
 *      stale/invalid (regardless of the exact wording), fall through to the
 *      upload path ONCE and refresh the stored id so a dead id can never
 *      permanently break Listen. Any NON-400 error (network / 5xx / 403
 *      blocked-by-user) is a real failure and is surfaced (no silent
 *      re-upload storm, no papering over a 403).
 *   3. If no id yet → load the audio (disk fast-path or on-demand synth) and
 *      send it as an InputFile, capturing the returned file_id for next time.
 */

/** The subset of a Telegram Message we read back: the sent voice's file_id. */
export type SentVoiceMessage = { voice?: { file_id?: string } } | undefined | null

/** Extract the reusable file_id from a `sendVoice` response, if present. */
export function extractVoiceFileId(sent: SentVoiceMessage): string | undefined {
  const id = sent?.voice?.file_id
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/**
 * True iff `err` looks like Telegram rejecting a file_id we sent (expired or
 * malformed id) — the one case where re-uploading from disk is the right
 * recovery. Duck-typed so this module stays grammy-free: a GrammyError carries
 * `error_code` (number) and `description` (string). A 400 whose text names the
 * file identifier is a stale-id signal; any other error is a genuine failure
 * the caller must NOT paper over with a silent re-upload.
 */
export function isInvalidTelegramFileIdError(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false
  const e = err as { error_code?: unknown; description?: unknown; message?: unknown }
  const code = typeof e.error_code === 'number' ? e.error_code : undefined
  if (code !== undefined && code !== 400) return false
  const text = String(e.description ?? e.message ?? '').toLowerCase()
  return (
    text.includes('file identifier') ||
    text.includes('file_id') ||
    text.includes('wrong file') ||
    text.includes('wrong remote file') ||
    text.includes('wrong padding')
  )
}

/**
 * True iff `err` is an HTTP 400-class Telegram rejection (grammy `error_code`
 * 400), regardless of the description wording. This is the re-upload trigger:
 * a send-by-file_id that fails with a 400 is treated as a stale/invalid id and
 * recovered by re-uploading from disk ONCE, superseding the narrower
 * substring-matched {@link isInvalidTelegramFileIdError}. Rationale: a
 * re-upload is always safe recovery and can never be worse than re-hitting a
 * guaranteed-failing id, whereas Telegram may return a stale-id 400 with
 * wording outside the known substring set. Non-400 errors (network / 5xx /
 * 403 blocked-by-user) are NOT 400 and must remain real failures — never
 * re-uploaded. Duck-typed so this module stays grammy-free.
 */
export function isHttp400Error(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false
  const e = err as { error_code?: unknown }
  return e.error_code === 400
}

export type ReuseFileIdDeps = {
  /** The entry's stored Telegram file_id, or null if none captured yet. */
  fileId: string | null
  /** Send by an already-uploaded file_id string. Resolves to the sent Message. */
  sendByFileId: (fileId: string) => Promise<SentVoiceMessage>
  /** Load the audio bytes (disk fast-path, then on-demand synth). Returns null
   *  when audio is unavailable — the impl has already surfaced any user-facing
   *  toast in that case. Only invoked on the upload path (never when a valid
   *  file_id served the tap). */
  loadAudio: () => Promise<Uint8Array | null>
  /** Upload the audio as an InputFile. Resolves to the sent Message. */
  sendByUpload: (audio: Uint8Array) => Promise<SentVoiceMessage>
  /** Persist a freshly captured/refreshed file_id onto the cache entry. */
  onFileId: (fileId: string) => void
  /** Classify a `sendByFileId` rejection: true → re-upload from disk once +
   *  refresh the id; false → surface as a real failure. Defaults to
   *  {@link isHttp400Error} — ANY HTTP 400 is treated as a stale/invalid id
   *  (safe recovery), superseding the narrower substring-matched
   *  {@link isInvalidTelegramFileIdError}. Non-400 errors (network / 5xx /
   *  403) stay real failures and never re-upload. */
  isInvalidFileIdError?: (err: unknown) => boolean
  log?: (line: string) => void
}

export type ReuseFileIdResult =
  | { ok: true; path: 'file_id' | 'upload'; refreshed: boolean }
  | { ok: false; reason: 'no-audio' }
  | { ok: false; reason: 'send-failed'; error: unknown }

/**
 * Send a voice note reusing a stored file_id when possible, with a disk/synth
 * re-upload fallback on a stale id. See the module header for the full
 * contract. Never throws — send failures are returned as `{ ok: false }`.
 */
export async function sendVoiceReusingFileId(deps: ReuseFileIdDeps): Promise<ReuseFileIdResult> {
  const shouldReupload = deps.isInvalidFileIdError ?? isHttp400Error

  // 1. Fast path — reuse the stored file_id. No disk read, no re-upload.
  if (deps.fileId != null && deps.fileId.length > 0) {
    try {
      const sent = await deps.sendByFileId(deps.fileId)
      const fresh = extractVoiceFileId(sent)
      if (fresh != null) deps.onFileId(fresh)
      return { ok: true, path: 'file_id', refreshed: false }
    } catch (err) {
      if (!shouldReupload(err)) {
        // Non-400 (network / 5xx / 403 blocked-by-user) — a real failure, not a
        // stale id. Never re-upload; surface it so the caller can retry/report.
        return { ok: false, reason: 'send-failed', error: err }
      }
      // Any 400 — treat the stored id as stale/invalid regardless of wording and
      // recover by re-uploading below ONCE + refreshing the id. This can never
      // be worse than re-hitting a guaranteed-failing id, and covers stale-id
      // 400s whose text falls outside isInvalidTelegramFileIdError's substrings.
      deps.log?.(
        `voice-ondemand: stored file_id rejected (${String(
          (err as { description?: unknown; message?: unknown })?.description ??
            (err as { message?: unknown })?.message ??
            err,
        )}) — re-uploading from disk\n`,
      )
    }
  }

  // 2. Upload path — load audio then send as an InputFile; capture the id.
  const audio = await deps.loadAudio()
  if (audio == null) return { ok: false, reason: 'no-audio' }
  const refreshed = deps.fileId != null && deps.fileId.length > 0
  try {
    const sent = await deps.sendByUpload(audio)
    const fresh = extractVoiceFileId(sent)
    if (fresh != null) deps.onFileId(fresh)
    return { ok: true, path: 'upload', refreshed }
  } catch (err) {
    return { ok: false, reason: 'send-failed', error: err }
  }
}
