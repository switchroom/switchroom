/**
 * Boot-time-only, chat-scoped resolution of a raw Telegram id/username into
 * a human `person_id` (e.g. "Lisa") for display in the `<channel>` tag's
 * `user` attribute.
 *
 * Design (converged after adversarial review — see the PR description for
 * the tradeoffs, do not re-litigate here):
 *
 *   - No MCP tool. Not callable by agents — display-only, gateway-internal.
 *   - No hot-reload. `PersonDirectory` is built ONCE at gateway boot from
 *     the static in-memory `people.json` the scaffold projected from
 *     `switchroom.yaml`'s `users:` block. A config change requires an agent
 *     restart to take effect — this file never re-reads anything.
 *   - `access.json` (the fail-CLOSED allow-list) is a completely separate
 *     concern and is never touched here. This feature is fail-OPEN: an
 *     unresolved id/username falls back to today's behavior (the caller
 *     keeps using the raw id/username) — it never blocks or denies
 *     anything.
 *   - Chat-scoped: a resolved name is only ever returned for a chat/group
 *     the person is actually a member of. In a DM the chat IS the sender,
 *     so resolution always applies. In a group, resolution only applies if
 *     the sender's id or username is explicitly present in that group's
 *     `allowFrom` (read from the EXISTING `access.json`/`loadAccess()`
 *     data — no new membership source). An empty/unset group `allowFrom`
 *     means membership can't be positively confirmed, so we conservatively
 *     do NOT resolve (the raw id/username is shown instead) — a name safe
 *     in a 1:1 DM could be a bigger leak in a shared group.
 *   - Per-entry validation: a malformed `users:` entry (duplicate
 *     `person_id` claimed by two different keys, empty/invalid
 *     `person_id`, no `telegram_ids`) drops ONLY that one entry — it never
 *     blanks resolution for the whole fleet. `buildPersonDirectory` never
 *     throws; every failure mode is reported via its `dropped` return
 *     value instead, so the caller can route it through the existing
 *     fleet-alert path (`emitGatewayOperatorEvent` in gateway.ts) at
 *     low/config severity — this must never page like a real outage.
 *
 * Fix note (accepted soft mitigation — see docs/configuration.md): there is
 * no automated enforcement that a configured `person_id` stays safe to show
 * if a group's membership changes AFTER the entry is written. This is an
 * operator-discipline convention, not a closed gap. Low severity today —
 * only two `person_id`s are configured fleet-wide.
 */

export interface RawPersonEntry {
  /** The `users:` map key (e.g. "lisa") — carried through for alert text. */
  key: string
  person_id: string
  telegram_ids: string[]
}

export interface PersonDirectoryEntry {
  key: string
  personId: string
  /** Normalized (lowercased, no leading "@") telegram ids/usernames. */
  telegramKeys: string[]
}

export interface PersonDirectory {
  /** normalized telegram id/username -> directory entry */
  byTelegramKey: Record<string, PersonDirectoryEntry>
}

export interface DroppedPersonEntry {
  key: string
  reason: string
  /**
   * Name-scrubbed reason CLASS — the same rejection without the embedded
   * `person_id` human-name value or the colliding telegram id. Used to
   * build the broadcast `alertDetail` so a config-warning card (which
   * `emitGatewayOperatorEvent` sends to EVERY `allowFrom` chat, including
   * group chats where the named person may NOT be a member) never surfaces
   * a human name that the display path (`resolvePersonName`) deliberately
   * chat-scopes. The verbose `reason` is still carried for the operator's
   * own stderr `logLine` (private, not broadcast).
   */
  reasonClass: string
}

export interface BuildPersonDirectoryResult {
  directory: PersonDirectory
  dropped: DroppedPersonEntry[]
}

/** Normalize a telegram id or @username for keying: trim, strip a leading
 * "@", lowercase (Telegram usernames are case-insensitive). */
function normalizeTelegramKey(raw: string): string {
  return raw.trim().replace(/^@/, '').toLowerCase()
}

/**
 * Validate and dedupe raw `users:` `person_id` entries into a lookup
 * directory. Never throws — every rejection is reported via `dropped`
 * instead, per the fail-open / drop-only-that-entry design.
 *
 * Drop reasons:
 *   - missing/blank `key` or `person_id`
 *   - `telegram_ids` missing or empty (nothing to key the entry by)
 *   - `person_id` already claimed by an earlier (different) entry key —
 *     first-declared entry wins, the later duplicate is dropped whole
 *     (not just the colliding id) so the alert is unambiguous about which
 *     entry lost
 *   - a `telegram_id`/username already claimed by an earlier (different)
 *     entry key — same first-declared-wins convention: the later duplicate
 *     is dropped whole so the alert is unambiguous about which entry lost
 *     and we never silently last-write-wins a numeric id into the wrong
 *     person's name
 */
export function buildPersonDirectory(entries: readonly RawPersonEntry[]): BuildPersonDirectoryResult {
  const byTelegramKey: Record<string, PersonDirectoryEntry> = {}
  const dropped: DroppedPersonEntry[] = []
  const personIdOwner = new Map<string, string>() // person_id (lowercased) -> owning entry key
  const telegramKeyOwner = new Map<string, string>() // normalized telegram id/username -> owning entry key

  for (const raw of entries) {
    const key = typeof raw.key === 'string' ? raw.key.trim() : ''
    const personId = typeof raw.person_id === 'string' ? raw.person_id.trim() : ''

    if (key.length === 0) {
      dropped.push({ key: raw.key || '(unknown)', reason: 'missing users: map key', reasonClass: 'missing users: map key' })
      continue
    }
    if (personId.length === 0) {
      dropped.push({ key, reason: 'empty or missing person_id', reasonClass: 'empty or missing person_id' })
      continue
    }
    if (!Array.isArray(raw.telegram_ids) || raw.telegram_ids.length === 0) {
      dropped.push({ key, reason: 'no telegram_ids to resolve against', reasonClass: 'no telegram_ids to resolve against' })
      continue
    }

    const personIdLower = personId.toLowerCase()
    const existingOwner = personIdOwner.get(personIdLower)
    if (existingOwner != null && existingOwner !== key) {
      dropped.push({
        key,
        // Verbose reason (stderr logLine only — private to the operator):
        // names the person_id value + the owning config key.
        reason: `duplicate person_id "${personId}" already claimed by users.${existingOwner}`,
        // reasonClass (broadcast alertDetail): scrubs the human-name
        // person_id value; keeps the entry key + collision class. A
        // config-warning card fans out to every allowFrom chat, so the
        // name must not travel further than the display path allows.
        reasonClass: `duplicate person_id already claimed by users.${existingOwner}`,
      })
      continue
    }
    personIdOwner.set(personIdLower, key)

    const telegramKeys = [...new Set(raw.telegram_ids.map(normalizeTelegramKey).filter((k) => k.length > 0))]
    if (telegramKeys.length === 0) {
      dropped.push({ key, reason: 'telegram_ids contained no usable id/username', reasonClass: 'telegram_ids contained no usable id/username' })
      personIdOwner.delete(personIdLower)
      continue
    }

    const collidingTelegramKey = telegramKeys.find((tk) => {
      const existingTkOwner = telegramKeyOwner.get(tk)
      return existingTkOwner != null && existingTkOwner !== key
    })
    if (collidingTelegramKey != null) {
      const existingTkOwner = telegramKeyOwner.get(collidingTelegramKey)
      dropped.push({
        key,
        reason: `duplicate telegram_id "${collidingTelegramKey}" already claimed by users.${existingTkOwner}`,
        // Scrub the colliding telegram id/username from the broadcast
        // reason; keep the owning config key (operator-chosen slug).
        reasonClass: `duplicate telegram_id already claimed by users.${existingTkOwner}`,
      })
      personIdOwner.delete(personIdLower)
      continue
    }

    const entry: PersonDirectoryEntry = { key, personId, telegramKeys }
    for (const tk of telegramKeys) {
      telegramKeyOwner.set(tk, key)
      byTelegramKey[tk] = entry
    }
  }

  return { directory: { byTelegramKey }, dropped }
}

export interface PersonDirectoryBootResult {
  directory: PersonDirectory
  /** Non-null when the caller should route an alert through the fleet
   * alert path (`emitGatewayOperatorEvent`, kind: 'config-warning'). */
  alertDetail: string | null
  /** Always present — one human-readable line for stderr. */
  logLine: string
}

/**
 * Orchestrate the ONE-TIME boot-time check (requirement: boot-time-only,
 * NOT periodic — call this exactly once, at gateway boot, never on a
 * timer/interval). Extracted as a pure(ish) function — taking the file
 * read as an injected dependency and RETURNING what to log/alert rather
 * than performing the I/O itself — so it's unit-testable without booting
 * the real gateway process.
 *
 * Dead-man's-switch: wraps the whole check in try/catch. If anything
 * throws before completing (including `readEntries` itself), that failure
 * is ALSO surfaced via `alertDetail` — mirrors a past incident where
 * `access.json` validation failed silently in the wrong (fail-open)
 * direction, undetected for hours. `PERSON_DIRECTORY` falls back to an
 * empty directory on crash (fail-open: raw ids/usernames keep showing).
 */
export function runPersonDirectoryBootCheck(readEntries: () => RawPersonEntry[]): PersonDirectoryBootResult {
  try {
    const rawEntries = readEntries()
    const { directory, dropped } = buildPersonDirectory(rawEntries)

    if (dropped.length > 0) {
      // Broadcast-safe summary for `alertDetail` (fans out to EVERY
      // allowFrom chat via emitGatewayOperatorEvent, including group chats
      // where the named person may not be a member): built from
      // `reasonClass`, which scrubs the embedded person_id human-name
      // value and the colliding telegram id. The verbose `reason`
      // (names the values) is kept for the operator's own stderr
      // `logLine` — private, never broadcast.
      const alertSummary = dropped.map((d) => `${d.key} (${d.reasonClass})`).join('; ')
      const logSummary = dropped.map((d) => `${d.key} (${d.reason})`).join('; ')
      const plural = dropped.length === 1 ? 'y' : 'ies'
      return {
        directory,
        alertDetail: `person_id: dropped ${dropped.length} malformed users: entr${plural} at boot — ${alertSummary}`,
        logLine: `telegram gateway: person_id boot validation dropped ${dropped.length} entr${plural}: ${logSummary}`,
      }
    }

    return {
      directory,
      alertDetail: null,
      logLine: rawEntries.length > 0
        ? `telegram gateway: person_id boot validation ok — ${Object.keys(directory.byTelegramKey).length} telegram id/username(s) resolved`
        : `telegram gateway: person_id boot validation ok — no person_id entries configured`,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      directory: { byTelegramKey: {} },
      // Crash alertDetail scrubs the raw error message too — it can
      // carry a filesystem path or other host detail that shouldn't fan
      // out to every allowFrom chat. The full message stays in logLine.
      alertDetail: `person_id boot validation crashed — name resolution disabled this boot (fail-open, raw ids/usernames will show); see gateway stderr for detail`,
      logLine: `telegram gateway: person_id boot validation CRASHED (name resolution disabled this boot, raw ids will show — fail-open): ${msg}`,
    }
  }
}

export interface ResolvePersonOptions {
  telegramId: string
  username?: string | undefined
  isDm: boolean
  /** That chat's/group's configured allowFrom, if any (from access.json). */
  groupAllowFrom?: readonly string[] | undefined
}

/**
 * Resolve a sender's display name for THIS chat, chat-scoped per the
 * module doc above. Returns undefined (fall back to raw id/username) when
 * unresolved OR when membership in a group chat can't be positively
 * confirmed.
 */
export function resolvePersonName(directory: PersonDirectory, opts: ResolvePersonOptions): string | undefined {
  const idKey = normalizeTelegramKey(opts.telegramId)
  const usernameKey = opts.username ? normalizeTelegramKey(opts.username) : undefined

  const entry = directory.byTelegramKey[idKey] ?? (usernameKey ? directory.byTelegramKey[usernameKey] : undefined)
  if (!entry) return undefined

  // DM: the chat IS the sender, so resolution always applies.
  if (opts.isDm) return entry.personId

  // Group: only resolve if the sender is explicitly present in that
  // chat's allowFrom (the existing membership source) — conservative
  // fallback (undefined) otherwise, since we can't positively confirm
  // membership from an empty/unset list.
  const allowFrom = opts.groupAllowFrom ?? []
  const allowFromNormalized = allowFrom.map(normalizeTelegramKey)
  const memberConfirmed =
    allowFromNormalized.includes(idKey) || (usernameKey != null && allowFromNormalized.includes(usernameKey))
  return memberConfirmed ? entry.personId : undefined
}

/**
 * Fail-open call-site wrapper around `resolvePersonName`, for use at the
 * `handleInbound` call site (gateway.ts). This feature's whole design
 * point is "never blocks or denies anything" (module doc above) — a throw
 * from resolution must fall back to the raw id/username, not abort message
 * handling. Mirrors the same defensive pattern already used for
 * `readPeopleFile` (gateway.ts) and `runPersonDirectoryBootCheck` (this
 * file): catch, fall back, never propagate.
 */
export function safeResolvePersonName(
  directory: PersonDirectory,
  opts: ResolvePersonOptions,
  rawFallback: string,
): string {
  try {
    return resolvePersonName(directory, opts) ?? rawFallback
  } catch {
    return rawFallback
  }
}
