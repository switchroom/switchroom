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
// "send a new reply when a long task completes"); `react`,
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
import { createHash } from 'node:crypto'
import {
  isNarrationBlock,
  isEphemeralTool,
  selectBackstopDelivery,
  SUBSTANTIVE_MIN_CHARS,
} from './narration-classify.mjs'

const REPLY_TOOLS = new Set([
  'mcp__switchroom-telegram__reply',
  'mcp__switchroom-telegram__stream_reply',
])
const FINAL_ANSWER_MIN_CHARS = SUBSTANTIVE_MIN_CHARS
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

// The narration heuristic (`isNarrationBlock`) and the STRUCTURAL rule
// (`isStructuralNarration`) live in the ONE shared classifier
// `./narration-classify.mjs`, imported at the top. Before switchroom#3513 this
// `.mjs` carried a byte-parallel COPY of the TS heuristic with a "MUST stay in
// sync" comment — the exact hand-synced drift that let intent-narration leak.
// Both the bundled gateway TS (`turn-flush-safety.ts`) and this unbundled hook
// now import the same module, so a single edit governs every classifier.

/**
 * Choose the prose the captured-prose bridge should deliver from the trailing
 * text blocks in the ZERO-reply case, mirroring `selectFlushDeliveryText`
 * (`turn-flush-safety.ts:198-232`). `texts` are already trimmed non-empty.
 *
 *   - 0 blocks   → undefined (nothing to deliver).
 *   - 1 block    → that block (the real single-block short-answer shape;
 *                  persisted even below the substance floor so the lowered-
 *                  floor capture-divergence corner can deliver it).
 *   - ≥2 blocks  → strip leading narration exactly as the flush does: if EVERY
 *                  preceding block is narration, deliver only the terminal
 *                  block; otherwise JOIN all blocks with a paragraph break (a
 *                  genuine multi-paragraph answer split across blocks). When
 *                  the result is narration-only (terminal block is itself
 *                  narration AND all preceding are narration) → undefined, so a
 *                  pure narration run never masquerades as an answer (#3228
 *                  Finding 2 parity).
 *
 * @param {string[]} texts
 * @returns {string | undefined}
 */
export function selectBridgePendingText(texts) {
  const candidates = texts.map((t) => t.trim()).filter((t) => t.length > 0)
  if (candidates.length === 0) return undefined
  if (candidates.length === 1) return candidates[0]
  const answer = candidates[candidates.length - 1]
  const preceding = candidates.slice(0, -1)
  const allPrecedingNarration = preceding.every((b) => isNarrationBlock(b))
  if (allPrecedingNarration) {
    // Deliver only the terminal block — unless it too is pure narration, in
    // which case the whole run is narration and there is no answer to bridge.
    return isNarrationBlock(answer) ? undefined : answer
  }
  // A preceding block carries real content → keep the whole answer joined so a
  // multi-block answer is never truncated to its last paragraph.
  return candidates.join('\n\n')
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
 * @param {boolean} [replyToolThrewThisTurn] W1-d follow-up (#4141): one of this
 *   turn's reply-tool calls came back `is_error: true`. Carried on the BLOCK
 *   result so the single-writer election can persist it onto the silent-end
 *   state file — the captured-prose bridge (the machine that actually delivers
 *   on the ELECTED path, where no outbox record is ever written) has no other
 *   way to learn it. A raw SIGNAL, never a verdict: downstream it only ever
 *   adds a provenance banner. Omitted rather than `false` when absent, so a
 *   spread of a prior state file cannot be read as positive evidence.
 */
function buildBlockResult(envelope, reason, pendingText, hasTrailingProse, replyToolThrewThisTurn) {
  const block = { decided: 'block', reason }
  if (replyToolThrewThisTurn === true) block.replyToolThrewThisTurn = true
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
  // W1-d follow-up (#4141): the same reply-throw signal `scanForOutboxCapture`
  // already derives, computed here too because the ELECTED path never reaches
  // that scanner's capture branch (a thrown-but-qualifying reply sets
  // `replyAlreadyDeliveredThisTurn`, so the hook defers to the election and
  // writes NO outbox record). Collected as two id sets whose intersection is
  // the signal. Read-only: nothing below branches on it, so no verdict of this
  // scanner changes.
  const replyToolUseIds = new Set()
  const erroredToolUseIds = new Set()
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line || line[0] !== '{') continue
    let obj
    try { obj = JSON.parse(line) } catch { continue }
    // Skip sub-agent contamination (defensive — sub-agent lines should
    // be in a separate transcript file, but `isSidechain:true` is the
    // documented marker if they leak).
    if (obj?.isSidechain === true) continue
    if (obj?.type === 'user') {
      // Tool RESULT lines: `user`-type, content array carrying
      // `{type:'tool_result', tool_use_id, is_error}`. Same shape read by
      // `scanForOutboxCapture` (#3865).
      const rc = obj?.message?.content
      if (!Array.isArray(rc)) continue
      for (const r of rc) {
        if (r?.type !== 'tool_result') continue
        if (r?.is_error !== true) continue
        if (typeof r.tool_use_id !== 'string') continue
        erroredToolUseIds.add(r.tool_use_id)
      }
      continue
    }
    if (obj?.type !== 'assistant') continue
    const content = obj?.message?.content
    if (!Array.isArray(content)) continue
    for (let ci = 0; ci < content.length; ci++) {
      const c = content[ci]
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
          //
          // #3513 follow-up (MF1): carry the block's text/length; the STRUCTURAL
          // provenance `followedByToolUse` is NOT computed per-message here (the
          // old `content.slice(ci+1)` only saw a tool later in this SAME message,
          // missing the cross-message shape [text-only message] → [tool_use in the
          // NEXT message]). It is filled by the PER-TURN two-pass below, which
          // sees a turn-continuing tool_use ANYWHERE later in the turn.
          blocks.push({
            kind: 'text',
            chars: String(c.text ?? '').trim().length,
            text: String(c.text ?? '').trim(),
            followedByToolUse: false,
          })
        }
        continue
      }
      if (c?.type !== 'tool_use') continue
      if (!REPLY_TOOLS.has(c.name)) {
        // #3513 follow-up (MF1): a turn-CONTINUING tool_use (any tool NOT in the
        // ephemeral surface set and NOT a reply tool) is the deterministic signal
        // that every PRIOR text block — including ones in earlier messages — was
        // intra-turn narration. Record it as an ordered provenance marker so the
        // two-pass below can retro-mark those blocks. Ephemeral surface tools
        // (react / pin / typing / edit / delete) are NOT turn-continuing: a text
        // block followed only by them is still the terminal answer.
        if (!isEphemeralTool(c.name)) {
          blocks.push({ kind: 'work-tool' })
        }
        continue
      }
      // #4141: EVERY reply-tool call's id, qualifying or not — an interim ack
      // that threw is still a reply-tool throw.
      if (typeof c.id === 'string') replyToolUseIds.add(c.id)
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

  // 2b. #3513 follow-up (MF1) — PER-TURN two-pass structural provenance. Walk
  //     the flattened blocks in REVERSE and mark each text block
  //     `followedByToolUse` iff a turn-continuing tool_use (`kind:'work-tool'`,
  //     recorded above for any non-ephemeral, non-reply tool) appears LATER
  //     anywhere in the turn — not just later in its own message. This is the
  //     root-cause fix: the per-message computation missed the cross-message
  //     shape ([text-only message] → [tool_use in the NEXT message]), leaking
  //     intra-turn narration to the bridge/sweep. A `deliver` (reply-tool) marker
  //     does NOT reset the flag: reply provenance is handled by the deliver
  //     cursor (lastAllowBlockIdx), not the structural mark.
  {
    let sawWorkToolLater = false
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i]
      if (b.kind === 'work-tool') {
        sawWorkToolLater = true
        continue
      }
      if (b.kind === 'text') b.followedByToolUse = sawWorkToolLater
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
  // #3513 follow-up — the ONE shared backstop coalescer selects the terminal
  // delivery from the trailing text blocks (in source order, carrying the
  // per-TURN structural provenance filled by the two-pass above).
  // `selectBackstopDelivery` UNCONDITIONALLY excludes any block a
  // turn-continuing tool followed (no length/wording gate — the #3515 substance
  // heuristic is gone on the backstop path) and joins the maximal terminal
  // suffix run of non-tool-followed blocks. `null` ⇒ nothing deliverable
  // (pure narration run, or an empty-terminal fragment below the floor).
  const backstopBlocks = undeliveredSlice
    .filter((b) => b.kind === 'text' && typeof b.text === 'string')
    .map((b) => ({ text: b.text, followedByToolUse: b.followedByToolUse }))
  const backstopSelected = selectBackstopDelivery(backstopBlocks)
  const backstopText =
    backstopSelected != null && typeof backstopSelected.text === 'string'
      ? backstopSelected.text
      : undefined

  // The interim-ack path (`trailing-text-after-reply`) keeps the 200-char
  // substance floor: a short trailing closer after a real reply is not a
  // dropped answer. A qualifying delivery already happened, so blocking here
  // only re-nags for a genuine ≥floor dropped answer.
  const sawUndeliveredTextAfterAllow =
    backstopText != null && backstopText.trim().length >= FINAL_ANSWER_MIN_CHARS
  const pendingText =
    backstopText != null && backstopText.trim().length >= FINAL_ANSWER_MIN_CHARS
      ? backstopText
      : undefined
  // `hasTrailingProse` INTENTIONALLY still counts ANY non-empty trailing prose
  // (narration included): in the zero-reply case it gates the single-writer
  // election to ALLOW the stop (`flush-will-deliver`) rather than BLOCK+nag —
  // the gateway flush then suppresses the narration structurally (its own
  // `selectBackstopDelivery` returns null), so the turn ends silently (no leak,
  // no nag loop). Only the DELIVERED text is narrowed by the coalescer.
  const trailingTextBlocks = undeliveredSlice.filter(
    (b) => b.kind === 'text' && typeof b.text === 'string' && b.text.length > 0,
  )
  const hasTrailingProse = trailingTextBlocks.length > 0
  // Zero-reply / capture-divergence corner: the coalesced terminal run is the
  // deliverable prose regardless of the 200-char interim-ack floor — a real
  // answer split across ≥2 individually-sub-200 terminal blocks is joined by
  // `selectBackstopDelivery` (its terminal-run join has no floor), so the bridge
  // delivers the joined prose instead of dropping. A pure narration run still
  // yields `undefined` (the #3228 Finding 2 guard, now structural).
  const zeroReplyPendingText = backstopText
  // #4141 — one of this turn's reply-tool calls errored. Derived here, consumed
  // only by `buildBlockResult` below (and thence the elected state file); it
  // gates nothing in this scanner.
  const replyToolThrewThisTurn = [...replyToolUseIds].some((id) => erroredToolUseIds.has(id))

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
    return buildBlockResult(
      envelope, 'no-final-reply', zeroReplyPendingText, hasTrailingProse, replyToolThrewThisTurn,
    )
  }

  if (sawUndeliveredTextAfterAllow) {
    // A qualifying delivery DID happen somewhere in the turn, but the
    // model kept writing after it and that trailing content was never
    // sent through a delivery tool. This is the "at least once" bug:
    // an early ack (or any qualifying reply) must not amnesty
    // everything written afterward.
    return buildBlockResult(
      envelope, 'trailing-text-after-reply', pendingText, hasTrailingProse, replyToolThrewThisTurn,
    )
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

// ── Outbox capture (guaranteed final-message delivery) ───────────────────────
//
// The Stop hook fires on EVERY main-session turn end, regardless of what woke
// the turn (Telegram inbound, `<task-notification>` handback, cron, or a future
// harness wake type). `scanForOutboxCapture` decides — class-agnostically —
// whether this turn ended with substantive undelivered trailing prose that must
// be captured into the durable outbox for the gateway sweep to deliver.
//
// Fail CLOSED (H4): capture keys on "a turn ended with unsent trailing prose",
// never on recognising the wake shape. An anchor-less transcript tail still
// captures (source='unknown') rather than silently allowing a lost answer.
//
// Cron (H5): NOT exempted — a cron turn that ends with prose is captured and
// guaranteed-delivered, same as any other class. Only NO_REPLY stays silent.
//
// H6: a turn ending with real prose followed by a stray bare `NO_REPLY` still
// captures the prose (the marker doesn't suppress a genuine answer), while a
// legitimately-silent turn (pure NO_REPLY / narration-only) writes no record.

/** Mirror of `deriveTurnNonce` in `../outbox.ts` — MUST stay in sync (a .mjs
 * can't import the .ts). Test `outbox-nonce-parity` pins the equality. */
export function deriveTurnNonce({ chatId, threadId, messageId, anchorTimestampMs, anchorContent }) {
  if (chatId != null && messageId != null && messageId !== '' && String(messageId) !== '0') {
    const key = `${chatId}:${threadId == null || threadId === 0 ? '_' : threadId}`
    return `${key}#${messageId}`
  }
  return createHash('sha256').update(`${anchorTimestampMs}\n${anchorContent}`, 'utf8').digest('hex')
}

/**
 * Strip a trailing bare silent-marker line (NO_REPLY / HEARTBEAT_OK) from a text
 * block, returning the prose that precedes it (H6). If the whole block is the
 * marker, prose is ''. If there is no trailing marker, `hadMarker` is false and
 * prose is the block unchanged.
 *
 * @param {string} text
 * @returns {{ prose: string, hadMarker: boolean }}
 */
export function stripTrailingSilentMarker(text) {
  if (typeof text !== 'string') return { prose: '', hadMarker: false }
  const rawLines = text.split('\n')
  // Find the last non-empty line.
  let lastIdx = -1
  for (let i = rawLines.length - 1; i >= 0; i--) {
    if (rawLines[i].trim().length > 0) {
      lastIdx = i
      break
    }
  }
  if (lastIdx === -1) return { prose: '', hadMarker: false }
  if (!SILENT_MARKER_RE.test(rawLines[lastIdx].trim())) {
    return { prose: text.trim(), hadMarker: false }
  }
  const prose = rawLines.slice(0, lastIdx).join('\n').trim()
  return { prose, hadMarker: true }
}

/**
 * Resolve the turn-start anchor for capture. Primary: the most-recent
 * `queue-operation`/`enqueue` line. H4 fallbacks (fail closed) when none is
 * found: the last non-sidechain `user`-type line, else the last
 * `queue-operation` of any operation, else the whole scanned range (startIdx=-1
 * → scan from the top). `degraded` marks a non-primary anchor (source unknown).
 *
 * @param {string[]} lines
 * @returns {{ startIdx: number, envelope: ReturnType<typeof parseChannelEnvelope>, anchorTimestampMs: number, anchorContent: string, degraded: boolean }}
 */
function resolveCaptureAnchor(lines) {
  let enqueueIdx = -1
  let anyQueueIdx = -1
  let userIdx = -1
  const parsed = new Array(lines.length)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line || line[0] !== '{') continue
    let obj
    try { obj = JSON.parse(line) } catch { continue }
    parsed[i] = obj
    if (obj?.type === 'queue-operation') {
      if (obj.operation === 'enqueue' && enqueueIdx === -1) enqueueIdx = i
      if (anyQueueIdx === -1) anyQueueIdx = i
    }
    if (obj?.type === 'user' && obj?.isSidechain !== true && userIdx === -1) userIdx = i
  }
  const anchorTs = (obj) => {
    const t = obj?.timestamp
    if (typeof t === 'number' && Number.isFinite(t)) return t
    if (typeof t === 'string') {
      const ms = Date.parse(t)
      if (Number.isFinite(ms)) return ms
    }
    return Date.now()
  }
  if (enqueueIdx !== -1) {
    const obj = parsed[enqueueIdx]
    const content = typeof obj.content === 'string' ? obj.content : ''
    return {
      startIdx: enqueueIdx,
      envelope: parseChannelEnvelope(content),
      anchorTimestampMs: anchorTs(obj),
      anchorContent: content,
      degraded: false,
    }
  }
  if (userIdx !== -1) {
    const obj = parsed[userIdx]
    const content = typeof obj?.message?.content === 'string' ? obj.message.content : JSON.stringify(obj?.message?.content ?? '')
    return {
      startIdx: userIdx,
      envelope: { chatId: null, threadId: null, messageId: null, source: 'unknown' },
      anchorTimestampMs: anchorTs(obj),
      anchorContent: content,
      degraded: true,
    }
  }
  if (anyQueueIdx !== -1) {
    const obj = parsed[anyQueueIdx]
    const content = typeof obj.content === 'string' ? obj.content : ''
    return {
      startIdx: anyQueueIdx,
      envelope: parseChannelEnvelope(content),
      anchorTimestampMs: anchorTs(obj),
      anchorContent: content,
      degraded: true,
    }
  }
  // No anchor at all — scan the whole range (fail closed on unknown shape).
  return {
    startIdx: -1,
    envelope: { chatId: null, threadId: null, messageId: null, source: 'unknown' },
    anchorTimestampMs: Date.now(),
    anchorContent: '',
    degraded: true,
  }
}

/**
 * Resolve THIS session's origin chat — the most-recent non-sidechain enqueue
 * line whose content carries a real Telegram `<channel>` envelope with a
 * chatId. Scoped to the session's OWN transcript, this is the conversation of
 * record for an envelope-less handback turn (F2): the sweep routes an
 * unresolved-registry record here instead of a gateway-global "last chat anyone
 * messaged" fallback, so a DM-origin handback can never leak into an unrelated
 * chat. Null when the session has no prior channel inbound → the record fails
 * CLOSED (held, never delivered to an arbitrary chat).
 *
 * @param {string[]} lines
 * @returns {{ chatId: string | null, threadId: number | null }}
 */
function resolveSessionOriginChat(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line || line[0] !== '{') continue
    let obj
    try { obj = JSON.parse(line) } catch { continue }
    if (obj?.isSidechain === true) continue
    if (obj?.type !== 'queue-operation') continue
    const content = typeof obj.content === 'string' ? obj.content : ''
    const env = parseChannelEnvelope(content)
    if (env.chatId != null && env.chatId !== '') {
      return { chatId: env.chatId, threadId: env.threadId ?? null }
    }
  }
  return { chatId: null, threadId: null }
}

/**
 * Class-agnostic capture scan. Walks the turn from its anchor, tracking the last
 * delivery event (qualifying reply / silent marker) and the substantive prose
 * blocks that trail it. Returns a capture descriptor when the turn ended with
 * undelivered final-answer prose, else `{ capture: false }`.
 *
 * @param {string} jsonl
 * @param {number} [now]
 * @returns {{ capture: false, reason: string } | { capture: true, text: string, turnNonce: string, chatId: string|null, threadId: number|null, source: string, anchorContent: string, replyAlreadyDeliveredThisTurn: boolean, deliveredReplySha256: string|null, replyToolThrewThisTurn: boolean }}
 */
export function scanForOutboxCapture(jsonl, now = Date.now()) {
  const lines = jsonl.split('\n')
  const anchor = resolveCaptureAnchor(lines)
  const { envelope } = anchor

  const blocks = []
  // W1-d (#3865): ids of reply-tool `tool_use` blocks seen this turn, and the
  // ids whose `tool_result` came back `is_error: true`. Their intersection is
  // the "did the reply tool throw this turn" signal.
  const replyToolUseIds = new Set()
  const erroredToolUseIds = new Set()
  for (let i = anchor.startIdx + 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line || line[0] !== '{') continue
    let obj
    try { obj = JSON.parse(line) } catch { continue }
    if (obj?.isSidechain === true) continue
    // W1-d (#3865): tool RESULT lines are how a reply-tool THROW becomes
    // visible. Claude Code writes the result of a `tool_use` as a `user`-type
    // line whose content array carries `{type:'tool_result', tool_use_id,
    // is_error}`. Nothing in this scanner read those before, which is exactly
    // why an errored reply was indistinguishable from a delivered one — the
    // transcript shape is otherwise identical.
    if (obj?.type === 'user') {
      const rc = obj?.message?.content
      if (!Array.isArray(rc)) continue
      for (const r of rc) {
        if (r?.type !== 'tool_result') continue
        if (r?.is_error !== true) continue
        if (typeof r.tool_use_id !== 'string') continue
        erroredToolUseIds.add(r.tool_use_id)
      }
      continue
    }
    if (obj?.type !== 'assistant') continue
    const content = obj?.message?.content
    if (!Array.isArray(content)) continue
    for (let ci = 0; ci < content.length; ci++) {
      const c = content[ci]
      if (c?.type === 'text') {
        const raw = String(c.text ?? '')
        // H6: strip a trailing bare marker; if substantive non-narration prose
        // remains, it is a genuine (undelivered) answer — capture it. If nothing
        // but the marker (or narration) remains, the block is a silence event.
        const { prose, hadMarker } = stripTrailingSilentMarker(raw)
        // #3513 follow-up (MF1): `followedByToolUse` is filled by the PER-TURN
        // two-pass below (a turn-continuing tool_use later ANYWHERE in the turn),
        // not per-message — the cross-message shape needs the whole-turn view.
        if (hadMarker) {
          // H6: a block ending "…real answer…\nNO_REPLY" carries a genuine
          // answer — capture the prose and do NOT treat the block as a silence
          // event (which would mask the answer). When the prose is empty or pure
          // narration the marker is an intentional silence, but it must NOT emit
          // a 'deliver' event: a *separate* bare-`NO_REPLY` block arriving AFTER
          // a real (undelivered) prose block would otherwise move the
          // last-delivery cursor past that prose and mask it (multi-block H6).
          // A bare/narration marker is simply not a delivery — push nothing.
          if (prose.length > 0 && !isNarrationBlock(prose)) {
            blocks.push({ kind: 'text', chars: prose.length, text: prose, followedByToolUse: false })
          }
        } else if (prose.length > 0) {
          blocks.push({ kind: 'text', chars: prose.length, text: prose, followedByToolUse: false })
        }
        continue
      }
      if (c?.type !== 'tool_use') continue
      if (!REPLY_TOOLS.has(c.name)) {
        // #3513 follow-up (MF1): record a turn-continuing (non-ephemeral,
        // non-reply) tool_use as an ordered provenance marker for the two-pass.
        if (!isEphemeralTool(c.name)) {
          blocks.push({ kind: 'work-tool' })
        }
        continue
      }
      // W1-d (#3865): remember EVERY reply-tool call's id, not just the
      // qualifying-final-answer ones. An interim ack that threw is still a
      // reply-tool throw, and the #3861 shape (reply raises, agent then writes
      // trailing working notes) does not require the errored call to have been
      // a qualifying final answer.
      if (typeof c.id === 'string') replyToolUseIds.add(c.id)
      const input = c.input ?? {}
      const text = String(input.text ?? '')
      if (SILENT_MARKER_RE.test(text.trim()) || endsWithSilentMarker(text)) {
        blocks.push({ kind: 'deliver', reason: 'silent-marker' })
        continue
      }
      if (isFinalAnswerReply({
        text,
        disableNotification: input.disable_notification === true,
        done: input.done === true,
      })) {
        // #3510: keep the delivered reply's text so the caller can log its
        // sha256 next to the captured trailing prose's sha256 — a double-send
        // becomes provable from logs alone, without transcript reconstruction.
        blocks.push({ kind: 'deliver', reason: 'final-reply', text })
      }
      // interim ack — neither delivery nor undelivered prose.
    }
  }

  // #3513 follow-up (MF1) — PER-TURN two-pass structural provenance (same as
  // scanTurnForFinalReply): mark each text block `followedByToolUse` iff a
  // turn-continuing tool_use appears LATER anywhere in the turn.
  {
    let sawWorkToolLater = false
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i]
      if (b.kind === 'work-tool') {
        sawWorkToolLater = true
        continue
      }
      if (b.kind === 'text') b.followedByToolUse = sawWorkToolLater
    }
  }

  let lastDeliverIdx = -1
  let lastFinalReplyBlock = null
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].kind !== 'deliver') continue
    lastDeliverIdx = i
    if (blocks[i].reason === 'final-reply') lastFinalReplyBlock = blocks[i]
  }
  // #3510: single source of truth for BOTH the fix's branching and the
  // instrumentation. When true, a genuine FINAL-ANSWER reply/stream_reply
  // already went through the gateway THIS turn — so a gateway anchor provably
  // exists (`turn.finalAnswerDelivered` is set by the SAME `isFinalAnswerReply`
  // classifier at outbound-send-path.ts ~2293) and the single-writer election
  // in the Stop hook is reachable and safe. The caller
  // (silent-end-interrupt-stop.mjs) MUST NOT self-exit a capture in that case;
  // doing so creates a third, uncoordinated delivery path that re-sends a
  // trailing recap of the reply as a second message (the #3510 double-send).
  //
  // #3511 review finding 1: ONLY a `'final-reply'` deliver block counts. A
  // `'silent-marker'` block (reply-tool NO_REPLY / HEARTBEAT_OK) delivered
  // NOTHING to the user, and the gateway routes such turns to sentinel
  // suppression (`decideTurnEndGate` → 'silent_end') BEFORE the captured-prose
  // bridge ever runs — deferring to the election there would orphan the
  // trailing answer (a drop). A silent marker still advances `lastDeliverIdx`
  // (the trailing-prose CURSOR — H6 semantics: NO_REPLY intentionally silences
  // what came BEFORE it), but it must keep the shape on the durable
  // outbox/sweep path, never route it to the election.
  const replyAlreadyDeliveredThisTurn = lastFinalReplyBlock != null
  const deliveredReplySha256 =
    lastFinalReplyBlock != null && typeof lastFinalReplyBlock.text === 'string'
      ? createHash('sha256').update(lastFinalReplyBlock.text, 'utf8').digest('hex')
      : null
  // #3513 follow-up — the ONE shared coalescer selects the terminal delivery,
  // UNCONDITIONALLY excluding any block a turn-continuing tool followed (no
  // length/wording gate) and joining the terminal suffix run. The durable outbox
  // never captures intra-turn narration for the sweep to deliver.
  const trailingTextBlocks = blocks
    .slice(lastDeliverIdx + 1)
    .filter((b) => b.kind === 'text' && typeof b.text === 'string' && b.text.length > 0)
  const backstopSelected = selectBackstopDelivery(
    trailingTextBlocks.map((b) => ({ text: b.text, followedByToolUse: b.followedByToolUse })),
  )
  const text = backstopSelected != null ? backstopSelected.text : null
  if (text == null || text.trim().length < FINAL_ANSWER_MIN_CHARS) {
    return { capture: false, reason: trailingTextBlocks.length === 0 ? 'no-trailing-prose' : 'below-floor' }
  }

  const turnNonce = deriveTurnNonce({
    chatId: envelope.chatId,
    threadId: envelope.threadId,
    messageId: envelope.messageId,
    anchorTimestampMs: anchor.anchorTimestampMs,
    anchorContent: anchor.anchorContent,
  })
  let source = envelope.source
  if (source == null) {
    if (anchor.degraded) source = 'unknown'
    else if (/task-notification|task-id/.test(anchor.anchorContent)) source = 'task-notification'
    else source = 'channel'
  }
  // F2: for an envelope-less record, stamp THIS session's own origin chat so the
  // sweep can route it without a gateway-global fallback. For an envelope-
  // bearing record the anchor chatId already routes it (origin is redundant).
  const origin = envelope.chatId != null ? { chatId: null, threadId: null } : resolveSessionOriginChat(lines)
  return {
    capture: true,
    text: text.trim(),
    turnNonce,
    chatId: envelope.chatId,
    threadId: envelope.threadId ?? null,
    source,
    anchorContent: anchor.anchorContent,
    originChatId: origin.chatId,
    originThreadId: origin.threadId,
    replyAlreadyDeliveredThisTurn,
    deliveredReplySha256,
    // W1-d (#3865): one of this turn's reply-tool calls came back an error.
    // Reported as a raw SIGNAL, not a verdict — `decideCaptureAudience` in
    // `audience-classify.mjs` combines it with the obligation state (which
    // this pure transcript scanner cannot see) to decide the audience.
    replyToolThrewThisTurn: [...replyToolUseIds].some((id) => erroredToolUseIds.has(id)),
  }
}
