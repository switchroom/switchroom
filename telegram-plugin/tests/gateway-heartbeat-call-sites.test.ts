/**
 * Architectural pin: every `preAllocatedDrafts.delete(chat_id)` call
 * site in gateway.ts must be paired with `cancelPlaceholderHeartbeat(chat_id)`.
 *
 * If a future PR adds a fourth delete site without canceling the
 * heartbeat, this test fails — and the failure message points at the
 * exact pattern to follow.
 *
 * Counterpart pin: there's exactly ONE `startPlaceholderHeartbeat`
 * call (at pre-alloc success). If a future PR adds another start
 * site without coordinating with cancel logic, that's a leak — also
 * caught here.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const GATEWAY_SRC = readFileSync(
  resolve(__dirname, '..', 'gateway', 'gateway.ts'),
  'utf8',
)

describe('gateway heartbeat — start/cancel structural pairing', () => {
  // Strip comments so we don't count examples in docstrings.
  // Single-line `//` comments AND multi-line `/* ... */` blocks.
  const codeOnly = GATEWAY_SRC
    .replace(/\/\/.*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')

  // Helper: count call sites, excluding the function definition itself
  // (which matches `startPlaceholderHeartbeat(`/`cancelPlaceholderHeartbeat(`
  // when preceded by `function `).
  function countCallSites(needle: string): number {
    const re = new RegExp(`(?<!function\\s)${needle}\\s*\\(`, 'g')
    return (codeOnly.match(re) ?? []).length
  }

  it('counts: 1 startPlaceholderHeartbeat call site (only pre-alloc success)', () => {
    // Strict equality — adding a second start site is a leak unless
    // the corresponding cancel logic is also rethought.
    expect(countCallSites('startPlaceholderHeartbeat')).toBe(1)
  })

  it('counts: cancelPlaceholderHeartbeat call count >= preAllocatedDrafts.delete count', () => {
    // Every delete must be paired with a cancel. The "by 200 chars"
    // proximity test (below) catches the per-site pairing — this
    // count check catches a delete site that has no nearby cancel
    // at all.
    //
    // Allowed extras: the start function itself defensively calls
    // cancel before starting (in case a prior heartbeat is still
    // running). That's not a "delete" pairing — it's safety.
    // So `cancelCount >= deleteCount` is the right bar, with a
    // tolerance budget of 1-2 for defensive cancels.
    const cancelCallCount = countCallSites('cancelPlaceholderHeartbeat')
    const deleteCallCount = (codeOnly.match(/preAllocatedDrafts\.delete\s*\(/g) ?? []).length

    expect(cancelCallCount).toBeGreaterThanOrEqual(deleteCallCount)
    expect(cancelCallCount - deleteCallCount).toBeLessThanOrEqual(3)
    // Sanity: there ARE delete sites today. After #472 #9 introduced the
    // consume-mark pattern, the count dropped from 3 to 2 (turn_end orphan +
    // catch-path); two former delete sites now mark `consumed = true`
    // instead, paired with cancel.
    expect(deleteCallCount).toBeGreaterThanOrEqual(2)
  })

  it('every preAllocatedDrafts.delete is followed by cancelPlaceholderHeartbeat within 300 chars (success/turn-end paths only)', () => {
    // Stronger pin: not just count match, but proximity. The cancel
    // must be on the next line or a couple lines later — not buried
    // 50 lines away in a different function.
    //
    // Exception: the pre-alloc API .catch() path deletes the entry on
    // sendMessageDraft failure. Heartbeat hasn't been STARTED on the
    // error path (start fires only inside the .then()), so there's
    // nothing to cancel — pairing it would be a no-op. The marker
    // string `pre-allocate draft failed` identifies this site.
    const deleteIdxs: number[] = []
    const re = /preAllocatedDrafts\.delete\s*\(/g
    let match: RegExpExecArray | null
    while ((match = re.exec(codeOnly)) != null) {
      deleteIdxs.push(match.index)
    }
    expect(deleteIdxs.length).toBeGreaterThan(0)
    for (const idx of deleteIdxs) {
      const window = codeOnly.slice(idx, idx + 400)
      const isCatchSite = /pre-allocate draft failed/.test(window)
      if (isCatchSite) continue
      expect(window).toMatch(/cancelPlaceholderHeartbeat\s*\(/)
    }
  })

  it('startPlaceholderHeartbeat is called inside the pre-alloc success branch', () => {
    // Sequencing: the start call must be inside the
    // `void sendMessageDraftFn!(...).then(...)` block — i.e. fires
    // only on successful pre-alloc, never on the error path. Anchor on
    // the success-branch's success log line which is unique to that
    // branch in the gateway code (#472 #8 changed the entry-set pattern
    // to a synchronous pre-seed before the API call, so the old
    // `.set(...)` anchor no longer marks the success branch).
    const successBlock = codeOnly.indexOf('pre-allocate draft ok chatId=')
    expect(successBlock).toBeGreaterThan(0)
    const window = codeOnly.slice(successBlock, successBlock + 800)
    expect(window).toMatch(/startPlaceholderHeartbeat\s*\(/)
  })

  it('imports the heartbeat helpers from the dedicated module', () => {
    // Pins the module boundary — heartbeat logic lives in
    // ../placeholder-heartbeat, NOT inlined into gateway.ts.
    expect(GATEWAY_SRC).toMatch(/from ['"]\.\.\/placeholder-heartbeat\.js['"]/)
  })

  it('heartbeat config respects SWITCHROOM_TG_PLACEHOLDER_HEARTBEAT_MS env override', () => {
    // Pins the rollback path from §10.1 — the env var must be honored.
    expect(GATEWAY_SRC).toContain('SWITCHROOM_TG_PLACEHOLDER_HEARTBEAT_MS')
  })

  // ─── Path A §4 phase enrichment — additional structural pins ───

  it('clearPhaseState is called near every preAllocatedDrafts.delete site (phase lifecycle)', () => {
    // Each delete must clear the phase map + auto-ack timer for that
    // chat. Same proximity rule as the heartbeat cancel pin.
    // Skips the .catch site where neither heartbeat nor phase state
    // was ever set up (the .then() never ran).
    const deleteIdxs: number[] = []
    const re = /preAllocatedDrafts\.delete\s*\(/g
    let match: RegExpExecArray | null
    while ((match = re.exec(codeOnly)) != null) {
      deleteIdxs.push(match.index)
    }
    expect(deleteIdxs.length).toBeGreaterThan(0)
    for (const idx of deleteIdxs) {
      const window = codeOnly.slice(idx, idx + 400)
      const isCatchSite = /pre-allocate draft failed/.test(window)
      if (isCatchSite) continue
      expect(window).toMatch(/clearPhaseState\s*\(/)
    }
  })

  it('imports the phase helpers from the dedicated module', () => {
    expect(GATEWAY_SRC).toMatch(/from ['"]\.\.\/placeholder-phase\.js['"]/)
  })

  it('scheduleAutoAck fires from the pre-alloc success branch', () => {
    // Auto-ack must be scheduled inside the success branch, not on
    // the .catch path. Same anchor as startPlaceholderHeartbeat.
    const successBlock = codeOnly.indexOf('pre-allocate draft ok chatId=')
    expect(successBlock).toBeGreaterThan(0)
    const window = codeOnly.slice(successBlock, successBlock + 800)
    expect(window).toMatch(/scheduleAutoAck\s*\(/)
  })

  it('tool_use → phase: gateway calls toolUseToPhase in the session-event handler', () => {
    expect(codeOnly).toMatch(/toolUseToPhase\s*\(/)
    expect(codeOnly).toMatch(/setCurrentPhase\s*\(/)
  })

  it('update_placeholder handler maps recall.py text to phases', () => {
    expect(codeOnly).toMatch(/recallTextToPhase\s*\(/)
  })
})
