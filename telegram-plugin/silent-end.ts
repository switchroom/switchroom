/**
 * silent-end.ts — gateway-side state-file writer for the Stop hook.
 *
 * The Stop hook (`telegram-plugin/hooks/silent-end-interrupt-stop.mjs`)
 * reads `$TELEGRAM_STATE_DIR/silent-end-pending.json` to decide whether
 * to block-and-re-prompt or allow the session to end. Pre-#1122 PR3 the
 * file was written from inside the progress-card driver's `onSilentEnd`
 * callback. PR3 deleted the driver and accidentally removed the writer.
 * The hook still ran on every Stop, but the file never appeared, so the
 * hook always allowed the stop → users could ask a question, see 👀
 * fire, and then get nothing back if the model failed to call `reply`.
 *
 * This module is the deterministic replacement. The gateway calls
 * `writeSilentEndState(...)` when a fresh user-message turn ends with
 * zero outbound messages, and `clearSilentEndState(...)` the moment a
 * reply lands. The Stop hook reads the same file and makes its
 * decision — no prompt dependency, no model behaviour required.
 *
 * Retry semantics: on first silent-end the hook blocks the stop with
 * a re-prompt; on the second silent-end (retryCount >= MAX_RETRIES in
 * the hook) the hook lets the session end. We inherit retryCount from
 * any prior state file IFF the prior file's `turnKey` matches — a new
 * turn always starts at retryCount=0.
 *
 * The state file is per-agent (each agent has its own
 * TELEGRAM_STATE_DIR), so two agents going silent at the same time
 * don't collide.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

export interface SilentEndState {
  /** The chat the silent turn was for — used by operator-facing diagnostics. */
  chatId: string
  /** Optional forum thread id, stringified or null. */
  threadId: number | null
  /** Stable identifier for the in-flight turn (statusKey shape). */
  turnKey: string
  /**
   * Per-turn nonce — `deriveTurnId`'s `${chatKey}#${messageId}` shape (#3228).
   * Unlike `turnKey` (the STABLE `chatId:threadId` statusKey, identical across
   * every turn on the same chat/thread), this is unique per inbound message.
   * The Stop hook stamps it from the enqueue envelope's `message_id`; the
   * gateway's `decideCapturedProseDelivery` requires it to match the LIVE
   * turn's `turnId` before delivering `pendingText`, so a stale captured-prose
   * record from a PRIOR turn on the same chat can never be misdelivered on a
   * later turn (Finding 3). Optional — absent when no message_id was derivable
   * (synthetic inbounds), in which case delivery falls back to the turnKey
   * match alone.
   */
  turnId?: string
  /** Incremented each time the Stop hook blocks for this turn. */
  retryCount: number
  /** Wall-clock ms of last write. */
  timestamp: number
  /**
   * Option A transcript-prose bridge. The substantive final-answer prose the
   * model wrote as plain transcript text but never sent through the reply
   * tool, as isolated by the Stop hook's transcript scan
   * (`scanTurnForFinalReply` → `pendingText`). Present only on a hook-written
   * state file for a turn that ended silently WITH deliverable prose; the
   * gateway's own `writeSilentEndState` never sets it. The gateway reads it
   * back to deliver the answer directly on the first silent-end. Optional —
   * absent for the zero-prose (genuinely empty) silent-end.
   */
  pendingText?: string
  /**
   * W1-d follow-up (#4141) — one of THIS turn's reply-tool calls came back
   * `is_error: true`, so `pendingText` is prose the model wrote *after* its
   * delivery attempt failed, not text it chose to send as the answer.
   *
   * Stamped by the Stop hook's single-writer election
   * (`silent-end-interrupt-stop.mjs` → `buildNextState`), the only component
   * that can see the transcript; the gateway's own `writeSilentEndState` never
   * sets it. Consumed by `deliverCapturedProse`, which prefixes a one-line
   * provenance banner so the recipient is told the text was scraped off a
   * failed turn rather than sent as an answer.
   *
   * Optional and only ever `true`: absent means "no positive evidence of a
   * throw", which delivers exactly as before. It never suppresses.
   */
  replyToolThrewThisTurn?: boolean
  /**
   * #4490 — did the turn that produced `pendingText` originate from a
   * self-improvement review inbound (`source="self_improve_review"`)?
   *
   * Stamped by the Stop hook's single-writer election
   * (`silent-end-interrupt-stop.mjs` → `buildNextState`) from the SAME
   * enqueue-envelope `source` tag `writeOutboxRecord` reads for the outbox
   * capture path; the gateway's own `writeSilentEndState` never sets it.
   * Consumed by `deliverCapturedProse` (`gateway/outbound-send-path.ts`),
   * which is the ELECTED path's deliverer — it never writes an outbox record,
   * so the sweep's audience gate / self-improvement framing can never reach
   * this message, and this is the only way that machine can learn the
   * provenance. Restores the #4141-style symmetry #4485 left one-sided (card
   * gate + title framing applied at the sweep only).
   *
   * Optional and only ever `true`: absent means "no positive evidence of a
   * review-origin turn", which delivers exactly as before. It never widens
   * suppression on a normal user turn.
   */
  reviewOriginated?: boolean
}

export interface SilentEndDeps {
  /** State dir root (defaults to `TELEGRAM_STATE_DIR` env). */
  stateDir?: string
  /** stderr writer (defaults to `process.stderr.write`). */
  log?: (line: string) => void
  /**
   * Has a genuine assistant reply been delivered to this chat (optionally
   * scoped to thread) at or after `sinceMs`? Same predicate shape as
   * `history.hasOutboundDeliveredSince` / the represent-guard's dep
   * (`gateway/represent-guard.ts`) — injected here so the exhaustion check
   * below is a pure, testable decision. When omitted (history unavailable,
   * or callers that don't wire it), the check is skipped and the guard
   * falls back to the pre-existing turnKey/retryCount bookkeeping only —
   * never suppress on doubt.
   */
  hasOutboundDeliveredSince?: (chatId: string, sinceMs: number, threadId?: number | null) => boolean
  /** Wall-clock now, ms. Defaults to `Date.now`; injectable for tests. */
  now?: () => number
  /**
   * #3513 (correction 1): was `text` marked ephemeral-shown on the progress card
   * for `turnNonce` (the durable shown-ledger)? Injected so the captured-prose
   * bridge (E3) — which sends via `bot.api.sendMessage` directly, bypassing
   * `normalizeOutboundBody` — refuses to deliver a block that was already
   * assigned to the ephemeral surface. The ledger only ever holds STRUCTURAL
   * narration (correction 4: never a possibly-terminal answer), so this can
   * never suppress a genuine answer. Omitted → the check is skipped (the
   * structural classifier remains the guard).
   */
  isBlockShown?: (turnNonce: string | null | undefined, text: string) => boolean
  /**
   * #3513 follow-up (MF2): has a prior BACKSTOP already delivered this turn's
   * answer, per the durable delivered-keys journal? Injected so the captured-
   * prose bridge (E3) enforces exactly-once-among-backstops DURABLY — if the
   * turn-flush backstop (E1/E2, `deliverySource:'flush'`) or the outbox sweep
   * (E4, `'sweep'`) already delivered this nonce, the bridge must NOT deliver a
   * second copy, even across a process boundary the in-memory ledger can't see.
   * This counts ONLY backstop deliveries (via `backstopAlreadyDelivered`), never
   * an explicit E0 reply (#3510 recap), so a legitimate later explicit reply is
   * unaffected. Omitted → the check is skipped (never suppress on doubt).
   */
  backstopDeliveredNonceHit?: (turnNonce: string | null | undefined) => boolean
}

/**
 * How many times the Stop hook re-prompts a silent-end turn before it
 * gives up. MUST stay in sync with `MAX_RETRIES` in the Stop hook
 * (`telegram-plugin/hooks/silent-end-interrupt-stop.mjs`) — the hook is a
 * standalone `.mjs` and can't import this module.
 *
 * 2026-05-25 bump from 1 → 2. With the original budget of 1, a model
 * that stubbornly emitted `type:"text"` + `stop_reason:"end_turn"` twice
 * in a row (instead of calling the reply tool) fell through to the
 * gateway's 5-minute silence-poke framework-fallback. Second-retry
 * cases now get a chance before the user-visible nudge fires. Memory:
 * the Stop hook prompt itself is explicit ("only text sent through the
 * reply tool is delivered. Send your final answer now"), so a second
 * nudge isn't redundant — it's giving a different sample from the
 * model under the same prompt.
 */
export const SILENT_END_MAX_RETRIES = 2

/**
 * Fix #8 (adversarial-validation progress-card fix pass): `turnKey` is the
 * STABLE `statusKey(chatId, threadId)` — it never changes across turns on
 * the same chat/thread — so `writeSilentEndState`'s "inherit retryCount IFF
 * turnKey matches" rule has no per-turn discriminator on its own. Normally
 * that's fine because `clearSilentEndState` always fires the moment a reply
 * lands, wiping the exhausted record before the next turn starts. But if the
 * gateway's own exhaust-read-and-clear is bypassed (crash/interrupt mid-turn,
 * `gateway.ts` ~turn_end handler never runs), an exhausted
 * (`retryCount >= SILENT_END_MAX_RETRIES`) record can survive into a LATER,
 * unrelated turn. That later turn's first silent-end would then misread the
 * old record as "this turn already exhausted its ladder" and skip its own
 * re-prompt entirely.
 *
 * A record legitimately re-written within one turn's own retry ladder is
 * always fresh (each Stop-hook block re-writes `timestamp`), so bounding by
 * age is a safe, cheap staleness signal that doesn't require a new identity
 * field: any record older than a turn's plausible lifetime could not still
 * be "this turn's" in-flight retry state, and is therefore stale-carryover,
 * not an active ladder. 30 minutes comfortably exceeds any real single-turn
 * Stop-hook retry cycle (seconds, not minutes) while staying well inside the
 * fleet's other staleness bounds (e.g. the 3h boot-resume window).
 */
export const SILENT_END_STALE_RECORD_MAX_AGE_MS = 30 * 60_000

/**
 * User-facing fallback text delivered when a user-message turn ends with no
 * final answer AND the deterministic Stop-hook re-prompt has already been
 * exhausted (#1161). Without this the user only sees the progress card
 * vanish; silence must never be the failure mode.
 *
 * PR #2892 (reference/rfcs/deterministic-turn-liveness.md Phase 2
 * hardening): include the turn's elapsed so the fallback is honest about
 * how long the user actually waited, instead of a generic apology with no
 * timing. A degenerate/unknown duration (missing, non-finite, or <= 0 —
 * e.g. a turn whose `startedAt` was never stamped) omits the waited clause
 * rather than printing a nonsensical "(waited 0s)".
 *
 * Lives here (not gateway.ts) so the transport-boundary tests exercise the
 * REAL string (tests/silent-end-transport.test.ts), not a hand-maintained
 * copy — gateway.ts is not importable in tests.
 */
export function silentEndFallbackText(turnDurationMs: number | undefined): string {
  const elapsed =
    typeof turnDurationMs === 'number' && Number.isFinite(turnDurationMs) && turnDurationMs > 0
      ? ` (waited ${Math.round(turnDurationMs / 1000)}s)`
      : ''
  return (
    '⚠️ The agent finished working but didn’t send a reply' +
    elapsed +
    ' — your last message may not have been answered. Please try asking again.'
  )
}

function resolveStateDir(deps?: SilentEndDeps): string {
  if (deps?.stateDir != null) return deps.stateDir
  const env = process.env.TELEGRAM_STATE_DIR
  if (env != null && env !== '') return env
  // Same fallback the gateway (`gateway.ts STATE_DIR`) and the Stop
  // hook (`silent-end-interrupt-stop.mjs getStateDir`) already use.
  // Discovered during UAT overnight 2026-05-13: test-harness ran
  // without `TELEGRAM_STATE_DIR` set, so the writer returned null
  // path → no state file ever appeared → hook always read "no
  // silent-end pending" → silent-end recovery never engaged. The
  // hook + writer have to agree on the path.
  //
  // Prefer `process.env.HOME` over `node:os` `homedir()` so the
  // fallback is overridable in tests. Bun's `os.homedir()` reads
  // the system home once at startup and ignores subsequent
  // `process.env.HOME` mutations, which breaks the bun-test pass
  // of `silent-end.test.ts` even though the vitest pass is fine
  // (Node's `os.homedir()` documents `HOME` as the first source).
  // In production both branches yield the same path — `HOME` is
  // always set under the agent's tini-supervised process tree.
  const home = process.env.HOME ?? homedir()
  return join(home, '.claude', 'channels', 'telegram')
}

function resolveStatePath(deps?: SilentEndDeps): string {
  return join(resolveStateDir(deps), 'silent-end-pending.json')
}

function emitLog(deps: SilentEndDeps | undefined, line: string): void {
  if (deps?.log != null) deps.log(line)
  else process.stderr.write(line)
}

/**
 * Write the silent-end state file for the given turn. Inherits
 * retryCount from a prior write IFF the prior write's turnKey matches.
 * Otherwise resets to 0.
 *
 * State path: `${TELEGRAM_STATE_DIR ?? ~/.claude/channels/telegram}/
 * silent-end-pending.json` — exactly matching the path the Stop hook
 * (silent-end-interrupt-stop.mjs) reads. The parent dir is created
 * with `mkdir -p` if it doesn't exist (fresh-install case).
 */
export function writeSilentEndState(
  args: { chatId: string; threadId: number | null; turnKey: string },
  deps?: SilentEndDeps,
): void {
  const statePath = resolveStatePath(deps)
  let retryCount = 0
  try {
    if (existsSync(statePath)) {
      const prev = JSON.parse(readFileSync(statePath, 'utf8')) as Partial<SilentEndState>
      if (prev.turnKey === args.turnKey && typeof prev.retryCount === 'number') {
        retryCount = prev.retryCount
      }
    }
  } catch {
    retryCount = 0
  }
  const state: SilentEndState = {
    chatId: args.chatId,
    threadId: args.threadId,
    turnKey: args.turnKey,
    retryCount,
    timestamp: Date.now(),
  }
  try {
    // The fallback path may not exist on a fresh install — mkdir-p
    // before writing. Cheap and idempotent. Without this the writer
    // throws ENOENT in environments where the operator hasn't booted
    // claude before (the dir is normally created by claude itself
    // on first run).
    mkdirSync(dirname(statePath), { recursive: true })
    writeFileSync(statePath, JSON.stringify(state), 'utf8')
    emitLog(
      deps,
      `silent-end: wrote state file turnKey=${args.turnKey} retryCount=${retryCount}\n`,
    )
  } catch (err) {
    emitLog(
      deps,
      `silent-end: failed to write state file: ${(err as Error).message}\n`,
    )
  }
}

/**
 * Clear the silent-end state file IFF it belongs to the given turnKey.
 * Called the moment a reply / stream_reply first-emit lands so the
 * Stop hook doesn't fire a stale block on the next stop.
 *
 * Pre-#1664 (`commit f664cde8`) state files lacked a `turnKey` field
 * entirely. The strict `prev.turnKey !== turnKey` check meant
 * `undefined !== <anything>` was always true, so legacy files survived
 * every clear path and remained readable by the Stop hook indefinitely.
 * In production this stranded clerk with `retryCount=1` for ~hours
 * across two container restarts, breaking the Stop hook's retry budget
 * for every subsequent silent-end (the 2026-05-25 incident).
 *
 * Tolerance: treat a missing `prev.turnKey` as "stale unknown, unlink
 * it" rather than "preserve". Strict comparison still applies when
 * both sides are present, so the same-turn invariant is preserved.
 *
 * Fail-silent: missing file, mismatched turnKey, or read/unlink errors
 * are all benign. The Stop hook itself defends against stale files via
 * the retryCount mechanism.
 */
export function clearSilentEndState(turnKey: string, deps?: SilentEndDeps): void {
  const statePath = resolveStatePath(deps)
  if (!existsSync(statePath)) return
  try {
    const prev = JSON.parse(readFileSync(statePath, 'utf8')) as Partial<SilentEndState>
    if (prev.turnKey != null && prev.turnKey !== turnKey) return
    unlinkSync(statePath)
    emitLog(deps, `silent-end: cleared state file turnKey=${turnKey}\n`)
  } catch {
    // best-effort
  }
}

/**
 * Minimum length (chars, trimmed) of captured prose the gateway will deliver
 * directly on a silent-end. Mirrors `FINAL_ANSWER_MIN_CHARS` in
 * `hooks/silent-end-scan.mjs` and `isFinalAnswerReply`'s 200-char substantive
 * backstop — the same bar used to recognise a real answer. A shorter trailing
 * fragment is not a dropped answer and must not be re-materialised.
 */
export const CAPTURED_PROSE_MIN_CHARS = 200

/**
 * Result of the captured-prose delivery decision (Option A transcript-prose
 * bridge). Pure, side-effect-free — the gateway consumes `deliver`/`text` and
 * owns the actual send + dedup + obligation-close bookkeeping.
 */
export interface CapturedProseDecision {
  /** True → the gateway should deliver `text` directly on this silent-end. */
  deliver: boolean
  /** The prose to deliver; present iff `deliver === true`. RAW — never framed
   *  here, so the caller's dedup and journal keys stay computed on the same
   *  bytes the sweep path uses (#4141). */
  text?: string
  /**
   * #4141 — the persisted record says this turn's reply tool threw. Surfaced
   * (not acted on) so `deliverCapturedProse` can state the prose's provenance.
   * `true` only on positive evidence; never affects `deliver`.
   */
  replyToolThrewThisTurn?: boolean
  /**
   * #4490 — the persisted record says this turn originated from a
   * self-improvement review inbound. Surfaced (not acted on) so
   * `deliverCapturedProse` can apply the SAME card-gate / title-framing rules
   * the outbox sweep applies. `true` only on positive evidence; never affects
   * `deliver` here — the audience decision is made downstream, exactly as
   * `replyToolThrewThisTurn`'s banner decision is.
   */
  reviewOriginated?: boolean
  /** Machine-readable reason (for logs / tests). */
  reason:
    | 'captured-prose'
    | 'no-state'
    | 'turnkey-mismatch'
    | 'turnid-mismatch'
    | 'no-substantive-prose'
    | 'ephemeral-shown'
    | 'already-delivered'
}

/**
 * Decide whether the current silent-end turn has a substantive undelivered
 * final answer that the gateway should deliver directly (Option A).
 *
 * Reads the same `silent-end-pending.json` the Stop hook wrote. Delivers ONLY
 * when (a) the record belongs to THIS turn — BOTH the stable `turnKey` AND, when
 * present, the per-turn `turnId` nonce must match (#3228 Finding 3: `turnKey`
 * alone is `chatId:threadId` and identical across turns on the same chat, so it
 * cannot by itself prove the record is this turn's rather than a stale
 * carryover) — and (b) the persisted `pendingText` clears the substance floor.
 * Otherwise returns `deliver:false` and the caller falls through to the existing
 * re-prompt / represent safety nets unchanged.
 *
 * turnId matching is enforced ONLY when BOTH sides carry one. A record written
 * without a nonce (synthetic inbound with no message_id) or a caller that has
 * no live turnId falls back to the turnKey match alone — never suppress
 * delivery on doubt, and never break the pre-nonce path.
 *
 * Extracted as a pure core (mirrors `decideTurnFlush` / `decideTurnEndGate`)
 * so the gateway runs the exact code the regression tests exercise —
 * `gateway.ts` is not importable in tests.
 */
export function decideCapturedProseDelivery(
  args: { turnKey: string; turnId?: string | null; minChars?: number },
  deps?: SilentEndDeps,
): CapturedProseDecision {
  const minChars = args.minChars ?? CAPTURED_PROSE_MIN_CHARS
  const state = readSilentEndState(deps)
  if (state == null) return { deliver: false, reason: 'no-state' }
  if (state.turnKey !== args.turnKey) return { deliver: false, reason: 'turnkey-mismatch' }
  // Per-turn nonce guard (#3228 Finding 3). When the on-disk record was stamped
  // with a `turnId` AND the caller passes the live turn's `turnId`, they MUST
  // match — otherwise the record belongs to a different turn on the same chat.
  if (
    typeof state.turnId === 'string' &&
    state.turnId !== '' &&
    args.turnId != null &&
    args.turnId !== '' &&
    state.turnId !== args.turnId
  ) {
    return { deliver: false, reason: 'turnid-mismatch' }
  }
  const text = typeof state.pendingText === 'string' ? state.pendingText : ''
  if (text.trim().length < minChars) return { deliver: false, reason: 'no-substantive-prose' }
  // #3513: the persisted prose was already surfaced on the ephemeral progress
  // card for this turn (durable shown-ledger) — the single-surface invariant
  // forbids the bridge from ALSO delivering it to chat. The ledger only holds
  // structural narration (never a possibly-terminal answer), so this can never
  // suppress a genuine answer.
  if (deps?.isBlockShown?.(state.turnId, text) === true) {
    return { deliver: false, reason: 'ephemeral-shown' }
  }
  // #3513 follow-up (MF2): exactly-once-among-backstops. If a prior backstop
  // (turn-flush E1/E2 or the outbox sweep E4) already delivered THIS turn's
  // answer per the durable journal, the bridge must not deliver a duplicate —
  // even across the process boundary the in-memory dedup can't see. Counts only
  // backstop deliveries, never an explicit E0 reply, so a genuine later explicit
  // reply is never blocked here.
  if (deps?.backstopDeliveredNonceHit?.(state.turnId) === true) {
    return { deliver: false, reason: 'already-delivered' }
  }
  return {
    deliver: true,
    text,
    reason: 'captured-prose',
    // #4141: pass the hook's raw signal through untouched. Deliberately placed
    // AFTER every `deliver:false` gate above — the banner is a labelling
    // concern, and must never become an input to whether we deliver at all.
    ...(state.replyToolThrewThisTurn === true ? { replyToolThrewThisTurn: true } : {}),
    // #4490: same discipline for the review-origin signal — placed after every
    // `deliver:false` gate so it can never become an input to whether the
    // (structurally different) "should we deliver at all" decision above
    // fires. The caller decides suppression/framing from this raw flag.
    ...(state.reviewOriginated === true ? { reviewOriginated: true } : {}),
  }
}

/**
 * Outcome of a captured-prose send attempt (Option A transcript-prose bridge).
 *   - `sent`               — the answer was delivered fresh this call.
 *   - `skipped-dedup`      — the exact answer already went out (dedup hit);
 *                            nothing new was sent, but the answer IS with the
 *                            user.
 *   - `failed`             — the send threw; the answer did NOT reach the
 *                            user.
 *   - `suppressed-internal`— #4490: the audience gate classified this prose
 *                            as internal (a non-card self-improvement review
 *                            turn) and it was never sent. Falls through the
 *                            SAME close-obligation + clear-state bookkeeping
 *                            as `sent` / `skipped-dedup` below — no operator
 *                            is waiting on a message that was never meant to
 *                            reach them, so there is nothing to recover.
 */
export type CapturedProseSendOutcome = 'sent' | 'skipped-dedup' | 'failed' | 'suppressed-internal'

/**
 * The bookkeeping effects the gateway applies after a captured-prose send
 * attempt, injected so the settlement decision is a pure, testable core
 * (`gateway.ts` itself is not importable in tests).
 */
export interface CapturedProseSettlementEffects {
  /** Close the ending turn's delivery obligation. */
  closeObligation: () => void
  /** Clear the silent-end state file for this turn. */
  clearState: () => void
  /**
   * Arm the deterministic Stop-hook re-prompt (recordUndeliveredTurnEnd) so
   * the answer is recoverable — the send-failure safety net. Returns the
   * `{ exhausted }` verdict from `recordUndeliveredTurnEnd`: `true` when the
   * re-prompt budget was ALREADY spent (retryCount >= SILENT_END_MAX_RETRIES)
   * on the attempt that failed, so the re-prompt can no longer recover the
   * answer and the caller must deliver a user-facing fallback instead (#3228
   * exhaustion-boundary gap).
   */
  recordUndelivered: () => { exhausted: boolean }
}

/**
 * Result of `settleCapturedProseDelivery`. `exhausted` is meaningful only on
 * the `failed` outcome — `true` means the Stop-hook re-prompt net is spent, so
 * the caller must fire the user-facing fallback (a plain-text retry of the
 * captured prose, then the generic apology) so the turn never goes silent.
 * Always `false` for `sent` / `skipped-dedup` (the answer is already with the
 * user; no fallback).
 */
export interface CapturedProseSettlementResult {
  exhausted: boolean
}

/**
 * Apply the correct bookkeeping after a captured-prose send attempt (#3228
 * Finding 1). This is the deterministic core the gateway's
 * `deliverCapturedProse` routes ALL three of its settlement points through.
 *
 *   - `sent` / `skipped-dedup` → the answer is with the user, so CLOSE the
 *     obligation and CLEAR the silent-end state; the represent and the
 *     exhausted fallback must not re-fire for the same answer.
 *
 *   - `failed` → the send threw, so the answer is NOT with the user. We must
 *     NOT close the obligation or clear the state; instead we ARM the Stop-hook
 *     re-prompt net (`recordUndelivered`). This is the regression fix: the
 *     shared turn-end teardown (`decideObligationTurnEnd`) already CLOSES the
 *     obligation whenever `replyCalled === true` (the interim-ack case that
 *     reaches captured-prose delivery), so "just leave the obligation open" is
 *     NOT a real net — without recordUndelivered a thrown send permanently
 *     loses the answer, strictly worse than the pre-bridge behaviour.
 *
 *     The `{ exhausted }` verdict from `recordUndelivered` is threaded back out
 *     to the caller (#3228 exhaustion-boundary gap): when the failed send
 *     happened on the attempt where the re-prompt budget was ALREADY spent,
 *     `recordUndeliveredTurnEnd` clears the state and reports `exhausted:true` —
 *     the Stop-hook re-prompt can no longer recover the answer, so the caller
 *     MUST deliver a user-facing fallback (mirroring the non-captured
 *     exhausted path) or the user gets NEITHER the answer NOR the apology.
 *
 * Pure — no IO, no module state; the caller injects the effects.
 */
export function settleCapturedProseDelivery(
  outcome: CapturedProseSendOutcome,
  effects: CapturedProseSettlementEffects,
): CapturedProseSettlementResult {
  if (outcome === 'failed') {
    return { exhausted: effects.recordUndelivered().exhausted }
  }
  effects.closeObligation()
  effects.clearState()
  return { exhausted: false }
}

/**
 * Read the state file (for tests + diagnostics). Returns null when
 * absent or unparsable.
 */
export function readSilentEndState(deps?: SilentEndDeps): SilentEndState | null {
  const statePath = resolveStatePath(deps)
  if (!existsSync(statePath)) return null
  try {
    return JSON.parse(readFileSync(statePath, 'utf8')) as SilentEndState
  } catch {
    return null
  }
}

/**
 * Record a user-message turn that ended WITHOUT the model delivering a
 * final answer, and report whether the deterministic re-prompt has been
 * exhausted. This is the gateway's single entry point for the main
 * turn-end path.
 *
 * #1664 — the trigger generalized from "zero outbound" to "no final
 * answer delivered". Two cases reach here now:
 *   1. Zero outbound — the turn ended with nothing sent at all (the
 *      original #1122/#1161 silent-end case).
 *   2. Interim-ack only — the model sent an ack via reply/stream_reply
 *      but ended the turn with its real answer as plain transcript text
 *      (rendered into an ephemeral answer-lane draft that gets retracted
 *      at turn_end, never finalized). The gateway tracks this via
 *      `CurrentTurn.finalAnswerDelivered`; case 1 is just the subset
 *      where that flag is false because nothing landed.
 * In both cases the model still owes the user an answer, so the same
 * re-prompt safety net applies — the framework re-prompts; the model
 * re-delivers via the reply tool (never the framework materializing a
 * message from the draft — see `reference/principles.md`).
 *
 *   - First undelivered turn-end (no prior state, or prior `retryCount`
 *     still below `SILENT_END_MAX_RETRIES`) → writes the state file via
 *     `writeSilentEndState`, so `silent-end-interrupt-stop.mjs` blocks
 *     the stop and re-prompts the agent. Returns `{ exhausted: false }`.
 *
 *   - An undelivered turn-end where the prior state for the SAME turn
 *     already shows `retryCount >= SILENT_END_MAX_RETRIES` → the Stop
 *     hook already spent its re-prompt and the agent is STILL
 *     undelivered. Recovery has failed. Clears the state file (so the
 *     Stop hook on this final turn finds nothing pending and allows the
 *     stop cleanly) and returns `{ exhausted: true }` — the caller MUST
 *     then deliver a user-facing fallback so the turn never just
 *     vanishes (#1161).
 *
 * Chat-less autonomous wakeup turns never reach here: the gateway only
 * creates a `currentTurn` (and therefore only runs a turn-end handler)
 * when the inbound event carries a chat id. Cron-fired turns DO carry a
 * topic chat and reach this path — a cron task that means to stay silent
 * must emit a NO_REPLY sentinel, which routes to the gateway's
 * silent-marker branch and never gets a fallback.
 */
export function recordSilentTurnEnd(
  args: { chatId: string; threadId: number | null; turnKey: string },
  deps?: SilentEndDeps,
): { exhausted: boolean } {
  const prev = readSilentEndState(deps)
  if (
    prev != null &&
    prev.turnKey === args.turnKey &&
    prev.retryCount >= SILENT_END_MAX_RETRIES
  ) {
    // Staleness guard (mirrors the represent-guard's #2472 fix,
    // `gateway/represent-guard.ts:shouldSuppressRepresent`): `turnKey` here
    // is `statusKey(chatId, threadId)` — stable across every turn on the
    // same chat/thread, NOT a per-turn nonce (unlike the obligation
    // ledger's `originTurnId`). The whole mechanism depends on a reply
    // ALWAYS clearing this state file via `clearSilentEndState` at the
    // send-site. `clearSilentEndState` is fail-silent by design (state
    // corruption / a write race must never crash the gateway), so if a
    // clear is ever missed, a stale `retryCount >= MAX_RETRIES` record
    // from an OLD, already-answered turn would be misread as "this
    // brand-new dark turn already exhausted its re-prompt budget" —
    // firing the user-facing fallback immediately, without the turn ever
    // going through the Stop-hook re-prompt ladder. Before trusting that
    // reading, verify against real delivery history: has a genuine reply
    // landed on this chat/thread since the stale record was last written?
    // If so, the record is satisfied-but-misdetected — drop it silently
    // and let this dark turn start its OWN fresh retry cycle instead of
    // inheriting someone else's spent budget.
    // Fix #8: age-based staleness bound. `turnKey` has no per-turn nonce
    // (see SILENT_END_STALE_RECORD_MAX_AGE_MS doc), so a record whose
    // `timestamp` is older than a turn's plausible lifetime cannot belong to
    // THIS dark turn's own retry ladder even absent any delivery evidence —
    // it's carryover from a prior turn whose gateway-side clear was
    // bypassed (crash/interrupt). Check this before (and independent of)
    // the delivery-based check below so a bypassed-clear record is caught
    // even when no reply was ever delivered on the chat/thread at all.
    const now = deps?.now?.() ?? Date.now()
    const staleByAge = now - prev.timestamp > SILENT_END_STALE_RECORD_MAX_AGE_MS
    if (
      staleByAge ||
      deps?.hasOutboundDeliveredSince?.(args.chatId, prev.timestamp, args.threadId)
    ) {
      emitLog(
        deps,
        staleByAge
          ? `silent-end: stale exhausted record for turnKey=${args.turnKey} ` +
              `(retryCount=${prev.retryCount}, age=${now - prev.timestamp}ms > ` +
              `${SILENT_END_STALE_RECORD_MAX_AGE_MS}ms) — treating as carryover ` +
              `from a prior turn, not exhausted\n`
          : `silent-end: stale exhausted record for turnKey=${args.turnKey} ` +
              `(retryCount=${prev.retryCount}) but a reply was delivered since ` +
              `${prev.timestamp} — treating as satisfied-but-misdetected, not exhausted\n`,
      )
      // MUST clear before writing (adversarial review of #2892):
      // writeSilentEndState re-inherits retryCount whenever the on-disk
      // turnKey matches — which it ALWAYS does here, since turnKey is the
      // stable statusKey(chatId, threadId). Writing over the stale record
      // directly would start the "fresh" ladder at retryCount=MAX: the
      // Stop hook would see retryCount >= MAX_RETRIES and never re-prompt,
      // while this call just returned exhausted:false so no fallback fires
      // either — pure silence, strictly worse than the pre-fix behaviour.
      // Clearing first makes the new record genuinely start at retryCount=0.
      clearSilentEndState(args.turnKey, deps)
      writeSilentEndState(args, deps)
      return { exhausted: false }
    }
    clearSilentEndState(args.turnKey, deps)
    emitLog(
      deps,
      `silent-end: re-prompt exhausted for turnKey=${args.turnKey} ` +
        `(retryCount=${prev.retryCount} >= ${SILENT_END_MAX_RETRIES}) — ` +
        `caller should deliver a fallback\n`,
    )
    return { exhausted: true }
  }
  writeSilentEndState(args, deps)
  return { exhausted: false }
}

/**
 * #1664 — semantic alias for `recordSilentTurnEnd`. The trigger is now
 * "no final answer delivered", of which "zero outbound" is one case; new
 * callsites should prefer this name so the intent reads correctly. The
 * behaviour, retry semantics, and `{exhausted}` contract are identical —
 * `recordSilentTurnEnd` is kept for the existing callers and tests.
 */
export const recordUndeliveredTurnEnd = recordSilentTurnEnd
