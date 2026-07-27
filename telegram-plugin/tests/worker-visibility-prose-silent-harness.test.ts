/**
 * Flagship harness for the prose-silent background-worker visibility fix
 * (PR 2 of 2). This is the automated proxy for the live-gateway test the
 * operator demanded: it wires the REAL `startSubagentWatcher` to the REAL
 * `createWorkerActivityFeed` on ONE shared virtual clock, mirroring the
 * gateway's `onProgress → workerActivityFeed.update` and
 * `onFinish → workerActivityFeed.finish` wiring, and drives a sub-agent JSONL
 * that contains ONLY tool_use events (a long `Bash` run) — NO `sub_agent_text`.
 *
 * It asserts the four outcomes the fix must deliver:
 *   (a) the `🛠 Worker` feed PAINTS a message (gets a messageId) within the
 *       expected window even though the worker never emitted prose,
 *   (b) the message keeps UPDATING via the heartbeat while the worker is alive,
 *   (c) NO false stall is flagged during the Bash window (the worker mid-`Bash`
 *       is not "stalled" just because its JSONL went quiet), and
 *   (d) the 300s-style silent-stall TERMINAL synthesis still releases the
 *       deferred-completion gate at the end (onStallTerminal + onFinish fire,
 *       and the feed finalizes) — the load-bearing completion path is intact.
 *
 * The pre-fix behaviour this locks against: a background worker that dives
 * straight into a long `Bash` fired one tool tick (before firstPaintMin, so the
 * paint was held), then no further JSONL lines — and the heartbeat skipped
 * `messageId == null` handles, so the worker showed NOTHING for its entire run
 * while ALSO being falsely flagged "stall detected (idle 60s)".
 *
 * Uses vitest (no bun:sqlite): no registry DB is wired, so the gate-release
 * proxy is the `onStallTerminal` + `onFinish` callbacks — the exact signals the
 * gateway's handback delivery and deferred-completion release consume.
 */

import { describe, it, expect, vi } from 'vitest'
import { startSubagentWatcher } from '../subagent-watcher.js'
import {
  createWorkerActivityFeed,
  type WorkerActivityView,
} from '../worker-activity-feed.js'
import * as fs from 'fs'

function buildJSONL(...lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
}
function subAgentUserMsg(promptText: string) {
  return { type: 'user', message: { content: [{ type: 'text', text: promptText }] } }
}
function bashToolUse(id: string, command: string) {
  return { type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } }
}

interface FakeBot {
  sent: Array<{ chatId: string; text: string }>
  edits: Array<{ messageId: number; text: string }>
  sendMessage: (chatId: string, text: string) => Promise<{ message_id: number }>
  editMessageText: (chatId: string, messageId: number, text: string) => Promise<unknown>
}
function makeFakeBot(): FakeBot {
  let nextId = 5000
  const fb: FakeBot = {
    sent: [],
    edits: [],
    sendMessage: async (chatId, text) => {
      fb.sent.push({ chatId, text })
      return { message_id: nextId++ }
    },
    editMessageText: async (_chatId, messageId, text) => {
      fb.edits.push({ messageId, text })
      return {}
    },
  }
  return fb
}

/** Flush the feed's async chains (microtasks + the awaited fake bot). */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
}

function makeHarness() {
  const agentId = 'prose-silent-bash-01'
  const chatId = 'chat-42'
  let currentTime = 1000

  const stallCalls: Array<{ agentId: string; idleMs: number }> = []
  const stallTerminalCalls: Array<{ agentId: string }> = []
  const finishCalls: Array<{ agentId: string; outcome: string }> = []

  const agentDir = '/home/user/.switchroom/agents/myagent'
  const sessionId = 'mock-session'
  const projectsRoot = `${agentDir}/.claude/projects`
  const projectDir = `${projectsRoot}/mock-cwd`
  const sessionDir = `${projectDir}/${sessionId}`
  const subagentsDir = `${sessionDir}/subagents`
  const jsonlPath = `${subagentsDir}/agent-${agentId}.jsonl`
  const fileContents = new Map<string, Buffer>()
  // Start with ONLY the dispatch user message — no tool, no prose. The Bash
  // tool_use is appended post-boot so it fires onProgress on a live (non-
  // historical) entry, exactly like a worker that starts then dives into Bash.
  fileContents.set(jsonlPath, Buffer.from(buildJSONL(subAgentUserMsg('run the integration suite')), 'utf-8'))

  let lastOpenedPath: string | null = null
  const mockFs = {
    existsSync: ((p: fs.PathLike) => {
      const ps = String(p)
      if (ps === projectsRoot || ps === projectDir || ps === sessionDir || ps === subagentsDir) return true
      return fileContents.has(ps)
    }) as typeof fs.existsSync,
    readdirSync: ((p: fs.PathLike) => {
      const ps = String(p)
      if (ps === projectsRoot) return ['mock-cwd']
      if (ps === projectDir) return [sessionId]
      if (ps === sessionDir) return ['subagents']
      if (ps === subagentsDir) return [`agent-${agentId}.jsonl`]
      return []
    }) as unknown as typeof fs.readdirSync,
    statSync: ((p: fs.PathLike) => ({ size: fileContents.get(String(p))?.length ?? 0 }) as fs.Stats) as typeof fs.statSync,
    openSync: ((p: fs.PathLike) => { lastOpenedPath = String(p); return 42 }) as unknown as typeof fs.openSync,
    closeSync: (() => { lastOpenedPath = null }) as typeof fs.closeSync,
    readSync: ((
      _fd: number, buf: NodeJS.ArrayBufferView, offset: number, length: number, position: number | null,
    ): number => {
      const content = lastOpenedPath != null ? fileContents.get(lastOpenedPath) : undefined
      if (!content) return 0
      const pos = position ?? 0
      const src = content.slice(pos, pos + length)
      ;(src as Buffer).copy(buf as Buffer, offset)
      return src.length
    }) as unknown as typeof fs.readSync,
    watch: (() => ({ close: vi.fn() }) as unknown as fs.FSWatcher) as unknown as typeof fs.watch,
  }

  // One shared interval list drives BOTH the watcher (rescan + checkStalls)
  // and the feed (heartbeat) off the same virtual clock.
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

  const bot = makeFakeBot()
  const feed = createWorkerActivityFeed({
    bot,
    now: () => currentTime,
    firstPaintMinMs: 8000,
    heartbeatTickMs: 6000,
    minEditIntervalMs: 2500,
    setInterval: sharedSetInterval,
    clearInterval: sharedClearInterval,
  })

  const watcher = startSubagentWatcher({
    agentDir,
    stallThresholdMs: 60_000, // tight active-loop threshold
    silentSynthesisStallThresholdMs: 300_000, // widened window (also long-runner window)
    silentStallTerminalMs: 300_000, // post-stall terminal-synthesis window (unchanged)
    inflightTerminalCapMs: 900_000, // died-mid-tool cap (15 min, compressed from the 45-min default)
    rescanMs: 500,
    now: () => currentTime,
    setInterval: sharedSetInterval,
    clearInterval: sharedClearInterval,
    fs: mockFs,
    onStall: (id, idleMs) => stallCalls.push({ agentId: id, idleMs }),
    onStallTerminal: (id) => stallTerminalCalls.push({ agentId: id }),
    onFinish: ({ agentId: id, outcome, description, resultText, toolCount, durationMs }) => {
      finishCalls.push({ agentId: id, outcome })
      // Mirror the gateway's terminal wiring: force the worker feed's recap.
      void feed.finish(id, {
        description,
        lastTool: null,
        toolCount,
        latestSummary: resultText,
        elapsedMs: durationMs,
        state: outcome === 'failed' ? 'failed' : 'done',
      })
    },
    // Mirror the gateway's onProgress → workerActivityFeed.update wiring for a
    // background worker (worker-feed owns the progress beat).
    onProgress: ({ agentId: id, description, latestSummary, elapsedMs, lastTool, toolCount, progressLine }) => {
      const view: WorkerActivityView = {
        description,
        lastTool,
        toolCount,
        // Mirror the gateway's step-line precedence: the friendly tool label
        // on tool ticks, else the narrative (the unified-cards fix — a
        // tools-only worker must grow real steps, not freeze on "starting…").
        latestSummary: progressLine != null && progressLine.length > 0 ? progressLine : latestSummary,
        elapsedMs,
        state: 'running',
      }
      void feed.update(id, chatId, view)
    },
  })

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

  const appendBash = (): void => {
    const existing = fileContents.get(jsonlPath) ?? Buffer.from('')
    const line = JSON.stringify(bashToolUse('tool-bash-1', 'npm run test:integration')) + '\n'
    fileContents.set(jsonlPath, Buffer.concat([existing, Buffer.from(line, 'utf-8')]))
  }

  return {
    agentId, bot, feed, watcher, advance, appendBash, flush,
    stallCalls, stallTerminalCalls, finishCalls,
    unmarkHistorical: () => {
      const e = watcher.getRegistry().get(agentId)
      if (e) e.historical = false
    },
    registry: () => watcher.getRegistry(),
  }
}

describe('prose-silent background worker — end-to-end visibility harness (PR 2)', () => {
  it('paints, keeps updating, does not falsely stall, and still releases the terminal gate', async () => {
    const h = makeHarness()

    // Boot: register the entry (historical=true at boot). Flip it live to model
    // an entry discovered post-boot (the only case progress/stall fire).
    h.advance(500)
    h.unmarkHistorical()

    // The worker dives into a long Bash. The single tool_use fires onProgress —
    // BEFORE firstPaintMin — so the feed HOLDS the paint (this is the trap).
    h.appendBash()
    h.advance(500) // poll reads the Bash line → onProgress(tool) → feed.update
    await h.flush()
    const entry = h.registry().get(h.agentId)
    expect(entry?.lastTool?.name).toBe('Bash')
    expect(entry?.toolCount).toBe(1)
    // Held: elapsed (~1s) < firstPaintMin (8s), no paint yet.
    expect(h.bot.sent).toHaveLength(0)
    expect(h.feed.messageIdOf(h.agentId)).toBeNull()

    // (a) PAINT: with NO further JSONL events, the heartbeat performs the first
    // paint once the held handle is past firstPaintMin. Pre-fix this never
    // happened (heartbeat skipped messageId==null) → the worker was invisible.
    h.advance(12_000) // ~12.5s since dispatch — past firstPaintMin, heartbeats fire
    await h.flush()
    expect(h.bot.sent).toHaveLength(1)
    expect(h.feed.messageIdOf(h.agentId)).not.toBeNull()
    expect(h.bot.sent[0].chatId).toBe('chat-42')
    expect(h.bot.sent[0].text.startsWith('🛠 **WORKER**')).toBe(true)

    // (b) KEEPS UPDATING: later heartbeats edit the message with a climbing
    // `· Ns` suffix so the still-alive worker visibly advances.
    h.advance(30_000)
    await h.flush()
    expect(h.bot.edits.length).toBeGreaterThanOrEqual(1)
    expect(h.bot.edits[h.bot.edits.length - 1].text).toMatch(/· \d+/)

    // (c) NO FALSE STALL during the Bash window: the worker's last tool is a
    // long-runner, so the tight 60s active-loop threshold does NOT apply. We
    // are now well past 60s of JSONL silence with zero stall flagged.
    h.advance(60_000) // total idle ~102s — far past the old 60s misfire point
    await h.flush()
    expect(h.stallCalls).toHaveLength(0)
    // The feed is still live and updating during this window.
    expect(h.bot.edits.length).toBeGreaterThanOrEqual(2)

    // The stall IS eventually flagged once past the widened silent-synthesis
    // window (the worker genuinely never wrote another line / turn_end).
    h.advance(260_000) // total idle > 300s → stall flagged
    await h.flush()
    expect(h.stallCalls).toHaveLength(1)
    expect(h.stallCalls[0].agentId).toBe(h.agentId)
    expect(h.stallTerminalCalls).toHaveLength(0)

    // (d) IN-FLIGHT DEFERRAL: 300s past the stall the OLD contract
    // (#2777/#2782) synthesised terminal here. But this worker's transcript
    // ends in a Bash tool_use with NO tool_result — it may still be inside
    // the tool call (incident 2026-07-10: exactly this shape finalised a
    // LIVE worker's card mid-Bash). Synthesis is now deferred while the
    // tool call is in flight...
    h.advance(310_000) // total idle ~672s — past silentStallTerminalMs, under the 900s cap
    await h.flush()
    expect(h.stallTerminalCalls).toHaveLength(0)
    expect(h.finishCalls).toHaveLength(0)

    // (e) TERMINAL GATE RELEASE AT THE CAP: ...but not forever. A worker
    // that died mid-tool (JSONL frozen, tool_result never coming) must not
    // wedge — past inflightTerminalCapMs of total idle the synthesis
    // proceeds and the completion gate releases. The load-bearing release
    // from #2777/#2782 survives, bounded instead of at the raw synth window.
    h.advance(300_000) // total idle ~972s ≥ 900s cap
    await h.flush()
    expect(h.stallTerminalCalls).toHaveLength(1)
    expect(h.finishCalls).toHaveLength(1)
    expect(h.finishCalls[0].agentId).toBe(h.agentId)
    // The feed's terminal recap edited the existing worker message to done.
    const lastEdit = h.bot.edits[h.bot.edits.length - 1]
    expect(lastEdit.text).toContain('done')
    // Handle dropped after finish (gateway unpins independently).
    expect(h.feed.messageIdOf(h.agentId)).toBeNull()
  })
})
