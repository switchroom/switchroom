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
