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
