/**
 * Apply a list of detections to the original text, replacing each secret
 * with `[secret stored as vault:${slug}]`. The slug map tells us which
 * slug each detection was actually stored under (the detector's
 * `suggested_slug` may have been bumped on collision).
 *
 * Replacements are applied right-to-left so earlier byte offsets stay
 * valid as we mutate the string.
 */
import type { Detection } from './index.js'

export interface RewriteTarget {
  detection: Detection
  actual_slug: string
}

export function rewritePrompt(text: string, targets: RewriteTarget[]): string {
  if (targets.length === 0) return text
  const sorted = [...targets].sort((a, b) => b.detection.start - a.detection.start)
  let out = text
  for (const t of sorted) {
    const { start, end } = t.detection
    out = out.slice(0, start) + `[secret stored as vault:${t.actual_slug}]` + out.slice(end)
  }
  return out
}
