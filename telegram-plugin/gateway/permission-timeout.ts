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
