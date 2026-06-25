/**
 * Per-foreground-turn EMISSION-AUTHORITY façade (kill-switched no-op seam).
 *
 * This is the SEAM the message-emission-determinism refactor (PR-4 series,
 * `docs/message-emission-determinism.md` §9 "deeper architectural move") routes
 * the foreground-lane card/ping emission call sites through. It mirrors the
 * one-concern-per-file precedent of `feed-open-gate.ts`: a single place that
 * will eventually OWN the WHEN of foreground emission. The gateway constructs
 * exactly ONE instance per foreground turn, alongside the `CurrentTurn` object,
 * and passes the chat/thread key in EXPLICITLY (even though today it is sourced
 * from the `currentTurn` singleton) — that explicit key is the seam PR-4e uses
 * to swap the singleton for a per-topic map. The façade must NOT persist across
 * turns: it is per-turn only, because cross-turn persistence would pre-empt the
 * per-chat scoping decision PR-4e owns.
 *
 * ## PR-4a is a behaviourally-IDENTICAL no-op
 *
 * In PR-4a NO decision logic moves in. Every method is a THIN DELEGATE: it
 * invokes the same statements the call site ran before, via an `apply` thunk
 * the caller hands in (so the load-bearing literals — `drainActivitySummary`,
 * `clearActivitySummary`, `decideOverPing`, the `finalAnswerEverDelivered`
 * latch-set — stay AT THE CALL SITE and remain visible to the source-read
 * wiring oracles). Framing (A) "construct-but-bypass": each method body branches
 * on the kill-switch, and in PR-4a BOTH branches execute the SAME delegate, so
 * the seam is a provable no-op even when the flag is ON. The flag's real teeth
 * (moving `mayOpenActivityCard` / `decideOverPing` decisions INTO the façade)
 * start in PR-4b — NOT here.
 *
 * ## PR-4d deadlock invariant (ship as a standing doc-comment)
 *
 * `mayDrain` is a PURE READ; it must NOT acquire `chatLock`. PR-4d acquires
 * `chatLock` strictly INSIDE the deliver-before-drain gate decision (gateway.ts
 * component-1, ref ~`:2730`), never the reverse, because a synthetic represent
 * turn starts `finalAnswerDelivered=false` and would wedge the gate (ref
 * ~`:1646`) if a card OPEN held the lock across the gate's release. Keep
 * `mayDrain` lock-free so PR-4d has a clean read to build on.
 */

import {
  computeFeedOpenVerdict,
  type FeedOpenGateView,
  type FeedOpenGateDeps,
} from './feed-open-gate.js'

/**
 * Kill-switch. Read ONCE at module top, `=== '1'` (default OFF), following the
 * existing flag convention (`SWITCHROOM_FEED_HEARTBEAT` etc. in gateway.ts's
 * flag region). In PR-4a this gates nothing behaviourally — both branches of
 * every façade method run the same delegate — so unset and set are identical.
 * It exists now so the seam is in place; PR-4b is where ON starts to differ.
 */
export const EMISSION_AUTHORITY_ENABLED =
  process.env.SWITCHROOM_EMISSION_AUTHORITY === '1'

/** Which producer triggered a card OPEN/EDIT — carried for the PR-4b seam. */
export type EmissionProducer = 'narrative' | 'tool' | 'liveness'

/**
 * The minimal per-turn surface the façade needs. A structural subset of
 * `CurrentTurn` — keeps this module decoupled from gateway.ts's giant turn type
 * (and out of an import cycle) while still typing the reads it performs.
 */
export interface EmissionTurnView {
  /** Single-flight slot: a drain Promise is in flight when non-null. */
  activityInFlight: Promise<void> | null
}

/** Inputs to the over-ping claim/downgrade decision (carried for PR-4b). */
export interface PingClaimInput {
  /** The model asked for a device ping (`disable_notification: false`). */
  modelRequestedPing: boolean
  /** This reply is a substantive final answer (`isSubstantiveFinalReply`). */
  substantive: boolean
}

/**
 * Per-foreground-turn emission-authority façade.
 *
 * Constructed once per turn with the chat/thread key passed in explicitly (the
 * PR-4e seam). In PR-4a every method just runs the caller's delegate — no
 * decision logic lives here yet.
 */
export class EmissionAuthority {
  /**
   * @param chatKey  The chat/thread key this façade governs, passed in
   *   EXPLICITLY by the gateway (today sourced from the `currentTurn`
   *   singleton). PR-4e swaps the singleton for a per-topic map keyed on this.
   *   Unused in PR-4a beyond being held — it is the seam, not yet a decision
   *   input.
   */
  constructor(private readonly chatKey: string) {}

  /**
   * PR-4b OPEN-gate wiring. The gateway centralizes it in `emissionAuthorityFor`
   * (one place) so the 6 `openOrEditCard` call sites stay byte-identical
   * `(producer, apply)` — the façade reads the live turn view + injected history
   * deps from HERE, not per-call. `viewProvider` is a thunk so the verdict reads
   * the CURRENT card/latch/tool-count at gate time (they mutate during the turn).
   * Lazily set on every `emissionAuthorityFor`; the disabled branch never reads
   * it, so a turn that never wires it is harmless (only `openOrEditCard`'s
   * EMISSION_AUTHORITY_ENABLED branch consults it).
   */
  private feedOpenView?: () => FeedOpenGateView
  private feedOpenDeps?: FeedOpenGateDeps

  /**
   * Wire the PR-4b OPEN-gate inputs (idempotent). Called by the gateway's
   * `emissionAuthorityFor` accessor so every routed turn's façade can compute
   * the open verdict in its enabled branch. No-op-equivalent under the flag OFF.
   */
  wireFeedOpenGate(
    viewProvider: () => FeedOpenGateView,
    deps: FeedOpenGateDeps,
  ): void {
    this.feedOpenView = viewProvider
    this.feedOpenDeps = deps
  }

  /** The chat/thread key this façade was constructed for (PR-4e seam read). */
  get key(): string {
    return this.chatKey
  }

  /**
   * Card OPEN-or-EDIT for the foreground turn (delegates to
   * `drainActivitySummary` at the call site via `apply`).
   *
   * PR-4b — the OPEN-gate decision RELOCATES here, behind the kill-switch:
   *
   *  - **Disabled branch (default):** unchanged from PR-4a — `apply()` runs
   *    unconditionally. The drain's own inline OPEN gate is what refuses (and
   *    `break`s) a disallowed OPEN, exactly as on main. Byte-identical to main.
   *  - **Enabled branch:** compute the OPEN verdict from the live turn view +
   *    injected history deps (`computeFeedOpenVerdict`) and run `apply()` IFF
   *    `!(isOpen && !mayOpen)` is FALSE-y in the refuse sense — concretely
   *    `apply()` runs iff `isOpen || mayOpen`. That is EXACTLY the set of cases
   *    main did NOT `break` (main refuses iff `activityMessageId == null &&
   *    !mayOpenActivityCard(...)`, i.e. `!isOpen && !mayOpen`). Same pure inputs
   *    ⇒ same verdict, so flag-ON ≡ flag-OFF ≡ main: no emitted message differs.
   *
   * On flag-ON the drain still re-evaluates the SAME gate (now redundant) — an
   * intentional, safe double-check: both are pure over identical inputs, and it
   * also covers the documented in-flight-send race (a send already PAST the
   * drain's check). A refused OPEN never calls `apply()`, so `activityInFlight`
   * stays null and the pending render stays unadvanced — matching main's `break`
   * + `finally` end-state. The delegate keeps the `turn.activityInFlight =
   * drainActivitySummary(turn, <producer>)` assignment AT THE CALL SITE so the
   * source-read wiring oracles still see it.
   */
  openOrEditCard(
    producer: EmissionProducer,
    apply: () => void,
  ): void {
    if (EMISSION_AUTHORITY_ENABLED) {
      // The OPEN-gate inputs are wired by `emissionAuthorityFor` (centralized).
      // If a turn somehow reaches here unwired, fall back to delegating (no
      // behaviour change — the drain's own gate still governs the OPEN).
      if (this.feedOpenView != null && this.feedOpenDeps != null) {
        const { isOpen, mayOpen } = computeFeedOpenVerdict(
          this.feedOpenView(),
          producer,
          this.feedOpenDeps,
        )
        // Refuse (skip apply) iff main would have `break`-refused the OPEN:
        // `!isOpen && !mayOpen`. Apply otherwise (an EDIT — isOpen — is never
        // gated; an OPEN-eligible producer — mayOpen — opens).
        if (!isOpen && !mayOpen) return
      }
      apply()
      return
    }
    apply()
  }

  /**
   * Finalize the card before a substantive reply send (delegates to
   * `clearActivitySummary` at the call site via `apply`).
   *
   * PR-4a: a pure pass-through. Both branches run `apply`.
   */
  finalizeCard(apply: () => void): void {
    if (EMISSION_AUTHORITY_ENABLED) {
      apply()
      return
    }
    apply()
  }

  /**
   * Mark that a substantive final answer was delivered this turn — the sticky
   * lever-1 latch (delegates to the `finalAnswerEverDelivered = true` set at the
   * call site via `apply`).
   *
   * PR-4a: a pure pass-through. Both branches run `apply`.
   */
  markSubstantiveFinalDelivered(apply: () => void): void {
    if (EMISSION_AUTHORITY_ENABLED) {
      apply()
      return
    }
    apply()
  }

  /**
   * Claim-or-downgrade the turn's one notification ping (wraps the existing
   * `decideOverPing` block via `apply`).
   *
   * PR-4a: a pure pass-through. The `_input` is carried for the PR-4b seam but
   * consulted nowhere yet; both branches run `apply`, which executes the
   * existing over-ping block verbatim (the `decideOverPing` call, the stderr
   * log, the metric emit, the `firstPingAt` / `firstPingWasSubstantive`
   * mutations, and the `disableNotification` / `wasOverPingSuppressed`
   * assignments the call site consumes). Nothing about the decision moves here.
   */
  claimOrDowngradePing(_input: PingClaimInput, apply: () => void): void {
    if (EMISSION_AUTHORITY_ENABLED) {
      apply()
      return
    }
    apply()
  }

  /**
   * Single-flight read: may a drain start? Returns `turn.activityInFlight ==
   * null` — the EXACT guard every drain call site already performs.
   *
   * PURE READ, NO lock acquisition (see the PR-4d deadlock invariant in this
   * module's header). PR-4d needs this read clean so it can acquire `chatLock`
   * elsewhere without the lattice inverting.
   */
  mayDrain(turn: EmissionTurnView): boolean {
    return turn.activityInFlight == null
  }
}
