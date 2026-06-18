import { describe, it, expect } from 'vitest'
import {
  recoverFromPollStall,
  POLL_STALL_EXIT_CODE,
} from '../gateway/poll-stall-recovery.js'

describe('recoverFromPollStall', () => {
  it('exits with code 1 — and NEVER 78 (78 = permanent quarantine)', () => {
    const codes: number[] = []
    recoverFromPollStall({ exit: (c) => { codes.push(c) }, log: () => {} })
    expect(codes).toEqual([1])
    expect(POLL_STALL_EXIT_CODE).toBe(1)
    expect(codes).not.toContain(78) // the sharp edge: quarantine on a transient stall
  })

  it('logs a recovery line carrying the agent name + the reason (no stop() await)', () => {
    const lines: string[] = []
    recoverFromPollStall({ exit: () => {}, log: (m) => { lines.push(m) }, agentName: 'carrie' })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('stall_recovery')
    expect(lines[0]).toContain('agent=carrie')
    expect(lines[0]).toContain('code=1')
    // documents WHY we don't await stop() — guards against a future revert
    expect(lines[0]).toMatch(/backoff|stop\(\)/)
  })

  it('exits exactly once', () => {
    let calls = 0
    recoverFromPollStall({ exit: () => { calls++ }, log: () => {} })
    expect(calls).toBe(1)
  })
})
