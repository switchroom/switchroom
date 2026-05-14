/**
 * `/auth` chat-command parser + handler (RFC H §7.3).
 *
 * The slot-pool-era dashboard at `telegram-plugin/auth-dashboard.ts`
 * — and its callback-driven inline-keyboard surface — is gone. The
 * fleet-wide active-account model offers a verb tree that mirrors
 * `switchroom auth` on the CLI (RFC H Decision 11 — "same shape on
 * the CLI and in Telegram"):
 *
 *   /auth                          — alias of `show`
 *   /auth show [<agent>]           — fleet snapshot, or one agent's
 *                                    effective account + mirror state
 *   /auth list                     — alias of `show` (no agent)
 *   /auth use <label>              — admin-only fleet swap
 *   /auth rotate                   — admin-only failover to next non-
 *                                    exhausted entry in fallback_order
 *   /auth add <label>              — admin-only chat-native OAuth flow
 *   /auth cancel                   — admin-only abort of `/auth add`
 *   /auth rm <label> [confirm]     — admin-only, two-step destructive
 *   /auth refresh [<label>]        — admin-only diagnostic force-tick
 *   /auth agent override <a> <l|clear>
 *                                  — admin-only per-agent pin
 *   /auth help                     — verb listing
 *
 * Parse is pure (no I/O) so callers can route on the verb without
 * needing a broker. The handler is async and talks to the broker
 * client; on broker failure it returns a user-facing error reply
 * rather than throwing.
 */

import type { ListStateData, AccountState } from './auth-line.js'

// ─── Parser ────────────────────────────────────────────────────────────────

export type ParsedAuthCommand =
  | { kind: 'show'; agent?: string }
  | { kind: 'list' }
  | { kind: 'use'; label: string }
  | { kind: 'rotate' }
  | { kind: 'add'; label: string }
  | { kind: 'cancel' }
  | { kind: 'rm-prompt'; label: string }
  | { kind: 'rm-confirmed'; label: string }
  | { kind: 'refresh'; label?: string }
  | { kind: 'override-set'; agent: string; label: string }
  | { kind: 'override-clear'; agent: string }
  | { kind: 'help'; reason?: string }

/**
 * TTL for the two-step `/auth rm` confirm window. Operators have
 * 60s between the prompt and the `confirm` follow-up — long enough
 * to read the warning and switch focus from chat to broker docs,
 * short enough that a stale tab from yesterday can't auto-delete an
 * account by accident.
 */
export const AUTH_RM_CONFIRM_TTL_MS = 60_000

/**
 * In-flight `/auth rm` confirm flow keyed by Telegram chat id.
 * Sibling to `pendingAuthAddFlows` in `auth-add-flow.ts` — same
 * shape, smaller surface (no subprocess to lifecycle-manage).
 * The gateway's chat-command handler reads/writes this map; the
 * confirm verb refuses if the entry is missing, expired, or for a
 * different label.
 */
export interface PendingAuthRmFlow {
  label: string
  expiresAt: number
}
export const pendingAuthRmFlows = new Map<string, PendingAuthRmFlow>()

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
    case 'show': {
      const agent = parts[1]
      if (agent) return { kind: 'show', agent }
      return { kind: 'show' }
    }
    case 'list':
      // List is a strict alias of bare `/auth show` (fleet snapshot).
      // Per RFC H Decision 11 — same shape as the CLI verb.
      return { kind: 'list' }
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
    case 'rm': {
      const label = parts[1]
      if (!label) return { kind: 'help', reason: 'Usage: /auth rm <label> [confirm]' }
      const labelErr = validateAuthAddLabel(label)
      if (labelErr) return { kind: 'help', reason: labelErr }
      // Two-step: a literal `confirm` token in slot 2 means "phase 2 —
      // actually delete". Anything else is a "phase 1 — show prompt".
      const tail = (parts[2] ?? '').toLowerCase()
      if (tail === 'confirm') return { kind: 'rm-confirmed', label }
      if (tail.length > 0) {
        return {
          kind: 'help',
          reason: `Unknown <code>rm</code> modifier: <code>${escapeHtml(tail)}</code>. Use <code>/auth rm &lt;label&gt; confirm</code> to confirm.`,
        }
      }
      return { kind: 'rm-prompt', label }
    }
    case 'refresh': {
      const label = parts[1]
      if (label) {
        const err = validateAuthAddLabel(label)
        if (err) return { kind: 'help', reason: err }
        return { kind: 'refresh', label }
      }
      return { kind: 'refresh' }
    }
    case 'agent': {
      // Only `/auth agent override <agent> <label|clear>` is wired. Any
      // other shape is a help-with-reason so the operator sees the
      // expected verb tree.
      const sub = (parts[1] ?? '').toLowerCase()
      if (sub !== 'override') {
        return {
          kind: 'help',
          reason: `Unknown <code>agent</code> subcommand: <code>${escapeHtml(sub || '(none)')}</code>. Try <code>/auth agent override &lt;agent&gt; &lt;label|clear&gt;</code>.`,
        }
      }
      const agent = parts[2]
      const target = parts[3]
      if (!agent || !target) {
        return {
          kind: 'help',
          reason: 'Usage: /auth agent override &lt;agent&gt; &lt;label|clear&gt;',
        }
      }
      if (target.toLowerCase() === 'clear') {
        return { kind: 'override-clear', agent }
      }
      const labelErr = validateAuthAddLabel(target)
      if (labelErr) return { kind: 'help', reason: labelErr }
      return { kind: 'override-set', agent, label: target }
    }
    case 'help':
      return { kind: 'help' }
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
  rmAccount(label: string): Promise<{ label: string }>
  refreshAccount(label: string): Promise<{ account: string; expiresAt?: number }>
  setOverride(
    agent: string,
    account: string | null,
  ): Promise<{ agent: string; account: string | null }>
}

export interface AuthCommandContext {
  /** The agent the gateway is bound to (its socket-path identity). */
  agentName: string
  /** Names of agents allowed to mutate fleet state. Empty / undefined → no admin. */
  adminAgents: ReadonlyArray<string> | undefined
  client: AuthBrokerClient
  /**
   * Telegram chat id this command was issued in. Used to key the
   * `/auth rm` two-step confirm window (see `pendingAuthRmFlows`).
   * Optional only so legacy gateway-routed verbs (`add`, `cancel`)
   * that never reach the destructive branches can skip wiring it.
   */
  chatId?: string
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
        `${reason}<b>/auth</b> — verbs (mirror of <code>switchroom auth</code>):\n` +
        `  <code>/auth</code> — show fleet snapshot (alias of <code>show</code>)\n` +
        `  <code>/auth show</code> — show fleet snapshot\n` +
        `  <code>/auth show &lt;agent&gt;</code> — show one agent's effective account + mirror state\n` +
        `  <code>/auth list</code> — alias of <code>/auth show</code>\n` +
        `  <code>/auth use &lt;label&gt;</code> — admin: swap the fleet to &lt;label&gt;\n` +
        `  <code>/auth rotate</code> — admin: cycle to next non-exhausted fallback\n` +
        `  <code>/auth add &lt;label&gt;</code> — admin: OAuth-add a new account from chat\n` +
        `  <code>/auth cancel</code> — abort an <code>/auth add</code> in progress\n` +
        `  <code>/auth rm &lt;label&gt;</code> — admin: remove an account (two-step confirm)\n` +
        `  <code>/auth refresh [&lt;label&gt;]</code> — admin: force a refresh tick\n` +
        `  <code>/auth agent override &lt;agent&gt; &lt;label|clear&gt;</code> — admin: per-agent account override\n` +
        `  <code>/auth help</code> — this list`,
      html: true,
    }
  }

  // `show` (no agent) and `list` both render the fleet snapshot; share
  // one code path so the two verbs can't diverge.
  if (
    parsed.kind === 'list' ||
    (parsed.kind === 'show' && parsed.agent === undefined)
  ) {
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

  if (parsed.kind === 'show') {
    // parsed.agent is non-undefined by the branch above.
    const agentName = parsed.agent as string
    try {
      const state = await ctx.client.listState()
      const agent = state.agents.find((a) => a.name === agentName)
      if (!agent) {
        return {
          text:
            `<b>/auth show:</b> no agent named <code>${escapeHtml(agentName)}</code> in broker view.\n` +
            `Run <code>/auth show</code> for the fleet snapshot.`,
          html: true,
        }
      }
      return { text: renderAgentDetail(state, agent), html: true }
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

  if (parsed.kind === 'rotate') {
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

  if (parsed.kind === 'rm-prompt') {
    // Phase 1 — gate, validate against current state, stash pending.
    // Refuse early if the label is unknown or is the fleet active, so
    // the destructive prompt itself can't lie about what's possible.
    let state: ListStateData
    try {
      state = await ctx.client.listState()
    } catch (err) {
      return {
        text: `<b>/auth rm failed:</b> ${escapeHtml((err as Error)?.message ?? String(err))}`,
        html: true,
      }
    }
    const exists = state.accounts.some((a) => a.label === parsed.label)
    if (!exists) {
      return {
        text:
          `<b>/auth rm:</b> no account named <code>${escapeHtml(parsed.label)}</code>. ` +
          `Run <code>/auth show</code> for the current list.`,
        html: true,
      }
    }
    if (state.active === parsed.label) {
      return {
        text:
          `<b>/auth rm refused.</b> <code>${escapeHtml(parsed.label)}</code> is the fleet active. ` +
          `Switch with <code>/auth use &lt;other&gt;</code> or <code>/auth rotate</code> first.`,
        html: true,
      }
    }
    // Stash. The gateway is responsible for keying this map by chat
    // id; the handler can't see ctx.chat. We expose the helper as a
    // mutation through the side-channel below so the gateway can wire
    // it after admin-gating. To keep the handler self-contained for
    // tests, fall back to populating the map directly when a chatId
    // is supplied via ctx (set by the gateway wrapper).
    if (ctx.chatId) {
      pendingAuthRmFlows.set(ctx.chatId, {
        label: parsed.label,
        expiresAt: Date.now() + AUTH_RM_CONFIRM_TTL_MS,
      })
    }
    return {
      text:
        `<b>⚠ /auth rm</b> — about to remove <code>${escapeHtml(parsed.label)}</code> from the broker.\n` +
        `The fleet active is unchanged. Any agent override pointing at <code>${escapeHtml(parsed.label)}</code> will stop working.\n\n` +
        `Send <code>/auth rm ${escapeHtml(parsed.label)} confirm</code> within ${Math.round(
          AUTH_RM_CONFIRM_TTL_MS / 1000,
        )}s to proceed.`,
      html: true,
    }
  }

  if (parsed.kind === 'rm-confirmed') {
    const pending = ctx.chatId ? pendingAuthRmFlows.get(ctx.chatId) : undefined
    const now = Date.now()
    if (!pending || pending.label !== parsed.label || pending.expiresAt <= now) {
      if (ctx.chatId && pending && pending.expiresAt <= now) {
        pendingAuthRmFlows.delete(ctx.chatId)
      }
      return {
        text:
          `<b>/auth rm:</b> no pending confirm for <code>${escapeHtml(parsed.label)}</code> (expired or not started). ` +
          `Send <code>/auth rm ${escapeHtml(parsed.label)}</code> first.`,
        html: true,
      }
    }
    // Clear before the broker call — re-entrance / double-tap should
    // not delete twice.
    if (ctx.chatId) pendingAuthRmFlows.delete(ctx.chatId)
    try {
      const data = await ctx.client.rmAccount(parsed.label)
      return {
        text: `<b>Removed</b> <code>${escapeHtml(data.label)}</code> from the broker.`,
        html: true,
      }
    } catch (err) {
      return {
        text: `<b>/auth rm failed:</b> ${escapeHtml((err as Error)?.message ?? String(err))}`,
        html: true,
      }
    }
  }

  if (parsed.kind === 'refresh') {
    try {
      const state = await ctx.client.listState()
      const targets = parsed.label
        ? state.accounts.filter((a) => a.label === parsed.label).map((a) => a.label)
        : state.accounts.map((a) => a.label)
      if (parsed.label && targets.length === 0) {
        return {
          text:
            `<b>/auth refresh:</b> no account named <code>${escapeHtml(parsed.label)}</code>.`,
          html: true,
        }
      }
      if (targets.length === 0) {
        return { text: `<b>/auth refresh:</b> no accounts to refresh.`, html: true }
      }
      const oldByLabel = new Map(state.accounts.map((a) => [a.label, a.expiresAt]))
      const rows: string[][] = [['ACCOUNT', 'OLD EXPIRY', 'NEW EXPIRY']]
      const failures: string[] = []
      for (const label of targets) {
        try {
          const data = await ctx.client.refreshAccount(label)
          rows.push([
            label,
            formatExpiryAbs(oldByLabel.get(label)),
            formatExpiryAbs(data.expiresAt),
          ])
        } catch (err) {
          failures.push(
            `${label}: ${escapeHtml((err as Error)?.message ?? String(err))}`,
          )
        }
      }
      const head =
        targets.length === 1
          ? `<b>Refreshed</b> <code>${escapeHtml(targets[0]!)}</code>`
          : `<b>Refreshed</b> ${rows.length - 1}/${targets.length} account${targets.length === 1 ? '' : 's'}`
      const table = rows.length > 1
        ? `\n<pre>${alignTable(rows)}</pre>`
        : ''
      const failBlock = failures.length > 0
        ? `\n<b>Failures:</b>\n${failures.map((f) => `  ${f}`).join('\n')}`
        : ''
      return { text: head + table + failBlock, html: true }
    } catch (err) {
      return {
        text: `<b>/auth refresh failed:</b> ${escapeHtml((err as Error)?.message ?? String(err))}`,
        html: true,
      }
    }
  }

  if (parsed.kind === 'override-set') {
    try {
      const data = await ctx.client.setOverride(parsed.agent, parsed.label)
      return {
        text:
          `<b>Override set.</b> <code>${escapeHtml(data.agent)}</code> is now pinned to ` +
          `<code>${escapeHtml(data.account ?? parsed.label)}</code>.`,
        html: true,
      }
    } catch (err) {
      return {
        text: `<b>/auth agent override failed:</b> ${escapeHtml((err as Error)?.message ?? String(err))}`,
        html: true,
      }
    }
  }

  if (parsed.kind === 'override-clear') {
    try {
      const data = await ctx.client.setOverride(parsed.agent, null)
      return {
        text:
          `<b>Override cleared</b> on <code>${escapeHtml(data.agent)}</code> ` +
          `— back to fleet active.`,
        html: true,
      }
    } catch (err) {
      return {
        text: `<b>/auth agent override failed:</b> ${escapeHtml((err as Error)?.message ?? String(err))}`,
        html: true,
      }
    }
  }

  // Exhaustiveness — any future ParsedAuthCommand variant lands here.
  const _exhaustive: never = parsed
  void _exhaustive
  return {
    text: `<b>/auth:</b> unhandled verb. Report this.`,
    html: true,
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

/**
 * Per-agent detail block — what `switchroom auth show <agent>` prints
 * on the CLI, adapted to Telegram HTML. Shows effective account,
 * override-vs-fleet-active source, token expiry, last refresh, and
 * exhausted / threshold-violation warnings when relevant.
 */
export function renderAgentDetail(
  state: ListStateData,
  agent: { name: string; account: string; override: string | null },
  now: number = Date.now(),
): string {
  const lines: string[] = []
  lines.push(`<b>${escapeHtml(agent.name)}</b>`)
  const source = agent.override ? 'override' : 'fleet-active'
  lines.push(
    `Active account: <code>${escapeHtml(agent.account)}</code> (${source})`,
  )
  const acct = state.accounts.find((a) => a.label === agent.account)
  if (acct) {
    const expRel = acct.expiresAt != null ? formatRelativeMs(acct.expiresAt - now) : '—'
    lines.push(`Token expires: ${expRel}`)
    if (typeof acct.last_refreshed_at === 'number') {
      lines.push(
        `Last refresh: ${formatRelativeMs(now - acct.last_refreshed_at)} ago`,
      )
    }
    if (acct.exhausted) {
      const resetRel =
        acct.exhausted_until != null && acct.exhausted_until > now
          ? formatRelativeMs(acct.exhausted_until - now)
          : '—'
      lines.push(`<i>Quota: exhausted · resets in ${resetRel}</i>`)
    }
    if (typeof acct.threshold_violations === 'number' && acct.threshold_violations > 0) {
      lines.push(
        `<i>Threshold violations: ${acct.threshold_violations} — claude refreshed under the broker's feet</i>`,
      )
    }
  }
  return lines.join('\n')
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
 * Format an absolute expiresAt epoch-ms as a short relative-to-now
 * string. Returns `'—'` when the value is missing or non-finite.
 * Used in the /auth refresh old-vs-new table.
 */
function formatExpiryAbs(expiresAt?: number, now: number = Date.now()): string {
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return '—'
  const delta = expiresAt - now
  if (delta <= 0) return 'expired'
  return formatRelativeMs(delta)
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
