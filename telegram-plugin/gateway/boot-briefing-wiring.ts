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
  type BriefingDailyMemory,
  type HindsightRecallResult,
} from './boot-briefing-builder.js'

/** Recall query the legacy handoff-briefing.sh sends verbatim. */
const HINDSIGHT_RECALL_QUERY = 'what was happening recently in our conversation?'
/** `max_tokens` the shell script sends (jq `--argjson m 800`). */
const HINDSIGHT_RECALL_MAX_TOKENS = 800
/** Recall HTTP budget — the shell's `curl -m 4`. */
const HINDSIGHT_TIMEOUT_MS = 4000

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
  /** Test seam: injected `fetch` for the Hindsight recall. Defaults to the
   *  runtime global `fetch`. Never used in production wiring. */
  fetchImpl?: typeof fetch
}

/**
 * Fetch the Hindsight recall slice (source 2 of the legacy handoff
 * contract). Mirrors `bin/handoff-briefing.sh`'s request EXACTLY:
 * `POST ${HINDSIGHT_API_URL}/v1/default/banks/${HINDSIGHT_BANK_ID}/memories/recall`
 * with body `{query, max_tokens: 800}` and a 4s timeout.
 *
 * Graceful-skip on ANY failure — missing env, timeout, non-200, malformed
 * JSON — returns `[]` so the briefing degrades to its other sources rather
 * than crashing or blocking boot. Never throws.
 */
export async function fetchHindsightRecall(
  env: Record<string, string | undefined>,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number; log?: (line: string) => void } = {},
): Promise<HindsightRecallResult[]> {
  const base = (env.HINDSIGHT_API_URL ?? '').replace(/\/+$/, '')
  const bank = env.HINDSIGHT_BANK_ID ?? ''
  if (!base || !bank) return []
  const doFetch = opts.fetchImpl ?? (globalThis.fetch as typeof fetch | undefined)
  if (typeof doFetch !== 'function') return []
  const log = opts.log
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? HINDSIGHT_TIMEOUT_MS)
  try {
    const url = `${base}/v1/default/banks/${encodeURIComponent(bank)}/memories/recall`
    const resp = await doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: HINDSIGHT_RECALL_QUERY,
        max_tokens: HINDSIGHT_RECALL_MAX_TOKENS,
      }),
      signal: controller.signal,
    })
    if (!resp.ok) {
      // Never log the URL/host — keep the deny reason generic (defence in
      // depth even though the recall URL carries no token).
      log?.(`telegram gateway: boot-briefing hindsight recall non-200 (${resp.status}) — skipping section\n`)
      return []
    }
    const body = (await resp.json()) as { results?: Array<{ text?: unknown; timestamp?: unknown }> }
    const results = Array.isArray(body?.results) ? body.results : []
    return results.map((r) => ({
      text: typeof r?.text === 'string' ? r.text : '',
      timestamp: typeof r?.timestamp === 'string' ? r.timestamp : null,
    }))
  } catch {
    // Timeout (abort), DNS/connection failure, malformed JSON — all graceful.
    log?.('telegram gateway: boot-briefing hindsight recall unavailable — skipping section\n')
    return []
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Read today's daily-memory file (source 3 of the legacy handoff contract):
 * `<workspaceDir>/memory/<YYYY-MM-DD>.md`, with the date derived in the
 * agent's LOCAL timezone (SWITCHROOM_TIMEZONE → TZ → system-local), exactly
 * as `bin/workspace-dynamic-hook.sh` reads it.
 *
 * NOTE — deliberate divergence from bin/handoff-briefing.sh: that script
 * reads `${WORKSPACE_DIR:-$AGENT_DIR}/memory/...`, but WORKSPACE_DIR is never
 * set in the agent env, so it resolves to `<agentDir>/memory/...` — the WRONG
 * path. Daily notes actually live at `<agentDir>/workspace/memory/...` (see
 * `resolveAgentWorkspaceDir` and `bin/workspace-dynamic-hook.sh`, the
 * authoritative reader). We mirror the correct path here (honouring an
 * explicit WORKSPACE_DIR override if one is ever set), not the shell's bug.
 * Returns null on a missing/empty file or any read error. Never throws.
 */
export function readDailyMemory(
  agentDir: string,
  env: Record<string, string | undefined>,
  nowMs: number,
  readFile: (path: string) => string = (p) => readFileSync(p, 'utf8'),
): BriefingDailyMemory | null {
  const date = agentLocalDate(nowMs, env.SWITCHROOM_TIMEZONE || env.TZ || undefined)
  if (!date) return null
  const workspaceDir = env.WORKSPACE_DIR && env.WORKSPACE_DIR.trim()
    ? env.WORKSPACE_DIR
    : join(agentDir, 'workspace')
  const file = join(workspaceDir, 'memory', `${date}.md`)
  try {
    const content = readFile(file)
    if (!content || !content.trim()) return null
    return { date, content }
  } catch {
    return null // ENOENT / unreadable — no section, no crash.
  }
}

/** Format `nowMs` as `YYYY-MM-DD` in `tz` (SWITCHROOM_TIMEZONE → TZ →
 *  system-local). Uses `en-CA` which renders ISO `YYYY-MM-DD`. Returns ''
 *  if the timezone is invalid (Intl throws) so the caller skips the
 *  section rather than looking up the wrong day. */
function agentLocalDate(nowMs: number, tz: string | undefined): string {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
    // en-CA yields YYYY-MM-DD; guard against locale/impl drift anyway.
    const s = fmt.format(new Date(nowMs))
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ''
  } catch {
    return ''
  }
}

/**
 * Build + enqueue the boot briefing when the feature flag and suppression
 * rules allow. Returns the queued inbound (for observability/tests) or
 * null when nothing was queued.
 *
 * ASYNC because source 2 (Hindsight recall) is an HTTP fetch. The fetch is
 * AWAITED to completion-or-timeout BEFORE `put` runs, so the briefing is
 * only ever enqueued with its Hindsight section already assembled — it can
 * never be delivered with the section racing in late. The 4s ceiling bounds
 * the added boot latency, and (like every other path here) any failure
 * degrades to "no Hindsight section", never a blocked or crashed boot. The
 * caller must AWAIT this before the resume inbound is spooled / the
 * boot-replay loop pulls live entries, to preserve briefing-before-resume
 * delivery order.
 */
export async function maybeQueueBootBriefing(
  opts: MaybeQueueBootBriefingOptions,
): Promise<InboundMessage | null> {
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
    // No active Telegram surface = no delivery target for the synthetic
    // briefing inbound (it routes to the primary surface's chat). Short-circuit
    // BEFORE the Hindsight fetch so a zero-history boot never pays the 4s
    // recall timeout. (Deliberate narrowing vs the file-writing legacy path,
    // which has no routing target and can emit a Hindsight/daily-only
    // briefing — documented in the PR.)
    if (surfaces.length === 0) {
      // Consume the generation even when empty (parity with the !text path
      // below, and with main's pre-short-circuit behaviour where zero
      // surfaces rendered to '' and hit markGeneration()). Had there been
      // nothing to brief at boot, a later respawn on the same generation must
      // not suddenly brief mid-session just because fresh messages arrived
      // after the session came up.
      markGeneration()
      log('telegram gateway: boot-briefing empty (no recent surfaces) — nothing queued\n')
      return null
    }
    const restartReason = readRestartBreadcrumb({
      restartReasonPath: join(agentDir, '.restart-reason'),
      env: opts.env,
      readFile: (p) => readFileSync(p, 'utf8'),
    })
    // Sources 2 + 3 of the legacy handoff contract. The Hindsight fetch is
    // AWAITED here (4s ceiling) so the section is present before `put` — the
    // briefing is never enqueued mid-fetch.
    const hindsight = await fetchHindsightRecall(opts.env, {
      fetchImpl: opts.fetchImpl,
      log,
    })
    const dailyMemory = readDailyMemory(agentDir, opts.env, nowMs)
    const text = renderBootBriefing(surfaces, { nowMs, restartReason, hindsight, dailyMemory })
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
        `surfaces=${surfaces.length} hindsight=${hindsight.length} ` +
        `daily=${dailyMemory != null ? 'yes' : 'no'} chars=${text.length} ` +
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
