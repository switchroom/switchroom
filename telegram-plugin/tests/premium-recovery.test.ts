/**
 * Unit tests for the "premium model recovered" ping.
 *
 *  - `decidePremiumRecovery` is the PURE recovery predicate: fires iff a marker
 *    is pending AND the broker shows the premium tier servable again (at least
 *    one account neither `exhausted` nor `premium_walled`) — the exact
 *    complement of the `all-blocked` condition that fired the downgrade. This
 *    IS the deterministic recovery signal: both fields are the broker's live-
 *    authoritative verdicts, so the ping never depends on model judgement.
 *  - `renderPremiumRecoveryPing` pins the honest, session-scoped wording +
 *    button label.
 *  - `premiumRecoveryClaimKey` keys the fleet-wide dedup on agent + token.
 *  - the `.premium-recovery` carrier round-trips + is shape-gated (parity with
 *    the `.session-model` / `.session-effort` carriers).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  decidePremiumRecovery,
  renderPremiumRecoveryPing,
  premiumRecoveryClaimKey,
} from '../premium-recovery.js'
import {
  writePremiumRecoveryFile,
  readPremiumRecoveryFile,
  clearPremiumRecoveryFile,
  parsePremiumRecovery,
  PREMIUM_RECOVERY_FILE,
} from '../gateway/session-model-file.js'

describe('decidePremiumRecovery — deterministic recovery predicate', () => {
  it('no marker → never fires', () => {
    expect(
      decidePremiumRecovery({ hasMarker: false, accounts: [{ exhausted: false, premiumWalled: false }] }),
    ).toEqual({ fire: false, reason: 'no-marker' })
  })

  it('marker pending but EVERY account still walled/exhausted → no fire (still-walled)', () => {
    const d = decidePremiumRecovery({
      hasMarker: true,
      accounts: [
        { exhausted: true, premiumWalled: false },
        { exhausted: false, premiumWalled: true },
        { exhausted: true, premiumWalled: true },
      ],
    })
    expect(d).toEqual({ fire: false, reason: 'still-walled' })
  })

  it('marker pending AND one account can serve the premium tier again → fire', () => {
    const d = decidePremiumRecovery({
      hasMarker: true,
      accounts: [
        { exhausted: true, premiumWalled: true },
        { exhausted: false, premiumWalled: false }, // recovered
      ],
    })
    expect(d).toEqual({ fire: true, reason: 'recovered' })
  })

  it('an account that is exhausted-but-not-premium-walled does NOT count as recovered', () => {
    // The premium tier is only servable on an account that is BOTH not
    // exhausted AND not premium-walled.
    const d = decidePremiumRecovery({
      hasMarker: true,
      accounts: [{ exhausted: true, premiumWalled: false }],
    })
    expect(d.fire).toBe(false)
  })

  it('an account that is premium-walled-but-not-exhausted does NOT count as recovered', () => {
    const d = decidePremiumRecovery({
      hasMarker: true,
      accounts: [{ exhausted: false, premiumWalled: true }],
    })
    expect(d.fire).toBe(false)
  })

  it('empty account list with a pending marker → no fire (nothing servable)', () => {
    expect(decidePremiumRecovery({ hasMarker: true, accounts: [] }).fire).toBe(false)
  })
})

describe('renderPremiumRecoveryPing — honest wording', () => {
  it('names the model, says available again, and offers a session-scoped switch', () => {
    const p = renderPremiumRecoveryPing('fable')
    expect(p.text).toContain('`fable`')
    expect(p.text.toLowerCase()).toContain('available again')
    expect(p.text.toLowerCase()).toContain('this session')
    expect(p.buttonText).toBe('Switch to fable')
    // Must NOT over-promise a durable pin.
    expect(p.text.toLowerCase()).not.toContain('permanently')
    expect(p.text.toLowerCase()).not.toContain('forever')
  })
})

describe('premiumRecoveryClaimKey', () => {
  it('keys the dedup on agent + token so different drops never collide', () => {
    expect(premiumRecoveryClaimKey('klanker', 'fable')).toBe('premium-recovery:klanker:fable')
    expect(premiumRecoveryClaimKey('klanker', 'fable')).not.toBe(
      premiumRecoveryClaimKey('klanker', 'opus'),
    )
  })
})

describe('.premium-recovery carrier — round-trip + shape gate', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'premium-recovery-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('write → read round-trips model + chats', () => {
    writePremiumRecoveryFile(dir, 'fable', ['12345', '67890'])
    const rec = readPremiumRecoveryFile(dir)
    expect(rec?.premiumModel).toBe('fable')
    expect(rec?.chats).toEqual(['12345', '67890'])
    expect(typeof rec?.ts).toBe('number')
  })

  it('clear removes the marker', () => {
    writePremiumRecoveryFile(dir, 'fable', ['12345'])
    expect(existsSync(join(dir, PREMIUM_RECOVERY_FILE))).toBe(true)
    clearPremiumRecoveryFile(dir)
    expect(existsSync(join(dir, PREMIUM_RECOVERY_FILE))).toBe(false)
    expect(readPremiumRecoveryFile(dir)).toBeNull()
  })

  it('refuses a non-canonical model token (shell-injection shape)', () => {
    expect(() => writePremiumRecoveryFile(dir, 'bad name; rm -rf /', ['12345'])).toThrow()
  })

  it('refuses an empty chat list (a marker with nowhere to ping is a bug)', () => {
    expect(() => writePremiumRecoveryFile(dir, 'fable', [])).toThrow()
  })

  it('parse rejects corrupt JSON / bad shape / bad token / empty chats', () => {
    expect(parsePremiumRecovery('{broken')).toBeNull()
    expect(parsePremiumRecovery(JSON.stringify({ premiumModel: 'fable', chats: [], ts: 1 }))).toBeNull()
    expect(
      parsePremiumRecovery(JSON.stringify({ premiumModel: 'bad;name', chats: ['1'], ts: 1 })),
    ).toBeNull()
    expect(
      parsePremiumRecovery(JSON.stringify({ premiumModel: 'fable', chats: [1, 2], ts: 1 })),
    ).toBeNull()
    expect(parsePremiumRecovery(JSON.stringify({ premiumModel: 'fable', chats: ['1'] }))).toBeNull()
  })

  it('read returns null on a corrupt on-disk marker (never a half-parsed record)', () => {
    writeFileSync(join(dir, PREMIUM_RECOVERY_FILE), '{not json\n')
    expect(readPremiumRecoveryFile(dir)).toBeNull()
  })
})
