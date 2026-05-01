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
    expect(cancelCallCount - deleteCallCount).toBeLessThanOrEqual(2)
    // Sanity: there ARE delete sites today (3 of them).
    expect(deleteCallCount).toBeGreaterThanOrEqual(3)
  })

  it('every preAllocatedDrafts.delete is followed by cancelPlaceholderHeartbeat within 200 chars', () => {
    // Stronger pin: not just count match, but proximity. The cancel
    // must be on the next line or a couple lines later — not buried
    // 50 lines away in a different function.
    const deleteIdxs: number[] = []
    const re = /preAllocatedDrafts\.delete\s*\(/g
    let match: RegExpExecArray | null
    while ((match = re.exec(codeOnly)) != null) {
      deleteIdxs.push(match.index)
    }
    expect(deleteIdxs.length).toBeGreaterThan(0)
    for (const idx of deleteIdxs) {
      const window = codeOnly.slice(idx, idx + 300)
      expect(window).toMatch(/cancelPlaceholderHeartbeat\s*\(/)
    }
  })

  it('startPlaceholderHeartbeat is called inside the pre-alloc success branch', () => {
    // Sequencing: the start call must be inside the
    // `void sendMessageDraftFn!(...).then(...)` block — i.e. fires
    // only on successful pre-alloc, never on the error path.
    const successBlock = codeOnly.indexOf('preAllocatedDrafts.set(chat_id, { draftId, allocatedAt')
    expect(successBlock).toBeGreaterThan(0)
    const window = codeOnly.slice(successBlock, successBlock + 600)
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
})
