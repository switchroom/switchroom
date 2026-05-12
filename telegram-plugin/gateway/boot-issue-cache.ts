/**
 * Boot-card issue dedup cache.
 *
 * Every gateway boot runs a full probe sweep and surfaces every
 * degraded/fail probe as a row on the boot card. That's correct on
 * day one but noisy in steady state: a long-standing "broker socket
 * missing" or "5 dangling skills" row reappears identically on every
 * restart, training the user to ignore the boot card.
 *
 * This module persists a per-probe fingerprint of the last few probe
 * outcomes per chat+topic so the renderer can:
 *
 *   - hide ⚠ rows the user has already seen N consecutive boots
 *     ("snooze" semantics — the user knows; we won't keep yelling)
 *   - render ✅ "resolved" rows for probes that were degraded/fail on
 *     the previous boot and are now ok (the positive-feedback signal
 *     that's missing from a silent-when-healthy card)
 *
 * Fingerprint policy is per-probe and chosen to fold across the
 * incidental variance in `detail` strings:
 *
 *   - skills:    folds across dangling-count ("3 dangling: a, b, c"
 *                and "4 dangling: a, b, c, d" share one fingerprint)
 *   - account:   folds by status_kind ("signed-out" vs "token-expired"
 *                vs "token-expiring" — the kind of trouble, not the day-count)
 *   - agent:     folds by raw systemd state string ("service failed",
 *                "service activating")
 *   - others:    literal detail string (broker/kernel/hindsight/quota/
 *                scheduler have low-cardinality details that read well as-is)
 *
 * Snooze defaults: hide a row after the user has seen the SAME
 * fingerprint on `snoozeBoots` consecutive boots (default 10) OR for
 * `snoozeMs` (default 3 days), whichever fires first. A change in
 * fingerprint (new failure mode) resets the counter — the user always
 * sees novel failures.
 *
 * Storage: `~/.switchroom/<agent>/boot-issue-cache.json` (mode 0600).
 * On corrupt cache: rename to `<path>.corrupt-<ts>` and start fresh.
 * Entries older than 30 days are GC'd on every load.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs'
import { dirname } from 'path'
import type { ProbeResult } from './boot-probes.js'
import type { ProbeKey, ProbeMap } from './boot-card.js'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface BootIssueCacheEntry {
  /** The fingerprint we computed for this probe on this boot. */
  fingerprint: string
  /** Number of CONSECUTIVE boots the same fingerprint has been observed. */
  consecutiveBoots: number
  /** Wall-clock ms at which this fingerprint was first observed in the
   *  current run of consecutive boots. */
  firstSeenMs: number
  /** Wall-clock ms at which this fingerprint was most recently observed. */
  lastSeenMs: number
}

export interface BootIssueCacheFile {
  /** Schema version — bump on incompatible changes. */
  schema: 1
  /** Map keyed by ProbeKey. */
  probes: Partial<Record<ProbeKey, BootIssueCacheEntry>>
}

/** Outcome of a single probe after diffing against the cache. */
export interface ProbeDiffResult {
  /** The fingerprint we'd persist for this outcome. */
  fingerprint: string
  /** True when the probe was degraded/fail on a prior boot and is now ok. */
  resolved: boolean
  /** True when the probe is degraded/fail AND should be hidden ("snoozed")
   *  because the user has seen this exact fingerprint enough times. */
  snoozed: boolean
  /** True when this is the FIRST boot we see this fingerprint (counter==1). */
  firstSighting: boolean
  /** The cache entry that would be written for this probe if we apply the diff.
   *  null when the probe is `ok` and the cache had no prior entry — nothing to
   *  persist. */
  nextEntry: BootIssueCacheEntry | null
}

export type ProbeDiffMap = Partial<Record<ProbeKey, ProbeDiffResult>>

export interface DiffOpts {
  /** Hide rows after this many consecutive boots with the same fingerprint. */
  snoozeBoots?: number
  /** Hide rows that have been seen for at least this many ms. */
  snoozeMs?: number
  /** Clock injection for tests. */
  now?: () => number
}

export const DEFAULT_SNOOZE_BOOTS = 10
export const DEFAULT_SNOOZE_MS = 3 * 24 * 60 * 60 * 1000  // 3 days
export const GC_AGE_MS = 30 * 24 * 60 * 60 * 1000  // 30 days

// ─── Fingerprinting ──────────────────────────────────────────────────────────

/**
 * Compute a stable fingerprint for a probe result, applying the per-probe
 * fold policy described in the module docstring.
 *
 * The fingerprint is what we compare across boots to decide
 * "same issue" vs "new issue". `detail` strings sometimes vary in
 * incidental ways (dangling-count, expiry day-count) that we want to fold,
 * so each probe has its own normalizer.
 */
export function fingerprintProbe(key: ProbeKey, r: ProbeResult): string {
  // ok results always have a single fingerprint per probe — we don't track
  // healthy variance.
  if (r.status === 'ok') return `${key}:ok`

  switch (key) {
    case 'skills': {
      // Fold across the dangling count and the listed names. The fact
      // that "some skills dangle" is what matters; ten more or fewer
      // doesn't reset the snooze.
      if (/dangling/.test(r.detail)) return `${key}:${r.status}:dangling`
      return `${key}:${r.status}:${normalizeDetail(r.detail)}`
    }
    case 'account': {
      // Fold by status_kind: signed-in-but-expired vs not-signed-in vs
      // token-expiring-soon. The literal detail includes the email and
      // day-countdown — both vary incidentally.
      const d = r.detail
      if (/not signed in/i.test(d)) return `${key}:${r.status}:signed-out`
      if (/expired/i.test(d)) return `${key}:${r.status}:token-expired`
      if (/token \d+d/i.test(d)) return `${key}:${r.status}:token-expiring`
      return `${key}:${r.status}:${normalizeDetail(d)}`
    }
    case 'agent': {
      // Systemd state string is the right granularity: "service failed"
      // vs "service activating" are different issues; the PID/uptime
      // suffix that ok rows carry has already been excluded above.
      const m = r.detail.match(/^service\s+([a-z-]+)/)
      if (m) return `${key}:${r.status}:state=${m[1]}`
      // Docker-mode "claude process not found" is its own bucket.
      return `${key}:${r.status}:${normalizeDetail(r.detail)}`
    }
    default:
      // broker / kernel / hindsight / quota / scheduler / gateway:
      // literal detail is the right granularity — they're already low-
      // cardinality strings the user can recognize.
      return `${key}:${r.status}:${normalizeDetail(r.detail)}`
  }
}

/**
 * Normalize a detail string for fingerprinting: lowercase, collapse
 * whitespace, strip absolute paths down to their basename so a moving
 * socket directory doesn't fragment the fingerprint.
 */
function normalizeDetail(d: string): string {
  return d.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 120)
}

// ─── Diff (cache vs current probe results) ──────────────────────────────────

/**
 * Compare current probe results against the cached entry for each probe
 * and produce a per-probe verdict. Pure function — does not touch disk.
 */
export function diffProbes(
  probes: ProbeMap,
  cache: BootIssueCacheFile,
  opts: DiffOpts = {},
): ProbeDiffMap {
  const snoozeBoots = opts.snoozeBoots ?? DEFAULT_SNOOZE_BOOTS
  const snoozeMs = opts.snoozeMs ?? DEFAULT_SNOOZE_MS
  const now = opts.now ?? Date.now
  const nowMs = now()

  const out: ProbeDiffMap = {}
  for (const [key, r] of Object.entries(probes) as [ProbeKey, ProbeResult | null | undefined][]) {
    if (!r) continue
    const prev = cache.probes[key]
    const fp = fingerprintProbe(key, r)

    if (r.status === 'ok') {
      // Resolved iff the cache had a non-ok entry for this probe.
      const resolved = prev != null && !prev.fingerprint.endsWith(':ok')
      out[key] = {
        fingerprint: fp,
        resolved,
        snoozed: false,
        firstSighting: prev == null,
        // No need to persist a freshly-ok probe — keeps the cache small.
        nextEntry: null,
      }
      continue
    }

    // Degraded / fail path
    let consecutiveBoots = 1
    let firstSeenMs = nowMs
    if (prev != null && prev.fingerprint === fp) {
      consecutiveBoots = prev.consecutiveBoots + 1
      firstSeenMs = prev.firstSeenMs
    }
    const ageMs = nowMs - firstSeenMs
    const snoozed =
      consecutiveBoots > snoozeBoots ||
      ageMs >= snoozeMs

    out[key] = {
      fingerprint: fp,
      resolved: false,
      snoozed,
      firstSighting: consecutiveBoots === 1,
      nextEntry: {
        fingerprint: fp,
        consecutiveBoots,
        firstSeenMs,
        lastSeenMs: nowMs,
      },
    }
  }
  return out
}

// ─── Persistence ────────────────────────────────────────────────────────────

export const EMPTY_CACHE: BootIssueCacheFile = { schema: 1, probes: {} }

/**
 * Load the cache from `path`. Returns an empty cache on:
 *   - file missing
 *   - JSON parse error (file is renamed aside as `<path>.corrupt-<ts>`)
 *   - schema mismatch
 *
 * Entries older than GC_AGE_MS are dropped on load — keeps the file
 * from growing unbounded across years of restarts.
 */
export function loadCache(path: string, now: () => number = Date.now): BootIssueCacheFile {
  if (!existsSync(path)) return { ...EMPTY_CACHE, probes: {} }
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch {
    return { ...EMPTY_CACHE, probes: {} }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Corrupt — preserve for forensics, return empty.
    try {
      renameSync(path, `${path}.corrupt-${now()}`)
    } catch {
      // best-effort
    }
    return { ...EMPTY_CACHE, probes: {} }
  }
  const obj = parsed as Partial<BootIssueCacheFile>
  if (!obj || obj.schema !== 1 || typeof obj.probes !== 'object' || obj.probes == null) {
    return { ...EMPTY_CACHE, probes: {} }
  }
  // GC ancient entries.
  const cutoff = now() - GC_AGE_MS
  const probes: Partial<Record<ProbeKey, BootIssueCacheEntry>> = {}
  for (const [k, v] of Object.entries(obj.probes) as [ProbeKey, BootIssueCacheEntry | undefined][]) {
    if (!v) continue
    if (typeof v.lastSeenMs !== 'number') continue
    if (v.lastSeenMs < cutoff) continue
    probes[k] = v
  }
  return { schema: 1, probes }
}

/**
 * Apply a diff back to the cache and persist atomically. Entries with
 * `nextEntry: null` are removed from the cache (probe is now ok). Other
 * entries are upserted.
 *
 * Writes go via `<path>.tmp` + rename so a crash mid-write can't leave
 * partial JSON on disk.
 */
export function applyAndSave(
  path: string,
  cache: BootIssueCacheFile,
  diff: ProbeDiffMap,
): BootIssueCacheFile {
  const next: BootIssueCacheFile = {
    schema: 1,
    probes: { ...cache.probes },
  }
  for (const [k, d] of Object.entries(diff) as [ProbeKey, ProbeDiffResult][]) {
    if (d.nextEntry == null) {
      delete next.probes[k]
    } else {
      next.probes[k] = d.nextEntry
    }
  }
  try {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 })
    renameSync(tmp, path)
  } catch {
    // Non-fatal: the cache is best-effort. Suppression on this boot
    // still applied from the in-memory diff; persistence will retry
    // on the next boot.
  }
  return next
}
