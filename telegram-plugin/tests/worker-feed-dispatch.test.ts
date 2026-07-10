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
    parent_agent_id: null,
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

describe('gateway onFinish — fix #1: resultText-driven handback fallback (model)', () => {
  // Mirrors the exact fallback gateway.ts's onFinish handler applies on top
  // of `resolveWorkerFeedDispatch`'s own result (gateway.ts, onFinish
  // handler, right after computing `dispatch`):
  //
  //   let isBackground = dispatch.isBackground
  //   if (!dispatch.hasRow && entryBackground == null && resultText.trim().length > 0) {
  //     isBackground = true
  //   }
  //
  // This is the worst case of the #1 bug: the DB row was never linked
  // (unlinked `jsonl_agent_id`) AND the watcher's own cached
  // `entry.background` was also never observed (both `resolveWorkerFeedDispatch`
  // fallbacks came up empty). A finished worker with actual narrative
  // result text is far more likely a dropped background handback than a
  // legitimate foreground no-op, so this degrades to background rather
  // than silently discarding the result.
  function applyOnFinishBackgroundFallback(
    dispatch: { isBackground: boolean; hasRow: boolean },
    entryBackground: boolean | undefined,
    resultText: string,
  ): boolean {
    let isBackground = dispatch.isBackground
    if (!dispatch.hasRow && entryBackground == null && resultText.trim().length > 0) {
      isBackground = true
    }
    return isBackground
  }

  it('meta-missing path: no row, no entry.background, non-empty resultText → routes a handback', () => {
    const dispatch = resolveWorkerFeedDispatch(null, 'sub-agent', undefined)
    const result = applyOnFinishBackgroundFallback(dispatch, undefined, 'Here is what I found...')
    expect(result).toBe(true)
  })

  it('no-fuzzy-candidate path: no row, no entry.background, non-empty resultText → routes a handback', () => {
    // Same shape as above — the ambiguous-fuzzy-match-refused case (fix #3)
    // also leaves jsonl_agent_id unlinked, landing in the same no-row state.
    const dispatch = resolveWorkerFeedDispatch(null, 'sub-agent', undefined)
    const result = applyOnFinishBackgroundFallback(dispatch, undefined, 'Task complete: 3 files changed.')
    expect(result).toBe(true)
  })

  it('empty resultText with no row/no entry.background does NOT escalate (true foreground no-op preserved)', () => {
    const dispatch = resolveWorkerFeedDispatch(null, 'sub-agent', undefined)
    const result = applyOnFinishBackgroundFallback(dispatch, undefined, '   ')
    expect(result).toBe(false)
  })

  it('entry.background=false (watcher DID observe it as foreground) is trusted over resultText', () => {
    const dispatch = resolveWorkerFeedDispatch(null, 'sub-agent', false)
    const result = applyOnFinishBackgroundFallback(dispatch, false, 'Some prose result anyway.')
    expect(result).toBe(false)
  })

  it('entry.background=true (watcher DID observe it) is trusted directly, no resultText fallback needed', () => {
    const dispatch = resolveWorkerFeedDispatch(null, 'sub-agent', true)
    const result = applyOnFinishBackgroundFallback(dispatch, true, '')
    expect(result).toBe(true)
  })

  it('a present DB row is authoritative — the resultText fallback never overrides a real foreground row', () => {
    const sub = makeSub({ background: false })
    const dispatch = resolveWorkerFeedDispatch(sub, 'sub-agent', undefined)
    const result = applyOnFinishBackgroundFallback(dispatch, undefined, 'Long narrative result...')
    expect(result).toBe(false)
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

describe('resolveWorkerFeedDispatch — fix #1(+#2): entryBackground fallback', () => {
  it('falls back to entryBackground=true when the registry row is missing (unlinked jsonl_agent_id)', () => {
    // Simulates onFinish firing for a background worker whose DB row was
    // never linked via `jsonl_agent_id` (meta.json missing, or the fuzzy
    // backfill match never fired) — the watcher's own cached
    // `entry.background` (seeded at dispatch time / kept fresh by
    // `readSubTail`'s liveness lookup) is the only signal left.
    const out = resolveWorkerFeedDispatch(null, 'sub-agent', true)
    expect(out.isBackground).toBe(true)
    expect(out.hasRow).toBe(false)
  })

  it('falls back to entryBackground=false when the row is missing and the entry was foreground', () => {
    const out = resolveWorkerFeedDispatch(null, 'sub-agent', false)
    expect(out.isBackground).toBe(false)
  })

  it('defaults to false when the row is missing AND entryBackground was never observed (undefined)', () => {
    // Both fallbacks come up empty — worst case, matches pre-fix
    // behaviour (isBackground=false) at the resolver level. The gateway's
    // onFinish handler applies its OWN further fallback on top of this
    // (routing a handback anyway when resultText is non-empty) — that's
    // pinned separately in the gateway-level test, not here.
    const out = resolveWorkerFeedDispatch(null, 'sub-agent', undefined)
    expect(out.isBackground).toBe(false)
    expect(out.hasRow).toBe(false)
  })

  it('a present registry row always wins over entryBackground, even when they disagree', () => {
    // The DB row is the authoritative source whenever it's actually
    // linked — entryBackground is a pure fallback for the unlinked case,
    // never a second vote.
    const sub = makeSub({ background: true })
    const out = resolveWorkerFeedDispatch(sub, 'sub-agent', false)
    expect(out.isBackground).toBe(true)
  })

  it('omitting entryBackground entirely preserves prior 2-arg call-site behaviour', () => {
    // #2002-era callers pass only 2 args — the optional 3rd param must not
    // change their observed result.
    expect(resolveWorkerFeedDispatch(null, 'sub-agent')).toEqual(
      resolveWorkerFeedDispatch(null, 'sub-agent', undefined),
    )
  })
})

describe('resolveWorkerFeedDispatch — nested/row-presence signals (unified progress cards)', () => {
  it('hasRow=false for a missing registry row (never silently foreground-nest it)', () => {
    const out = resolveWorkerFeedDispatch(null, 'sub-agent')
    expect(out.hasRow).toBe(false)
    expect(out.isNested).toBe(false)
  })

  it('hasRow=true for any present row', () => {
    expect(resolveWorkerFeedDispatch(makeSub({}), 'sub-agent').hasRow).toBe(true)
  })

  it('isNested=true when parent_agent_id is set (depth-2+ dispatch)', () => {
    const sub = makeSub({ parent_agent_id: 'ac15e1e3528f421d6', background: false })
    const out = resolveWorkerFeedDispatch(sub, 'sub-agent')
    expect(out.isNested).toBe(true)
    // Its own background flag stays honest — the caller ORs isNested in.
    expect(out.isBackground).toBe(false)
  })

  it('isNested=false for a main-session dispatch (parent_agent_id null)', () => {
    expect(resolveWorkerFeedDispatch(makeSub({ parent_agent_id: null }), 's').isNested).toBe(false)
  })
})
