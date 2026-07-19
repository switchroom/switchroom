/**
 * #3020 — Telegram `/stop` command + bare operator "stop" keyword.
 *
 * Pure-logic coverage for telegram-plugin/gateway/stop-command.ts (parser +
 * reply builder), plus structural pins on gateway.ts wiring in the style of
 * gateway-pending-command-wiring.test.ts — the halt sequence lives in
 * un-exported inline closures, so we assert on the source structure.
 * Also pins the /stop → /agentstop rename in the command catalogue.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { parseStopKeyword, buildStopReply } from '../gateway/stop-command.js'
import { switchroomHelpCommandNames, switchroomHelpText } from '../welcome-text.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const GATEWAY_SRC = readFileSync(resolve(__dirname, '..', 'gateway', 'gateway.ts'), 'utf8')
// P7 PR-2 (#2996): the handleInbound stop-keyword intercept block moved into
// inbound-interceptors.ts (`interceptStopKeyword`). The coalescer bypass stays
// in gateway.ts. Scrapes anchor on whichever file now owns each literal.
const INTERCEPTORS_SRC = readFileSync(
  resolve(__dirname, '..', 'gateway', 'inbound-interceptors.ts'),
  'utf8',
)

describe('parseStopKeyword', () => {
  it('matches the exact word stop, case-insensitively', () => {
    for (const t of ['stop', 'Stop', 'STOP', 'sToP']) {
      expect(parseStopKeyword(t), t).toBe(true)
    }
  })
  it('tolerates surrounding whitespace and a single trailing . or !', () => {
    for (const t of ['  stop  ', 'stop.', 'stop!', ' STOP! ', '\nstop\n']) {
      expect(parseStopKeyword(t), JSON.stringify(t)).toBe(true)
    }
  })
  it('does NOT match stop inside normal speech', () => {
    for (const t of [
      'stop the build',
      'please stop',
      'stop it',
      'stopping',
      'nonstop',
      'stop?',
      'stop!!',
      'stop..',
      '/stop', // the slash command routes via bot.command, not the keyword
      '! stop',
      'stop now',
      '',
      '   ',
    ]) {
      expect(parseStopKeyword(t), JSON.stringify(t)).toBe(false)
    }
  })
})

describe('buildStopReply', () => {
  it('is honest when nothing is running', () => {
    const r = buildStopReply(false, [])
    expect(r.text).toContain('Nothing running')
    expect(r.text).not.toContain('cancelled')
  })
  it('confirms the cancel when a turn was in flight', () => {
    const r = buildStopReply(true, [])
    expect(r.text).toContain('Turn cancelled')
    expect(r.text).not.toContain('Queued')
  })
  it('mentions surviving queued session commands (singular)', () => {
    const r = buildStopReply(true, ['/model fable'])
    expect(r.text).toContain('Turn cancelled')
    expect(r.text).toContain('/model fable')
    expect(r.text).toContain('survives')
    expect(r.text).toContain('idle')
  })
  it('mentions surviving queued session commands (plural)', () => {
    const r = buildStopReply(true, ['/model fable', '/effort high'])
    expect(r.text).toContain('/model fable')
    expect(r.text).toContain('/effort high')
    expect(r.text).toContain('Queued commands')
    expect(r.text).toContain('survive')
  })
})

describe('gateway wiring — /stop cancels the in-flight turn (#3020)', () => {
  it('registers /stop gated on isAuthorizedSender, honest-idle via turnInFlightForGate, halting via executeHaltNow', () => {
    const idx = GATEWAY_SRC.indexOf("bot.command('stop', async ctx => {")
    expect(idx).toBeGreaterThan(0)
    const win = GATEWAY_SRC.slice(idx, idx + 900)
    expect(win).toContain('if (!isAuthorizedSender(ctx)) return')
    expect(win).toContain('turnInFlightForGate()')
    expect(win).toContain('buildStopReply(false')
    expect(win).toContain("executeHaltNow('stop-command')")
    expect(win).toContain('buildStopReply(true')
    // Queued /model + /effort survive the halt and are named in the reply.
    expect(win).toContain('pendingSessionCommand.list()')
  })

  it('container stop moved to /agentstop and still dispatches hostd agent_stop', () => {
    const idx = GATEWAY_SRC.indexOf("bot.command('agentstop', async ctx => {")
    expect(idx).toBeGreaterThan(0)
    const win = GATEWAY_SRC.slice(idx, idx + 700)
    expect(win).toContain("op: 'agent_stop'")
    // The new /stop must NOT dispatch a container stop.
    const stopIdx = GATEWAY_SRC.indexOf("bot.command('stop', async ctx => {")
    expect(GATEWAY_SRC.slice(stopIdx, stopIdx + 900)).not.toContain("op: 'agent_stop'")
  })

  it('executeHaltNow honors the safe-boundary deferral then fires tmux C-c, cancels the obligation, and releases busy state', () => {
    const fnIdx = GATEWAY_SRC.indexOf('async function executeHaltNow(')
    expect(fnIdx).toBeGreaterThan(0)
    const win = GATEWAY_SRC.slice(fnIdx, fnIdx + 5500)
    const deferIdx = win.indexOf('decideInterruptTiming({')
    expect(deferIdx).toBeGreaterThan(0)
    expect(win).toContain('resolveInterruptMaxWaitMs')
    const waitIdx = win.indexOf('await waitForSafeBoundary(')
    const sigintIdx = win.indexOf('sendAgentInterrupt({ agentName })')
    const cancelIdx = win.indexOf('cancelInterruptedObligation()')
    const stampIdx = win.indexOf("endedVia: 'stop' as const")
    const endIdx = win.indexOf('endCurrentTurnAtomic(turn)')
    const releaseIdx = win.indexOf('releaseTurnBufferGate(key, turn)')
    // Ordered: defer-wait → C-c → obligation cancel → clean registry stamp
    // (so the cancelled turn can never boot-resume) → deterministic release.
    expect(waitIdx).toBeGreaterThan(deferIdx)
    expect(sigintIdx).toBeGreaterThan(waitIdx)
    expect(cancelIdx).toBeGreaterThan(sigintIdx)
    expect(stampIdx).toBeGreaterThan(cancelIdx)
    expect(endIdx).toBeGreaterThan(stampIdx)
    expect(releaseIdx).toBeGreaterThan(endIdx)
  })

  it('executeHaltNow guards against the wrong-turn kill race (snapshot at entry, no-op if the turn changed)', () => {
    const fnIdx = GATEWAY_SRC.indexOf('async function executeHaltNow(')
    const win = GATEWAY_SRC.slice(fnIdx, fnIdx + 5500)
    // Identity snapshotted BEFORE the boundary wait…
    const snapIdx = win.indexOf('const haltTarget = currentTurn')
    const waitIdx = win.indexOf('await waitForSafeBoundary(')
    expect(snapIdx).toBeGreaterThan(0)
    expect(snapIdx).toBeLessThan(waitIdx)
    // …and re-checked AFTER it, before the C-c: a changed turn no-ops both
    // the SIGINT and the teardown (the requester's turn already ended).
    const guardIdx = win.indexOf('currentTurn !== haltTarget')
    const sigintIdx = win.indexOf('sendAgentInterrupt({ agentName })')
    expect(guardIdx).toBeGreaterThan(waitIdx)
    expect(guardIdx).toBeLessThan(sigintIdx)
    const afterGuard = win.slice(guardIdx)
    expect(afterGuard).toMatch(/\n\s*return\b/)
  })

  it('executeHaltNow cancels the halted turn\'s pending permission cards and kicks the session-command drain', () => {
    const fnIdx = GATEWAY_SRC.indexOf('async function executeHaltNow(')
    const win = GATEWAY_SRC.slice(fnIdx, fnIdx + 5500)
    // Item 4: deny + strip pending Approve/Deny cards so the buffer gate
    // opens and a later tap can't dispatch into an idle session.
    const permCancelIdx = win.indexOf('cancelPendingPermissionsForHalt(origin)')
    expect(permCancelIdx).toBeGreaterThan(0)
    // Item 5: after busy release, drain a queued /model / /effort promptly
    // instead of waiting for the 60s reaper.
    const drainIdx = win.indexOf('if (!turnInFlightForGate()) void drainPendingSessionCommand()')
    const releaseIdx = win.indexOf('releaseTurnBufferGate(key, turn)')
    expect(drainIdx).toBeGreaterThan(releaseIdx)
    // The cancel helper itself denies, strips, and forgets each card.
    const helperIdx = GATEWAY_SRC.indexOf('function cancelPendingPermissionsForHalt(')
    expect(helperIdx).toBeGreaterThan(0)
    const helperWin = GATEWAY_SRC.slice(helperIdx, helperIdx + 1200)
    expect(helperWin).toContain("behavior: 'deny'")
    expect(helperWin).toContain('stripCancelledPermissionCards(')
    expect(helperWin).toContain('pendingPermissions.delete(requestId)')
    expect(helperWin).toContain('permCardStore.remove(requestId)')
  })

  it('the session-event ingest kicks halt-boundary waiters alongside the deferred-interrupt boundary check', () => {
    const idx = GATEWAY_SRC.indexOf('toolFlightTracker.onEvent(ev)')
    expect(idx).toBeGreaterThan(0)
    const win = GATEWAY_SRC.slice(idx, idx + 600)
    expect(win).toContain('notifyHaltBoundaryWaiters()')
  })

  it('bare "stop" bypasses the coalescer and routes into executeHaltNow in handleInbound', () => {
    // Coalesce bypass sits next to the `!` bypass.
    const bypassIdx = GATEWAY_SRC.indexOf('parseInterruptMarker(text).isInterrupt')
    expect(bypassIdx).toBeGreaterThan(0)
    const bypassWin = GATEWAY_SRC.slice(bypassIdx, bypassIdx + 800)
    expect(bypassWin).toContain('parseStopKeyword(text)')
    // interceptStopKeyword block (P7 PR-2, inbound-interceptors.ts): honest
    // idle reply or halt + confirmation.
    const kwIdx = INTERCEPTORS_SRC.indexOf("deps.executeHaltNow('stop-keyword')")
    expect(kwIdx).toBeGreaterThan(0)
    const kwWin = INTERCEPTORS_SRC.slice(kwIdx - 1600, kwIdx + 900)
    expect(kwWin).toContain('deps.turnInFlightForGate()')
    expect(kwWin).toContain('buildStopReply(inFlight, queuedLabels)')
    // Intercepted — never forwarded to the agent as a turn.
    expect(kwWin).toContain('return { handled: true }')
  })

  it('the empty-`!` interrupt routes through the same executeHaltNow helper', () => {
    expect(GATEWAY_SRC).toContain("executeHaltNow('bang-empty')")
  })

  it('/stop with an argument warns and does NOT halt (old container-stop muscle memory)', () => {
    const idx = GATEWAY_SRC.indexOf("bot.command('stop', async ctx => {")
    const win = GATEWAY_SRC.slice(idx, idx + 1600)
    const argIdx = win.indexOf('const arg = ctx.match?.trim()')
    const haltIdx = win.indexOf("executeHaltNow('stop-command')")
    expect(argIdx).toBeGreaterThan(0)
    // Arg check runs BEFORE the halt and returns without cancelling.
    expect(argIdx).toBeLessThan(haltIdx)
    expect(win).toContain('takes no argument')
    expect(win).toContain('/agentstop')
    expect(win).toContain('Nothing was stopped')
  })

  it('a photo/attachment captioned "stop" never trips the halt-and-drop path', () => {
    // Coalesce bypass: pure text only.
    const bypassIdx = GATEWAY_SRC.indexOf(
      'parseStopKeyword(text) && downloadImage == null && attachment == null',
    )
    expect(bypassIdx).toBeGreaterThan(0)
    // interceptStopKeyword block (P7 PR-2): also excludes coalesced extra
    // attachments (per-message facts arrive as the `p.` params object).
    const kwIdx = INTERCEPTORS_SRC.indexOf("deps.executeHaltNow('stop-keyword')")
    const kwWin = INTERCEPTORS_SRC.slice(kwIdx - 2400, kwIdx)
    expect(kwWin).toContain('p.downloadImage == null')
    expect(kwWin).toContain('p.attachment == null')
    expect(kwWin).toContain('p.extraAttachments == null || p.extraAttachments.length === 0')
  })
})

describe('command catalogue — /agentstop rename regression (#3020)', () => {
  it('help name array carries both stop (turn cancel) and agentstop (container)', () => {
    expect(switchroomHelpCommandNames as readonly string[]).toContain('stop')
    expect(switchroomHelpCommandNames as readonly string[]).toContain('agentstop')
  })
  it('help text documents /agentstop as the container verb and /stop as the turn cancel', () => {
    const out = switchroomHelpText('assistant')
    expect(out).toContain('/agentstop')
    expect(out).toMatch(/\/stop.*(in-flight|turn)/i)
    // No stale "/stop [name] — stop an agent" container wording.
    expect(out).not.toContain('`/stop [name]`')
  })
})
