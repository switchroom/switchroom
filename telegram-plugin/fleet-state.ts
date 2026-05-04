/**
 * P0 of #662 — fleet state struct + pure transition functions.
 *
 * `FleetMember` is the per-sub-agent unit the v2 two-zone status card
 * (P1) will render. This module is pure data plumbing: the driver
 * shadows a `Map<agentId, FleetMember>` alongside the legacy
 * `chatState.subAgents` map and updates it through the reducers below
 * at the same sites the legacy map is mutated. No render code, no
 * timers, no globals — clocks and IDs are caller-supplied so tests can
 * drive deterministic transitions.
 *
 * Status derivation (verified in #662): `session-tail.ts:101` defines
 * `sub_agent_turn_end` as `{kind, agentId}` with NO terminal-status
 * field, so failure must be derived: any `sub_agent_tool_result` with
 * `isError=true` accumulates into `errorSeen`, and `applyTurnEnd` flips
 * `status` to `failed` if any error was seen, else `done`.
 */

const ROLE_FALLBACK_LEN = 20
const SANITISE_MAX_LEN = 120

export type FleetStatus = 'running' | 'background' | 'done' | 'failed' | 'stuck' | 'killed'

export interface FleetMember {
  agentId: string
  /** Display label: description / subagentType / first-prompt slice / 'agent'. */
  role: string
  /** ms epoch when this member was registered (driver snapshot of `now()`). */
  startedAt: number
  toolCount: number
  /** ms epoch of the most recent tool_use / tool_result for this member. */
  lastActivityAt: number
  /** Most recent tool call observed (name + sanitised arg for display). */
  lastTool: { name: string; sanitisedArg: string } | null
  status: FleetStatus
  /** ms epoch when status became terminal (done/failed/killed); null otherwise. */
  terminalAt: number | null
  /** True if any sub_agent_tool_result with isError=true has been observed. */
  errorSeen: boolean
  /** Snapshot of driver's currentTurnKey at sub_agent_started. Stable across turns. */
  originatingTurnKey: string
}

export interface CreateFleetMemberArgs {
  agentId: string
  role: string
  startedAt: number
  originatingTurnKey: string
}

export function createFleetMember(args: CreateFleetMemberArgs): FleetMember {
  return {
    agentId: args.agentId,
    role: args.role,
    startedAt: args.startedAt,
    toolCount: 0,
    lastActivityAt: args.startedAt,
    lastTool: null,
    status: 'running',
    terminalAt: null,
    errorSeen: false,
    originatingTurnKey: args.originatingTurnKey,
  }
}

export function applyToolUse(
  member: FleetMember,
  toolName: string,
  input: Record<string, unknown> | undefined,
  now: number,
): FleetMember {
  // P3 of #662 — recovery from stuck. A live tool event proves the
  // sub-agent is alive again, so flip status back to running. Terminal
  // statuses (done/failed/killed) are sticky and never reset here.
  const status: FleetStatus = member.status === 'stuck' ? 'running' : member.status
  return {
    ...member,
    status,
    toolCount: member.toolCount + 1,
    lastActivityAt: now,
    lastTool: { name: toolName, sanitisedArg: sanitiseToolArg(toolName, input ?? {}) },
  }
}

export function applyToolResult(member: FleetMember, isError: boolean | undefined): FleetMember {
  if (!isError) return member
  if (member.errorSeen) return member
  return { ...member, errorSeen: true }
}

export function applyTurnEnd(member: FleetMember, now: number): FleetMember {
  // Idempotent — if already terminal, do nothing.
  if (member.terminalAt != null) return member
  return {
    ...member,
    status: member.errorSeen ? 'failed' : 'done',
    terminalAt: now,
    lastActivityAt: now,
  }
}

export function markStuck(member: FleetMember, now: number, idleMs: number = 60_000): FleetMember {
  if (member.status !== 'running') return member
  if (now - member.lastActivityAt < idleMs) return member
  return { ...member, status: 'stuck' }
}

/**
 * P2 of #662 / fixes #64 — true if any fleet member is in
 * `status: 'background'` AND has not yet reached terminal state. Used by
 * the driver's dispose path to keep a PerChatState alive past parent
 * turn_end while background sub-agents are still running, and by the v2
 * renderer's phase resolver to choose ⏸ Background vs ✅ Done.
 */
export function hasLiveBackground(fleet: ReadonlyMap<string, FleetMember>): boolean {
  for (const m of fleet.values()) {
    if (m.status === 'background' && m.terminalAt == null) return true
  }
  return false
}

export function cap(
  members: readonly FleetMember[],
  n: number = 5,
): { visible: FleetMember[]; hidden: number } {
  const sorted = [...members].sort((a, b) => b.lastActivityAt - a.lastActivityAt)
  if (sorted.length <= n) return { visible: sorted, hidden: 0 }
  return { visible: sorted.slice(0, n), hidden: sorted.length - n }
}

/**
 * Sanitise a tool input for display on the fleet row.
 *
 * - Path-bearing tools (Read/Edit/Write/NotebookEdit) → basename only,
 *   so absolute paths under `/etc/secrets/` etc. don't leak into the
 *   pinned card.
 * - Bash/command-bearing tools → the command, but with bearer-token-
 *   shaped substrings replaced with `[redacted]`.
 * - Anything else → empty string. Renderer falls back to tool name only.
 *
 * Hard-capped at 120 chars; the fleet row is one line and Telegram caps
 * the whole card at ~4096 bytes.
 */
export function sanitiseToolArg(name: string, raw: Record<string, unknown>): string {
  let out = ''
  switch (name) {
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit': {
      const fp = raw.file_path
      if (typeof fp === 'string' && fp.length > 0) out = basename(fp)
      break
    }
    case 'Bash': {
      const cmd = raw.command
      if (typeof cmd === 'string') out = redactSecrets(cmd)
      break
    }
    case 'Grep':
    case 'Glob': {
      const pat = raw.pattern
      if (typeof pat === 'string') out = pat
      break
    }
    case 'WebFetch':
    case 'WebSearch': {
      const url = raw.url ?? raw.query
      if (typeof url === 'string') out = redactSecrets(url)
      break
    }
    default: {
      // Generic best-effort: the first string-valued field.
      for (const v of Object.values(raw)) {
        if (typeof v === 'string' && v.length > 0) {
          out = redactSecrets(v)
          break
        }
      }
    }
  }
  if (out.length > SANITISE_MAX_LEN) out = out.slice(0, SANITISE_MAX_LEN - 1) + '…'
  return out
}

function basename(p: string): string {
  const idx = p.lastIndexOf('/')
  return idx === -1 ? p : p.slice(idx + 1)
}

// Bearer / sk-/secret-shaped tokens (>= 16 chars of base64-ish run). The pattern
// is intentionally conservative — we'd rather miss a token than blow away
// legitimate command text. The renderer's job is to be readable; secret
// scanning lives elsewhere.
const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /Bearer\s+[A-Za-z0-9._\-+/=]{16,}/g,
  /sk-[A-Za-z0-9_\-]{16,}/g,
  /\b[A-Fa-f0-9]{32,}\b/g, // long hex (e.g. API keys)
]

function redactSecrets(text: string): string {
  let out = text
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[redacted]')
  return out
}

/**
 * Resolve the fleet-row label for a freshly-dispatched sub-agent.
 *
 * Fallback chain (per #662 P0 spec): description → subagentType →
 * first 20 chars of firstPromptText → "agent". `description` comes
 * from the parent's Agent/Task tool_use input; `subagentType` is
 * Claude Code's slot label (e.g. "general-purpose"); the prompt slice
 * is the last-resort handle for ad-hoc dispatches that omit both.
 */
export function roleFromDispatch(
  description: string | undefined,
  subagentType: string | undefined,
  firstPromptText: string,
): string {
  if (description != null && description.trim().length > 0) return description.trim()
  if (subagentType != null && subagentType.trim().length > 0) return subagentType.trim()
  const slice = firstPromptText.slice(0, ROLE_FALLBACK_LEN).trim()
  if (slice.length > 0) return firstPromptText.slice(0, ROLE_FALLBACK_LEN)
  return 'agent'
}
