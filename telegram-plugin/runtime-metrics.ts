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
   * Last-resort safety net: 5 minutes silent, the framework itself sent
   * a user-visible "still working… / still thinking…" message AND
   * unwedged the turn (cleared activeTurnStartedAt, nulled currentTurn,
   * drained buffered inbound). Should be rare (target <5 per 1000 turns);
   * a high rate means turns are genuinely getting stuck. This is the only
   * remaining framework safety-net signal — the model-targeted nudge
   * ladder (ack/soft/firm) and the 60s awareness ping were retired once
   * the live-updating reply/draft took over the pacing job.
   */
  | {
      kind: 'silence_fallback_sent'
      key: string
      fallback_kind: 'working' | 'thinking'
      silence_ms: number
    }
  /**
   * #3552 — per-turn silence-poke state dropped by the orphan reaper: the turn
   * behind `key` is provably over (no `activeTurnStartedAt` entry AND no
   * current turn) yet its state was still armed, so it is disarmed on the poll
   * tick rather than 300s later at fire time. A healthy fleet trends this
   * toward zero; a persistent stream of it names a turn-end path that is
   * failing to call `silencePoke.endTurn`. `silence_ms` is how long the state
   * had already been orphaned when the reaper caught it.
   */
  | {
      kind: 'silence_poke_orphan_reaped'
      key: string
      silence_ms: number
    }
  /**
   * #2527 — mid-turn liveness floor decision. `decision: 'fire'` when the
   * quiet "still on it" beat was sent; otherwise the machine-readable skip
   * reason for a declined forced ("Status?") poke. `forced` distinguishes
   * the timer beat from a user-asked one.
   */
  | {
      kind: 'mid_turn_floor'
      key: string
      silence_ms: number
      forced: boolean
      decision: string
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
   *   replaced  → total voice changes in this message (dash rewrites + leading-affirmation strips)
   *   site      → which reply path saw the scrub (executeReply / edit / answer-stream)
   */
  | {
      kind: 'voice_scrub_applied'
      chatKey: string
      replaced: number
      // `stream_reply` and `turn_flush` added in v0.13.21 — modern
      // Claude routes most multi-paragraph replies through the
      // answer-stream / draft-stream path, bypassing the v0.13.20
      // executeReply scrub site. The two new sites close that gap.
      site: 'reply' | 'edit_message' | 'progress_update' | 'answer_stream' | 'stream_reply' | 'turn_flush'
    }
  /**
   * #2307 Tier-1: a cron fire routed to the `<agent>-cron` cheap session
   * (meta.session=cron) fell back to the MAIN session because the cron bridge
   * wasn't registered (wedged boot, crashed session, or hot-added cron with no
   * live session yet). Each occurrence means the Tier-1 saving was NOT realised
   * for that fire — a climbing counter is the runtime signal that a cron
   * session is down (the doctor check catches a permanently-wedged one at boot;
   * this catches a session that registered then died).
   */
  | {
      kind: 'cron_fell_back_to_main'
      agent: string
      prompt_key: string
    }
  /**
   * Every terminal rate-limit-family operator event (429 burst / 529
   * overload), classified by origin BEFORE the gateway acts on it — fires
   * even when the user-facing card is cooldown-suppressed, so the count is
   * honest. `classification` says where the limit lives (see
   * `RateLimit429Classification` in throttle-tier.ts): `account-scoped` =
   * Anthropic throttled the account (throttle tier ran), `litellm-local` =
   * the LiteLLM proxy's own tpm/rpm/router limiter tripped (calm path, no
   * account attribution), `generic-transient` = other server-side 429/529
   * wording. `action` is what the gateway DECIDED (throttle / failover /
   * calm), emitted PRE-execution: the actual failover fire is dedup-gated
   * downstream (fleetFallbackGate), so N long-reset 429s inside one dedup
   * window emit N `action: 'failover'` metrics for ONE real roll — count
   * decisions here, count rolls via the broker/fallback announcements.
   * Correlating `account-scoped` fires against fleet token throughput is
   * the operator's evidence base for setting LiteLLM `tpm_limit` caps; the
   * `litellm-local` count then shows those caps actually absorbing load.
   * Limit/reset fields are best-effort parses of the error body (null when
   * absent).
   */
  | {
      kind: 'rate_limit_429_classified'
      agent: string
      classification: 'account-scoped' | 'litellm-local' | 'generic-transient'
      action: 'throttle' | 'failover' | 'calm'
      reset_at_ms: number | null
      reset_in_ms: number | null
      limit_type: string | null
      limit: number | null
      current_usage: number | null
    }
  /**
   * A litellm-local throttle NOTICE actually posted (litellm-local-notice.ts
   * — the debounced "fleet token limiter engaged" message). Distinct from
   * `rate_limit_429_classified`, which fires on EVERY classified 429: this
   * fires once per sent notice, and `suppressed_count` is how many
   * litellm-local 429s the cooldown window silently absorbed since the
   * previous notice (0 on the first) — the debounce's effectiveness in one
   * number. `window_ms` is the resolved cooldown window (default 15 min;
   * channels.telegram.litellm_notice.window_ms).
   */
  | {
      kind: 'litellm_local_429_notice'
      agent: string
      suppressed_count: number
      window_ms: number
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
