/**
 * Pure helpers for determining boot reason and resolving the target chat
 * on every gateway start.
 *
 * Kept in a separate module so unit tests can import them without pulling
 * in the full gateway.ts side-effect tree (bot setup, DB init, etc.).
 */

import type { RestartReason } from './boot-card.js'
import type { CleanShutdownMarker } from './clean-shutdown-marker.js'
import { DEFAULT_MAX_AGE_MS as CLEAN_SHUTDOWN_MAX_AGE_MS } from './clean-shutdown-marker.js'
import type { SessionMarker } from './session-marker.js'

// Re-export so tests can import from a single path
export type { RestartReason }

/**
 * Operator-initiated restart-marker freshness window. Longer than the
 * default `clean-shutdown.json` window (60s) because operator-driven
 * flows — specifically `switchroom update` from the host CLI — stamp
 * the marker BEFORE `docker compose up -d --remove-orphans` runs, and
 * the recreate for a multi-agent fleet can comfortably take longer
 * than 60s to bring every container's gateway back up (9 agents ×
 * docker network/volume setup + gateway boot probes). Without this
 * extended window, my "operator: switchroom update" marker reads
 * stale by the time the late-bootstrapping agent's gateway reads it
 * — `determineRestartReason` falls through to `'crash'` and the
 * boot card renders the planned redeploy as a crash with a noisy
 * `agent-crashed` operator-events broadcast (the very pattern
 * PR #1139 set out to suppress).
 *
 * Five minutes is generous: a 50-agent fleet recreate would still
 * finish well inside it, and we still treat a 5-min-old marker as a
 * crash if the gateway eventually does come up so the longer window
 * isn't a "silent forever" mode. Verified end-to-end against a 9-agent
 * fleet on 2026-05-13: latest-recreated agent's marker age was 97s.
 *
 * Keyed on the reason-text prefix (`operator:`) so user/cli/in-gateway
 * restart paths keep their 60s tight window — those produce a much
 * shorter shutdown-to-boot delta and a 5-min window there would mask
 * a real crash during/after a `/restart`.
 */
const OPERATOR_MARKER_MAX_AGE_MS = 5 * 60_000

/**
 * Determine why this gateway is starting up.
 *
 * Priority order:
 *   1. restart-pending.json present + fresh (<5 min) → 'planned'
 *   2. clean-shutdown.json present + fresh:
 *        - default <60s → 'graceful'
 *        - reason starts with `operator:` → <5min → 'graceful' (#1141
 *          follow-up: fleet recreate can exceed 60s and still be a
 *          planned operator update)
 *   3. gateway-session.json present (prior process existed) → 'crash'
 *   4. Otherwise → 'fresh'
 */
export function determineRestartReason(opts: {
  marker: { ts: number } | null
  cleanMarker: CleanShutdownMarker | null
  sessionMarker: SessionMarker | null
  now: number
  cleanMaxAgeMs?: number
  markerMaxAgeMs?: number
  operatorMaxAgeMs?: number
}): RestartReason {
  const {
    marker,
    cleanMarker,
    sessionMarker,
    now,
    cleanMaxAgeMs = CLEAN_SHUTDOWN_MAX_AGE_MS,
    markerMaxAgeMs = 5 * 60_000,
    operatorMaxAgeMs = OPERATOR_MARKER_MAX_AGE_MS,
  } = opts
  if (marker != null && now - marker.ts < markerMaxAgeMs) return 'planned'
  if (cleanMarker != null && now - cleanMarker.ts >= 0) {
    const isOperator = typeof cleanMarker.reason === 'string'
      && cleanMarker.reason.startsWith('operator:')
    const window = isOperator ? operatorMaxAgeMs : cleanMaxAgeMs
    if (now - cleanMarker.ts < window) return 'graceful'
  }
  if (sessionMarker != null) return 'crash'
  return 'fresh'
}

/**
 * Boot-reason window during which a bridge re-register reuses the reason
 * the boot path already determined. Matches the restart-marker and
 * operator-marker freshness windows (5 min) — a bridge that survived a
 * gateway restart reconnects within seconds of the new gateway's boot,
 * comfortably inside it.
 */
export const BOOT_REASON_REUSE_WINDOW_MS = 5 * 60_000

/**
 * Determine the restart reason for a BRIDGE RE-REGISTER (gateway.ts
 * `onClientRegistered`, the `bridge-reconnect` path) — as opposed to the
 * gateway's own boot path.
 *
 * Why this exists (fleet-audit B2, kdogg 2026-08-02 06:27 trace): on a
 * planned gateway restart (`cli: restart` SIGTERM), the bridge — living
 * inside the separate claude process — survives and reconnects a few
 * seconds after the new gateway boots. By then the boot path has already
 * READ AND CLEARED the restart / clean-shutdown markers (the 2026-05-25
 * GC, gateway.ts boot path), so re-deriving the reason from disk falls
 * through to the sessionMarker branch and every such re-register logs —
 * and, when a chat is resolvable, POSTS a boot card claiming —
 * `reason=crash` for a perfectly graceful restart. Hundreds of these per
 * agent fleet-wide (lawgpt 310, reggie 179, ziggy 175, kdogg 174).
 *
 * Decision:
 *   1. Any on-disk marker still present → normal `determineRestartReason`
 *      (in-gateway /restart flows where the gateway never went down write
 *      a marker the boot path never consumed — keep honoring it).
 *   2. No markers, but the gateway booted recently (<5 min) and recorded
 *      the reason it determined at boot → reuse that reason. The bridge
 *      is re-registering into the SAME restart episode the boot path
 *      already classified.
 *   3. Otherwise (gateway long-lived, markers absent) → fall through to
 *      `determineRestartReason` — a marker-less bridge re-register hours
 *      into a gateway's life still classifies conservatively as 'crash'
 *      (the claude/bridge side genuinely died and came back).
 */
export function determineBridgeReconnectReason(opts: {
  marker: { ts: number } | null
  cleanMarker: CleanShutdownMarker | null
  sessionMarker: SessionMarker | null
  now: number
  /** `GATEWAY_STARTED_AT_MS` of the running gateway process. */
  gatewayStartedAtMs: number
  /** Reason the gateway's own boot path determined (null if it never ran). */
  bootReason: RestartReason | null
  bootReasonReuseWindowMs?: number
  cleanMaxAgeMs?: number
  markerMaxAgeMs?: number
  operatorMaxAgeMs?: number
}): RestartReason {
  const { gatewayStartedAtMs, bootReason, bootReasonReuseWindowMs = BOOT_REASON_REUSE_WINDOW_MS } = opts
  if (opts.marker == null && opts.cleanMarker == null
    && bootReason != null
    && opts.now - gatewayStartedAtMs < bootReasonReuseWindowMs) {
    return bootReason
  }
  return determineRestartReason(opts)
}
