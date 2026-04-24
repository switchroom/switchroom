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
 * Out of scope for Phase 1
 * ────────────────────────
 * `/create-agent` has a complex multi-turn state machine (persisted wizard
 * state across messages). It is intentionally NOT included here and remains
 * foreman/server-only until Phase 2 or later.
 */

/**
 * The set of command names that are treated as "admin commands" — intercepted
 * by the gateway when SWITCHROOM_AGENT_ADMIN=true, forwarded to Claude otherwise.
 *
 * Keep in sync with the bot.command() registrations in gateway.ts.
 */
export const ADMIN_COMMAND_NAMES = new Set<string>([
  'agents',
  'logs',
  'restart',
  'update',
  'auth',
  'reauth',
  'reconcile',
  'stop',
  'switchroomstart',
  'grant',
  'dangerous',
  'permissions',
  'switchroomhelp',
  'doctor',
  'memory',
  'usage',
  'topics',
  'vault',
  'authfallback',
  'new',
  'reset',
  'approve',
  'deny',
  'pending',
  'interrupt',
  'pins-status',
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
