/**
 * Access / allowlist file layer for the Telegram gateway.
 *
 * This module owns the read/write side of `access.json` (the per-agent DM
 * allowlist + group policy + pairing state) and the read-only `people.json`
 * projection. It was extracted verbatim out of `gateway.ts` (switchroom#4248)
 * to relieve the gateway line-ratchet; the behavior is byte-identical to the
 * inline version.
 *
 * Init-time semantics preserved: in static-access mode the gateway snapshots
 * `access.json` ONCE at module-init time (the `BOOT_ACCESS` constant below),
 * downgrades a `pairing` dmPolicy to `allowlist`, and clears pending pairings —
 * so a static agent's allowlist is frozen for the life of the process. That
 * snapshot must happen at the same point in startup as before, so the store is
 * built by a factory (`createAccessStore`) that the gateway calls at the
 * original `BOOT_ACCESS` site; the snapshot runs eagerly inside the factory,
 * NOT lazily on first `loadAccess()`.
 *
 * The gateway-internal dependencies (`ACCESS_FILE`, `PEOPLE_FILE`, `STATE_DIR`
 * path constants and the `STATIC` mode flag) are injected as explicit params so
 * this module holds no runtime import of gateway.ts. The only back-reference is
 * the `Access` / `GroupPolicy` types, imported type-only (erased under
 * `isolatedModules`, so no runtime cycle) — the same seam
 * `turn-start-surfaces.ts` already uses.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { validateStringArray } from './access-validator.js'
import type { RawPersonEntry } from './resolve-person.js'
import type { Access } from './gateway.js'

/** The per-group policy shape, derived from the exported `Access` type so the
 *  store needs no extra symbol export from gateway.ts. */
type GroupPolicy = Access['groups'][string]

/** Gateway-internal deps the store needs, injected at build time. */
export interface AccessStoreDeps {
  /** Absolute path to `access.json` (gateway's `ACCESS_FILE`). */
  accessFile: string
  /** Absolute path to `people.json` (gateway's `PEOPLE_FILE`). */
  peopleFile: string
  /** State dir created (mode 0o700) before an atomic access.json write. */
  stateDir: string
  /** Static-access mode (`TELEGRAM_ACCESS_MODE === 'static'`). Freezes the
   *  allowlist at init and turns `saveAccess` into a no-op. */
  isStatic: boolean
}

/** The access/allowlist file layer, bound to one set of paths + mode. */
export interface AccessStore {
  defaultAccess(): Access
  readAccessFile(): Access
  loadAccess(): Access
  readPeopleFile(): RawPersonEntry[]
  assertAllowedChat(chat_id: string | number): void
  saveAccess(a: Access): void
  pruneExpired(a: Access): boolean
}

/**
 * Build the access store. The `BOOT_ACCESS` snapshot happens eagerly here, so
 * call this at the same point in gateway startup where `BOOT_ACCESS` used to be
 * initialized — that keeps the static-mode freeze timing identical.
 */
export function createAccessStore(deps: AccessStoreDeps): AccessStore {
  const { accessFile, peopleFile, stateDir, isStatic } = deps

  function defaultAccess(): Access {
    return { dmPolicy: 'pairing', allowFrom: [], groups: {}, pending: {} }
  }

  function readAccessFile(): Access {
    try {
      const raw = readFileSync(accessFile, 'utf8')
      const parsed = JSON.parse(raw) as Partial<Access>
      const allowFrom = validateStringArray('allowFrom', parsed.allowFrom ?? [])
      const groups: Record<string, GroupPolicy> = {}
      for (const [chatId, policy] of Object.entries(parsed.groups ?? {})) {
        groups[chatId] = {
          ...policy,
          allowFrom: validateStringArray(`groups.${chatId}.allowFrom`, policy.allowFrom ?? []),
        }
      }
      return {
        dmPolicy: parsed.dmPolicy ?? 'pairing',
        allowFrom,
        groups,
        pending: parsed.pending ?? {},
        mentionPatterns: parsed.mentionPatterns,
        ackReaction: parsed.ackReaction,
        replyToMode: parsed.replyToMode,
        textChunkLimit: parsed.textChunkLimit,
        chunkMode: parsed.chunkMode,
        parseMode: parsed.parseMode,
        disableLinkPreview: parsed.disableLinkPreview,
        coalescingGapMs: parsed.coalescingGapMs,
        litellmNoticeWindowMs: parsed.litellmNoticeWindowMs,
        coalesceMaxAttachments: parsed.coalesceMaxAttachments,
        interruptSafeBoundary: parsed.interruptSafeBoundary,
        interruptMaxWaitMs: parsed.interruptMaxWaitMs,
        statusReactions: parsed.statusReactions,
        historyEnabled: parsed.historyEnabled,
        historyRetentionDays: parsed.historyRetentionDays,
        // #596: telegram features projected into access.json by scaffold.
        // Without these passthroughs, gateway readers (`access.voice_in`,
        // `access.telegraph`, `access.stickers`) silently see undefined.
        stickers: parsed.stickers,
        voice_in: parsed.voice_in,
        voice_out: parsed.voice_out,
        telegraph: parsed.telegraph,
        // #789: button-choice-confirmation config projected by scaffold.
        button_choice_confirmation: parsed.button_choice_confirmation,
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultAccess()
      try { renameSync(accessFile, `${accessFile}.corrupt-${Date.now()}`) } catch {}
      process.stderr.write(`telegram gateway: access.json is corrupt, moved aside. Starting fresh.\n`)
      return defaultAccess()
    }
  }

  const BOOT_ACCESS: Access | null = isStatic
    ? (() => {
        const a = readAccessFile()
        if (a.dmPolicy === 'pairing') {
          process.stderr.write('telegram gateway: static mode — dmPolicy "pairing" downgraded to "allowlist"\n')
          a.dmPolicy = 'allowlist'
        }
        a.pending = {}
        return a
      })()
    : null

  function loadAccess(): Access {
    return BOOT_ACCESS ?? readAccessFile()
  }

  /**
   * Read `people.json` (the scaffold's plain projection of `users:` entries
   * that carry a `person_id`). Fail-open: ENOENT or corrupt/malformed JSON
   * returns an empty array rather than throwing — this feature must never
   * block startup. Unlike `access.json` this file is never gateway-mutated,
   * so there's no "move corrupt file aside" concern; the scaffold owns and
   * regenerates it on every reconcile.
   */
  function readPeopleFile(): RawPersonEntry[] {
    try {
      const raw = readFileSync(peopleFile, 'utf8')
      const parsed = JSON.parse(raw) as { entries?: unknown }
      if (!Array.isArray(parsed.entries)) return []
      return parsed.entries as RawPersonEntry[]
    } catch {
      return []
    }
  }

  function assertAllowedChat(chat_id: string | number): void {
    const id = String(chat_id)
    const access = loadAccess()
    if (access.allowFrom.includes(id)) return
    if (id in access.groups) return
    throw new Error(`chat ${id} is not allowlisted — add via /telegram:access`)
  }

  function saveAccess(a: Access): void {
    if (isStatic) return
    mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    const tmp = accessFile + '.tmp'
    writeFileSync(tmp, JSON.stringify(a, null, 2) + '\n', { mode: 0o600 })
    renameSync(tmp, accessFile)
  }

  function pruneExpired(a: Access): boolean {
    const now = Date.now()
    let changed = false
    for (const [code, p] of Object.entries(a.pending)) {
      if (p.expiresAt < now) {
        delete a.pending[code]
        changed = true
      }
    }
    return changed
  }

  return {
    defaultAccess,
    readAccessFile,
    loadAccess,
    readPeopleFile,
    assertAllowedChat,
    saveAccess,
    pruneExpired,
  }
}
