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
    const win = GATEWAY_SRC.slice(fnIdx, fnIdx + 3200)
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
    // handleInbound keyword block: honest idle reply or halt + confirmation.
    const kwIdx = GATEWAY_SRC.indexOf("executeHaltNow('stop-keyword')")
    expect(kwIdx).toBeGreaterThan(0)
    const kwWin = GATEWAY_SRC.slice(kwIdx - 1600, kwIdx + 900)
    expect(kwWin).toContain('turnInFlightForGate()')
    expect(kwWin).toContain('buildStopReply(inFlight, queuedLabels)')
    // Intercepted — never forwarded to the agent as a turn.
    expect(kwWin).toContain('return')
  })

  it('the empty-`!` interrupt routes through the same executeHaltNow helper', () => {
    expect(GATEWAY_SRC).toContain("executeHaltNow('bang-empty')")
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
