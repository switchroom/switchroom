/**
 * Photo inbound handler (switchroom#2996 P6 cluster D).
 *
 * `message:photo` is the one attachment type whose gateway handling is not a
 * pure metadata render: it downloads the largest photo size from the Telegram
 * CDN (bounded 15s fetch), writes it into the per-agent inbox with 0600 perms,
 * and hands the on-disk path to the coalescing inbound pipeline as the image
 * download. Split out of the cluster-C metadata handlers precisely because it
 * carries side-effecting IO + bot-token handling.
 *
 * The registration line stays in gateway.ts (order is a load-bearing invariant
 * pinned by gateway-handler-registration-wiring.test.ts) and delegates here.
 * The bot token is read lazily via `getToken()` — it is materialized after
 * this deps object is constructed — and never exposed in logs (redacted on the
 * error path). Path-safety helpers are imported directly.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import type { Context, Filter } from 'grammy'
import { buildAttachmentPath, assertInsideInbox } from '../attachment-path.js'

export interface PhotoHandlerDeps {
  handleInboundCoalesced: (
    ctx: Context,
    text: string,
    downloadImage: (() => Promise<string | undefined>) | undefined,
  ) => Promise<void>
  /** Lazily read the materialized bot token (set after deps construction). */
  getToken: () => string
  /** Per-agent inbox directory (0700). */
  inboxDir: string
  /** stderr log sink. */
  log: (line: string) => void
}

export async function handlePhotoMessage(
  ctx: Filter<Context, 'message:photo'>,
  deps: PhotoHandlerDeps,
): Promise<void> {
  const caption = ctx.message.caption ?? '(photo)'
  await deps.handleInboundCoalesced(ctx, caption, async () => {
    const photos = ctx.message.photo
    const best = photos[photos.length - 1]
    try {
      const file = await ctx.api.getFile(best.file_id)
      if (!file.file_path) return undefined
      // Build download URL — token is embedded in the URL but never exposed
      // in error messages or logs (caught and sanitized below).
      //
      // Bounded fetch: a stalled Telegram CDN connection without a
      // timeout would hang the entire inbound handler, blocking the
      // user's photo from ever being acked or seen by the agent.
      // 15s is generous for normal photos (typical 100ms-2s) and
      // tight enough to surface a real outage.
      const token = deps.getToken()
      const downloadUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`
      const res = await fetch(downloadUrl, { signal: AbortSignal.timeout(15_000) })
      if (!res.ok) {
        deps.log(`telegram gateway: photo download failed: HTTP ${res.status}\n`)
        return undefined
      }
      const buf = Buffer.from(await res.arrayBuffer())
      const dlPath = buildAttachmentPath({
        inboxDir: deps.inboxDir,
        telegramFilePath: file.file_path,
        fileUniqueId: best.file_unique_id,
        now: Date.now(),
      })
      mkdirSync(deps.inboxDir, { recursive: true, mode: 0o700 })
      assertInsideInbox(deps.inboxDir, dlPath)
      writeFileSync(dlPath, buf, { mode: 0o600 })
      return dlPath
    } catch (err) {
      // Sanitize error to avoid leaking bot token in logs
      const msg = err instanceof Error ? err.message : 'unknown error'
      deps.log(`telegram gateway: photo download failed: ${msg.replace(deps.getToken(), '<REDACTED>')}\n`)
      return undefined
    }
  })
}
