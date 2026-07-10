/**
 * worker-pin-reaper.ts — pure decision for the mid-session `wk:` pin sweep
 * (#3001).
 *
 * Why this exists: the background-worker pin (`wk:<agentId>`, pinned on the
 * `🛠 Worker` feed message while the worker runs) is normally unpinned by the
 * worker's completion handler (`reconcileWorkerPin(agentId, null, false)` on
 * the watcher's onFinish). But that event can be MISSED — watcher crash, SDK
 * subprocess SIGKILL, a dropped JSONL tail — and then nothing ever unpins the
 * worker's message until the next gateway boot. Log evidence on one agent:
 * ~1120 pinChatMessage vs ~1014 unpinChatMessage with zero logged failures —
 * a long tail of stale pins glued to the top of the chat.
 *
 * This module is the pure half (mirrors `runActivityCardMidSessionReaper`'s
 * decide-over-injected-seams shape): given the currently-claimed `wk:` pins,
 * a terminality predicate over the sub-agent registry, and a TTL, it returns
 * the pins that should be unpinned NOW. The gateway executes each reap via
 * `reconcileStatusPin(key, chat, { pinned: false })` so the in-memory claim
 * AND the durable store row clear together.
 *
 * A pin is reaped when EITHER:
 *   - `terminal` — the registry says the worker reached a terminal status
 *     (completed | failed): its work is finished, the pin must go, however
 *     young it is. (A missed onFinish is exactly this case.)
 *   - `ttl` — the pin has been held past `ttlMs` AND the registry cannot
 *     vouch for the worker (no row / never linked / `stalled` / lookup
 *     error). A registry-confirmed RUNNING row exempts the pin from the TTL
 *     entirely: a healthy 7h worker keeps its pin for the whole run instead
 *     of churning unpin→re-pin every TTL. The stall detector demotes a dead
 *     worker's row out of 'running' within ~60s, so the TTL still catches
 *     true zombies.
 *
 * A worker the registry can't vouch for is still never touched before the
 * TTL — the sweep can only ever shorten a stale pin's life, not a live one's.
 */

/** Default TTL for a held worker pin: 6 hours. Rationale: worker turns are
 *  expected to run minutes-to-a-couple-of-hours (the watcher's own stall
 *  detection fires after ~60s of JSONL inactivity, and the longest sanctioned
 *  background dispatches are bounded by a single Claude session's lifetime).
 *  6h comfortably exceeds any legitimate worker turn while bounding the
 *  stale-pin window to the same day instead of "until the next restart". */
export const WORKER_PIN_TTL_MS_DEFAULT = 6 * 60 * 60_000

export const WORKER_PIN_KEY_PREFIX = 'wk:'

/** One currently-claimed worker pin, flattened from the gateway's Maps. */
export interface WorkerPinCandidate {
  /** Full pin key, `wk:<agentId>` shape. */
  pinKey: string
  /** Chat the pin lives in (from the gateway's pinKey → chatId registry). */
  chatId: string
  /** Wall-clock ms the claim was first taken (gateway's pinnedAt registry). */
  pinnedAt: number
}

export interface WorkerPinReap extends WorkerPinCandidate {
  reason: 'terminal' | 'ttl'
}

/** Extract the agentId from a `wk:<agentId>` pin key, or null for any other
 *  key shape (fg:/banner:/tool: keys are never worker-reaped). */
export function workerAgentIdOfPinKey(pinKey: string): string | null {
  if (!pinKey.startsWith(WORKER_PIN_KEY_PREFIX)) return null
  const agentId = pinKey.slice(WORKER_PIN_KEY_PREFIX.length)
  return agentId.length > 0 ? agentId : null
}

/** The registry's view of a worker, distilled for the reap decision.
 *  - 'terminal' — row exists in completed | failed: reap now.
 *  - 'running'  — row exists and is still 'running': NEVER reap, not even
 *    past the TTL. A healthy 7h worker must not get unpinned mid-run only
 *    for the next feed edit to re-pin it (pin/unpin churn every TTL). The
 *    subagent-watcher's stall detection demotes a dead worker's row out of
 *    'running' within ~60s of its JSONL going quiet, so a true zombie can
 *    only hold 'running' briefly — the TTL still catches everything the
 *    registry has lost track of.
 *  - 'unknown'  — no row / never linked / 'stalled' / lookup error: the
 *    TTL gate applies (the registry can't vouch for it). */
export type WorkerRegistryStatus = 'terminal' | 'running' | 'unknown'

/**
 * Decide which claimed worker pins to unpin now. Pure: the registry lookup is
 * an injected predicate (`statusOf` must return 'terminal' ONLY for a row in
 * completed | failed, 'running' only for a live 'running' row, and 'unknown'
 * for stalled / missing / lookup-error; a DB hiccup must degrade to 'unknown'
 * — kept until the TTL — never to a spurious 'terminal' unpin).
 */
export function decideWorkerPinReaps(args: {
  pins: Iterable<WorkerPinCandidate>
  statusOf: (agentId: string) => WorkerRegistryStatus
  ttlMs: number
  now: number
}): WorkerPinReap[] {
  const reaps: WorkerPinReap[] = []
  for (const pin of args.pins) {
    const agentId = workerAgentIdOfPinKey(pin.pinKey)
    if (agentId == null) continue // not a worker pin — never ours to reap
    if (pin.chatId.length === 0) continue // can't unpin without a chat
    const status = args.statusOf(agentId)
    if (status === 'terminal') {
      reaps.push({ ...pin, reason: 'terminal' })
      continue
    }
    // A registry-confirmed RUNNING worker keeps its pin regardless of age —
    // the TTL only reaps pins the registry can't vouch for (see
    // WorkerRegistryStatus doc).
    if (status === 'running') continue
    if (args.now - pin.pinnedAt >= args.ttlMs) {
      reaps.push({ ...pin, reason: 'ttl' })
    }
  }
  return reaps
}
