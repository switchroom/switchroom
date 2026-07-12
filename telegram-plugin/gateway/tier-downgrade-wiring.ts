/**
 * tier-downgrade-wiring.ts — the gateway GLUE for the model-tier downgrade,
 * behind injected deps so the orchestration is unit-testable without importing
 * the whole gateway (mirrors throttle-tier-wiring.ts).
 *
 * The pure decision (`decideTierDowngrade`), the give-up/suppress routing
 * (`planTierDowngrade`), and the user-facing wording (`renderTierDowngradeNotice`)
 * all live in tier-downgrade.ts. This module owns the ORDER-SENSITIVE side
 * effects the gateway performs off those verdicts — and the invariants a review
 * cares about:
 *
 *   - the resume gate is PEEKed (not armed) first, so the fallible carrier write
 *     happens before the single-flight latch is committed;
 *   - the consume-once `.session-model` carrier is written BEFORE the arm; a
 *     throwing write aborts the downgrade and leaves NO armed latch;
 *   - the latch is armed only AFTER a successful carrier write;
 *   - the durable premium-recovery marker write is best-effort (a failure never
 *     aborts the downgrade — the recovery ping simply doesn't arm);
 *   - the broadcast notice is the HONEST resume-on-default text (never a
 *     revert-to-premium promise) and is sent only on a real downgrade;
 *   - a `skip-inflight` resume-gate verdict returns `restart-pending` and emits
 *     NO notice and NO restart (the concurrent turn's armed restart resumes).
 */

import {
  decideTierDowngrade,
  planTierDowngrade,
  type ResumeGateVerdict,
} from '../tier-downgrade.js'

export type TierDowngradeOutcome = 'downgraded' | 'restart-pending' | 'skip'

export interface TierDowngradeRunnerDeps {
  /** Bind-mounted agent state dir, or null when unresolvable (→ skip). */
  getAgentDir: () => string | null
  /** Resolved configured-default token; '' / null → unresolved (never downgrade blind). */
  getConfiguredDefault: () => string | null
  /** Live session `/model` override, or null on the plain configured default. */
  getSessionOverride: () => string | null
  /** Model canonicalizer (the gateway passes resolveMainModel). */
  resolve: (token: string) => string
  /** PEEK the resume gate WITHOUT arming it. */
  peekResumeGate: () => ResumeGateVerdict
  /** Write the consume-once `.session-model` carrier for the default. May throw. */
  writeCarrier: (agentDir: string, toModel: string, configuredDefault: string) => void
  /** Commit the single-flight arm — called ONLY after a successful carrier write. */
  armResumeGate: () => void
  /** Persist the durable premium-recovery marker (best-effort; may throw — caught). */
  writeRecoveryMarker: (agentDir: string, premiumModel: string) => void
  /** Broadcast the honest downgrade notice to the operator chats. */
  broadcastNotice: (markdown: string) => void
  /** Fire the resume self-restart for `agent`. */
  selfRestart: (agent: string) => void
  /** The agent whose session self-restarts (SWITCHROOM_AGENT_NAME ?? triggerAgent). */
  selfAgent: (triggerAgent: string) => string
  /** Structured logger (stderr in prod, captured in test). */
  log: (msg: string) => void
}

/**
 * Run the tier-downgrade glue. Returns:
 *   'downgraded'      — carrier written, latch armed, notice broadcast, restart fired.
 *   'restart-pending' — a resume restart is already armed (concurrent turn); no
 *                       notice, no restart (its restart replays the dead turn).
 *   'skip'            — not applicable / carrier write failed; caller falls
 *                       through to its all-blocked give-up card.
 */
export function runTierDowngrade(
  triggerAgent: string,
  deps: TierDowngradeRunnerDeps,
): TierDowngradeOutcome {
  const agentDir = deps.getAgentDir()
  if (!agentDir) return 'skip'
  const configuredDefault = deps.getConfiguredDefault() ?? ''
  const decision = decideTierDowngrade({
    sessionOverride: deps.getSessionOverride(),
    configuredDefault,
    resolve: deps.resolve,
  })
  // PEEK (no arm): the fallible carrier write must precede the latch commit.
  const gateVerdict = deps.peekResumeGate()
  const plan = planTierDowngrade(decision, gateVerdict, triggerAgent)
  if (plan.kind === 'skip') {
    if (decision.action === 'downgrade') {
      deps.log(`[tier-downgrade] restart suppressed (${gateVerdict}) agent=${triggerAgent}`)
    }
    return 'skip'
  }
  if (plan.kind === 'suppress') {
    deps.log(
      `[tier-downgrade] give-up suppressed — a resume restart is already armed agent=${triggerAgent}`,
    )
    return 'restart-pending'
  }
  // plan.kind === 'downgrade'. Carrier BEFORE arm: a throwing write must not
  // leave an armed latch with no pending restart.
  try {
    deps.writeCarrier(agentDir, plan.toModel, configuredDefault)
  } catch (err) {
    deps.log(
      `[tier-downgrade] failed to write session-model carrier — aborting downgrade: ${(err as Error)?.message ?? err}`,
    )
    return 'skip'
  }
  deps.armResumeGate()
  deps.log(
    `[tier-downgrade] downgrading ${plan.fromModel} → ${plan.toModel} and resuming via self-restart agent=${triggerAgent}`,
  )
  // Durable premium-recovery marker — best-effort (survives the restart; the
  // downgrade is the critical path and must not abort on a marker failure).
  try {
    deps.writeRecoveryMarker(agentDir, plan.fromModel)
  } catch (err) {
    deps.log(
      `[tier-downgrade] premium-recovery marker write failed (non-fatal): ${(err as Error)?.message ?? err}`,
    )
  }
  deps.broadcastNotice(plan.notice)
  deps.selfRestart(deps.selfAgent(triggerAgent))
  return 'downgraded'
}
