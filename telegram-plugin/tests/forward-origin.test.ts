/**
 * Unit tests for the forwarded-message origin helpers
 * (telegram-plugin/gateway/forward-origin.ts).
 *
 * These pin the pure pieces of the forward-origin metadata path that live
 * outside gateway.ts so they can be exercised without loadAccess()/IPC:
 *   1. parseForwardOrigin — all four Bot API 7.0 origin shapes, missing
 *      fields, hostile (attacker-controlled) names, hidden_user marking.
 *   2. buildForwardOriginMeta — fixed attribute order, XML escaping at the
 *      channel-meta boundary, numbered `_2..` siblings for multi-origin
 *      bursts (same convention as image_path_2 / attachment_file_id_2).
 *   3. dedupeForwardOrigins — the coalescer's burst collapse: a
 *      single-origin album emits one attr set; distinct origins keep
 *      arrival order and get numbered.
 *
 * Trust model under test: origin info rides the ATTRS lane only, names are
 * truncated + escaped (they're attacker-controlled), and hidden_user is
 * explicitly marked so agents don't treat a self-reported display name as
 * an authenticated identity.
 */

import { describe, expect, it } from 'vitest'
import type { MessageOrigin } from 'grammy/types'
import {
  parseForwardOrigin,
  buildForwardOriginMeta,
  dedupeForwardOrigins,
  forwardOriginKey,
  forwardOriginDateIso,
  FORWARDED_FROM_NAME_MAX,
  type ForwardOriginInfo,
} from '../gateway/forward-origin.js'
import { fmtLocalStamp, resolveEnvTimezone } from '../shared/local-time.js'

// Synthetic fixtures only — no real Telegram ids/names (check-no-pii-secrets).
const DATE = 1750000000 // unix seconds
// switchroom #tz-fix: forwarded_date is now the agent's LOCAL am/pm wall clock
// (NOT UTC ISO), so it can't compete with the local-time hint. Compute the
// expected value through the SAME helper production uses, so the assertion is
// deterministic under whatever TZ the runner env carries.
const DATE_LOCAL = fmtLocalStamp(DATE * 1000, resolveEnvTimezone())

function userOrigin(overrides: Partial<{
  first_name: string
  last_name?: string
  username?: string
  id: number
}> = {}): MessageOrigin {
  return {
    type: 'user',
    date: DATE,
    sender_user: {
      id: 42,
      is_bot: false,
      first_name: 'Ada',
      last_name: 'Lovelace',
      username: 'adalove',
      ...overrides,
    },
  }
}

describe('parseForwardOrigin — the four origin shapes', () => {
  it('user: first + last name plus (@username), id and date captured', () => {
    const info = parseForwardOrigin(userOrigin())
    expect(info).toEqual({
      name: 'Ada Lovelace (@adalove)',
      type: 'user',
      id: 42,
      date: DATE,
    })
  })

  it('user: first name only, no username', () => {
    const info = parseForwardOrigin(userOrigin({ last_name: undefined, username: undefined }))
    expect(info?.name).toBe('Ada')
    expect(info?.id).toBe(42)
  })

  it('hidden_user: self-reported name, marked hidden_user, NO id', () => {
    const info = parseForwardOrigin({
      type: 'hidden_user',
      date: DATE,
      sender_user_name: 'Mystery Sender',
    })
    expect(info).toEqual({
      name: 'Mystery Sender',
      type: 'hidden_user',
      date: DATE,
    })
    // The whole point of the type marker: no verifiable id exists.
    expect(info?.id).toBeUndefined()
  })

  it('chat: sender_chat title plus (@username)', () => {
    const info = parseForwardOrigin({
      type: 'chat',
      date: DATE,
      sender_chat: { id: -100200300, type: 'supergroup', title: 'Ops Room', username: 'opsroom' } as never,
    })
    expect(info).toEqual({
      name: 'Ops Room (@opsroom)',
      type: 'chat',
      id: -100200300,
      date: DATE,
    })
  })

  it('channel: chat.title plus (@username), message_id captured', () => {
    const info = parseForwardOrigin({
      type: 'channel',
      date: DATE,
      message_id: 555,
      chat: { id: -100400500, type: 'channel', title: 'Release Notes', username: 'relnotes' } as never,
    })
    expect(info).toEqual({
      name: 'Release Notes (@relnotes)',
      type: 'channel',
      id: -100400500,
      date: DATE,
      messageId: 555,
    })
  })
})

describe('parseForwardOrigin — missing / malformed fields', () => {
  it('returns undefined for a non-forwarded message (no origin)', () => {
    expect(parseForwardOrigin(undefined)).toBeUndefined()
  })

  it('returns undefined for an unknown future origin type', () => {
    expect(parseForwardOrigin({ type: 'giveaway', date: DATE } as never)).toBeUndefined()
  })

  it('user origin without sender_user is dropped', () => {
    expect(parseForwardOrigin({ type: 'user', date: DATE } as never)).toBeUndefined()
  })

  it('hidden_user with an empty name is dropped (nothing to show)', () => {
    expect(
      parseForwardOrigin({ type: 'hidden_user', date: DATE, sender_user_name: '' }),
    ).toBeUndefined()
  })

  it('user with no printable name falls back to the numeric id as name', () => {
    const info = parseForwardOrigin({
      type: 'user',
      date: DATE,
      sender_user: { id: 42, is_bot: false, first_name: '' },
    })
    expect(info).toEqual({ name: '42', type: 'user', id: 42, date: DATE })
  })

  it('missing date yields no date (and later no forwarded_date attr)', () => {
    const info = parseForwardOrigin({
      type: 'hidden_user',
      sender_user_name: 'Mystery Sender',
    } as never)
    expect(info?.date).toBeUndefined()
    expect(buildForwardOriginMeta([info!]).forwarded_date).toBeUndefined()
    expect(forwardOriginDateIso(info)).toBeNull()
  })

  it('channel origin without a title falls back to first/last name shape, then id', () => {
    const noName = parseForwardOrigin({
      type: 'channel',
      date: DATE,
      message_id: 9,
      chat: { id: -100777888, type: 'channel' } as never,
    })
    expect(noName).toEqual({
      name: '-100777888',
      type: 'channel',
      id: -100777888,
      date: DATE,
      messageId: 9,
    })
  })
})

describe('parseForwardOrigin — hostile names (attacker-controlled)', () => {
  it('truncates a 4KB name to the cap (raw, ellipsis-terminated)', () => {
    const bomb = 'x'.repeat(4096)
    const info = parseForwardOrigin(userOrigin({ first_name: bomb, last_name: undefined, username: undefined }))
    expect(info?.name).toHaveLength(FORWARDED_FROM_NAME_MAX)
    expect(info?.name?.endsWith('…')).toBe(true)
  })

  it('keeps XML metacharacters RAW in the parsed record (SQLite lane)', () => {
    const info = parseForwardOrigin(
      userOrigin({ first_name: '<b>"Bob"&\'friends\'</b>', last_name: undefined, username: undefined }),
    )
    // Escaping happens at the channel-meta boundary, not at parse time —
    // the history buffer stores what the user actually saw.
    expect(info?.name).toBe('<b>"Bob"&\'friends\'</b>')
  })
})

describe('buildForwardOriginMeta — channel-tag attrs', () => {
  it('single origin: bare keys in the fixed order name, type, id, date', () => {
    const meta = buildForwardOriginMeta([parseForwardOrigin(userOrigin())!])
    expect(Object.keys(meta)).toEqual([
      'forwarded_from',
      'forwarded_from_type',
      'forwarded_from_id',
      'forwarded_date',
    ])
    expect(meta).toEqual({
      forwarded_from: 'Ada Lovelace (@adalove)',
      forwarded_from_type: 'user',
      forwarded_from_id: '42',
      forwarded_date: DATE_LOCAL,
    })
  })

  it('id-less origin (hidden_user) omits forwarded_from_id entirely', () => {
    const meta = buildForwardOriginMeta([
      { name: 'Mystery Sender', type: 'hidden_user', date: DATE },
    ])
    expect(Object.keys(meta)).toEqual([
      'forwarded_from',
      'forwarded_from_type',
      'forwarded_date',
    ])
    expect(meta.forwarded_from_type).toBe('hidden_user')
  })

  it('XML-escapes hostile names — the rendered attribute value cannot break out', () => {
    const meta = buildForwardOriginMeta([
      { name: '<script>"a"&\'b\'</script>', type: 'user', id: 42, date: DATE },
    ])
    expect(meta.forwarded_from).toBe(
      '&lt;script&gt;&quot;a&quot;&amp;&apos;b&apos;&lt;/script&gt;',
    )
    // Outcome assertion: rendered into a channel tag, the value carries no
    // raw quote/angle characters that could terminate the attribute.
    const rendered = `<channel source="telegram" forwarded_from="${meta.forwarded_from}">`
    expect(rendered).not.toMatch(/forwarded_from="[^"]*[<>][^"]*"/)
    expect((rendered.match(/"/g) ?? []).length).toBe(4) // only the delimiters
  })

  it('defense in depth: a name that skipped parse-time truncation is capped here too', () => {
    const meta = buildForwardOriginMeta([
      { name: 'y'.repeat(4096), type: 'user', id: 42, date: DATE },
    ])
    // 99 chars + '…' — no 4KB payload reaches the tag.
    expect(meta.forwarded_from).toHaveLength(FORWARDED_FROM_NAME_MAX)
  })

  it('no origins → empty record (no attrs on a normal message)', () => {
    expect(buildForwardOriginMeta([])).toEqual({})
  })

  // switchroom #tz-fix (deterministic outcome): under a real configured zone
  // the forwarded_date the MODEL sees is LOCAL am/pm with NO "UTC" / trailing-Z.
  it('renders forwarded_date as LOCAL am/pm — never a UTC ISO string', () => {
    const prevTz = process.env.SWITCHROOM_TIMEZONE
    const prevTZ = process.env.TZ
    process.env.SWITCHROOM_TIMEZONE = 'Australia/Melbourne'
    delete process.env.TZ
    try {
      const meta = buildForwardOriginMeta([{ name: 'Ada', type: 'user', id: 42, date: DATE }])
      const d = meta.forwarded_date!
      // e.g. "Sunday 2025-06-15 08:26 PM AEST" — weekday, ISO date, am/pm, abbrev.
      expect(d).toMatch(/ (?:AM|PM) [A-Za-z]{2,5}$/)
      expect(d).not.toContain('UTC')
      expect(d.endsWith('Z')).toBe(false)
    } finally {
      if (prevTz === undefined) delete process.env.SWITCHROOM_TIMEZONE
      else process.env.SWITCHROOM_TIMEZONE = prevTz
      if (prevTZ === undefined) delete process.env.TZ
      else process.env.TZ = prevTZ
    }
  })
})

describe('coalesced bursts — dedupe + numbered siblings', () => {
  const alice: ForwardOriginInfo = { name: 'Alice Q (@aliceq)', type: 'user', id: 42, date: DATE }
  const relnotes: ForwardOriginInfo = {
    name: 'Release Notes (@relnotes)',
    type: 'channel',
    id: -100400500,
    date: DATE + 60,
    messageId: 7,
  }

  it('single-origin album (N parts, one sender) collapses to ONE attr set', () => {
    const origins = dedupeForwardOrigins([alice, { ...alice, date: DATE + 5 }, { ...alice, date: DATE + 9 }])
    expect(origins).toHaveLength(1)
    const meta = buildForwardOriginMeta(origins)
    expect(meta.forwarded_from).toBe('Alice Q (@aliceq)')
    expect(meta.forwarded_from_2).toBeUndefined()
    // First occurrence wins — the emitted date is the first part's.
    expect(meta.forwarded_date).toBe(DATE_LOCAL)
  })

  it('multi-origin burst: first origin bare, second gets _2 keys in order', () => {
    const meta = buildForwardOriginMeta(dedupeForwardOrigins([alice, relnotes]))
    expect(Object.keys(meta)).toEqual([
      'forwarded_from',
      'forwarded_from_type',
      'forwarded_from_id',
      'forwarded_date',
      'forwarded_from_2',
      'forwarded_from_type_2',
      'forwarded_from_id_2',
      'forwarded_date_2',
    ])
    expect(meta.forwarded_from_2).toBe('Release Notes (@relnotes)')
    expect(meta.forwarded_from_type_2).toBe('channel')
    expect(meta.forwarded_from_id_2).toBe('-100400500')
  })

  it('non-forwarded entries in the burst are skipped', () => {
    expect(dedupeForwardOrigins([undefined, alice, undefined])).toEqual([alice])
    expect(dedupeForwardOrigins([undefined, undefined])).toEqual([])
  })

  it('id-less origins dedupe by name; same type+id dedupes despite name drift', () => {
    const hidden: ForwardOriginInfo = { name: 'Mystery Sender', type: 'hidden_user', date: DATE }
    expect(dedupeForwardOrigins([hidden, { ...hidden, date: DATE + 3 }])).toHaveLength(1)
    // Same user id, renamed mid-burst — still one origin.
    expect(dedupeForwardOrigins([alice, { ...alice, name: 'Alice Renamed' }])).toHaveLength(1)
    // Same numeric id but different type stays distinct.
    expect(forwardOriginKey(alice)).not.toBe(forwardOriginKey({ ...alice, type: 'chat' }))
  })

  it('arrival order is preserved across three distinct origins', () => {
    const hidden: ForwardOriginInfo = { name: 'Mystery Sender', type: 'hidden_user', date: DATE }
    const meta = buildForwardOriginMeta(dedupeForwardOrigins([relnotes, hidden, alice]))
    expect(meta.forwarded_from).toBe('Release Notes (@relnotes)')
    expect(meta.forwarded_from_2).toBe('Mystery Sender')
    expect(meta.forwarded_from_3).toBe('Alice Q (@aliceq)')
    expect(meta.forwarded_from_type_3).toBe('user')
  })
})
