/**
 * Issue #3373 follow-up (PR #3376 adversarial review) — guards for the
 * SendMessage-resume → feed re-surface seam.
 *
 * The #3376 fix has three links: the watcher fires `onResume` on jsonl growth
 * past a genuine terminal (pinned by subagent-watcher-resume-reregister.test.ts),
 * the gateway's `onResume` handler delegates to `handleWorkerResume`, and
 * `handleWorkerResume` calls `feed.resurrect(agentId)` to clear the terminal
 * `finalized` latch. The review found the middle + last links untested: deleting
 * the gateway handler (or gutting its body) left every test green. This file
 * closes both:
 *
 *   1. UNIT — `handleWorkerResume` calls `feed.resurrect` with the agentId,
 *      never throws when resurrect throws or the feed is absent, and always
 *      emits the re-surface audit line.
 *   2. SOURCE SCAN (mirrors permission-verdict-resume-guard.test.ts) — the
 *      gateway wires an `onResume:` callback into the watcher config AND that
 *      callback delegates to `handleWorkerResume`. Deleting the handler, or
 *      replacing the delegation with a no-op body, reds this suite.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { handleWorkerResume } from '../gateway/worker-feed-dispatch.js'

describe('handleWorkerResume (issue #3373 seam unit)', () => {
  it('calls feed.resurrect with the agentId and logs the re-surface line', () => {
    const calls: string[] = []
    const logs: string[] = []
    handleWorkerResume({ resurrect: (id) => calls.push(id) }, 'w1', (m) => logs.push(m))
    expect(calls).toEqual(['w1'])
    expect(logs.some((l) => l.includes('w1') && l.includes('RE-SURFACED'))).toBe(true)
  })

  it('a throwing resurrect is logged, never propagated (watcher poll loop safety)', () => {
    const logs: string[] = []
    expect(() =>
      handleWorkerResume(
        { resurrect: () => { throw new Error('boom') } },
        'w2',
        (m) => logs.push(m),
      ),
    ).not.toThrow()
    expect(logs.some((l) => l.includes('boom') && l.includes('w2'))).toBe(true)
    // The audit line still lands after the failure.
    expect(logs.some((l) => l.includes('RE-SURFACED'))).toBe(true)
  })

  it('a null/undefined feed (feed disabled) is a safe no-op that still audits', () => {
    const logs: string[] = []
    expect(() => handleWorkerResume(null, 'w3', (m) => logs.push(m))).not.toThrow()
    expect(logs.some((l) => l.includes('w3') && l.includes('RE-SURFACED'))).toBe(true)
  })
})

describe('gateway onResume wiring (issue #3373 source-scan guard)', () => {
  const __dirname = dirname(fileURLToPath(import.meta.url))
  const GATEWAY_SRC = readFileSync(
    resolve(__dirname, '..', 'gateway', 'gateway.ts'),
    'utf8',
  )

  it('the watcher config carries an onResume callback', () => {
    expect(/\bonResume:\s*\(/.test(GATEWAY_SRC)).toBe(true)
  })

  it('the onResume callback delegates to handleWorkerResume (not an inline no-op)', () => {
    // Match the `onResume: (…) => { … }` callback body and require the
    // delegation call inside it. A gutted handler (empty body / dropped
    // resurrect) fails here even though tsc stays green.
    const m = GATEWAY_SRC.match(/\bonResume:\s*\([^)]*\)\s*=>\s*\{([\s\S]*?)\n\s{14}\},/)
    expect(m, 'onResume callback not found in gateway.ts').not.toBeNull()
    expect(m![1]).toMatch(/\bhandleWorkerResume\s*\(/)
    expect(m![1]).toMatch(/\bworkerActivityFeed\b/)
  })

  it('handleWorkerResume is imported from worker-feed-dispatch (the tested seam)', () => {
    expect(
      /import\s*\{[^}]*\bhandleWorkerResume\b[^}]*\}\s*from\s*'\.\/worker-feed-dispatch\.js'/.test(
        GATEWAY_SRC,
      ),
    ).toBe(true)
  })
})
