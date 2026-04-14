/**
 * Human-readable labels for tool_use events on the progress card.
 *
 * Each function takes the tool's `input` object (as Claude Code records it
 * in the session JSONL) and returns a short suffix to append to the tool
 * name, e.g. `formatToolLabel('Read', { file_path: '/abs/foo.ts' })` →
 * `'tests/foo.ts'`.
 *
 * Goals:
 *   - Short enough to fit on one Telegram line without wrapping on mobile
 *   - Recognisable — paths shortened to basename-with-parent, commands
 *     truncated at first newline, queries truncated and quoted
 *   - Safe: all outputs pass through the renderer's HTML escape, and
 *     inputs that look malformed fall back to empty string (no bare
 *     tool name without suffix looks clean too)
 *
 * Keep this file tiny and dependency-free — it's in the hot path of
 * every render.
 */

const MAX_LABEL_CHARS = 60

/**
 * Shorten an absolute or project-relative path to something readable.
 * `/home/ken/code/clerk/src/foo.ts` → `src/foo.ts` or `clerk/src/foo.ts`.
 */
function shortenPath(p: string): string {
  if (!p) return ''
  // Drop the common prefix up to the first interesting directory.
  // Heuristic: strip everything up to and including the last occurrence
  // of `/clerk/`, `/src/`, `/tests/`, `/.claude/`, or the user's home.
  const markers = ['/clerk/', '/.claude/']
  for (const m of markers) {
    const idx = p.lastIndexOf(m)
    if (idx !== -1) return p.slice(idx + 1)
  }
  // Fallback: last two path segments.
  const parts = p.split('/').filter(Boolean)
  if (parts.length <= 2) return p
  return parts.slice(-2).join('/')
}

function truncate(s: string, n = MAX_LABEL_CHARS): string {
  if (s.length <= n) return s
  return s.slice(0, n - 1) + '…'
}

function firstLine(s: string): string {
  const idx = s.indexOf('\n')
  return idx === -1 ? s : s.slice(0, idx)
}

/**
 * Return a display suffix for `tool` given its `input`, without the tool
 * name itself. Caller renders `${tool}: ${suffix}` (with a colon only
 * when the suffix is non-empty).
 */
export function toolLabel(tool: string, input?: Record<string, unknown>): string {
  if (!input || typeof input !== 'object') return ''
  const str = (k: string): string | undefined =>
    typeof input[k] === 'string' ? (input[k] as string) : undefined

  switch (tool) {
    case 'Read':
    case 'Write':
    case 'NotebookEdit':
      return truncate(shortenPath(str('file_path') ?? ''))

    case 'Edit': {
      const path = shortenPath(str('file_path') ?? '')
      return truncate(path)
    }

    case 'Bash':
    case 'BashOutput': {
      const cmd = str('command') ?? str('bash_id') ?? ''
      return truncate(firstLine(cmd))
    }

    case 'KillShell':
      return truncate(str('shell_id') ?? '')

    case 'Glob':
      return truncate(str('pattern') ?? '')

    case 'Grep': {
      const pat = str('pattern') ?? ''
      const path = str('path')
      if (path) return truncate(`"${pat}" in ${shortenPath(path)}`)
      return truncate(`"${pat}"`)
    }

    case 'WebFetch':
      return truncate(str('url') ?? '')

    case 'WebSearch':
      return truncate(str('query') ?? '')

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

    default:
      // Unknown tool — try common keys in priority order.
      for (const k of ['file_path', 'path', 'url', 'query', 'pattern', 'command', 'description']) {
        const v = str(k)
        if (v != null && v.length > 0) {
          return truncate(k.endsWith('path') || k === 'url' ? shortenPath(v) : firstLine(v))
        }
      }
      return ''
  }
}
