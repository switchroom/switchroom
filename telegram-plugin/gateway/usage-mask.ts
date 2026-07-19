/**
 * Adversarial-review F4 — account-label masking policy for the `/usage` card.
 *
 * A group configured with an EMPTY `allowFrom` authorizes every member
 * (`isAuthorizedSender` returns true for any sender in that group). That is an
 * intentional "whole-group" access mode, but it means `/usage` would expose
 * per-account email labels + quota headroom to every member of a broadly
 * shared group. This predicate decides whether to mask account labels for the
 * quota-bearing card, reusing the existing demo-mask machinery:
 *
 *   - private (operator DM) chat  → never mask
 *   - group / supergroup with a NON-empty pinned `allowFrom` → trusted,
 *     operator-curated member list → don't mask
 *   - group / supergroup with an EMPTY `allowFrom` (open membership) → mask
 *   - any other chat type reaching a quota render → mask defensively
 *
 * This changes only what `/usage` REVEALS, not who may run it — general
 * command authorization semantics are untouched.
 */
export function shouldMaskUsageLabels(
  chatType: string | undefined,
  groupAllowFrom: readonly string[] | undefined,
): boolean {
  if (chatType === 'private') return false
  if (chatType === 'group' || chatType === 'supergroup') {
    return (groupAllowFrom ?? []).length === 0
  }
  return true
}
