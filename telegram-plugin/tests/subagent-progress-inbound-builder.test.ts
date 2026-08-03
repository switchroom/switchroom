/**
 * Pin the InboundMessage shape and decision logic for the synthetic
 * `subagent_progress` envelope (#1720 — mid-flight progress beat).
 *
 * Three load-bearing guarantees:
 *
 *   1. The `meta.source` string is `subagent_progress`. The MCP
 *      channel notification wraps it as
 *      `<channel source="subagent_progress">`; the parent agent's
 *      beat-3 hook keys on exactly that tag.
 *   2. `meta.expiresAt` is set on every envelope (`nowMs + 2 × interval`).
 *      Stale progress is a lie, so the spool's TTL filter MUST have a
 *      live numeric value to gate on.
 *   3. The spool dedup id derived via `meta.subagent_jsonl_id` +
 *      `meta.bucket_idx` is deterministic — same (jsonl id, bucket idx)
 *      always collapses to the same `s:progress:...` id, so a re-fire
 *      within the same window is structurally a no-op.
 */

import { describe, it, expect } from 'vitest'
import {
  buildSubagentProgressInbound,
  decideSubagentProgress,
  isEnvFlagOn,
  DEFAULT_PROGRESS_INTERVAL_MS,
  PROGRESS_DESC_MAX,
  PROGRESS_RESULT_MAX,
} from '../gateway/subagent-progress-inbound-builder.js'
import { spoolId } from '../gateway/inbound-spool.js'

const FIXED_NOW = 1_700_000_000_000
const INTERVAL_MS = DEFAULT_PROGRESS_INTERVAL_MS

describe('buildSubagentProgressInbound', () => {
  it('builds an envelope with the load-bearing meta.source and TTL', () => {
    const inbound = buildSubagentProgressInbound({
      ctx: {
        chatId: '12345',
        subagentJsonlId: 'jsonl-abc',
        taskDescription: 'Crawl the repo for dead code',
        latestSummary: 'scanning packages/server — 14 files in so far',
        elapsedMs: 7 * 60 * 1000,
        bucketIdx: 1,
        progressIntervalMs: INTERVAL_MS,
      },
      nowMs: FIXED_NOW,
    })
    expect(inbound.type).toBe('inbound')
    expect(inbound.chatId).toBe('12345')
    expect(inbound.user).toBe('subagent-watcher')
    expect(inbound.ts).toBe(FIXED_NOW)
    expect(inbound.messageId).toBe(FIXED_NOW)
    expect(inbound.meta.source).toBe('subagent_progress')
    expect(inbound.meta.subagent_jsonl_id).toBe('jsonl-abc')
    expect(inbound.meta.bucket_idx).toBe('1')
    // TTL: nowMs + 2 × interval. Numeric, parseable, > now.
    expect(inbound.meta.expiresAt).toBeDefined()
    const exp = Number(inbound.meta.expiresAt)
    expect(Number.isFinite(exp)).toBe(true)
    expect(exp).toBe(FIXED_NOW + 2 * INTERVAL_MS)
    // Body content
    expect(inbound.text).toContain('Crawl the repo for dead code')
    expect(inbound.text).toContain('scanning packages/server')
    expect(inbound.text).toMatch(/beat 3/)
  })

  it('handles an empty latest summary (tool-only worker) without breaking shape', () => {
    const inbound = buildSubagentProgressInbound({
      ctx: {
        chatId: '99',
        subagentJsonlId: 'jsonl-xyz',
        taskDescription: 'Run the suite',
        latestSummary: '',
        elapsedMs: 6 * 60 * 1000,
        bucketIdx: 1,
        progressIntervalMs: INTERVAL_MS,
      },
      nowMs: FIXED_NOW,
    })
    expect(inbound.meta.source).toBe('subagent_progress')
    expect(inbound.text).toContain('tool-only')
  })

  it('caps an over-long latest summary and description', () => {
    const inbound = buildSubagentProgressInbound({
      ctx: {
        chatId: '99',
        subagentJsonlId: 'jsonl-xyz',
        taskDescription: 'D'.repeat(PROGRESS_DESC_MAX + 500),
        latestSummary: 'L'.repeat(PROGRESS_RESULT_MAX + 5000),
        elapsedMs: 5 * 60 * 1000,
        bucketIdx: 1,
        progressIntervalMs: INTERVAL_MS,
      },
      nowMs: FIXED_NOW,
    })
    expect(inbound.text.length).toBeLessThan(
      PROGRESS_RESULT_MAX + PROGRESS_DESC_MAX + 800,
    )
    expect(inbound.text).toContain('…')
  })

  // Deterministic spoolId per bucket — the core #1720 guarantee.
  it('two envelopes with the same (jsonl id, bucket idx) yield IDENTICAL spoolIds', () => {
    const a = buildSubagentProgressInbound({
      ctx: {
        chatId: '12345',
        subagentJsonlId: 'jsonl-abc',
        taskDescription: 'x',
        latestSummary: 'first line',
        elapsedMs: 7 * 60 * 1000,
        bucketIdx: 1,
        progressIntervalMs: INTERVAL_MS,
      },
      nowMs: FIXED_NOW,
    })
    const b = buildSubagentProgressInbound({
      ctx: {
        chatId: '12345',
        subagentJsonlId: 'jsonl-abc',
        taskDescription: 'x',
        latestSummary: 'a DIFFERENT line, also in bucket 1',
        elapsedMs: 8 * 60 * 1000, // still bucket 1 (8 < 10)
        bucketIdx: 1,
        progressIntervalMs: INTERVAL_MS,
      },
      // Different nowMs — proves dedup is content-keyed, not ts-keyed.
      nowMs: FIXED_NOW + 60_000,
    })
    expect(spoolId(a)).toBe(spoolId(b))
    expect(spoolId(a)).toBe('s:progress:jsonl-abc:1')
  })

  it('different bucket idx → different spoolId (envelopes do NOT collapse)', () => {
    const bucket1 = buildSubagentProgressInbound({
      ctx: {
        chatId: '12345',
        subagentJsonlId: 'jsonl-abc',
        taskDescription: 'x',
        latestSummary: 'b1',
        elapsedMs: 7 * 60 * 1000,
        bucketIdx: 1,
        progressIntervalMs: INTERVAL_MS,
      },
      nowMs: FIXED_NOW,
    })
    const bucket2 = buildSubagentProgressInbound({
      ctx: {
        chatId: '12345',
        subagentJsonlId: 'jsonl-abc',
        taskDescription: 'x',
        latestSummary: 'b2',
        elapsedMs: 12 * 60 * 1000,
        bucketIdx: 2,
        progressIntervalMs: INTERVAL_MS,
      },
      nowMs: FIXED_NOW + 5 * 60 * 1000,
    })
    expect(spoolId(bucket1)).not.toBe(spoolId(bucket2))
  })

  // Supergroup topic routing (#status-channel-routing).
  it('carries top-level threadId AND meta.message_thread_id when ctx.threadId is set', () => {
    const inbound = buildSubagentProgressInbound({
      ctx: {
        chatId: '-100999',
        threadId: 7,
        subagentJsonlId: 'jsonl-abc',
        taskDescription: 'x',
        latestSummary: 'still going',
        elapsedMs: 7 * 60 * 1000,
        bucketIdx: 1,
        progressIntervalMs: INTERVAL_MS,
      },
      nowMs: FIXED_NOW,
    })
    expect(inbound.threadId).toBe(7)
    expect(inbound.meta.message_thread_id).toBe('7')
  })

  it('omits both thread carriers when ctx.threadId is absent (DM-shaped chat)', () => {
    const inbound = buildSubagentProgressInbound({
      ctx: {
        chatId: '12345',
        subagentJsonlId: 'jsonl-abc',
        taskDescription: 'x',
        latestSummary: 'y',
        elapsedMs: 7 * 60 * 1000,
        bucketIdx: 1,
        progressIntervalMs: INTERVAL_MS,
      },
      nowMs: FIXED_NOW,
    })
    expect(inbound.threadId).toBeUndefined()
    expect(inbound.meta.message_thread_id).toBeUndefined()
  })
})

describe('isEnvFlagOn — bool env parser', () => {
  it('treats unset / empty / 0 / false / no / off as OFF (case-insensitive, trimmed)', () => {
    for (const v of [undefined, '', '0', 'false', 'FALSE', 'False', 'no', 'NO', 'off', 'OFF', '  0  ', ' false ']) {
      expect(isEnvFlagOn(v), `value=${JSON.stringify(v)}`).toBe(false)
    }
  })
  it('treats 1 / true / yes / arbitrary non-empty as ON', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', 'on', 'enabled', 'kill', 'anything']) {
      expect(isEnvFlagOn(v), `value=${JSON.stringify(v)}`).toBe(true)
    }
  })
})

describe('decideSubagentProgress', () => {
  function baseInput(over: Partial<Parameters<typeof decideSubagentProgress>[0]> = {}) {
    return {
      disableEnvValue: undefined,
      isBackground: true,
      fleetChatId: '12345',
      ownerChatId: '999',
      subagentJsonlId: 'jsonl-abc',
      taskDescription: 'x',
      latestSummary: 'hi',
      elapsedMs: 7 * 60 * 1000,
      progressIntervalMs: INTERVAL_MS,
      lastBucketIdx: null,
      nowMs: FIXED_NOW,
      ...over,
    } as const
  }

  it('delivers when all gates pass; bucketIdx is floor(elapsed/interval)', () => {
    const d = decideSubagentProgress(baseInput())
    expect(d.deliver).toBe(true)
    if (d.deliver) {
      expect(d.bucketIdx).toBe(1)
      expect(d.chatId).toBe('12345')
      expect(d.inbound.meta.source).toBe('subagent_progress')
    }
  })

  it('kill-switch (SWITCHROOM_DISABLE_SUBAGENT_PROGRESS=1) skips delivery', () => {
    const d = decideSubagentProgress(baseInput({ disableEnvValue: '1' }))
    expect(d.deliver).toBe(false)
    if (!d.deliver) expect(d.reason).toBe('env-disabled')
  })

  it('kill-switch treats `false`/`no`/`off`/empty/unset as OFF (not enabled)', () => {
    for (const v of [undefined, '', '0', 'false', 'FALSE', 'False', 'no', 'NO', 'off', 'OFF', '  0  ', ' false ']) {
      const d = decideSubagentProgress(baseInput({ disableEnvValue: v }))
      expect(d.deliver, `value=${JSON.stringify(v)} should NOT be env-disabled`).toBe(true)
    }
  })

  it('kill-switch treats `1`/`true`/`yes`/arbitrary non-empty as ON', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', 'on', 'enabled', 'kill']) {
      const d = decideSubagentProgress(baseInput({ disableEnvValue: v }))
      expect(d.deliver, `value=${JSON.stringify(v)} should be env-disabled`).toBe(false)
      if (!d.deliver) expect(d.reason).toBe('env-disabled')
    }
  })

  it('foreground sub-agents skip (parent already sees the narrative)', () => {
    const d = decideSubagentProgress(baseInput({ isBackground: false }))
    expect(d.deliver).toBe(false)
    if (!d.deliver) expect(d.reason).toBe('foreground')
  })

  // #3233 — worker-feed-DISABLED legacy path: a contentless skeleton liveness
  // cue must NOT be relayed as a synthesized "still working" inbound (that
  // would be a blank card). It degrades to a no-op, deterministically, BEFORE
  // bucketing so it can never advance the bucket tracker.
  it('skeleton liveness cue is dropped (no blank card) even when every other gate would pass', () => {
    // Same input that DELIVERS in the happy-path test above (bucket 1, chat
    // resolves) — only `skeleton` flips it off. Empty summary mirrors the real
    // skeleton cue.
    const d = decideSubagentProgress(baseInput({ skeleton: true, latestSummary: '' }))
    expect(d.deliver).toBe(false)
    if (!d.deliver) expect(d.reason).toBe('skeleton-liveness')
  })

  it('skeleton suppression fires before bucketing — a background skeleton at bucket>=1 never delivers', () => {
    // ≤1 relay per interval is trivially satisfied: skeleton cues deliver ZERO
    // inbounds regardless of how many no-growth polls fire within a bucket.
    for (const elapsedMs of [7 * 60 * 1000, 8 * 60 * 1000, 9 * 60 * 1000]) {
      const d = decideSubagentProgress(baseInput({ skeleton: true, latestSummary: '', elapsedMs }))
      expect(d.deliver, `elapsedMs=${elapsedMs}`).toBe(false)
    }
  })

  it('a NON-skeleton cue with identical inputs still delivers (guard is skeleton-scoped, not summary-scoped)', () => {
    // Red-on-regression companion: proves the drop keys on `skeleton`, not on
    // the empty summary — a real tool-only cue (empty prose summary) still
    // delivers, so the guard cannot silently swallow genuine progress.
    const d = decideSubagentProgress(baseInput({ skeleton: false, latestSummary: '' }))
    expect(d.deliver).toBe(true)
  })

  it('falls back to owner chat when fleet chat is empty', () => {
    const d = decideSubagentProgress(baseInput({ fleetChatId: '' }))
    expect(d.deliver).toBe(true)
    if (d.deliver) expect(d.chatId).toBe('999')
  })

  it('no-chat when neither fleet nor owner resolves', () => {
    const d = decideSubagentProgress(baseInput({ fleetChatId: '', ownerChatId: '' }))
    expect(d.deliver).toBe(false)
    if (!d.deliver) expect(d.reason).toBe('no-chat')
  })

  it('first bucket (idx 0) is suppressed — ambient liveness is plenty for the opening window', () => {
    const d = decideSubagentProgress(baseInput({ elapsedMs: 60_000 }))
    expect(d.deliver).toBe(false)
    if (!d.deliver) expect(d.reason).toBe('first-bucket-suppressed')
  })

  it('same bucket as last fired is a no-op (dedup at the decision layer)', () => {
    const d = decideSubagentProgress(baseInput({ lastBucketIdx: 1 }))
    expect(d.deliver).toBe(false)
    if (!d.deliver) expect(d.reason).toBe('bucket-already-fired')
  })

  it('next bucket fires even when prior bucket already fired', () => {
    const d = decideSubagentProgress(baseInput({
      elapsedMs: 12 * 60 * 1000,
      lastBucketIdx: 1,
    }))
    expect(d.deliver).toBe(true)
    if (d.deliver) expect(d.bucketIdx).toBe(2)
  })

  it('missing-jsonl-id refuses to mint a non-deterministic envelope', () => {
    const d = decideSubagentProgress(baseInput({ subagentJsonlId: '' }))
    expect(d.deliver).toBe(false)
    if (!d.deliver) expect(d.reason).toBe('missing-jsonl-id')
  })

  // Supergroup topic routing (#status-channel-routing).
  it('threads to the origin topic when the origin (fleet) chat won', () => {
    const d = decideSubagentProgress(baseInput({ fleetChatId: '-100abc', originThreadId: 7 }))
    expect(d.deliver).toBe(true)
    if (d.deliver) {
      expect(d.inbound.threadId).toBe(7)
      expect(d.inbound.meta.message_thread_id).toBe('7')
    }
  })

  it('does NOT thread when falling back to the owner DM', () => {
    const d = decideSubagentProgress(baseInput({ fleetChatId: '', originThreadId: 7 }))
    expect(d.deliver).toBe(true)
    if (d.deliver) {
      expect(d.chatId).toBe('999')
      expect(d.inbound.threadId).toBeUndefined()
      expect(d.inbound.meta.message_thread_id).toBeUndefined()
    }
  })
})

// ─── msg-6897 misroute regression (2026-08-04): meta.chat_id is LOAD-BEARING ──
// Same turn-registration contract as the handback builder (see
// subagent-handback-inbound-builder.test.ts): without meta.chat_id the
// progress turn's channel XML has no chat_id, the gateway mints no turn atom
// (no `turns` row, no `turn-active.json`), and a worker dispatched from
// inside the progress turn can never be attributed to its chat/topic.
describe('buildSubagentProgressInbound — meta.chat_id turn registration (msg-6897)', () => {
  it('carries the origin chat as meta.chat_id', () => {
    const inbound = buildSubagentProgressInbound({
      ctx: {
        chatId: '-1004223464247',
        threadId: 77,
        subagentJsonlId: 'stem1',
        taskDescription: 'Topic work',
        latestSummary: 'still going',
        elapsedMs: 6 * 60_000,
        bucketIdx: 1,
        progressIntervalMs: 5 * 60_000,
      },
      nowMs: 1_700_000_000_000,
    })
    expect(inbound.meta.chat_id).toBe('-1004223464247')
    expect(inbound.meta.message_thread_id).toBe('77')
  })
})
