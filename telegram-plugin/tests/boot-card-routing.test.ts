/**
 * Boot-card "Routing" row (.routing-mode observability — 2026-07-17 boot-race
 * incident: silent fable→opus demotion on one agent, silent fable→router-root
 * divergence on another).
 *
 * Contract:
 *   - `readRoutingMode` parses `<agentDir>/.routing-mode`, returns null on
 *     absence/garbage (tolerant), and flags `prevBoot` when the file's mtime
 *     predates this gateway boot (render-timing hazard: the gateway's outer
 *     pass can render the card before the inner pass writes this boot's line).
 *   - `renderBootCard` renders the row when `routing` is passed; stale values
 *     are suffixed "(prev boot)" — never presented as current; divergence
 *     (landed ≠ declared) gets the warning dot; absent file → no row at all.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, utimesSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readRoutingMode, renderRoutingRow, renderBootCard, containerBootStartMs } from '../gateway/boot-card.js'

const LINE =
  'mode=router-root base=http://litellm:4010 model=fable litellm_ok=1 declared=router-root ts=2026-07-17T02:00:00Z\n'

describe('readRoutingMode', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'routing-mode-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('parses a current-boot line', () => {
    writeFileSync(join(dir, '.routing-mode'), LINE)
    const r = readRoutingMode(dir, Date.now() - 60_000)
    expect(r).not.toBeNull()
    expect(r!.mode).toBe('router-root')
    expect(r!.declared).toBe('router-root')
    expect(r!.model).toBe('fable')
    expect(r!.litellmOk).toBe('1')
    expect(r!.prevBoot).toBe(false)
  })

  it('returns null when the file is absent (fleets pre-dating the state file)', () => {
    expect(readRoutingMode(dir, Date.now())).toBeNull()
  })

  it('returns null on a garbage file with no mode= field', () => {
    writeFileSync(join(dir, '.routing-mode'), 'not a routing line\n')
    expect(readRoutingMode(dir, Date.now())).toBeNull()
  })

  it('flags prevBoot when the file mtime predates this gateway boot', () => {
    writeFileSync(join(dir, '.routing-mode'), LINE)
    const old = (Date.now() - 3_600_000) / 1000
    utimesSync(join(dir, '.routing-mode'), old, old)
    const r = readRoutingMode(dir, Date.now() - 1_000)
    expect(r).not.toBeNull()
    expect(r!.prevBoot).toBe(true)
  })
})

describe('containerBootStartMs', () => {
  it('derives PID-1 start epoch from /proc/stat btime + /proc/1/stat starttime', () => {
    const btime = 1_700_000_000 // seconds since epoch
    const startTicks = 500 // 5s after boot at 100 HZ
    const fsImpl = {
      readFileSync: ((p: unknown) => {
        if (p === '/proc/stat') return `cpu 1 2 3\nbtime ${btime}\nprocesses 100\n`
        if (p === '/proc/1/stat')
          // pid (comm) state ... field22=starttime. comm has a space+paren to
          // exercise the last-')' split.
          return `1 (init a) S 0 1 1 0 -1 0 0 0 0 0 0 0 0 0 0 0 0 0 ${startTicks} 0`
        throw new Error('unexpected path')
      }) as typeof readFileSync,
    }
    expect(containerBootStartMs(fsImpl)).toBe((btime + startTicks / 100) * 1000)
  })

  it('returns null when /proc is unavailable (fallback path for callers)', () => {
    const fsImpl = {
      readFileSync: (() => {
        throw new Error('ENOENT')
      }) as typeof readFileSync,
    }
    expect(containerBootStartMs(fsImpl)).toBeNull()
  })

  it('returns null when btime is missing', () => {
    const fsImpl = {
      readFileSync: ((p: unknown) =>
        p === '/proc/stat' ? 'cpu 1 2 3\nprocesses 100\n' : '1 (init) S 0') as typeof readFileSync,
    }
    expect(containerBootStartMs(fsImpl)).toBeNull()
  })
})

describe('renderRoutingRow / renderBootCard routing row', () => {
  const base = { agentName: 'klanker', version: 'v1' }

  it('renders a converged row with the routing dot and model', () => {
    const row = renderRoutingRow({
      mode: 'router-root', declared: 'router-root', model: 'fable', litellmOk: '1', prevBoot: false,
    })
    expect(row).toContain('**Routing**')
    expect(row).toContain('router-root')
    expect(row).toContain('`fable`')
    expect(row).toContain('litellm ok')
    expect(row).not.toContain('≠')
    expect(row).not.toContain('prev boot')
  })

  it('marks divergence (landed ≠ declared) with the warning dot', () => {
    const row = renderRoutingRow({
      mode: 'passthrough', declared: 'router-root', model: 'opus', litellmOk: '0', prevBoot: false,
    })
    expect(row).toContain('🟡')
    expect(row).toContain('≠ declared router-root')
    expect(row).toContain('litellm unconfirmed')
  })

  it('labels a stale (previous-boot) value instead of presenting it as current', () => {
    const row = renderRoutingRow({
      mode: 'router-root', declared: 'router-root', prevBoot: true,
    })
    expect(row).toContain('(prev boot)')
  })

  it('renderBootCard includes the routing row when passed, omits it when routing is null/absent', () => {
    const withRow = renderBootCard({
      ...base,
      routing: { mode: 'router-root', declared: 'passthrough', model: 'fable', litellmOk: '1', prevBoot: false },
    })
    expect(withRow).toContain('**Routing**')
    expect(withRow).toContain('router-root')

    const without = renderBootCard({ ...base })
    expect(without).not.toContain('Routing')
    const withNull = renderBootCard({ ...base, routing: null })
    expect(withNull).toBe(without)
  })
})
