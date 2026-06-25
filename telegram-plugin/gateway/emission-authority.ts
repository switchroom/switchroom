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
 *
 * ## PR-4d ships: `mayDrainCardNow` unifies the card-drain path with the #2137
 * deliver-before-drain gate
 *
 * PR-4d adds `mayDrainCardNow` — the card-path counterpart of the deliver-before-
 * drain decision in `serialize-drain-gate.ts`. It is ALSO a pure, lock-free read:
 *
 *  - Flag OFF (default): returns exactly the `mayDrain` single-flight read —
 *    byte-equivalent to base. The card single-flight gate is unchanged.
 *  - Flag ON: returns the `mayDrain` read AND-ed with `mayDrainBufferedInbound`,
 *    importing the PURE `mayDrainBufferedInbound` from `./serialize-drain-gate.js`
 *    (the façade imports the pure helper, NEVER the gateway). The card path
 *    threads `endingTurnFinalAnswerDelivered: null` so the deliver-before-drain
 *    predicate degenerates to `!turnInFlight`: the card single-flight is governed
 *    by `activityInFlight` (via `mayDrain`), NOT by an ending turn's delivery
 *    state. A synthetic represent turn (finalAnswerDelivered=false) therefore can
 *    never wedge the live foreground card path.
 *
 * The LOCK is acquired by the GATEWAY around the gate decision (a centralized
 * `chatLock.run(statusKey(...), …)` helper that consults this method then kicks
 * off `openOrEditCard`). `mayDrainCardNow` itself, like `mayDrain`, acquires NO
 * lock — it is a pure read the gateway calls from inside the lock. The lock spans
 * only the gate decision + the synchronous `openOrEditCard` kick-off (which only
 * ASSIGNS `turn.activityInFlight = drainActivitySummary(...)`; the async send is
 * NOT awaited inside the lock), so a card OPEN never holds `chatLock` across the
 * gate's release.
 */

import {
  computeFeedOpenVerdict,
  type FeedOpenGateView,
  type FeedOpenGateDeps,
} from './feed-open-gate.js'
import {
  decideOverPing,
  type OverPingDecision,
} from '../over-ping-safety-net.js'
import { mayDrainBufferedInbound } from './serialize-drain-gate.js'

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
 * The live per-turn ping-slot state the over-ping decision reads (PR-4c seam).
 *
 * A structural subset of `CurrentTurn` threaded in EXPLICITLY so the façade can
 * call `decideOverPing` in its enabled branch without importing gateway.ts's
 * turn type. These are READS only — the façade decides; the call-site
 * `applyDecision` thunk performs the atomic `firstPingAt`/`firstPingWasSubstantive`
 * pair-set (the #2562 atomicity invariant: two adjacent assignments, no await
 * between, so a racing second reply reads a consistent pair).
 */
export interface PingClaimCtx {
  /** Wall-clock ms of the FIRST ping this turn, or null if none has landed. */
  firstPingAt: number | null
  /** True iff the send that CLAIMED the slot was itself a substantive answer. */
  firstPingWasSubstantive: boolean
  /** Deterministic clock for the decision (the call site's `Date.now()`). */
  nowMs: number
}

/**
 * The deliver-before-drain inputs the PR-4d card-drain gate threads into the
 * pure `mayDrainBufferedInbound` predicate. A small structural subset (mirrors
 * the `PingClaimCtx` / `FeedOpenGateDeps` shape) so the façade never imports the
 * gateway's turn type — the gateway sources these and passes them in.
 *
 * `endingTurnFinalAnswerDelivered` is fixed to `null` on the card path (§5
 * modeling decision): the predicate degenerates to `!turnInFlight`, so the card
 * single-flight is governed by `activityInFlight` (via `mayDrain`), not by an
 * ending turn's delivery state — a synthetic represent turn cannot wedge it.
 */
export interface CardDrainGateCtx {
  /** A turn is in flight RIGHT NOW (`turnInFlightForGate()`), evaluated at the
   *  gate site. When true, never drain the card — claude is busy. */
  turnInFlight: boolean
  /** The ending turn's `finalAnswerDelivered`. Threaded `null` for the CARD
   *  path so the deliver-before-drain predicate degenerates to `!turnInFlight`
   *  (the card single-flight is governed by `activityInFlight`, not delivery). */
  endingTurnFinalAnswerDelivered: boolean | null
  /** Serialize-until-replied kill-switch state (`SERIALIZE_UNTIL_REPLIED_ENABLED`). */
  enabled: boolean
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
   * Claim-or-downgrade the turn's one notification ping.
   *
   * PR-4c — the over-ping DECISION relocates here, behind the kill-switch, the
   * same structural way PR-4b moved the OPEN gate. Nothing new is extracted:
   * `decideOverPing` is already a pure predicate in `over-ping-safety-net.ts`;
   * PR-4c only relocates the *call* into the enabled branch and keeps the
   * *effects* (stderr, metric, the atomic `firstPingAt`/`firstPingWasSubstantive`
   * pair-set, the `disableNotification`/`wasOverPingSuppressed` closure writes)
   * at the call site, parameterized by the decision the façade hands back.
   *
   *  - **Disabled branch (default):** unchanged from PR-4a — `disabled()` runs,
   *    and that thunk holds its OWN literal `decideOverPing(...)` call + the full
   *    effects block, VERBATIM from PR-4b-base. The disabled path is therefore
   *    provably byte-identical to base: nothing about the decision moves out of
   *    the call site when the flag is OFF.
   *  - **Enabled branch:** compute the decision HERE via `decideOverPing` (the
   *    SAME pure predicate, the SAME inputs threaded through `ctx` + `input`) and
   *    hand it to `applyDecision(decision)`, which performs the identical effects
   *    at the call site. Same pure inputs ⇒ same decision ⇒ flag-ON ≡ flag-OFF ≡
   *    base: not one device ping differs.
   *
   * SYNCHRONOUS by contract — no `async`, no `await`. The
   * `decideOverPing → applyDecision → pair-set` chain runs in one synchronous
   * block so the #2562 atomicity invariant holds across the façade boundary: the
   * façade decides whether to claim/upgrade; the call-site `applyDecision` thunk
   * performs the two-adjacent-line `firstPingAt`/`firstPingWasSubstantive`
   * pair-set with no await between.
   */
  claimOrDowngradePing(
    input: PingClaimInput,
    ctx: PingClaimCtx,
    applyDecision: (decision: OverPingDecision) => void,
    disabled: () => void,
  ): void {
    if (EMISSION_AUTHORITY_ENABLED) {
      const decision = decideOverPing({
        modelRequestedPing: input.modelRequestedPing,
        firstPingAt: ctx.firstPingAt,
        substantive: input.substantive,
        firstPingWasSubstantive: ctx.firstPingWasSubstantive,
        nowMs: ctx.nowMs,
      })
      applyDecision(decision)
      return
    }
    disabled()
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

  /**
   * PR-4d card-drain gate: may the card drain start RIGHT NOW, unifying the
   * single-flight read with the #2137 deliver-before-drain serialization gate.
   *
   *  - **Flag OFF (default):** returns exactly `this.mayDrain(turn)` — the card
   *    single-flight read, byte-equivalent to base. Nothing else is consulted.
   *  - **Flag ON:** returns `this.mayDrain(turn) && mayDrainBufferedInbound(ctx)`
   *    — the single-flight read AND the pure deliver-before-drain predicate
   *    (imported from `./serialize-drain-gate.js`). The gateway threads
   *    `endingTurnFinalAnswerDelivered: null` for the card path (§5 modeling
   *    decision), so `mayDrainBufferedInbound` degenerates to `!turnInFlight`:
   *    the card single-flight stays governed by `activityInFlight` (via
   *    `mayDrain`), NOT by an ending turn's delivery state.
   *
   * PURE READ — see the PR-4d deadlock invariant in this module's header. The
   * GATEWAY serializes this decision via the chat mutex AROUND the call; this
   * method only reads. Routes the single-flight via the pure `this.mayDrain`.
   */
  mayDrainCardNow(turn: EmissionTurnView, ctx: CardDrainGateCtx): boolean {
    if (EMISSION_AUTHORITY_ENABLED) {
      return (
        this.mayDrain(turn) &&
        mayDrainBufferedInbound({
          turnInFlight: ctx.turnInFlight,
          endingTurnFinalAnswerDelivered: ctx.endingTurnFinalAnswerDelivered,
          enabled: ctx.enabled,
        })
      )
    }
    return this.mayDrain(turn)
  }
}
