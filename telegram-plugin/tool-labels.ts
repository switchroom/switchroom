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
  // If path ends with a slash or has no extension, treat as dir and keep
  // the trailing slash; otherwise basename.
  const trimmed = p.replace(/\/+$/, '')
  const parts = trimmed.split('/').filter(Boolean)
  if (parts.length === 0) return 'repo'
  const last = parts[parts.length - 1]
  // Heuristic: no dot in last segment → directory.
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

function firstLine(s: string): string {
  const idx = s.indexOf('\n')
  return idx === -1 ? s : s.slice(0, idx)
}

/**
 * Return a display suffix for `tool` given its `input`, without the tool
 * name itself. Caller renders `${tool} ${suffix}` (space-separated; no
 * colon) — the checklist format the progress card uses.
 */
export function toolLabel(tool: string, input?: Record<string, unknown>): string {
  if (!input || typeof input !== 'object') return ''
  const str = (k: string): string | undefined =>
    typeof input[k] === 'string' ? (input[k] as string) : undefined

  switch (tool) {
    case 'Read':
    case 'Write':
    case 'NotebookEdit':
    case 'Edit':
      return truncate(basename(str('file_path') ?? ''))

    case 'Bash':
    case 'BashOutput': {
      const cmd = str('command') ?? str('bash_id') ?? ''
      return truncate(firstLine(cmd), MAX_BASH_CHARS)
    }

    case 'KillShell':
      return truncate(str('shell_id') ?? '')

    case 'Glob':
      return truncate(str('pattern') ?? '')

    case 'Grep': {
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

    default:
      // Unknown tool — try common keys in priority order.
      for (const k of ['file_path', 'path', 'url', 'query', 'pattern', 'command', 'description']) {
        const v = str(k)
        if (v != null && v.length > 0) {
          if (k === 'file_path' || k === 'path') return truncate(basename(v))
          if (k === 'url') return truncate(hostFromUrl(v))
          return truncate(firstLine(v))
        }
      }
      return ''
  }
}
