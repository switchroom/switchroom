/**
 * throttle-tier-wiring.ts — side-effect runner for the 429 throttle tier.
 *
 * The DECISION and notice text live in ../throttle-tier.ts (pure). This
 * module owns the sequenced side effects, with every dependency injected so
 * the wiring is unit-testable without importing gateway.ts:
 *
 *   1. Broker `mark-throttled` — records `throttled_until` in the quota
 *      ledger (no roll, no eligibility change) and runs the broker-side
 *      escalation guard (3 hits / 10 min → live probe → mark-exhausted when
 *      corroborated). EVERY fire reaches the broker — the notice cooldown
 *      below never suppresses the ledger write, because the escalation
 *      counter is what corroborates a wall hiding behind transient wording.
 *   2. ONE lightweight operator notice — deduped per account BOTH locally
 *      (cooldown window) and FLEET-WIDE via the broker's claim-notification
 *      verb (N agents sharing a throttled account produce one copy per chat,
 *      not N). Claim failures FAIL OPEN (send anyway) per the claim
 *      contract.
 *   3. A delayed retry nudge — after `throttled_until` (+slack +jitter so N
 *      agents don't restart-and-replay simultaneously into the just-cleared
 *      account), replay the turn the 429 killed via the existing resume
 *      lever (triggerSelfRestart → boot-resume). Guards, in order:
 *        - a LIVE turn that started AFTER the throttle was armed supersedes
 *          the dead turn — skip entirely (restarting would kill live work
 *          and boot-resume would replay the WRONG turn);
 *        - a live turn that started BEFORE the arm is the dead turn itself
 *          still holding the in-flight gate — defer the restart to the
 *          turn-complete drain (`pendingRestarts`) instead of SIGTERM-now;
 *        - otherwise consult the SHARED fleet-fallback resume gate
 *          (single-flight across throttle AND fallback resumes + staleness)
 *          and restart on a 'resume' verdict.
 *
 * The escalated outcome (broker corroborated a wall and already rolled)
 * posts its own announcement — gateway-side, per the reactive-path doctrine
 * (`LastFleetRoll` docstring in src/auth/broker/server.ts), which also
 * covers PINNED (non-fleet-active) account rolls — then nudges the resume
 * immediately through the same turn-safety guards.
 *
 * Two entrypoints (#failover-429-corroborate):
 *   - `fire` — the FULL path above, for an ACCOUNT-SCOPED 429 (wording that
 *     names the account's own usage limit). Records `throttled_until`, notices,
 *     nudges, escalates.
 *   - `fireProbeOnly` — for a GENERIC-TRANSIENT 429 (bare `rate_limit_error`
 *     wording that neither names the account nor is proxy-local). Runs ONLY the
 *     broker's rate-bounded escalation probe: a corroborated wall escalates
 *     exactly like `fire`, but a HEALTHY probe is account-inert — no notice, no
 *     nudge, no `throttled_until`, no second card. The gateway's calm
 *     rate-limited card stays the only user-visible output. The two share the
 *     escalation announce/resume via `announceEscalation`.
 */

import {
  evaluateThrottleNotice,
  renderThrottleEscalationNotice,
  renderThrottleNotice,
  THROTTLE_NOTICE_COOLDOWN_MS,
  type ThrottleNoticeState,
} from '../throttle-tier.js'

/** Slack past throttled_until before the retry nudge fires. */
export const THROTTLE_RETRY_NUDGE_SLACK_MS = 5_000

/** Max random jitter added to the nudge so agents sharing the throttled
 *  account stagger their restart-and-replay instead of stampeding the
 *  just-cleared account. */
export const THROTTLE_RETRY_NUDGE_JITTER_MAX_MS = 30_000

/** The narrow broker surface the runner needs (structurally satisfied by
 *  the gateway's AuthBrokerClient). */
export interface ThrottleBrokerClient {
  markThrottled(until: number, probeOnly?: boolean): Promise<{
    account: string
    throttled_until: number
    escalated: boolean
    rolledTo?: string | null
  }>
  claimNotification(key: string, windowMs: number): Promise<{ granted: boolean }>
}

export interface ThrottleTierRunnerDeps {
  /** This gateway's own agent (SWITCHROOM_AGENT_NAME). */
  agentName: string
  getBrokerClient(): Promise<ThrottleBrokerClient | null>
  /** Chats the notice broadcasts to (access.allowFrom, resolved per call). */
  listNoticeChats(): Array<string | number>
  /** Fire-and-forget rich send (gateway wraps swallowingApiCall). */
  sendNotice(chatId: string | number, markdown: string): void
  /** THE shared fleet-fallback resume gate (single-flight + staleness). */
  resumeDecide(failedTurnStartedAtMs: number | null): 'resume' | 'skip-inflight' | 'skip-stale'
  newestActiveTurnStartedAtMs(): number | null
  /** True while a turn is in flight (gateway turnInFlightForGate()). */
  turnInFlight(): boolean
  /** Defer the restart to the turn-complete drain (pendingRestarts). */
  deferRestartToTurnComplete(agentName: string, reason: string): void
  /** Restart now (gateway triggerSelfRestart). */
  restartNow(agentName: string, reason: string): void
  log(msg: string): void
  now?: () => number
  /** Timer seam (tests drive synchronously). Default setTimeout+unref. */
  schedule?: (fn: () => void, ms: number) => { cancel(): void }
  /** Jitter source (tests pin it). Default uniform 0..JITTER_MAX. */
  jitterMs?: () => number
}

export interface ThrottleTierRunner {
  /**
   * Run the FULL throttle path for one terminal account-scoped 429: record
   * `throttled_until`, post one deduped notice, arm the retry nudge, and
   * escalate to failover when the first-hit probe corroborates a wall.
   * Fire-and-forget from the caller's perspective — never throws.
   */
  fire(triggerAgent: string, throttledUntilMs: number, resetParsed: boolean): Promise<void>
  /**
   * PROBE-ONLY path for a generic-transient 429 (#failover-429-corroborate).
   * Runs ONLY the broker's rate-bounded escalation probe: a corroborated wall
   * escalates (announce + resume nudge) exactly like `fire`; a HEALTHY probe is
   * account-inert — NO notice, NO nudge, NO `throttled_until` soft-defer, NO
   * second card. The calm rate-limited card the gateway already emitted stays
   * the only user-visible output. Fire-and-forget; never throws.
   */
  fireProbeOnly(triggerAgent: string): Promise<void>
  /** Test/debug view of internal state. */
  inspect(): { noticeState: ThrottleNoticeState; nudgePending: boolean }
}

export function createThrottleTierRunner(deps: ThrottleTierRunnerDeps): ThrottleTierRunner {
  const now = deps.now ?? (() => Date.now())
  const schedule =
    deps.schedule ??
    ((fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms)
      if (typeof t.unref === 'function') t.unref()
      return { cancel: () => clearTimeout(t) }
    })
  const jitterMs =
    deps.jitterMs ?? (() => Math.floor(Math.random() * THROTTLE_RETRY_NUDGE_JITTER_MAX_MS))

  let noticeState: ThrottleNoticeState = { lastSentAtMsByAccount: {} }
  /** The LATEST throttle owns the nudge — a newer hit replaces an armed
   *  timer instead of stacking restarts. */
  let pendingNudge: { cancel(): void } | null = null

  /**
   * Post `markdown` to every authorized chat, fleet-deduped per chat via the
   * broker claim verb when a client + account are available. Fail-open: a
   * claim error or missing broker never drops the notice.
   */
  async function broadcastDeduped(
    client: ThrottleBrokerClient | null,
    keyPrefix: string,
    account: string | null,
    markdown: string,
  ): Promise<void> {
    for (const chatId of deps.listNoticeChats()) {
      let granted = true
      if (client && account) {
        try {
          granted = (
            await client.claimNotification(
              `${keyPrefix}:${account}:${chatId}`,
              THROTTLE_NOTICE_COOLDOWN_MS,
            )
          ).granted
        } catch {
          granted = true // fail open — a duplicated notice beats a dropped one
        }
      }
      if (granted) {
        deps.sendNotice(chatId, markdown)
      } else {
        deps.log(`[throttle-tier] notice suppressed (fleet claim) chat=${chatId}`)
      }
    }
  }

  /**
   * Replay the dead turn via restart, with the turn-safety guards (see
   * module docstring). `armedAtMs` anchors the "newer turn supersedes"
   * check: a turn that started after the throttle was armed is live user
   * work, never to be killed for a replay.
   */
  function nudgeResume(reason: string, armedAtMs: number): void {
    const newest = deps.newestActiveTurnStartedAtMs()
    if (deps.turnInFlight()) {
      if (newest != null && newest > armedAtMs) {
        deps.log(
          `[throttle-tier] resume skipped (superseded by a live newer turn) reason=${reason}`,
        )
        return
      }
      // The in-flight gate is held by the dead throttled turn itself —
      // defer to the turn-complete drain instead of SIGTERM-ing now.
      deps.log(`[throttle-tier] resume deferred to turn-complete reason=${reason}`)
      deps.deferRestartToTurnComplete(deps.agentName, reason)
      return
    }
    const verdict = deps.resumeDecide(newest)
    if (verdict === 'resume') {
      deps.log(`[throttle-tier] resuming dead turn via self-restart reason=${reason}`)
      deps.restartNow(deps.agentName, reason)
    } else {
      deps.log(`[throttle-tier] resume suppressed (${verdict}) reason=${reason}`)
    }
  }

  /**
   * The escalated outcome, shared by `fire` and `fireProbeOnly`: the broker
   * corroborated a genuine wall via a live probe and already ran mark-exhausted
   * + roll (fleet active AND pinned accounts alike). The RAISING gateway
   * announces — reactive-path doctrine — fleet-deduped so N gateways sharing
   * the account produce one copy per chat, then nudges the resume.
   */
  async function announceEscalation(
    client: ThrottleBrokerClient | null,
    account: string | null,
    rolledTo: string | null,
    triggerAgent: string,
    armedAtMs: number,
  ): Promise<void> {
    deps.log(
      `[throttle-tier] escalated to wall account=${account ?? '?'} ` +
        `rolledTo=${rolledTo ?? 'none (all blocked)'}`,
    )
    await broadcastDeduped(
      client,
      'throttle-escalation',
      account,
      renderThrottleEscalationNotice({ account, agent: triggerAgent, rolledTo }),
    )
    if (rolledTo) nudgeResume('throttle-escalation-resume', armedAtMs)
  }

  async function fire(
    triggerAgent: string,
    throttledUntilMs: number,
    resetParsed: boolean,
  ): Promise<void> {
    const armedAtMs = now()
    let client: ThrottleBrokerClient | null = null
    let account: string | null = null
    let escalated = false
    let rolledTo: string | null = null
    try {
      client = await deps.getBrokerClient()
      if (client) {
        const r = await client.markThrottled(throttledUntilMs)
        account = r.account
        escalated = r.escalated
        rolledTo = r.rolledTo ?? null
      } else {
        deps.log(
          `[throttle-tier] broker unreachable — notice only, no ledger record agent=${triggerAgent}`,
        )
      }
    } catch (err) {
      deps.log(
        `[throttle-tier] markThrottled failed agent=${triggerAgent}: ${(err as Error)?.message ?? err}`,
      )
    }

    if (escalated) {
      await announceEscalation(client, account, rolledTo, triggerAgent, armedAtMs)
      return
    }

    // ONE lightweight notice, deduped per account: locally by cooldown, then
    // fleet-wide by broker claim. Unknown account (broker down) keys the
    // local cooldown on the agent so the degraded path still can't spam.
    const cooldownKey = account ?? `agent:${triggerAgent}`
    const verdict = evaluateThrottleNotice(noticeState, cooldownKey, now())
    if (verdict.send) {
      noticeState = verdict.next
      await broadcastDeduped(
        client,
        'throttle-notice',
        account,
        renderThrottleNotice({
          account,
          agent: triggerAgent,
          throttledUntilMs,
          resetParsed,
          now: new Date(now()),
        }),
      )
    } else {
      deps.log(`[throttle-tier] notice suppressed (cooldown) key=${cooldownKey}`)
    }

    // Arm (or re-arm) the retry nudge: slack past the reset + jitter so
    // agents sharing the account stagger their replays.
    const delayMs =
      Math.max(throttledUntilMs - now(), 0) + THROTTLE_RETRY_NUDGE_SLACK_MS + jitterMs()
    if (pendingNudge) pendingNudge.cancel()
    pendingNudge = schedule(() => {
      pendingNudge = null
      nudgeResume('throttle-retry-resume', armedAtMs)
    }, delayMs)
  }

  async function fireProbeOnly(triggerAgent: string): Promise<void> {
    const armedAtMs = now()
    let client: ThrottleBrokerClient | null = null
    let account: string | null = null
    let escalated = false
    let rolledTo: string | null = null
    try {
      client = await deps.getBrokerClient()
      if (client) {
        // `until` is ignored by the broker in probeOnly mode (nothing is
        // recorded) but the protocol requires a positive int — pass a nominal.
        const r = await client.markThrottled(now() + 1, true)
        account = r.account
        escalated = r.escalated
        rolledTo = r.rolledTo ?? null
      } else {
        deps.log(
          `[throttle-tier] broker unreachable — probe-only skipped agent=${triggerAgent}`,
        )
      }
    } catch (err) {
      deps.log(
        `[throttle-tier] probe-only markThrottled failed agent=${triggerAgent}: ${(err as Error)?.message ?? err}`,
      )
    }

    if (escalated) {
      await announceEscalation(client, account, rolledTo, triggerAgent, armedAtMs)
      return
    }

    // HEALTHY / rate-bounded / broker-down: account-inert. NOTHING else — no
    // notice, no retry nudge, no throttled_until soft-defer. The calm
    // rate-limited card the gateway already emitted is the only user-visible
    // output, exactly as before the escalation probe was wired.
    deps.log(`[throttle-tier] generic-transient probe-only inert (no wall) agent=${triggerAgent}`)
  }

  return {
    fire,
    fireProbeOnly,
    inspect: () => ({ noticeState, nudgePending: pendingNudge != null }),
  }
}
