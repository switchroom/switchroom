/**
 * Structural tests for the /vault grant inline-keyboard wizard added in #227.
 *
 * Why structural: gateway/gateway.ts and server.ts do not export the bot
 * command handlers — pure-functional invocation would require a full
 * Grammy/Bot harness. We pin the behaviour at the file level with grep
 * against the source so a regression in either file is caught.
 *
 * Both surfaces are tested in parallel: server.ts (monolith polling
 * mode) and gateway/gateway.ts (split mode). The gateway port landed
 * in PR #262; this file's gateway describe-block was added in
 * follow-up #265.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Resolve paths relative to the repo root, derived from this test file's
// own location, instead of process.cwd() — which is brittle across run
// modes (vitest from repo root vs `bun test` from telegram-plugin/ vs
// CI's `cd telegram-plugin && bun test`). The repo root is two levels
// up from this file (telegram-plugin/tests/vault-grant-wizard.test.ts).
const TEST_DIR = (() => {
  try {
    return resolve(fileURLToPath(import.meta.url), '..')
  } catch {
    return resolve('.')
  }
})()
const REPO_ROOT = resolve(TEST_DIR, '..', '..')

function readSrc(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), 'utf8')
}

// #235 Wave 3 F4: server.ts monolith removed; assertions below now live
// only against gateway.ts (the single source of truth for the wizard).
// Pre-removal there was a parallel server.ts describe block here; see
// `telegram-plugin/docs/gateway-server-split.md` for the F4 cleanup notes.

describe('/vault grant inline-keyboard wizard — gateway (#227, #262, #265)', () => {
  const gatewaySrc = readSrc('telegram-plugin/gateway/gateway.ts')

  it('gateway.ts: dispatches /vault grant to the wizard entry', () => {
    expect(gatewaySrc).toMatch(/\/vault grant/i)
    expect(gatewaySrc).toContain("kind: 'grant-wizard'")
  })

  it('gateway.ts: wizard state-machine has step transitions', () => {
    expect(gatewaySrc).toContain('grantWizardStep3')
    expect(gatewaySrc).toContain('grantWizardConfirm')
    expect(gatewaySrc).toContain('executeGrantWizard')
  })

  it('gateway.ts: wizard callback prefix vg: is registered', () => {
    expect(gatewaySrc).toContain('vg:')
  })

  it('gateway.ts: expired-wizard sessions reply with a clear error', () => {
    expect(gatewaySrc).toMatch(/Wizard session expired|Run \/vault grant to start again/i)
  })

  it('gateway.ts: custom-duration text-reply path exists', () => {
    expect(gatewaySrc).toContain('awaitingCustomDuration')
  })

  it('gateway.ts: agent name validated before path join (#265 item 1)', () => {
    const slice = gatewaySrc.slice(
      gatewaySrc.indexOf('async function executeGrantWizard'),
      gatewaySrc.indexOf('async function executeGrantWizard') + 4000,
    )
    expect(slice).toMatch(/assertSafeAgentName\(\s*state\.agent/)
  })

  it('gateway.ts: keys-continue empty branch can show its toast (#265 item 2)', () => {
    const wizardSlice = gatewaySrc.slice(
      gatewaySrc.indexOf("// #227 grant wizard callbacks"),
      gatewaySrc.indexOf("// #227 grant wizard callbacks") + 6000,
    )
    expect(wizardSlice).toContain("Select at least one key.")
    expect(wizardSlice).toContain('const ackSilently')
  })
})
