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
 * HTTP call. 429 results are NOT cached so the next boot tries fresh.
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
 * Write a probe result to the cache. Ignored on rate-limited or
 * fail-status results — we want the next boot to try fresh.
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
  // Don't cache failure / rate-limit so next boot retries clean.
  if (result.status === 'fail') return
  if (result.detail === 'rate limited') return

  const path = opts.path ?? DEFAULT_CACHE_PATH
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
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
