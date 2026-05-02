/**
 * Real-gateway harness — Phase 3 of #545 / first PR of #553.
 *
 * Wraps the Phase 1 `waiting-ux-harness` with the real production
 * `InboundCoalescer` so the F1–F4 user-perceived UX deadlines are
 * asserted against the same coalescing timing the live gateway uses,
 * not a parallel reimplementation.
 *
 * The Phase 1 harness called `controller.setQueued()` (👀) synchronously
 * in `inbound()` — that's why F2 ("👀 within 800ms") passed trivially
 * there. Production code routes inbound through `handleInboundCoalesced`
 * first, which buffers messages for `gapMs` (default 1500ms) and only
 * THEN calls the first-paint flow that fires the reaction. This harness
 * exposes that gap to tests so the F2 deadline becomes catchable.
 *
 * Composition (top-down):
 *   inbound(chatId, msgId, text)
 *     → inboundCoalescer.enqueue(key, payload)
 *     → after gapMs, onFlush() runs:
 *        → controller.setQueued()    (👀)
 *        → driver.startTurn()
 *   feedSessionEvent(ev)
 *     → controller.setThinking() / setTool() / setDone()
 *     → driver.ingest()
 *
 * `gapMs` defaults to 1500 (production value). Tests can pass `gapMs: 0`
 * to disable coalescing and verify the upper-bound on first-paint
 * latency without the coalesce wait, or `gapMs: 500` to mimic an
 * operator who tuned it down.
 *
 * F1–F4 deadlines this harness lets us assert:
 *   - F1 ladder collapse: reaction sequence over a multi-tool turn
 *   - F2 no instant draft: firstReactionMs - inboundAt
 *   - F3 late progress card: progressCardSendMs - firstToolUseMs
 *   - F4 static interim text: edits per session-event step transition
 */

import {
  createWaitingUxHarness,
  type CreateHarnessOpts,
  type HarnessHandle,
} from './waiting-ux-harness.js'
import type { SessionEvent } from '../session-tail.js'
import {
  createInboundCoalescer,
  inboundCoalesceKey,
  type InboundCoalescer,
} from '../gateway/inbound-coalesce.js'

export interface RealGatewayHarnessOpts extends CreateHarnessOpts {
  /**
   * Inbound coalesce window in ms. Production reads this per-call from
   * the access file (default 1500). Tests can pass 0 to disable
   * coalescing entirely.
   */
  gapMs?: number
}

interface CoalescePayload {
  chatId: string
  messageId: number
  text: string
  userId: string
}

export interface RealGatewayHarnessHandle extends HarnessHandle {
  /**
   * Total inbound messages currently buffered by the coalescer (across
   * all keys). For tests asserting that flush actually fired.
   */
  coalesceBufferSize(): number
  /** Underlying coalescer — exposed for tests that need direct introspection. */
  coalescer: InboundCoalescer<CoalescePayload>
  /**
   * Effective gapMs the harness was configured with. Pinned for tests
   * that compute deadlines relative to the coalesce window.
   */
  gapMs: number
}

const DEFAULT_GAP_MS = 1500

export function createRealGatewayHarness(
  opts: RealGatewayHarnessOpts = {},
): RealGatewayHarnessHandle {
  const gapMs = opts.gapMs ?? DEFAULT_GAP_MS

  // Phase 1 harness: controller + driver + recorder + clock.
  const inner = createWaitingUxHarness(opts)

  // Wrap inner.inbound() with the real coalescer so the test surface
  // matches what production sees end-to-end.
  const coalescer = createInboundCoalescer<CoalescePayload>({
    gapMs,
    merge: (entries) => {
      const last = entries[entries.length - 1]
      return {
        chatId: last.chatId,
        messageId: last.messageId,
        userId: last.userId,
        text: entries.map((e) => e.text).join('\n'),
      }
    },
    onFlush: (_key, merged) => {
      // The flush is the moment first-paint runs in production —
      // controller.setQueued() (👀) and driver.startTurn(). Delegate
      // to the inner harness's inbound() which already wires both.
      inner.inbound({ chatId: merged.chatId, messageId: merged.messageId, text: merged.text })
    },
  })

  function inbound(args: { chatId: string; messageId: number; text?: string; userId?: string }): void {
    const userId = args.userId ?? '777' // matches update-factory's default sender
    const payload: CoalescePayload = {
      chatId: args.chatId,
      messageId: args.messageId,
      text: args.text ?? '',
      userId,
    }
    const key = inboundCoalesceKey(args.chatId, userId)
    const result = coalescer.enqueue(key, payload)
    if (result.bypass) {
      // gapMs <= 0 — production calls handleInbound directly; mirror
      // by calling the inner harness's first-paint immediately.
      inner.inbound({ chatId: args.chatId, messageId: args.messageId, text: args.text })
    }
  }

  function feedSessionEvent(ev: SessionEvent): void {
    inner.feedSessionEvent(ev)
  }

  function finalize(): void {
    coalescer.reset()
    inner.finalize()
  }

  return {
    ...inner,
    inbound,
    feedSessionEvent,
    finalize,
    coalescer,
    coalesceBufferSize: () => coalescer.size(),
    gapMs,
  }
}
