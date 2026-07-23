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
 * Write the durable outbox record for a captured undelivered final answer
 * (atomic tmp+rename), mirroring `writeOutboxRecordAtomic` in `../outbox.ts`.
 * The gateway heartbeat sweep is the single deliverer. Best-effort; never
 * throws. Returns true when a record exists on disk for the nonce afterward.
 */
function writeOutboxRecord(stateDir, capture) {
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
  try {
    const capture = scanForOutboxCapture(jsonl)
    if (capture.capture === true) {
      writeOutboxRecord(stateDir, capture)
      process.stderr.write(
        `[silent-end-interrupt] captured undelivered final answer to outbox ` +
          `(nonce=${capture.turnNonce} source=${capture.source} chars=${capture.text.length}) — ` +
          `sweep will deliver; allowing stop\n`,
      )
      process.exit(0)
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
