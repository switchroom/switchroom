/**
 * Shared quota probe cache.
 *
 * Background: every gateway boot AND every bridge-reconnect calls
 * `probeQuota` which hits Anthropic's /api/oauth/usage endpoint. With
 * four agents on one OAuth account and reconnects happening multiple
 * times per minute (per the boot-card-on-every-start design), the
 * endpoint returns 429 and the boot card shows 🟡 "rate limited" — a
 * cosmetic alarm caused by the boot card itself.
 *
 * Cache the result for 5 min in a single file shared across all agents.
 * On a hit, the cached ProbeResult is returned instead of making the
 * HTTP call. 429 (rate-limited) results are cached for a shorter 30 s
 * window so fleet-restart bursts are absorbed without holding stale state
 * for 5 min. Fail results are never cached.
 *
 * Cache location: `~/.switchroom/quota-cache.json` (mode 0600). Format:
 *   { capturedAt: string, ttlMs: number, result: ProbeResult }
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import type { ProbeResult } from './boot-probes.js'

export interface QuotaCacheEntry {
  capturedAt: string  // ISO 8601
  ttlMs: number
  result: ProbeResult
}

export const DEFAULT_TTL_MS = 5 * 60 * 1000  // 5 min

/**
 * Short TTL used when caching a 429 result. 30 s is long enough to absorb
 * a simultaneous fleet restart (all N agents firing their quota probe within
 * the same second) while clearing fast enough that any real retry or the
 * next scheduled boot gets a live result.
 */
export const RATE_LIMIT_TTL_MS = 30 * 1000  // 30 s
export const DEFAULT_CACHE_PATH =
  process.env.SWITCHROOM_QUOTA_CACHE_PATH
    ?? join(process.env.HOME ?? '/tmp', '.switchroom', 'quota-cache.json')

/**
 * Read a cached probe result if one exists and is still within TTL.
 * Returns null on:
 *   - file missing
 *   - JSON parse error
 *   - cache entry past its TTL
 *
 * Pure helper — accepts a clock so tests can advance time.
 */
export function readQuotaCache(opts: {
  path?: string
  now?: number
} = {}): ProbeResult | null {
  const path = opts.path ?? DEFAULT_CACHE_PATH
  const now = opts.now ?? Date.now()

  if (!existsSync(path)) return null

  let entry: QuotaCacheEntry
  try {
    entry = JSON.parse(readFileSync(path, 'utf8')) as QuotaCacheEntry
  } catch {
    return null
  }

  const capturedAtMs = Date.parse(entry.capturedAt)
  if (!isFinite(capturedAtMs)) return null

  const ageMs = now - capturedAtMs
  if (ageMs < 0) return null  // clock went backwards; treat as miss
  if (ageMs >= entry.ttlMs) return null  // expired

  return entry.result
}

/**
 * Write a probe result to the cache.
 *
 * Normal results (ok / degraded non-rate-limit) use the standard 5-min TTL.
 * A result with `rateLimited: true` (HTTP 429) uses the short
 * RATE_LIMIT_TTL_MS (30 s) so back-to-back fleet restarts read the cached
 * 'ok' row instead of piling up on the endpoint, while still clearing fast
 * enough for any real next-boot probe to see a live result.
 *
 * Fail results are still not cached — they indicate a real error and the
 * next boot should always retry.
 *
 * Writes are best-effort: any IO error is swallowed (cache is an
 * optimization, not a correctness requirement).
 */
export function writeQuotaCache(
  result: ProbeResult,
  opts: {
    path?: string
    ttlMs?: number
    now?: number
  } = {},
): void {
  // Don't cache hard failures — let the next boot retry clean.
  if (result.status === 'fail') return

  const path = opts.path ?? DEFAULT_CACHE_PATH
  // Rate-limit results use a shorter TTL: long enough to absorb a fleet
  // restart burst, short enough that subsequent boots get a live probe.
  // Use the structured `rateLimited` field rather than string-matching on
  // `detail` — the detail string is user-facing and may change.
  const ttlMs = opts.ttlMs ?? (result.rateLimited ? RATE_LIMIT_TTL_MS : DEFAULT_TTL_MS)
  const now = opts.now ?? Date.now()

  const entry: QuotaCacheEntry = {
    capturedAt: new Date(now).toISOString(),
    ttlMs,
    result,
  }

  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(entry, null, 2), { mode: 0o600 })
  } catch {
    // Best-effort. Swallow.
  }
}
