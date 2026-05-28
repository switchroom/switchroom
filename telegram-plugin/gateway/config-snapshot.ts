/**
 * Config-snapshot cache — captures a fingerprint of each agent's
 * active configuration at gateway boot and diffs against the prior boot.
 *
 * Closes the JTBD "no need to ask" gap in `restart-and-know-what-im-running`:
 * a user who restarts after editing switchroom.yaml now sees exactly what
 * changed on the boot card, without running `/status`.
 *
 * What's captured:
 *   - model slug (single string, shown verbatim in the diff row)
 *   - tools allowlist hash (sorted SHA-256 prefix — coarse diff only;
 *     granular enumeration is a follow-up)
 *   - skills hash (same pattern)
 *   - memory backend / collection name (single string, shown verbatim)
 *
 * Diff policy:
 *   - model / memoryBackend: shown verbatim ("model: A → B")
 *   - toolsHash / skillsHash: "tools allowlist changed — run /status for
 *     details" (honest without being exhaustive for long allowlists)
 *
 * Silent when unchanged: the caller ONLY surfaces a row when
 * `diffSnapshots()` returns at least one `ConfigChangeDim`.
 *
 * First boot (no prior snapshot): returns an empty diff and persists
 * the current snapshot for the next boot.  Corrupt / missing snapshot:
 * treated as first boot.
 *
 * Storage: `<agentDir>/.config-snapshot.json` (mode 0600), same
 * location pattern as `boot-issue-cache.json`.
 */

import { createHash } from 'crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs'
import { dirname } from 'path'
import { escapeHtml } from '../card-format.js'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ConfigSnapshot {
  /** Schema version — bump on incompatible layout changes. */
  schema: 1
  /** Wall-clock ms at the time of capture (for forensics / GC). */
  capturedAtMs: number
  /** Resolved model slug, e.g. "claude-sonnet-4-5".
   *  null when not set in config (gateway uses the claude CLI default). */
  model: string | null
  /**
   * Sorted SHA-256 prefix of the tools allowlist.
   * Null when the allowlist is unset / empty (uses claude CLI default).
   * Computed from the sorted join of the array so reordering the YAML
   * does not fire a spurious diff.
   */
  toolsHash: string | null
  /**
   * Sorted SHA-256 prefix of the skills list.
   * Null when no skills are configured.
   */
  skillsHash: string | null
  /**
   * Memory backend identifier — `memory.collection` from switchroom.yaml,
   * or null when not configured.
   */
  memoryBackend: string | null
}

/** One dimension that changed between the prior snapshot and this boot. */
export interface ConfigChangeDim {
  /** Which field changed. */
  field: 'model' | 'tools' | 'skills' | 'memoryBackend'
  /** Previous value (null = "not configured" or "first boot"). */
  from: string | null
  /** Current value (null = "removed" — field was cleared in config). */
  to: string | null
}

export type ConfigDiff = ConfigChangeDim[]

// ─── Hashing ────────────────────────────────────────────────────────────────

/**
 * Compute a short deterministic fingerprint for an array of strings.
 * Sort before hashing so reordering the array in YAML doesn't fire a
 * spurious diff row. Returns null for empty / null input.
 */
export function hashStringArray(items: string[] | null | undefined): string | null {
  if (!items || items.length === 0) return null
  const sorted = [...items].sort()
  const raw = createHash('sha256').update(sorted.join('\0')).digest('hex')
  // 12-char prefix is visually compact and collision-resistant enough for
  // config arrays that rarely exceed a few dozen entries.
  return raw.slice(0, 12)
}

/**
 * Normalize a model slug for comparison: lowercase, strip trailing
 * whitespace, collapse multiple spaces. Prevents spurious diffs from
 * case/whitespace variance in the YAML value.
 */
export function normalizeModel(model: string | null | undefined): string | null {
  if (!model || model.trim().length === 0) return null
  return model.trim().toLowerCase()
}

// ─── Capture ────────────────────────────────────────────────────────────────

export interface CaptureInput {
  /** Agent name — used for the default memoryBackend when not explicitly set. */
  agentName: string
  /** Resolved model from the config cascade (may be undefined/null). */
  model?: string | null
  /** Full tools allowlist from the config cascade (may be undefined/null). */
  toolsAllow?: string[] | null
  /** Full skills list from the config cascade (may be undefined/null). */
  skills?: string[] | null
  /** Memory collection name from the config cascade (may be undefined/null). */
  memoryCollection?: string | null
  /** Clock injection for tests. */
  now?: () => number
}

/**
 * Build a ConfigSnapshot from the current resolved agent config.
 *
 * The caller is responsible for loading the config and passing the
 * relevant fields. This function is pure — no disk I/O.
 */
export function captureConfigSnapshot(input: CaptureInput): ConfigSnapshot {
  return {
    schema: 1,
    capturedAtMs: (input.now ?? Date.now)(),
    model: normalizeModel(input.model),
    toolsHash: hashStringArray(input.toolsAllow ?? null),
    skillsHash: hashStringArray(input.skills ?? null),
    memoryBackend: input.memoryCollection?.trim() || null,
  }
}

// ─── Diff ────────────────────────────────────────────────────────────────────

/**
 * Compare `current` against `previous` and return one entry per changed
 * dimension. Returns an empty array when nothing changed.
 *
 * Edge cases:
 *   - `previous` is null (first boot or corrupt cache): returns empty diff.
 *     The caller will persist `current` for the next boot.
 *   - A field is null on both sides: not a change.
 */
export function diffSnapshots(
  current: ConfigSnapshot,
  previous: ConfigSnapshot | null,
): ConfigDiff {
  if (previous === null) return []

  const changes: ConfigDiff = []

  if (current.model !== previous.model) {
    changes.push({ field: 'model', from: previous.model, to: current.model })
  }
  if (current.toolsHash !== previous.toolsHash) {
    changes.push({ field: 'tools', from: previous.toolsHash, to: current.toolsHash })
  }
  if (current.skillsHash !== previous.skillsHash) {
    changes.push({ field: 'skills', from: previous.skillsHash, to: current.skillsHash })
  }
  if (current.memoryBackend !== previous.memoryBackend) {
    changes.push({
      field: 'memoryBackend',
      from: previous.memoryBackend,
      to: current.memoryBackend,
    })
  }

  return changes
}

// ─── Rendering ───────────────────────────────────────────────────────────────

/**
 * Render a single config-change row for the boot card.
 *
 * Model and memory backend: shown verbatim ("model: A → B").
 * Tools / skills: coarse hash diff ("tools allowlist changed — run /status
 * for details"), since enumerating the full list would be too verbose.
 *
 * The null-to-value case means "field was first configured on this boot".
 * The value-to-null case means "field was removed" (unusual but legal).
 */
export function renderConfigChangeDim(dim: ConfigChangeDim): string {
  switch (dim.field) {
    case 'model': {
      const from = escapeHtml(dim.from ?? '(default)')
      const to = escapeHtml(dim.to ?? '(default)')
      return `⚙️ <b>Config</b>  model: ${from} → ${to}`
    }
    case 'memoryBackend': {
      const from = escapeHtml(dim.from ?? '(default)')
      const to = escapeHtml(dim.to ?? '(default)')
      return `⚙️ <b>Config</b>  memory backend: ${from} → ${to}`
    }
    case 'tools':
      return `⚙️ <b>Config</b>  tools allowlist changed — run /status for details`
    case 'skills':
      return `⚙️ <b>Config</b>  skills changed — run /status for details`
  }
}

// ─── Persistence ─────────────────────────────────────────────────────────────

/**
 * Load the config snapshot from `path`.
 *
 * Returns null on:
 *   - file missing (first boot)
 *   - JSON parse error (corrupt — renamed aside for forensics)
 *   - schema mismatch
 */
export function loadSnapshot(path: string, now: () => number = Date.now): ConfigSnapshot | null {
  if (!existsSync(path)) return null
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Corrupt — preserve for forensics, return null (treat as first boot).
    try {
      renameSync(path, `${path}.corrupt-${now()}`)
    } catch {
      // best-effort
    }
    return null
  }
  const obj = parsed as Partial<ConfigSnapshot>
  if (!obj || obj.schema !== 1) return null
  // Validate required keys exist (defensive against partial writes).
  if (
    typeof obj.capturedAtMs !== 'number' ||
    !('model' in obj) ||
    !('toolsHash' in obj) ||
    !('skillsHash' in obj) ||
    !('memoryBackend' in obj)
  ) {
    return null
  }
  return {
    schema: 1,
    capturedAtMs: obj.capturedAtMs,
    model: obj.model ?? null,
    toolsHash: obj.toolsHash ?? null,
    skillsHash: obj.skillsHash ?? null,
    memoryBackend: obj.memoryBackend ?? null,
  }
}

/**
 * Persist `snapshot` to `path` atomically (via `.tmp` + rename).
 * Failures are swallowed — the snapshot is best-effort and should not
 * block the boot sequence.
 */
export function persistSnapshot(path: string, snapshot: ConfigSnapshot): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    writeFileSync(tmp, JSON.stringify(snapshot), { mode: 0o600 })
    renameSync(tmp, path)
  } catch {
    // Non-fatal: best-effort persistence. Next boot will re-detect.
  }
}
