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
function buildBlockResult(envelope, reason, pendingText) {
  const block = { decided: 'block', reason }
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
    return buildBlockResult(envelope, 'no-final-reply', pendingText)
  }

  if (sawUndeliveredTextAfterAllow) {
    // A qualifying delivery DID happen somewhere in the turn, but the
    // model kept writing after it and that trailing content was never
    // sent through a delivery tool. This is the "at least once" bug:
    // an early ack (or any qualifying reply) must not amnesty
    // everything written afterward.
    return buildBlockResult(envelope, 'trailing-text-after-reply', pendingText)
  }

  return { decided: 'allow', reason: lastAllowReason }
}
