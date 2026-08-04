/**
 * Unit tests for determineRestartReason() — the pure helper that decides
 * which restart reason to show in the boot card.
 *
 * Run with:
 *   bun test telegram-plugin/tests/boot-card-reason.test.ts
 */
import { describe, it, expect } from 'bun:test'
import { determineRestartReason } from '../gateway/boot-reason.js'

const NOW = 1_700_000_000_000 // arbitrary fixed timestamp

// ── Marker fixtures ────────────────────────────────────────────────────────

function recentMarker(offsetMs = 0) {
  return { ts: NOW - offsetMs }
}

function recentCleanMarker(offsetMs = 0, reason?: string) {
  // `signal` is part of the CleanShutdownMarker shape; required at the
  // type level but not exercised by determineRestartReason itself.
  return { ts: NOW - offsetMs, signal: 'SIGTERM', reason }
}

function sessionMarker() {
  return { pid: 1234 }
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('determineRestartReason', () => {
  it('returns "planned" when a restart marker is present and fresh (<5 min)', () => {
    const result = determineRestartReason({
      marker: recentMarker(10_000),     // 10s ago
      cleanMarker: null,
      sessionMarker: sessionMarker(),
      now: NOW,
    })
    expect(result).toBe('planned')
  })

  it('returns "graceful" when clean-shutdown marker is present and fresh, no restart marker', () => {
    const result = determineRestartReason({
      marker: null,
      cleanMarker: recentCleanMarker(5_000),   // 5s ago, within 60s default
      sessionMarker: sessionMarker(),
      now: NOW,
    })
    expect(result).toBe('graceful')
  })

  it('returns "crash" when session marker exists but no other markers', () => {
    const result = determineRestartReason({
      marker: null,
      cleanMarker: null,
      sessionMarker: sessionMarker(),
      now: NOW,
    })
    expect(result).toBe('crash')
  })

  it('returns "fresh" when no markers exist at all (first ever start)', () => {
    const result = determineRestartReason({
      marker: null,
      cleanMarker: null,
      sessionMarker: null,
      now: NOW,
    })
    expect(result).toBe('fresh')
  })

  it('returns "crash" (not "graceful") when clean-shutdown marker is stale (>60s)', () => {
    const result = determineRestartReason({
      marker: null,
      cleanMarker: recentCleanMarker(90_000),  // 90s ago, stale
      sessionMarker: sessionMarker(),
      now: NOW,
    })
    // stale clean-shutdown = marker too old to suppress crash detection
    expect(result).toBe('crash')
  })

  it('returns "planned" even when clean-shutdown marker is also present (planned wins)', () => {
    // Both present: planned restart marker takes priority
    const result = determineRestartReason({
      marker: recentMarker(3_000),
      cleanMarker: recentCleanMarker(3_000),
      sessionMarker: sessionMarker(),
      now: NOW,
    })
    expect(result).toBe('planned')
  })

  it('returns "graceful" when clean-shutdown marker has operator: reason and is within the extended 5-min window (#1141 follow-up: 9-agent fleet recreate can exceed 60s)', () => {
    const result = determineRestartReason({
      marker: null,
      cleanMarker: recentCleanMarker(97_000, 'operator: switchroom update'),
      sessionMarker: sessionMarker(),
      now: NOW,
    })
    expect(result).toBe('graceful')
  })

  it('still treats operator: marker as stale beyond 5 min (longer window not "silent forever")', () => {
    const result = determineRestartReason({
      marker: null,
      cleanMarker: recentCleanMarker(6 * 60_000, 'operator: switchroom update'),
      sessionMarker: sessionMarker(),
      now: NOW,
    })
    expect(result).toBe('crash')
  })

  it('non-operator reasons (user:, cli:) keep the tight 60s window — a /restart that takes >60s before its gateway boots is still a crash', () => {
    const result = determineRestartReason({
      marker: null,
      cleanMarker: recentCleanMarker(90_000, 'user: /restart from chat'),
      sessionMarker: sessionMarker(),
      now: NOW,
    })
    expect(result).toBe('crash')
  })

  it('cli: reasons also keep the tight 60s window', () => {
    const result = determineRestartReason({
      marker: null,
      cleanMarker: recentCleanMarker(90_000, 'cli: switchroom restart'),
      sessionMarker: sessionMarker(),
      now: NOW,
    })
    expect(result).toBe('crash')
  })

  it('operator: marker just barely inside the 5-min window still graceful', () => {
    const result = determineRestartReason({
      marker: null,
      cleanMarker: recentCleanMarker(4 * 60_000 + 59_000, 'operator: switchroom update'),
      sessionMarker: sessionMarker(),
      now: NOW,
    })
    expect(result).toBe('graceful')
  })

  it('respects operatorMaxAgeMs override (tests can tighten the window)', () => {
    const result = determineRestartReason({
      marker: null,
      cleanMarker: recentCleanMarker(120_000, 'operator: switchroom update'),
      sessionMarker: sessionMarker(),
      now: NOW,
      operatorMaxAgeMs: 60_000, // override tightens to 60s
    })
    expect(result).toBe('crash')
  })

  it('respects custom markerMaxAgeMs — stale marker does not count as planned', () => {
    const result = determineRestartReason({
      marker: recentMarker(10 * 60_000),  // 10 min ago
      cleanMarker: null,
      sessionMarker: sessionMarker(),
      now: NOW,
      markerMaxAgeMs: 5 * 60_000,          // 5 min window
    })
    // Marker is too old to be "planned", session marker present → crash
    expect(result).toBe('crash')
  })
})

// ── determineBridgeReconnectReason (fleet-audit B2) ────────────────────────
//
// Live trace this pins (kdogg gateway-supervisor.log, 2026-08-02):
//   06:27:43  shutdown.clean_marker_written reason="cli: restart"
//   06:27:46  boot.clean_shutdown_detected → boot path logs reason=graceful
//             …and CLEARS the clean-shutdown marker (2026-05-25 GC)
//   06:27:55  surviving bridge re-registers → old code re-derived from the
//             now-empty disk and logged reason=crash for a graceful restart.
// Fleet-wide: lawgpt 310 / reggie 179 / ziggy 175 / kdogg 174 such lines.

import { determineBridgeReconnectReason } from '../gateway/boot-reason.js'

describe('determineBridgeReconnectReason', () => {
  it('reuses the boot-determined reason when the boot path consumed the markers (kdogg 2026-08-02 trace)', () => {
    const result = determineBridgeReconnectReason({
      marker: null,               // cleared by the boot path
      cleanMarker: null,          // cleared by the boot path
      sessionMarker: sessionMarker(),
      now: NOW,
      gatewayStartedAtMs: NOW - 10_000, // bridge re-registered 10s after boot
      bootReason: 'graceful',
    })
    // Old behavior (plain determineRestartReason on the empty disk state)
    // returned 'crash' here — the B2 mislabel.
    expect(result).toBe('graceful')
  })

  it('a still-present fresh restart marker wins over the cached boot reason', () => {
    const result = determineBridgeReconnectReason({
      marker: recentMarker(10_000),
      cleanMarker: null,
      sessionMarker: sessionMarker(),
      now: NOW,
      gatewayStartedAtMs: NOW - 10_000,
      bootReason: 'graceful',
    })
    expect(result).toBe('planned')
  })

  it('a still-present fresh clean-shutdown marker wins over the cached boot reason', () => {
    const result = determineBridgeReconnectReason({
      marker: null,
      cleanMarker: recentCleanMarker(5_000),
      sessionMarker: sessionMarker(),
      now: NOW,
      gatewayStartedAtMs: NOW - 10_000,
      bootReason: 'crash',
    })
    expect(result).toBe('graceful')
  })

  it('late re-register (gateway up past the reuse window) still classifies as crash', () => {
    const result = determineBridgeReconnectReason({
      marker: null,
      cleanMarker: null,
      sessionMarker: sessionMarker(),
      now: NOW,
      gatewayStartedAtMs: NOW - 6 * 60_000, // gateway alive 6 min — bridge side died
      bootReason: 'graceful',
    })
    expect(result).toBe('crash')
  })

  it('no recorded boot reason falls back to the plain derivation', () => {
    const result = determineBridgeReconnectReason({
      marker: null,
      cleanMarker: null,
      sessionMarker: sessionMarker(),
      now: NOW,
      gatewayStartedAtMs: NOW - 10_000,
      bootReason: null,
    })
    expect(result).toBe('crash')
  })

  it('fresh first boot (no session marker) reuses bootReason fresh', () => {
    const result = determineBridgeReconnectReason({
      marker: null,
      cleanMarker: null,
      sessionMarker: null,
      now: NOW,
      gatewayStartedAtMs: NOW - 3_000,
      bootReason: 'fresh',
    })
    expect(result).toBe('fresh')
  })
})
