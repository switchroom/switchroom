#!/usr/bin/env node
/**
 * Stop hook — deterministic guardrail that a turn ended with a final
 * reply tool call.
 *
 * Closes #1775. The pre-fix hook depended on the gateway's
 * `$TELEGRAM_STATE_DIR/silent-end-pending.json` file as its block/allow
 * signal. That file is written by the gateway's `turn_end` handler,
 * which runs DOWNSTREAM of session-tail processing the `turn_duration`
 * JSONL line — and the JSONL line is itself written AFTER
 * `stop_hook_summary`. Live evidence on clerk (12 correlated samples,
 * 2026-05-25): state file lands ~175ms (range 111-287ms) after the
 * hook fires. The race is structurally always lost. The hook never
 * saw its OWN turn's silent-end signal; the mechanism only worked
 * one-turn-delayed via stale state from prior turns.
 *
 * Fix: the hook now reads `transcript_path` from its event input
 * (Claude Code flushes assistant content to the JSONL before firing
 * Stop hooks — verified empirically because `secret-scrub-stop.mjs`
 * already reads `transcript_path` at Stop time successfully) and
 * scans the CURRENT turn's tool_use entries for a qualifying reply.
 * No race window — the decision is derived from the transcript that
 * is on disk at the moment the hook runs.
 *
 * The gateway's state file is preserved for retry-count
 * bookkeeping (the 1-retry budget + `silent-end.ts` user-facing
 * fallback chain). The SIGNAL changes; the budget mechanism does
 * not.
 *
 * #1664 — "no final answer delivered" covers two cases: (a) the turn
 * ended with zero outbound, and (b) the model sent only an interim
 * ack via reply/stream_reply but left its real answer as plain
 * transcript text. The transcript scan handles BOTH cleanly:
 *  - case (a) → no tool_use of reply tools in the turn → block
 *  - case (b) → tool_use present but `isFinalAnswerReply` returns
 *    false on every call → block
 *
 * Carve-outs preserved:
 *   - NO_REPLY / HEARTBEAT_OK silent markers (`gateway.ts:6692`) → allow
 *   - Sub-agent (`isSidechain:true`) lines → skipped (the parent's
 *     reply obligation is not satisfied by a sub-agent's reply tool)
 *   - Cron-fired turns DO carry a topic chat and reach the silent-end
 *     path (`silent-end.ts:219-224`) — they must emit NO_REPLY
 *     explicitly, not be specially exempted here
 *
 * Protocol:
 *   Input:  JSON on stdin — { session_id, transcript_path, ... }
 *   Output: exit 0 + empty stdout → allow stop.
 *           exit 0 + JSON stdout { decision: "block", reason: "..." } → re-prompt.
 *
 * Fail-open on every error path (no transcript / unreadable / no
 * turn-start anchor / state-file write failure) — blocking on a
 * malfunction is worse than the original race because it loops
 * every session close.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

import { createHash } from 'node:crypto'
import { renameSync } from 'node:fs'

import {
  scanTurnForFinalReply,
  scanForOutboxCapture,
  decideStopHookDisposition,
  isTurnFlushSafetyEnabledEnv,
  isCapturedProseDeliveryEnabledEnv,
  isGatewayHeartbeatFresh,
} from './silent-end-scan.mjs'
import {
  decideCaptureAudience,
  resolveOpenObligation,
  isReviewOriginatedSource,
  isSelfImprovementCard,
  AUDIENCE_INTERNAL,
} from './audience-classify.mjs'

// MUST stay in sync with SILENT_END_MAX_RETRIES in telegram-plugin/silent-end.ts
// (this hook is a standalone .mjs and can't import the TS module).
// Bumped 1 → 2 on 2026-05-25 — see the matching doc-comment in silent-end.ts.
const MAX_RETRIES = 2

function readStdin() {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

function getStateDir() {
  return process.env.TELEGRAM_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'telegram')
}

/**
 * Build the state-file payload the gateway reads back: carries `turnKey` /
 * `chatId` / `threadId` / per-turn `turnId` nonce and the Option-A
 * `pendingText` bridge, with the given `retryCount`. Stale carryover values
 * from the prior on-disk state (`base`) are explicitly dropped when THIS turn
 * has no derivable nonce / no deliverable prose.
 *
 * @param {object} base   Prior on-disk state (spread as a starting point).
 * @param {ReturnType<import('./silent-end-scan.mjs').scanTurnForFinalReply>} decision
 * @param {number} retryCount
 */
function buildNextState(base, decision, retryCount) {
  const next = { ...base, retryCount, timestamp: Date.now() }
  if (decision.turnKey) {
    next.turnKey = decision.turnKey
    next.chatId = decision.chatId
    if (decision.threadId != null) next.threadId = decision.threadId
    if (decision.turnId) next.turnId = decision.turnId
    else delete next.turnId
  } else {
    delete next.turnId
  }
  if (typeof decision.pendingText === 'string' && decision.pendingText.length > 0) {
    next.pendingText = decision.pendingText
  } else {
    delete next.pendingText
  }
  // #4141: carry THIS turn's reply-throw signal through to the captured-prose
  // bridge, which is the delivering machine on the ELECTED path and has no
  // transcript of its own. Same stale-carryover discipline as `pendingText` /
  // `turnId`: explicitly DELETED when this turn's scan saw no throw, so a
  // spread of a prior turn's file can never mislabel a clean turn.
  if (decision.replyToolThrewThisTurn === true) {
    next.replyToolThrewThisTurn = true
  } else {
    delete next.replyToolThrewThisTurn
  }
  // #4490: same carry-through for review-turn provenance. The outbox capture
  // path (`writeOutboxRecord` above) stamps `reviewOriginated` from the SAME
  // envelope `source` tag; the ELECTED path ('trailing-text-after-reply') never
  // writes an outbox record, so the captured-prose bridge (the delivering
  // machine on this path) has no other way to learn it. Explicitly deleted
  // when this turn's scan saw no review-source envelope, so a spread of a
  // prior turn's file can never mislabel a normal turn's prose as a review
  // turn's (or vice versa).
  if (isReviewOriginatedSource(decision.source)) {
    next.reviewOriginated = true
  } else {
    delete next.reviewOriginated
  }
  return next
}

/**
 * Persist the elected state file (single-writer election allow path).
 * retryCount is left UNCHANGED (this is a hand-off to the gateway's delivery
 * machine, not a re-prompt). Fail-open on write error — an allow never loops.
 *
 * @param {string} statePath
 * @param {object} base
 * @param {ReturnType<import('./silent-end-scan.mjs').scanTurnForFinalReply>} decision
 */
function writeElectedState(statePath, base, decision) {
  const retryCount = typeof base.retryCount === 'number' ? base.retryCount : 0
  try {
    writeFileSync(statePath, JSON.stringify(buildNextState(base, decision, retryCount)), 'utf8')
  } catch (err) {
    process.stderr.write(`[silent-end-interrupt] failed to write elected state file: ${err.message}\n`)
  }
}

const JOURNAL_FILE = 'delivered.jsonl'

/** Is `nonce` already in the outbox delivered-keys journal? (best-effort) */
function outboxAlreadyDelivered(outboxDir, nonce) {
  const path = join(outboxDir, JOURNAL_FILE)
  if (!existsSync(path)) return false
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line) continue
      try {
        if (JSON.parse(line)?.turnNonce === nonce) return true
      } catch {
        /* skip corrupt */
      }
    }
  } catch {
    /* best-effort */
  }
  return false
}

/**
 * W1-d (#3865): classify WHO the captured prose is for, at capture time — the
 * only point in the pipeline that can still see the turn.
 *
 * The obligation snapshot is read here (impure) and the verdict is computed by
 * the shared pure classifier, so the hook and the gateway run the identical
 * predicate. Any failure resolves to `'user'` via `resolveOpenObligation`'s
 * `'unknown'` → the record delivers exactly as it does today.
 *
 * @param {string} stateDir
 * @param {{ chatId: string|null, originChatId?: string|null, replyToolThrewThisTurn?: boolean, source?: string|null }} capture
 * @returns {'user' | 'internal'}
 */
function classifyCaptureAudience(stateDir, capture) {
  let snapshotRaw = null
  try {
    const p = join(stateDir, 'obligations.json')
    if (existsSync(p)) snapshotRaw = readFileSync(p, 'utf8')
  } catch {
    /* unreadable ⇒ null ⇒ 'unknown' ⇒ 'user' (fail-safe toward delivering) */
  }
  // #4146: with the ledger disabled, obligations are going UNTRACKED and any
  // file on disk is a leftover, not a fact. Distrust it outright rather than
  // read a stale empty set as positive proof that nobody is waiting — that is
  // the one configuration in which the asymmetric default would invert. (The
  // gateway also unlinks the snapshot at boot in this mode; this is the
  // reader-side half, covering the window before it does.)
  // STATIC is the second persistence-off mode (`gateway.ts:1343` gates the same
  // `onChange` wiring on it at `:2810`), so it must distrust the file for the
  // same reason. Writer-side cleanup already covers it at boot; this leg covers
  // the window the writer cannot — an unlink that failed (EACCES) or a gateway
  // that has not restarted since the mode changed. Honest caveat:
  // `TELEGRAM_ACCESS_MODE` is supplied by the host, not by this repo, so if it
  // is not exported into the hook's environment this leg degrades to a no-op and
  // the writer-side unlink remains the cover. It can only ever move the verdict
  // toward DELIVER, so a degraded read is never worse than today.
  const snapshotTrusted =
    process.env.SWITCHROOM_OBLIGATION_LEDGER !== '0' &&
    process.env.TELEGRAM_ACCESS_MODE !== 'static'
  return decideCaptureAudience({
    replyToolThrewThisTurn: capture.replyToolThrewThisTurn === true,
    // A self-improvement review turn has exactly ONE sanctioned operator-facing
    // output: a well-formed self-improvement CARD. Deterministic on the enqueue
    // envelope's `source` tag (the same signal the rest of the self-improve
    // machinery routes on) plus the EXACT card-shape of the captured text. A
    // card delivers; any other trailing prose (the raw-reasoning leak) is
    // suppressed. Independent of the reply-throw / obligation state below.
    reviewOriginated: isReviewOriginatedSource(capture.source),
    reviewTextIsCard: isSelfImprovementCard(capture.text),
    openInboundObligation: resolveOpenObligation({
      snapshotRaw,
      snapshotTrusted,
      // Same chat the sweep will route to: the envelope chat when present,
      // else this session's origin chat (`resolveOutboxChat`'s F2 fallback).
      chatId: capture.chatId ?? capture.originChatId ?? null,
    }),
  })
}

/**
 * Write the durable outbox record for a captured undelivered final answer
 * (atomic tmp+rename), mirroring `writeOutboxRecordAtomic` in `../outbox.ts`.
 * The gateway heartbeat sweep is the single deliverer. Best-effort; never
 * throws. Returns true when a record exists on disk for the nonce afterward.
 */
function writeOutboxRecord(stateDir, capture, audience) {
  const outboxDir = join(stateDir, 'outbox')
  try {
    mkdirSync(outboxDir, { recursive: true })
    const finalPath = join(outboxDir, `${capture.turnNonce}.json`)
    if (existsSync(finalPath)) return true
    // Already delivered by another machine (reply/flush) under this nonce.
    if (outboxAlreadyDelivered(outboxDir, capture.turnNonce)) return true
    const record = {
      turnNonce: capture.turnNonce,
      chatId: capture.chatId,
      threadId: capture.threadId,
      text: capture.text,
      textSha256: createHash('sha256').update(capture.text, 'utf8').digest('hex'),
      createdAt: Date.now(),
      source: capture.source,
      anchorContent: capture.chatId == null ? capture.anchorContent : undefined,
      // F2: per-session origin chat for envelope-less routing (fail-closed).
      originChatId: capture.chatId == null ? (capture.originChatId ?? null) : undefined,
      originThreadId: capture.chatId == null ? (capture.originThreadId ?? null) : undefined,
      // #3510 instrumentation: carried into every delivered.jsonl entry the
      // sweep writes for this record, so a double-send is provable from the
      // journal alone. Driven by the SAME boolean that gates capture-vs-election
      // in main() — fix and telemetry cannot drift.
      replyAlreadyDeliveredThisTurn: capture.replyAlreadyDeliveredThisTurn === true,
      // W1-d (#3865): WHO this text is for. Always stamped explicitly (never
      // left implicit) so a post-change record is self-describing and the
      // sweep's gate never has to infer. `'user'` is byte-for-byte the
      // pre-change behaviour.
      audience: audience === AUDIENCE_INTERNAL ? AUDIENCE_INTERNAL : 'user',
      // W1-d follow-up (#4141): the RAW structural signal, persisted alongside
      // the verdict it fed. `audience` collapses it with the obligation state
      // and loses it; the sweep needs it on its own to decide provenance
      // framing for the `'user'` records the audience gate deliberately does
      // not catch (the foreground case). Stamped here because this is the last
      // point in the pipeline that can still see the transcript.
      replyToolThrewThisTurn: capture.replyToolThrewThisTurn === true,
      // Ken 2026-08-07: did this turn originate from a self-improvement review
      // inbound? `audience` already consumed it (with the card-shape signal) to
      // deliver a well-formed card and suppress raw reasoning by default; the
      // sweep consumes this raw flag again, on its own, to prepend the
      // self-improvement TITLE to any review record delivered with the audience
      // gate OFF, so review reasoning can never appear as raw, unlabelled prose.
      reviewOriginated: isReviewOriginatedSource(capture.source),
    }
    const tmpPath = join(outboxDir, `.${capture.turnNonce}.${process.pid}.tmp`)
    writeFileSync(tmpPath, JSON.stringify(record), 'utf8')
    renameSync(tmpPath, finalPath)
    return true
  } catch (err) {
    process.stderr.write(`[silent-end-interrupt] failed to write outbox record: ${err.message}\n`)
    return false
  }
}

function main() {
  const raw = readStdin().trim()
  if (!raw) process.exit(0)

  let event
  try {
    event = JSON.parse(raw)
  } catch {
    process.exit(0)
  }

  const transcriptPath = event?.transcript_path
  if (!transcriptPath || typeof transcriptPath !== 'string' || !existsSync(transcriptPath)) {
    // No transcript → can't scan → fail-open. Pre-fix the hook fell
    // back to the state-file signal here; we deliberately do NOT do
    // that anymore because the state-file signal is structurally
    // stale (race-loses every time).
    process.exit(0)
  }

  let jsonl
  try {
    jsonl = readFileSync(transcriptPath, 'utf8')
  } catch (err) {
    process.stderr.write(
      `[silent-end-interrupt] failed to read transcript ${transcriptPath}: ${err.message}\n`,
    )
    process.exit(0)
  }

  const stateDir = getStateDir()

  // ── Outbox capture (guaranteed final-message delivery) ────────────────
  // Class-agnostic: fires on EVERY main-session turn end. When the turn ended
  // with substantive undelivered trailing prose (Telegram inbound,
  // task-notification handback, cron, or a future/unknown wake shape), write a
  // durable outbox record. The gateway heartbeat sweep is the single deliverer
  // — no CurrentTurn, no election, no re-prompt needed. This is the deterministic
  // guarantee: the model calling `reply` is no longer required. Fail-open on any
  // error (never loop the session).
  //
  // Kill switch symmetry: `SWITCHROOM_TG_OUTBOX_DELIVERY=0` disables the gateway
  // sweep (the deliverer). Capture MUST honour the SAME gate — otherwise, with
  // the flag off, capture would write records that nothing delivers AND
  // short-circuit the legacy re-prompt path below = silent loss. Flag off ⇒ skip
  // capture entirely and fall through to the legacy block/re-prompt behaviour.
  if (process.env.SWITCHROOM_TG_OUTBOX_DELIVERY !== '0') try {
    const capture = scanForOutboxCapture(jsonl)
    if (capture.capture === true) {
      if (capture.replyAlreadyDeliveredThisTurn === true) {
        // #3510: a qualifying reply ALREADY delivered through the gateway this
        // turn, so a gateway anchor provably exists and the single-writer
        // election below ('trailing-text-after-reply') is reachable. Writing an
        // outbox record + self-exiting here would create a third, uncoordinated
        // delivery path that bypasses the #3469 election and re-sends a
        // trailing recap of the reply as a second (unformatted) message. Do NOT
        // capture; fall through so the election is the actual single writer.
        // The gateway-blind backstop (#3502) is untouched: it is the
        // replyAlreadyDeliveredThisTurn === false branch below.
        // Log both hashes so a double-send is provable from logs alone.
        process.stderr.write(
          `[silent-end-interrupt] capture found trailing prose after a delivered reply ` +
            `(nonce=${capture.turnNonce} source=${capture.source} chars=${capture.text.length} ` +
            `replyAlreadyDeliveredThisTurn=true ` +
            `capturedTextSha256=${createHash('sha256').update(capture.text, 'utf8').digest('hex')} ` +
            `deliveredReplySha256=${capture.deliveredReplySha256 ?? 'unknown'}) — ` +
            `deferring to single-writer election (#3510)\n`,
        )
      } else {
        const audience = classifyCaptureAudience(stateDir, capture)
        writeOutboxRecord(stateDir, capture, audience)
        process.stderr.write(
          `[silent-end-interrupt] captured undelivered final answer to outbox ` +
            `(nonce=${capture.turnNonce} source=${capture.source} chars=${capture.text.length} ` +
            `replyAlreadyDeliveredThisTurn=false audience=${audience} ` +
            `replyToolThrewThisTurn=${capture.replyToolThrewThisTurn === true}) — ` +
            `${audience === AUDIENCE_INTERNAL
              ? 'internal prose: journaled for inspection, sweep will NOT deliver'
              : 'sweep will deliver'}; allowing stop\n`,
        )
        process.exit(0)
      }
    }
  } catch (err) {
    process.stderr.write(`[silent-end-interrupt] outbox capture error (fail-open): ${err.message}\n`)
  }

  const decision = scanTurnForFinalReply(jsonl)

  // 'allow' (qualifying reply or silent marker) and 'unknown' (no
  // turn-start anchor in the scanned range — session restart,
  // compaction, etc.) both allow the stop.
  if (decision.decided !== 'block') {
    process.exit(0)
  }

  // Retry-budget bookkeeping. The state file is read/written here
  // as a counter ONLY — the decision was already made from the
  // transcript above. If a state file exists from a prior turn that
  // never got cleared (clean shutdown not perfect), this read still
  // works; if absent, retryCount defaults to 0.
  const statePath = join(stateDir, 'silent-end-pending.json')

  let state = {}
  if (existsSync(statePath)) {
    try {
      state = JSON.parse(readFileSync(statePath, 'utf8'))
    } catch {
      // Corrupt — treat as fresh.
      state = {}
    }
  }

  const retryCount = typeof state.retryCount === 'number' ? state.retryCount : 0

  // ── Single-writer election (duplicate-message fix) ────────────────
  // On a would-BLOCK scan, ALLOW the stop (while still writing the state
  // file so the gateway's delivery machines have their input) IFF a
  // gateway delivery machine is PROVABLY going to deliver the trailing
  // prose. Otherwise BLOCK exactly as today. See
  // `decideStopHookDisposition` in silent-end-scan.mjs for the four
  // never-drop gates. This eliminates the double-send: the gateway flush
  // / captured-prose bridge is the single writer; the hook no longer
  // re-prompts a reworded reply that defeats the exact-match dedup.
  const disposition = decideStopHookDisposition({
    scan: decision,
    retryCount,
    turnFlushSafetyEnabled: isTurnFlushSafetyEnabledEnv(process.env),
    capturedProseDeliveryEnabled: isCapturedProseDeliveryEnabledEnv(process.env),
    gatewayLive: isGatewayHeartbeatFresh(stateDir),
  })
  if (disposition.action === 'allow-elected') {
    // Persist the state file (turnKey / turnId / pendingText) so the
    // gateway's turn-end path delivers the answer — retryCount stays at 0
    // (this is NOT a re-prompt, it's a hand-off to the single writer).
    writeElectedState(statePath, state, decision)
    process.stderr.write(
      `[silent-end-interrupt] single-writer election ALLOWED stop ` +
        `(scan=${decision.reason} elect=${disposition.reason}) — gateway will deliver\n`,
    )
    process.exit(0)
  }

  if (retryCount >= MAX_RETRIES) {
    // Budget spent. Let the session end so the gateway's
    // `silent-end.ts:recordUndeliveredTurnEnd` path delivers the
    // user-facing fallback (the gateway sees `silentEnd.exhausted ===
    // true` and posts SILENT_END_FALLBACK_TEXT).
    process.stderr.write(
      `[silent-end-interrupt] retry exhausted (retryCount=${retryCount} >= MAX_RETRIES=${MAX_RETRIES}) — allowing stop\n`,
    )
    process.exit(0)
  }

  // Persist incremented retry count so a follow-up Stop in the same
  // chat hits the exhaustion branch above. The gateway's existing
  // clearSilentEndState path (`silent-end.ts:155-180`) handles
  // resetting on successful delivery.
  //
  // CRITICAL: include `turnKey` (and the supporting `chatId` / `threadId`)
  // when the scan derived them from the enqueue envelope. The gateway's
  // `recordSilentTurnEnd` (`silent-end.ts:114`) preserves retryCount
  // ONLY when `prev.turnKey === args.turnKey`. Without turnKey here,
  // the gateway's later write (~175ms after the hook) sees `prev.turnKey
  // === undefined`, fails the match, and resets retryCount to 0 — which
  // doubles the effective re-prompt budget vs. the design. With turnKey
  // present (same chatKey shape the gateway uses), the match succeeds
  // and the budget is honored.
  //
  // Per-turn nonce (Finding 3, #3228) and the Option-A `pendingText` bridge
  // are plumbed by `buildNextState`.
  const nextState = buildNextState(state, decision, retryCount + 1)
  try {
    writeFileSync(statePath, JSON.stringify(nextState), 'utf8')
  } catch (err) {
    process.stderr.write(`[silent-end-interrupt] failed to update state file: ${err.message}\n`)
    // Fail-open: a retry-count write failure shouldn't loop the
    // session forever.
    process.exit(0)
  }

  process.stderr.write(
    `[silent-end-interrupt] blocking stop to re-prompt agent (transcriptScan=${decision.reason} retryCount was ${retryCount})\n`,
  )

  process.stdout.write(
    JSON.stringify({
      decision: 'block',
      reason:
        'This turn is ending without your final answer reaching the user. ' +
        'If you wrote an answer as plain text (not via a tool), the user ' +
        'cannot see it — only text sent through the reply tool is delivered. ' +
        'Send your final answer now by calling mcp__switchroom-telegram__reply. ' +
        'If your final answer has already reached the user, or you ' +
        'intentionally have nothing to add, reply with exactly NO_REPLY.',
    }),
  )
  process.exit(0)
}

main()
