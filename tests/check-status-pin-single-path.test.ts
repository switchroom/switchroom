/**
 * Teeth for the status-pin single-path fitness function.
 *
 * A guard that would not fail on the fork it exists to prevent is not a guard,
 * so every case below is a MUTATION: it feeds `findViolations` the exact shape
 * of source that #3831 (and its siblings) produced, and asserts the guard reds
 * with an actionable message. The clean cases guard the other direction — the
 * sanctioned modules and the marker escape must NOT red, or the check gets
 * disabled the first time someone hits a false positive.
 */
import { describe, it, expect } from 'vitest'
// @ts-expect-error — plain .mjs lint script, no types
import { findViolations, parseAllowlist } from '../scripts/check-status-pin-single-path.mjs'

const ALLOW = parseAllowlist(`
raw-pin-api :: telegram-plugin/status-pin-driver.ts :: the executor
raw-pin-api :: telegram-plugin/gateway/status-pin-api.ts :: the api surface
claim-store-write :: telegram-plugin/gateway/status-pin-store.ts :: the store
single-wiring :: telegram-plugin/gateway/gateway.ts :: the one wiring
`)

const rules = (v: Array<{ rule: string }>) => v.map((x) => x.rule)

function scan(path: string, source: string) {
  return findViolations({ path, source, allow: ALLOW }) as Array<{
    rule: string
    at: string
    fix: string
  }>
}

describe('raw pin API', () => {
  it('reds on a raw pinChatMessage in an unsanctioned file', () => {
    const v = scan(
      'telegram-plugin/worker-activity-feed.ts',
      `async function syncPin(id: number) {\n  await bot.api.pinChatMessage(chatId, id)\n}\n`,
    )
    expect(rules(v)).toEqual(['raw-pin-api'])
    expect(v[0].at).toBe('telegram-plugin/worker-activity-feed.ts:2')
    // The message must TELL the next engineer what to do instead.
    expect(v[0].fix).toContain('reconcileStatusPin')
  })

  it('reds on unpinChatMessage and unpinAllChatMessages too', () => {
    expect(
      rules(scan('telegram-plugin/x.ts', `await bot.api.unpinChatMessage(c, 1)\n`)),
    ).toEqual(['raw-pin-api'])
    expect(
      rules(scan('telegram-plugin/x.ts', `await bot.api.unpinAllChatMessages(c)\n`)),
    ).toEqual(['raw-pin-api'])
  })

  it('accepts a sanctioned file with no marker at all', () => {
    expect(
      scan('telegram-plugin/status-pin-driver.ts', `await api.pinChatMessage(c, 1)\n`),
    ).toEqual([])
  })

  it('accepts an inline marker WITH a reason, on the line or just above it', () => {
    expect(
      scan('telegram-plugin/x.ts', `await bot.api.pinChatMessage(c, 1) // allow-raw-pin: explicit tool pin\n`),
    ).toEqual([])
    expect(
      scan(
        'telegram-plugin/x.ts',
        `// allow-raw-pin: explicit tool pin\nawait bot.api.pinChatMessage(c, 1)\n`,
      ),
    ).toEqual([])
  })

  it('REJECTS a marker with no reason — a rubber stamp is not a justification', () => {
    expect(
      rules(scan('telegram-plugin/x.ts', `await bot.api.pinChatMessage(c, 1) // allow-raw-pin:\n`)),
    ).toEqual(['raw-pin-api'])
  })

  it('does not fire on a docblock that merely mentions the API', () => {
    expect(
      scan('telegram-plugin/x.ts', ` * calls pinChatMessage() under the hood\n`),
    ).toEqual([])
  })
})

describe('#3831 — a second decider / a second retarget expansion', () => {
  it('reds when any file but the orchestrator calls decidePinAction', () => {
    // This is the fork verbatim: the driver deciding for itself.
    const v = scan(
      'telegram-plugin/status-pin-driver.ts',
      `const action = decidePinAction(prevState, desired)\n`,
    )
    expect(rules(v)).toEqual(['single-decider'])
    expect(v[0].fix).toContain('runStatusPinReconcile')
  })

  it('reds when a second file NAMES a repin — the expansion cannot be re-forked', () => {
    const v = scan(
      'telegram-plugin/status-pin-driver.ts',
      `if (action.kind === 'repin') {\n  await reconcilePin({ ...args, desired: { pinned: false } })\n}\n`,
    )
    expect(rules(v)).toEqual(['single-expansion'])
  })

  it('has NO marker escape for either — there is no legitimate second decider', () => {
    expect(
      rules(
        scan(
          'telegram-plugin/status-pin-driver.ts',
          `const a = decidePinAction(p, d) // allow-raw-pin: I promise it is fine\n`,
        ),
      ),
    ).toEqual(['single-decider'])
  })

  it('leaves the orchestrator and the pure decision module alone', () => {
    expect(
      scan(
        'telegram-plugin/gateway/status-pin-retarget.ts',
        `const action = decidePinAction(prev, desired)\nif (action.kind === 'repin') {\n}\n`,
      ),
    ).toEqual([])
    expect(scan('telegram-plugin/status-pin.ts', `return { kind: 'repin', a, b }\n`)).toEqual([])
  })
})

describe('#3809 — the claim registry is never mutated out of band', () => {
  it('reds on a direct set/delete/clear, anywhere, including the gateway', () => {
    expect(
      rules(
        scan(
          'telegram-plugin/gateway/gateway.ts',
          `statusPinClaims.set(pinKey, { messageId, chatId, pinnedAt })\n`,
        ),
      ),
    ).toEqual(['claim-registry'])
    expect(
      rules(scan('telegram-plugin/gateway/gateway.ts', `statusPinClaims.delete(pinKey)\n`)),
    ).toEqual(['claim-registry'])
  })

  it('allows reads — the reaper and the DM sweep must be able to look', () => {
    expect(
      scan(
        'telegram-plugin/gateway/gateway.ts',
        `const claim = statusPinClaims.get(pinKey)\nfor (const c of statusPinClaims.values()) {}\n`,
      ),
    ).toEqual([])
  })
})

describe('durable store writes', () => {
  it('reds on a raw store write outside the store module', () => {
    const v = scan('telegram-plugin/gateway/gateway.ts', `await mutateStatusPinRow(p, fs, k, row)\n`)
    expect(rules(v)).toEqual(['claim-store-write'])
    expect(v[0].fix).toContain('persist-BEFORE-pin')
  })

  it('accepts the marker, and the store module itself', () => {
    expect(
      scan(
        'telegram-plugin/gateway/gateway.ts',
        `await mutateStatusPinRow(p, fs, k, row) // allow-raw-pin-store: tool pin bookkeeping\n`,
      ),
    ).toEqual([])
    expect(
      scan('telegram-plugin/gateway/status-pin-store.ts', `persistStatusPins(path, fs, rows)\n`),
    ).toEqual([])
  })
})

describe('a second wiring of the subsystem', () => {
  it('reds when a module other than the gateway composes orchestrator + driver', () => {
    const v = scan(
      'telegram-plugin/gateway/narrative-lane.ts',
      `await runStatusPinReconcile({ pinKey, chatId, prev, desired, persist, runPin, claims })\n`,
    )
    expect(rules(v)).toEqual(['single-wiring'])
    expect(v[0].fix).toContain('gateway.ts')
  })

  it('leaves the sanctioned wiring and the modules themselves alone', () => {
    expect(
      scan('telegram-plugin/gateway/gateway.ts', `await runStatusPinReconcile({})\n`),
    ).toEqual([])
    expect(scan('telegram-plugin/status-pin-driver.ts', `export async function executePinLeg(\n`)).toEqual([])
  })
})

describe('allowlist parsing', () => {
  it('throws on a malformed entry rather than silently granting nothing', () => {
    expect(() => parseAllowlist('raw-pin-api :: some/file.ts\n')).toThrow(/malformed entry/)
  })

  it('requires a reason on every entry', () => {
    expect(() => parseAllowlist('raw-pin-api :: some/file.ts :: \n')).toThrow(/malformed entry/)
  })

  it('ignores comments and blank lines', () => {
    const a = parseAllowlist('# a comment\n\nraw-pin-api :: f.ts :: because\n')
    expect(a.get('raw-pin-api').has('f.ts')).toBe(true)
  })
})
