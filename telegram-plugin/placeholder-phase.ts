/**
 * Placeholder phases — outcome-focused labels for what the agent is
 * doing, expressed in language non-technical users understand.
 *
 * Design: docs/heartbeat-phases-design.md.
 *
 * The user perceives a sequence of phases during the model's TTFT
 * window:
 *
 *   T+~500ms  🔵 thinking                                   (pre-alloc)
 *   T+~1s     🔵 Got your message, working on it…           (auto-ack)
 *   T+~1s     📚 Looking through what we've talked about    (recall)
 *   T+~7s     💭 Thinking it through · 7s                   (post-recall)
 *   T+~12s    🔍 Looking something up · 12s                 (file read)
 *   T+~18s    🤖 Asking a specialist for help · 18s         (sub-agent)
 *   T+~25s    ✍️ Writing your reply · 25s                  (model writes)
 *
 * No technical jargon — `🔍 Looking something up` not `Read X` or
 * `grep`. `🤖 Asking a specialist` not `Agent(subagent_type='Explore')`.
 *
 * This module is pure: maps tool names + Bash command strings to
 * phases. Wiring (subscribers, gateway state) lives in `gateway.ts`.
 */

export type PhaseKind =
  | 'acknowledged'
  | 'recalling'
  | 'thinking'
  | 'looking_up'
  | 'checking'
  | 'working'
  | 'asking_specialist'
  | 'writing_reply'

export interface Phase {
  /** Stable identifier — use for state map keys, telemetry, tests. */
  kind: PhaseKind
  /** User-facing text. Includes the leading emoji. Never technical. */
  label: string
}

/**
 * Canonical phase labels. Single source of truth for the user-facing
 * text. Updating these updates everywhere they're rendered.
 */
export const PHASES: Record<PhaseKind, Phase> = {
  acknowledged: {
    kind: 'acknowledged',
    label: '🔵 Got your message, working on it…',
  },
  recalling: {
    kind: 'recalling',
    label: "📚 Looking through what we've talked about",
  },
  thinking: {
    kind: 'thinking',
    label: '💭 Thinking it through',
  },
  looking_up: {
    kind: 'looking_up',
    label: '🔍 Looking something up',
  },
  checking: {
    kind: 'checking',
    label: '⚙️ Checking on something',
  },
  working: {
    kind: 'working',
    label: '✏️ Making changes',
  },
  asking_specialist: {
    kind: 'asking_specialist',
    label: '🤖 Asking a specialist for help',
  },
  writing_reply: {
    kind: 'writing_reply',
    label: '✍️ Writing your reply',
  },
}

/**
 * Lookup table — built-in tools we've seen + their phase mapping.
 * Unknown tools (anything not here) produce no phase change; the
 * current phase persists. See §3.1 phase rule 5.
 */
const TOOL_PHASE_MAP: Record<string, PhaseKind | 'no_change'> = {
  // Looking things up — passive read activity
  Read: 'looking_up',
  Grep: 'looking_up',
  Glob: 'looking_up',
  WebFetch: 'looking_up',
  WebSearch: 'looking_up',

  // Making changes — active write activity
  Edit: 'working',
  Write: 'working',
  NotebookEdit: 'working',

  // Specialist dispatch
  Task: 'asking_specialist',
  Agent: 'asking_specialist',

  // Telegram surface tools — model is about to write a reply
  reply: 'writing_reply',
  stream_reply: 'writing_reply',

  // MCP tools that don't warrant a phase change (cosmetic / ambient)
  react: 'no_change',
  send_typing: 'no_change',
  edit_message: 'no_change',
  delete_message: 'no_change',
  forward_message: 'no_change',
  pin_message: 'no_change',
  download_attachment: 'no_change',
  get_recent_messages: 'no_change',

  // TodoWrite, AskUserQuestion etc. — agent self-organisation, not
  // user-relevant
  TodoWrite: 'no_change',
  AskUserQuestion: 'no_change',

  // Bash is handled separately via toolUseToPhase; not in this map
}

/**
 * Read-only Bash heuristic — strict starts-with on the FIRST word
 * of the command (or on `git <subcommand>` for git's read-only ops).
 *
 * False negatives (calling `working` when actually read-only) are
 * SAFER than false positives (calling `checking` when actually
 * destructive). Keep narrow.
 */
const READ_ONLY_FIRST_WORD = new Set([
  'ls',
  'cat',
  'pwd',
  'which',
  'head',
  'tail',
  'wc',
  'du',
  'ps',
  'df',
  'echo',
  'printenv',
  'env',
  'stat',
  'file',
  'whoami',
  'date',
])

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  'status',
  'log',
  'diff',
  'show',
  'branch',
  'remote',
  'config',
  'rev-parse',
  'describe',
  'blame',
])

/**
 * Decide whether a Bash command is read-only. Examines the FIRST
 * shell command in the string (treats `|` and `&&` as separators
 * — classifies on the first command only).
 */
export function isReadOnlyBashCommand(command: string): boolean {
  const trimmed = command.trim()
  if (trimmed.length === 0) return false

  // Take the first command only — split on pipes / && / ;
  const firstCmd = trimmed.split(/[|&;]/)[0]?.trim() ?? ''
  if (firstCmd.length === 0) return false

  // First word
  const parts = firstCmd.split(/\s+/)
  const firstWord = parts[0] ?? ''

  if (READ_ONLY_FIRST_WORD.has(firstWord)) return true

  // git <subcommand> — only if subcommand is in the read-only set
  if (firstWord === 'git' && parts.length >= 2) {
    return READ_ONLY_GIT_SUBCOMMANDS.has(parts[1] ?? '')
  }

  return false
}

/**
 * Map a tool_use event to a phase change. Returns:
 *   - `Phase` — the new phase (caller writes it to currentPhase map)
 *   - `null` — no phase change (current phase persists)
 *
 * Bash splits into `checking` (read-only) vs `working` (everything
 * else). Other tools follow the static lookup table.
 *
 * Unknown tools return null (current phase persists). This is the
 * default — we don't speculate about tools we haven't catalogued.
 */
export function toolUseToPhase(
  toolName: string,
  input?: Record<string, unknown>,
): Phase | null {
  // Bash special case
  if (toolName === 'Bash') {
    const command = typeof input?.command === 'string' ? input.command : ''
    return isReadOnlyBashCommand(command) ? PHASES.checking : PHASES.working
  }

  // MCP tools come through with `mcp__server__tool` naming; strip
  // the prefix to match the unqualified name in the lookup.
  const unqualified = toolName.startsWith('mcp__')
    ? (toolName.split('__').pop() ?? toolName)
    : toolName

  const mapped = TOOL_PHASE_MAP[unqualified]
  if (mapped === 'no_change' || mapped === undefined) return null
  return PHASES[mapped]
}

/**
 * Resolve recall.py's existing literal text to a phase, for
 * backward-compat with the current `update_placeholder` IPC contract.
 * recall.py emits these strings today — we map them to canonical
 * phases without requiring a coordinated change.
 *
 * Returns the phase if the text matches a known recall transition,
 * or null if it's a custom literal label that should pass through
 * unchanged. (See `update-placeholder-handler.ts` for the fall-through
 * behavior.)
 */
export function recallTextToPhase(text: string): Phase | null {
  const normalized = text.trim()

  // recall.py PR #496 dropped trailing ellipsis but check both shapes
  // for forward+backward compat:
  if (normalized === '📚 recalling memories' || normalized === '📚 recalling memories…') {
    return PHASES.recalling
  }
  if (normalized === '💭 thinking' || normalized === '💭 thinking…') {
    return PHASES.thinking
  }

  return null
}
