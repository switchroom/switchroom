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
import {
  maybeQueueBootBriefing,
  fetchHindsightRecall,
  readDailyMemory,
} from '../gateway/boot-briefing-wiring.js'
import type { BriefingSurface } from '../gateway/boot-briefing-builder.js'
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

  it('queues a briefing built from real history rows when the flag is gateway', async () => {
    seedUser('321', null, 30 * 60, 'please review the deploy plan')
    seedBot('321', null, 25 * 60, 'on it — reviewing now')
    const puts: Array<{ agent: string; msg: InboundMessage }> = []
    const queued = await maybeQueueBootBriefing({
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

  it('queues NOTHING when the flag is legacy (default) — legacy behaviour untouched', async () => {
    seedUser('321', null, 30 * 60, 'recent message')
    const puts: unknown[] = []
    const queued = await maybeQueueBootBriefing({
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

  it('queues nothing when history is empty', async () => {
    const puts: unknown[] = []
    const queued = await maybeQueueBootBriefing({
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

  it('suppresses on a force-fresh (/reset) marker', async () => {
    seedUser('321', null, 30 * 60, 'recent message')
    writeFileSync(join(stateDir, '.force-fresh-session'), '')
    const queued = await maybeQueueBootBriefing({
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

  it('suppresses on SWITCHROOM_FORCE_FRESH=1 even when NO marker file exists (env-keyed, race-proof)', async () => {
    // The M1 fix: the decision keys on the env snapshot start.sh takes
    // BEFORE forking the gateway, not on fs state at gateway check time. So
    // the /reset boot is suppressed even after the inner pass has already
    // `rm`ed the marker — the exact race the old existsSync check lost.
    seedUser('321', null, 30 * 60, 'recent message')
    expect(existsSync(join(stateDir, '.force-fresh-session'))).toBe(false)
    const queued = await maybeQueueBootBriefing({
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

  it('suppresses on SWITCHROOM_FORCE_FRESH=1 regardless of whether the marker is present', async () => {
    // Outcome does not depend on fs state at check time: with the env set,
    // the briefing is suppressed whether or not the marker file is on disk.
    seedUser('321', null, 30 * 60, 'recent message')
    writeFileSync(join(stateDir, '.force-fresh-session'), '')
    const queued = await maybeQueueBootBriefing({
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

  it('never throws even when put itself throws', async () => {
    seedUser('321', null, 30 * 60, 'recent message')
    // The internal try/catch swallows put's throw — the promise RESOLVES to
    // null rather than rejecting, so boot is never blocked or crashed.
    await expect(
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
    ).resolves.toBeNull()
  })
})

// A minimal primary surface for the pure render tests (no DB needed).
function primarySurface(text = 'the primary ask'): BriefingSurface {
  return {
    chatId: '321',
    threadId: null,
    lastTs: NOW_SEC - 60,
    messages: [{ role: 'user', user: 'ken', ts: NOW_SEC - 60, text }],
  }
}

describe('renderBootBriefing — Hindsight + daily-memory sections (source 2 + 3 parity)', () => {
  it('renders a Hindsight section with `- text (timestamp)` lines mirroring the shell jq', () => {
    const out = renderBootBriefing([primarySurface()], {
      nowMs: NOW_MS,
      hindsight: [
        { text: 'we agreed to ship the gateway briefing', timestamp: '2026-08-01T10:00:00Z' },
        { text: 'no timestamp here', timestamp: null },
      ],
    })
    expect(out).toContain('## Hindsight recall (recent context)')
    expect(out).toContain('- we agreed to ship the gateway briefing (2026-08-01T10:00:00Z)')
    // No dangling ` (…)` when a result has no timestamp.
    expect(out).toContain('- no timestamp here')
    expect(out).not.toContain('no timestamp here (')
  })

  it('renders `(no text)` for a blank Hindsight result (shell `.text // "(no text)"`)', () => {
    const out = renderBootBriefing([primarySurface()], {
      nowMs: NOW_MS,
      hindsight: [{ text: '   ', timestamp: null }],
    })
    expect(out).toContain('- (no text)')
  })

  it('renders a daily-memory section under a dated header', () => {
    const out = renderBootBriefing([primarySurface()], {
      nowMs: NOW_MS,
      dailyMemory: { date: '2026-08-02', content: 'Shipped X. Blocked on Y.' },
    })
    expect(out).toContain("## Today's memory (2026-08-02)")
    expect(out).toContain('Shipped X. Blocked on Y.')
  })

  it('renders NO Hindsight/daily header when both inputs are absent or empty (no empty headers)', () => {
    const noneOut = renderBootBriefing([primarySurface()], { nowMs: NOW_MS })
    expect(noneOut).not.toContain('## Hindsight recall')
    expect(noneOut).not.toContain("## Today's memory")

    const emptyOut = renderBootBriefing([primarySurface()], {
      nowMs: NOW_MS,
      hindsight: [],
      dailyMemory: { date: '2026-08-02', content: '   \n  ' },
    })
    expect(emptyOut).not.toContain('## Hindsight recall')
    expect(emptyOut).not.toContain("## Today's memory")
  })

  it('orders sections telegram → hindsight → daily (mirrors bin/handoff-briefing.sh)', () => {
    const out = renderBootBriefing([primarySurface()], {
      nowMs: NOW_MS,
      hindsight: [{ text: 'recall line', timestamp: null }],
      dailyMemory: { date: '2026-08-02', content: 'daily line' },
    })
    const iPrimary = out.indexOf('the primary ask')
    const iHind = out.indexOf('## Hindsight recall')
    const iDaily = out.indexOf("## Today's memory")
    expect(iPrimary).toBeGreaterThan(-1)
    expect(iHind).toBeGreaterThan(iPrimary)
    expect(iDaily).toBeGreaterThan(iHind)
  })

  it('respects the char budget: an oversized daily memory truncates, never blows the budget', () => {
    const huge = 'x'.repeat(50_000)
    const out = renderBootBriefing([primarySurface()], {
      nowMs: NOW_MS,
      hindsight: [{ text: 'a recall', timestamp: null }],
      dailyMemory: { date: '2026-08-02', content: huge },
      charBudget: BRIEFING_CHAR_BUDGET,
    })
    expect(out.length).toBeLessThanOrEqual(BRIEFING_CHAR_BUDGET)
    // Telegram history keeps priority (present) and the daily section is
    // truncated with an ellipsis rather than dropped or overflowing.
    expect(out).toContain('the primary ask')
    expect(out).toContain("## Today's memory (2026-08-02)")
    expect(out).toContain('…')
  })

  it('respects the char budget for ASTRAL / non-BMP input and never cuts a surrogate pair', () => {
    // Regression: the char budget is a UTF-16 `.length` bound, but the
    // truncators used to measure CODEPOINTS against it — so an astral-plane
    // daily memory (each 😀 is 1 codepoint but 2 UTF-16 units) overflowed the
    // budget nearly 2x. ASCII-only budget tests can't see this.
    const astral = '😀'.repeat(50_000) // 50k codepoints = 100k UTF-16 units
    const out = renderBootBriefing([primarySurface()], {
      nowMs: NOW_MS,
      hindsight: [{ text: 'a short recall', timestamp: null }],
      dailyMemory: { date: '2026-08-02', content: astral },
      charBudget: BRIEFING_CHAR_BUDGET,
    })
    // The module's own asserted invariant: final UTF-16 length within budget.
    expect(out.length).toBeLessThanOrEqual(BRIEFING_CHAR_BUDGET)
    // And the cut must never bisect a surrogate pair (no lone/broken half).
    const hasLoneSurrogate = (s: string): boolean => {
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i)
        if (c >= 0xd800 && c <= 0xdbff) {
          const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0
          if (!(next >= 0xdc00 && next <= 0xdfff)) return true
          i++ // valid pair — skip the low half
        } else if (c >= 0xdc00 && c <= 0xdfff) {
          return true // lone low surrogate
        }
      }
      return false
    }
    expect(hasLoneSurrogate(out)).toBe(false)
    // The daily section is still present (truncated, not dropped).
    expect(out).toContain("## Today's memory (2026-08-02)")
  })

  it('skips a trailing section entirely when there is not even room for a truncated body', () => {
    // Budget large enough for the telegram slice + a small header, but the
    // daily body cannot fit — the section is skipped whole (no dangling
    // header), and the result still respects the budget.
    const base = renderBootBriefing([primarySurface()], { nowMs: NOW_MS })
    const tightBudget = base.length + 20 // room for neither a real hindsight nor daily body
    const out = renderBootBriefing([primarySurface()], {
      nowMs: NOW_MS,
      dailyMemory: { date: '2026-08-02', content: 'x'.repeat(5000) },
      charBudget: tightBudget,
    })
    expect(out.length).toBeLessThanOrEqual(tightBudget)
    expect(out).not.toContain("## Today's memory")
  })
})

describe('fetchHindsightRecall — graceful-skip paths (source 2 wiring)', () => {
  const okBody = {
    results: [
      { text: 'first memory', timestamp: '2026-08-01T00:00:00Z' },
      { text: 'second memory' },
    ],
  }

  function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const liveEnv = {
    HINDSIGHT_API_URL: 'http://hindsight.internal:8080/',
    HINDSIGHT_BANK_ID: 'agent-bank',
  }

  it('mirrors the shell request contract (POST recall URL + {query, max_tokens})', async () => {
    let seenUrl = ''
    let seenInit: RequestInit | undefined
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seenUrl = String(url)
      seenInit = init
      return jsonResponse(200, okBody)
    }) as unknown as typeof fetch
    const results = await fetchHindsightRecall(liveEnv, { fetchImpl })
    // Trailing slash trimmed; the exact recall path the bash script hits.
    expect(seenUrl).toBe('http://hindsight.internal:8080/v1/default/banks/agent-bank/memories/recall')
    expect(seenInit?.method).toBe('POST')
    const parsed = JSON.parse(String(seenInit?.body))
    expect(parsed.query).toBe('what was happening recently in our conversation?')
    expect(parsed.max_tokens).toBe(800)
    expect(results).toEqual([
      { text: 'first memory', timestamp: '2026-08-01T00:00:00Z' },
      { text: 'second memory', timestamp: null },
    ])
  })

  it('returns [] when the env is missing (no HINDSIGHT_API_URL / BANK_ID) — no fetch at all', async () => {
    let called = false
    const fetchImpl = (async () => {
      called = true
      return jsonResponse(200, okBody)
    }) as unknown as typeof fetch
    expect(await fetchHindsightRecall({}, { fetchImpl })).toEqual([])
    expect(await fetchHindsightRecall({ HINDSIGHT_API_URL: 'http://x' }, { fetchImpl })).toEqual([])
    expect(called).toBe(false)
  })

  it('returns [] on a non-200 response (graceful skip, never throws)', async () => {
    const fetchImpl = (async () => jsonResponse(503, { error: 'down' })) as unknown as typeof fetch
    expect(await fetchHindsightRecall(liveEnv, { fetchImpl })).toEqual([])
  })

  it('returns [] on a fetch rejection / timeout (AbortError), never throws', async () => {
    const fetchImpl = (async () => {
      throw new DOMException('aborted', 'AbortError')
    }) as unknown as typeof fetch
    expect(await fetchHindsightRecall(liveEnv, { fetchImpl })).toEqual([])
  })

  it('honours the abort timeout (a slow endpoint yields [] within the budget)', async () => {
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      // Never resolve until aborted — mirrors a hung Hindsight.
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        )
      })
    }) as unknown as typeof fetch
    const start = Date.now()
    const results = await fetchHindsightRecall(liveEnv, { fetchImpl, timeoutMs: 50 })
    expect(results).toEqual([])
    expect(Date.now() - start).toBeLessThan(2000)
  })

  it('returns [] on malformed JSON (results absent / not an array)', async () => {
    const fetchImpl = (async () => jsonResponse(200, { notResults: 1 })) as unknown as typeof fetch
    expect(await fetchHindsightRecall(liveEnv, { fetchImpl })).toEqual([])
  })
})

describe('readDailyMemory — graceful-skip paths (source 3 wiring)', () => {
  // NOW_MS = 1_754_000_000_000 → 2025-07-31/08-01 depending on tz. Compute the
  // expected date the same way the impl does so the assertion can't drift.
  function expectedDate(tz: string): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(NOW_MS))
  }

  it('reads <agentDir>/workspace/memory/<today>.md (correct path, not the shell bug path)', () => {
    const date = expectedDate('UTC')
    let seenPath = ''
    const out = readDailyMemory(
      '/state/agent',
      { SWITCHROOM_TIMEZONE: 'UTC' },
      NOW_MS,
      (p) => {
        seenPath = p
        return '# today\nshipped the parity PR'
      },
    )
    expect(seenPath).toBe(`/state/agent/workspace/memory/${date}.md`)
    expect(out).toEqual({ date, content: '# today\nshipped the parity PR' })
  })

  it('honours an explicit WORKSPACE_DIR override when set', () => {
    const date = expectedDate('UTC')
    let seenPath = ''
    readDailyMemory(
      '/state/agent',
      { SWITCHROOM_TIMEZONE: 'UTC', WORKSPACE_DIR: '/custom/ws' },
      NOW_MS,
      (p) => {
        seenPath = p
        return 'content'
      },
    )
    expect(seenPath).toBe(`/custom/ws/memory/${date}.md`)
  })

  it('derives "today" in the agent LOCAL timezone (not UTC)', () => {
    // A far-eastern zone can be a day ahead of UTC at this instant.
    const dateSydney = expectedDate('Australia/Sydney')
    let seenPath = ''
    readDailyMemory('/a', { SWITCHROOM_TIMEZONE: 'Australia/Sydney' }, NOW_MS, (p) => {
      seenPath = p
      return 'x'
    })
    expect(seenPath).toBe(`/a/workspace/memory/${dateSydney}.md`)
  })

  it('returns null on ENOENT (missing daily file), never throws', () => {
    const out = readDailyMemory('/a', { SWITCHROOM_TIMEZONE: 'UTC' }, NOW_MS, () => {
      const e = new Error('ENOENT') as NodeJS.ErrnoException
      e.code = 'ENOENT'
      throw e
    })
    expect(out).toBeNull()
  })

  it('returns null on an empty / whitespace-only file (no empty section)', () => {
    expect(
      readDailyMemory('/a', { SWITCHROOM_TIMEZONE: 'UTC' }, NOW_MS, () => '   \n\t '),
    ).toBeNull()
  })
})

describe('maybeQueueBootBriefing — end-to-end with Hindsight + daily memory', () => {
  it('folds a live Hindsight recall into the queued briefing (awaited before put)', async () => {
    seedUser('321', null, 30 * 60, 'primary conversation ask')
    const puts: Array<{ agent: string; msg: InboundMessage }> = []
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ results: [{ text: 'we were mid-deploy', timestamp: '2026-08-01T00:00:00Z' }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )) as unknown as typeof fetch
    const queued = await maybeQueueBootBriefing({
      env: {
        SWITCHROOM_SESSION_BRIEFING: 'gateway',
        SWITCHROOM_RESUME_MODE: 'handoff',
        SWITCHROOM_AGENT_NAME: 'testagent',
        HINDSIGHT_API_URL: 'http://hindsight.internal',
        HINDSIGHT_BANK_ID: 'agent-bank',
      },
      stateDir: join(stateDir, 'telegram'),
      resumeMsg: null,
      put: (agent, msg) => puts.push({ agent, msg }),
      log: () => {},
      nowMs: NOW_MS,
      fetchImpl,
    })
    expect(queued).not.toBeNull()
    expect(puts.length).toBe(1)
    // The section is PRESENT in the enqueued text — proving the fetch was
    // awaited to completion before put, not raced in late.
    expect(puts[0]!.msg.text).toContain('## Hindsight recall (recent context)')
    expect(puts[0]!.msg.text).toContain('- we were mid-deploy (2026-08-01T00:00:00Z)')
    expect(puts[0]!.msg.text).toContain('primary conversation ask')
    expect(puts[0]!.msg.text.length).toBeLessThanOrEqual(BRIEFING_CHAR_BUDGET)
  })

  it('still queues (telegram-only) when Hindsight fails and no daily file exists', async () => {
    seedUser('321', null, 30 * 60, 'primary conversation ask')
    const puts: Array<{ agent: string; msg: InboundMessage }> = []
    const fetchImpl = (async () => {
      throw new Error('connection refused')
    }) as unknown as typeof fetch
    const queued = await maybeQueueBootBriefing({
      env: {
        SWITCHROOM_SESSION_BRIEFING: 'gateway',
        SWITCHROOM_RESUME_MODE: 'handoff',
        SWITCHROOM_AGENT_NAME: 'testagent',
        HINDSIGHT_API_URL: 'http://hindsight.internal',
        HINDSIGHT_BANK_ID: 'agent-bank',
      },
      stateDir: join(stateDir, 'telegram'),
      resumeMsg: null,
      put: (agent, msg) => puts.push({ agent, msg }),
      log: () => {},
      nowMs: NOW_MS,
      fetchImpl,
    })
    expect(queued).not.toBeNull()
    expect(puts[0]!.msg.text).toContain('primary conversation ask')
    expect(puts[0]!.msg.text).not.toContain('## Hindsight recall')
    expect(puts[0]!.msg.text).not.toContain("## Today's memory")
  })

  it('does not fetch Hindsight when there is no active surface (no delivery target)', async () => {
    let called = false
    const fetchImpl = (async () => {
      called = true
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    const queued = await maybeQueueBootBriefing({
      env: {
        SWITCHROOM_SESSION_BRIEFING: 'gateway',
        SWITCHROOM_RESUME_MODE: 'handoff',
        SWITCHROOM_AGENT_NAME: 'testagent',
        HINDSIGHT_API_URL: 'http://hindsight.internal',
        HINDSIGHT_BANK_ID: 'agent-bank',
      },
      stateDir: join(stateDir, 'telegram'),
      resumeMsg: null,
      put: () => {
        throw new Error('must not be called')
      },
      log: () => {},
      nowMs: NOW_MS,
      fetchImpl,
    })
    expect(queued).toBeNull()
    expect(called).toBe(false)
  })

  it('threads a real resumeMsg end-to-end: elides the interrupted-turn window from the queued briefing on that surface', async () => {
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
    const queued = await maybeQueueBootBriefing({
      env: {
        SWITCHROOM_SESSION_BRIEFING: 'gateway',
        SWITCHROOM_RESUME_MODE: 'handoff',
        SWITCHROOM_AGENT_NAME: 'testagent',
      },
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

describe('maybeQueueBootBriefing — session-generation guard (#4242)', () => {
  function envGen(bootId?: string): Record<string, string | undefined> {
    return {
      SWITCHROOM_SESSION_BRIEFING: 'gateway',
      SWITCHROOM_RESUME_MODE: 'handoff',
      SWITCHROOM_AGENT_NAME: 'testagent',
      ...(bootId != null ? { SWITCHROOM_GATEWAY_BOOT_ID: bootId } : {}),
    }
  }

  const call = (
    env: Record<string, string | undefined>,
    puts: Array<{ agent: string; msg: InboundMessage }>,
  ) =>
    maybeQueueBootBriefing({
      env,
      stateDir: join(stateDir, 'telegram'),
      resumeMsg: null,
      put: (agent, msg) => puts.push({ agent, msg }),
      log: () => {},
      nowMs: NOW_MS,
    })

  it('re-mints ONCE per boot generation: a supervisor respawn (same boot id) queues nothing', async () => {
    seedUser('321', null, 30 * 60, 'the deploy is half-done')
    const puts: Array<{ agent: string; msg: InboundMessage }> = []

    // Boot-1: first gateway process of this generation briefs.
    const first = await call(envGen('gen-1'), puts)
    expect(first).not.toBeNull()
    expect(puts.length).toBe(1)
    // Generation persisted for the respawn check.
    expect(existsSync(join(stateDir, '.boot-briefing-generation'))).toBe(true)

    // Respawn: same shell → same SWITCHROOM_GATEWAY_BOOT_ID. The gateway
    // module re-evaluates, but the inner Claude session is still live from
    // boot-1 — re-injecting a "you just rebooted" briefing would be wrong.
    const respawn = await call(envGen('gen-1'), puts)
    expect(respawn).toBeNull()
    expect(puts.length).toBe(1) // no second put
  })

  it('a GENUINE new boot (fresh boot id) briefs again', async () => {
    seedUser('321', null, 30 * 60, 'still pending your call')
    const puts: Array<{ agent: string; msg: InboundMessage }> = []

    expect(await call(envGen('gen-1'), puts)).not.toBeNull()
    expect(puts.length).toBe(1)
    // Next real container boot re-derives a different id → not a respawn.
    expect(await call(envGen('gen-2'), puts)).not.toBeNull()
    expect(puts.length).toBe(2)
  })

  it('consumes the generation even when the first boot had nothing to brief (no mid-session brief on respawn)', async () => {
    const puts: Array<{ agent: string; msg: InboundMessage }> = []
    // Boot-1: empty history → nothing queued, but the generation is consumed.
    expect(await call(envGen('gen-1'), puts)).toBeNull()
    expect(puts.length).toBe(0)
    expect(existsSync(join(stateDir, '.boot-briefing-generation'))).toBe(true)

    // Messages arrive AFTER the session is live, then the gateway respawns.
    seedUser('321', null, 5 * 60, 'a message that landed mid-session')
    const respawn = await call(envGen('gen-1'), puts)
    expect(respawn).toBeNull()
    expect(puts.length).toBe(0) // must NOT brief into the live session
  })

  it('guard is inert when SWITCHROOM_GATEWAY_BOOT_ID is absent (non-docker / pre-upgrade start.sh keeps legacy behaviour)', async () => {
    seedUser('321', null, 30 * 60, 'legacy path message')
    const puts: Array<{ agent: string; msg: InboundMessage }> = []
    // With no boot id, every gateway start briefs as before — no marker
    // written, no suppression.
    expect(await call(envGen(undefined), puts)).not.toBeNull()
    expect(await call(envGen(undefined), puts)).not.toBeNull()
    expect(puts.length).toBe(2)
    expect(existsSync(join(stateDir, '.boot-briefing-generation'))).toBe(false)
  })
})
