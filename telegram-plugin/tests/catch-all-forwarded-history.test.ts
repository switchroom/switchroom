/**
 * Outcome regression for the forwarded-message history row (#3300 / #3162).
 *
 * SCOPE (honest): this suite pins the PERSISTENCE leg of the end-to-end
 * chain — `parseForwardOrigin` (#3162) feeding `recordInbound` against the
 * real bun:sqlite history store. The ROUTING leg (an update reaching the
 * pipeline at all — the layer where the 2026-07-16 silent drop happened) is
 * pinned by `catch-all-unhandled-message.test.ts`, which drives the real
 * production catch-all module on a real grammy composer. Together the two
 * suites cover the chain; this one alone also passes on pre-#3300 code
 * because #3162's persistence was always correct — it was simply never
 * reached for the dropped message.
 *
 * Runs under bun (history.ts uses bun:sqlite; gateway.ts itself is a
 * side-effecting module that cannot be imported into a test).
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  initHistory,
  recordInbound,
  query as queryHistory,
  _resetForTests as resetHistory,
} from '../history.js'
import { parseForwardOrigin } from '../gateway/forward-origin.js'

let stateDir: string

beforeEach(() => {
  resetHistory()
  stateDir = mkdtempSync(join(tmpdir(), 'catch-all-forward-'))
  initHistory(stateDir, 0) // 0 disables the init-time prune so we can seed cleanly
})

afterEach(() => {
  resetHistory()
  rmSync(stateDir, { recursive: true, force: true })
})

describe('(a) a forwarded plain-text message records a history row with forwarded_from', () => {
  it('parses the server-stamped forward_origin and persists forwarded_from', () => {
    const chat_id = '777'
    const message_id = 8100
    // Telegram Bot API 7.0 forward_origin, server-stamped (untrusted body,
    // trusted attrs) — a plain-text message forwarded from a user.
    const forwardOrigin = parseForwardOrigin({
      type: 'user',
      date: 1_700_000_000,
      sender_user: { id: 424242, is_bot: false, first_name: 'Alice', last_name: 'Example' },
    })
    expect(forwardOrigin).toBeDefined()
    expect(forwardOrigin!.name).toBe('Alice Example')

    recordInbound({
      chat_id,
      thread_id: null,
      message_id,
      user: 'ken',
      user_id: '777',
      ts: 1_700_000_100,
      text: 'here is the brief I forwarded',
      forwarded_from: forwardOrigin!.name,
      forwarded_from_type: forwardOrigin!.type,
      forwarded_from_id: forwardOrigin!.id != null ? String(forwardOrigin!.id) : null,
    })

    const rows = queryHistory({ chat_id, limit: 10 })
    expect(rows).toHaveLength(1)
    const row = rows[0]
    // A delivered turn is present (the message was NOT dropped) AND carries
    // forwarded provenance.
    expect(row.role).toBe('user')
    expect(row.text).toBe('here is the brief I forwarded')
    expect(row.forwarded_from).toBe('Alice Example')
    expect(row.forwarded_from_type).toBe('user')
    expect(row.forwarded_from_id).toBe('424242')
  })

  it('a non-forwarded message leaves forwarded_from NULL (no false provenance)', () => {
    const chat_id = '778'
    // undefined forward_origin → parseForwardOrigin returns undefined.
    const forwardOrigin = parseForwardOrigin(undefined)
    expect(forwardOrigin).toBeUndefined()

    recordInbound({
      chat_id,
      thread_id: null,
      message_id: 8200,
      user: 'ken',
      user_id: '778',
      ts: 1_700_000_200,
      text: 'a normal message',
      forwarded_from: forwardOrigin ?? null,
    })

    const rows = queryHistory({ chat_id, limit: 10 })
    expect(rows).toHaveLength(1)
    expect(rows[0].forwarded_from).toBeNull()
  })
})
