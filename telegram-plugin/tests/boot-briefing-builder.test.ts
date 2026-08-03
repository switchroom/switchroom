/**
 * Outcome tests for the gateway boot briefing
 * (`session_continuity.briefing: gateway`).
 *
 * Runs under `bun test` (vitest-excluded): the collector is exercised
 * against the REAL history schema — rows are seeded through history.ts's
 * own writers (`recordInbound` / `recordOutbound`) into a real bun:sqlite
 * DB, so the surface-scoping SQL is proven against the production table,
 * not a hand-rolled fixture schema.
 *
 * What must be provable here (each test would fail on the bug it guards):
 *   - surface scoping: DM vs forum-topic selection, primary-vs-secondary
 *   - the 48h activity window and the 15-message primary depth
 *   - the hard character budget (newest kept, oldest dropped)
 *   - per-message truncation
 *   - resume-inbound dedup (interrupted-turn window elided, only on the
 *     resumed surface)
 *   - SQLITE_BUSY / any DB failure → EMPTY briefing, never a throw
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  initHistory,
  recordInbound,
  recordOutbound,
  getHistoryDbForBriefing,
  _resetForTests,
} from '../history.js'
import {
  BRIEFING_CHAR_BUDGET,
  BRIEFING_PER_MESSAGE_MAX_CHARS,
  BRIEFING_PRIMARY_DEPTH,
  BOOT_BRIEFING_SOURCE,
  buildBootBriefingInbound,
  collectBriefingSurfaces,
  decideBootBriefing,
  excludeWindowFromResumeInbound,
  readRestartBreadcrumb,
  renderBootBriefing,
  type BriefingDb,
} from '../gateway/boot-briefing-builder.js'
import { maybeQueueBootBriefing } from '../gateway/boot-briefing-wiring.js'
import { spoolId } from '../gateway/inbound-spool.js'
import type { InboundMessage } from '../gateway/ipc-protocol.js'

let stateDir: string
let msgId = 0

const NOW_MS = 1_754_000_000_000 // fixed "now" (ms)
const NOW_SEC = Math.floor(NOW_MS / 1000)
const HOUR = 3600

/** Seed one user-inbound row at `ageSec` seconds before NOW. */
function seedUser(
  chat: string,
  thread: number | null,
  ageSec: number,
  text: string,
  user = 'ken',
): void {
  recordInbound({
    chat_id: chat,
    thread_id: thread,
    message_id: ++msgId,
    user,
    user_id: '1',
    ts: NOW_SEC - ageSec,
    text,
  })
}

/** Seed one assistant-outbound row at `ageSec` seconds before NOW. */
function seedBot(chat: string, thread: number | null, ageSec: number, text: string): void {
  recordOutbound({
    chat_id: chat,
    thread_id: thread,
    message_ids: [++msgId],
    texts: [text],
    ts: NOW_SEC - ageSec,
  })
}

function db(): BriefingDb {
  const h = getHistoryDbForBriefing()
  if (h == null) throw new Error('history not initialised')
  return h
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'boot-briefing-test-'))
  initHistory(stateDir, 0)
  msgId = 0
})

afterEach(() => {
  _resetForTests()
  if (existsSync(stateDir)) rmSync(stateDir, { recursive: true, force: true })
})

describe('collectBriefingSurfaces — surface scoping', () => {
  it('DM shape: one full-depth section per chat, most-recent chat primary, other chat header-only', () => {
    seedUser('111', null, 5 * HOUR, 'older chat question')
    seedBot('111', null, 5 * HOUR - 60, 'older chat answer')
    seedUser('222', null, 2 * HOUR, 'recent chat question')
    seedBot('222', null, 2 * HOUR - 60, 'recent chat answer')

    const surfaces = collectBriefingSurfaces(db(), { nowMs: NOW_MS })
    expect(surfaces.length).toBe(2)
    // Primary = the most-recently-active surface, at full depth.
    expect(surfaces[0]!.chatId).toBe('222')
    expect(surfaces[0]!.threadId).toBeNull()
    expect(surfaces[0]!.messages.map((m) => m.text)).toEqual([
      'recent chat question',
      'recent chat answer',
    ])
    // Secondary = last message only.
    expect(surfaces[1]!.chatId).toBe('111')
    expect(surfaces[1]!.messages.length).toBe(1)
    expect(surfaces[1]!.messages[0]!.text).toBe('older chat answer')
  })

  it('forum shape: groups by (chat, thread); primary topic full depth, sibling topic secondary, DM-root separate', () => {
    seedUser('999', 10, 1 * HOUR, 'topic-10 latest ask')
    seedUser('999', 20, 3 * HOUR, 'topic-20 ask')
    seedUser('999', null, 6 * HOUR, 'general (no topic) ask')

    const surfaces = collectBriefingSurfaces(db(), { nowMs: NOW_MS })
    expect(surfaces.map((s) => [s.chatId, s.threadId])).toEqual([
      ['999', 10],
      ['999', 20],
      ['999', null],
    ])
    // Topic scoping is real: topic-10's messages never contain topic-20's.
    expect(surfaces[0]!.messages.map((m) => m.text)).toEqual(['topic-10 latest ask'])
  })

  it('caps the primary section at the depth bound (15), keeping the NEWEST oldest-first', () => {
    for (let i = 0; i < 25; i++) {
      // msg-0 is oldest (25h... no: ages 25..1 minutes)
      seedUser('42', null, (25 - i) * 60, `msg-${i}`)
    }
    const surfaces = collectBriefingSurfaces(db(), { nowMs: NOW_MS })
    expect(surfaces.length).toBe(1)
    const texts = surfaces[0]!.messages.map((m) => m.text)
    expect(texts.length).toBe(BRIEFING_PRIMARY_DEPTH)
    // Newest 15 (msg-10..msg-24), oldest-first.
    expect(texts[0]).toBe('msg-10')
    expect(texts[texts.length - 1]).toBe('msg-24')
  })

  it('excludes surfaces with no activity inside the 48h window', () => {
    seedUser('act', null, 47 * HOUR, 'inside window')
    seedUser('stale', null, 49 * HOUR, 'outside window')
    const surfaces = collectBriefingSurfaces(db(), { nowMs: NOW_MS })
    expect(surfaces.map((s) => s.chatId)).toEqual(['act'])
  })

  it('elides messages covered by the resume inbound window — on that surface only', () => {
    const interruptStartMs = NOW_MS - 30 * 60 * 1000 // turn started 30 min ago
    seedUser('77', null, 2 * HOUR, 'before the interrupted turn')
    seedUser('77', null, 10 * 60, 'the interrupted request itself') // inside window
    seedUser('88', null, 10 * 60, 'unrelated chat, same recency')

    const surfaces = collectBriefingSurfaces(db(), {
      nowMs: NOW_MS,
      exclude: { chatId: '77', threadId: null, sinceMs: interruptStartMs },
    })
    const s77 = surfaces.find((s) => s.chatId === '77')!
    const s88 = surfaces.find((s) => s.chatId === '88')!
    // The resumed turn's own message is elided (the resume inbound already
    // carries it); the earlier context survives.
    expect(s77.messages.map((m) => m.text)).toEqual(['before the interrupted turn'])
    // The unrelated surface is untouched by the window.
    expect(s88.messages.map((m) => m.text)).toEqual(['unrelated chat, same recency'])
  })

  it('drops a surface entirely when the resume window elides all of it', () => {
    seedUser('55', null, 10 * 60, 'only message, inside the resume window')
    const surfaces = collectBriefingSurfaces(db(), {
      nowMs: NOW_MS,
      exclude: { chatId: '55', threadId: null, sinceMs: NOW_MS - 30 * 60 * 1000 },
    })
    expect(surfaces).toEqual([])
  })

  it('returns [] (never throws) on SQLITE_BUSY / any DB failure', () => {
    const busyDb: BriefingDb = {
      prepare() {
        throw new Error('SQLITE_BUSY: database is locked')
      },
    }
    expect(collectBriefingSurfaces(busyDb, { nowMs: NOW_MS })).toEqual([])
    const busyAll: BriefingDb = {
      prepare: () => ({
        all() {
          throw new Error('SQLITE_BUSY: database is locked')
        },
      }),
    }
    expect(collectBriefingSurfaces(busyAll, { nowMs: NOW_MS })).toEqual([])
  })
})

describe('renderBootBriefing — bounds', () => {
  it('renders nothing for no surfaces', () => {
    expect(renderBootBriefing([], { nowMs: NOW_MS })).toBe('')
  })

  it('never exceeds the character budget, dropping OLDEST primary messages first', () => {
    for (let i = 0; i < 15; i++) {
      seedUser('9', null, (15 - i) * 60, `padding-${i} ` + 'x'.repeat(380))
    }
    const surfaces = collectBriefingSurfaces(db(), { nowMs: NOW_MS })
    // Default bounds hold: 15 truncated messages + header fit the budget.
    const full = renderBootBriefing(surfaces, { nowMs: NOW_MS })
    expect(full.length).toBeGreaterThan(0)
    expect(full.length).toBeLessThanOrEqual(BRIEFING_CHAR_BUDGET)
    // Cap enforcement: with a tighter budget the render must trim the
    // OLDEST primary messages first and never exceed the cap.
    const tight = renderBootBriefing(surfaces, { nowMs: NOW_MS, charBudget: 3000 })
    expect(tight.length).toBeGreaterThan(0)
    expect(tight.length).toBeLessThanOrEqual(3000)
    expect(tight).toContain('padding-14') // newest kept
    expect(tight).not.toContain('padding-0 ') // oldest dropped
  })

  it('truncates each message to the per-message bound', () => {
    seedUser('9', null, 60, 'HEAD-' + 'y'.repeat(2000))
    const surfaces = collectBriefingSurfaces(db(), { nowMs: NOW_MS })
    const text = renderBootBriefing(surfaces, { nowMs: NOW_MS })
    const line = text.split('\n').find((l) => l.includes('HEAD-'))!
    expect(line.length).toBeLessThanOrEqual(BRIEFING_PER_MESSAGE_MAX_CHARS + 40) // + prefix/label
    expect(line.endsWith('…')).toBe(true)
  })

  it('renders secondary surfaces as a header + last-message preview and folds in the restart reason', () => {
    seedUser('1', null, 30 * 60, 'primary talk')
    seedUser('2', 7, 5 * HOUR, 'secondary topic message')
    const surfaces = collectBriefingSurfaces(db(), { nowMs: NOW_MS })
    const text = renderBootBriefing(surfaces, { nowMs: NOW_MS, restartReason: 'sigterm' })
    expect(text).toContain('## Active conversation — chat 1')
    expect(text).toContain('## Other recent surfaces')
    expect(text).toContain('chat 2, topic 7')
    expect(text).toContain('secondary topic message')
    expect(text).toContain('ended via: sigterm')
    // Loop-guard contract: the briefing turn must classify as a synthetic
    // boot turn if it is itself interrupted.
    expect(text.startsWith('You just restarted.')).toBe(true)
  })
})

describe('decideBootBriefing — feature flag and suppression', () => {
  const base = { briefingMode: 'gateway', resumeMode: 'handoff', forceFreshMarker: false }
  it('defaults to legacy (no briefing) unless the flag opts in', () => {
    expect(decideBootBriefing({ ...base, briefingMode: undefined }).build).toBe(false)
    expect(decideBootBriefing({ ...base, briefingMode: 'legacy' }).build).toBe(false)
    expect(decideBootBriefing(base).build).toBe(true)
  })
  it('suppresses when --continue/auto may replay the transcript', () => {
    expect(decideBootBriefing({ ...base, resumeMode: 'continue' })).toEqual({
      build: false,
      reason: 'transcript-replay-possible',
    })
    expect(decideBootBriefing({ ...base, resumeMode: 'auto' }).build).toBe(false)
    expect(decideBootBriefing({ ...base, resumeMode: 'none' }).build).toBe(true)
  })
  it('suppresses on a /reset force-fresh boot', () => {
    expect(decideBootBriefing({ ...base, forceFreshMarker: true })).toEqual({
      build: false,
      reason: 'force-fresh',
    })
  })
})

describe('inbound shape + spool dedup', () => {
  it('mints a boot_briefing inbound whose spool id is stable across boots (per chat)', () => {
    const a = buildBootBriefingInbound({ chatId: '5', threadId: null, text: 'brief', nowMs: NOW_MS })
    const b = buildBootBriefingInbound({
      chatId: '5',
      threadId: null,
      text: 'brief again',
      nowMs: NOW_MS + 60_000, // a later boot
    })
    expect(a.meta.source).toBe(BOOT_BRIEFING_SOURCE)
    expect(a.meta.chat_id).toBe('5')
    expect(Number(a.meta.expiresAt)).toBeGreaterThan(NOW_MS)
    // Same spool id despite different synthetic messageIds — a multi-restart
    // sequence collapses to ONE live briefing instead of stacking N.
    expect(spoolId(a)).toBe(spoolId(b))
    expect(spoolId(a)).toBe('s:boot-briefing:5')
  })

  it('derives the resume-dedup window from a resume inbound meta', () => {
    const resumeMsg = {
      type: 'inbound',
      chatId: '77',
      messageId: 1,
      user: 'switchroom',
      userId: 0,
      ts: NOW_MS,
      text: 'You just restarted.',
      meta: {
        source: 'resume_interrupted',
        chat_id: '77',
        message_thread_id: '12',
        started_at: String(NOW_MS - 1000),
      },
    } as InboundMessage
    expect(excludeWindowFromResumeInbound(resumeMsg)).toEqual({
      chatId: '77',
      threadId: 12,
      sinceMs: NOW_MS - 1000,
    })
    expect(excludeWindowFromResumeInbound(null)).toBeNull()
  })
})

describe('readRestartBreadcrumb', () => {
  it('reads the .restart-reason first line, with SWITCHROOM_PENDING_ENDED_VIA overriding', () => {
    const read = () => 'operator restart\nsecond line'
    expect(
      readRestartBreadcrumb({ restartReasonPath: '/x/.restart-reason', env: {}, readFile: read }),
    ).toBe('operator restart')
    expect(
      readRestartBreadcrumb({
        restartReasonPath: '/x/.restart-reason',
        env: { SWITCHROOM_PENDING_ENDED_VIA: 'timeout' },
        readFile: read,
      }),
    ).toBe('timeout')
    expect(
      readRestartBreadcrumb({
        restartReasonPath: '/missing',
        env: {},
        readFile: () => {
          throw new Error('ENOENT')
        },
      }),
    ).toBeNull()
  })
})

describe('maybeQueueBootBriefing — end-to-end wiring', () => {
  function envFor(mode: string): Record<string, string | undefined> {
    return {
      SWITCHROOM_SESSION_BRIEFING: mode,
      SWITCHROOM_RESUME_MODE: 'handoff',
      SWITCHROOM_AGENT_NAME: 'testagent',
    }
  }

  it('queues a briefing built from real history rows when the flag is gateway', () => {
    seedUser('321', null, 30 * 60, 'please review the deploy plan')
    seedBot('321', null, 25 * 60, 'on it — reviewing now')
    const puts: Array<{ agent: string; msg: InboundMessage }> = []
    const queued = maybeQueueBootBriefing({
      env: envFor('gateway'),
      stateDir: join(stateDir, 'telegram'),
      resumeMsg: null,
      put: (agent, msg) => puts.push({ agent, msg }),
      log: () => {},
      nowMs: NOW_MS,
    })
    expect(queued).not.toBeNull()
    expect(puts.length).toBe(1)
    expect(puts[0]!.agent).toBe('testagent')
    expect(puts[0]!.msg.meta.source).toBe('boot_briefing')
    expect(puts[0]!.msg.chatId).toBe('321')
    expect(puts[0]!.msg.text).toContain('please review the deploy plan')
    expect(puts[0]!.msg.text).toContain('on it — reviewing now')
    expect(puts[0]!.msg.text.length).toBeLessThanOrEqual(BRIEFING_CHAR_BUDGET)
  })

  it('queues NOTHING when the flag is legacy (default) — legacy behaviour untouched', () => {
    seedUser('321', null, 30 * 60, 'recent message')
    const puts: unknown[] = []
    const queued = maybeQueueBootBriefing({
      env: envFor('legacy'),
      stateDir: join(stateDir, 'telegram'),
      resumeMsg: null,
      put: (a, m) => puts.push([a, m]),
      log: () => {},
      nowMs: NOW_MS,
    })
    expect(queued).toBeNull()
    expect(puts.length).toBe(0)
  })

  it('queues nothing when history is empty', () => {
    const puts: unknown[] = []
    const queued = maybeQueueBootBriefing({
      env: envFor('gateway'),
      stateDir: join(stateDir, 'telegram'),
      resumeMsg: null,
      put: (a, m) => puts.push([a, m]),
      log: () => {},
      nowMs: NOW_MS,
    })
    expect(queued).toBeNull()
    expect(puts.length).toBe(0)
  })

  it('suppresses on a force-fresh (/reset) marker', () => {
    seedUser('321', null, 30 * 60, 'recent message')
    writeFileSync(join(stateDir, '.force-fresh-session'), '')
    const queued = maybeQueueBootBriefing({
      env: envFor('gateway'),
      stateDir: join(stateDir, 'telegram'),
      resumeMsg: null,
      put: () => {
        throw new Error('must not be called')
      },
      log: () => {},
      nowMs: NOW_MS,
    })
    expect(queued).toBeNull()
  })

  it('suppresses on SWITCHROOM_FORCE_FRESH=1 even when NO marker file exists (env-keyed, race-proof)', () => {
    // The M1 fix: the decision keys on the env snapshot start.sh takes
    // BEFORE forking the gateway, not on fs state at gateway check time. So
    // the /reset boot is suppressed even after the inner pass has already
    // `rm`ed the marker — the exact race the old existsSync check lost.
    seedUser('321', null, 30 * 60, 'recent message')
    expect(existsSync(join(stateDir, '.force-fresh-session'))).toBe(false)
    const queued = maybeQueueBootBriefing({
      env: { ...envFor('gateway'), SWITCHROOM_FORCE_FRESH: '1' },
      stateDir: join(stateDir, 'telegram'),
      resumeMsg: null,
      put: () => {
        throw new Error('must not be called')
      },
      log: () => {},
      nowMs: NOW_MS,
    })
    expect(queued).toBeNull()
  })

  it('suppresses on SWITCHROOM_FORCE_FRESH=1 regardless of whether the marker is present', () => {
    // Outcome does not depend on fs state at check time: with the env set,
    // the briefing is suppressed whether or not the marker file is on disk.
    seedUser('321', null, 30 * 60, 'recent message')
    writeFileSync(join(stateDir, '.force-fresh-session'), '')
    const queued = maybeQueueBootBriefing({
      env: { ...envFor('gateway'), SWITCHROOM_FORCE_FRESH: '1' },
      stateDir: join(stateDir, 'telegram'),
      resumeMsg: null,
      put: () => {
        throw new Error('must not be called')
      },
      log: () => {},
      nowMs: NOW_MS,
    })
    expect(queued).toBeNull()
  })

  it('never throws even when put itself throws', () => {
    seedUser('321', null, 30 * 60, 'recent message')
    expect(() =>
      maybeQueueBootBriefing({
        env: envFor('gateway'),
        stateDir: join(stateDir, 'telegram'),
        resumeMsg: null,
        put: () => {
          throw new Error('spool exploded')
        },
        log: () => {},
        nowMs: NOW_MS,
      }),
    ).not.toThrow()
  })

  it('threads a real resumeMsg end-to-end: elides the interrupted-turn window from the queued briefing on that surface', () => {
    // #4247: every other wiring test passes resumeMsg: null, so the
    // resume-dedup path (interrupted-turn window elided so the boot-resume
    // synthetic and the briefing never double-inject the same messages) was
    // only ever proven at the pure-function level. This drives a real non-null
    // resumeMsg all the way through maybeQueueBootBriefing and asserts the
    // OUTCOME on the queued inbound's text.
    const startedAtMs = NOW_MS - 10 * 60 * 1000 // interrupted turn began 10m ago
    // Surface 321 (the resumed chat): one message BEFORE the interrupted turn
    // (must survive) and one AT/AFTER it (the resume synthetic already covers
    // it — must be elided).
    seedUser('321', null, 30 * 60, 'context from before the interrupted turn')
    seedUser('321', null, 5 * 60, 'the interrupted request itself')
    // Surface 654 (a different chat): same recency window, NOT the resumed
    // surface, so its message must be untouched by the dedup.
    seedUser('654', null, 5 * 60, 'unrelated chat, must remain')
    const resumeMsg = {
      type: 'inbound',
      chatId: '321',
      messageId: 1,
      user: 'switchroom',
      userId: 0,
      ts: NOW_MS,
      text: 'You just restarted — resuming the interrupted turn.',
      meta: {
        source: 'resume_interrupted',
        chat_id: '321',
        started_at: String(startedAtMs),
      },
    } as InboundMessage
    const puts: Array<{ agent: string; msg: InboundMessage }> = []
    const queued = maybeQueueBootBriefing({
      env: envFor('gateway'),
      stateDir: join(stateDir, 'telegram'),
      resumeMsg,
      put: (agent, msg) => puts.push({ agent, msg }),
      log: () => {},
      nowMs: NOW_MS,
    })
    expect(queued).not.toBeNull()
    expect(puts.length).toBe(1)
    const text = puts[0]!.msg.text
    // The pre-interruption message survives; the interrupted request itself is
    // elided (the resume synthetic already re-injects it).
    expect(text).toContain('context from before the interrupted turn')
    expect(text).not.toContain('the interrupted request itself')
    // Dedup is surface-scoped: the unrelated chat is untouched.
    expect(text).toContain('unrelated chat, must remain')
  })
})
