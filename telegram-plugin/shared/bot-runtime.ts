/**
 * Shared bot runtime helpers — extracted from gateway.ts so both the
 * per-agent gateway and the foreman bot can share the same core plumbing
 * without duplicating code.
 *
 * What lives here:
 *   - `createRobustApiCall` — thin re-export of createRetryApiCall pre-wired
 *     with stderr logging (mirrors how gateway.ts constructs `robustApiCall`).
 *   - `makeSwitchroomExec` / `makeSwitchroomExecCombined` — factory fns for
 *     the switchroom CLI exec helpers (callers pass their own CLI path / config
 *     env so each process can be configured independently).
 *   - `escapeHtmlForTg`, `preBlock`, `stripAnsi`, `formatSwitchroomOutput` —
 *     pure text-formatting helpers used by both gateways.
 *   - `makeSwitchroomReply` — factory that returns a `switchroomReply`-like
 *     function bound to a thread-resolver; gateway keeps its own resolver.
 *   - `runPollingLoop` — thin wrapper around the grammyjs/runner `run()` call
 *     with built-in 409 retry logic, matching the loop in gateway.ts.
 *
 * IMPORTANT: This module MUST NOT import anything from gateway.ts — the
 * dependency is the other way around. Only import from grammy, node builtins,
 * or other telegram-plugin/shared or telegram-plugin/*.ts modules.
 */

import { GrammyError, type Bot, type Context } from 'grammy'
import { run, type RunnerHandle } from '@grammyjs/runner'
import { execFileSync, spawnSync } from 'child_process'
import { clearStaleTelegramPollingState } from '../startup-reset.js'
import { createRetryApiCall } from '../retry-api-call.js'

// ─── robustApiCall factory ────────────────────────────────────────────────

/**
 * Creates a robust API call wrapper pre-wired with stderr logging.
 * This is exactly how gateway.ts constructs its `robustApiCall`.
 *
 * Usage:
 *   const robustApiCall = createRobustApiCall()
 */
export function createRobustApiCall() {
  return createRetryApiCall({
    log: (line) => process.stderr.write(line),
  })
}

// ─── HTML escape helpers ─────────────────────────────────────────────────

export function escapeHtmlForTg(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function preBlock(text: string): string {
  return '<pre>' + escapeHtmlForTg(text) + '</pre>'
}

export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
}

export function formatSwitchroomOutput(output: string, maxLen = 4000): string {
  const trimmed = output.trim()
  if (trimmed.length <= maxLen) return trimmed
  return trimmed.slice(0, maxLen - 20) + '\n... (truncated)'
}

// ─── CLI exec factories ───────────────────────────────────────────────────

export interface CliConfig {
  /** Path to the switchroom CLI binary. Defaults to 'switchroom'. */
  cliPath?: string
  /** Optional --config path forwarded to every CLI invocation. */
  configPath?: string
}

/** Returns a function that calls the CLI and returns stdout. */
export function makeSwitchroomExec(cfg: CliConfig = {}) {
  const cli = cfg.cliPath ?? process.env.SWITCHROOM_CLI_PATH ?? 'switchroom'
  const config = cfg.configPath ?? process.env.SWITCHROOM_CONFIG

  return function switchroomExec(args: string[], timeoutMs = 15000): string {
    const fullArgs = config ? ['--config', config, ...args] : args
    return execFileSync(cli, fullArgs, {
      encoding: 'utf-8',
      timeout: timeoutMs,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      maxBuffer: 4 * 1024 * 1024,
    })
  }
}

/** Returns a function that calls the CLI with stderr merged into stdout. */
export function makeSwitchroomExecCombined(cfg: CliConfig = {}) {
  const cli = cfg.cliPath ?? process.env.SWITCHROOM_CLI_PATH ?? 'switchroom'
  const config = cfg.configPath ?? process.env.SWITCHROOM_CONFIG

  // Pre-#28 fix this used `execSync(\`${quoted} 2>&1\`, { shell: '/bin/bash' })`,
  // hand-quoting each argument. The shell-quoting was correct today, but the
  // structural shape meant any future caller passing user-controlled input
  // would re-introduce a command-injection class of bug. spawnSync with
  // argv array eliminates the shell entirely; we then concat stdout + stderr
  // ourselves to preserve the merged-output contract callers depend on.
  return function switchroomExecCombined(args: string[], timeoutMs = 15000): string {
    const fullArgs = config ? ['--config', config, ...args] : args
    const result = spawnSync(cli, fullArgs, {
      encoding: 'utf-8',
      timeout: timeoutMs,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      maxBuffer: 4 * 1024 * 1024,
    })
    const stdout = (result.stdout as string | undefined) ?? ''
    const stderr = (result.stderr as string | undefined) ?? ''
    const merged = stderr.length > 0 ? stdout + stderr : stdout
    if (result.error) throw result.error
    if (result.status !== 0) {
      // Mirror execSync's behaviour: throw on non-zero exit, attaching the
      // merged output so callers (which catch and inspect .stdout) can read it.
      const err = new Error(`Command failed: ${cli} ${fullArgs.join(' ')}`) as Error & {
        stdout?: string
        stderr?: string
        status?: number | null
      }
      err.stdout = merged
      err.stderr = stderr
      err.status = result.status
      throw err
    }
    return merged
  }
}

/** Returns a CLI exec wrapper that parses JSON output (--json flag). */
export function makeSwitchroomExecJson(cfg: CliConfig = {}) {
  const exec = makeSwitchroomExec(cfg)
  return function switchroomExecJson<T = unknown>(args: string[]): T | null {
    try {
      const output = exec([...args, '--json'])
      return JSON.parse(output) as T
    } catch {
      return null
    }
  }
}

// ─── Reply helper factory ─────────────────────────────────────────────────

import { InlineKeyboard } from 'grammy'

export type SwitchroomReplyMarkup =
  | InlineKeyboard
  | { force_reply: true; input_field_placeholder?: string; selective?: boolean }

/**
 * Creates a `switchroomReply` function that sends an HTML reply to the
 * chat in `ctx`, optionally threaded.
 *
 * @param resolveThreadId - returns the thread ID to use for the given
 *   chat_id + optional explicit thread (mirrors gateway's resolveThreadId).
 *   Pass `() => undefined` for bots that don't use forum topics.
 */
export function makeSwitchroomReply(
  resolveThreadId: (chatId: string, explicit?: number | null) => number | undefined,
) {
  return async function switchroomReply(
    ctx: Context,
    text: string,
    options: { html?: boolean; reply_markup?: SwitchroomReplyMarkup } = {},
  ): Promise<void> {
    const chatId = String(ctx.chat!.id)
    const threadId = resolveThreadId(chatId, ctx.message?.message_thread_id)
    await ctx.reply(text, {
      ...(threadId != null ? { message_thread_id: threadId } : {}),
      ...(options.html ? { parse_mode: 'HTML' as const, link_preview_options: { is_disabled: true } } : {}),
      ...(options.reply_markup ? { reply_markup: options.reply_markup } : {}),
    })
  }
}

// ─── Polling loop ─────────────────────────────────────────────────────────

export interface PollingLoopCallbacks {
  /** Fired once after `getMe()` on the first (non-409) attempt. */
  onReady?: (botUsername: string, botId: number) => void | Promise<void>
  /**
   * Fired exactly once per process lifetime (not on 409 retries) after
   * `onReady`. Use for one-time startup work (command registration, sweeps,
   * intervals).
   */
  onOneTimeSetup?: (botUsername: string) => void | Promise<void>
  /** Fired when the polling loop exits cleanly (runner task resolved). */
  onStop?: () => void | Promise<void>
  /** Called each time a 409 is detected (useful for logging). */
  on409?: (attempt: number, delayMs: number) => void
}

/**
 * Runs a grammyjs/runner polling loop with built-in 409 retry backoff,
 * matching the loop structure in gateway.ts.
 *
 * Returns the RunnerHandle so callers can call `.stop()` on SIGTERM.
 *
 * The promise resolves when the polling loop exits cleanly.
 * The promise rejects on non-409, non-Aborted errors.
 */
export async function runPollingLoop(
  bot: Bot,
  callbacks: PollingLoopCallbacks = {},
): Promise<void> {
  let didOneTimeSetup = false

  for (let attempt = 1; ; attempt++) {
    try {
      await clearStaleTelegramPollingState(bot.api)

      const me = await bot.api.getMe()
      process.stderr.write(`bot-runtime: polling as @${me.username}\n`)

      if (callbacks.onReady) {
        await callbacks.onReady(me.username ?? '', me.id)
      }

      if (!didOneTimeSetup) {
        didOneTimeSetup = true
        if (callbacks.onOneTimeSetup) {
          await callbacks.onOneTimeSetup(me.username ?? '')
        }
      }

      process.stderr.write(`bot-runtime: starting runner pid=${process.pid}\n`)
      const handle: RunnerHandle = run(bot)
      await handle.task()
      if (callbacks.onStop) await callbacks.onStop()
      return
    } catch (err) {
      if (err instanceof GrammyError && err.error_code === 409) {
        const delay = Math.min(1000 * attempt, 15000)
        if (callbacks.on409) callbacks.on409(attempt, delay)
        process.stderr.write(
          `bot-runtime: 409 Conflict attempt=${attempt} retry_in_ms=${delay}\n`,
        )
        await new Promise(r => setTimeout(r, delay))
        continue
      }
      if (err instanceof Error && err.message === 'Aborted delay') return
      process.stderr.write(`bot-runtime: polling failed: ${err}\n`)
      throw err
    }
  }
}

// ─── Access guard ─────────────────────────────────────────────────────────

/**
 * Returns true if the sender's user ID is in the allowFrom list.
 * Used by both gateway and foreman for auth gating.
 */
export function isAllowedSender(ctx: Context, allowFrom: string[]): boolean {
  const from = ctx.from
  if (!from) return false
  return allowFrom.includes(String(from.id))
}
