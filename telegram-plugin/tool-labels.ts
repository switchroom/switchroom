/**
 * Human-readable labels for tool_use events on the progress card.
 *
 * Each function takes the tool's `input` object (as Claude Code records it
 * in the session JSONL) and returns a short suffix to append to the tool
 * name, e.g. `toolLabel('Read', { file_path: '/abs/foo.ts' })` → `'foo.ts'`.
 *
 * Goals:
 *   - Short enough to fit on one Telegram line without wrapping on mobile
 *   - Recognisable — paths shown as basename only; commands truncated at
 *     ~40 chars / first newline; queries quoted; hostnames for URLs
 *   - Safe: all outputs pass through the renderer's HTML escape, and
 *     inputs that look malformed fall back to empty string
 *
 * Keep this file tiny and dependency-free — it's in the hot path of
 * every render.
 */

const MAX_LABEL_CHARS = 60
const MAX_BASH_CHARS = 40
/**
 * Cap for human-readable `description` fields (Bash, fallback). Set
 * larger than MAX_BASH_CHARS because descriptions are agent-authored
 * English prose intended for humans — letting them wrap a couple of
 * mobile lines is fine; aggressive truncation hides intent.
 */
const MAX_DESCRIPTION_CHARS = 160

/**
 * Basename of a path — just the trailing segment. `/a/b/c.ts` → `c.ts`.
 * We used to shorten to "project/last-two-segments" but user feedback
 * asked for a cleaner look in the checklist; the path's directory rarely
 * adds useful information when the user is watching tool calls scroll by.
 */
function basename(p: string): string {
  if (!p) return ''
  const parts = p.split('/').filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : p
}

/**
 * Shorten a Grep `path` argument. Prefer "<parent>/<dir>/" form for
 * directories so the hint is recognisable (e.g. "src/" rather than just
 * "src" is ambiguous vs. a file). Returns the basename for files.
 */
function shortenGrepPath(p: string): string {
  if (!p) return 'repo'
  const hadTrailingSlash = /\/+$/.test(p)
  const trimmed = p.replace(/\/+$/, '')
  const parts = trimmed.split('/').filter(Boolean)
  if (parts.length === 0) return 'repo'
  const last = parts[parts.length - 1]
  if (hadTrailingSlash) return `${last}/`
  // Dotfiles like `.env`, `.gitignore`, `.npmrc` — a leading dot with no
  // further dot — are files, not directories. The old heuristic ("no dot
  // → dir") mislabeled them as directories.
  if (last.startsWith('.') && !last.slice(1).includes('.')) return last
  // Otherwise: no extension → treat as a directory hint.
  if (!last.includes('.')) return `${last}/`
  return last
}

/**
 * Extract a hostname from a URL. Falls back to the original string on
 * malformed input.
 */
function hostFromUrl(u: string): string {
  if (!u) return ''
  try {
    return new URL(u).host
  } catch {
    // Not a valid URL — just return the raw input, truncated.
    return truncate(u)
  }
}

function truncate(s: string, n = MAX_LABEL_CHARS): string {
  if (s.length <= n) return s
  return s.slice(0, n - 1) + '…'
}

/**
 * Strip HTML tags from a preview string. MCP tools like `stream_reply`
 * accept Telegram-HTML text as input; when we use that text as a label
 * preview, the raw `<b>`/`<i>`/etc. markers would pass through
 * `escapeHtml` in the renderer and show up as visible `<b>` on screen.
 * Dropping tags here keeps the preview human-readable.
 *
 * Requires an ASCII letter (or `/`) immediately after `<` so comparison
 * operators in plain-text queries (`"find x < 5 and y > 3"`) survive
 * unmolested. A naive `/<[^>]+>/g` would otherwise eat everything
 * between the two brackets.
 */
function stripHtml(s: string): string {
  return s.replace(/<\/?[a-zA-Z][^>]*>/g, '')
}

function firstLine(s: string): string {
  const idx = s.indexOf('\n')
  return idx === -1 ? s : s.slice(0, idx)
}

/**
 * Return true when the label produced by `toolLabel(tool, input)` came
 * from a human-authored `description` field rather than a raw fallback
 * (filename, command string, hostname, etc.). The progress card uses this
 * flag to suppress the tool-name prefix — "Check commit state" reads
 * better than "Bash Check commit state".
 *
 * Rules:
 *   - Bash / BashOutput → true when `input.description` is a non-empty string
 *   - Task / Agent     → true when `input.description` is a non-empty string
 *   - All other tools  → false (keep the "ToolName label" concat)
 *
 * WebFetch and WebSearch are intentionally left as false because the
 * tool name provides important context ("WebFetch example.com" makes more
 * sense than just "example.com").
 */
export function isHumanDescription(
  tool: string,
  input?: Record<string, unknown>,
): boolean {
  if (!input || typeof input !== 'object') return false
  const description =
    typeof input['description'] === 'string' ? input['description'] : undefined
  switch (tool) {
    case 'Bash':
    case 'BashOutput':
    case 'Task':
    case 'Agent':
      return typeof description === 'string' && description.trim().length > 0
    default:
      return false
  }
}

/**
 * Return a display suffix for `tool` given its `input`, without the tool
 * name itself. Caller renders `${tool} ${suffix}` (space-separated; no
 * colon) — the checklist format the progress card uses.
 *
 * The optional `preamble` is the most recent short `text` content block
 * the model emitted just before this `tool_use` in the same assistant
 * message — the model's natural "I'll check foo.ts" narration. For the
 * file/search tools (Read/Write/Edit/Grep/Glob/NotebookEdit) we prefer
 * that prose over the filename/pattern fallback when it's short enough
 * to fit on one mobile line (single-line, ≤160 chars). Multi-line or
 * longer text is treated as a narrative step, not a per-tool preamble,
 * and the fallback label wins. Bash/BashOutput/Task/Agent already carry
 * `input.description` and intentionally ignore preamble.
 */
export function toolLabel(
  tool: string,
  input?: Record<string, unknown>,
  preamble?: string,
): string {
  if (!input || typeof input !== 'object') return ''
  const str = (k: string): string | undefined =>
    typeof input[k] === 'string' ? (input[k] as string) : undefined

  const preambleLabel = (): string | null => {
    if (!preamble) return null
    if (preamble.includes('\n')) return null
    const trimmed = preamble.trim()
    if (!trimmed) return null
    if (trimmed.length > MAX_DESCRIPTION_CHARS) return null
    return trimmed
  }

  switch (tool) {
    case 'Read':
    case 'Write':
    case 'NotebookEdit':
    case 'Edit': {
      const pre = preambleLabel()
      if (pre) return pre
      return truncate(basename(str('file_path') ?? ''))
    }

    case 'Bash':
    case 'BashOutput': {
      const description = str('description')
      if (description) return truncate(firstLine(description), MAX_DESCRIPTION_CHARS)
      const cmd = str('command') ?? str('bash_id') ?? ''
      return truncate(firstLine(cmd), MAX_BASH_CHARS)
    }

    case 'KillShell':
      return truncate(str('shell_id') ?? '')

    case 'Glob': {
      const pre = preambleLabel()
      if (pre) return pre
      return truncate(str('pattern') ?? '')
    }

    case 'Grep': {
      const pre = preambleLabel()
      if (pre) return pre
      const pat = str('pattern') ?? ''
      if (!pat) return ''
      const path = str('path')
      const where = shortenGrepPath(path ?? '')
      return truncate(`"${pat}" (in ${where})`)
    }

    case 'WebFetch':
      return truncate(hostFromUrl(str('url') ?? ''))

    case 'WebSearch': {
      const q = str('query') ?? ''
      return q ? truncate(`"${q}"`) : ''
    }

    case 'Task':
    case 'Agent': {
      const desc = str('description') ?? str('subagent_type') ?? ''
      return truncate(desc)
    }

    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'TaskList':
    case 'TaskGet':
    case 'TaskStop':
    case 'TaskOutput':
      return ''

    case 'Skill':
      return truncate(str('skill') ?? '')

    case 'SlashCommand':
      return truncate(str('command') ?? '')

    case 'ToolSearch': {
      const q = str('query') ?? ''
      if (!q) return ''
      // "select:Foo,Bar" — the model is loading schemas for named tools.
      // Strip the prefix and show just the names so the checklist reads
      // "ToolSearch Loading schema: Foo, Bar" rather than echoing the raw
      // colon-delimited string.
      const selectMatch = q.match(/^\s*select\s*:\s*(.+)$/i)
      if (selectMatch) {
        const names = selectMatch[1]
          .split(',')
          .map((n) => n.trim())
          .filter((n) => n.length > 0)
          .join(', ')
        return truncate(`Loading schema: ${names}`)
      }
      return truncate(`Searching tools: ${q}`)
    }

    default:
      // MCP tools (`mcp__<server>__<action>`) share a single prefix and a
      // handful of common shapes. Dispatch them here before the generic
      // key-sweep fallback, which would otherwise echo raw query strings.
      if (tool.startsWith('mcp__')) {
        const description = str('description')
        if (description) return truncate(firstLine(stripHtml(description)), MAX_DESCRIPTION_CHARS)
        const label = mcpBaseLabel(tool)
        const query = str('query') ?? str('text') ?? str('name')
        if (label && query) {
          // Reserve room for the " (…)" wrapping so the total label stays
          // under MAX_LABEL_CHARS. 4 chars of framing: " (" + "…" + ")".
          const budget = Math.max(8, MAX_LABEL_CHARS - label.length - 4)
          const preview = truncate(firstLine(stripHtml(query)), budget)
          return `${label} (${preview})`
        }
        if (label) return truncate(label)
        // No derivable base label — fall through to the generic sweep.
      }

      // Unknown tool — try common keys in priority order. `description`
      // is checked first because it's the agent's human-readable summary
      // (when present) and beats raw command/path strings.
      for (const k of ['description', 'file_path', 'path', 'url', 'query', 'pattern', 'command']) {
        const v = str(k)
        if (v != null && v.length > 0) {
          if (k === 'file_path' || k === 'path') return truncate(basename(v))
          if (k === 'url') return truncate(hostFromUrl(v))
          if (k === 'description') return truncate(firstLine(v), MAX_DESCRIPTION_CHARS)
          return truncate(firstLine(v))
        }
      }
      return ''
  }
}

/**
 * Derive a "<Server>: <action>" label from an `mcp__<server>__<action>`
 * tool name. Returns the empty string when the name doesn't match the
 * expected shape so callers can fall back to the generic sweep.
 *
 * Servers sometimes ship with noisy machine names (e.g.
 * `switchroom-telegram`) — we map a small allowlist to friendlier
 * labels, and otherwise capitalise the first letter and keep the rest
 * verbatim so unknown servers still render cleanly.
 */
function mcpBaseLabel(tool: string): string {
  if (!tool.startsWith('mcp__')) return ''
  const parts = tool.slice('mcp__'.length).split('__')
  if (parts.length < 2) return ''
  const rawServer = parts[0]
  // Action may itself contain `__` in theory; preserve anything after
  // the first separator verbatim. In practice actions are single tokens
  // like `recall` or `stream_reply`.
  const action = parts.slice(1).join('__')
  if (!rawServer || !action) return ''
  return `${prettifyServer(rawServer)}: ${action}`
}

function prettifyServer(name: string): string {
  const LABELS: Record<string, string> = {
    'switchroom-telegram': 'Telegram',
  }
  if (LABELS[name]) return LABELS[name]
  if (!name) return name
  return name.charAt(0).toUpperCase() + name.slice(1)
}
