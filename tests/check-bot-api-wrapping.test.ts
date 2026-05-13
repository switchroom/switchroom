/**
 * Smoke tests for the #1075 lint script
 * (`scripts/check-bot-api-wrapping.sh`).
 *
 * The script's job: fail CI when a new raw `bot.api.*` / `lockedBot.api.*` /
 * `ctx.api.*` Telegram outbound call lands outside the standard retry
 * policy (robustApiCall / swallowingApiCall / retryWithThreadFallback)
 * AND outside the allowlist. We verify:
 *
 *   1. Clean baseline — the actual repo passes (regression gate).
 *   2. A synthetic non-allowlisted callsite fails the check.
 *   3. The wrapped form (inside a robustApiCall closure) passes.
 */

import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO = resolve(import.meta.dirname, '..')
const SCRIPT = join(REPO, 'scripts/check-bot-api-wrapping.sh')

/**
 * Run the lint script in a given working directory. The script `cd`s
 * to its OWN parent at startup — so we invoke the *copy* of the script
 * sitting under `<cwd>/scripts/`, not the canonical one. The caller
 * is expected to have cpSync'd the script to `<cwd>/scripts/`.
 *
 * Returns `{ ok, stdout, stderr }`.
 */
function runScript(cwd: string): { ok: boolean; stdout: string; stderr: string } {
  const scriptCopy = join(cwd, 'scripts/check-bot-api-wrapping.sh')
  try {
    const stdout = execFileSync('bash', [scriptCopy], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { ok: true, stdout, stderr: '' }
  } catch (err: unknown) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string }
    return {
      ok: false,
      stdout: e.stdout?.toString?.() ?? '',
      stderr: e.stderr?.toString?.() ?? '',
    }
  }
}

describe('scripts/check-bot-api-wrapping.sh (#1075)', () => {
  it(
    'passes against the live repo (regression gate)',
    () => {
      const result = runScript(REPO)
      expect(result.ok).toBe(true)
      expect(result.stdout).toMatch(/clean/)
    },
    // Local runs finish in ~1.5s; hosted Buildkite agents have slower I/O
    // and the script grep-walks the entire telegram-plugin tree, occasionally
    // pushing past vitest's 5s default. 30s is well above worst-case observed.
    30_000,
  )

  it('fails when a non-allowlisted raw bot.api.sendMessage lands in plugin source', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'check-bot-api-'))
    try {
      // Copy the script + scaffolding the script expects.
      mkdirSync(join(tmp, 'scripts'), { recursive: true })
      mkdirSync(join(tmp, 'telegram-plugin'), { recursive: true })
      cpSync(SCRIPT, join(tmp, 'scripts/check-bot-api-wrapping.sh'))

      // Bogus plugin source with a raw call outside any retry wrapper.
      writeFileSync(
        join(tmp, 'telegram-plugin/bad-callsite.ts'),
        `
import type { Bot } from 'grammy'
export async function badSend(bot: Bot, chatId: string): Promise<void> {
  // This SHOULD trip the lint — raw sendMessage, no retry wrapper.
  await bot.api.sendMessage(chatId, 'hello', { message_thread_id: 1 })
}
`,
      )

      const result = runScript(tmp)
      expect(result.ok).toBe(false)
      // The error message is written to stderr.
      const combined = result.stdout + result.stderr
      expect(combined).toMatch(/raw bot\.api\.\* call/)
      expect(combined).toMatch(/bad-callsite\.ts/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('passes when a raw bot.api call is inside a robustApiCall closure', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'check-bot-api-'))
    try {
      mkdirSync(join(tmp, 'scripts'), { recursive: true })
      mkdirSync(join(tmp, 'telegram-plugin'), { recursive: true })
      cpSync(SCRIPT, join(tmp, 'scripts/check-bot-api-wrapping.sh'))

      // Same call, but inside a robustApiCall closure. The script's
      // heuristic should treat this as wrapped.
      writeFileSync(
        join(tmp, 'telegram-plugin/wrapped-callsite.ts'),
        `
import type { Bot } from 'grammy'
declare const robustApiCall: <T>(fn: () => Promise<T>, opts?: unknown) => Promise<T>
export async function goodSend(bot: Bot, chatId: string): Promise<void> {
  await robustApiCall(
    () => bot.api.sendMessage(chatId, 'hello', { message_thread_id: 1 }),
    { chat_id: chatId, threadId: 1 },
  )
}
`,
      )

      const result = runScript(tmp)
      expect(result.ok).toBe(true)
      expect(result.stdout).toMatch(/clean/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
