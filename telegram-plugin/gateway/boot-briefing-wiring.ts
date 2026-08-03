/**
 * Impure orchestration for the gateway boot briefing
 * (`session_continuity.briefing: gateway`). The pure logic — flag
 * decision, surface collection, budget-bounded rendering, resume dedup —
 * lives in `boot-briefing-builder.ts`; this module reads the real env /
 * fs / history handle and hands the finished inbound to the caller's
 * `put` (spool or in-memory buffer).
 *
 * Contract with gateway.ts: a single call at boot, AFTER `initHistory`
 * and AFTER the boot-resume inbound is built (its interrupted-turn window
 * feeds the dedup), and BEFORE the resume inbound is spooled when the
 * caller wants briefing-before-resume delivery order. NEVER throws and
 * never blocks: every failure path degrades to "no briefing".
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { GATEWAY_BOOT_BRIEFING_CAPABILITY } from './boot-briefing-capability.js'
import { getHistoryDbForBriefing } from '../history.js'
import type { InboundMessage } from './ipc-protocol.js'
import {
  buildBootBriefingInbound,
  collectBriefingSurfaces,
  decideBootBriefing,
  excludeWindowFromResumeInbound,
  readRestartBreadcrumb,
  renderBootBriefing,
} from './boot-briefing-builder.js'

export interface MaybeQueueBootBriefingOptions {
  env: Record<string, string | undefined>
  /** Gateway STATE_DIR (`<agentDir>/telegram` in production). */
  stateDir: string
  /** The already-built boot resume/report inbound (or null) — its
   *  interrupted-turn window is elided from the briefing so the two boot
   *  synthetics never double-inject the same messages. */
  resumeMsg: InboundMessage | null
  /** Durable enqueue — `inboundSpool.put` (or the in-memory buffer's push
   *  in STATIC mode). */
  put: (agent: string, msg: InboundMessage) => unknown
  log?: (line: string) => void
  nowMs?: number
}

/**
 * Build + enqueue the boot briefing when the feature flag and suppression
 * rules allow. Returns the queued inbound (for observability/tests) or
 * null when nothing was queued.
 */
export function maybeQueueBootBriefing(
  opts: MaybeQueueBootBriefingOptions,
): InboundMessage | null {
  const log = opts.log ?? ((l: string) => process.stderr.write(l))
  try {
    const agentDir = opts.stateDir.endsWith('/telegram')
      ? opts.stateDir.slice(0, -'/telegram'.length)
      : opts.stateDir
    // Session-generation guard (#4242). This module re-evaluates on EVERY
    // gateway process start, including a supervisor respawn after the
    // gateway crashes — but a respawn does NOT restart the inner Claude
    // session, so re-queuing a boot briefing would inject a "you just
    // rebooted" reorientation into a live, mid-conversation session. The
    // spool's dedup can't catch it: by respawn time boot-1's briefing has
    // been delivered AND acked, so its spool entry is already gone.
    //
    // start.sh's OUTER pass stamps SWITCHROOM_GATEWAY_BOOT_ID once per REAL
    // boot, before forking the gateway; `_switchroom_supervise` respawns
    // `bun` in a loop within that same shell, so every respawn inherits the
    // identical id, while the next real boot re-derives a fresh one. We
    // persist the id the first time a generation actually queues (or
    // determines it has nothing to queue) and skip when the persisted id
    // matches — that is a respawn. Absent env (non-docker / pre-upgrade
    // start.sh) leaves the guard inert: legacy best-effort behaviour.
    const bootId = opts.env.SWITCHROOM_GATEWAY_BOOT_ID
    const genMarkerPath = join(agentDir, '.boot-briefing-generation')
    if (bootId) {
      let prevGen: string | null = null
      try {
        prevGen = readFileSync(genMarkerPath, 'utf8').trim()
      } catch {
        prevGen = null
      }
      if (prevGen === bootId) {
        log(
          'telegram gateway: boot-briefing suppressed (supervisor respawn — this boot generation already briefed)\n',
        )
        return null
      }
    }
    const markGeneration = (): void => {
      if (!bootId) return
      try {
        writeFileSync(genMarkerPath, `${bootId}\n`)
      } catch {
        // Best-effort: a failed persist only risks one redundant re-queue on
        // respawn, which the spool still dedups; never block boot.
      }
    }
    // Force-fresh suppression is keyed on env, NOT on existsSync at this
    // module-eval time. start.sh's OUTER pass snapshots the
    // `.force-fresh-session` marker into SWITCHROOM_FORCE_FRESH *before*
    // forking this gateway, so the value is fixed at fork time and immune to
    // the inner tmux pass's later `rm` of the marker (the two race with no
    // ordering — the old existsSync could lose that race and resurrect the
    // briefing on a /reset boot). The existsSync is retained only as a
    // fallback for runtimes where start.sh doesn't hoist the env (non-docker),
    // where there is no such fork race.
    const forceFresh =
      opts.env.SWITCHROOM_FORCE_FRESH === '1' ||
      existsSync(join(agentDir, '.force-fresh-session'))
    const decision = decideBootBriefing({
      briefingMode: opts.env.SWITCHROOM_SESSION_BRIEFING,
      resumeMode: opts.env.SWITCHROOM_RESUME_MODE,
      forceFreshMarker: forceFresh,
    })
    if (!decision.build) {
      if (decision.reason !== 'flag-legacy') {
        log(`telegram gateway: boot-briefing suppressed (${decision.reason})\n`)
      }
      return null
    }
    const selfAgent = opts.env.SWITCHROOM_AGENT_NAME ?? ''
    if (!selfAgent) return null
    const db = getHistoryDbForBriefing()
    if (db == null) {
      log('telegram gateway: boot-briefing skipped — history DB unavailable\n')
      return null
    }
    const nowMs = opts.nowMs ?? Date.now()
    const surfaces = collectBriefingSurfaces(db, {
      nowMs,
      exclude: excludeWindowFromResumeInbound(opts.resumeMsg),
    })
    const restartReason = readRestartBreadcrumb({
      restartReasonPath: join(agentDir, '.restart-reason'),
      env: opts.env,
      readFile: (p) => readFileSync(p, 'utf8'),
    })
    const text = renderBootBriefing(surfaces, { nowMs, restartReason })
    if (!text) {
      // Consume the generation even when empty: had there been nothing to
      // brief at boot, a later respawn must not suddenly brief mid-session
      // just because fresh messages arrived after the session came up.
      markGeneration()
      log('telegram gateway: boot-briefing empty (no recent surfaces) — nothing queued\n')
      return null
    }
    const primary = surfaces[0]!
    const msg = buildBootBriefingInbound({
      chatId: primary.chatId,
      threadId: primary.threadId,
      text,
      nowMs,
    })
    opts.put(selfAgent, msg)
    markGeneration()
    log(
      `telegram gateway: boot-briefing queued chat=${primary.chatId}` +
        `${primary.threadId != null ? ` thread=${primary.threadId}` : ''} ` +
        `surfaces=${surfaces.length} chars=${text.length} ` +
        `cap=${GATEWAY_BOOT_BRIEFING_CAPABILITY}\n`,
    )
    return msg
  } catch (err) {
    // The briefing is best-effort context — a failure here must never
    // block or crash gateway boot.
    log(
      `telegram gateway: boot-briefing failed (${(err as Error).message}) — continuing without briefing\n`,
    )
    return null
  }
}
