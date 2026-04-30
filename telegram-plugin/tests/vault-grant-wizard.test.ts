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

  it('server.ts: agent name validated before path join (#265 item 1)', () => {
    // Pre-#265 fix `state.agent!` flowed straight into a path join. The
    // wizard is admin-DM-only, but defense-in-depth: assertSafeAgentName
    // should bracket the executeGrantWizard path-write.
    const slice = serverSrc.slice(
      serverSrc.indexOf('async function executeGrantWizard'),
      serverSrc.indexOf('async function executeGrantWizard') + 4000,
    )
    expect(slice).toMatch(/assertSafeAgentName\(\s*state\.agent/)
  })

  it('server.ts: keys-continue empty branch can show its toast (#265 item 2)', () => {
    // The unconditional `await ctx.answerCallbackQuery().catch(() => {})`
    // up front used to swallow the keys-continue toast. The fix moved
    // ack into per-branch tails. Pin the structural shape so a future
    // rework that re-adds the unconditional pre-ack regresses loudly.
    const wizardSlice = serverSrc.slice(
      serverSrc.indexOf("// #227 grant wizard callbacks"),
      serverSrc.indexOf("// #227 grant wizard callbacks") + 6000,
    )
    expect(wizardSlice).toContain("Select at least one key.")
    // Ensure the per-branch ack helper exists (proves no unconditional
    // pre-ack at the top of the wizard block).
    expect(wizardSlice).toContain('const ackSilently')
  })
})

describe('/vault grant inline-keyboard wizard — gateway parity (#262, #265)', () => {
  // Gateway port of the wizard. Mirrors the server.ts assertions so a
  // change to one file without the other is caught by CI.
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
