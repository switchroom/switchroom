/**
 * Pure boot-card version-string composer + helpers.
 *
 * Extracted from gateway.ts so the version-string code path can be
 * exercised by property-based tests without dragging in the gateway's
 * runtime side effects (env loading, bot client init, etc.). Live
 * callers stay in gateway.ts; this file is pure functions only.
 */

export type BootVersionInputs = {
  version: string
  commitSha: string | null
  commitDate: string | null
  latestPr: number | null
  commitsAheadOfTag: number | null
  claudeCliVersion: string | null
}

export function formatRelativeAgo(iso: string | null): string | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  const diffSec = Math.max(0, Math.floor((Date.now() - t) / 1000))
  if (diffSec < 60) return `${diffSec}s ago`
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`
  return `${Math.floor(diffSec / 86400)}d ago`
}

/**
 * Compose the version string shown in the boot-card ack line and the
 * status card's Version row. Two shapes, matching the deleted greeting
 * card's behavior:
 *
 *   - on a tag (commits_ahead = 0 or null):   "v0.2.0 · #44 · claude 2.1.123 · 2h ago"
 *     (omit "#44 ·" when no PR was parsed; omit claude segment if unavailable)
 *   - ahead of a tag (commits_ahead > 0):     "v0.2.0+3 · db6de9e · claude 2.1.123 · 2m ago"
 *     (always show short SHA when ahead, omit PR)
 *
 * Age segment is omitted if no commit date is available (npm consumer).
 *
 * Sanitization: claude --version output is whitespace-collapsed before
 * embedding — a malicious or rogue `claude` on PATH must not be able to
 * smuggle newlines into the ack line. Markdown escaping happens at the
 * boot-card boundary (see boot-card.ts: escapeMarkdown(version)) so any
 * GFM formatting specials in the version render literally (#2669).
 */
export function composeBootVersionString(inputs: BootVersionInputs): string {
  const ago = formatRelativeAgo(inputs.commitDate)
  const onTag = inputs.commitsAheadOfTag === 0 || inputs.commitsAheadOfTag === null
  const claudeVerRaw = inputs.claudeCliVersion?.replace(/\s+/g, ' ').trim()
  const claudeVer = claudeVerRaw && claudeVerRaw.length > 0 ? claudeVerRaw : null

  if (onTag) {
    const parts: string[] = [`v${inputs.version}`]
    if (inputs.latestPr != null) parts.push(`#${inputs.latestPr}`)
    if (claudeVer) parts.push(`claude ${claudeVer}`)
    if (ago) parts.push(ago)
    return parts.join(' · ')
  }

  const parts: string[] = [`v${inputs.version}+${inputs.commitsAheadOfTag}`]
  if (inputs.commitSha) parts.push(inputs.commitSha)
  if (claudeVer) parts.push(`claude ${claudeVer}`)
  if (ago) parts.push(ago)
  return parts.join(' · ')
}
