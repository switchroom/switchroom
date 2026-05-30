import { describe, expect, it } from 'vitest'
import type { Subagent } from '../registry/subagents-schema.js'
import { resolveWorkerFeedDispatch } from '../gateway/worker-feed-dispatch.js'

function makeSub(over: Partial<Subagent>): Subagent {
  return {
    id: 'toolu_01ABC',
    parent_session_id: null,
    parent_turn_key: null,
    agent_type: 'general-purpose',
    description: null,
    background: false,
    started_at: 0,
    last_activity_at: null,
    ended_at: null,
    status: 'running',
    result_summary: null,
    jsonl_agent_id: 'a37ad7639ae61476c',
    ...over,
  }
}

describe('resolveWorkerFeedDispatch (#2002 regression pin)', () => {
  it('uses the real registry description for the feed header, not the watcher label', () => {
    const sub = makeSub({ background: true, description: 'Background ten-step worker' })
    const out = resolveWorkerFeedDispatch(sub, 'sub-agent')
    expect(out.isBackground).toBe(true)
    expect(out.feedDescription).toBe('Background ten-step worker')
  })

  it('falls back to the watcher label when the registry row is missing', () => {
    const out = resolveWorkerFeedDispatch(null, 'sub-agent')
    expect(out.isBackground).toBe(false)
    expect(out.feedDescription).toBe('sub-agent')
  })

  it('falls back to the watcher label when the registry description is null', () => {
    const sub = makeSub({ background: true, description: null })
    const out = resolveWorkerFeedDispatch(sub, 'sub-agent')
    expect(out.isBackground).toBe(true)
    expect(out.feedDescription).toBe('sub-agent')
  })

  it('falls back to the watcher label when the registry description is empty', () => {
    const sub = makeSub({ background: true, description: '' })
    const out = resolveWorkerFeedDispatch(sub, 'sub-agent')
    expect(out.feedDescription).toBe('sub-agent')
  })

  it('reports a foreground sub-agent as not background', () => {
    const sub = makeSub({ background: false, description: 'inline helper' })
    const out = resolveWorkerFeedDispatch(sub, 'sub-agent')
    expect(out.isBackground).toBe(false)
    // description still resolves — callers gate on isBackground separately.
    expect(out.feedDescription).toBe('inline helper')
  })

  it('a missing row defaults isBackground false so the feed never fires blind', () => {
    // The gateway gates the feed on isBackground; a registry miss must not
    // flip a foreground turn into a background one.
    expect(resolveWorkerFeedDispatch(null, '').isBackground).toBe(false)
  })
})

// Deterministic PRNG (mulberry32) so a failing case is reproducible from the
// printed seed rather than flaking once and vanishing.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Adversarial description fragments the gateway might hand us — empty, the
// literal watcher placeholder, whitespace-only, control chars, multi-byte
// unicode/emoji, and a pathologically long task. A registry description is
// only "real" (must win the feed header) when it's a non-empty string.
const DESC_POOL: (string | null)[] = [
  null,
  '',
  'sub-agent',
  '   ',
  '\n\t',
  'Background ten-step worker',
  'Crawl the repo for dead code',
  '🔧 deploy · staging',
  'café — naïve façade',
  '0',
  'false',
  'a'.repeat(4096),
  'line1\nline2\nline3',
  'desc with "quotes" & <tags>',
]

const WATCHER_POOL = ['sub-agent', '', 'sub-agent ', 'fallback', '🤖', 'x'.repeat(512)]

describe('resolveWorkerFeedDispatch — randomized property sweep', () => {
  it('holds the #2002 invariants across 20k random registry rows', () => {
    for (let seed = 1; seed <= 20000; seed++) {
      const rng = mulberry32(seed)
      const pick = <T>(arr: T[]): T => arr[Math.floor(rng() * arr.length)]!

      const rowMissing = rng() < 0.25
      const background = rng() < 0.5
      const description = pick(DESC_POOL)
      const watcher = pick(WATCHER_POOL)
      const sub = rowMissing ? null : makeSub({ background, description })

      const out = resolveWorkerFeedDispatch(sub, watcher)
      const ctx = `seed=${seed} rowMissing=${rowMissing} bg=${background} desc=${JSON.stringify(description)} watcher=${JSON.stringify(watcher)}`

      // 1. Types are always concrete — the feed renderer never sees undefined.
      expect(typeof out.isBackground, ctx).toBe('boolean')
      expect(typeof out.feedDescription, ctx).toBe('string')

      // 2. isBackground mirrors the row (or false when missing) — a registry
      //    miss must never promote a foreground turn into a background one.
      expect(out.isBackground, ctx).toBe(rowMissing ? false : background)

      const realDescription =
        !rowMissing && typeof description === 'string' && description.length > 0

      if (realDescription) {
        // 3. THE bug guard: a real registry description always wins the header,
        //    regardless of the watcher's generic 'sub-agent' placeholder.
        expect(out.feedDescription, ctx).toBe(description)
      } else {
        // 4. Otherwise we fall back to exactly the watcher label, untouched.
        expect(out.feedDescription, ctx).toBe(watcher)
      }

      // 5. Pure + deterministic: identical inputs yield a deep-equal result.
      expect(resolveWorkerFeedDispatch(sub, watcher), ctx).toEqual(out)
    }
  })
})
