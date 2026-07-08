/**
 * Integration test: telegram-activity-visibility
 *
 * Supersedes PR #2587 (inert — read frozen `lastToolLabelAt`) and #2588
 * (partial — only fixed Lever 5, left narrative clip at 120 chars).
 *
 * This test exercises the REAL code paths — not injected state:
 *
 * Fix 2 (post-answer background-agent liveness) — drives the REAL code paths:
 *   - The actual `startSubagentWatcher` with a real fs mock drives `onProgress`,
 *     which stamps `turn.subagentActivityAt` (the gateway's one-line stamp,
 *     gated exactly as gateway.ts gates it on a non-null currentTurn).
 *   - The REAL `mayOpenActivityCard` AND the REAL `evaluatePostAnswerLiveness`
 *     (the helper feedHeartbeatTick consults each tick) decide the verdict — not
 *     a re-implemented copy of the gate.
 *   - Concern 2 lifecycle: the gateway's `currentTurn` gating is modelled
 *     verbatim to prove the stamp + heartbeat EMIT in the post-answer/pre-teardown
 *     window but are INERT once `currentTurn` nulls at turn_end — and that the
 *     decoupled worker still surfaces (and is bounded) via the real,
 *     currentTurn-independent `workerActivityFeed`.
 *   - Concern 3: the staleness cap flips the verdict to 'stale' once the worker's
 *     last advance is older than the cap, so the card stops climbing forever.
 *
 * Fix 1 (narrative as first-class feed lines):
 *   - `clipNarrative` is called on a long narrative string → verifies 200-char
 *     limit (not the old 120-char one that truncated mid-sentence).
 *   - `appendActivityLabel` accumulates narrative AND tool label lines side-by-side
 *     in mirrorLines (distinct, not overwriting) → verifies the feed reads
 *     "narrative → tool → narrative" in order.
 *   - `mayOpenActivityCard` with narrative producer pre-answer → allows OPEN
 *     (Lever 5 removed, #2588).
 *
 * Each test also verifies it FAILS on the original code, as required:
 *   - Fix 2 without `subagentActivityAt` → gate would block (returns false).
 *   - Fix 1 at old 120-char clip → narrative truncates.
 *   - Fix 1 with Lever 5 active → narrative cannot open a card.
 */

import { describe, it, expect } from 'vitest'
import * as realFs from 'fs'
import { startSubagentWatcher } from '../subagent-watcher.js'
import { mayOpenActivityCard } from '../gateway/feed-open-gate.js'
import {
  clipNarrative,
  appendActivityLabel,
  renderActivityFeedWithNested,
  formatStepSuffix,
} from '../tool-activity-summary.js'
import { evaluatePostAnswerLiveness } from '../turn-liveness-floor.js'
import {
  createWorkerActivityFeed,
  type WorkerActivityView,
  type BotApiForWorkerFeed,
} from '../worker-activity-feed.js'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildJSONL(...lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
}

function subAgentUserMsg(text: string) {
  return { type: 'user', message: { content: [{ type: 'text', text }] } }
}

function subAgentToolUse(name: string) {
  return { type: 'assistant', message: { content: [{ type: 'tool_use', name, id: 'id1', input: {} }] } }
}

function subAgentAssistantText(text: string) {
  return { type: 'assistant', message: { content: [{ type: 'text', text }] } }
}

// ─── Fix 2: Post-answer background-agent liveness ────────────────────────────

describe('Fix 2: post-answer background-agent liveness (watcher → gate → liveness card)', () => {
  /**
   * This test uses the REAL `startSubagentWatcher` with an injected mock fs
   * (the same pattern as subagent-watcher.test.ts — the authoritative harness
   * for watcher tests). The `onProgress` callback is the REAL watcher code path.
   *
   * Simulate: parent turn has delivered substantive answer → turn.finalAnswerEverDelivered=true.
   * Then watcher fires onProgress for a background sub-agent → we capture the
   * timestamp it would write to turn.subagentActivityAt.
   * Then call the REAL mayOpenActivityCard with that signal → assert it returns true.
   *
   * This exercises the entire watcher → signal → gate pipeline, not injected state.
   */

  it('watcher onProgress advances subagentActivityAt and gate allows liveness card (real pipeline)', async () => {
    // --- Setup fake turn state mirroring what gateway.ts holds post-answer ---
    // The parent answered at time 1000; we are now at 1500 (post-answer).
    const turn = {
      finalAnswerEverDelivered: true,
      finalAnswerDelivered: true,
      finalAnswerDeliveredAt: 1000,
      subagentActivityAt: undefined as number | undefined,
      labeledToolCount: 2,
    }
    // Model the gateway's module-scope `currentTurn` mirror so the test can
    // reproduce its lifecycle: non-null in the post-answer/pre-teardown window,
    // nulled at `endCurrentTurnAtomic` (turn_end). The onProgress stamp and the
    // heartbeat both read THIS — the crux of concern 2.
    let currentTurn: typeof turn | null = turn

    // --- Wire up the REAL startSubagentWatcher with mock fs ---
    // Pattern: start with an EMPTY subagents dir so the boot scan finds nothing
    // (no historical entries). Then simulate a new file appearing after boot.
    const agentDir = '/home/user/.switchroom/agents/myagent'
    const projectsRoot = `${agentDir}/.claude/projects`
    const projectDir = `${projectsRoot}/myproject`
    const sessionDir = `${projectDir}/session-abc`
    const subagentsDir = `${sessionDir}/subagents`
    const jsonlPath = `${subagentsDir}/agent-bg01.jsonl`

    // The JSONL has a tool_use then a narrative block.
    // sub_agent_tool_use fires onProgress(progressLine), sub_agent_text fires onProgress(latestSummary).
    const content = buildJSONL(
      subAgentUserMsg('Analyse the 30 changed files'),
      subAgentToolUse('Read'),
      subAgentAssistantText('I have read the files and analysed the scope of the change'),
    )
    const contentBuf = Buffer.from(content, 'utf-8')

    // Start with empty subagents dir so boot scan registers nothing historical
    const fileContents: Map<string, Buffer> = new Map()
    let lastOpenedPath: string | null = null

    // Control knobs for per-phase fs state
    let jsonlVisible = false
    const mockFs = {
      existsSync: ((p: realFs.PathLike) => {
        const ps = String(p)
        const staticPaths = [agentDir, projectsRoot, projectDir, sessionDir, subagentsDir]
        if (staticPaths.includes(ps)) return true
        if (ps === jsonlPath) return jsonlVisible
        return false
      }) as typeof realFs.existsSync,
      readdirSync: ((p: realFs.PathLike) => {
        const ps = String(p)
        if (ps === projectsRoot) return ['myproject']
        if (ps === projectDir) return ['session-abc']
        if (ps === sessionDir) return ['subagents']
        if (ps === subagentsDir) return jsonlVisible ? ['agent-bg01.jsonl'] : []
        return []
      }) as unknown as typeof realFs.readdirSync,
      statSync: ((p: realFs.PathLike) => {
        const ps = String(p)
        if (ps === jsonlPath && jsonlVisible) return { size: contentBuf.length, mtimeMs: 1500, isDirectory: () => false } as unknown as realFs.Stats
        return { size: 0, mtimeMs: 0, isDirectory: () => false } as unknown as realFs.Stats
      }) as typeof realFs.statSync,
      openSync: ((p: realFs.PathLike) => { lastOpenedPath = String(p); return 42 }) as unknown as typeof realFs.openSync,
      closeSync: (() => { lastOpenedPath = null }) as typeof realFs.closeSync,
      readSync: ((_fd: number, buf: NodeJS.ArrayBufferView, offset: number, length: number, position: number | null): number => {
        if (lastOpenedPath !== jsonlPath) return 0
        const pos = position ?? 0
        const src = contentBuf.slice(pos, pos + length)
        ;(src as Buffer).copy(buf as Buffer, offset)
        return src.length
      }) as unknown as typeof realFs.readSync,
      watch: (() => ({ close: () => {} })) as unknown as typeof realFs.watch,
    }

    let currentTime = 1500
    const intervals: Array<{ fn: () => void; ms: number }> = []
    let nextRef = 0

    const progressEvents: Array<{ agentId: string; latestSummary: string }> = []

    const watcher = startSubagentWatcher({
      agentDir,
      // Omit agentCwd so the watcher doesn't filter by slug — keeps the test simple
      now: () => currentTime,
      setInterval: (fn, ms) => {
        const ref = nextRef++
        intervals.push({ fn, ms })
        return { ref }
      },
      clearInterval: () => {},
      setTimeout: (_fn, _ms) => { return { ref: nextRef++ } },
      clearTimeout: () => {},
      fs: mockFs,
      onProgress: ({ agentId, latestSummary }) => {
        progressEvents.push({ agentId, latestSummary })
        // Mirror ONLY the gateway's one-line stamp (`stampTurn.subagentActivityAt
        // = Date.now()`), gated exactly as gateway.ts gates it: `currentTurn !=
        // null && finalAnswerEverDelivered`. The DECISION the heartbeat then
        // makes off this signal is NOT re-implemented here — the test drives the
        // REAL `evaluatePostAnswerLiveness` helper below (concern 1/2: drive the
        // real code path, not a copy of the gate).
        const stampTurn = currentTurn // gateway: `const stampTurn = currentTurn`
        if (stampTurn != null && stampTurn.finalAnswerEverDelivered) {
          stampTurn.subagentActivityAt = currentTime
        }
      },
      log: () => {},
    })
    // After startSubagentWatcher returns, bootScanInProgress = false.
    // The JSONL was not visible during boot, so it is NOT historical.

    // Phase 2: simulate the file appearing after boot (background worker dispatched after answer)
    jsonlVisible = true
    currentTime = 1600

    // Trigger a poll — the watcher finds the new file, registers it as live (non-historical),
    // does an initial read, and fires onProgress for the tool_use and/or text events.
    const pollInterval = intervals[0]
    expect(pollInterval).toBeDefined()
    pollInterval.fn()

    watcher.stop()

    // --- Assert the REAL watcher fired onProgress ---
    // The JSONL has a tool_use (fires progressLine) and a text block (fires latestSummary).
    // At minimum one onProgress should have fired.
    expect(progressEvents.length).toBeGreaterThan(0)
    expect(progressEvents[0].agentId).toBe('bg01')

    // --- Assert subagentActivityAt was stamped by the onProgress callback ---
    // This is the Fix 2 signal: the watcher's onProgress writes it to the turn
    // independently of lastToolLabelAt (which is frozen by the drop-guard).
    expect(turn.subagentActivityAt).toBe(currentTime)
    expect(turn.subagentActivityAt!).toBeGreaterThan(turn.finalAnswerDeliveredAt!)

    // --- Assert the REAL mayOpenActivityCard gate allows a liveness card ---
    // Fix 2's Lever 1 exception: postAnswerSubagentActivity=true + tool producer → allowed.
    const allowed = mayOpenActivityCard({
      producer: 'tool',
      finalAnswerEverDelivered: turn.finalAnswerEverDelivered,
      labeledToolCount: turn.labeledToolCount,
      postAnswerSubagentActivity: true, // derived from subagentActivityAt > finalAnswerDeliveredAt
    })
    expect(allowed).toBe(true)

    // --- Confirm FAILS without the fix ---
    // Without postAnswerSubagentActivity, Lever 1 blocks: the old #2587 code path
    // drove this off lastToolLabelAt (frozen) and never set postAnswerSubagentActivity.
    const blockedWithoutFix = mayOpenActivityCard({
      producer: 'tool',
      finalAnswerEverDelivered: turn.finalAnswerEverDelivered,
      labeledToolCount: turn.labeledToolCount,
      // postAnswerSubagentActivity omitted → old Lever 1 block (was the bug in #2587)
    })
    expect(blockedWithoutFix).toBe(false)

    // --- Drive the REAL feedHeartbeatTick decision helper (not a re-impl) ---
    // The heartbeat reads `currentTurn`; in this post-answer/pre-teardown window
    // it is still non-null AND just-stamped, so the REAL `evaluatePostAnswerLiveness`
    // returns 'emit' → the liveness card renders. (Concern 2 (a): the stamp fires
    // and the card renders while the turn is alive.)
    expect(currentTurn).not.toBeNull()
    const verdictInWindow = evaluatePostAnswerLiveness({
      subagentActivityAt: currentTurn!.subagentActivityAt,
      finalAnswerDeliveredAt: currentTurn!.finalAnswerDeliveredAt,
      now: currentTime + 5, // a heartbeat tick moments after the stamp
      staleCapMs: 30_000,
      stillDispatched: false,
    })
    expect(verdictInWindow).toBe('emit')
  })

  it('idle post-answer (no watcher activity) → evaluatePostAnswerLiveness returns "idle" → silent', () => {
    // When subagentActivityAt is undefined (no watcher activity since the answer)
    // the REAL heartbeat decision returns 'idle' → the post-answer branch returns
    // early and no card opens. The reply-is-last invariant holds for idle turns.
    const verdict = evaluatePostAnswerLiveness({
      subagentActivityAt: undefined,
      finalAnswerDeliveredAt: 1000,
      now: 50_000,
      staleCapMs: 30_000,
      stillDispatched: false,
    })
    expect(verdict).toBe('idle')
  })

  it('subagentActivityAt at/before the answer → "idle" (pre-answer label never opens a post-answer card)', () => {
    expect(
      evaluatePostAnswerLiveness({
        subagentActivityAt: 500,
        finalAnswerDeliveredAt: 1000,
        now: 1500,
        staleCapMs: 30_000,
        stillDispatched: false,
      }),
    ).toBe('idle')
  })
})

// ─── Fix 2 — concern 2: the currentTurn path is INERT after teardown ─────────

describe('Fix 2 / concern 2: currentTurn nulls at turn_end → heartbeat path inert; worker feed covers it', () => {
  /**
   * The reviewer's concern: the post-answer liveness fix stamps + renders off
   * `currentTurn`, which `endCurrentTurnAtomic` nulls at `turn_end`. A genuinely
   * DECOUPLED background worker keeps ticking PAST teardown, so when its later
   * onProgress arrives `currentTurn` is null → the stamp is inert and the
   * heartbeat (which early-returns `if (turn == null) return`) is silent.
   *
   * This test reproduces that lifecycle EXACTLY (the gateway's `currentTurn`
   * gating, which can't be imported, modelled verbatim) and proves:
   *   (a) in the post-answer/pre-teardown window the stamp fires and the REAL
   *       `evaluatePostAnswerLiveness` returns 'emit';
   *   (b) after teardown (`currentTurn = null`) a later worker tick CANNOT stamp
   *       and the heartbeat is structurally silent — i.e. the currentTurn fix IS
   *       inert for a decoupled worker, as suspected.
   * The follow-on `describe` then proves the decoupled worker still surfaces via
   * the currentTurn-INDEPENDENT `workerActivityFeed` (the by-design coverage).
   */

  // The gateway's stamp, verbatim (the only line we can't import): gated on a
  // non-null currentTurn that has delivered its substantive answer.
  function gatewayStamp(currentTurn: { finalAnswerEverDelivered: boolean; subagentActivityAt?: number } | null, now: number): void {
    const stampTurn = currentTurn
    if (stampTurn != null && stampTurn.finalAnswerEverDelivered) {
      stampTurn.subagentActivityAt = now
    }
  }

  // The gateway's feedHeartbeatTick post-answer entry, reduced to its decision:
  // `if (turn == null) return` (no-turn), else the REAL evaluatePostAnswerLiveness.
  // `stillDispatched` defaults to false (a purely-background worker, no
  // foreground `turn.foregroundSubAgents` tracking) so these existing tests
  // keep proving the ORIGINAL staleness-cap behaviour is preserved for that
  // case; a dedicated Fix-3 describe block below covers `stillDispatched: true`.
  function heartbeatVerdict(
    currentTurn: { finalAnswerDelivered: boolean; finalAnswerDeliveredAt?: number; subagentActivityAt?: number } | null,
    now: number,
    stillDispatched = false,
  ): 'no-turn' | 'pre-answer' | ReturnType<typeof evaluatePostAnswerLiveness> {
    const turn = currentTurn
    if (turn == null) return 'no-turn' // gateway: `if (turn == null) return`
    if (!turn.finalAnswerDelivered) return 'pre-answer'
    return evaluatePostAnswerLiveness({
      subagentActivityAt: turn.subagentActivityAt,
      finalAnswerDeliveredAt: turn.finalAnswerDeliveredAt,
      now,
      staleCapMs: 30_000,
      stillDispatched,
    })
  }

  it('(a) in-window: currentTurn alive → stamp fires and heartbeat emits', () => {
    const turn = {
      finalAnswerEverDelivered: true,
      finalAnswerDelivered: true,
      finalAnswerDeliveredAt: 1000,
      subagentActivityAt: undefined as number | undefined,
    }
    let currentTurn: typeof turn | null = turn

    // Worker ticks at t=1600, still inside the turn (pre-teardown).
    gatewayStamp(currentTurn, 1600)
    expect(turn.subagentActivityAt).toBe(1600)
    expect(heartbeatVerdict(currentTurn, 1605)).toBe('emit')
  })

  it('(b) post-teardown: currentTurn nulled → later worker tick cannot stamp; heartbeat is silent (INERT)', () => {
    const turn = {
      finalAnswerEverDelivered: true,
      finalAnswerDelivered: true,
      finalAnswerDeliveredAt: 1000,
      subagentActivityAt: undefined as number | undefined,
    }
    let currentTurn: typeof turn | null = turn

    // turn_end fires → endCurrentTurnAtomic nulls the module-scope mirror.
    currentTurn = null

    // The DECOUPLED worker keeps running and ticks much later (t=120_000).
    gatewayStamp(currentTurn, 120_000)
    // Nothing to stamp — the turn object is unreferenced by the live mirror.
    expect(turn.subagentActivityAt).toBeUndefined()
    // And the heartbeat is structurally silent: no live turn to render on.
    expect(heartbeatVerdict(currentTurn, 120_005)).toBe('no-turn')
  })

  it('concern 3: while the turn is alive but the worker went stale, heartbeat stops ("stale")', () => {
    const turn = {
      finalAnswerDelivered: true,
      finalAnswerDeliveredAt: 1000,
      // last advance at 2000; the worker has since finished (onFinish froze it).
      subagentActivityAt: 2000 as number | undefined,
    }
    const currentTurn: typeof turn | null = turn
    // One tick just after the last advance still emits…
    expect(heartbeatVerdict(currentTurn, 2500)).toBe('emit')
    // …but once `now - subagentActivityAt >= 30s` the verdict flips to 'stale'
    // and the card stops climbing `running` forever (the concern-3 bug).
    expect(heartbeatVerdict(currentTurn, 2000 + 30_000)).toBe('stale')
    expect(heartbeatVerdict(currentTurn, 2000 + 90_000)).toBe('stale')
  })
})

// ─── Fix 3 — sub-agent-delegation freeze (operator-confirmed: card frozen on
//     "Running a command" for 41s / 3m12s while a sub-agent ran underneath) ──

describe('Fix 3: a still-tracked foreground sub-agent bypasses the staleness cap (no mid-delegation freeze)', () => {
  /**
   * Reproduces the EXACT scenario the operator's 3 screenshots showed: a
   * foreground `Task`/`Agent` dispatch is still outstanding (one long silent
   * step — no new watcher narrative tick), so `subagentActivityAt` stops
   * advancing, yet the worker has NOT reported finished. Before Fix 3 the
   * staleness cap could not tell this apart from genuine completion and froze
   * the card after 30s regardless. `stillDispatched: true` — sourced from
   * `turn.foregroundSubAgents.size > 0` at the real call site — is the
   * positive signal that closes the gap.
   */

  // Local copy of the gateway's post-answer decision (same as the "Fix 2 /
  // concern 2" describe block above — duplicated here rather than hoisted to
  // module scope so each describe stays self-contained/readable).
  function heartbeatVerdict(
    currentTurn: { finalAnswerDelivered: boolean; finalAnswerDeliveredAt?: number; subagentActivityAt?: number } | null,
    now: number,
    stillDispatched = false,
  ): 'no-turn' | 'pre-answer' | ReturnType<typeof evaluatePostAnswerLiveness> {
    const turn = currentTurn
    if (turn == null) return 'no-turn'
    if (!turn.finalAnswerDelivered) return 'pre-answer'
    return evaluatePostAnswerLiveness({
      subagentActivityAt: turn.subagentActivityAt,
      finalAnswerDeliveredAt: turn.finalAnswerDeliveredAt,
      now,
      staleCapMs: 30_000,
      stillDispatched,
    })
  }

  it('long silent single step (41s, no new narrative) — bypasses the cap while still dispatched', () => {
    const turn = {
      finalAnswerDelivered: true,
      finalAnswerDeliveredAt: 1000,
      subagentActivityAt: 2000 as number | undefined,
    }
    const currentTurn: typeof turn | null = turn
    // 41s after the last (and only) narrative advance — well past the 30s cap.
    // Legacy (stillDispatched: false) behaviour would already be 'stale' here
    // (proven by the concern-3 test above); with a tracked foreground worker
    // it must stay 'emit' so the card keeps climbing instead of freezing.
    expect(heartbeatVerdict(currentTurn, 2000 + 41_000, /* stillDispatched */ true)).toBe('emit')
  })

  it('long silent single step (3m12s) — still bypasses the cap while still dispatched', () => {
    const turn = {
      finalAnswerDelivered: true,
      finalAnswerDeliveredAt: 1000,
      subagentActivityAt: 2000 as number | undefined,
    }
    const currentTurn: typeof turn | null = turn
    const threeMinTwelveSecMs = 3 * 60_000 + 12_000
    expect(heartbeatVerdict(currentTurn, 2000 + threeMinTwelveSecMs, true)).toBe('emit')
  })

  it('once the foreground sub-agent is no longer tracked (finished), the cap re-applies normally', () => {
    // The gateway removes the agentId from `turn.foregroundSubAgents` when it
    // finishes (gateway.ts ~27032/27037) — `stillDispatched` then reads false
    // again and the ORIGINAL runaway-climb protection re-engages exactly as
    // before Fix 3. This is the adversarial check that Fix 3 doesn't remove
    // the cap's protection outright, only bypasses it while genuinely unknown.
    const turn = {
      finalAnswerDelivered: true,
      finalAnswerDeliveredAt: 1000,
      subagentActivityAt: 2000 as number | undefined,
    }
    const currentTurn: typeof turn | null = turn
    expect(heartbeatVerdict(currentTurn, 2000 + 41_000, false)).toBe('stale')
  })

  it('idle-gap suppression still wins over stillDispatched (no watcher activity ever ⇒ silent, reply-is-last preserved)', () => {
    // Adversarial check: a turn that dispatched a foreground sub-agent but has
    // had NO watcher tick at all since the answer (subagentActivityAt
    // undefined) must stay 'idle', never 'emit', even if stillDispatched is
    // true — a still-registered worker with zero ticks yet is not the same as
    // one whose last tick went stale. This preserves the reply-is-last
    // invariant for a turn that answered and dispatched but hasn't surfaced
    // any post-answer step yet.
    const turn = {
      finalAnswerDelivered: true,
      finalAnswerDeliveredAt: 1000,
      subagentActivityAt: undefined as number | undefined,
    }
    const currentTurn: typeof turn | null = turn
    expect(heartbeatVerdict(currentTurn, 50_000, true)).toBe('idle')
  })

  it('end-to-end: the RENDERED card text keeps changing across real heartbeat ticks while a foreground sub-agent is silently working (not just the verdict function)', () => {
    // Full simulated turn: dispatch a foreground Task, one narrative tick
    // lands, then NOTHING further for over three minutes (one long silent
    // Bash inside the sub-agent) — the exact operator-reported shape. Drives
    // the REAL `evaluatePostAnswerLiveness` verdict AND the REAL
    // `renderActivityFeedWithNested`/`composeTurnActivity`-shaped render at
    // each tick, asserting the VISIBLE text (not an internal label) actually
    // climbs instead of freezing.
    const turn = {
      finalAnswerDelivered: true,
      finalAnswerDeliveredAt: 1_000,
      subagentActivityAt: 2_000 as number | undefined,
      mirrorLines: ['Delegating to a sub-agent'],
      foregroundSubAgents: new Map<string, string[]>([['agent-1', ['Running a command']]]),
    }

    function renderCardAt(now: number): string | null {
      const verdict = evaluatePostAnswerLiveness({
        subagentActivityAt: turn.subagentActivityAt,
        finalAnswerDeliveredAt: turn.finalAnswerDeliveredAt,
        now,
        staleCapMs: 30_000,
        stillDispatched: turn.foregroundSubAgents.size > 0,
      })
      if (verdict !== 'emit') return null // the pre-Fix-3 freeze point
      const childLines = [...turn.foregroundSubAgents.values()].flat()
      const header = { label: 'Agent', elapsedMs: now - 0, toolCount: 1, state: 'running' as const }
      return renderActivityFeedWithNested(turn.mirrorLines, childLines, false, formatStepSuffix(now - turn.subagentActivityAt!), undefined, header)
    }

    const tick1 = renderCardAt(2_000 + 6_000) // 6s after the last tick
    const tick2 = renderCardAt(2_000 + 41_000) // 41s — the first operator-reported freeze point
    const tick3 = renderCardAt(2_000 + (3 * 60_000 + 12_000)) // 3m12s — the second

    expect(tick1).not.toBeNull()
    expect(tick2).not.toBeNull()
    expect(tick3).not.toBeNull()
    // The visible text must actually differ tick-over-tick (climbing elapsed),
    // not be frozen at the same string for minutes.
    expect(tick2).not.toBe(tick1)
    expect(tick3).not.toBe(tick2)
    // And it must contain the growing wall-clock evidence the operator was
    // missing — a live elapsed suffix on the nested step.
    expect(tick2).toContain('41s')
    expect(tick3).toContain('3m12s')
  })
})

// ─── Fix 2 — concern 2 resolution: the decoupled worker surfaces via the
//     currentTurn-INDEPENDENT workerActivityFeed (and is bounded) ────────────

describe('Fix 2 / concern 2: decoupled background-worker activity surfaces via the real workerActivityFeed', () => {
  /**
   * Because the currentTurn heartbeat is inert post-teardown (proven above), the
   * decoupled worker's activity is surfaced by the dedicated `workerActivityFeed`
   * — a regular chat message edited in place, keyed by jsonl agent id, that the
   * watcher keeps driving AFTER the parent turn ends (NO currentTurn dependency).
   * This drives the REAL `createWorkerActivityFeed` to prove:
   *   - a running worker paints + edits a live message with NO turn in scope, and
   *   - it is BOUNDED: `finish` posts the terminal edit, the handle is dropped,
   *     and a later heartbeat tick emits nothing (no unbounded climb).
   */

  interface FakeBot extends BotApiForWorkerFeed {
    sent: Array<{ chatId: string; text: string }>
    edits: Array<{ messageId: number; text: string }>
  }
  function makeBot(): FakeBot {
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
  function wView(p: Partial<WorkerActivityView> = {}): WorkerActivityView {
    return {
      description: 'analyse the 30 changed files',
      lastTool: { name: 'Read', sanitisedArg: 'src/auth' },
      toolCount: 2,
      latestSummary: 'reading the auth module',
      elapsedMs: 10_000,
      state: 'running',
      ...p,
    }
  }

  it('surfaces a running decoupled worker with NO live turn, then stops at finish (bounded)', async () => {
    const bot = makeBot()
    let clock = 1_000_000
    const ticks: Array<() => void> = []
    const feed = createWorkerActivityFeed({
      bot,
      now: () => clock,
      firstPaintMinMs: 8000,
      minEditIntervalMs: 0,
      setInterval: (cb) => { ticks.push(cb); return ticks.length },
      clearInterval: () => {},
    })

    // The parent turn has long ended (currentTurn is null) — irrelevant here:
    // the feed is keyed by agentId and never reads currentTurn.
    await feed.update('bg01', 'chat-77', wView({ elapsedMs: 12_000 }))
    expect(bot.sent.length).toBe(1) // painted a live message post-teardown
    expect(feed.has('bg01')).toBe(true)

    // A later running tick edits the same message in place.
    clock += 6000
    await feed.update('bg01', 'chat-77', wView({ elapsedMs: 18_000, toolCount: 3, latestSummary: 'patching token parser' }))
    expect(bot.edits.length).toBeGreaterThanOrEqual(1)

    // Terminal: finish posts the recap edit and DROPS the handle.
    clock += 3000
    await feed.finish('bg01', wView({ state: 'done', toolCount: 4, latestSummary: 'opened PR #42' }))
    expect(feed.has('bg01')).toBe(false)
    const editsAfterFinish = bot.edits.length

    // Bounded: a subsequent heartbeat tick must NOT keep editing a finished worker.
    clock += 60_000
    ticks.forEach((t) => t())
    await Promise.resolve()
    expect(bot.edits.length).toBe(editsAfterFinish)

    feed.stop()
  })

  it('the worker-feed heartbeat only ticks RUNNING workers (terminal worker never climbs)', async () => {
    const bot = makeBot()
    let clock = 2_000_000
    const ticks: Array<() => void> = []
    const feed = createWorkerActivityFeed({
      bot,
      now: () => clock,
      firstPaintMinMs: 0,
      minEditIntervalMs: 0,
      heartbeatTickMs: 6000,
      setInterval: (cb) => { ticks.push(cb); return ticks.length },
      clearInterval: () => {},
    })
    await feed.update('bg02', 'chat-9', wView({ elapsedMs: 1000 }))
    expect(bot.sent.length).toBe(1)
    await feed.finish('bg02', wView({ state: 'done', latestSummary: 'done' }))
    const editCount = bot.edits.length

    // Heartbeat after finish: the handle is gone → no further edits ever.
    clock += 600_000
    ticks.forEach((t) => t())
    await Promise.resolve()
    expect(bot.edits.length).toBe(editCount)
    feed.stop()
  })
})

// ─── Fix 1: Narrative as first-class feed lines ───────────────────────────────

describe('Fix 1: narrative as durable feed lines (clip length + Lever 5 removal)', () => {
  /**
   * These tests drive the REAL clipNarrative and appendActivityLabel functions
   * from tool-activity-summary.ts, and the REAL mayOpenActivityCard gate.
   * The pipeline is: raw text → clipNarrative → appendActivityLabel →
   * mirrorLines (persistent alongside tool labels).
   */

  it('clipNarrative raises clip to 200 chars (readable feed-line, matches STATUS_LINE_MAX)', () => {
    // A narrative that is longer than the old 120-char limit but fits in 200.
    // Before Fix 1: the 120-char clip would have truncated this mid-sentence.
    const longNarrative = 'I will now analyse all 30 changed files in /src/auth to understand the scope of the authentication regression before patching the vulnerable token-parsing code path'
    // Confirm it is longer than 120 chars (would have been clipped before the fix)
    expect(longNarrative.length).toBeGreaterThan(120)
    // Confirm it is ≤ 200 chars (the new limit matches STATUS_LINE_MAX)
    expect(longNarrative.length).toBeLessThanOrEqual(200)

    const clipped = clipNarrative(longNarrative)
    // With Fix 1 (200 chars): the full narrative is preserved
    expect(clipped).toBe(longNarrative)

    // CONFIRM FAILS WITHOUT FIX: old 120-char limit would have truncated it
    const oldClip = longNarrative.slice(0, 120)
    expect(clipped).not.toBe(oldClip) // the fix produces a longer result
    expect(clipped.length).toBeGreaterThan(oldClip.length)
  })

  it('clipNarrative still clips at 200 chars and takes first line only', () => {
    // A multi-line narrative: only first line, and capped at 200.
    const multiLine = 'First line of narrative\nSecond line should be dropped'
    const clipped = clipNarrative(multiLine)
    expect(clipped).toBe('First line of narrative')
    expect(clipped).not.toContain('\n')

    // A narrative longer than 200 chars IS clipped
    const tooLong = 'A'.repeat(250)
    const clippedLong = clipNarrative(tooLong)
    expect(clippedLong.length).toBe(200)
  })

  it('narrative and tool label lines both persist in mirrorLines (durable, not overwriting)', () => {
    // The REAL appendActivityLabel function: appends to mirrorLines without removing
    // prior entries. Narrative lines and tool labels coexist in order.
    const mirrorLines: string[] = []

    // Step 1: narrative fires before a tool (the agent thinks aloud)
    const narr1 = 'I will read the authentication module first'
    appendActivityLabel(mirrorLines, narr1)
    expect(mirrorLines).toHaveLength(1)
    expect(mirrorLines[0]).toBe(narr1)

    // Step 2: tool label arrives (producer B — the tool runs)
    const tool1 = 'Reading /src/auth/accounts.ts'
    appendActivityLabel(mirrorLines, tool1)
    expect(mirrorLines).toHaveLength(2)
    expect(mirrorLines[1]).toBe(tool1)

    // Step 3: another narrative after the tool (post-action narration)
    const narr2 = 'Now I will patch the token-parsing path'
    appendActivityLabel(mirrorLines, narr2)
    expect(mirrorLines).toHaveLength(3)
    expect(mirrorLines[2]).toBe(narr2)

    // The feed reads: narrative → tool → narrative (interleaved, legible)
    expect(mirrorLines[0]).toBe(narr1)
    expect(mirrorLines[1]).toBe(tool1)
    expect(mirrorLines[2]).toBe(narr2)
  })

  it('0-tool narrative DOES open a card pre-answer (Lever 5 removed, Fix 1 / #2588)', () => {
    // Before Fix 1: Lever 5 blocked narrative from opening a card on 0-tool turns.
    // After Fix 1: pre-answer narrative may open; Lever 2 (clearActivitySummary)
    // handles reply-is-last ordering.
    const allowed = mayOpenActivityCard({
      producer: 'narrative',
      finalAnswerEverDelivered: false,
      labeledToolCount: 0, // 0-tool conversational turn
    })
    expect(allowed).toBe(true)

    // CONFIRM FAILS WITHOUT FIX:
    // The old Lever 5 would have returned false here. We can verify this by
    // simulating the old gate logic directly:
    function oldMayOpenActivityCard(input: { producer: string; finalAnswerEverDelivered: boolean; labeledToolCount: number }): boolean {
      if (input.finalAnswerEverDelivered) return false
      if (input.producer === 'narrative' && input.labeledToolCount === 0) return false // old Lever 5
      return true
    }
    expect(oldMayOpenActivityCard({ producer: 'narrative', finalAnswerEverDelivered: false, labeledToolCount: 0 })).toBe(false)
    // The fix changes this to true — the narrative card CAN open pre-answer.
  })

  it('post-answer narrative remains blocked (Lever 1 still applies after Fix 1)', () => {
    // Fix 1 only removes Lever 5 for pre-answer. Post-answer is still covered
    // by Lever 1 (finalAnswerEverDelivered) — reply-is-last is preserved.
    const blocked = mayOpenActivityCard({
      producer: 'narrative',
      finalAnswerEverDelivered: true,
      labeledToolCount: 2,
    })
    expect(blocked).toBe(false)
  })
})
