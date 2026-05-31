/**
 * Pure helpers for A2 multi-attachment coalescing — kept out of `gateway.ts`
 * so the cap/ordering and numbered-meta logic can be unit-tested without the
 * gateway's `loadAccess()` / IPC machinery.
 *
 * Inbound model: each Telegram message carries at most one attachment, so the
 * coalescer accumulates one attachment per buffered entry. On flush the
 * gateway folds up to `coalesce.max_attachments` of them into a single turn —
 * the first is the primary (unsuffixed `image_path` / `attachment_*` meta),
 * the rest are numbered siblings (`image_path_2`, `attachment_file_id_2`, …).
 */

export interface CoalesceAttachmentMeta {
  kind: string
  file_id: string
  size?: number
  mime?: string
  name?: string
}

/** A resolved extra attachment: photos are pre-downloaded to `imagePath`;
 *  documents/voice carry only `attachment` metadata (agent fetches the file
 *  via `download_attachment`). */
export interface ResolvedExtraAttachment {
  imagePath?: string
  attachment?: CoalesceAttachmentMeta
}

/**
 * Split the attachment-bearing entries of a coalesce window into the primary
 * entry plus the capped list of extras. Preserves arrival order so a
 * `[photo][text][photo]` burst keeps both photos in the order sent. Entries
 * past `maxAttachments` are dropped here (the gateway bypasses them to their
 * own turn upstream, so nothing is actually lost).
 *
 * `maxAttachments` is floored at 1 — a cap of 0 or negative would strip the
 * primary, silently dropping the only attachment.
 */
export function splitCoalescedAttachments<T>(
  entries: T[],
  hasAttachment: (e: T) => boolean,
  maxAttachments: number,
): { primary: T | undefined; extras: T[] } {
  const withAttachment = entries.filter(hasAttachment)
  const capped = withAttachment.slice(0, Math.max(1, maxAttachments))
  const [primary, ...extras] = capped
  return { primary, extras: extras }
}

/**
 * Build the numbered meta fields for the resolved extra attachments. The
 * primary occupies the unsuffixed keys, so extras start at `_2`.
 */
export function buildExtraAttachmentMeta(
  resolved: ResolvedExtraAttachment[],
): Record<string, string> {
  const out: Record<string, string> = {}
  resolved.forEach((ex, i) => {
    const n = i + 2
    if (ex.imagePath) out[`image_path_${n}`] = ex.imagePath
    if (ex.attachment) {
      out[`attachment_kind_${n}`] = ex.attachment.kind
      out[`attachment_file_id_${n}`] = ex.attachment.file_id
      if (ex.attachment.size != null) out[`attachment_size_${n}`] = String(ex.attachment.size)
      if (ex.attachment.mime) out[`attachment_mime_${n}`] = ex.attachment.mime
      if (ex.attachment.name) out[`attachment_name_${n}`] = ex.attachment.name
    }
  })
  return out
}
