/**
 * Tests for the prefix-cache warmup module.
 *
 * Per cold-start TTFO RFC Option A: fire a synthetic inbound on
 * bridge-up so Anthropic's prefix cache is warm by the user's next
 * real message. These tests pin: env gate, cooldown, missing-target
 * skip, message shape (meta.source="warmup", correct text), and
 * cooldown debounce across multiple bridge reconnects.
 */

import { describe, expect, it, beforeEach, vi } from 'vitest'
import {
  __resetForTests,
  maybeFireWarmup,
  WARMUP_TEXT,
} from '../gateway/prefix-warmup'
import type { WarmupCtx } from '../gateway/prefix-warmup'

beforeEach(() => {
  __resetForTests()
  delete process.env.SWITCHROOM_PREFIX_WARMUP
})

function makeCtx(overrides?: Partial<WarmupCtx>): {
  ctx: WarmupCtx
  send: ReturnType<typeof vi.fn>
  logs: string[]
} {
  const send = vi.fn()
  const logs: string[] = []
  const ctx: WarmupCtx = {
    selfAgent: 'test-agent',
    client: { send, agentName: 'test-agent', id: 'c1', isAlive: () => true, lastHeartbeat: 0, close: () => {} } as never,
    resolveBootTarget: () => ({ chatId: '12345', threadId: undefined }),
    log: (l: string) => logs.push(l),
    now: () => 1_000_000,
    ...overrides,
  }
  return { ctx, send, logs }
}

describe('maybeFireWarmup — env gate', () => {
  it('skipped when SWITCHROOM_PREFIX_WARMUP is unset', () => {
    const { ctx, send } = makeCtx()
    expect(maybeFireWarmup(ctx)).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('skipped when SWITCHROOM_PREFIX_WARMUP is 0', () => {
    process.env.SWITCHROOM_PREFIX_WARMUP = '0'
    const { ctx, send } = makeCtx()
    expect(maybeFireWarmup(ctx)).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('fires when SWITCHROOM_PREFIX_WARMUP=1', () => {
    process.env.SWITCHROOM_PREFIX_WARMUP = '1'
    const { ctx, send } = makeCtx()
    expect(maybeFireWarmup(ctx)).toBe(true)
    expect(send).toHaveBeenCalledTimes(1)
  })
})

describe('maybeFireWarmup — message shape', () => {
  beforeEach(() => {
    process.env.SWITCHROOM_PREFIX_WARMUP = '1'
  })

  it('tags meta.source="warmup"', () => {
    const { ctx, send } = makeCtx()
    maybeFireWarmup(ctx)
    const msg = send.mock.calls[0][0]
    expect(msg.meta.source).toBe('warmup')
  })

  it('uses synthetic messageId=0 and userId=0', () => {
    const { ctx, send } = makeCtx()
    maybeFireWarmup(ctx)
    const msg = send.mock.calls[0][0]
    expect(msg.messageId).toBe(0)
    expect(msg.userId).toBe(0)
    expect(msg.user).toBe('switchroom-warmup')
  })

  it('text carries the NO_REPLY instruction', () => {
    const { ctx, send } = makeCtx()
    maybeFireWarmup(ctx)
    const msg = send.mock.calls[0][0]
    expect(msg.text).toBe(WARMUP_TEXT)
    expect(msg.text).toContain('__WARMUP_PING__')
    expect(msg.text).toContain('NO_REPLY')
  })

  it('routes to the resolved boot chat', () => {
    process.env.SWITCHROOM_PREFIX_WARMUP = '1'
    const { ctx, send } = makeCtx({
      resolveBootTarget: () => ({ chatId: 'CHAT-9', threadId: 42 }),
    })
    maybeFireWarmup(ctx)
    const msg = send.mock.calls[0][0]
    expect(msg.chatId).toBe('CHAT-9')
    expect(msg.threadId).toBe(42)
  })

  it('omits threadId when boot target has none', () => {
    const { ctx, send } = makeCtx()
    maybeFireWarmup(ctx)
    const msg = send.mock.calls[0][0]
    expect(msg.threadId).toBeUndefined()
  })
})

describe('maybeFireWarmup — cooldown', () => {
  beforeEach(() => {
    process.env.SWITCHROOM_PREFIX_WARMUP = '1'
  })

  it('second call within cooldown is skipped', () => {
    const { ctx, send, logs } = makeCtx()
    expect(maybeFireWarmup(ctx)).toBe(true)
    // Same now() — well within cooldown.
    expect(maybeFireWarmup(ctx)).toBe(false)
    expect(send).toHaveBeenCalledTimes(1)
    expect(logs.some((l) => l.includes('reason=cooldown'))).toBe(true)
  })

  it('call after cooldown elapses fires again', () => {
    let t = 1_000_000
    const ctx = makeCtx({ now: () => t }).ctx
    expect(maybeFireWarmup(ctx)).toBe(true)
    t += 5 * 60_000 + 1 // just past cooldown
    expect(maybeFireWarmup(ctx)).toBe(true)
  })

  it('cooldown is per-agent', () => {
    const a = makeCtx({ selfAgent: 'agent-a' })
    const b = makeCtx({ selfAgent: 'agent-b' })
    expect(maybeFireWarmup(a.ctx)).toBe(true)
    expect(maybeFireWarmup(b.ctx)).toBe(true)
    expect(maybeFireWarmup(a.ctx)).toBe(false) // a in cooldown
    expect(maybeFireWarmup(b.ctx)).toBe(false) // b in cooldown
  })
})

describe('maybeFireWarmup — missing boot target', () => {
  beforeEach(() => {
    process.env.SWITCHROOM_PREFIX_WARMUP = '1'
  })

  it('skipped when no boot chat resolves', () => {
    const { ctx, send, logs } = makeCtx({ resolveBootTarget: () => null })
    expect(maybeFireWarmup(ctx)).toBe(false)
    expect(send).not.toHaveBeenCalled()
    expect(logs.some((l) => l.includes('reason=no-boot-chat-target'))).toBe(true)
  })
})

describe('maybeFireWarmup — send error handling', () => {
  beforeEach(() => {
    process.env.SWITCHROOM_PREFIX_WARMUP = '1'
  })

  it('caught send throw returns false and does not mark cooldown', () => {
    const send = vi.fn(() => {
      throw new Error('boom')
    })
    const ctx = makeCtx({
      client: { send } as never,
    }).ctx
    expect(maybeFireWarmup(ctx)).toBe(false)
    // Cooldown NOT recorded — next call should attempt again.
    expect(maybeFireWarmup(ctx)).toBe(false) // still throws
    expect(send).toHaveBeenCalledTimes(2)
  })
})
