/**
 * Prefix-cache warmup turn — opt-in cold-start TTFO optimization.
 *
 * Per cold-start TTFO RFC (reference/rfcs/cold-start-ttfo.md, PR #1589),
 * Option A. On every bridge-up after a restart, synthesize a synthetic
 * inbound (`__WARMUP_PING__`, meta.source="warmup") and deliver it to
 * the just-registered bridge. Claude processes the message — paying
 * the full cold-cache cost on the synthetic turn — and responds
 * `NO_REPLY` per the in-prompt instruction. The existing NO_REPLY
 * suppression at `gateway.ts:5949` swallows the outbound.
 *
 * By the time the user's REAL next message arrives, Anthropic's prefix
 * cache is warm and the user-perceived TTFO drops 4-8s on average.
 *
 * Phase 1 (this file): minimum-viable warmup. AGENT.md is NOT modified
 * — the warmup TEXT carries the NO_REPLY instruction inline. Agent
 * compliance is best-effort; non-compliant agents will emit a real
 * reply to the primary chat (acceptable UX cost gated behind opt-in
 * env var). Cooldown prevents the gymbro-style bridge-churn case from
 * burning OAuth quota on every flap.
 *
 * Kill switch: `SWITCHROOM_PREFIX_WARMUP=1` opt-in (default OFF).
 *
 * Future PR (Phase 2): suppress 👀 reaction + progress card for
 * meta.source="warmup" inbound; tag for Hindsight exclusion.
 */

import type { IpcClient } from './ipc-server.js'
import type { InboundMessage } from './ipc-protocol.js'

// Per cold-start RFC open-question #4: cooldown anchored on bridge-up
// time; conservative 5-minute window catches gymbro-style 6-reconnects-
// per-UAT-cycle without dropping legitimate every-restart warmups.
const WARMUP_COOLDOWN_MS = 5 * 60_000

const lastWarmupAtPerAgent = new Map<string, number>()

export const WARMUP_TEXT =
  '__WARMUP_PING__\n\nThis is a system prefix-cache warmup (not from a user). ' +
  'Respond with exactly `NO_REPLY` and nothing else. ' +
  'The gateway will suppress the response — no message will be sent to anyone.'

export interface WarmupCtx {
  readonly selfAgent: string
  readonly client: IpcClient
  readonly resolveBootTarget: () =>
    | { chatId: string; threadId?: number | undefined }
    | null
  readonly log?: (line: string) => void
  readonly now?: () => number
}

/**
 * Fire a prefix-cache warmup if conditions are met. Idempotent within
 * the cooldown window. Returns true when a warmup was actually sent.
 *
 * Conditions:
 *   1. `SWITCHROOM_PREFIX_WARMUP=1` env var set (opt-in).
 *   2. Cooldown elapsed for this agent (default 5 min).
 *   3. A boot chat target resolves (no point warming without a chat).
 *
 * The warmup is delivered to `client.send()` directly — it bypasses
 * the gateway's `handleInbound`, which gates on a real Telegram
 * Context object. The bridge forwards to claude exactly as it would a
 * Telegram message.
 */
export function maybeFireWarmup(ctx: WarmupCtx): boolean {
  if (process.env.SWITCHROOM_PREFIX_WARMUP !== '1') return false

  const log = ctx.log ?? ((line: string) => process.stderr.write(line))
  const now = (ctx.now ?? Date.now)()

  const lastAt = lastWarmupAtPerAgent.get(ctx.selfAgent) ?? 0
  if (now - lastAt < WARMUP_COOLDOWN_MS) {
    log(
      `telegram gateway: prefix-warmup skipped agent=${ctx.selfAgent} ` +
        `reason=cooldown last=${Math.round((now - lastAt) / 1000)}s ago\n`,
    )
    return false
  }

  const target = ctx.resolveBootTarget()
  if (!target) {
    log(
      `telegram gateway: prefix-warmup skipped agent=${ctx.selfAgent} ` +
        `reason=no-boot-chat-target\n`,
    )
    return false
  }

  const msg: InboundMessage = {
    type: 'inbound',
    chatId: target.chatId,
    ...(target.threadId !== undefined ? { threadId: target.threadId } : {}),
    messageId: 0, // synthetic — never matches a real Telegram message
    user: 'switchroom-warmup',
    userId: 0,
    ts: Math.floor(now / 1000),
    text: WARMUP_TEXT,
    meta: { source: 'warmup' },
  }

  try {
    ctx.client.send(msg)
    lastWarmupAtPerAgent.set(ctx.selfAgent, now)
    log(
      `telegram gateway: prefix-warmup fired agent=${ctx.selfAgent} ` +
        `chat=${target.chatId} thread=${target.threadId ?? '-'}\n`,
    )
    return true
  } catch (err) {
    log(
      `telegram gateway: prefix-warmup send threw agent=${ctx.selfAgent}: ` +
        `${(err as Error).message}\n`,
    )
    return false
  }
}

/** Test hook: reset the cooldown state. */
export function __resetForTests(): void {
  lastWarmupAtPerAgent.clear()
}
