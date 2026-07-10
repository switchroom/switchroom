import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * #2555 — run-hook.sh must tolerate a Node exit-134 (uv_thread_create abort
 * under memory pressure): retry once, and if it still aborts, skip cleanly
 * (exit 0) rather than propagating 134. Real non-134 statuses pass through.
 *
 * We drive the wrapper with a fake command (a tiny sh script) whose exit code
 * is scripted via a counter file, so we exercise the exact control flow
 * without needing a real memory-pressured Node.
 */
const wrapper = resolve(
  fileURLToPath(new URL('../hooks/run-hook.sh', import.meta.url)),
)

describe('#2555 run-hook.sh exit-134 tolerance', () => {
  let dir: string
  let fake: string
  let counter: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'run-hook-'))
    fake = join(dir, 'fake.sh')
    counter = join(dir, 'n')
    writeFileSync(counter, '0')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  /** Fake command: exits `codes[attemptIndex]`, records each invocation. */
  function writeFake(codes: number[]): void {
    writeFileSync(
      fake,
      [
        '#!/bin/sh',
        `n=$(cat "${counter}")`,
        `echo "$((n + 1))" > "${counter}"`,
        'case "$n" in',
        ...codes.map((c, i) => `  ${i}) exit ${c} ;;`),
        `  *) exit ${codes[codes.length - 1]} ;;`,
        'esac',
      ].join('\n'),
    )
  }

  const run = (input = '') =>
    spawnSync('sh', [wrapper, 'sh', fake], { encoding: 'utf-8', input })

  const attempts = () => Number(readFileSync(counter, 'utf-8').trim())

  it('passes a clean exit 0 through without retrying', () => {
    writeFake([0])
    const r = run()
    expect(r.status).toBe(0)
    expect(attempts()).toBe(1)
  })

  it('passes a real non-134 failure through unchanged (no retry, not masked)', () => {
    writeFake([2])
    const r = run()
    expect(r.status).toBe(2)
    expect(attempts()).toBe(1)
  })

  it('retries ONCE on a 134 abort and succeeds on the second attempt', () => {
    writeFake([134, 0])
    const r = run()
    expect(r.status).toBe(0)
    expect(attempts()).toBe(2)
  })

  it('skips cleanly (exit 0) when it aborts 134 twice — no crash card', () => {
    writeFake([134, 134])
    const r = run()
    expect(r.status).toBe(0) // skipped cleanly, NOT 134
    expect(attempts()).toBe(2)
    expect(r.stderr).toMatch(/skipping hook cleanly/)
  })

  it('exports a shrunk UV_THREADPOOL_SIZE to the child', () => {
    writeFileSync(fake, `#!/bin/sh\necho "$UV_THREADPOOL_SIZE"\nexit 0\n`)
    const r = run()
    expect(r.stdout.trim()).toBe('1')
  })

  it('replays the SAME stdin payload on the retry (scanner never sees empty input)', () => {
    // Fake: attempt 0 reads stdin then aborts 134; attempt 1 reads stdin and
    // records it, then exits 0. If stdin were not preserved, the recorded
    // payload on the retry would be empty.
    const seen = join(dir, 'seen-stdin')
    writeFileSync(
      fake,
      [
        '#!/bin/sh',
        `n=$(cat "${counter}")`,
        `echo "$((n + 1))" > "${counter}"`,
        'data=$(cat)', // drain stdin (the abort-after-read scenario)
        `echo "$data" > "${seen}.$n"`,
        '[ "$n" = "0" ] && exit 134',
        'exit 0',
      ].join('\n'),
    )
    const r = run('SECRET-PAYLOAD-123')
    expect(r.status).toBe(0)
    expect(attempts()).toBe(2)
    // The RETRY (attempt 1) must have received the full payload, not empty.
    expect(readFileSync(`${seen}.1`, 'utf-8').trim()).toBe('SECRET-PAYLOAD-123')
  })

  it('FAILS CLOSED (propagates 134) for a security hook that aborts twice', () => {
    // A genuinely broken secret scanner must NOT silently pass — exit 0 after
    // two aborts would be a silent security bypass.
    const secFake = join(dir, 'secret-guard-pretool.mjs')
    writeFileSync(
      secFake,
      [
        '#!/bin/sh',
        `n=$(cat "${counter}")`,
        `echo "$((n + 1))" > "${counter}"`,
        'exit 134',
      ].join('\n'),
    )
    const r = spawnSync('sh', [wrapper, 'sh', secFake], { encoding: 'utf-8', input: '{}' })
    expect(r.status).toBe(134) // fail closed — NOT skipped
    expect(attempts()).toBe(2)
    expect(r.stderr).toMatch(/FAILING CLOSED/)
  })
})
