/**
 * runtime-metrics.ts — high-value gateway events fanned out to PostHog
 * AND a local JSONL file.
 *
 * Why both sinks:
 *  - PostHog gets the events for dashboards, funnels, error correlation,
 *    fleet-wide KPI tracking. This is the source of truth for the
 *    conversational-turn-UX redesign KPIs (see docs/posthog.md).
 *  - JSONL is preserved as a per-agent debug breadcrumb so the agent's
 *    own context (or an operator on the host) can read what happened
 *    without round-tripping to PostHog. Same file the silence-poke
 *    subsystem (next PR) will append to.
 *
 * Distinct from `streaming-metrics.ts` — that module is the noisy
 * gated-by-env stderr stream used for one-off streaming-perf analysis.
 * Runtime metrics are always-on, narrow, and KPI-shaped.
 */

import { existsSync, mkdirSync, appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { captureEvent } from './analytics-posthog.js'
import type { PokeLevel } from './silence-poke.js'

export type RuntimeMetricEvent =
  /**
   * A user-sent message that matches a status-query pattern
   * ("status?", "still there?", etc). Primary lagging KPI for the
   * conversational turn UX — every fire is a JTBD failure.
   */
  | {
      kind: 'inbound_status_query'
      chat_id: string
      message_id: number | null
      thread_id: number | null
      text_length: number
      prior_turn_in_flight: boolean
      seconds_since_turn_start: number | null
    }
  /**
   * A fresh turn began (user message arrived, ack reaction fired).
   * Pairs with `turn_ended` for duration / TTFO computation.
   */
  | {
      kind: 'turn_started'
      chat_id: string
      message_id: number | null
      thread_id: number | null
      inbound_classified_as_status_query: boolean
    }
  /**
   * A turn completed (terminal reply or silent close). Carries the
   * gap distribution + TTFO so the dashboard can compute outbound
   * silence p95 without per-event reconstruction.
   */
  | {
      kind: 'turn_ended'
      chat_id: string
      thread_id: number | null
      duration_ms: number
      ttfo_ms: number | null
      outbound_count: number
      longest_silent_gap_ms: number
      ended_via: 'reply' | 'stream_reply_done' | 'silent' | 'forced' | 'framework_fallback'
    }
  /**
   * Framework safety-net: a silence-poke was armed. `ack` is the early
   * (~10s) ack-budget poke — the model has sent NOTHING this turn and is
   * leaving the user on a silent chat. `soft` (75s) / `firm` (180s) are
   * the silence-since-last-outbound ladder. The system-reminder appended
   * to the next tool result nudges the model to send an update. Doubles
   * as a design-health signal — if these fire frequently, the
   * conversational-pacing prompt isn't doing its job.
   */
  | {
      kind: 'silence_poke_fired'
      key: string
      level: PokeLevel
      silence_ms: number
      subagent_wait: boolean
    }
  /**
   * The model sent an outbound message within the success window
   * (default 15s) after a poke fired. Pair with `silence_poke_fired`
   * to compute success rate — the design target is >80%. (`ack`-level
   * success is not currently emitted — the ack poke sits outside the
   * `pokesFired` ladder noteOutbound measures against; the type admits
   * `ack` only so the silence-poke metric union stays assignable.)
   */
  | {
      kind: 'silence_poke_succeeded'
      key: string
      level: PokeLevel
      latency_ms: number
    }
  /**
   * Last-resort: 5 minutes silent, the framework itself sent a
   * user-visible "still working… / still thinking…" message. Should
   * be rare (target <5 per 1000 turns); a high rate means the model
   * is genuinely stuck or the soft/firm pokes aren't being honoured.
   */
  | {
      kind: 'silence_fallback_sent'
      key: string
      fallback_kind: 'working' | 'thinking'
      silence_ms: number
    }
  /**
   * #1445 cross-turn pending-async ambient lifecycle. `started` fires
   * when a turn ends with a captured anchor AND a pending Agent/Task/
   * Bash-background dispatch — i.e. the framework will now edit the
   * model's last reply in place every ~60s until cleared. `edited`
   * fires on each successful in-place edit; `elapsed_ms` is how long
   * ambient has been running for this chat. `cleared` fires when
   * ambient stops — `reason` says why (inbound / handback / timeout).
   * Targets: edited/started ratio is the "still alive minutes per
   * activation" health proxy; cleared.reason='inbound' should
   * dominate (model + user resolving naturally).
   */
  | { kind: 'pending_progress_started'; chatKey: string }
  | { kind: 'pending_progress_edited'; chatKey: string; elapsedMs: number }
  | {
      kind: 'pending_progress_cleared'
      chatKey: string
      elapsedMs?: number
      reason?: string
    }
  /**
   * #1674 over-ping safety net engaged. Fires when a `reply` call
   * arrived with `disable_notification: false` AND the current turn
   * already had a pinged reply land — the framework downgraded this
   * call to silent to honour beat 5's "EXACTLY ONE ping per turn"
   * contract. Each event is a model contract violation the safety
   * net caught. A high rate per agent means the model is
   * systematically over-pinging — prompt drift or training
   * regression worth investigating.
   *
   *   key                 → `<chatId>:<threadIdOrEmpty>` (the statusKey shape)
   *   sinceFirstPingMs    → time since the FIRST ping landed this turn
   */
  | {
      kind: 'over_ping_suppressed'
      key: string
      sinceFirstPingMs: number
    }
  /**
   * Voice scrubber engaged: em / en dashes were rewritten to commas /
   * periods on an outbound reply. Each event is a soft-layer policy
   * violation the framework caught (SOUL.md.hbs "never use em-dashes"
   * is the soft layer, this scrub is the hard layer). Fleet-wide
   * trend over weeks shows whether the soft prompt is gaining or
   * losing ground; a per-agent spike is prompt drift on that agent.
   *
   *   chatKey   → `<chatId>:<threadIdOrEmpty>` (statusKey shape)
   *   replaced  → count of dashes rewritten in this single message
   *   site      → which reply path saw the scrub (executeReply / edit / answer-stream)
   */
  | {
      kind: 'voice_scrub_applied'
      chatKey: string
      replaced: number
      site: 'reply' | 'edit_message' | 'progress_update' | 'answer_stream'
    }

/**
 * The JSONL sink lives under the runtime state dir so it's per-agent
 * and survives container restarts (the dir is bind-mounted from the
 * host). Path can be overridden for tests via SWITCHROOM_RUNTIME_METRICS_PATH.
 */
function resolveJsonlPath(): string {
  const override = process.env.SWITCHROOM_RUNTIME_METRICS_PATH
  if (override && override.trim() !== '') return override.trim()
  const base = process.env.SWITCHROOM_RUNTIME_STATE_DIR ?? '/state/agent'
  return join(base, 'runtime-metrics.jsonl')
}

function appendJsonl(line: string): void {
  const path = resolveJsonlPath()
  try {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, line + '\n', 'utf-8')
  } catch (err) {
    // JSONL is a local debug aid; failing to write must not break
    // the gateway. Surface to stderr so it's at least visible in
    // the plugin log.
    process.stderr.write(`runtime-metrics: jsonl write failed: ${(err as Error).message}\n`)
  }
}

/**
 * Whether to write JSONL at all. Defaults to ON (the user asked for it
 * to stay as a local debugging side-channel). Operator can opt-out with
 * SWITCHROOM_RUNTIME_METRICS_JSONL_DISABLED=1 if disk pressure is a
 * concern.
 */
function jsonlEnabled(): boolean {
  const v = process.env.SWITCHROOM_RUNTIME_METRICS_JSONL_DISABLED
  return !(v === '1' || v === 'true')
}

/**
 * Emit one runtime metric event. Fans out to:
 *   1. JSONL file (unless disabled)
 *   2. PostHog (unless SWITCHROOM_TELEMETRY_DISABLED=1)
 *
 * Never throws. Each sink fails independently — a broken sink does not
 * block the other.
 */
export function emitRuntimeMetric(event: RuntimeMetricEvent): void {
  const wrapped = { ts: Date.now(), ...event }
  if (jsonlEnabled()) {
    try {
      appendJsonl(JSON.stringify(wrapped))
    } catch {
      // already guarded inside appendJsonl
    }
  }
  // captureEvent is async + internally guarded; void-fire to avoid blocking
  // the caller. PostHog batches, so this is cheap.
  void captureEvent(event.kind, { ...event, ts: wrapped.ts })
}

/** Exposed for tests — pin the JSONL path to a temp file. */
export function __setRuntimeMetricsPathForTests(path: string | null): void {
  if (path == null) {
    delete process.env.SWITCHROOM_RUNTIME_METRICS_PATH
  } else {
    process.env.SWITCHROOM_RUNTIME_METRICS_PATH = path
  }
}

/** Exposed for tests — read back the current resolved path. */
export function __getRuntimeMetricsPathForTests(): string {
  return resolveJsonlPath()
}

/** Exposed for tests — JSONL gate helper. */
export function __isJsonlEnabledForTests(): boolean {
  return jsonlEnabled()
}
