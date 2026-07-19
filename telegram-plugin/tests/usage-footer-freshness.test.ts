/**
 * Adversarial-review F1 + F2 — the /usage card must NEVER stamp "Live" when
 * no account row carries usable live data.
 *
 * Root cause (F1): the gateway `/usage` handler decided the freshness footer
 * from `probeResp.results.length > 0`. But opProbeQuota
 * (src/auth/broker/server.ts) returns `{result:{ok:false}, served:"live"}`
 * for a failed live probe against an EMPTY cache — a non-empty results array
 * where every row is `ok:false`. `zipProbeResults` only marks
 * `served==="cache"` rows stale, so those failed rows carry no cache stamp
 * either. Result: on a fresh restart (empty cache) + a transient probe
 * failure, every row rendered "⚠️ no data — probe failed" UNDER a false
 * "Live · refreshed 0s ago" stamp.
 *
 * F2 (test gap): the footer decision had zero coverage. This drives the
 * extracted decision (`deriveUsageFooterFreshness`) composed with the real
 * card renderer (`renderUsageCard`) with an all-`ok:false`, no-cache broker
 * stub and asserts the rendered footer is NOT "Live" — i.e. it would fail
 * against the pre-fix `.length > 0` gate.
 */

import { describe, it, expect } from 'vitest'
import {
  deriveUsageFooterFreshness,
  type AccountSnapshot,
  type ProbeQuotaResultRow,
} from '../auth-snapshot-format.js'
import { renderUsageCard } from '../quota-bar-format.js'

const NOW = new Date('2026-07-19T12:00:00Z')

// Two accounts, no usable quota (the probe failed, nothing cached) — mirrors
// what the gateway hands renderUsageCard when the broker cache is empty and
// the live probe threw for every account.
const NO_DATA_SNAPSHOTS: AccountSnapshot[] = [
  { label: 'alice@example.com', isActive: true, quota: null, quotaError: 'probe failed' },
  { label: 'bob@example.com', isActive: false, quota: null, quotaError: 'probe failed' },
]

// A broker probe-quota response where every row failed and nothing was served
// from cache — the exact shape opProbeQuota returns for a failed live probe
// against an empty cache.
const ALL_FAILED_NO_CACHE: ProbeQuotaResultRow[] = [
  { label: 'alice@example.com', result: { ok: false, reason: 'network error' }, served: 'live' },
  { label: 'bob@example.com', result: { ok: false, reason: 'network error' }, served: 'live' },
]

const EXHAUSTED = new Map<string, boolean>()

describe('deriveUsageFooterFreshness (F1)', () => {
  it('flags probeFailed when every row is ok:false and there is no cache', () => {
    const opts = deriveUsageFooterFreshness(ALL_FAILED_NO_CACHE, undefined, NOW.getTime())
    // Would have been { liveProbedAtMs } under the old `.length > 0` gate.
    expect(opts).toEqual({ probeFailed: true })
    expect(opts.liveProbedAtMs).toBeUndefined()
  })

  it('stamps liveProbedAtMs when at least one row carries usable data', () => {
    const rows: ProbeQuotaResultRow[] = [
      ALL_FAILED_NO_CACHE[0],
      {
        label: 'bob@example.com',
        result: {
          ok: true,
          data: {
            fiveHourUtilizationPct: 12,
            sevenDayUtilizationPct: 34,
            fiveHourResetAt: null,
            sevenDayResetAt: null,
            representativeClaim: null,
            overageStatus: null,
            overageDisabledReason: null,
            fiveHourUtilPresent: true,
            sevenDayUtilPresent: true,
          },
        },
        served: 'live',
      },
    ]
    const opts = deriveUsageFooterFreshness(rows, undefined, NOW.getTime())
    expect(opts).toEqual({ liveProbedAtMs: NOW.getTime() })
    expect(opts.probeFailed).toBeUndefined()
  })

  it('gives cache-served data precedence over both live and failed', () => {
    const capturedAt = NOW.getTime() - 60_000
    expect(deriveUsageFooterFreshness(ALL_FAILED_NO_CACHE, capturedAt, NOW.getTime())).toEqual({
      staleCachedAtMs: capturedAt,
    })
  })

  it('flags probeFailed for a totally empty results array', () => {
    expect(deriveUsageFooterFreshness([], undefined, NOW.getTime())).toEqual({ probeFailed: true })
  })
})

describe('/usage card footer end-to-end (F2)', () => {
  it('renders "probe failed", NOT "Live", when no row carries live data', () => {
    const freshness = deriveUsageFooterFreshness(ALL_FAILED_NO_CACHE, undefined, NOW.getTime())
    const card = renderUsageCard(NO_DATA_SNAPSHOTS, EXHAUSTED, { now: NOW, ...freshness })
    expect(card).toContain('probe failed — no live data')
    // The honesty invariant: no "Live" stamp when every row shows no data.
    expect(card).not.toContain('Live')
    // And the rows themselves are the no-data warning, not a fake 0% bar.
    expect(card).toContain('no data — probe failed')
  })

  it('renders a "Live" footer when a row carries usable data', () => {
    const liveSnapshots: AccountSnapshot[] = [
      {
        label: 'bob@example.com',
        isActive: true,
        quota: {
          fiveHourUtilizationPct: 12,
          sevenDayUtilizationPct: 34,
          fiveHourResetAt: null,
          sevenDayResetAt: null,
          representativeClaim: null,
          overageStatus: null,
          overageDisabledReason: null,
          fiveHourUtilPresent: true,
          sevenDayUtilPresent: true,
        },
      },
    ]
    const freshness = deriveUsageFooterFreshness(
      [
        {
          label: 'bob@example.com',
          result: { ok: true, data: liveSnapshots[0].quota! },
          served: 'live',
        },
      ],
      undefined,
      NOW.getTime(),
    )
    const card = renderUsageCard(liveSnapshots, EXHAUSTED, { now: NOW, ...freshness })
    expect(card).toContain('Live · refreshed')
    expect(card).not.toContain('probe failed')
  })
})
