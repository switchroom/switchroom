/**
 * tier-downgrade.ts — MODEL-TIER downgrade failover (second recovery tier).
 *
 * The problem this owns:
 *   A user selects a premium model (e.g. `/model fable`). Mid-turn that model
 *   is overloaded / throttled fleet-wide (HTTP 529 / 429 / overloaded_error /
 *   503). The FIRST recovery tier — account-level failover (swap the OAuth
 *   account, same model) — is tried first and already exists
 *   (`runFleetAutoFallback` → `doFireFleetAutoFallback`). When that comes back
 *   `all-blocked` (no account still serves the premium model), the live turn
 *   would otherwise stall silently. This module adds a SECOND, lower-priority
 *   tier: DOWNGRADE the session to the agent's configured default model (the
 *   fleet default is `opus`) and resume, so the turn keeps moving.
 *
 * Precedence (HARD): account-swap FIRST. The gateway only consults this module
 * inside the `all-blocked` branch of `doFireFleetAutoFallback` — i.e. AFTER
 * account-swap has been tried and found no eligible account. A `switched`
 * outcome never reaches here (the existing resume-after-swap path handles it),
 * so a premium model that is merely throttled on ONE account is recovered by
 * account-swap, never by a downgrade.
 *
 * There is NO automatic return to the premium model. The `/model` override is
 * SESSION-SCOPED: rev 5 (reference/rfcs/session-model-stickiness.md §0.05) makes
 * every switch a consume-once `.session-model` carrier relaunch, so the override
 * dies on the downgrade SIGTERM (the carrier was consumed on its own apply-boot).
 * The downgrade writes a consume-once `.session-model`
 * carrier for the CONFIGURED DEFAULT: start.sh applies+deletes it on the resume
 * boot, and every subsequent restart boots the configured default too. The
 * premium model is never restored on its own — the user must re-issue
 * `/model <premium>` once it frees up. The user-facing notice
 * (`renderTierDowngradeNotice`) says exactly that; it must NOT promise any
 * revert to the premium tier.
 *
 * Effort is NATIVE. A live `/effort` override records in gateway memory only
 * (no carrier), so the self-restart sheds it and the downgraded default boots at
 * the configured `thinking_effort` (the fleet `low` pin, #1978 /
 * src/config/thinking-effort-risk.ts). This module writes NO effort carrier —
 * that is the whole point: the downgraded opus must resolve LOW.
 *
 * Loop guard — the natural on-default guard is the real bound. After the
 * downgrade boot the session runs the configured default (the override is gone
 * with the restart), so a second `all-blocked` finds no premium tier and
 * `decide()` returns `skip` ('on-default') — the turn never re-downgrades. If
 * the DEFAULT is itself walled fleet-wide on the resume boot, `decide()` still
 * returns `skip` and the gateway falls through to its normal all-blocked card;
 * there is no restart loop. Cross-restart pacing is additionally bounded by the
 * broker-side persisted account exhaustion (see fleet-fallback-resume.ts).
 *
 * Concurrent-turn race (single process, pre-restart): if a first turn already
 * armed a resume restart (a downgrade OR an account-swap), a second turn that
 * also hits `all-blocked` must NOT emit a give-up card — the armed restart will
 * replay the latest interrupted turn. `planTierDowngrade` maps a `skip-inflight`
 * resume-gate verdict to `suppress` for exactly this reason (no re-downgrade, no
 * contradictory "could not be recovered" message).
 *
 * This module is pure (`decideTierDowngrade` / `planTierDowngrade` /
 * `renderTierDowngradeNotice`) so the decision, the give-up suppression, and the
 * user-facing wording are all unit-testable without a process restart; the
 * gateway does the FS write, the latch arm, and the restart off these verdicts.
 */

export type TierDowngradeDecision =
  | {
      /** Fire the downgrade: write a consume-once carrier for `toModel` and
       *  self-restart to resume the dead turn on the configured default. */
      action: 'downgrade'
      toModel: string
      fromModel: string
    }
  | {
      /** No downgrade is warranted. `on-default`: the session is already on the
       *  configured default (nothing lower to fall to). `unresolved`: the
       *  configured default could not be read (never downgrade blind). */
      action: 'skip'
      reason: 'on-default' | 'unresolved'
    }

export interface TierDowngradeInput {
  /** The live session model override (`sessionModelSource.getOverride()`), or
   *  null when the session is running the plain configured default. Null is the
   *  common "on default" signal (boot seeding leaves it null when the launched
   *  model equals the configured default). */
  sessionOverride: string | null
  /** The resolved configured default model token (from
   *  `.configured-default-model` / `resolveMainModel`). Empty/undefined => the
   *  boot record was unreadable and we must not downgrade blind. */
  configuredDefault: string | null | undefined
  /** Canonicalizer so `sessionOverride` and `configuredDefault` compare in the
   *  same dialect (the gateway passes `resolveMainModel`). Keeps `opus` from
   *  spuriously reading as a premium tier over a `claude-opus-*`-shaped default
   *  and vice versa, as far as the resolver can. */
  resolve: (token: string) => string
}

/**
 * Decide whether — and to what — the walled premium session should downgrade.
 * PURE: no FS, no clock, no restart. The gateway does the I/O and the restart
 * off this verdict.
 */
export function decideTierDowngrade(input: TierDowngradeInput): TierDowngradeDecision {
  const configured =
    typeof input.configuredDefault === 'string' ? input.configuredDefault.trim() : ''
  if (configured.length === 0) {
    // No configured-default record — never downgrade to an unknown model.
    return { action: 'skip', reason: 'unresolved' }
  }

  const override = input.sessionOverride
  if (override == null || override.length === 0) {
    // On the configured default already — no lower tier to fall to. This is also
    // the natural loop bound: after the downgrade boot the override is gone, so a
    // re-entry lands here and never re-downgrades.
    return { action: 'skip', reason: 'on-default' }
  }

  // Canonicalize both sides so an alias vs resolved-id spelling of the SAME
  // model reads as "on default", never as a premium tier (which would loop).
  if (input.resolve(override) === input.resolve(configured)) {
    return { action: 'skip', reason: 'on-default' }
  }

  // A premium model is active AND walled fleet-wide → downgrade to the default.
  return { action: 'downgrade', toModel: configured, fromModel: override }
}

/**
 * The user-facing broadcast for a fired downgrade. PURE + deterministic so the
 * wording is pinned by a test.
 *
 * HONESTY CONTRACT (do not regress): it states the turn resumes on the DEFAULT
 * and that the user must RE-ISSUE `/model <premium>` to get the premium tier
 * back. It must NOT claim any automatic revert to the premium model — there is
 * none (the override is session-scoped and dies on the downgrade restart).
 */
export function renderTierDowngradeNotice(
  fromModel: string,
  toModel: string,
  agent: string,
): string {
  return (
    `⤵️ **Downgrading model to keep going** on agent **${agent}**\n` +
    `\`${fromModel}\` is overloaded across every account right now, so this turn is ` +
    `resuming on the default \`${toModel}\` to keep working. ` +
    `Re-issue \`/model ${fromModel}\` once it frees up — it won't switch back on its own.`
  )
}

/** The resume-gate verdict the gateway feeds `planTierDowngrade` (mirrors
 *  `ResumeDecision` from fleet-fallback-resume.ts, peeked WITHOUT arming). */
export type ResumeGateVerdict = 'resume' | 'skip-inflight' | 'skip-stale'

export type TierDowngradePlan =
  | {
      /** Fire the downgrade: write the carrier, arm the latch, broadcast
       *  `notice`, and self-restart. */
      kind: 'downgrade'
      toModel: string
      fromModel: string
      notice: string
    }
  | {
      /** A resume restart is ALREADY armed in this process (a concurrent turn's
       *  downgrade or account-swap) — emit NO give-up card; the armed restart
       *  replays the interrupted turn. */
      kind: 'suppress'
    }
  | {
      /** No downgrade; caller falls through to its normal all-blocked card. */
      kind: 'skip'
    }

/**
 * Pure orchestration off the (pure) decision + the resume-gate verdict. Keeps
 * the concurrent-turn suppression (LOW-9a) and the give-up/fall-through routing
 * testable without a live gateway.
 *
 *   - decision `skip`               → `skip` (fall through to the all-blocked card)
 *   - decision `downgrade`, gate `skip-inflight`
 *                                   → `suppress` (a restart is already armed)
 *   - decision `downgrade`, gate `skip-stale`
 *                                   → `skip` (turn too old to resume; give up)
 *   - decision `downgrade`, gate `resume`
 *                                   → `downgrade` (carry the honest notice)
 */
export function planTierDowngrade(
  decision: TierDowngradeDecision,
  gateVerdict: ResumeGateVerdict,
  agent: string,
): TierDowngradePlan {
  if (decision.action !== 'downgrade') return { kind: 'skip' }
  if (gateVerdict === 'skip-inflight') return { kind: 'suppress' }
  if (gateVerdict === 'skip-stale') return { kind: 'skip' }
  return {
    kind: 'downgrade',
    toModel: decision.toModel,
    fromModel: decision.fromModel,
    notice: renderTierDowngradeNotice(decision.fromModel, decision.toModel, agent),
  }
}
