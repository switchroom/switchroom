/**
 * premium-recovery.ts — "your premium model is servable again" ping (pure layer).
 *
 * Companion to tier-downgrade.ts. When a premium `/model` selection (e.g.
 * `/model fable`) is walled fleet-wide, the tier-downgrade tier resumes the
 * turn on the configured default and tells the user to re-issue `/model fable`
 * once it frees up (there is NO automatic revert — the override is session-
 * scoped and dies on the downgrade restart). This module closes that loop with
 * a HEADS-UP: the moment the premium tier can be served again, ping the chat
 * ONCE with a one-tap "switch back" button.
 *
 * DETERMINISTIC recovery signal (P0 deterministic-controls — never model-
 * decided). The signal is the auth-broker's own per-account eligibility, read
 * off `list-state` (the SAME state the gateway's `runQuotaWatch` tick already
 * polls every 15 min — no new poller, no broker change):
 *   - `account.exhausted`      — live-authoritative `isAccountExhausted` verdict
 *     (5h/7d wall or an unexpired `exhausted_until` mark).
 *   - `account.premium_walled` — live-authoritative `isAccountPremiumWalled`
 *     verdict; `isModelTierWalled` is a pure timestamp compare
 *     (`premium_walled_until > now`) unless a fresher canary read the flagship
 *     tier `allowed`. (src/auth/broker/model-tier-quota.ts / account-eligibility.ts.)
 * The tier-downgrade fires from the account-swap `all-blocked` verdict — i.e.
 * EVERY account was exhausted or premium-walled. Recovery is the exact
 * complement: at least ONE account is neither. No clock of our own, no model
 * judgement — the broker already decided; we read its decision.
 *
 * AT-MOST-ONCE. The gateway holds a consume-once `.premium-recovery` marker
 * (session-model-file.ts) recording the dropped premium token + the chats to
 * notify. `decidePremiumRecovery` is a pure predicate; the gateway clears the
 * marker BEFORE sending (never-storm) and additionally takes a fleet-wide
 * `claim-notification` so a bounce or a second gateway tick can't double-fire.
 * The marker is also cleared the instant the user manually re-issues
 * `/model <premium>` (no stale ping).
 *
 * PURE — no I/O, no clock. The gateway does the list-state read, the marker
 * FS, the claim, and the send off these verdicts.
 */

/** The minimal per-account eligibility view the recovery predicate needs —
 *  both fields are the broker's live-authoritative verdicts from `list-state`. */
export interface AccountRecoveryView {
  /** `isAccountExhausted` — a 5h/7d wall or an unexpired `exhausted_until` mark. */
  exhausted: boolean
  /** `isAccountPremiumWalled` — the flagship (`7d_oi`) tier wall verdict. */
  premiumWalled: boolean
}

export interface PremiumRecoveryDecision {
  /** Fire exactly one ping now (a marker is pending AND the premium tier is
   *  servable again). The gateway clears the marker + claims before sending. */
  fire: boolean
  /** Why not, for the log (never surfaced to the user). */
  reason: 'no-marker' | 'still-walled' | 'recovered'
}

/**
 * Decide whether the premium tier has recovered for a pending downgrade.
 * PURE. Fires iff a marker is pending AND at least one account can serve the
 * premium tier again (neither exhausted nor premium-walled) — the exact
 * complement of the `all-blocked` condition that fired the downgrade.
 */
export function decidePremiumRecovery(opts: {
  hasMarker: boolean
  accounts: ReadonlyArray<AccountRecoveryView>
}): PremiumRecoveryDecision {
  if (!opts.hasMarker) return { fire: false, reason: 'no-marker' }
  const servable = opts.accounts.some((a) => !a.exhausted && !a.premiumWalled)
  return servable
    ? { fire: true, reason: 'recovered' }
    : { fire: false, reason: 'still-walled' }
}

export interface PremiumRecoveryPing {
  /** Telegram-formatted (rich-markdown) body. */
  text: string
  /** Inline-keyboard button label. */
  buttonText: string
}

/**
 * The user-facing recovery ping. PURE + deterministic so the wording + button
 * are pinned by a test. Honest: the switch it offers is SESSION-SCOPED (the
 * same `/model` semantics as everywhere else — it reverts on the next restart),
 * so it never promises a durable pin.
 */
export function renderPremiumRecoveryPing(premiumModel: string): PremiumRecoveryPing {
  return {
    text:
      `✅ \`${premiumModel}\` is available again — tap to switch back to it for this session.`,
    buttonText: `Switch to ${premiumModel}`,
  }
}

/**
 * The fleet-wide `claim-notification` key for a premium-recovery ping. Keyed on
 * agent + the specific premium token so two different dropped models never
 * dedup each other, and a bounce mid-window can't re-send the same one.
 */
export function premiumRecoveryClaimKey(agent: string, premiumModel: string): string {
  return `premium-recovery:${agent}:${premiumModel}`
}
