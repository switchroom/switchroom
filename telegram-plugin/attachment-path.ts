/**
 * Sanitizing path builder for downloaded Telegram attachments.
 *
 * Telegram's `file_path` and `file_unique_id` fields come from a trusted
 * response, but we still strip them to a safe character set before
 * interpolating into a filesystem path — defense in depth against:
 *   - future API-surface changes
 *   - a compromised/misbehaving Telegram account returning weird ids
 *   - path-traversal attempts via `../..` sequences
 *
 * Two callsites in server.ts (the MCP `download_attachment` tool and the
 * `message:photo` bot handler) were previously doing this inline, and
 * the photo handler forgot the sanitization — that's why this module
 * exists: a single implementation both paths delegate to.
 */

import { join, basename, resolve, sep } from 'node:path'

export interface AttachmentPathInput {
  /** Dir where downloaded attachments land. Caller creates this. */
  inboxDir: string
  /** Telegram's `file.file_path` (extension source). May be undefined. */
  telegramFilePath?: string
  /** Telegram's `file.file_unique_id`. May be undefined. */
  fileUniqueId?: string
  /** Epoch ms prefix for uniqueness. Injectable so tests are deterministic. */
  now: number
}

/** Strip to `[a-zA-Z0-9]`, fallback to `"bin"` on empty. */
export function sanitizeExtension(ext: string | undefined): string {
  if (ext == null) return 'bin'
  const cleaned = ext.replace(/[^a-zA-Z0-9]/g, '')
  return cleaned.length > 0 ? cleaned : 'bin'
}

/** Strip to `[a-zA-Z0-9_-]`, fallback to `"dl"` on empty. */
export function sanitizeUniqueId(id: string | undefined): string {
  if (id == null) return 'dl'
  const cleaned = id.replace(/[^a-zA-Z0-9_-]/g, '')
  return cleaned.length > 0 ? cleaned : 'dl'
}

/**
 * Pull the extension out of a Telegram file_path (e.g. "photos/123.jpg").
 * Returns the last dot-suffix if present, or "bin" otherwise.
 */
export function extractExtension(telegramFilePath: string | undefined): string {
  if (!telegramFilePath || !telegramFilePath.includes('.')) return 'bin'
  const raw = telegramFilePath.split('.').pop()!
  return sanitizeExtension(raw)
}

/**
 * Build a filesystem path for a downloaded attachment.
 * Guaranteed to land INSIDE `inboxDir` — no traversal possible because
 * both the unique-id and extension are character-class filtered.
 */
export function buildAttachmentPath(input: AttachmentPathInput): string {
  const ext = extractExtension(input.telegramFilePath)
  const uid = sanitizeUniqueId(input.fileUniqueId)
  const filename = `${input.now}-${uid}.${ext}`
  return join(input.inboxDir, filename)
}

/**
 * Belt-and-braces assertion: the resolved path really IS under inboxDir.
 * Throws on any escape. Callers should invoke this after building the
 * path and before writing bytes — it's cheap and makes the invariant
 * explicit instead of depending on the regex's correctness alone.
 */
export function assertInsideInbox(inboxDir: string, candidatePath: string): void {
  const inboxReal = resolve(inboxDir)
  const candidateReal = resolve(candidatePath)
  if (candidateReal !== inboxReal && !candidateReal.startsWith(inboxReal + sep)) {
    throw new Error(
      `attachment path escape: ${basename(candidatePath)} resolved outside ${inboxDir}`,
    )
  }
}
