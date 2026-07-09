import { describe, it, expect, vi } from 'vitest'
import {
  buildPersonDirectory,
  resolvePersonName,
  runPersonDirectoryBootCheck,
  safeResolvePersonName,
  type PersonDirectory,
  type RawPersonEntry,
} from '../gateway/resolve-person.js'

/**
 * Telegram person_id name resolution (docs/configuration.md).
 *
 * Covers the requirements from the converged design:
 *   - happy-path resolution
 *   - unresolved-id fallback (fail-open)
 *   - a malformed single entry is dropped WITHOUT affecting others
 *   - chat-scoping: a name is shown only in a chat/group the person is a
 *     member of (per that chat's allowFrom), never broadcast into every
 *     chat
 *   - boot-time validation alert firing on bad config
 *   - validation-step-crash alert firing (dead-man's-switch)
 */

const LISA: RawPersonEntry = { key: 'lisa', person_id: 'Lisa', telegram_ids: ['8201250670'] }
const KEN: RawPersonEntry = { key: 'ken', person_id: 'Ken', telegram_ids: ['mekenthompson', '111'] }

describe('buildPersonDirectory — happy path', () => {
  it('resolves a single well-formed entry', () => {
    const { directory, dropped } = buildPersonDirectory([LISA])
    expect(dropped).toEqual([])
    expect(directory.byTelegramKey['8201250670']?.personId).toBe('Lisa')
  })

  it('resolves multiple entries, multiple telegram_ids each, case/@-insensitive', () => {
    const { directory, dropped } = buildPersonDirectory([LISA, KEN])
    expect(dropped).toEqual([])
    expect(directory.byTelegramKey['8201250670']?.personId).toBe('Lisa')
    expect(directory.byTelegramKey['mekenthompson']?.personId).toBe('Ken')
    expect(directory.byTelegramKey['111']?.personId).toBe('Ken')
    // username lookups are normalized: leading "@" stripped, lowercased
    expect(directory.byTelegramKey['@MeKenThompson'.trim().replace(/^@/, '').toLowerCase()]?.personId).toBe('Ken')
  })

  it('no entries → empty directory (fleet behaves as today)', () => {
    const { directory, dropped } = buildPersonDirectory([])
    expect(directory.byTelegramKey).toEqual({})
    expect(dropped).toEqual([])
  })
})

describe('buildPersonDirectory — per-entry validation drops only the bad entry', () => {
  it('drops an entry with an empty person_id, keeps the other entry intact', () => {
    const bad: RawPersonEntry = { key: 'ghost', person_id: '', telegram_ids: ['999'] }
    const { directory, dropped } = buildPersonDirectory([LISA, bad])
    expect(directory.byTelegramKey['8201250670']?.personId).toBe('Lisa')
    expect(directory.byTelegramKey['999']).toBeUndefined()
    expect(dropped).toHaveLength(1)
    expect(dropped[0]?.key).toBe('ghost')
    expect(dropped[0]?.reason).toMatch(/person_id/)
  })

  it('drops an entry with no telegram_ids, keeps the other entry intact', () => {
    const bad: RawPersonEntry = { key: 'ghost', person_id: 'Ghost', telegram_ids: [] }
    const { directory, dropped } = buildPersonDirectory([LISA, bad])
    expect(directory.byTelegramKey['8201250670']?.personId).toBe('Lisa')
    expect(dropped).toHaveLength(1)
    expect(dropped[0]?.key).toBe('ghost')
    expect(dropped[0]?.reason).toMatch(/telegram_ids/)
  })

  it('drops a duplicate person_id (later entry loses), keeps the first entry intact', () => {
    const dupe: RawPersonEntry = { key: 'lisa2', person_id: 'Lisa', telegram_ids: ['555'] }
    const { directory, dropped } = buildPersonDirectory([LISA, dupe])
    expect(directory.byTelegramKey['8201250670']?.personId).toBe('Lisa')
    expect(directory.byTelegramKey['555']).toBeUndefined()
    expect(dropped).toHaveLength(1)
    expect(dropped[0]?.key).toBe('lisa2')
    expect(dropped[0]?.reason).toMatch(/duplicate person_id/)
  })

  it('drops a duplicate telegram_id claimed by a different person_id (later entry loses), keeps the first entry intact — no silent last-write-wins', () => {
    const dupe: RawPersonEntry = { key: 'imposter', person_id: 'Imposter', telegram_ids: ['8201250670'] }
    const { directory, dropped } = buildPersonDirectory([LISA, dupe])
    expect(directory.byTelegramKey['8201250670']?.personId).toBe('Lisa')
    expect(dropped).toHaveLength(1)
    expect(dropped[0]?.key).toBe('imposter')
    expect(dropped[0]?.reason).toMatch(/duplicate telegram_id/)
  })

  it('telegram_id collision on boot check fires the config-warning alert path, does not blank the whole directory', () => {
    const dupe: RawPersonEntry = { key: 'imposter', person_id: 'Imposter', telegram_ids: ['8201250670'] }
    const result = runPersonDirectoryBootCheck(() => [LISA, KEN, dupe])
    expect(result.alertDetail).not.toBeNull()
    expect(result.alertDetail).toContain('imposter')
    expect(result.directory.byTelegramKey['8201250670']?.personId).toBe('Lisa')
    expect(result.directory.byTelegramKey['mekenthompson']?.personId).toBe('Ken')
  })

  it('drops an entry with a missing users: map key', () => {
    const bad: RawPersonEntry = { key: '', person_id: 'Nobody', telegram_ids: ['1'] }
    const { directory, dropped } = buildPersonDirectory([LISA, bad])
    expect(directory.byTelegramKey['8201250670']?.personId).toBe('Lisa')
    expect(dropped).toHaveLength(1)
    expect(dropped[0]?.reason).toMatch(/users: map key/)
  })

  it('multiple malformed entries each get their own drop reason, valid entries unaffected', () => {
    const bad1: RawPersonEntry = { key: 'a', person_id: '', telegram_ids: ['1'] }
    const bad2: RawPersonEntry = { key: 'b', person_id: 'B', telegram_ids: [] }
    const { directory, dropped } = buildPersonDirectory([LISA, bad1, KEN, bad2])
    expect(dropped).toHaveLength(2)
    expect(directory.byTelegramKey['8201250670']?.personId).toBe('Lisa')
    expect(directory.byTelegramKey['mekenthompson']?.personId).toBe('Ken')
  })
})

describe('resolvePersonName — unresolved id falls back (fail-open)', () => {
  it('returns undefined for an id not in the directory', () => {
    const { directory } = buildPersonDirectory([LISA])
    const name = resolvePersonName(directory, { telegramId: '000', isDm: true })
    expect(name).toBeUndefined()
  })

  it('returns undefined for an empty directory', () => {
    const { directory } = buildPersonDirectory([])
    const name = resolvePersonName(directory, { telegramId: '8201250670', isDm: true })
    expect(name).toBeUndefined()
  })
})

describe('resolvePersonName — chat scoping', () => {
  const { directory } = buildPersonDirectory([LISA])

  it('DM: always resolves (the chat IS the sender)', () => {
    const name = resolvePersonName(directory, { telegramId: '8201250670', isDm: true })
    expect(name).toBe('Lisa')
  })

  it('group: resolves when the sender is present in that chat\'s allowFrom', () => {
    const name = resolvePersonName(directory, {
      telegramId: '8201250670',
      isDm: false,
      groupAllowFrom: ['8201250670', '111'],
    })
    expect(name).toBe('Lisa')
  })

  it('group: does NOT resolve when allowFrom is empty/unset (can\'t confirm membership)', () => {
    expect(resolvePersonName(directory, { telegramId: '8201250670', isDm: false })).toBeUndefined()
    expect(resolvePersonName(directory, { telegramId: '8201250670', isDm: false, groupAllowFrom: [] })).toBeUndefined()
  })

  it('group: does NOT resolve when the sender is absent from that group\'s allowFrom (a name safe in a DM is not broadcast elsewhere)', () => {
    const name = resolvePersonName(directory, {
      telegramId: '8201250670',
      isDm: false,
      groupAllowFrom: ['111'], // some other member, not lisa
    })
    expect(name).toBeUndefined()
  })

  it('group: resolves via username when username (not id) is in allowFrom', () => {
    const { directory: dir2 } = buildPersonDirectory([KEN])
    const name = resolvePersonName(dir2, {
      telegramId: '999999',
      username: 'mekenthompson',
      isDm: false,
      groupAllowFrom: ['mekenthompson'],
    })
    expect(name).toBe('Ken')
  })
})

describe('safeResolvePersonName — fail-open call-site wrapper used by handleInbound', () => {
  it('happy path: resolves same as resolvePersonName when nothing throws', () => {
    const { directory } = buildPersonDirectory([LISA])
    const name = safeResolvePersonName(directory, { telegramId: '8201250670', isDm: true }, 'raw-fallback')
    expect(name).toBe('Lisa')
  })

  it('unresolved id: falls back to the raw id/username, same as today\'s behavior', () => {
    const { directory } = buildPersonDirectory([LISA])
    const name = safeResolvePersonName(directory, { telegramId: '000', isDm: true }, 'raw-fallback')
    expect(name).toBe('raw-fallback')
  })

  it('resolution throwing (e.g. a malformed opts shape at the call site) is swallowed — falls back to the raw id/username instead of propagating and aborting handleInbound', () => {
    const { directory } = buildPersonDirectory([LISA])
    // Force resolvePersonName's internal normalizeTelegramKey to throw by
    // passing a non-string telegramId past the type system, simulating an
    // unexpected runtime shape from the Telegram payload.
    const name = safeResolvePersonName(
      directory,
      { telegramId: undefined as unknown as string, isDm: true },
      'raw-fallback',
    )
    expect(name).toBe('raw-fallback')
  })

  it('a directory whose lookup throws is also swallowed, not propagated', () => {
    const throwingDirectory: PersonDirectory = {
      byTelegramKey: new Proxy(
        {},
        {
          get() {
            throw new Error('boom: directory lookup exploded')
          },
        },
      ),
    }
    const spy = vi.fn()
    try {
      const name = safeResolvePersonName(throwingDirectory, { telegramId: '8201250670', isDm: true }, 'raw-fallback')
      expect(name).toBe('raw-fallback')
    } catch (err) {
      spy(err)
    }
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('runPersonDirectoryBootCheck — one-time boot validation + alerting', () => {
  it('happy path: no alert, directory populated', () => {
    const result = runPersonDirectoryBootCheck(() => [LISA, KEN])
    expect(result.alertDetail).toBeNull()
    expect(result.directory.byTelegramKey['8201250670']?.personId).toBe('Lisa')
    expect(result.logLine).toMatch(/boot validation ok/)
  })

  it('no entries configured: no alert (this is not an error)', () => {
    const result = runPersonDirectoryBootCheck(() => [])
    expect(result.alertDetail).toBeNull()
    expect(result.directory.byTelegramKey).toEqual({})
  })

  it('dropped entry at boot fires an alert (routes through the caller\'s fleet-alert path) and still resolves the good entries', () => {
    const bad: RawPersonEntry = { key: 'ghost', person_id: '', telegram_ids: ['1'] }
    const result = runPersonDirectoryBootCheck(() => [LISA, bad])
    expect(result.alertDetail).not.toBeNull()
    expect(result.alertDetail).toContain('dropped 1')
    expect(result.alertDetail).toContain('ghost')
    expect(result.directory.byTelegramKey['8201250670']?.personId).toBe('Lisa')
  })

  it('dead-man\'s-switch: readEntries throwing is caught, reported via alertDetail, and PERSON_DIRECTORY falls back to empty (fail-open)', () => {
    const result = runPersonDirectoryBootCheck(() => {
      throw new Error('disk read exploded')
    })
    expect(result.alertDetail).not.toBeNull()
    expect(result.alertDetail).toContain('crashed')
    expect(result.alertDetail).toContain('disk read exploded')
    expect(result.directory.byTelegramKey).toEqual({})
    expect(result.logLine).toContain('CRASHED')
  })
})
