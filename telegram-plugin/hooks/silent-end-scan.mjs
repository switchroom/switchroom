/**
 * Pure helpers for the silent-end Stop hook — extracted so unit tests
 * can exercise the scan logic without spawning the .mjs subprocess.
 *
 * Closes the race documented in #1775: the gateway writes
 * `silent-end-pending.json` only AFTER the Stop hook fires (the
 * gateway's `turn_end` handler runs downstream of the `turn_duration`
 * JSONL line, which is itself written AFTER `stop_hook_summary`). The
 * fix: the hook stops depending on the gateway's state file as its
 * SIGNAL and instead scans `transcript_path` directly. Claude Code
 * flushes assistant content to the JSONL before firing Stop hooks
 * (verified empirically: `telegram-plugin/hooks/secret-scrub-stop.mjs`
 * already reads `transcript_path` at Stop time successfully in
 * production), so a transcript scan is race-free.
 *
 * The state file is preserved for retry-count bookkeeping (the
 * 1-retry budget + user-facing fallback chain in `silent-end.ts`),
 * but it is no longer the signal that drives the block/allow
 * decision.
 *
 * Same `isFinalAnswerReply` predicate the gateway applies at every
 * reply callsite (`final-answer-detect.ts:78-83`):
 *   done===true  OR  !disableNotification  OR  text.length >= 200
 *
 * Plus the `NO_REPLY` / `HEARTBEAT_OK` silent-marker carve-out — if
 * the model explicitly emitted that sentinel through the reply tool,
 * the turn is "intentionally silent" and the hook must allow stop.
 *
 * Sidechain filter: sub-agent (Task) tool_use lines that leak into
 * the parent transcript with `isSidechain:true` are skipped. The
 * sub-agent's OWN replies live in `subagents/agent-<id>.jsonl` (per
 * `session-tail.ts:277-281`) and never count toward the parent's
 * delivery obligation.
 */

// Verified complete (2026-07-09, adversarial-review follow-up): `reply`
// and `stream_reply` are the ONLY two MCP tools whose payload is the
// model's free-text final-answer content reaching the user — the exact
// scope `final-answer-detect.ts`'s own docstring claims ("plain assistant
// transcript text instead of a `reply` / `stream_reply` tool call").
// Cross-checked the full tool surface in `telegram-plugin/bridge/bridge.ts`
// (`TOOL_SCHEMAS`, kept in sync with `gateway/gateway.ts`): `edit_message`
// explicitly does NOT ping/deliver a fresh answer (its own description says
// "send a new reply when a long task completes"); `react`, `pin_message`,
// `delete_message`, `forward_message`, `send_typing`, `download_attachment`,
// `get_recent_messages` carry no model-authored answer text at all;
// `send_checklist` / `send_sticker` / `send_gif` / `ask_user` /
// `update_checklist` deliver structured/templated content, not the turn's
// prose answer, and are intentionally a different interaction pattern (a
// question or a fixed artifact, not "the answer"). `stream_reply` sends its
// FULL cumulative text snapshot on every call (not incremental chunks —
// see `stream-reply-handler.ts` docstring), and each call is its own
// `tool_use` block in the transcript in chronological order, so the
// "last delivery event wins" walk below already treats a stream's final
// (`done:true`) call as the qualifying one regardless of how many
// intermediate non-final `stream_reply` calls preceded it. No gap found;
// re-verify only if a new outbound-delivery tool is added to bridge.ts.
import { statSync } from 'node:fs'
import { join } from 'node:path'

const REPLY_TOOLS = new Set([
  'mcp__switchroom-telegram__reply',
  'mcp__switchroom-telegram__stream_reply',
])
const FINAL_ANSWER_MIN_CHARS = 200
// Match the gateway's silent-marker classifier (gateway.ts:6692 — the
// `isSilentFlushMarker` helper accepts trailing punctuation + case
// variants like "NO_REPLY." / "no_reply").
const SILENT_MARKER_RE = /^(NO_REPLY|HEARTBEAT_OK)[\s.!?]*$/i

/**
 * True when `text`'s final non-empty line is a bare silent marker
 * (NO_REPLY / HEARTBEAT_OK + optional trailing punctuation), regardless
 * of what precedes it. Closes #2053: a turn that emits prose then a
 * trailing bare `NO_REPLY` line is the model explicitly signalling
 * "intentionally silent". The anchored `SILENT_MARKER_RE` only matches
 * when the ENTIRE trimmed output is the bare marker, so prose+NO_REPLY
 * slipped through → the hook blocked → nag loop → sentinel leak.
 *
 * Approximately mirrors `turn-flush-safety.ts:endsWithSilentMarker` (TS
 * gateway side). NOT byte-identical: this .mjs uses `SILENT_MARKER_RE`
 * directly (no length cap, unlimited trailing punctuation), whereas the
 * TS side delegates to `isSilentFlushMarker` (length-capped, single
 * trailing punct). This side is intentionally the more permissive of the
 * two; the divergence is benign in direction — both suppress the common
 * `prose\nNO_REPLY` shape, and the extra leniency here only ever
 * suppresses MORE (never leaks, never wrongly silences a user-awaited
 * reply, which is gated separately).
 *
 * @param {string} text
 * @returns {boolean}
 */
export function endsWithSilentMarker(text) {
  if (typeof text !== 'string') return false
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  if (lines.length === 0) return false
  return SILENT_MARKER_RE.test(lines[lines.length - 1])
}

/**
 * Predicate ported from `telegram-plugin/final-answer-detect.ts:78-83`.
 * Kept in this .mjs so the hook is fully self-contained (no TS import).
 * If the TS file ever diverges, the test fixture below (T14) catches it.
 */
export function isFinalAnswerReply({ text, disableNotification, done }) {
  if (done === true) return true
  if (!disableNotification) return true
  if ((text ?? '').length >= FINAL_ANSWER_MIN_CHARS) return true
  return false
}

/**
 * Parse a `<channel ...>` envelope's chat_id and message_thread_id
 * attributes. Same shape session-tail.ts:125-140 uses to derive these
 * from the enqueue line's `content` string.
 *
 * Returns `null` if the envelope can't be parsed (caller treats as
 * "no turn key derivable" and writes a turnKey-less state file —
 * still functional, just loses retry-count preservation across the
 * hook→gateway write order).
 *
 * @param {string} content
 * @returns {{ chatId: string | null, threadId: number | null }}
 */
function parseChannelEnvelope(content) {
  if (typeof content !== 'string') {
    return { chatId: null, threadId: null, messageId: null, source: null }
  }
  const chatMatch = content.match(/chat_id="([^"]+)"/)
  const threadMatch = content.match(/message_thread_id="([^"]+)"/)
  // LEFT-ANCHOR the message_id match on an attribute boundary (start-of-string
  // or a whitespace/quote before the name) so it matches ONLY the real
  // `message_id` attribute — never a same-suffix sibling like
  // `target_message_id`, `reply_to_message_id`, or `original_message_id`.
  // Byte-identical to session-tail.ts `parseChannelMeta`'s `grab('message_id')`
  // so the turnId the hook derives here matches the gateway's `deriveTurnId`
  // exactly (Finding 3, #3228).
  const msgMatch = content.match(/(?:^|[\s"'])message_id="([^"]+)"/)
  const sourceMatch = content.match(/<channel[^>]*\bsource="([^"]+)"/)
  const threadRaw = threadMatch ? Number(threadMatch[1]) : NaN
  return {
    chatId: chatMatch ? chatMatch[1] : null,
    threadId: Number.isFinite(threadRaw) && threadRaw !== 0 ? threadRaw : null,
    messageId: msgMatch ? msgMatch[1] : null,
    source: sourceMatch ? sourceMatch[1] : null,
  }
}

/**
 * Build the turnKey the gateway will use for `recordSilentTurnEnd`'s
 * write of the state file. Matches `chatKey(chatId, threadId)` shape
 * at `gateway/chat-key.ts:46`: `${chatId}:${threadId || '_'}`.
 *
 * @param {string} chatId
 * @param {number | null} threadId
 * @returns {string}
 */
function buildTurnKey(chatId, threadId) {
  return `${chatId}:${threadId == null || threadId === 0 ? '_' : threadId}`
}

/**
 * Build the per-turn nonce the gateway stamps as `CurrentTurn.turnId`
 * (`gateway.ts deriveTurnId` → `${chatKey(chatId, threadId)}#${messageId}`).
 * Unlike `buildTurnKey` (the STABLE `chatId:threadId` statusKey, shared by
 * every turn on the same chat/thread), this is unique per inbound message —
 * so a stale captured-prose record from a PRIOR turn on the same chat can
 * never be misdelivered on a LATER turn (Finding 3, #3228). Returns null when
 * the enqueue envelope carries no usable message_id (synthetic inbounds); the
 * gateway then falls back to the turnKey-only match, unchanged.
 *
 * @param {string | null} chatId
 * @param {number | null} threadId
 * @param {string | null} messageId
 * @returns {string | null}
 */
function buildTurnId(chatId, threadId, messageId) {
  if (chatId == null) return null
  if (messageId == null || messageId === '' || String(messageId) === '0') return null
  return `${buildTurnKey(chatId, threadId)}#${messageId}`
}

/**
 * Build the `{ decided: 'block', ... }` result shape, populating
 * `turnKey`/`chatId`/`threadId` from the enqueue envelope when
 * available. Shared by both block branches below.
 *
 * @param {ReturnType<typeof parseChannelEnvelope>} envelope
 * @param {string} reason
 * @param {string} [pendingText] The substantive undelivered final-answer
 *   prose the model wrote as plain transcript text but never sent through a
 *   reply tool (Option A transcript-prose bridge). Only populated when it
 *   clears the substance floor, so the gateway never re-delivers a short
 *   trailing pleasantry. Omitted entirely otherwise.
 */
function buildBlockResult(envelope, reason, pendingText, hasTrailingProse) {
  const block = { decided: 'block', reason }
  // Single-writer election input (#duplicate-message fix): does ANY
  // non-empty, non-silent trailing text block exist after the last
  // delivery event? The zero-reply election allows only when this is
  // true — `decideTurnFlush` has no length floor, so any non-empty
  // non-silent captured text WILL flush; but a turn with NO trailing
  // prose at all (tool calls only) has nothing for any delivery
  // machine to send and must keep blocking.
  if (hasTrailingProse === true) block.hasTrailingProse = true
  if (envelope.chatId) {
    block.chatId = envelope.chatId
    block.threadId = envelope.threadId
    block.turnKey = buildTurnKey(envelope.chatId, envelope.threadId)
    // Per-turn nonce (Finding 3, #3228). Populated only when the enqueue
    // envelope carried a real message_id — the gateway requires it to match
    // this turn's `turnId` before delivering `pendingText`, so a stale record
    // carried over from a prior turn on the same chat/thread is rejected.
    const turnId = buildTurnId(envelope.chatId, envelope.threadId, envelope.messageId)
    if (turnId != null) block.turnId = turnId
  }
  if (typeof pendingText === 'string' && pendingText.length > 0) {
    block.pendingText = pendingText
  }
  return block
}

/**
 * Scan a JSONL transcript and decide whether the current turn ended
 * with a final reply delivered.
 *
 * Returns:
 *   { decided: 'allow', reason }    — qualifying reply OR silent marker found,
 *                                     and nothing undelivered was written
 *                                     after it
 *   { decided: 'block', reason, turnKey?, chatId?, threadId? }
 *                                   — turn-start found, no qualifying reply
 *                                     delivered (or a qualifying reply
 *                                     happened, but the model kept writing
 *                                     plain-text content afterward that was
 *                                     never sent through a delivery tool).
 *                                     `turnKey`/`chatId`/`threadId` populated
 *                                     from the enqueue's channel envelope so
 *                                     the hook can write a state file shape
 *                                     that matches what the gateway's
 *                                     `recordSilentTurnEnd` would write —
 *                                     keeping the retry-count preservation
 *                                     gate at `silent-end.ts:114` happy when
 *                                     the gateway's later write reads back
 *                                     the hook's state.
 *   { decided: 'unknown', reason }  — couldn't locate turn-start; caller fail-open
 *
 * On a 'block' decision the result MAY carry `pendingText`: the substantive
 * final-answer prose the model wrote as plain transcript text after the last
 * delivery event (or the whole turn's prose when nothing was ever delivered),
 * joined and trimmed. This is the Option A transcript-prose bridge — the
 * gateway reads it back out of the state file and delivers it directly on the
 * first silent-end instead of waiting for the model re-prompt / obligation
 * represent to eventually recover it. Only surfaced when it clears the same
 * FINAL_ANSWER_MIN_CHARS substance floor the block decision uses.
 *
 * Turn-start anchor: the most recent `queue-operation`/`enqueue` line
 * (the inbound message the gateway pushed onto the session). For
 * queued mid-turn messages (multiple `enqueue` lines per "turn"), we
 * anchor on the LAST enqueue — the model is responsible for at least
 * the most recent message. (Mild over-allow risk on the multi-enqueue
 * edge case where the model replied combined ahead of the second
 * enqueue's append; accepted residual.)
 *
 * IMPORTANT — trailing-content check (fixes the "at least once" bug):
 * a naive scan that returns 'allow' on the FIRST qualifying reply it
 * finds is wrong. A turn can legitimately call `reply` early (e.g. a
 * notification-bearing interim ack — `disable_notification` unset/false
 * always qualifies as "final" under `isFinalAnswerReply`, regardless of
 * how short the text is) and then keep working, eventually writing a
 * SUBSTANTIVE plain-text verdict that never goes through `reply` again.
 * The early ack satisfied "reply was called somewhere in this turn",
 * but the user never saw the actual answer. So this scan does NOT
 * short-circuit on the first match: it walks the ENTIRE turn in
 * chronological order, remembers the position of the LAST qualifying
 * delivery event (a final-answer reply/stream_reply call, or an
 * explicit silent-marker), and then checks whether any plain assistant
 * text block appears AFTER that position. If one does, that content was
 * written but never delivered — block, same as the zero-reply case.
 *
 * This deliberately does NOT flag a turn that ends on a delivery
 * tool_use with nothing after it (the normal, healthy shape), nor a
 * turn where all assistant text precedes the final delivering reply
 * (the model narrating before it sends) — only text that comes AFTER
 * the last delivery event counts as a drop.
 *
 * Substance floor (#2956 review): the trailing-text check only BLOCKS
 * when the trailing text is SUBSTANTIVE — at least FINAL_ANSWER_MIN_CHARS
 * (the same bar `isFinalAnswerReply` uses to recognise a real answer). A
 * SHORT trailing pleasantry / closer after a delivered reply ("Let me
 * know if you need anything else.") is not a dropped answer and must not
 * trigger a re-prompt (no-spam / single-answer invariant). A long
 * trailing verdict the model forgot to send still blocks. The floor keeps
 * the "at least once" guarantee for real dropped answers while stopping a
 * false-positive that burned retry budget on healthy turns.
 *
 * @param {string} jsonl
 * @returns {{ decided: 'allow' | 'block' | 'unknown', reason: string, turnKey?: string, turnId?: string, chatId?: string, threadId?: number | null, pendingText?: string }}
 */
export function scanTurnForFinalReply(jsonl) {
  const lines = jsonl.split('\n')

  // 1. Walk backward to most-recent queue-operation/enqueue.
  let startIdx = -1
  let envelope = { chatId: null, threadId: null, source: null }
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line || line[0] !== '{') continue
    let obj
    try { obj = JSON.parse(line) } catch { continue }
    if (obj?.type === 'queue-operation' && obj.operation === 'enqueue') {
      startIdx = i
      envelope = parseChannelEnvelope(obj.content)
      break
    }
  }
  if (startIdx < 0) {
    return { decided: 'unknown', reason: 'no-turn-start' }
  }

  // 2. Flatten every assistant content block (text and tool_use) from
  //    the turn into a single chronologically-ordered list. Classify
  //    each block as it's collected: a "delivery" event (qualifying
  //    final-answer reply/stream_reply, or an explicit silent marker —
  //    whether emitted as plain text or as a reply-tool payload) or
  //    plain undelivered text.
  const blocks = []
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line || line[0] !== '{') continue
    let obj
    try { obj = JSON.parse(line) } catch { continue }
    // Skip sub-agent contamination (defensive — sub-agent lines should
    // be in a separate transcript file, but `isSidechain:true` is the
    // documented marker if they leak).
    if (obj?.isSidechain === true) continue
    if (obj?.type !== 'assistant') continue
    const content = obj?.message?.content
    if (!Array.isArray(content)) continue
    for (const c of content) {
      if (c?.type === 'text') {
        // Plain assistant text carve-out (#2053): a turn that ends with
        // a trailing bare NO_REPLY / HEARTBEAT_OK line — emitted as
        // plain transcript text, NOT through the reply tool — is the
        // model explicitly signalling "intentionally silent". Treat a
        // trailing-marker text block as a delivery/silence event;
        // anything else is candidate undelivered content.
        if (endsWithSilentMarker(String(c.text ?? ''))) {
          blocks.push({ kind: 'deliver', reason: 'silent-marker-text' })
        } else if (String(c.text ?? '').trim().length > 0) {
          // Carry the trimmed char count so the trailing-content check
          // (step 3) can apply a substance floor: a SHORT trailing text
          // after a delivered reply (a pleasantry / closer like "Let me
          // know if you need anything else.") is NOT a dropped answer and
          // must not trigger a re-prompt (no-spam invariant). Only
          // SUBSTANTIVE trailing text — at least FINAL_ANSWER_MIN_CHARS,
          // the same bar `isFinalAnswerReply` uses to recognise a real
          // answer — counts as "undelivered content the user was waiting
          // on". #2956 review finding.
          //
          // Carry the trimmed text itself too (Option A transcript-prose
          // bridge): when this turn ends up blocked, the joined undelivered
          // text becomes `pendingText` so the gateway can deliver the model's
          // real answer directly. Trimmed per-block; joined below.
          blocks.push({
            kind: 'text',
            chars: String(c.text ?? '').trim().length,
            text: String(c.text ?? '').trim(),
          })
        }
        continue
      }
      if (c?.type !== 'tool_use') continue
      if (!REPLY_TOOLS.has(c.name)) continue
      const input = c.input ?? {}
      const text = String(input.text ?? '')
      // Silent-marker carve-out: the operator explicitly signaled
      // "intentionally silent" (cron HEARTBEAT_OK, model-driven
      // NO_REPLY). Accept both the whole-text bare marker and the
      // prose+trailing-marker shape (#2053). Same posture as the
      // gateway's silent-marker suppression at gateway.ts:6692.
      if (SILENT_MARKER_RE.test(text.trim()) || endsWithSilentMarker(text)) {
        blocks.push({ kind: 'deliver', reason: 'silent-marker' })
        continue
      }
      if (isFinalAnswerReply({
        text,
        disableNotification: input.disable_notification === true,
        done: input.done === true,
      })) {
        blocks.push({ kind: 'deliver', reason: 'final-reply' })
        continue
      }
      // Non-qualifying reply call (interim ack) — delivered to the
      // user, but not a "final answer". It's neither a delivery event
      // nor undelivered text, so it doesn't affect the decision either
      // way; simply not pushed.
    }
  }

  // 3. Find the LAST delivery event's position, then check whether any
  //    plain-text block appears strictly after it. This is the fix for
  //    the "at least once" bug: a naive scan that stops at the FIRST
  //    qualifying reply misses substantive content the model wrote
  //    afterward and never (re-)sent.
  let lastAllowBlockIdx = -1
  let lastAllowReason = null
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].kind === 'deliver') {
      lastAllowBlockIdx = i
      lastAllowReason = blocks[i].reason
    }
  }
  const undeliveredSlice = blocks.slice(lastAllowBlockIdx + 1)
  const sawUndeliveredTextAfterAllow = undeliveredSlice
    .some((b) => b.kind === 'text' && (b.chars ?? 0) >= FINAL_ANSWER_MIN_CHARS)

  // Option A transcript-prose bridge: isolate the undelivered final-answer
  // prose so the gateway can deliver it directly.
  //
  // Finding 2 (#3228): a real dropped answer is a SINGLE substantive block —
  // NOT concatenated inter-tool narration ("Let me check…", "Still querying…")
  // that only crosses the floor once joined. The old code joined ALL post-
  // delivery text blocks and surfaced the join whenever the COMBINED length
  // hit the floor, so a run of short narration masqueraded as a final answer
  // (and in the zero-delivery case that join was every text block in the
  // turn). Instead, deliver only the LAST block that CLEARS the substance
  // floor ON ITS OWN. This mirrors the block decision itself
  // (`sawUndeliveredTextAfterAllow`, which requires a single ≥floor block) and
  // handles the "big answer then short closer" shape by delivering the answer,
  // not the closer. When no single block clears the floor, `pendingText` stays
  // undefined and the gateway falls through to the re-prompt / represent nets.
  const substantiveBlocks = undeliveredSlice.filter(
    (b) =>
      b.kind === 'text' &&
      typeof b.text === 'string' &&
      (b.chars ?? 0) >= FINAL_ANSWER_MIN_CHARS,
  )
  const pendingText =
    substantiveBlocks.length > 0
      ? substantiveBlocks[substantiveBlocks.length - 1].text
      : undefined
  const trailingTextBlocks = undeliveredSlice.filter(
    (b) => b.kind === 'text' && typeof b.text === 'string' && b.text.length > 0,
  )
  const hasTrailingProse = trailingTextBlocks.length > 0
  // Capture-divergence bridge (#duplicate-message fix): in the ZERO-reply
  // case, persist the last trailing block even when no single block clears
  // the 200-char substance floor. The gateway's flush normally delivers any
  // non-empty captured text, but when the gateway's own capture diverged
  // (captured empty) the captured-prose bridge is the only delivery machine
  // left, and it reads `pendingText` — the gateway lowers `minChars` for
  // exactly this corner (`capturedProseMinCharsFor`, silent-end.ts). The
  // interim-ack case (`trailing-text-after-reply`) keeps the substantive
  // floor unchanged — a short closer after a real reply is not a dropped
  // answer.
  //
  // Scoped to the SINGLE-trailing-block shape so the #3228 Finding 2 guard is
  // preserved: a RUN of short narration blocks ("Let me check…", "Still
  // querying…") must still yield NO pendingText (never masquerade a joined
  // narration run as an answer). A single trailing block IS the real
  // short-answer shape the model produces when it writes one plain-text reply.
  const zeroReplyPendingText =
    pendingText ??
    (trailingTextBlocks.length === 1 ? trailingTextBlocks[0].text : undefined)

  if (lastAllowBlockIdx === -1) {
    // No qualifying delivery/silence event anywhere in the turn.
    // Cron-fired turns (#2053): a scheduled turn that produced no
    // qualifying reply is NOT a delivery failure the user is waiting
    // on — nagging it only pushes the model to escape the loop by
    // shoving a NO_REPLY sentinel through the reply tool, which leaks
    // to chat. A cron turn that genuinely needs to speak will have
    // called reply (caught above); otherwise let it end silently.
    if (envelope.source === 'cron') {
      return { decided: 'allow', reason: 'cron-source' }
    }
    return buildBlockResult(envelope, 'no-final-reply', zeroReplyPendingText, hasTrailingProse)
  }

  if (sawUndeliveredTextAfterAllow) {
    // A qualifying delivery DID happen somewhere in the turn, but the
    // model kept writing after it and that trailing content was never
    // sent through a delivery tool. This is the "at least once" bug:
    // an early ack (or any qualifying reply) must not amnesty
    // everything written afterward.
    return buildBlockResult(envelope, 'trailing-text-after-reply', pendingText, hasTrailingProse)
  }

  return { decided: 'allow', reason: lastAllowReason }
}

// ── Single-writer election (duplicate-message fix) ───────────────────
//
// RCA: when a turn ends with its final answer as plain transcript text,
// TWO uncoordinated recovery paths both fire — (A) the gateway's
// deterministic turn-end flush (`decideTurnFlush` /
// `answer-ready-flush.ts`) delivers the captured transcript prose, AND
// (B) this Stop hook blocks and re-prompts the model, which regenerates
// a REWORDED reply that defeats the exact-match dedup
// (`flushed-turn-supersede.ts` `flushedAnswerMatchesReply`). The user
// gets two near-identical messages.
//
// Fix: the Stop hook is the single elector. On a would-BLOCK scan it
// ALLOWS the stop (still persisting the state file so the gateway's
// delivery machines have their input) IFF it can PROVE a gateway
// delivery machine will handle the trailing prose. Every gate below
// exists to prevent a DROP (worse than a duplicate):
//
//   1. deliverable trailing prose exists AND the right machine covers it
//      - zero-reply (`no-final-reply`): ANY non-empty non-silent
//        trailing prose — `decideTurnFlush` has no length floor and
//        flushes any non-empty non-silent captured text. (No 200-char
//        floor here.)
//      - interim-ack (`trailing-text-after-reply`, replyCalled=true):
//        ONLY the captured-prose bridge delivers there (the flush skips
//        on reply-called), and its floor is 200 — so short trailing
//        text after a real reply keeps BLOCKING (no duplicate exists in
//        that case today).
//   2. the governing delivery flag is enabled (read by the hook from
//      its own env): zero-reply needs the turn-flush-safety flag AND
//      the captured-prose flag (the bridge is the capture-divergence
//      backstop when the gateway captured empty); interim-ack needs the
//      captured-prose flag. Flag off → the machine won't fire → BLOCK.
//   3. retryCount === 0 — a prior failed delivery must fall back to
//      today's BLOCK, preserving the #3228 send-failure recovery net.
//   4. gateway liveness — the gateway heartbeat file must be FRESH.
//      Allowing into a dead gateway is the one drop worse than a
//      duplicate; when liveness can't be established, BLOCK.
//
// Pure and deterministic: the hook wrapper does the IO (env read, stat,
// state-file write) and maps this verdict to exit-0-allow vs
// decision:block.

/**
 * @param {{
 *   scan: ReturnType<typeof scanTurnForFinalReply>,
 *   retryCount: number,
 *   turnFlushSafetyEnabled: boolean,
 *   capturedProseDeliveryEnabled: boolean,
 *   gatewayLive: boolean,
 * }} input
 * @returns {{ action: 'allow-scan' | 'allow-elected' | 'block', reason: string }}
 */
export function decideStopHookDisposition(input) {
  const {
    scan,
    retryCount,
    turnFlushSafetyEnabled,
    capturedProseDeliveryEnabled,
    gatewayLive,
  } = input
  if (scan == null || scan.decided !== 'block') {
    return { action: 'allow-scan', reason: `scan-${scan?.decided ?? 'unknown'}` }
  }
  // Gate 4 — never allow into a possibly-dead gateway.
  if (gatewayLive !== true) {
    return { action: 'block', reason: 'gateway-liveness-not-fresh' }
  }
  // Gate 3 — a retry ladder already in flight means a prior delivery
  // attempt failed; today's BLOCK is the recovery net (#3228).
  if (retryCount !== 0) {
    return { action: 'block', reason: 'retry-ladder-in-flight' }
  }
  if (scan.reason === 'no-final-reply') {
    // Gate 2 (zero-reply): the turn-end flush is the delivery machine;
    // the captured-prose bridge is the capture-divergence backstop.
    if (!turnFlushSafetyEnabled) {
      return { action: 'block', reason: 'turn-flush-flag-disabled' }
    }
    if (!capturedProseDeliveryEnabled) {
      return { action: 'block', reason: 'captured-prose-flag-disabled' }
    }
    // Gate 1 (zero-reply): any non-empty non-silent trailing prose.
    if (scan.hasTrailingProse !== true) {
      return { action: 'block', reason: 'no-trailing-prose' }
    }
    return { action: 'allow-elected', reason: 'flush-will-deliver' }
  }
  if (scan.reason === 'trailing-text-after-reply') {
    // Gate 2 (interim-ack): only the captured-prose bridge delivers here.
    if (!capturedProseDeliveryEnabled) {
      return { action: 'block', reason: 'captured-prose-flag-disabled' }
    }
    // Gate 1 (interim-ack): the bridge's substance floor is 200 chars
    // (CAPTURED_PROSE_MIN_CHARS, silent-end.ts). Below it the bridge
    // will NOT deliver — keep blocking (matches today: no duplicate
    // exists for short trailing text after a real reply).
    if (
      typeof scan.pendingText !== 'string' ||
      scan.pendingText.trim().length < FINAL_ANSWER_MIN_CHARS
    ) {
      return { action: 'block', reason: 'short-trailing-after-reply' }
    }
    return { action: 'allow-elected', reason: 'bridge-will-deliver' }
  }
  // Unknown block reason — conservatively keep today's behaviour.
  return { action: 'block', reason: `unrecognized-scan-reason-${scan.reason}` }
}

/**
 * Mirror of `isTurnFlushSafetyEnabled` (`turn-flush-safety.ts:392-400`).
 * Kept in this .mjs so the hook is self-contained (no TS import); MUST
 * stay in sync — default ON, disabled by `0` / `false` / `off` / `no`.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {boolean}
 */
export function isTurnFlushSafetyEnabledEnv(env) {
  const raw = env.SWITCHROOM_TG_TURN_FLUSH_SAFETY
  if (raw == null) return true
  const v = raw.trim().toLowerCase()
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no')
}

/**
 * Mirror of `CAPTURED_PROSE_DELIVERY_ENABLED` (`gateway/gateway.ts` —
 * `SWITCHROOM_TG_CAPTURED_PROSE_DELIVERY !== '0'`). MUST stay in sync.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {boolean}
 */
export function isCapturedProseDeliveryEnabledEnv(env) {
  return env.SWITCHROOM_TG_CAPTURED_PROSE_DELIVERY !== '0'
}

// MUST stay in sync with gateway/gateway-heartbeat.ts (the hook is a
// standalone .mjs and can't import the TS module). The gateway touches
// the file every GATEWAY_HEARTBEAT_INTERVAL_MS (15s); freshness bound is
// 4 intervals — conservative against scheduler jitter, small enough that
// a dead gateway is detected before its stale heartbeat can swallow more
// than one turn's election.
export const GATEWAY_HEARTBEAT_FILE = 'gateway-heartbeat'
export const GATEWAY_HEARTBEAT_FRESH_MS = 60_000

/**
 * Gate 4 IO helper: is the gateway heartbeat file fresh? Missing,
 * unstattable, or stale ⇒ false (BLOCK — never allow into a possibly-
 * dead gateway).
 *
 * @param {string} stateDir
 * @param {number} [now]
 * @returns {boolean}
 */
export function isGatewayHeartbeatFresh(stateDir, now = Date.now()) {
  try {
    const st = statSync(join(stateDir, GATEWAY_HEARTBEAT_FILE))
    return now - st.mtimeMs <= GATEWAY_HEARTBEAT_FRESH_MS
  } catch {
    return false
  }
}
