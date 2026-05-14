/**
 * admin-commands/index.ts
 *
 * Shared dispatcher for switchroom admin slash commands. Used by both:
 *  - gateway.ts  (when SWITCHROOM_AGENT_ADMIN=true in the agent's systemd unit)
 *  - server.ts   (legacy monolith — always acts as its own admin)
 *
 * The dispatcher is intentionally thin: it only decides whether an inbound
 * text message matches a known admin command AND should be handled locally
 * (intercepted before Claude sees it). Actual command execution lives in the
 * Grammy bot.command() handlers in gateway.ts / server.ts; this module
 * provides the gating logic and the canonical command list so both paths
 * stay in sync.
 *
 * Architecture
 * ────────────
 * Grammy routes a message to whichever handler matches first. `bot.command()`
 * handlers fire BEFORE `bot.on('message:text')`, so a `/agents` message never
 * reaches `handleInbound` under normal circumstances. However, when admin=false
 * we WANT those commands to fall through to Claude. The gateway registers a
 * middleware (via `makeAdminCommandMiddleware`) BEFORE its bot.command() calls;
 * the middleware redirects to handleInbound when admin=false.
 *
 * Out of scope
 * ────────────
 * `/create-agent` is a multi-turn wizard for onboarding a new agent
 * from Telegram. Not implemented — operators run `switchroom agent
 * add <name>` on the host. (The standalone foreman bot used to host
 * this wizard; it was retired since the gateway-intercept model
 * supersedes it.)
 */

/**
 * The set of command names that are treated as "admin commands" — intercepted
 * by the gateway when SWITCHROOM_AGENT_ADMIN=true, forwarded to Claude otherwise.
 *
 * Scope: ONLY fleet-management verbs (lifecycle, scaffolding, privileges,
 * secrets). Per-agent / per-chat ops — auth, interrupt, permission flow,
 * info commands (`/version`, `/doctor`, `/usage`), session reset (`/new`,
 * `/reset`), and `/commands` — must always be gateway-handled
 * regardless of admin status, because they need to work even when the model
 * is unreachable (rate-limited, expired token, network down). Routing those
 * through Claude defeats the entire point of the slash-command UX.
 *
 * Keep in sync with the bot.command() registrations in gateway.ts.
 */
export const ADMIN_COMMAND_NAMES = new Set<string>([
  // Fleet lifecycle
  'agents',
  'logs',
  'restart',
  'stop',
  'agentstart',
  'update',
  'reconcile',
  // Privileges + secrets
  'grant',
  'dangerous',
  'permissions',
  'vault',
  // Per-agent ops that read shared fleet state via the switchroom CLI
  'memory',
  'topics',
])

/**
 * Parse a slash command name from a text message, accounting for bot@username
 * suffixes (e.g. `/agents@mybot`). Returns null for non-command text.
 */
export function parseCommandName(text: string): string | null {
  if (!text.startsWith('/')) return null
  // Extract the part after / up to the first space or end-of-string,
  // stripping an optional @botname suffix.
  const raw = text.split(' ')[0]!.slice(1)
  const atIdx = raw.indexOf('@')
  return atIdx === -1 ? raw.toLowerCase() : raw.slice(0, atIdx).toLowerCase()
}

/**
 * Parse the argument portion of a slash command (everything after the command
 * token, trimmed). Returns '' when no argument is present.
 *
 *   parseCommandArg('/restart')           === ''
 *   parseCommandArg('/restart   ')        === ''
 *   parseCommandArg('/restart foo')       === 'foo'
 *   parseCommandArg('/restart@bot foo')   === 'foo'
 *   parseCommandArg('/restart foo bar')   === 'foo bar'
 */
export function parseCommandArg(text: string): string {
  if (!text.startsWith('/')) return ''
  const spaceIdx = text.indexOf(' ')
  if (spaceIdx === -1) return ''
  return text.slice(spaceIdx + 1).trim()
}

/**
 * Result of admin-gate classification used by the gateway middleware to decide
 * how to handle an inbound slash command when admin gating is OFF.
 *
 *  - `pass-through` — let the command fall through to the gateway's local
 *    bot.command() handler. Used for non-admin commands AND for `/restart`
 *    targeting the current agent (self-restart is always allowed).
 *  - `block` — the gateway should reply with an "admin required" warning and
 *    NOT forward the message to Claude.
 *
 * `reason` distinguishes the two block cases for the audit log:
 *  - `other-agent` — `/restart` aimed at a different agent
 *  - `admin-required` — any other ADMIN_COMMAND_NAMES verb
 */
export type AdminGateDecision =
  | { action: 'pass-through' }
  | { action: 'block'; reason: 'other-agent' | 'admin-required'; cmd: string }

/**
 * Decide what the gateway middleware should do with an inbound text message
 * when SWITCHROOM_AGENT_ADMIN=false.
 *
 * Rules:
 *  - Non-slash text → pass-through.
 *  - Unknown / non-admin slash command → pass-through.
 *  - `/restart` with no arg, or arg matching `myAgentName` → pass-through
 *    (gateway's local bot.command('restart', …) handles self-restart).
 *  - `/restart <other-agent>` → block (reason='other-agent').
 *  - Any other ADMIN_COMMAND_NAMES verb → block (reason='admin-required').
 *
 * This function is pure and synchronous so it can be unit-tested without a
 * Grammy context. The middleware in gateway.ts does the side effects.
 */
export function classifyAdminGate(
  text: string,
  myAgentName: string,
): AdminGateDecision {
  if (!text.startsWith('/')) return { action: 'pass-through' }
  const cmd = parseCommandName(text)
  if (cmd === null || !ADMIN_COMMAND_NAMES.has(cmd)) {
    return { action: 'pass-through' }
  }
  if (cmd === 'restart') {
    const arg = parseCommandArg(text)
    // Case-insensitive: assertSafeAgentName allows mixed case, so `/restart Clerk`
    // must still self-target an agent named `clerk`.
    if (arg === '' || arg.toLowerCase() === myAgentName.toLowerCase()) {
      return { action: 'pass-through' }
    }
    return { action: 'block', reason: 'other-agent', cmd }
  }
  return { action: 'block', reason: 'admin-required', cmd }
}

/**
 * Decide whether an inbound message should be intercepted as an admin command.
 *
 * Returns `{ handled: true }` when:
 *   - `adminEnabled` is true (SWITCHROOM_AGENT_ADMIN=true)
 *   - `text` starts with `/`
 *   - The command name is in ADMIN_COMMAND_NAMES
 *
 * Returns `{ handled: false }` in all other cases — the message should fall
 * through to normal processing (forwarded to Claude via IPC).
 *
 * Note: this function does NOT execute the command. Execution is performed by
 * Grammy's bot.command() handlers in gateway.ts. This function is used:
 *  1. By the gateway middleware to decide whether to forward non-admin-gated
 *     commands to Claude (when adminEnabled=false).
 *  2. By tests to verify the dispatch table is correct without starting a bot.
 */
export function dispatchAdminCommand(
  text: string,
  adminEnabled: boolean,
): { handled: boolean } {
  // Belt-and-braces: even if the caller forgot to check, we never intercept
  // when admin is off.
  if (!adminEnabled) return { handled: false }
  if (!text.startsWith('/')) return { handled: false }
  const cmd = parseCommandName(text)
  if (!cmd) return { handled: false }
  if (ADMIN_COMMAND_NAMES.has(cmd)) return { handled: true }
  return { handled: false }
}
