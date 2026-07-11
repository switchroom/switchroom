/**
 * Pure helpers for permission-card TIMEOUT handling — making a "no operator
 * responded" auto-deny distinguishable from a deliberate denial, and
 * suppressing the duplicate card a model raises when it retries the identical
 * call after such a timeout.
 *
 * Background (marko Rentals-budget loop, 2026-06-17). switchroom forwards a
 * permission verdict to claude as `{ behavior, message? }`; with no `message`,
 * claude renders the generic "the user said: Denied". A 10-minute TTL
 * auto-deny was therefore indistinguishable from a real operator "Deny", so
 * the model read it as transient and retried the SAME tool call — re-raising
 * an identical card 10 minutes later, in a loop the operator never asked for.
 *
 * Two levers, both pure here and wired in gateway.ts:
 *  1. `timeoutDenyMessage` — the `message` we attach ONLY to a TTL auto-deny,
 *     telling the model it was a timeout (not a denial) and not to retry.
 *  2. `permissionSignature` + `isRecentTimeoutDuplicate` — recognise a retry of
 *     the exact same (tool, input) shortly after it timed out, so the gateway
 *     can short-circuit it (deny with `duplicateDenyMessage`) WITHOUT posting a
 *     second identical card. The suppression is reset on operator activity
 *     (handled gateway-side), so it only ever holds while the operator is
 *     genuinely absent — re-showing a card to an absent operator is the noise
 *     this removes.
 */

// NUL — can appear in neither a tool name nor a rendered input preview, so it
// safely delimits the two halves of a signature (a printable separator could
// collide: ("a b","c") vs ("a","b c")). Built at runtime so the SOURCE file
// stays plain text (a literal NUL byte would make git treat it as binary).
const SIGNATURE_SEP = String.fromCharCode(0)

/**
 * Stable identity for a permission request: the tool plus its input preview
 * (the same string the card renders). Same tool + same preview ⇒ same action.
 */
export function permissionSignature(toolName: string, inputPreview: string): string {
  return toolName + SIGNATURE_SEP + inputPreview
}

/** The `message` attached to a TTL auto-deny so the model treats it as a
 *  timeout, not a denial, and does not retry the identical call. */
export function timeoutDenyMessage(timeoutMinutes: number): string {
  return (
    `No operator responded within ${timeoutMinutes} minutes, so this request timed out. ` +
    `This is a TIMEOUT, not a denial — the operator is likely away. ` +
    `Do NOT retry this exact action automatically. Tell the user it is still ` +
    `awaiting their approval, then continue with other work or stop.`
  )
}

/** The `message` attached when we short-circuit a duplicate retry of an
 *  already-timed-out request (no new card posted). */
export const duplicateDenyMessage =
  `This exact action already timed out awaiting the operator, and they have not ` +
  `responded since. Do NOT keep re-requesting it — tell the user it needs their ` +
  `approval when they are back, and move on to other work or stop.`

/**
 * True when `sig` timed out within `windowMs` of `now` (so a fresh request for
 * it is a retry to suppress). `timeouts` maps signature → last-timeout epoch ms.
 */
export function isRecentTimeoutDuplicate(
  timeouts: ReadonlyMap<string, number>,
  sig: string,
  now: number,
  windowMs: number,
): boolean {
  const at = timeouts.get(sig)
  return at != null && now - at <= windowMs
}

// ─── Bug 2 — per-tool TTL + timed-out card hygiene + stale-tap honesty ──────

/** Fallback operator approval-card lifetime when nothing is configured. */
export const PERMISSION_TTL_DEFAULT_MS = 60 * 60_000

/**
 * Resolve the operator approval-card lifetime (ms) from the environment.
 * Threaded from config as `channels.telegram.approval_timeout_minutes` →
 * `SWITCHROOM_TG_APPROVAL_TIMEOUT_MS` (see scaffold.ts `channelsToEnv`). A
 * blank/garbage value falls back to the 60-min default; `0` (or negative) is
 * clamped to the default so a card can never be born already-expired.
 */
export function approvalTtlMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.SWITCHROOM_TG_APPROVAL_TIMEOUT_MS
  if (raw === undefined || raw.trim() === '') return PERMISSION_TTL_DEFAULT_MS
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return PERMISSION_TTL_DEFAULT_MS
  return Math.floor(n)
}

/** Default operator approval-card lifetime (config-driven, 60 min default). */
export const PERMISSION_TTL_MS = approvalTtlMs()

/**
 * hostd gated fleet-mutation verbs (rollout / update_apply / agent_* /
 * config_propose_edit) surface an OPERATOR approval card and demand a
 * human-scale decision window. The `mcp__hostd__*` family gets at least
 * 30 min; if the configured approval window is longer, it wins.
 */
export const HOSTD_PERMISSION_TTL_MS = Math.max(30 * 60_000, PERMISSION_TTL_MS)

/** Per-tool approval-card TTL. */
export function ttlForTool(toolName: string | undefined): number {
  return toolName && toolName.startsWith('mcp__hostd__')
    ? HOSTD_PERMISSION_TTL_MS
    : PERMISSION_TTL_MS
}

/** Suffix appended to a card body when its approval window times out. */
export const TIMED_OUT_FOOTER = '\n\n⏱ Timed out — re-request to act'

export interface PermissionCardRef {
  chatId: string
  messageId: number
}

export interface TimedOutCardEdit {
  chatId: string
  messageId: number
  /** New body text (original card body + the timed-out footer). */
  text: string
  /**
   * Always true: the edit MUST drop the inline keyboard (omit reply_markup)
   * so the stale Allow/Deny buttons are no longer tappable — the core of
   * Bug 2 fix #1. A stale tappable Approve dispatches a verdict for an
   * already-resolved request_id, which Claude Code ignores → "operator
   * approved but work never continued".
   */
  stripKeyboard: true
}

/**
 * Build the (pure) list of card edits the reaper applies on TTL auto-deny:
 * re-render each recorded card's original body with the timed-out footer and
 * mark it for keyboard-strip. One entry per card (a permission may have been
 * broadcast to several operator surfaces).
 */
export function buildTimedOutCardEdits(
  cardText: string,
  cards: readonly PermissionCardRef[],
): TimedOutCardEdit[] {
  return cards.map(({ chatId, messageId }) => ({
    chatId,
    messageId,
    text: `${cardText}${TIMED_OUT_FOOTER}`,
    stripKeyboard: true,
  }))
}

/**
 * Suffix appended to a card body when its turn is halted by the operator
 * (#3020 `/stop` / bare "stop" / empty `!`). Same keyboard-strip contract as
 * the timeout path: the halted turn's MCP permission call is being denied,
 * so a later Approve tap must not be able to dispatch into an idle session.
 */
export const CANCELLED_FOOTER = '\n\n⏹ Cancelled — the turn was stopped'

/**
 * Build the (pure) list of card edits the halt path applies when the
 * operator stops the in-flight turn: re-render each recorded card with the
 * cancelled footer and strip the keyboard. Mirrors buildTimedOutCardEdits.
 */
export function buildCancelledCardEdits(
  cardText: string,
  cards: readonly PermissionCardRef[],
): TimedOutCardEdit[] {
  return cards.map(({ chatId, messageId }) => ({
    chatId,
    messageId,
    text: `${cardText}${CANCELLED_FOOTER}`,
    stripKeyboard: true,
  }))
}

/**
 * A tap on a permission card is STALE when no pending entry exists for its
 * request_id — the reaper already auto-denied + deleted it on TTL. A stale
 * tap must NOT dispatch a verdict (the dead id is ignored by Claude Code);
 * the operator instead gets an honest "already resolved" notice.
 */
export function isStaleTap(hasPending: boolean): boolean {
  return !hasPending
}

/** Operator-facing notice shown when a stale (timed-out) card is tapped. */
export const STALE_TAP_NOTICE =
  'This request already resolved (timed out) — ask again to act.'
