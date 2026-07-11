/**
 * Pure helpers for the dispatch-claim Stop hook (#396) — extracted so
 * unit tests can exercise the scan logic without spawning the .mjs
 * subprocess (mirrors the `silent-end-scan.mjs` extraction pattern).
 *
 * The defect (#396): the model sends a reply that TELLS the user it has
 * dispatched work ("Dispatching a worker now to fix this") but the turn
 * contains no `Agent`/`Task` tool call and no backgrounded `Bash` — the
 * narration was never backed by an actual dispatch. The silent-end Stop
 * gate (#1664) does not catch this: that turn HAS a qualifying final
 * reply, so it passes untouched.
 *
 * Mechanism (Stop-hook only — the design comment on #396 drops the
 * 2026-04 PreToolUse deny; a pre-send deny would fire before the Agent
 * call exists and block legitimate reply-then-dispatch flows):
 *   1. Walk the current turn's transcript slice (same turn-anchor walk as
 *      `silent-end-scan.mjs:scanTurnForFinalReply`), skipping
 *      `isSidechain:true` lines. A sub-agent's own reply/dispatch lines
 *      leak into the parent transcript with that marker; they are neither
 *      the parent's claim NOR the parent's dispatch, so they are skipped
 *      for BOTH detections.
 *   2. Collect the text of qualifying `reply`/`stream_reply` tool_use
 *      calls (reuse `REPLY_TOOLS`).
 *   3. Detect whether the turn actually dispatched: any non-sidechain
 *      `Agent`/`Task` tool_use, OR a `Bash` tool_use with
 *      `run_in_background: true`.
 *   4. Block only when a reply text makes a first-person dispatch
 *      commitment AND the turn dispatched nothing.
 *
 * Registry-check decision (design comment "belt-and-braces" step 4):
 * The design offered two options — (a) query the subagent-tracker
 * `registry.db` for a dispatch row in this turn window, or (b) skip the
 * registry and rely on transcript-only detection, in which case
 * "past-tense phrasing must be excluded by the regex". We take (b). The
 * transcript already carries the ground truth for THIS turn's dispatches
 * (the `Agent`/`Task` tool_use blocks are in the same JSONL slice we
 * walk), so a second sqlite round-trip from a dependency-free .mjs hook
 * would be redundant and awkward. The registry's real value in the design
 * was clearing PAST-tense references to earlier-turn dispatches; we
 * achieve the same by EXCLUDING pure past-tense verb forms from the
 * commitment regex (see DISPATCH_COMMIT_RE below) so "the worker I
 * dispatched earlier" never trips the gate in the first place. This keeps
 * the hook self-contained and deterministic (no cross-process DB read on
 * the reply path).
 */

// Same two MCP tools whose payload is the model's free-text answer text
// reaching the user (verified complete in silent-end-scan.mjs's header).
const REPLY_TOOLS = new Set([
  'mcp__switchroom-telegram__reply',
  'mcp__switchroom-telegram__stream_reply',
])

// Dispatch tool names — Claude Code emits the sub-agent dispatch tool under
// either the legacy `Agent` or the newer `Task` name depending on version
// (same dual-name recognition subagent-tracker-pretool.mjs uses).
const DISPATCH_TOOLS = new Set(['Agent', 'Task'])

// Silent marker (NO_REPLY / HEARTBEAT_OK + optional trailing punct) — a turn
// whose only reply is a bare silent marker made no claim about anything.
// Matches silent-end-scan.mjs SILENT_MARKER_RE.
const SILENT_MARKER_RE = /^(NO_REPLY|HEARTBEAT_OK)[\s.!?]*$/i

// First-person dispatch-commitment regex. Seed list from the #396 design
// comment:
//   \b(dispatch(ing|ed)?|launch(ing|ed)?|spinning up|kick(ing|ed) off|
//     delegat(ing|ed)|spawn(ing|ed)?)\b[^.?!]{0,60}\b(worker|researcher|
//     reviewer|sub-?agent|agent|task)\b
//
// DEVIATION (documented above): because we skip the registry belt-and-
// braces check, we drop the PURE PAST-TENSE alternatives (`dispatched`,
// `launched`, `kicked off`, `delegated`, `spawned`) from the verb group.
// Present/progressive/bare-infinitive forms ("dispatching a worker",
// "I'll dispatch a worker", "spinning up a researcher") are commitments
// about THIS turn; a bare past-tense reference ("the worker I dispatched
// earlier") is about a prior turn and must not trip the gate. Keeping only
// the non-past forms is the transcript-only substitute for the registry's
// past-tense clearing.
const DISPATCH_COMMIT_RE =
  /\b(?:dispatch(?:ing)?|launch(?:ing)?|spinning up|kick(?:ing)? off|delegat(?:e|ing)|spawn(?:ing)?)\b[^.?!]{0,60}?\b(?:worker|researcher|reviewer|sub-?agent|agent|task)\b/i

// Interrogative / conditional exclusion. A sentence offering to dispatch
// ("want me to dispatch a worker?", "I could spin up a reviewer if you
// like") is not a commitment that a dispatch HAPPENED — it is a question
// or a conditional, so it must not block. Seed list from the design
// comment: '?', could|should|would|want me to|shall I|if you.
const CONDITIONAL_RE = /\?|\b(?:could|should|would|want me to|shall i|if you)\b/i

/**
 * True when `text` (one reply's payload) contains at least one SENTENCE
 * that makes a first-person dispatch commitment and is not interrogative
 * or conditional.
 *
 * Split into sentences first (retaining the trailing `.?!` terminator) so
 * the conditional exclusion is scoped to the sentence carrying the verb —
 * a later unrelated sentence with a '?' must not amnesty a real earlier
 * commitment, and vice versa.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function replyClaimsDispatch(text) {
  if (typeof text !== 'string' || text.length === 0) return false
  // Bare silent markers carry no claim.
  if (SILENT_MARKER_RE.test(text.trim())) return false
  const sentences = text.match(/[^.?!]+[.?!]*/g) || [text]
  for (const sentence of sentences) {
    if (!DISPATCH_COMMIT_RE.test(sentence)) continue
    if (CONDITIONAL_RE.test(sentence)) continue
    return true
  }
  return false
}

/**
 * Compute a stable per-turn signature from the enqueue anchor line's raw
 * content string (the inbound message envelope). Used by the hook's
 * 1-retry budget so the budget resets on a genuinely new turn (a new
 * enqueue line with a new message_id) but is preserved across the
 * re-prompt of the SAME turn (same enqueue anchor — no new inbound).
 *
 * A tiny djb2 hash keeps the state file small and dependency-free.
 *
 * @param {string} content
 * @returns {string}
 */
export function turnSignature(content) {
  const s = typeof content === 'string' ? content : ''
  let h = 5381
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  }
  return `t${h.toString(36)}`
}

/**
 * Scan a JSONL transcript and decide whether the current turn told the
 * user it dispatched work without actually dispatching anything.
 *
 * Returns:
 *   { decided: 'allow',  reason }             — no unbacked dispatch claim
 *   { decided: 'block',  reason, turnSig }    — a reply claimed a dispatch
 *                                               but the turn dispatched
 *                                               nothing; `turnSig` anchors
 *                                               the hook's retry budget
 *   { decided: 'unknown', reason }            — no turn-start anchor found;
 *                                               caller fails open
 *
 * Turn-start anchor: the most recent `queue-operation`/`enqueue` line
 * (identical to `scanTurnForFinalReply`). Fail-open on any structural
 * miss — a mis-firing gate must never wedge the reply path.
 *
 * @param {string} jsonl
 * @returns {{ decided: 'allow' | 'block' | 'unknown', reason: string, turnSig?: string }}
 */
export function scanTurnForDispatchClaim(jsonl) {
  if (typeof jsonl !== 'string' || jsonl.length === 0) {
    return { decided: 'unknown', reason: 'empty-transcript' }
  }
  const lines = jsonl.split('\n')

  // 1. Walk backward to the most-recent enqueue (the turn-start anchor).
  let startIdx = -1
  let enqueueContent = ''
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line || line[0] !== '{') continue
    let obj
    try { obj = JSON.parse(line) } catch { continue }
    if (obj?.type === 'queue-operation' && obj.operation === 'enqueue') {
      startIdx = i
      enqueueContent = typeof obj.content === 'string' ? obj.content : ''
      break
    }
  }
  if (startIdx < 0) {
    return { decided: 'unknown', reason: 'no-turn-start' }
  }

  // 2. Walk the turn forward, skipping sub-agent (isSidechain) lines for
  //    BOTH claim detection and dispatch detection. Collect reply texts;
  //    note whether the turn dispatched anything real.
  let dispatched = false
  const replyTexts = []
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line || line[0] !== '{') continue
    let obj
    try { obj = JSON.parse(line) } catch { continue }
    // Sidechain (sub-agent) lines are not the parent's claim NOR the
    // parent's dispatch — skip entirely.
    if (obj?.isSidechain === true) continue
    if (obj?.type !== 'assistant') continue
    const content = obj?.message?.content
    if (!Array.isArray(content)) continue
    for (const c of content) {
      if (c?.type !== 'tool_use') continue
      const name = c.name
      if (DISPATCH_TOOLS.has(name)) {
        dispatched = true
        continue
      }
      if (name === 'Bash') {
        const input = c.input ?? {}
        if (input.run_in_background === true) dispatched = true
        continue
      }
      if (REPLY_TOOLS.has(name)) {
        const input = c.input ?? {}
        replyTexts.push(String(input.text ?? ''))
        continue
      }
    }
  }

  // 3. If the turn actually dispatched work, the claim (if any) is backed
  //    — allow, regardless of reply phrasing.
  if (dispatched) {
    return { decided: 'allow', reason: 'dispatched' }
  }

  // 4. No dispatch happened. Block iff a reply made a first-person
  //    dispatch commitment that was neither interrogative nor conditional.
  const claimed = replyTexts.some((t) => replyClaimsDispatch(t))
  if (claimed) {
    return { decided: 'block', reason: 'claim-without-dispatch', turnSig: turnSignature(enqueueContent) }
  }
  return { decided: 'allow', reason: 'no-claim' }
}

/**
 * Pure 1-retry-budget helper for the Stop hook. Mirrors the
 * `silent-end-interrupt-stop.mjs` MAX_RETRIES pattern but with its own
 * state shape, keyed on the per-turn signature so the budget resets on a
 * new turn and is honoured across the re-prompt of the same turn.
 *
 * Returns:
 *   { block: true,  nextState }  — budget available; write nextState and block
 *   { block: false }             — budget exhausted for this turn; fail open
 *
 * @param {{ turnSig?: string, retryCount?: number } | null | undefined} existingState
 * @param {string} turnSig
 * @param {number} maxRetries
 * @returns {{ block: boolean, nextState?: { turnSig: string, retryCount: number, timestamp: number } }}
 */
export function applyRetryBudget(existingState, turnSig, maxRetries) {
  const prev = existingState && typeof existingState === 'object' ? existingState : {}
  // Only carry the counter forward when it belongs to the SAME turn;
  // otherwise this is a fresh turn and the budget starts at 0.
  const prevCount =
    prev.turnSig === turnSig && typeof prev.retryCount === 'number' ? prev.retryCount : 0
  if (prevCount >= maxRetries) {
    return { block: false }
  }
  return {
    block: true,
    nextState: { turnSig, retryCount: prevCount + 1, timestamp: Date.now() },
  }
}
