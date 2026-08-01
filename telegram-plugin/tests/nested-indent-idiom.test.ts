import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderBootCard } from '../gateway/boot-card.js'
import { renderUpdateOutcomeLine } from '../gateway/update-announce.js'
import { NESTED_PREFIX } from '../status-no-truncate.js'

/**
 * #4115 — ONE indent idiom in the repo, and it is the one that actually
 * renders.
 *
 * #3668 fixed the status card's nested lines by moving `NESTED_PREFIX` off
 * ASCII spaces onto U+2800 BRAILLE PATTERN BLANK: card bodies reach Telegram
 * as GFM markdown parsed SERVER-SIDE, and that parser left-trims a leading
 * whitespace run off a content line, so an ASCII (or U+00A0) indent is dropped
 * on the wire and the line renders FLAT. Live-verified on a phone 2026-07-26 —
 * the record is on `WORKER_STEP_INDENT` in `status-no-truncate.ts`.
 *
 * The boot card and the update-announce line were NOT migrated by that PR, so
 * they kept shipping the collapsed non-indent to the user. These tests assert
 * what RENDERS (the leading run survives a server-side left-trim), not merely
 * that a constant was referenced — a byte-equality assertion against the old
 * literal is exactly what let the pre-#3668 indent ship green and inert.
 */

/** Every rule a server-side trimmer could plausibly use. */
const isTrimmableWhitespace = (ch: string): boolean =>
  /\s/u.test(ch) || /\p{White_Space}/u.test(ch) || /\p{Zs}/u.test(ch)

/**
 * The assertion that ties to rendering: after a leading-whitespace left-trim
 * of the kind Telegram applies, the line STILL carries its full indent, and it
 * does not lead with either character already proven flat on a phone.
 */
function expectSurvivesLeftTrim(line: string): void {
  expect(line.startsWith(NESTED_PREFIX)).toBe(true)
  expect(
    line.replace(/^[\s\p{White_Space}]+/u, '').startsWith(NESTED_PREFIX),
    `nested line "${line.slice(0, 40)}…" loses its indent to a leading-whitespace trim — ` +
      `it renders FLAT on a phone (#3668/#4115). Use NESTED_PREFIX.`,
  ).toBe(true)
  expect(line.startsWith(' ')).toBe(false)
  expect(line.startsWith(' ')).toBe(false)
  const indent = [...line.slice(0, line.indexOf('↳'))]
  expect(indent.length).toBeGreaterThan(0)
  for (const ch of indent) expect(isTrimmableWhitespace(ch)).toBe(false)
}

/** Card lines with the stack's own break chrome removed. */
function linesOf(card: string): string[] {
  return card.split('\n').map((l) => l.replace(/[ \t]+$/, ''))
}

describe('boot card nested lines render as a real indent (#4115)', () => {
  it("a probe's next-step continuation line survives a server-side left-trim", () => {
    // Fail-before: this row was `'    ↳ ' + nextStep` — four ASCII spaces, all
    // of them trimmed, so the line rendered flush against its probe row.
    const out = renderBootCard({
      agentName: 'lawgpt',
      version: 'v0.7.16',
      probes: {
        skills: {
          status: 'degraded',
          label: 'Skills',
          detail: '10/10 dangling: a, b, c +7 more',
          nextStep: 'Run `switchroom agent reconcile lawgpt` to rebuild symlinks',
        },
      },
    })
    const nested = linesOf(out).filter((l) => l.includes('↳'))
    expect(nested.length).toBe(1)
    expectSurvivesLeftTrim(nested[0])
  })

  it('the crash row tail-logs continuation line survives a server-side left-trim', () => {
    const out = renderBootCard({
      agentName: 'lawgpt',
      version: 'v0.7.16',
      restartReason: 'crash',
      restartAgeMs: 6_100,
    })
    const nested = linesOf(out).filter((l) => l.includes('↳'))
    expect(nested.length).toBe(1)
    expect(nested[0]).toContain('Tail logs:')
    expectSurvivesLeftTrim(nested[0])
  })
})

describe('update-announce recovery line renders as a real indent (#4115)', () => {
  it('the failure card\'s recovery continuation survives a server-side left-trim', () => {
    // Fail-before: the recovery row was `'    ↳ Recovery: …'`.
    const line = renderUpdateOutcomeLine({
      ts: '2026-05-17T11:59:00.000Z',
      op: 'update_apply',
      caller: { kind: 'operator' },
      request_id: 'req-2',
      result: 'error',
      exit_code: 1,
      duration_ms: 100,
      phase: 'terminal',
      stderr_tail: 'compose pull failed: registry timeout',
      install_context: { install_type: 'binary', detected_at: '2026-05-17T11:00:00Z' },
    })
    const nested = linesOf(line).filter((l) => l.includes('↳'))
    expect(nested.length).toBe(1)
    expect(nested[0]).toContain('Recovery:')
    expectSurvivesLeftTrim(nested[0])
  })
})

describe('GUARD: no ASCII-space nested indent may reappear in the source (#4115)', () => {
  // A run of ASCII spaces/tabs immediately before the `↳` nesting glyph — the
  // exact shape that renders flat. The one exported constant is the only legal
  // way to indent a nested card line.
  const ASCII_INDENT_BEFORE_ARROW = /[ \t]{2,}↳/

  const here = fileURLToPath(import.meta.url)
  const repoRoot = join(here, '..', '..', '..')
  const ROOTS = ['telegram-plugin', 'src']
  const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage'])

  function walk(dir: string, out: string[]): string[] {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p, out)
      else if (p.endsWith('.ts') && p !== here) out.push(p)
    }
    return out
  }

  it('no source file hardcodes an ASCII-indent-plus-↳ nested line', () => {
    const offenders: string[] = []
    for (const root of ROOTS) {
      for (const file of walk(join(repoRoot, root), [])) {
        const text = readFileSync(file, 'utf8')
        text.split('\n').forEach((line, i) => {
          if (ASCII_INDENT_BEFORE_ARROW.test(line)) {
            offenders.push(`${relative(repoRoot, file)}:${i + 1}: ${line.trim().slice(0, 100)}`)
          }
        })
      }
    }
    expect(
      offenders,
      `Hardcoded ASCII indent before a '↳' nesting glyph. Telegram left-trims a leading ` +
        `ASCII-whitespace run off a content line, so this renders FLAT on a phone (#3668/#4115). ` +
        `Import NESTED_PREFIX from status-no-truncate.js instead:\n  ${offenders.join('\n  ')}`,
    ).toEqual([])
  })

  it('the guard actually fires on the shape it is guarding against', () => {
    // A guard that cannot fail is not a guard: pin the detector on the exact
    // literal the two migrated call sites used to carry.
    expect(ASCII_INDENT_BEFORE_ARROW.test("degradedRows.push(`    ↳ ${next}`)")).toBe(true)
    expect(ASCII_INDENT_BEFORE_ARROW.test('   ↳ Recovery: reinstall')).toBe(true)
    // …and stays quiet on the legal idiom and on prose that merely mentions ↳.
    expect(ASCII_INDENT_BEFORE_ARROW.test(`${NESTED_PREFIX}Recovery: reinstall`)).toBe(false)
    expect(ASCII_INDENT_BEFORE_ARROW.test('the nested ↳ block is windowed')).toBe(false)
  })
})
