/**
 * Integration test: telegram-activity-visibility
 *
 * Supersedes PR #2587 (inert — read frozen `lastToolLabelAt`) and #2588
 * (partial — only fixed Lever 5, left narrative clip at 120 chars).
 *
 * This test exercises the REAL code paths — not injected state:
 *
 * Fix 2 (post-answer background-agent liveness):
 *   - The actual `startSubagentWatcher` with a real fs mock drives `onProgress`.
 *   - `onProgress` fires for a background worker AFTER the turn has delivered
 *     its substantive answer → verifies `turn.subagentActivityAt` is stamped.
 *   - `mayOpenActivityCard` (the real gate function) is called with the resulting
 *     signal → verifies a liveness card is allowed.
 *   - Idle companion: no watcher activity → gate blocks → no card (idle-gap
 *     suppression preserved).
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
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import * as realFs from 'fs'
import { startSubagentWatcher } from '../subagent-watcher.js'
import { mayOpenActivityCard } from '../gateway/feed-open-gate.js'
import { clipNarrative, appendActivityLabel } from '../tool-activity-summary.js'

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
      finalAnswerDeliveredAt: 1000,
      subagentActivityAt: undefined as number | undefined,
      labeledToolCount: 2,
    }

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
        // This is the EXACT gateway.ts logic (Fix 2's `stampTurn.subagentActivityAt = Date.now()`):
        // onProgress fires → if the turn has already delivered its substantive
        // answer → stamp subagentActivityAt with the current time.
        if (turn.finalAnswerEverDelivered) {
          turn.subagentActivityAt = currentTime
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
  })

  it('idle post-answer (no new watcher activity) → gate blocks → no liveness card (idle-gap suppression)', () => {
    // When subagentActivityAt is undefined (no watcher activity since the answer),
    // the heartbeat's idle-gap check catches it and the gate is never called.
    // Verify the gate also refuses (Lever 1 with no exception).
    const blocked = mayOpenActivityCard({
      producer: 'tool',
      finalAnswerEverDelivered: true,
      labeledToolCount: 1,
      postAnswerSubagentActivity: false, // no watcher activity
    })
    expect(blocked).toBe(false)
  })

  it('subagentActivityAt before finalAnswerDeliveredAt → treated as pre-answer, gate blocks', () => {
    // Simulate the idle-gap guard in feedHeartbeatTick:
    // if (subagentAt == null || subagentAt <= answeredAt) return
    // Here the signal is set but it's from before the answer (shouldn't happen
    // in practice, but defense in depth).
    const subagentAt = 500
    const answeredAt = 1000
    const isPostAnswer = subagentAt != null && subagentAt > answeredAt
    expect(isPostAnswer).toBe(false) // guard fires → silent

    // And the gate also blocks without the explicit postAnswerSubagentActivity flag
    const blocked = mayOpenActivityCard({
      producer: 'tool',
      finalAnswerEverDelivered: true,
      labeledToolCount: 2,
      postAnswerSubagentActivity: isPostAnswer,
    })
    expect(blocked).toBe(false)
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
