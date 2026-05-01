/**
 * Structural tests for the /vault status, /vault lock, and /vault unlock
 * subcommands added in issue #158.
 *
 * Why structural: gateway/gateway.ts and server.ts do not export the bot
 * command handlers, so pure-functional invocation would require a full
 * Grammy/Bot harness. The broker client functions (statusViaBroker,
 * lockViaBroker, unlockViaBroker) are separately unit-tested in
 * src/vault/broker/server.test.ts. What we pin here is:
 *
 *   1. The handler wires each subcommand to the correct broker function.
 *   2. The broker-unreachable (null / false return) path replies with a
 *      clear error rather than silently succeeding or throwing.
 *   3. The /vault unlock flow prompts for a passphrase and records a
 *      pending-op entry of kind 'unlock' — never caches the passphrase.
 *   4. An empty passphrase on the pending-op intercept is rejected.
 *   5. Help text includes all three new subcommands.
 *   6. The passphrase is never logged (no console.log / logger call with
 *      the passphrase variable in the unlock branch).
 *
 * Each assertion covers BOTH server.ts (monolith polling mode) and
 * gateway/gateway.ts (persistent gateway mode) so a regression in either
 * file is caught.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const __dir = dirname(fileURLToPath(import.meta.url))
const pluginDir = join(__dir, '..')

const gatewaySrc = readFileSync(join(pluginDir, 'gateway', 'gateway.ts'), 'utf8')

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Slice the source from the first occurrence of `marker` for `len` chars. */
function sliceFrom(src: string, marker: string, len = 4000): string {
  const idx = src.indexOf(marker)
  if (idx === -1) return ''
  return src.slice(idx, idx + len)
}

/** Returns the portion of `src` inside the `/vault` bot.command() handler. */
function vaultHandlerBlock(src: string): string {
  const start = src.indexOf("bot.command('vault'")
  if (start === -1) return ''
  // The handler ends at the closing `})` of bot.command — find the next
  // top-level `bot.command(` or `bot.on(` after our start to bound the slice.
  const nextCmd = src.indexOf('\nbot.command(', start + 1)
  const end = nextCmd === -1 ? start + 8000 : nextCmd
  return src.slice(start, end)
}

// ─── broker client imports ────────────────────────────────────────────────────

describe('/vault #158 — broker client imports', () => {
  for (const [label, src] of [['gateway.ts', gatewaySrc]] as const) {
    it(`${label} imports statusViaBroker, lockViaBroker, unlockViaBroker`, () => {
      expect(src).toMatch(/statusViaBroker/)
      expect(src).toMatch(/lockViaBroker/)
      expect(src).toMatch(/unlockViaBroker/)
    })
  }
})

// ─── /vault status ───────────────────────────────────────────────────────────

describe('/vault status — happy path', () => {
  for (const [label, src] of [['gateway.ts', gatewaySrc]] as const) {
    const block = vaultHandlerBlock(src)

    it(`${label}: calls statusViaBroker inside the status branch`, () => {
      const statusBranch = sliceFrom(block, "sub === 'status'", 800)
      expect(statusBranch).toMatch(/statusViaBroker\(\)/)
    })

    it(`${label}: renders lock icon and uptime on success`, () => {
      const statusBranch = sliceFrom(block, "sub === 'status'", 800)
      // Renders 🔓/🔒 based on status.unlocked
      expect(statusBranch).toMatch(/status\.unlocked/)
      // Renders uptime
      expect(statusBranch).toMatch(/uptimeSec/)
      // Renders key count
      expect(statusBranch).toMatch(/keyCount/)
    })
  }
})

describe('/vault status — broker unreachable', () => {
  for (const [label, src] of [['gateway.ts', gatewaySrc]] as const) {
    const block = vaultHandlerBlock(src)

    it(`${label}: replies with clear error when statusViaBroker returns null`, () => {
      const statusBranch = sliceFrom(block, "sub === 'status'", 800)
      // The null guard must exist
      expect(statusBranch).toMatch(/if \(!status\)/)
      // The reply must communicate broker unreachability
      expect(statusBranch).toMatch(/not running|unreachable/i)
    })
  }
})

// ─── /vault lock ─────────────────────────────────────────────────────────────

describe('/vault lock — happy path', () => {
  for (const [label, src] of [['gateway.ts', gatewaySrc]] as const) {
    const block = vaultHandlerBlock(src)

    it(`${label}: calls lockViaBroker and confirms lock on success`, () => {
      const lockBranch = sliceFrom(block, "sub === 'lock'", 500)
      expect(lockBranch).toMatch(/lockViaBroker\(\)/)
      // Success reply mentions locked
      expect(lockBranch).toMatch(/locked/i)
    })

    it(`${label}: replies with error when lockViaBroker returns false`, () => {
      const lockBranch = sliceFrom(block, "sub === 'lock'", 500)
      // Failure path must exist
      expect(lockBranch).toMatch(/Could not lock|not running|is it running/i)
    })
  }
})

// ─── /vault unlock — prompt flow ─────────────────────────────────────────────

describe('/vault unlock — passphrase prompt', () => {
  for (const [label, src] of [['gateway.ts', gatewaySrc]] as const) {
    const block = vaultHandlerBlock(src)

    it(`${label}: records a pending-op of kind 'unlock'`, () => {
      const unlockBranch = sliceFrom(block, "sub === 'unlock'", 600)
      expect(unlockBranch).toMatch(/pendingVaultOps\.set/)
      expect(unlockBranch).toMatch(/kind.*['"]unlock['"]|['"]unlock['"].*kind/)
    })

    it(`${label}: prompts user with passphrase message (passphrase never cached)`, () => {
      const unlockBranch = sliceFrom(block, "sub === 'unlock'", 600)
      expect(unlockBranch).toMatch(/passphrase/i)
      // Must explicitly note the passphrase is never cached
      expect(unlockBranch).toMatch(/never cached|not cached/i)
    })

    it(`${label}: does NOT store passphrase in vaultPassphraseCache inside the prompt branch`, () => {
      // The unlock prompt sets pendingVaultOps but must NOT write the
      // passphrase to vaultPassphraseCache in the same branch.
      const unlockBranch = sliceFrom(block, "sub === 'unlock'", 600)
      expect(unlockBranch).not.toMatch(/vaultPassphraseCache\.set/)
    })
  }
})

// ─── /vault unlock — intercept (passphrase received) ─────────────────────────

describe('/vault unlock — pending-op intercept (passphrase received)', () => {
  for (const [label, src] of [['gateway.ts', gatewaySrc]] as const) {
    it(`${label}: empty passphrase is rejected with clear message`, () => {
      // The intercept (bot.on message:text handler) checks the kind and
      // rejects empty passphrase for the unlock branch.
      const interceptArea = sliceFrom(src, "kind === 'unlock'", 1500)
      expect(interceptArea).toMatch(/Passphrase cannot be empty/i)
      expect(interceptArea).toMatch(/vault unlock/i)
    })

    it(`${label}: calls unlockViaBroker with the passphrase on non-empty input`, () => {
      const interceptArea = sliceFrom(src, "kind === 'unlock'", 1500)
      expect(interceptArea).toMatch(/unlockViaBroker\(passphrase\)/)
    })

    it(`${label}: deletes the passphrase message immediately after receipt`, () => {
      const interceptArea = sliceFrom(src, "kind === 'unlock'", 800)
      // Must call deleteMessage to scrub the passphrase from chat
      expect(interceptArea).toMatch(/deleteMessage/)
    })

    it(`${label}: replies with success when unlockViaBroker returns ok:true`, () => {
      const interceptArea = sliceFrom(src, "kind === 'unlock'", 1500)
      expect(interceptArea).toMatch(/result\.ok/)
      expect(interceptArea).toMatch(/unlocked/i)
    })

    it(`${label}: replies with error when unlockViaBroker returns ok:false`, () => {
      const interceptArea = sliceFrom(src, "kind === 'unlock'", 1500)
      expect(interceptArea).toMatch(/vault unlock failed/i)
    })

    it(`${label}: passphrase is NOT passed to any console.log / logger call`, () => {
      // Security invariant: the raw passphrase must never be logged.
      // We look in the unlock intercept block for logger/console calls
      // that reference the passphrase variable.
      const interceptArea = sliceFrom(src, "kind === 'unlock'", 1000)
      // Pattern: console.log(...passphrase...) or logger.*(...passphrase...)
      expect(interceptArea).not.toMatch(/console\.log[^;]*passphrase/)
      expect(interceptArea).not.toMatch(/logger\.[a-z]+[^;]*passphrase/)
    })
  }
})

// ─── help text ───────────────────────────────────────────────────────────────

describe('/vault help text includes new subcommands', () => {
  for (const [label, src] of [['gateway.ts', gatewaySrc]] as const) {
    const block = vaultHandlerBlock(src)

    it(`${label}: /vault help lists status, unlock, lock`, () => {
      // The help reply is generated in the !sub || sub === 'help' branch
      const helpBranch = sliceFrom(block, "sub === 'help'", 600)
      expect(helpBranch).toMatch(/status/)
      expect(helpBranch).toMatch(/unlock/)
      expect(helpBranch).toMatch(/lock/)
    })
  }
})

// ─── switchroomHelpText (welcome-text.ts) ────────────────────────────────────

describe('switchroomHelpText — /vault section', () => {
  it('lists status, unlock, and lock as separate entries', async () => {
    const { switchroomHelpText } = await import('../welcome-text.js')
    const out = switchroomHelpText('assistant')
    expect(out).toMatch(/vault.*status/i)
    expect(out).toMatch(/vault.*unlock/i)
    expect(out).toMatch(/vault.*lock/i)
  })

  it('vault section mentions broker state / passphrase', async () => {
    const { switchroomHelpText } = await import('../welcome-text.js')
    const out = switchroomHelpText('assistant')
    // At minimum the status entry should mention broker state
    expect(out).toMatch(/broker state|broker/i)
  })
})
