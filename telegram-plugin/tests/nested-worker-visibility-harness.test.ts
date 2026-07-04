/**
 * Flagship harness for NESTED (depth-2+) sub-agent card visibility — the
 * unified progress-card fix. Mirrors
 * worker-visibility-prose-silent-harness.test.ts: it wires the REAL
 * `startSubagentWatcher` to the REAL `createWorkerActivityFeed` on ONE
 * virtual clock, with a REAL registry DB (bun:sqlite) and REAL files in a
 * tempdir, and mirrors the gateway's onProgress/onFinish routing
 * (resolveWorkerFeedDispatch + resolveSubagentOriginTurnKey).
 *
 * Scenario (the live incident shape): a depth-1 BACKGROUND worker —
 * attributed to its originating turn at dispatch — spawns a nested worker
 * AFTER the main turn has ended. The PreToolUse hook cannot attribute the
 * nested dispatch (turn-active.json is gone) and may lose the row entirely.
 * Pre-fix: the nested card posted, heartbeat-edited every ~6s, and stayed
 * frozen on "starting…" forever, routed to the owner DM.
 *
 * Asserts the required end-state behaviour for the nested permutation:
 *   (a) a registry row EXISTS for the nested worker (watcher-recorded from
 *       the parent's JSONL), keyed so the child's meta.json links it,
 *   (b) the nested card reaches LIVE TOOL ACTIVITY (real steps, climbing
 *       tool count) — never frozen "starting…",
 *   (c) the card routes to the ORIGINATING chat (transitive turn-key
 *       inheritance), not the owner-DM fallback,
 *   (d) clean finalization on turn_end (card edits to done, handle dropped),
 *   (e) parallel-worker isolation: the depth-1 parent's own feed message is
 *       independent of the nested child's (no cross-worker interleaving).
 *
 * bun:sqlite — run under Bun:
 *   bun test telegram-plugin/tests/nested-worker-visibility-harness.test.ts
 */

import { describe, it, expect, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startSubagentWatcher } from '../subagent-watcher.js'
import { createWorkerActivityFeed, type WorkerActivityView } from '../worker-activity-feed.js'
import { openTurnsDbInMemory } from '../registry/turns-schema.js'
import {
  applySubagentsSchema,
  getSubagent,
  getSubagentByJsonlId,
  resolveSubagentOriginTurnKey,
} from '../registry/subagents-schema.js'
import { resolveWorkerFeedDispatch } from '../gateway/worker-feed-dispatch.js'

const OWNER_DM = 'owner-dm-fallback'
const ORIGIN_CHAT = '-1001234567890'
const ORIGIN_TURN_KEY = `${ORIGIN_CHAT}:_:1783202199395`

function jline(o: object): string {
  return JSON.stringify(o) + '\n'
}
function userMsg(text: string): string {
  return jline({ type: 'user', message: { content: [{ type: 'text', text }] } })
}
function toolUse(id: string, name: string, input: Record<string, unknown>): string {
  return jline({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } })
}
function turnEnd(): string {
  return jline({ type: 'system', subtype: 'turn_duration', durationMs: 1234 })
}

interface FakeBot {
  sent: Array<{ chatId: string; text: string }>
  edits: Array<{ chatId: string; messageId: number; text: string }>
  sendMessage: (chatId: string, text: string) => Promise<{ message_id: number }>
  editMessageText: (chatId: string, messageId: number, text: string) => Promise<unknown>
}
function makeFakeBot(): FakeBot {
  let nextId = 7000
  const fb: FakeBot = {
    sent: [],
    edits: [],
    sendMessage: async (chatId, text) => {
      fb.sent.push({ chatId, text })
      return { message_id: nextId++ }
    },
    editMessageText: async (chatId, messageId, text) => {
      fb.edits.push({ chatId, messageId, text })
      return {}
    },
  }
  return fb
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0))
}

let cleanupDirs: string[] = []
let stoppers: Array<() => void> = []
afterEach(() => {
  for (const s of stoppers) { try { s() } catch { /* ignore */ } }
  stoppers = []
  for (const d of cleanupDirs) { try { rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ } }
  cleanupDirs = []
})

function makeHarness() {
  const agentDir = mkdtempSync(join(tmpdir(), 'nested-harness-'))
  cleanupDirs.push(agentDir)
  const subagentsDir = join(agentDir, '.claude', 'projects', 'proj', 'sess-1', 'subagents')
  mkdirSync(subagentsDir, { recursive: true })

  const db = openTurnsDbInMemory()
  applySubagentsSchema(db)
  // The originating turn — ENDED before the nested dispatch happens.
  db.prepare(`
    INSERT INTO turns (turn_key, chat_id, thread_id, started_at, ended_at, created_at, updated_at)
    VALUES (?, ?, NULL, 500, 900, 500, 900)
  `).run(ORIGIN_TURN_KEY, ORIGIN_CHAT)
  // Depth-1 background worker row — stamped by the pretool hook while the
  // main turn was live (the mechanism PRs #2085/#2075 already fixed).
  db.prepare(`
    INSERT INTO subagents
      (id, parent_session_id, parent_turn_key, agent_type, description,
       background, started_at, last_activity_at, status, jsonl_agent_id, parent_agent_id)
    VALUES ('toolu_parent', 'sess-1', ?, 'worker', 'depth-1 orchestrator', 1, 800, 800, 'running', NULL, NULL)
  `).run(ORIGIN_TURN_KEY)

  let currentTime = 1000
  const intervals: Array<{ fn: () => void; ms: number; ref: number; fireAt: number }> = []
  let nextRef = 1
  const sharedSetInterval = (fn: () => void, ms: number): unknown => {
    const ref = nextRef++
    intervals.push({ fn, ms, ref, fireAt: currentTime + ms })
    return { ref }
  }
  const sharedClearInterval = (h: unknown): void => {
    const { ref } = h as { ref: number }
    const idx = intervals.findIndex((i) => i.ref === ref)
    if (idx !== -1) intervals.splice(idx, 1)
  }
  const sharedSetTimeout = sharedSetInterval
  const sharedClearTimeout = sharedClearInterval

  const bot = makeFakeBot()
  const feed = createWorkerActivityFeed({
    bot,
    now: () => currentTime,
    firstPaintMinMs: 0, // paint immediately — routing/content is under test, not paint gating
    minEditIntervalMs: 0,
    heartbeatTickMs: 6000,
    setInterval: sharedSetInterval,
    clearInterval: sharedClearInterval,
  })

  const finishCalls: Array<{ agentId: string; outcome: string }> = []

  // Mirror the gateway's routing: registry-derived dispatch + transitive
  // origin resolution, worker feed for background OR nested, orphan-DM
  // fallback otherwise.
  const routeChat = (agentId: string): { chatId: string } => {
    const key = resolveSubagentOriginTurnKey(db, agentId)
    if (key == null) return { chatId: OWNER_DM }
    const turn = db.prepare('SELECT chat_id FROM turns WHERE turn_key = ?').get(key) as { chat_id: string } | null
    return { chatId: turn?.chat_id ?? OWNER_DM }
  }

  const watcher = startSubagentWatcher({
    agentDir,
    db,
    rescanMs: 500,
    stallThresholdMs: 60_000,
    silentSynthesisStallThresholdMs: 300_000,
    silentStallTerminalMs: 300_000,
    now: () => currentTime,
    setInterval: sharedSetInterval,
    clearInterval: sharedClearInterval,
    setTimeout: sharedSetTimeout,
    clearTimeout: sharedClearTimeout,
    onProgress: ({ agentId, description, latestSummary, elapsedMs, lastTool, toolCount, progressLine }) => {
      const dispatch = resolveWorkerFeedDispatch(getSubagentByJsonlId(db, agentId), description)
      const isWorkerSurface = dispatch.isBackground || dispatch.isNested || !dispatch.hasRow
      if (!isWorkerSurface) return // foreground-nest path — out of scope here
      const { chatId } = routeChat(agentId)
      const view: WorkerActivityView = {
        description: dispatch.feedDescription,
        lastTool,
        toolCount,
        latestSummary: progressLine != null && progressLine.length > 0 ? progressLine : latestSummary,
        elapsedMs,
        state: 'running',
      }
      void feed.update(agentId, chatId, view)
    },
    onFinish: ({ agentId, outcome, description, resultText, toolCount, durationMs }) => {
      finishCalls.push({ agentId, outcome })
      const dispatch = resolveWorkerFeedDispatch(getSubagentByJsonlId(db, agentId), description)
      void feed.finish(agentId, {
        description: dispatch.feedDescription,
        lastTool: null,
        toolCount,
        latestSummary: resultText,
        elapsedMs: durationMs,
        state: outcome === 'failed' ? 'failed' : 'done',
      })
    },
  })
  stoppers.push(() => watcher.stop(), () => feed.stop())

  const advance = (ms: number): void => {
    currentTime += ms
    for (;;) {
      intervals.sort((a, b) => a.fireAt - b.fireAt)
      const next = intervals[0]
      if (!next || next.fireAt > currentTime) break
      next.fireAt += next.ms
      next.fn()
    }
  }

  const writeWorker = (stem: string, toolUseId: string, description: string, firstLines: string): void => {
    writeFileSync(join(subagentsDir, `agent-${stem}.meta.json`), JSON.stringify({
      agentType: 'general-purpose', description, toolUseId,
    }))
    writeFileSync(join(subagentsDir, `agent-${stem}.jsonl`), firstLines)
  }
  const appendWorker = (stem: string, lines: string): void => {
    appendFileSync(join(subagentsDir, `agent-${stem}.jsonl`), lines)
  }

  return { db, bot, feed, watcher, advance, writeWorker, appendWorker, finishCalls }
}

describe('nested (depth-2+) worker — end-to-end visibility harness', () => {
  it('records the row, shows live tool activity, routes to the origin chat, and finalizes', async () => {
    const h = makeHarness()
    h.advance(500) // boot scan (empty dir)

    // Depth-1 parent JSONL appears (post-boot → live) and immediately
    // dispatches a NESTED worker. The main turn ended at t=900 — there is no
    // turn-active marker, and the hook "lost" the child row entirely (we
    // never insert it): the exact frozen-card incident shape.
    h.writeWorker('parent01', 'toolu_parent', 'depth-1 orchestrator',
      userMsg('orchestrate the nested probe')
      + toolUse('toolu_child', 'Task', {
        description: 'nested probe', subagent_type: 'general-purpose', run_in_background: false,
      }))
    h.advance(500)
    await flush()

    // (a) The watcher recorded the nested dispatch from the parent's JSONL.
    const childRow = getSubagent(h.db, 'toolu_child')
    expect(childRow).not.toBeNull()
    expect(childRow?.parent_agent_id).toBe('parent01')
    expect(childRow?.parent_turn_key).toBe(ORIGIN_TURN_KEY)

    // The child JSONL appears and runs REAL tools (no prose).
    h.writeWorker('child01', 'toolu_child', 'nested probe',
      userMsg('probe the nested structure')
      + toolUse('t1', 'Read', { file_path: '/repo/src/index.ts' }))
    h.advance(500)
    await flush()

    // Linked + transitively attributed.
    expect(getSubagent(h.db, 'toolu_child')?.jsonl_agent_id).toBe('child01')
    expect(resolveSubagentOriginTurnKey(h.db, 'child01')).toBe(ORIGIN_TURN_KEY)

    // (b)+(c) The nested card painted in the ORIGINATING chat with a REAL
    // tool step — not the owner DM, not frozen "starting…".
    const childMsgs = [...h.bot.sent, ...h.bot.edits].filter((m) => m.text.includes('nested probe'))
    expect(childMsgs.length).toBeGreaterThanOrEqual(1)
    for (const m of childMsgs) expect(m.chatId).toBe(ORIGIN_CHAT)
    const lastChild = childMsgs[childMsgs.length - 1]!
    expect(lastChild.text).not.toContain('starting…')
    expect(lastChild.text).toContain('index.ts')

    // More tool activity → climbing tool count, still live.
    h.appendWorker('child01', toolUse('t2', 'Bash', { command: 'ls -la /repo' }))
    h.advance(1000)
    await flush()
    const afterSecondTool = [...h.bot.edits].filter((m) => m.text.includes('nested probe')).pop()
    expect(afterSecondTool?.text).toContain('2 tools')

    // (e) Parallel isolation: the parent's own card (if painted) never
    // absorbed the child's steps, and vice versa.
    const parentMsgs = [...h.bot.sent, ...h.bot.edits].filter((m) => m.text.includes('depth-1 orchestrator'))
    for (const m of parentMsgs) {
      expect(m.text).not.toContain('index.ts')
    }
    for (const m of [...h.bot.sent, ...h.bot.edits].filter((x) => x.text.includes('nested probe'))) {
      expect(m.text).not.toContain('orchestrate the nested probe')
    }

    // (d) turn_end → clean finalize: the card edits to done and the feed
    // handle is dropped (never heartbeated frozen forever).
    h.appendWorker('child01', turnEnd())
    h.advance(1000)
    await flush()
    expect(h.finishCalls.some((f) => f.agentId === 'child01')).toBe(true)
    const finalEdit = h.bot.edits.filter((m) => m.text.includes('nested probe')).pop()
    expect(finalEdit?.text).toContain('done')
    expect(h.feed.messageIdOf('child01')).toBeNull()
  })

  it('links late (backfill retry) when the child JSONL appears BEFORE the parent dispatch line is read', async () => {
    const h = makeHarness()
    h.advance(500) // boot scan

    // Child JSONL first — registration backfill finds NO row ("Phase 2 Pre
    // hook pending", the 2-minute freeze window from the live gateway log).
    h.writeWorker('child01', 'toolu_child', 'nested probe',
      userMsg('probe') + toolUse('t1', 'Read', { file_path: '/repo/a.ts' }))
    h.advance(500)
    await flush()
    expect(getSubagent(h.db, 'toolu_child')).toBeNull()

    // Parent's dispatch line lands → watcher records the child row.
    h.writeWorker('parent01', 'toolu_parent', 'depth-1 orchestrator',
      userMsg('orchestrate')
      + toolUse('toolu_child', 'Task', { description: 'nested probe', run_in_background: false }))
    h.advance(500)
    await flush()
    expect(getSubagent(h.db, 'toolu_child')).not.toBeNull()

    // The child's JSONL grows → the liveness-path backfill RETRY links it
    // (registration's one-shot backfill already missed).
    h.advance(3000) // past BACKFILL_RETRY_INTERVAL_MS
    h.appendWorker('child01', toolUse('t2', 'Bash', { command: 'pwd' }))
    h.advance(1000)
    await flush()
    const row = getSubagent(h.db, 'toolu_child')
    expect(row?.jsonl_agent_id).toBe('child01')
    expect(row?.parent_turn_key).toBe(ORIGIN_TURN_KEY)
    expect(resolveSubagentOriginTurnKey(h.db, 'child01')).toBe(ORIGIN_TURN_KEY)
  })
})
