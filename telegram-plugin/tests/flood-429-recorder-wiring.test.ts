/**
 * The wiring proof: a 429 that reaches `retryApiCall` reaches the pressure
 * ledger.
 *
 * The classifier can be perfect and still useless if nothing feeds it. This
 * suite drives the REAL `createRetryApiCall` policy with a real `GrammyError`
 * carrying `parameters.retry_after`, wired exactly the way the gateway wires
 * it, and asserts the ledger on disk afterwards. It fails if the recorder's
 * ledger append is removed, if a future callsite stops going through
 * `makeFloodWaitRecorder`, or if `onFloodWait` stops firing for the long-ban
 * branch (the branch the 2026-07-27 incident took).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GrammyError } from 'grammy'

import { createRetryApiCall } from '../retry-api-call.js'
import { makeFloodWaitRecorder, floodStatePath, readFloodState } from '../flood-circuit-breaker.js'
import {
  classifyFlood429Pressure,
  flood429LedgerPath,
  readFlood429Ledger,
} from '../flood-429-ledger.js'

/** A 429 shaped like Telegram's, with the retry_after the gateway reads. */
function floodError(retryAfterSec: number): GrammyError {
  return new GrammyError(
    'Call to sendMessage failed!',
    {
      ok: false,
      error_code: 429,
      description: 'Too Many Requests: retry later',
      parameters: { retry_after: retryAfterSec },
    },
    'sendMessage',
    {},
  )
}

describe('429 → pressure ledger, through the real retry policy', () => {
  let dir: string
  let ledgerPath: string
  let statePath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flood-429-wiring-'))
    ledgerPath = flood429LedgerPath(dir)
    statePath = floodStatePath(dir)
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /** The gateway's own wiring shape (gateway.ts's `rawRobustApiCall`). */
  function apiCall(now: () => number) {
    return createRetryApiCall({
      log: () => {},
      sleep: async () => {},
      onFloodWait: (retryAfterSec) => makeFloodWaitRecorder(statePath, now)(retryAfterSec),
    })
  }

  it('records a long ban — the 2026-07-27 branch, which never sleeps', async () => {
    const ts = Date.parse('2026-07-27T20:19:56.704Z')
    await expect(
      apiCall(() => ts)(async () => {
        throw floodError(15908)
      }),
    ).rejects.toThrow()

    const episodes = readFlood429Ledger(ledgerPath)
    expect(episodes).toHaveLength(1)
    expect(episodes[0].peakRetryAfterSec).toBe(15908)
    expect(episodes[0].firstTs).toBe(ts)

    // And the breaker's own marker is still written — the ledger is additive.
    expect(readFloodState(statePath)?.retryAfterSec).toBe(15908)

    // World-readable: `switchroom doctor` runs as the operator, not the agent.
    expect(statSync(ledgerPath).mode & 0o777).toBe(0o644)
  })

  it('records a short slept-and-retried 429 too', async () => {
    const ts = Date.parse('2026-07-24T08:22:21.126Z')
    let attempts = 0
    const result = await apiCall(() => ts)(async () => {
      attempts += 1
      if (attempts === 1) throw floodError(3)
      return 'sent'
    })
    expect(result).toBe('sent')
    expect(readFlood429Ledger(ledgerPath)[0].peakRetryAfterSec).toBe(3)
  })

  it('accumulates across calls into a verdict the doctor would report', async () => {
    const first = Date.parse('2026-07-25T23:43:07.861Z')
    const second = Date.parse('2026-07-27T20:19:56.704Z')
    await expect(
      apiCall(() => first)(async () => {
        throw floodError(3713)
      }),
    ).rejects.toThrow()
    await expect(
      apiCall(() => second)(async () => {
        throw floodError(15908)
      }),
    ).rejects.toThrow()

    const verdict = classifyFlood429Pressure(
      readFlood429Ledger(ledgerPath),
      Date.parse('2026-07-28T01:00:00Z'),
    )
    expect(verdict?.status).toBe('fail')
    expect(verdict?.reason).toBe('repeat_penalty')
    expect(verdict?.detail).toContain('GROWING')
  })

  it('a non-429 failure leaves no ledger behind', async () => {
    await expect(
      apiCall(() => Date.now())(async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(readFlood429Ledger(ledgerPath)).toEqual([])
  })
})
