/**
 * Placeholder heartbeat — keeps the user-visible draft message moving
 * during the model's TTFT window so the chat never feels frozen.
 *
 * Design: docs/heartbeat-placeholder-design.md (§3 minimum shape).
 * This module implements the zero-extractor version: a per-chat
 * setTimeout chain that edits the placeholder draft every
 * `intervalMs` with the elapsed wait time.
 *
 * Lives in its own module so the formatter + lifecycle logic is
 * unit-testable without booting the gateway. The gateway-side wiring
 * (start at pre-alloc success, cancel at all three preAllocatedDrafts
 * delete sites) is in `gateway.ts`.
 *
 * Failure modes (specified in design §3.4):
 * - sendMessageDraft errors are swallowed; next tick still fires
 * - isPlaceholderActive returning false stops the chain immediately
 * - maxDurationMs is a safety cap; default 5min, far longer than any
 *   realistic turn
 *
 * §4 enrichment (label-map coordination, session-tail tool labels)
 * is intentionally NOT in this module — that's a follow-up PR. The
 * `getCurrentLabel` callback is included as a forward-compatible
 * seam: §3 minimum passes a constant-returning function; §4 will
 * pass a label-map reader.
 */

/** Default placeholder text when no enrichment source has set a label. */
export const DEFAULT_HEARTBEAT_LABEL = '🔵 thinking'

/** Max sane heartbeat duration. Beyond this we stop ticking — the turn
 * is either genuinely runaway or something has wedged. The placeholder
 * stays visible at its last text; user can re-send if needed. */
export const DEFAULT_MAX_DURATION_MS = 5 * 60 * 1000  // 5 min

/** Default tick interval. See §5.1 in the design doc for the
 * Telegram-cap / perception / mobile-battery rationale. */
export const DEFAULT_INTERVAL_MS = 5000

/**
 * Format an elapsed milliseconds value as a short human-readable string.
 *
 * Precision tiers from §3.2:
 * - 0–9s:    1s precision   →  "5s", "9s"
 * - 10–59s:  5s precision   →  "10s", "15s", "55s"
 * - 1–9m:    minute precision → "1m", "1m 30s", "2m"
 * - ≥10m:    minute-only     → "10m+"
 *
 * The 5s precision in the 10-59s window matches the heartbeat tick
 * interval — every tick produces a different displayed value, so the
 * visible change is always meaningful (not "incremented by 1 then 1
 * then 1, hard to notice").
 */
export function formatElapsed(elapsedMs: number): string {
  // Defensive: negative inputs (clock skew, test races) → "0s"
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000))
  if (seconds < 10) return `${seconds}s`
  if (seconds < 60) {
    // Round to nearest 5s — matches tick cadence
    const rounded = Math.round(seconds / 5) * 5
    return `${rounded}s`
  }
  const totalMinutes = Math.floor(seconds / 60)
  if (totalMinutes >= 10) return '10m+'
  const remainderSec = Math.round((seconds - totalMinutes * 60) / 5) * 5
  // Snap remainder up to a clean minute when it would round to 60
  if (remainderSec >= 60) return `${totalMinutes + 1}m`
  if (remainderSec === 0) return `${totalMinutes}m`
  return `${totalMinutes}m ${remainderSec}s`
}

/**
 * Compose the heartbeat placeholder text from a label + elapsed.
 *
 * Pattern: `${label} · ${elapsed}` — the middle dot is `·` (U+00B7),
 * which renders cleanly across iOS/Android/desktop Telegram clients.
 *
 * If `label` already ends with a `·`-separated token (e.g. recall.py
 * pushed `📚 recalling memories · 5s` somehow), don't double-append —
 * strip the trailing token and re-render with the current elapsed.
 * Mostly a defensive guard for the §4 enrichment path; in §3 minimum
 * the label is always the constant DEFAULT_HEARTBEAT_LABEL.
 */
export function composeHeartbeatText(label: string | null, elapsedMs: number): string {
  const baseLabel = (label ?? DEFAULT_HEARTBEAT_LABEL).trim()
  // Strip any trailing ` · <something>` so we don't accumulate.
  const stripped = baseLabel.replace(/\s*·\s*[^·]+$/, '').trimEnd()
  // If stripping removed everything (label was JUST an elapsed string),
  // fall back to the default.
  const cleanLabel = stripped.length > 0 ? stripped : DEFAULT_HEARTBEAT_LABEL
  return `${cleanLabel} · ${formatElapsed(elapsedMs)}`
}

/**
 * Dependencies the heartbeat needs. Every external interaction is
 * injected so the module can be tested without booting the gateway.
 */
export interface HeartbeatDeps {
  /** Bound `sendMessageDraft` for this gateway instance. Same shape
   * as gateway.ts's `sendMessageDraftFn`. */
  sendMessageDraft: (chatId: string, draftId: number, text: string) => Promise<unknown>
  /** Returns true while the placeholder draft for this chat is still
   * the bridge's responsibility — i.e. while
   * `preAllocatedDrafts.has(chatId)` is true in the gateway. The
   * heartbeat exits cleanly the first time this returns false. */
  isPlaceholderActive: (chatId: string) => boolean
  /** Returns the current label text for this chat, or null to use
   * `DEFAULT_HEARTBEAT_LABEL`. In §3 minimum this always returns null;
   * §4 enrichment swaps in a label-map reader. */
  getCurrentLabel: (chatId: string) => string | null
  /** Tick interval. See §5.1. */
  intervalMs: number
  /** Safety cap. See `DEFAULT_MAX_DURATION_MS`. */
  maxDurationMs: number
  /** Optional logger; when omitted, no diagnostic lines are written.
   * Production gateway passes `(msg) => process.stderr.write(...)`. */
  log?: (msg: string) => void
}

/** Returned from `startHeartbeat`. The cancel function is idempotent. */
export interface HeartbeatHandle {
  cancel: () => void
}

/**
 * Start a heartbeat for a placeholder draft. Returns a handle whose
 * `cancel()` stops the next pending tick.
 *
 * The first tick fires at `+intervalMs` (NOT immediately) because the
 * placeholder text was just written by pre-alloc and showing
 * `🔵 thinking · 0s` would be redundant. By T+intervalMs the user has
 * been waiting long enough for an elapsed counter to be informative.
 *
 * `cancel()` clears any scheduled tick; idempotent (safe to call
 * multiple times).
 */
export function startHeartbeat(
  chatId: string,
  draftId: number,
  startedAt: number,
  deps: HeartbeatDeps,
): HeartbeatHandle {
  const { sendMessageDraft, isPlaceholderActive, getCurrentLabel, intervalMs, maxDurationMs, log } = deps

  // intervalMs = 0 is the operator opt-out signal (see §5 + §10.1
  // rollback plan). Return a no-op handle so the caller doesn't
  // have to special-case it.
  if (intervalMs <= 0) {
    log?.(`telegram gateway: heartbeat disabled chatId=${chatId} (intervalMs=${intervalMs})`)
    return { cancel: () => {} }
  }

  let timer: ReturnType<typeof setTimeout> | null = null
  let cancelled = false

  const tick = (): void => {
    if (cancelled) return
    const elapsedMs = Date.now() - startedAt

    // Safety cap: stop ticking after maxDurationMs even if the
    // placeholder is somehow still active. Protects against runaway
    // turns and any bug that prevents normal cancel.
    if (elapsedMs >= maxDurationMs) {
      log?.(`telegram gateway: heartbeat max-duration reached chatId=${chatId} elapsedMs=${elapsedMs}`)
      cancelled = true
      timer = null
      return
    }

    // Honour the placeholder lifecycle: if the gateway already
    // consumed/deleted the draft, stop now without making another
    // edit (which would either fail or revive a closed message).
    if (!isPlaceholderActive(chatId)) {
      log?.(`telegram gateway: heartbeat stopped chatId=${chatId} reason=placeholder-inactive`)
      cancelled = true
      timer = null
      return
    }

    const label = getCurrentLabel(chatId)
    const text = composeHeartbeatText(label, elapsedMs)

    // Fire-and-forget. Errors (rate limit, deleted message, etc.)
    // are swallowed by design — next tick will either succeed or
    // exit on the isPlaceholderActive check.
    void sendMessageDraft(chatId, draftId, text).catch((err: unknown) => {
      log?.(
        `telegram gateway: heartbeat edit failed chatId=${chatId} draftId=${draftId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    })

    // Schedule next tick if we're still alive.
    if (!cancelled) {
      timer = setTimeout(tick, intervalMs)
    }
  }

  // First tick fires at +intervalMs. Pre-alloc text is fresh; no
  // immediate edit needed.
  timer = setTimeout(tick, intervalMs)
  log?.(`telegram gateway: heartbeat started chatId=${chatId} draftId=${draftId} intervalMs=${intervalMs}`)

  return {
    cancel: () => {
      if (cancelled) return
      cancelled = true
      if (timer != null) {
        clearTimeout(timer)
        timer = null
      }
      log?.(`telegram gateway: heartbeat cancelled chatId=${chatId}`)
    },
  }
}
