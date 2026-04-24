/**
 * Pure handler logic extracted from foreman.ts for testability.
 *
 * foreman.ts has process-level side effects (reads .env, connects Bot,
 * starts polling) that prevent direct import in tests. This module
 * exports the command handler implementations and their helpers so that
 * tests can exercise real code with mocked bot + ctx, rather than
 * re-implementing the logic locally.
 */

import { execFileSync } from 'child_process'
import { renameSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join, resolve } from 'path'
import {
  escapeHtmlForTg,
  preBlock,
  stripAnsi,
  formatSwitchroomOutput,
} from '../shared/bot-runtime.js'

// ─── Types ────────────────────────────────────────────────────────────────

export type SwitchroomExecFn = (args: string[]) => string
export type SwitchroomExecJsonFn = <T = unknown>(args: string[]) => T | null

// ─── Agent name validation ────────────────────────────────────────────────

/**
 * Throw if the agent name is not safe for use in journalctl unit names.
 * Mirrors AGENT_NAME_RE in src/agents/create-orchestrator.ts and the yaml
 * schema in src/config/schema.ts — all three MUST stay in sync. Max 51
 * chars (see operator-events.ts callback_data contract).
 */
export function assertSafeAgentName(name: string): void {
  if (!/^[a-z0-9][a-z0-9_-]{0,50}$/.test(name)) {
    throw new Error(`invalid agent name: ${name}`)
  }
}

// ─── Tail-N parsing ───────────────────────────────────────────────────────

export function parseTailN(args: string[]): number {
  let tailN = 50
  const tailIdx = args.indexOf('--tail')
  if (tailIdx !== -1 && args[tailIdx + 1]) {
    const parsed = parseInt(args[tailIdx + 1], 10)
    if (!isNaN(parsed) && parsed > 0) tailN = Math.min(parsed, 500)
  }
  return tailN
}

// ─── Text chunking ────────────────────────────────────────────────────────

export function chunkText(text: string, maxLen = 4096): string[] {
  if (text.length <= maxLen) return [text]
  const chunks: string[] = []
  let pos = 0
  while (pos < text.length) {
    chunks.push(text.slice(pos, pos + maxLen))
    pos += maxLen
  }
  return chunks
}

// ─── /status handler impl ─────────────────────────────────────────────────

export type AgentListEntry = {
  name: string
  status: string
  uptime: string
  template?: string | null
  topic_name?: string | null
}

export function statusIcon(status: string): string {
  if (status === 'active' || status === 'running') return '🟢'
  if (status === 'inactive' || status === 'stopped' || status === 'dead') return '🔴'
  if (status === 'failed') return '⚠️'
  return '⚪'
}

export function buildFleetSummary(
  switchroomExecJson: SwitchroomExecJsonFn,
): string {
  try {
    const data = switchroomExecJson<{ agents: AgentListEntry[] }>(['agent', 'list'])
    if (!data || data.agents.length === 0) return '<i>No agents defined</i>'
    const lines = ['<b>Fleet status</b>']
    for (const a of data.agents) {
      lines.push(
        `${statusIcon(a.status)} <b>${escapeHtmlForTg(a.name)}</b> · ${escapeHtmlForTg(a.status)} · ${escapeHtmlForTg(a.uptime)}`,
      )
      if (a.template || a.topic_name) {
        const meta = [a.template, a.topic_name]
          .filter(Boolean)
          .map((s) => escapeHtmlForTg(s!))
          .join(' → ')
        lines.push(`  <i>${meta}</i>`)
      }
    }
    return lines.join('\n')
  } catch (err) {
    return `<b>agent list failed:</b>\n${preBlock(formatSwitchroomOutput((err as Error).message))}`
  }
}

// ─── /logs handler impl ───────────────────────────────────────────────────

export const LOG_PAGE_BYTES = 3 * 1024 // 3 KB

export interface LogsResult {
  /** One or more reply strings. Send them in order. */
  replies: Array<{ text: string; html: boolean }>
}

/**
 * Core /logs implementation — returns the reply payloads rather than
 * sending them directly, so the caller (foreman.ts) can use its own
 * switchroomReply and tests can inspect the output.
 *
 * @param match  The text after "/logs " from ctx.match
 * @param execFile  Injected execFileSync for testability
 */
export function handleLogsCommand(
  match: string,
  execFile: typeof execFileSync = execFileSync,
): LogsResult {
  const args = match.trim().split(/\s+/).filter(Boolean)

  if (args.length === 0) {
    return { replies: [{ text: 'Usage: /logs &lt;agent&gt; [--tail N]', html: true }] }
  }

  const agentName = args[0]
  try {
    assertSafeAgentName(agentName)
  } catch {
    return { replies: [{ text: 'Invalid agent name.', html: true }] }
  }

  const tailN = parseTailN(args)

  let output: string
  try {
    output = stripAnsi(
      execFile(
        'journalctl',
        [
          '--user',
          '-u',
          `switchroom-${agentName}`,
          '-n',
          String(tailN),
          '--no-pager',
          '--output=short-monotonic',
        ],
        {
          encoding: 'utf-8',
          timeout: 10000,
          env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      ) as string,
    )
  } catch (err) {
    const msg = err as { stdout?: string; stderr?: string; message?: string }
    const detail = msg.stdout || msg.stderr || msg.message || 'unknown error'
    return {
      replies: [
        {
          text: `<b>logs failed for ${escapeHtmlForTg(agentName)}:</b>\n${preBlock(formatSwitchroomOutput(stripAnsi(detail)))}`,
          html: true,
        },
      ],
    }
  }

  const trimmed = output.trim()
  if (!trimmed) {
    return {
      replies: [
        {
          text: `No logs found for <code>${escapeHtmlForTg(agentName)}</code>.`,
          html: true,
        },
      ],
    }
  }

  if (Buffer.byteLength(trimmed, 'utf8') > LOG_PAGE_BYTES) {
    const chunks = chunkText(trimmed, 3800)
    return {
      replies: chunks.map((chunk, i) => {
        const label = chunks.length > 1 ? ` (${i + 1}/${chunks.length})` : ''
        return {
          text: preBlock(chunk) + (label ? `\n<i>${label}</i>` : ''),
          html: true,
        }
      }),
    }
  }

  return { replies: [{ text: preBlock(trimmed), html: true }] }
}

// ─── /restart handler impl ────────────────────────────────────────────────

export interface RestartResult {
  ok: boolean
  text: string
  html: boolean
}

/**
 * Core /restart implementation.
 *
 * Shells out to `systemctl --user restart switchroom-<agent>` via execFileSync
 * (no shell, so agent name is safely passed as an arg — no injection risk).
 *
 * @param match      Text after "/restart " from ctx.match
 * @param execFile   Injected execFileSync for testability
 */
export function handleRestartCommand(
  match: string,
  execFile: typeof execFileSync = execFileSync,
): RestartResult {
  const agentName = match.trim().split(/\s+/)[0] ?? ''

  if (!agentName) {
    return {
      ok: false,
      text: 'Usage: /restart &lt;agent&gt;',
      html: true,
    }
  }

  try {
    assertSafeAgentName(agentName)
  } catch {
    return { ok: false, text: 'Invalid agent name.', html: true }
  }

  try {
    execFile(
      'systemctl',
      ['--user', 'restart', `switchroom-${agentName}`],
      {
        encoding: 'utf-8',
        timeout: 15000,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    return {
      ok: true,
      text: `Restarted <code>switchroom-${escapeHtmlForTg(agentName)}</code>.`,
      html: true,
    }
  } catch (err) {
    const msg = err as { stderr?: string; stdout?: string; message?: string }
    const detail = stripAnsi(msg.stderr || msg.stdout || msg.message || 'unknown error').trim()
    return {
      ok: false,
      text: `<b>restart failed for ${escapeHtmlForTg(agentName)}:</b>\n${preBlock(formatSwitchroomOutput(detail))}`,
      html: true,
    }
  }
}

// ─── /delete (destroy) handler impl ──────────────────────────────────────

export interface DeleteResult {
  replies: Array<{ text: string; html: boolean }>
  /** When true, foreman.ts should also send an inline keyboard for confirmation. */
  needsConfirm?: boolean
  /** Agent name (for the confirmation prompt). */
  agentForConfirm?: string
}

/**
 * Resolve the agents directory from environment or default location.
 * Exposed for testability.
 */
export function resolveAgentsDirForDelete(): string {
  const switchroomDir = process.env.SWITCHROOM_AGENTS_DIR
    ?? join(homedir(), '.switchroom', 'agents')
  return switchroomDir
}

/**
 * Core /delete first-step implementation — returns a confirmation prompt.
 *
 * The actual deletion is performed by executeDeleteAgent() once the user
 * confirms via callback_query or "YES" text.
 */
export function handleDeleteCommand(match: string): DeleteResult {
  const agentName = match.trim().split(/\s+/)[0] ?? ''

  if (!agentName) {
    return {
      replies: [{ text: 'Usage: /delete &lt;agent&gt;', html: true }],
    }
  }

  try {
    assertSafeAgentName(agentName)
  } catch {
    return { replies: [{ text: 'Invalid agent name.', html: true }] }
  }

  return {
    replies: [
      {
        text: `Are you sure you want to delete agent <b>${escapeHtmlForTg(agentName)}</b>?\n\nThis will stop and remove the systemd unit and archive the agent directory. Reply <b>YES</b> to confirm.`,
        html: true,
      },
    ],
    needsConfirm: true,
    agentForConfirm: agentName,
  }
}

/**
 * Execute agent deletion after confirmation.
 *
 * Archives the agent dir to `agents/_archived_<name>_<timestamp>/` before
 * running `switchroom agent destroy --yes <name>` so data is recoverable.
 *
 * @param agentName   Validated agent name
 * @param switchroomExec  Injected CLI exec for testability
 * @param execFile    Injected execFileSync for testability (systemctl)
 * @param agentsDir   Override agents dir (for tests)
 */
export function executeDeleteAgent(
  agentName: string,
  switchroomExec: SwitchroomExecFn,
  execFile: typeof execFileSync = execFileSync,
  agentsDir: string = resolveAgentsDirForDelete(),
): DeleteResult {
  try {
    assertSafeAgentName(agentName)
  } catch {
    return { replies: [{ text: 'Invalid agent name.', html: true }] }
  }

  const agentDir = resolve(agentsDir, agentName)
  let archivePath: string | null = null

  // Step 1: Archive the dir if it exists
  if (existsSync(agentDir)) {
    const timestamp = Date.now()
    archivePath = resolve(agentsDir, `_archived_${agentName}_${timestamp}`)
    try {
      renameSync(agentDir, archivePath)
    } catch (err) {
      return {
        replies: [
          {
            text: `<b>Archive failed for ${escapeHtmlForTg(agentName)}:</b>\n${preBlock(formatSwitchroomOutput((err as Error).message))}`,
            html: true,
          },
        ],
      }
    }
  }

  // Step 2: Stop + remove systemd unit via CLI (--yes skips the interactive prompt)
  let cliOutput = ''
  let cliOk = true
  try {
    cliOutput = switchroomExec(['agent', 'destroy', '--yes', agentName])
  } catch (err) {
    cliOk = false
    const msg = err as { stderr?: string; stdout?: string; message?: string }
    cliOutput = stripAnsi(msg.stderr || msg.stdout || msg.message || 'unknown error').trim()
  }

  const lines: string[] = []

  if (archivePath) {
    lines.push(`Archived <code>${escapeHtmlForTg(agentName)}</code> to:`)
    lines.push(`<code>${escapeHtmlForTg(archivePath)}</code>`)
    lines.push('')
  }

  if (cliOk) {
    lines.push(`Agent <b>${escapeHtmlForTg(agentName)}</b> deleted.`)
    if (cliOutput.trim()) {
      lines.push(preBlock(formatSwitchroomOutput(stripAnsi(cliOutput))))
    }
  } else {
    lines.push(`<b>CLI destroy failed</b> (agent dir was archived; systemd unit may still exist):`)
    lines.push(preBlock(formatSwitchroomOutput(cliOutput)))
  }

  return { replies: [{ text: lines.join('\n'), html: true }] }
}

// ─── /update handler impl ─────────────────────────────────────────────────

export interface UpdateResult {
  replies: Array<{ text: string; html: boolean }>
}

/**
 * Core /update implementation.
 *
 * Shells out to `switchroom update` via the CLI exec helper. Output is
 * paginated when > 3 KB.
 *
 * @param switchroomExec  Injected CLI exec (combined stdout+stderr) for testability
 */
export function handleUpdateCommand(
  switchroomExec: SwitchroomExecFn,
): UpdateResult {
  let output: string
  try {
    output = switchroomExec(['update'])
  } catch (err) {
    const msg = err as { stderr?: string; stdout?: string; message?: string }
    const detail = stripAnsi(msg.stderr || msg.stdout || msg.message || 'unknown error').trim()
    return {
      replies: [
        {
          text: `<b>update failed:</b>\n${preBlock(formatSwitchroomOutput(detail))}`,
          html: true,
        },
      ],
    }
  }

  const trimmed = stripAnsi(output).trim()
  if (!trimmed) {
    return { replies: [{ text: 'Update complete (no output).', html: false }] }
  }

  if (Buffer.byteLength(trimmed, 'utf8') > LOG_PAGE_BYTES) {
    const chunks = chunkText(trimmed, 3800)
    return {
      replies: chunks.map((chunk, i) => {
        const label = chunks.length > 1 ? ` (${i + 1}/${chunks.length})` : ''
        return {
          text: preBlock(chunk) + (label ? `\n<i>${label}</i>` : ''),
          html: true,
        }
      }),
    }
  }

  return { replies: [{ text: preBlock(trimmed), html: true }] }
}
