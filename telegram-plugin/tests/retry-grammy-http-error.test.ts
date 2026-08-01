/**
 * Outcome test for the transient-network retry class, driven through the REAL
 * seam that carries the bug: a real grammy `Bot` whose injected `fetch` throws
 * a realistic transport error, wrapped by the real `createRetryApiCall` loop.
 *
 * Why not a hand-rolled `throw new Error('fetch failed')`: grammy never lets
 * that shape reach the retry loop. `Api.callMethod` catches every fetch
 * rejection and rethrows `toHttpError(method, sensitiveLogs, err)`
 * (grammy 1.44.0, out/core/client.js:58 → out/core/error.js:76-83), which
 * produces an `HttpError` whose message is `Network request for '<method>'
 * failed!` — the original `fetch failed` / `ECONNRESET` text is DROPPED unless
 * `client.sensitiveLogs` is on (it is off by default and we do not enable it,
 * because it leaks the bot token URL into logs).
 *
 * So the only honest test of "does a transport blip get retried" has to go
 * through grammy's own wrapping. Faking the error shape is what let the dead
 * branch ship green (#4117).
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { Bot, HttpError, GrammyError } from 'grammy'
import {
  createRetryApiCall,
  willRetryTelegramFailure,
  isTransientNetworkMessage,
  isTransientTransportError,
  type RetryObserver,
} from '../retry-api-call.js'
import { installTgPostLogger } from '../shared/bot-runtime.js'
import { detectGatewayFindings, scanAgent } from '../../src/fleet-health/detect.js'

afterEach(() => {
  vi.restoreAllMocks()
})

const TOKEN = '111111:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

function okResponse(result: unknown): Response {
  return new Response(JSON.stringify({ ok: true, result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * A real grammy Bot whose transport fails `failures` times with `err`, then
 * succeeds. Returns the bot plus the live call count.
 */
function makeBot(err: unknown, failures: number) {
  const calls = { n: 0 }
  const bot = new Bot(TOKEN, {
    botInfo: {
      id: 1,
      is_bot: true,
      first_name: 'test',
      username: 'test_bot',
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
    },
    client: {
      fetch: (async () => {
        calls.n += 1
        if (calls.n <= failures) throw err
        return okResponse({ message_id: 42, date: 0, chat: { id: 7, type: 'private' } })
      }) as unknown as typeof fetch,
    },
  })
  return { bot, calls }
}

describe('grammy transport failures reach the retry loop as HttpError', () => {
  it('grammy rewrites the transport message so the substring predicate cannot see it', async () => {
    const { bot } = makeBot(new TypeError('fetch failed'), 99)

    const caught = await bot.api.sendMessage(7, 'hi').then(
      () => null,
      (e: unknown) => e,
    )

    // The shape the retry loop actually receives.
    expect(caught).toBeInstanceOf(HttpError)
    expect(caught).not.toBeInstanceOf(GrammyError)
    expect((caught as HttpError).message).toBe("Network request for 'sendMessage' failed!")

    // ...and the original transport text is gone, so the substring classifier
    // used by the retry loop returns false on it. This is the defect.
    expect(isTransientNetworkMessage((caught as HttpError).message)).toBe(false)

    // The cause is preserved on `.error`, which is where the class lives.
    expect((caught as HttpError).error).toBeInstanceOf(TypeError)
  })
})

describe('retryApiCall retries a real grammy transport failure', () => {
  for (const [label, cause] of [
    ['fetch failed (undici)', new TypeError('fetch failed')],
    ['ECONNRESET', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })],
    ['ETIMEDOUT', Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' })],
    ['ENOTFOUND', Object.assign(new Error('getaddrinfo ENOTFOUND api.telegram.org'), {
      code: 'ENOTFOUND',
    })],
  ] as const) {
    it(`delivers the message after a transient ${label}`, async () => {
      const { bot, calls } = makeBot(cause, 1)
      const retries: string[] = []
      const observer: RetryObserver = {
        onRetry: ({ reason }) => {
          retries.push(reason)
        },
      }
      const retryApiCall = createRetryApiCall({
        sleep: async () => {},
        observer,
      })

      // OUTCOME: the send actually lands, and the loop actually retried.
      const res = await retryApiCall(() => bot.api.sendMessage(7, 'hi'), {
        verb: 'sendMessage',
      })

      expect(res).toMatchObject({ message_id: 42 })
      expect(calls.n).toBe(2)
      expect(retries).toEqual(['network'])
    })
  }

  it('does NOT retry a caller-initiated abort — shutdown must not stall', async () => {
    const aborted = Object.assign(new Error('The operation was aborted'), {
      name: 'AbortError',
      code: 'ABORT_ERR',
    })
    const { bot, calls } = makeBot(aborted, 99)
    const sleeps: number[] = []
    const retryApiCall = createRetryApiCall({
      sleep: async (ms: number) => {
        sleeps.push(ms)
      },
    })

    await expect(
      retryApiCall(() => bot.api.sendMessage(7, 'hi'), { verb: 'sendMessage' }),
    ).rejects.toBeInstanceOf(HttpError)

    // Terminal on the first attempt, and no backoff was slept.
    expect(calls.n).toBe(1)
    expect(sleeps).toEqual([])
  })

  it('DOES retry a grammy request timeout', async () => {
    const timedOut = new Error("Request to 'sendMessage' timed out after 500 seconds")
    const { bot, calls } = makeBot(timedOut, 1)
    const retryApiCall = createRetryApiCall({ sleep: async () => {} })

    const res = await retryApiCall(() => bot.api.sendMessage(7, 'hi'), {
      verb: 'sendMessage',
    })

    expect(res).toMatchObject({ message_id: 42 })
    expect(calls.n).toBe(2)
  })

  it('gives up after maxRetries when the transport never recovers', async () => {
    const { bot, calls } = makeBot(new TypeError('fetch failed'), 99)
    const retries: string[] = []
    const giveUps: number[] = []
    const retryApiCall = createRetryApiCall({
      maxRetries: 3,
      sleep: async () => {},
      observer: {
        onRetry: ({ reason }) => retries.push(reason),
        onGiveUp: ({ attempts }) => giveUps.push(attempts),
      },
    })

    await expect(
      retryApiCall(() => bot.api.sendMessage(7, 'hi'), { verb: 'sendMessage' }),
    ).rejects.toBeInstanceOf(HttpError)

    expect(calls.n).toBe(3)
    expect(retries).toEqual(['network', 'network'])
    expect(giveUps).toEqual([3])
  })

  it('does NOT retry a real GrammyError 403 that arrives over the same seam', async () => {
    const calls = { n: 0 }
    const bot = new Bot(TOKEN, {
      botInfo: {
        id: 1,
        is_bot: true,
        first_name: 'test',
        username: 'test_bot',
        can_join_groups: true,
        can_read_all_group_messages: false,
        supports_inline_queries: false,
        can_connect_to_business: false,
        has_main_web_app: false,
      },
      client: {
        fetch: (async () => {
          calls.n += 1
          return new Response(
            JSON.stringify({
              ok: false,
              error_code: 403,
              description: 'Forbidden: bot was blocked by the user',
            }),
            { status: 403, headers: { 'content-type': 'application/json' } },
          )
        }) as unknown as typeof fetch,
      },
    })

    const retryApiCall = createRetryApiCall({ sleep: async () => {} })

    await expect(
      retryApiCall(() => bot.api.sendMessage(7, 'hi'), { verb: 'sendMessage' }),
    ).rejects.toBeInstanceOf(GrammyError)

    // Terminal on the first attempt — a 403 must never be retried.
    expect(calls.n).toBe(1)
  })
})

describe('the log tier and the retry policy agree about a transport blip', () => {
  /**
   * Full production composition: retry policy → tg-post transformer → real
   * grammy client → a fetch that blips once. Returns the gateway log lines
   * shaped exactly as `gateway-supervisor.log` carries them, so the REAL
   * fleet-health detector can be run over them.
   */
  async function gatewayLinesForBlip(failures: number): Promise<{
    lines: string[]
    threw: boolean
  }> {
    const written: string[] = []
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      written.push(String(chunk))
      return true
    }) as unknown as typeof process.stderr.write)
    let threw = false
    try {
      const { bot } = makeBot(new TypeError('fetch failed'), failures)
      installTgPostLogger(bot)
      const retryApiCall = createRetryApiCall({ sleep: async () => {} })
      // `sendRichMessage` is the user-facing reply verb the fleet-health
      // `reply-delivery-failure` signature is scoped to (detect.ts:169) — using
      // any other method would make the detector assertions below vacuous.
      await retryApiCall(() =>
        bot.api.sendRichMessage(4242, { markdown: 'the answer' }),
      ).catch(() => {
        threw = true
      })
    } finally {
      spy.mockRestore()
    }
    const lines = written
      .filter((l) => l.startsWith('tg-post '))
      .map((l) => `2026-08-01T12:00:00Z gateway: ${l.trimEnd()}`)
    return { lines, threw }
  }

  it('blip-then-ok: the reply lands, the blip logs status=retry, nothing escalates', async () => {
    const { lines, threw } = await gatewayLinesForBlip(1)

    // Ground truth: the reply WAS delivered. Without this the rest is vacuous.
    expect(threw).toBe(false)
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain('status=ok')

    // The blip is on the log, honestly labelled as an ATTEMPT — not an outcome.
    expect(lines[0]).toContain('status=retry')
    expect(lines[0]).toContain('err=HttpError')

    // THE outcome: fleet-health raises nothing for a delivered reply.
    const joined = lines.join('\n')
    expect(detectGatewayFindings('alpha', joined).gw_hits['reply-delivery-failure']).toBe(0)
    expect(scanAgent('alpha', '', joined).escalate).toBe(false)
  })

  it('transport down for every attempt: exactly one delivery-failure alert', async () => {
    const { lines, threw } = await gatewayLinesForBlip(99)

    expect(threw).toBe(true)
    // Three attempts: two survivable, the last one terminal.
    expect(lines).toHaveLength(3)
    expect(lines.filter((l) => l.includes('status=retry'))).toHaveLength(2)
    expect(lines.filter((l) => l.includes('status=err'))).toHaveLength(1)

    // One alert for one lost answer — not one per attempt, not zero.
    const joined = lines.join('\n')
    expect(detectGatewayFindings('alpha', joined).gw_hits['reply-delivery-failure']).toBe(1)
    expect(scanAgent('alpha', '', joined).escalate).toBe(true)
  })
})

describe('isTransientTransportError keeps the non-retryable classes out', () => {
  it('excludes local resource exhaustion even when grammy wrapped it', () => {
    const enospc = Object.assign(new Error('ENOSPC: no space left on device'), {
      code: 'ENOSPC',
    })
    expect(isTransientTransportError(enospc)).toBe(false)
    // #2923: retrying a local disk failure in a tight loop is what tripped the
    // per-bot flood ban. Wrapping it in an HttpError must not make it retryable.
    expect(
      isTransientTransportError(new HttpError("Network request for 'sendMessage' failed!", enospc)),
    ).toBe(false)
  })

  it('excludes every GrammyError (Telegram answered — that IS the outcome)', () => {
    for (const code of [400, 403, 404]) {
      const err = new GrammyError(
        'Call to sendMessage failed!',
        { ok: false, error_code: code, description: 'nope' },
        'sendMessage',
        {},
      )
      expect(isTransientTransportError(err)).toBe(false)
    }
  })

  it('excludes a caller-initiated abort, but NOT a grammy request timeout', () => {
    // `bot.stop()` / an explicit AbortSignal aborts the fetch. Retrying that
    // three times just re-aborts and adds backoff sleeps to shutdown.
    const aborted = Object.assign(new Error('The operation was aborted'), {
      name: 'AbortError',
      code: 'ABORT_ERR',
    })
    expect(
      isTransientTransportError(
        new HttpError("Network request for 'sendMessage' failed!", aborted),
      ),
    ).toBe(false)

    // grammy's OWN timeout is a different object: `createTimeout` rejects the
    // race with a plain Error BEFORE aborting the controller
    // (grammy 1.44.0, out/core/client.js:168-178). That IS transient.
    expect(
      isTransientTransportError(
        new HttpError(
          "Network request for 'sendMessage' failed!",
          new Error("Request to 'sendMessage' timed out after 500 seconds"),
        ),
      ),
    ).toBe(true)
  })

  it('excludes an unrelated programming error', () => {
    expect(isTransientTransportError(new TypeError('x is not a function'))).toBe(false)
    expect(isTransientTransportError(undefined)).toBe(false)
  })

  it('accepts a transport error preserved through standard cause-chaining', () => {
    expect(
      isTransientTransportError(
        new Error('send failed', { cause: new TypeError('fetch failed') }),
      ),
    ).toBe(true)
  })
})

describe('willRetryTelegramFailure agrees with the loop for HttpError', () => {
  it('reports a mid-policy grammy transport failure as retryable', async () => {
    const { bot } = makeBot(new TypeError('fetch failed'), 99)
    const err = (await bot.api.sendMessage(7, 'hi').catch((e: unknown) => e)) as HttpError

    // Same fact the loop uses: attempt 0 of 3 ⇒ another attempt follows.
    expect(
      willRetryTelegramFailure(
        { errorCode: null, message: err.message, cause: err },
        { attempt: 0, maxRetries: 3, maxFloodSleepMs: 120_000 },
      ),
    ).toBe(true)
  })

  it('reports the LAST attempt as terminal', async () => {
    const { bot } = makeBot(new TypeError('fetch failed'), 99)
    const err = (await bot.api.sendMessage(7, 'hi').catch((e: unknown) => e)) as HttpError

    expect(
      willRetryTelegramFailure(
        { errorCode: null, message: err.message, cause: err },
        { attempt: 2, maxRetries: 3, maxFloodSleepMs: 120_000 },
      ),
    ).toBe(false)
  })

  it('reports a real GrammyError 403 as terminal', async () => {
    const err = new GrammyError(
      'Call to sendMessage failed!',
      { ok: false, error_code: 403, description: 'Forbidden' },
      'sendMessage',
      {},
    )
    expect(
      willRetryTelegramFailure(
        { errorCode: err.error_code, message: err.message, cause: err },
        { attempt: 0, maxRetries: 3, maxFloodSleepMs: 120_000 },
      ),
    ).toBe(false)
  })
})
