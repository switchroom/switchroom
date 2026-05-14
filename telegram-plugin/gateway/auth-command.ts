/**
 * `/auth` chat-command parser + handler (RFC H §7.3).
 *
 * The slot-pool-era dashboard at `telegram-plugin/auth-dashboard.ts`
 * — and its callback-driven inline-keyboard surface — is gone. The
 * fleet-wide active-account model leaves three verbs:
 *
 *   /auth show           — fleet snapshot (read-only for anyone).
 *   /auth use <label>    — admin-only fleet swap.
 *   /auth rotate         — admin-only "next non-exhausted in
 *                          fallback_order" failover.
 *
 * Parse is pure (no I/O) so callers can route on the verb without
 * needing a broker. The handler is async and talks to the broker
 * client; on broker failure it returns a user-facing error reply
 * rather than throwing.
 */

import type { ListStateData, AccountState } from './auth-line.js'

// ─── Parser ────────────────────────────────────────────────────────────────

export type ParsedAuthCommand =
  | { kind: 'show' }
  | { kind: 'use'; label: string }
  | { kind: 'rotate' }
  | { kind: 'add'; label: string }
  | { kind: 'cancel' }
  | { kind: 'help'; reason?: string }

/**
 * Account-label regex — must match the broker's `LABEL_RE` in
 * `src/auth/account-store.ts`. Duplicated rather than imported to
 * keep `auth-command.ts` pure (no side-effecting imports) so the
 * parser is cheap to unit test.
 */
const LABEL_RE = /^[A-Za-z0-9._@+-]+$/
const LABEL_MAX = 64

/** Returns null when label is valid; otherwise a user-facing error string. */
export function validateAuthAddLabel(label: string): string | null {
  if (!label || label.length === 0) return 'Label cannot be empty.'
  if (label.length > LABEL_MAX) {
    return `Label too long (max ${LABEL_MAX} chars).`
  }
  if (label === '.' || label === '..') return `Label "${label}" is reserved.`
  if (label.includes('/') || label.includes('\\')) {
    return 'Label cannot contain path separators.'
  }
  if (!LABEL_RE.test(label)) {
    return 'Label must match <code>[A-Za-z0-9._@+-]+</code> (letters, digits, dot, underscore, dash, @, +).'
  }
  return null
}

/**
 * Parse a `/auth …` chat command. Returns `null` when the text is
 * not an `/auth` command at all (so the gateway falls through to its
 * other handlers).
 *
 * Whitespace tolerant; case-insensitive on the verb. `/auth` alone
 * resolves to `show` (the read-only default).
 */
export function parseAuthCommand(text: string): ParsedAuthCommand | null {
  const trimmed = text.trim()
  if (trimmed.length === 0) return null
  // Allow `/auth`, `/auth@botname`, `/auth foo` — the leading token
  // must be `/auth` (optionally with a bot-suffix) or the message
  // isn't ours.
  const m = trimmed.match(/^\/auth(?:@[A-Za-z0-9_]+)?(?:\s+(.*))?$/)
  if (!m) return null
  const rest = (m[1] ?? '').trim()
  if (rest.length === 0) return { kind: 'show' }
  const parts = rest.split(/\s+/)
  const verb = (parts[0] ?? '').toLowerCase()
  switch (verb) {
    case 'show':
      return { kind: 'show' }
    case 'rotate':
      return { kind: 'rotate' }
    case 'use': {
      const label = parts[1]
      if (!label) return { kind: 'help', reason: 'Usage: /auth use <label>' }
      return { kind: 'use', label }
    }
    case 'add': {
      const label = parts[1]
      if (!label) return { kind: 'help', reason: 'Usage: /auth add <label>' }
      const err = validateAuthAddLabel(label)
      if (err) return { kind: 'help', reason: err }
      return { kind: 'add', label }
    }
    case 'cancel':
      return { kind: 'cancel' }
    default:
      return { kind: 'help', reason: `Unknown verb: <code>${escapeHtml(verb)}</code>` }
  }
}

// ─── Handler ───────────────────────────────────────────────────────────────

/**
 * Broker client surface this handler depends on. Kept narrow so the
 * gateway can inject the real client (`src/auth/broker/client.ts`)
 * and tests can pass a mock without juggling the full NDJSON shape.
 */
export interface AuthBrokerClient {
  listState(): Promise<ListStateData>
  setActive(label: string): Promise<{ active: string; fanned: string[] }>
}

export interface AuthCommandContext {
  /** The agent the gateway is bound to (its socket-path identity). */
  agentName: string
  /** Names of agents allowed to mutate fleet state. Empty / undefined → no admin. */
  adminAgents: ReadonlyArray<string> | undefined
  client: AuthBrokerClient
}

export interface AuthCommandReply {
  text: string
  /** True when the reply contains HTML markup. */
  html: boolean
}

/**
 * Dispatch a parsed `/auth` command. Returns the reply the gateway
 * should send. Never throws — broker errors surface as user-visible
 * text.
 */
export async function handleAuthCommand(
  parsed: ParsedAuthCommand,
  ctx: AuthCommandContext,
): Promise<AuthCommandReply> {
  if (parsed.kind === 'help') {
    const reason = parsed.reason ? `${parsed.reason}\n\n` : ''
    return {
      text:
        `${reason}<b>/auth</b> — verbs:\n` +
        `  <code>/auth show</code> — fleet snapshot (read-only)\n` +
        `  <code>/auth use &lt;label&gt;</code> — swap fleet active (admin)\n` +
        `  <code>/auth rotate</code> — failover to next non-exhausted (admin)\n` +
        `  <code>/auth add &lt;label&gt;</code> — add a new Anthropic OAuth account (admin)\n` +
        `  <code>/auth cancel</code> — abort a pending <code>/auth add</code> flow (admin)`,
      html: true,
    }
  }

  if (parsed.kind === 'show') {
    try {
      const state = await ctx.client.listState()
      return { text: renderShowText(state), html: true }
    } catch (err) {
      return {
        text: `<b>/auth show failed:</b> ${escapeHtml((err as Error)?.message ?? String(err))}`,
        html: true,
      }
    }
  }

  // Admin-gated verbs from here on.
  if (!isAdmin(ctx)) {
    return {
      text:
        `<b>Not authorized.</b> <code>/auth ${parsed.kind}</code> is admin-only.\n` +
        `Add this agent to <code>auth.admin_agents</code> in switchroom.yaml to unlock.`,
      html: true,
    }
  }

  // `add` and `cancel` are dispatched directly by the gateway (they
  // need to drive the `claude setup-token` scratch-dir lifecycle and
  // the per-chat pending-paste state). They should never reach this
  // handler in production — if they do (defensive), return a clear
  // error rather than silently coercing into a different verb.
  if (parsed.kind === 'add' || parsed.kind === 'cancel') {
    return {
      text:
        `<b>/auth ${parsed.kind} not routed.</b> Internal error — gateway should dispatch this verb directly. Report this.`,
      html: true,
    }
  }

  if (parsed.kind === 'use') {
    try {
      const result = await ctx.client.setActive(parsed.label)
      return {
        text:
          `<b>Active account →</b> <code>${escapeHtml(result.active)}</code>\n` +
          `Re-mirrored credentials for ${result.fanned.length} agent${result.fanned.length === 1 ? '' : 's'}.`,
        html: true,
      }
    } catch (err) {
      return {
        text: `<b>/auth use failed:</b> ${escapeHtml((err as Error)?.message ?? String(err))}`,
        html: true,
      }
    }
  }

  // parsed.kind === 'rotate'
  try {
    const state = await ctx.client.listState()
    const nextLabel = pickRotateTarget(state)
    if (!nextLabel) {
      return {
        text:
          `<b>/auth rotate</b> — no eligible target.\n` +
          `Either every account in <code>fallback_order</code> is exhausted, ` +
          `or no fallback order is configured.`,
        html: true,
      }
    }
    const result = await ctx.client.setActive(nextLabel)
    return {
      text:
        `<b>Rotated:</b> active → <code>${escapeHtml(result.active)}</code>\n` +
        `Re-mirrored credentials for ${result.fanned.length} agent${result.fanned.length === 1 ? '' : 's'}.`,
      html: true,
    }
  } catch (err) {
    return {
      text: `<b>/auth rotate failed:</b> ${escapeHtml((err as Error)?.message ?? String(err))}`,
      html: true,
    }
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Admin gate. Exposed so the gateway-routed verbs (`/auth add`,
 * `/auth cancel`) reuse the same ACL check as the handler-routed
 * verbs (`/auth use`, `/auth rotate`).
 */
export function isAuthAdmin(args: {
  agentName: string
  adminAgents: ReadonlyArray<string> | undefined
}): boolean {
  if (!args.adminAgents || args.adminAgents.length === 0) return false
  return args.adminAgents.includes(args.agentName)
}

function isAdmin(ctx: AuthCommandContext): boolean {
  return isAuthAdmin(ctx)
}

/**
 * Choose the next account `auth rotate` should set active. Walks
 * `fallback_order` starting *after* the currently-active label,
 * wrapping; returns the first label whose account is not exhausted.
 * Returns null when nothing is eligible.
 */
export function pickRotateTarget(state: ListStateData, now: number = Date.now()): string | null {
  const order = state.fallback_order
  if (order.length === 0) return null
  const byLabel = new Map<string, AccountState>(state.accounts.map((a) => [a.label, a]))
  const start = Math.max(0, order.indexOf(state.active))
  for (let step = 1; step <= order.length; step++) {
    const candidate = order[(start + step) % order.length]
    if (!candidate || candidate === state.active) continue
    const acc = byLabel.get(candidate)
    if (!acc) continue
    if (acc.exhausted && (acc.exhausted_until == null || acc.exhausted_until > now)) continue
    return candidate
  }
  return null
}

/**
 * Render the two-table `auth show` format from RFC §4.6, adapted for
 * Telegram (HTML, monospace blocks). Three sections, each suppressed
 * when empty.
 */
export function renderShowText(state: ListStateData, now: number = Date.now()): string {
  const lines: string[] = []
  lines.push('<b>Auth — fleet snapshot</b>')

  // Accounts table
  if (state.accounts.length > 0) {
    lines.push('')
    lines.push('<b>Accounts</b>')
    lines.push('<pre>')
    lines.push(formatAccountsTable(state, now))
    lines.push('</pre>')
  }

  // Agents table
  if (state.agents.length > 0) {
    lines.push('<b>Agents</b>')
    lines.push('<pre>')
    lines.push(formatAgentsTable(state))
    lines.push('</pre>')
  }

  // Consumers table — only when there are any (typical case: hindsight).
  if (state.consumers.length > 0) {
    lines.push('<b>Consumers</b>')
    lines.push('<pre>')
    lines.push(formatConsumersTable(state, now))
    lines.push('</pre>')
  }

  // Discovery hint — operators on a quota-walled fleet need to know
  // `/auth add` exists so they can add a fresh account without an
  // LLM in the loop. Keep it short; the help text has the full menu.
  lines.push(
    '<i>Add a new Anthropic account: <code>/auth add &lt;label&gt;</code> (admin)</i>',
  )

  return lines.join('\n')
}

function formatAccountsTable(state: ListStateData, now: number): string {
  const rows: string[][] = [['ACCOUNT', 'STATUS', 'EXPIRES', 'QUOTA-RESET']]
  for (const acc of state.accounts) {
    const isActive = acc.label === state.active
    const marker = isActive
      ? '●' // ●
      : acc.exhausted
        ? '!'
        : '✓' // ✓
    const status = isActive ? 'active' : acc.exhausted ? 'exhausted' : 'available'
    const expires = acc.expiresAt != null ? formatRelativeMs(acc.expiresAt - now) : '—'
    const quotaReset =
      acc.exhausted && acc.exhausted_until != null && acc.exhausted_until > now
        ? formatRelativeMs(acc.exhausted_until - now)
        : '—'
    rows.push([`${marker} ${escapeHtml(acc.label)}`, status, expires, quotaReset])
  }
  return alignTable(rows)
}

function formatAgentsTable(state: ListStateData): string {
  const rows: string[][] = [['AGENT', 'ACTIVE', 'SOURCE']]
  for (const a of state.agents) {
    const source = a.override
      ? 'override'
      : a.account === state.active
        ? 'fleet-active'
        : 'pinned'
    rows.push([escapeHtml(a.name), escapeHtml(a.account), source])
  }
  return alignTable(rows)
}

function formatConsumersTable(state: ListStateData, now: number): string {
  const rows: string[][] = [['CONSUMER', 'ACTIVE', 'STATUS']]
  for (const c of state.consumers) {
    const status =
      c.last_seen_at == null
        ? 'socket bound'
        : `socket bound (last seen ${formatRelativeMs(now - c.last_seen_at)} ago)`
    rows.push([escapeHtml(c.name), escapeHtml(c.account), status])
  }
  return alignTable(rows)
}

// ─── Plain-text helpers ────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function formatRelativeMs(ms: number): string {
  if (ms <= 0) return '0s'
  const totalSec = Math.floor(ms / 1000)
  const days = Math.floor(totalSec / 86400)
  const hours = Math.floor((totalSec % 86400) / 3600)
  const mins = Math.floor((totalSec % 3600) / 60)
  const secs = totalSec % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${mins}m`
  if (mins > 0) return `${mins}m ${secs}s`
  return `${secs}s`
}

/**
 * Right-pad columns so they line up under a fixed-width Telegram
 * `<pre>` block. Last column is left untrimmed so it can run to its
 * natural width.
 */
function alignTable(rows: string[][]): string {
  if (rows.length === 0) return ''
  const widths: number[] = []
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) {
      const cell = row[i] ?? ''
      widths[i] = Math.max(widths[i] ?? 0, cell.length)
    }
  }
  const out: string[] = []
  for (const row of rows) {
    const parts: string[] = []
    for (let i = 0; i < row.length; i++) {
      const cell = row[i] ?? ''
      if (i === row.length - 1) parts.push(cell)
      else parts.push(cell.padEnd(widths[i] ?? cell.length, ' '))
    }
    out.push(parts.join('  '))
  }
  return out.join('\n')
}
