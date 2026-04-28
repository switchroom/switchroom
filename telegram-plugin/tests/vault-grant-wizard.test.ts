/**
 * Structural tests for the /vault grant inline-keyboard wizard added in #227.
 *
 * Why structural: gateway/gateway.ts and server.ts do not export the bot
 * command handlers — pure-functional invocation would require a full
 * Grammy/Bot harness. We pin the behaviour at the file level with grep
 * against the source so a regression in either file is caught.
 *
 * Note: this PR wires the wizard in server.ts (monolith polling mode)
 * only. gateway/gateway.ts wiring is filed as a follow-up.
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

describe('/vault grant inline-keyboard wizard (#227)', () => {
  const serverSrc = readSrc('telegram-plugin/server.ts')

  it('server.ts: dispatches /vault grant to the wizard entry', () => {
    expect(serverSrc).toMatch(/\/vault grant/i)
    expect(serverSrc).toContain("kind: 'grant-wizard'")
  })

  it('server.ts: wizard state-machine has step transitions', () => {
    // Step 1 (agent), Step 2 (keys), Step 3 (duration), Confirm + Generate
    expect(serverSrc).toContain('grantWizardStep3')
    expect(serverSrc).toContain('grantWizardConfirm')
    expect(serverSrc).toContain('executeGrantWizard')
  })

  it('server.ts: wizard callback prefix vg: is registered', () => {
    expect(serverSrc).toContain('vg:')
  })

  it('server.ts: expired-wizard sessions reply with a clear error', () => {
    // When pending state is missing or wrong-kind, reply tells the user to restart
    expect(serverSrc).toMatch(/Wizard session expired|Run \/vault grant to start again/i)
  })

  it('server.ts: custom-duration text-reply path exists', () => {
    expect(serverSrc).toContain('awaitingCustomDuration')
  })

  it('server.ts: Generate calls broker mint_grant', () => {
    // executeGrantWizard issues a mint_grant op via the broker client
    const slice = serverSrc.slice(serverSrc.indexOf('executeGrantWizard'))
    expect(slice).toMatch(/mint_grant|mintGrant/i)
  })

  it('server.ts: /vault help text mentions the new grant subcommand', () => {
    expect(serverSrc).toContain('/vault grant')
  })

  it('server.ts: passphrase / token bytes are not logged in the wizard', () => {
    // Defensive: scan the executeGrantWizard region for console.log/logger calls
    // referencing token-shaped variables. The PR's docstring says token is
    // returned only in the one-shot reply, never logged.
    const slice = serverSrc.slice(
      serverSrc.indexOf('async function executeGrantWizard'),
      serverSrc.indexOf('async function executeGrantWizard') + 4000,
    )
    expect(slice).not.toMatch(/console\.log[^;]*\.token\b/)
    expect(slice).not.toMatch(/logger\.[a-z]+[^;]*\.token\b/)
  })
})
