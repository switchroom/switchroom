/**
 * Structural tests for the /vault grants list + revoke implementation
 * added in issue #228.
 *
 * Why structural: gateway/gateway.ts and server.ts do not export the bot
 * command handlers, so pure-functional invocation would require a full
 * Grammy/Bot harness. The broker client functions (listGrantsViaBroker,
 * revokeGrantViaBroker) are separately unit-tested in
 * src/vault/broker/server-grants.test.ts. What we pin here is:
 *
 *   1. Both server.ts and gateway/gateway.ts import listGrantsViaBroker and
 *      revokeGrantViaBroker from the broker client module.
 *   2. The /vault command handler contains a `grants` branch that calls
 *      listGrantsViaBroker.
 *   3. The grants list renders an inline keyboard with vg:revoke:<id> buttons.
 *   4. A callback_query handler intercepts vg: prefixed data in both files.
 *   5. The revoke callback handler invokes revokeGrantViaBroker on vg:confirm.
 *   6. The confirmation flow uses an intermediate vg:confirm/<vg:cancel> card
 *      (not immediate revoke on first tap) — two-step confirmation.
 *   7. /vault grants <agent> filter form parses the agent argument.
 *   8. Help text in both files mentions /vault grants.
 *   9. welcome-text.ts /vault section lists the grants subcommand.
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
  const nextCmd = src.indexOf('\nbot.command(', start + 1)
  const end = nextCmd === -1 ? start + 12000 : nextCmd
  return src.slice(start, end)
}

// ─── broker client imports ────────────────────────────────────────────────────

describe('/vault grants #228 — broker client imports', () => {
  for (const [label, src] of [['gateway.ts', gatewaySrc]] as const) {
    it(`${label} imports listGrantsViaBroker`, () => {
      expect(src).toMatch(/listGrantsViaBroker/)
    })

    it(`${label} imports revokeGrantViaBroker`, () => {
      expect(src).toMatch(/revokeGrantViaBroker/)
    })
  }
})

// ─── /vault grants dispatcher ────────────────────────────────────────────────

describe('/vault grants — dispatcher entry', () => {
  for (const [label, src] of [['gateway.ts', gatewaySrc]] as const) {
    const block = vaultHandlerBlock(src)

    it(`${label}: has a grants branch inside the vault handler`, () => {
      expect(block).toMatch(/sub === ['"]grants['"]/)
    })

    it(`${label}: grants branch calls listGrantsViaBroker`, () => {
      // Use a larger slice (2000) — the keyboard.text('vg:revoke') call comes ~1580 chars in
      const grantsBranch = sliceFrom(block, "sub === 'grants'", 2000)
      expect(grantsBranch).toMatch(/listGrantsViaBroker\(/)
    })
  }
})

// ─── /vault grants — list rendering ──────────────────────────────────────────

describe('/vault grants — list rendering wires to list_grants', () => {
  for (const [label, src] of [['gateway.ts', gatewaySrc]] as const) {
    const block = vaultHandlerBlock(src)

    it(`${label}: renders grouped grants with agent names as headers`, () => {
      const grantsBranch = sliceFrom(block, "sub === 'grants'", 2000)
      // Groups grants by agent_slug and renders agent name as a bold header
      expect(grantsBranch).toMatch(/agent_slug/)
      expect(grantsBranch).toMatch(/byAgent/)
    })

    it(`${label}: attaches inline keyboard with vg:revoke buttons`, () => {
      // keyboard.text('Revoke', 'vg:revoke:<id>') is ~1580 chars into the grants branch
      const grantsBranch = sliceFrom(block, "sub === 'grants'", 2000)
      expect(grantsBranch).toMatch(/vg:revoke:/)
      expect(grantsBranch).toMatch(/InlineKeyboard/)
    })

    it(`${label}: handles empty grants list with friendly message`, () => {
      const grantsBranch = sliceFrom(block, "sub === 'grants'", 2000)
      expect(grantsBranch).toMatch(/No active grants/)
    })

    it(`${label}: handles broker unreachable with error message`, () => {
      const grantsBranch = sliceFrom(block, "sub === 'grants'", 2000)
      expect(grantsBranch).toMatch(/unreachable/i)
    })
  }
})

// ─── /vault grants <agent> — filter form ─────────────────────────────────────

describe('/vault grants <agent> — agent filter argument', () => {
  for (const [label, src] of [['gateway.ts', gatewaySrc]] as const) {
    const block = vaultHandlerBlock(src)

    it(`${label}: parses optional agent argument from args`, () => {
      const grantsBranch = sliceFrom(block, "sub === 'grants'", 2000)
      // Agent filter is read from args[1]
      expect(grantsBranch).toMatch(/args\[1\]/)
    })

    it(`${label}: passes agentFilter to listGrantsViaBroker`, () => {
      const grantsBranch = sliceFrom(block, "sub === 'grants'", 2000)
      expect(grantsBranch).toMatch(/listGrantsViaBroker\(agentFilter\)/)
    })

    it(`${label}: filter note appears in empty-grants message when agent filter is set`, () => {
      const grantsBranch = sliceFrom(block, "sub === 'grants'", 2000)
      expect(grantsBranch).toMatch(/filterNote/)
    })
  }
})

// ─── vg: callback dispatch ────────────────────────────────────────────────────

describe('vg: callback query handler exists', () => {
  for (const [label, src] of [['gateway.ts', gatewaySrc]] as const) {
    it(`${label}: has a handler block that checks data.startsWith('vg:')`, () => {
      expect(src).toMatch(/data\.startsWith\(['"]vg:['"]\)/)
    })

    it(`${label}: has a revokeMatch handler for vg:revoke: prefix`, () => {
      // Use 'const revokeMatch' as a specific code marker (not a comment)
      expect(src).toMatch(/const revokeMatch = \/\^vg:revoke:/)
    })

    it(`${label}: has a confirmMatch handler for vg:confirm: prefix`, () => {
      expect(src).toMatch(/const confirmMatch = \/\^vg:confirm:/)
    })

    it(`${label}: has a cancelMatch handler for vg:cancel: prefix`, () => {
      expect(src).toMatch(/const cancelMatch = \/\^vg:cancel:/)
    })
  }
})

// ─── revoke callback — invokes revokeGrantViaBroker ──────────────────────────

describe('vg:confirm callback invokes revokeGrantViaBroker', () => {
  for (const [label, src] of [['gateway.ts', gatewaySrc]] as const) {
    it(`${label}: vg:confirm branch calls revokeGrantViaBroker with the grant ID`, () => {
      // Use 'const confirmMatch =' as the unique code marker (avoids comment occurrences)
      const confirmArea = sliceFrom(src, 'const confirmMatch = /^vg:confirm:', 800)
      expect(confirmArea).toMatch(/revokeGrantViaBroker\(grantId\)/)
    })

    it(`${label}: vg:confirm success replies with revoked confirmation text`, () => {
      const confirmArea = sliceFrom(src, 'const confirmMatch = /^vg:confirm:', 800)
      expect(confirmArea).toMatch(/revoked|Revoked/i)
    })

    it(`${label}: vg:confirm handles broker unreachable`, () => {
      const confirmArea = sliceFrom(src, 'const confirmMatch = /^vg:confirm:', 800)
      expect(confirmArea).toMatch(/unreachable/i)
    })

    it(`${label}: vg:confirm handles error result from broker`, () => {
      const confirmArea = sliceFrom(src, 'const confirmMatch = /^vg:confirm:', 800)
      expect(confirmArea).toMatch(/Revoke failed/i)
    })
  }
})

// ─── two-step confirmation flow ───────────────────────────────────────────────

describe('revoke flow uses two-step confirmation (no immediate revoke on first tap)', () => {
  for (const [label, src] of [['gateway.ts', gatewaySrc]] as const) {
    it(`${label}: vg:revoke tap shows confirmation card, not immediate revoke`, () => {
      // Use 'const revokeMatch =' as the unique code marker
      const revokeArea = sliceFrom(src, 'const revokeMatch = /^vg:revoke:', 1500)
      // Must show a confirmation card with confirm/cancel buttons
      expect(revokeArea).toMatch(/Confirm Revoke|confirm.*revoke/i)
      // Must NOT call revokeGrantViaBroker in the first-tap handler
      // (revokeGrantViaBroker is only called from confirmMatch, which appears later)
      const firstTapArea = sliceFrom(src, 'const revokeMatch = /^vg:revoke:', 900)
      expect(firstTapArea).not.toMatch(/revokeGrantViaBroker/)
    })

    it(`${label}: confirmation card shows vg:confirm and vg:cancel options`, () => {
      const revokeArea = sliceFrom(src, 'const revokeMatch = /^vg:revoke:', 1500)
      expect(revokeArea).toMatch(/vg:confirm:/)
      expect(revokeArea).toMatch(/vg:cancel:/)
    })
  }
})

// ─── vg:cancel — dismiss without revoke ──────────────────────────────────────

describe('vg:cancel dismisses without revoking', () => {
  for (const [label, src] of [['gateway.ts', gatewaySrc]] as const) {
    it(`${label}: vg:cancel does NOT call revokeGrantViaBroker`, () => {
      const cancelArea = sliceFrom(src, 'const cancelMatch = /^vg:cancel:', 500)
      expect(cancelArea).not.toMatch(/revokeGrantViaBroker/)
    })

    it(`${label}: vg:cancel clears the inline keyboard`, () => {
      const cancelArea = sliceFrom(src, 'const cancelMatch = /^vg:cancel:', 500)
      expect(cancelArea).toMatch(/editMessageReplyMarkup|inline_keyboard/)
    })
  }
})

// ─── help text ───────────────────────────────────────────────────────────────

describe('/vault help text includes grants subcommand', () => {
  for (const [label, src] of [['gateway.ts', gatewaySrc]] as const) {
    const block = vaultHandlerBlock(src)

    it(`${label}: /vault help lists grants subcommand`, () => {
      const helpBranch = sliceFrom(block, "sub === 'help'", 1200)
      expect(helpBranch).toMatch(/grants/)
    })

    it(`${label}: grants help entry mentions agent filter or 'tap to revoke'`, () => {
      const helpBranch = sliceFrom(block, "sub === 'help'", 1200)
      expect(helpBranch).toMatch(/revoke|agent/i)
    })
  }
})

// ─── switchroomHelpText (welcome-text.ts) ────────────────────────────────────

describe('switchroomHelpText — /vault grants entry', () => {
  it('lists vault grants as a separate entry', async () => {
    const { switchroomHelpText } = await import('../welcome-text.js')
    const out = switchroomHelpText('assistant')
    expect(out).toMatch(/vault.*grants/i)
  })

  it('grants entry mentions revoke capability', async () => {
    const { switchroomHelpText } = await import('../welcome-text.js')
    const out = switchroomHelpText('assistant')
    expect(out).toMatch(/revoke/i)
  })
})
