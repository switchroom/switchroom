/**
 * Regression guard for the v0.13.30→v0.13.31 wedge fix: the buffer
 * gate (`activeTurnStartedAt`) must release on EVERY successful
 * reply / stream_reply finalize — not just on `isFinalAnswerReply`.
 *
 * Surfaced 2026-05-24 via the v0.13.30 UAT canary:
 *   13:02:46 reply finalized for msg 1873 (charCount=67)
 *   13:03:04 msg 1874 — held mid-turn  (gate STILL open)
 *   13:03:40 msg 1875 — held mid-turn  (depth=2)
 *   13:04:19 msg 1876 — held mid-turn  (depth=3)
 *
 * Root cause: the trivial-prompt reply used `disable_notification:
 * true` and was < 200 chars (the model classified "4" as an interim
 * ack), so `isFinalAnswerReply` returned false, the
 * `finalizeStatusReaction` gate in `executeReply` short-circuited,
 * and the buffer gate stayed set. Pre-#1718 the gate released on
 * every reply (via `endStatusReaction → purgeReactionTracking`);
 * #1718 deferred everything to `turn_end`, then #1729 partially
 * restored via `isFinalAnswerReply`-gated finalize. This fix
 * decouples the buffer-gate release from the reaction-state
 * finalize: every successful reply releases the gate, the reaction
 * controller stays alive (preserves #1713 bidirectional ladder +
 * the steer-vs-queue logic).
 *
 * The gateway IIFE is too entangled to instantiate in-process; we
 * do source-level assertions like `reply-terminal-reaction.test.ts`
 * does. If a future commit regresses the contract (re-narrows the
 * gate release, or removes the helper), these assertions trip.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const gatewaySrc = readFileSync(
  resolve(__dirname, '..', 'gateway', 'gateway.ts'),
  'utf-8',
)
// #2996 P2: executeReply's body moved verbatim to outbound-send-path.ts
// (`sendReply`); the post-send block assertions read there. #2996 P8 PR-B: the
// `releaseTurnBufferGate` helper body moved verbatim to turn-end.ts (gateway
// keeps a thin delegating wrapper); the helper-body assertions read there.
const sendPathSrc = readFileSync(
  resolve(__dirname, '..', 'gateway', 'outbound-send-path.ts'),
  'utf-8',
)
const turnEndSrc = readFileSync(
  resolve(__dirname, '..', 'gateway', 'turn-end.ts'),
  'utf-8',
)

describe('buffer-gate release decoupled from final-answer classification', () => {
  // Extract the helper's docstring (everything between the matching
  // `/**` block above `function releaseTurnBufferGate` and the
  // function declaration). The body slice (used by other tests) is
  // separate — see fnBody().
  function fnDocstring(): string {
    const beforeFn = turnEndSrc.split('function releaseTurnBufferGate')[0] ?? ''
    const lastBlockOpen = beforeFn.lastIndexOf('/**')
    if (lastBlockOpen < 0) return ''
    return beforeFn.slice(lastBlockOpen)
  }
  function fnBody(): string {
    // The function body — everything between `function
    // releaseTurnBufferGate(...): void {` and its matching `}`. Use
    // a simple brace-balance over the slice from open-brace onward.
    const afterDecl = turnEndSrc.split('function releaseTurnBufferGate')[1] ?? ''
    const openIdx = afterDecl.indexOf('{')
    if (openIdx < 0) return ''
    let depth = 0
    for (let i = openIdx; i < afterDecl.length; i++) {
      const ch = afterDecl[i]
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) return afterDecl.slice(openIdx, i + 1)
      }
    }
    return afterDecl.slice(openIdx)
  }

  it('declares a narrow `releaseTurnBufferGate` helper (not the full purgeReactionTracking)', () => {
    // Multitopic component 1: the signature now also accepts an optional
    // `endingTurn` so the serialize-until-replied drain gate can read its
    // finalAnswerDelivered flag. The narrow-helper contract is unchanged.
    expect(turnEndSrc).toMatch(
      /function releaseTurnBufferGate\(key: string, endingTurn\?: CurrentTurn\): void/,
    )
    // The helper docstring must explain WHY split from
    // purgeReactionTracking — future readers need to know.
    const doc = fnDocstring()
    expect(doc).toMatch(/#1713/)
    expect(doc).toMatch(/steer-vs-queue/)
  })

  it('releaseTurnBufferGate ONLY clears activeTurnStartedAt + flushes; does NOT touch activeStatusReactions', () => {
    const body = fnBody()
    expect(body).toMatch(/activeTurnStartedAt\.delete\(key\)/)
    // The drain is now routed through the shared `drainBufferedIfAllowed`
    // helper (multitopic component 1), which owns the pendingInboundBuffer
    // flush + the serialize-until-replied gate.
    expect(body).toMatch(/drainBufferedIfAllowed\(/)
    // Critical regression guard: the helper must NOT touch the
    // reaction controller, else #1713's bidirectional ladder
    // collapses to 👍 mid-turn.
    expect(body).not.toMatch(/activeStatusReactions\.delete/)
    expect(body).not.toMatch(/activeReactionMsgIds\.delete/)
    // Also must NOT call finalizeStatusReaction or
    // purgeReactionTracking (both would clear the controller).
    expect(body).not.toMatch(/finalizeStatusReaction\(/)
    expect(body).not.toMatch(/purgeReactionTracking\(/)
  })

  it('executeReply calls releaseTurnBufferGate OUTSIDE the isFinalAnswerReply branch', () => {
    // Slice the executeReply post-send block (between the anchor
    // comments and the next exported function).
    const post = sendPathSrc.split("fresh sendMessage from reply tool is a user-visible")[1] ?? ''
    const slice = post.split('\nexport async function ')[0] ?? ''
    // The narrow `isFinalAnswerReply`-gated finalize MUST stay (it
    // emits the 👍 reaction on the final-answer happy path).
    expect(slice).toMatch(/isFinalAnswerReply\(/)
    expect(slice).toMatch(/finalizeStatusReaction\(/)
    // The unconditional buffer-gate release must ALSO be present and
    // must be OUTSIDE the isFinalAnswerReply branch (so trivial-prompt
    // non-notification replies still release the gate). Multitopic
    // component 1: the call now passes the turn so the serialize gate
    // can read finalAnswerDelivered.
    expect(slice).toMatch(/releaseTurnBufferGate\(statusKey\(chat_id, threadId\), turn \?\? undefined\)/)
    // Structural check: the release must appear AFTER the
    // isFinalAnswerReply block's closing brace but BEFORE the
    // post-send block ends. Easiest pin: it must NOT be inside the
    // `if (turn != null && isFinalAnswerReply(...))` block.
    const gateBlockOpen = slice.indexOf('if (turn != null && isFinalAnswerReply(')
    const gateBlockClose = slice.indexOf('}', gateBlockOpen)
    const releaseIdx = slice.indexOf('releaseTurnBufferGate(')
    expect(gateBlockOpen).toBeGreaterThan(-1)
    expect(gateBlockClose).toBeGreaterThan(gateBlockOpen)
    expect(releaseIdx).toBeGreaterThan(gateBlockClose)
  })

  it('the helper is invoked from turn-terminal paths only — reply-finalize and halt', () => {
    // Sanity: nothing else should call releaseTurnBufferGate. The
    // helper is narrow on purpose. If future code adds new
    // callsites that aren't turn-terminal, the steer-vs-queue
    // semantics could drift.
    // #2996 P2: the reply-finalize callsite moved (verbatim) into
    // outbound-send-path.ts `sendReply`; gateway.ts keeps the definition,
    // the halt callsite, and the deps-injection reference.
    const callMatches = (gatewaySrc + sendPathSrc).match(/releaseTurnBufferGate\(/g) ?? []
    // Definition + deps-interface member + 2 callsites = 4:
    //   - sendReply's post-send block (reply-finalize, the original).
    //   - executeHaltNow (#3020): an interrupt-cancelled turn never reaches
    //     reply-finalize (the C-c killed it and no replacement inbound
    //     follows), so the halt IS that turn's terminal — releasing there is
    //     the deterministic sibling of the reply-path release, not a
    //     mid-turn drift. (The retired stream_reply callsite was removed
    //     with executeStreamReply.)
    // If this count grows the test catches it; reviewer must justify
    // any new callsite.
    // #2996 P8 PR-B adds exactly one more match in gateway.ts: the thin
    // wrapper's delegate call (`turnEndFunnel().releaseTurnBufferGate(...)`)
    // alongside the wrapper's own declaration. Still only TWO turn-terminal
    // callsites (sendReply post-send + executeHaltNow).
    expect(callMatches.length).toBe(5)
  })
})
