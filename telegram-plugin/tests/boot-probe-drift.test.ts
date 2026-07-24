/**
 * KEN-130 — boot-card drift probe. Outcome-asserting: a staled stamped
 * surface or a host-written drift report produces a degraded probe row
 * naming the surfaces; a clean agent dir stays ok (silent-when-healthy —
 * ok probes never render a boot-card row).
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { probeDrift } from '../gateway/boot-probes.js'
import {
  CLAUDE_MD_YOURS_MARKER,
  computeConfigHash,
  computeStampFilesFromDisk,
  writeGenerationStamp,
} from '../../src/agents/generation-stamp.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boot-drift-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function seedAndStamp(): void {
  writeFileSync(join(dir, 'start.sh'), '#!/bin/bash\necho hi\n')
  writeFileSync(
    join(dir, 'CLAUDE.md'),
    `# Agent\nmanaged\n\n${CLAUDE_MD_YOURS_MARKER}\n\nyours\n`,
  )
  writeFileSync(join(dir, '.mcp.json'), '{"mcpServers":{}}\n')
  writeGenerationStamp(dir, {
    switchroomVersion: '1.0.0',
    configHash: computeConfigHash({ model: 'opus' }),
    files: computeStampFilesFromDisk(dir),
  })
}

describe('probeDrift', () => {
  it('clean agent dir with stamp → ok (no boot-card row)', async () => {
    seedAndStamp()
    const r = await probeDrift(dir)
    expect(r.status).toBe('ok')
  })

  it('no stamp and no report (fresh agent / pre-KEN-130) → ok', async () => {
    const r = await probeDrift(dir)
    expect(r.status).toBe('ok')
  })

  it('tampered start.sh → degraded row naming start.sh with a next step', async () => {
    seedAndStamp()
    writeFileSync(join(dir, 'start.sh'), '#!/bin/bash\nTAMPERED\n')
    const r = await probeDrift(dir, { agentName: 'bot' })
    expect(r.status).toBe('degraded')
    expect(r.detail).toContain('start.sh')
    expect(r.nextStep).toContain('switchroom apply')
    expect(r.nextStep).toContain('reconcile bot')
  })

  it('operator edit BELOW the CLAUDE.md marker → still ok', async () => {
    seedAndStamp()
    writeFileSync(
      join(dir, 'CLAUDE.md'),
      `# Agent\nmanaged\n\n${CLAUDE_MD_YOURS_MARKER}\n\ncompletely new operator prose\n`,
    )
    const r = await probeDrift(dir)
    expect(r.status).toBe('ok')
  })

  it('host drift report findings surface on the row (with age when stale)', async () => {
    seedAndStamp()
    // Backdate the stamp so the report post-dates the last apply (a
    // report older than the stamp is legitimately suppressed — see the
    // superseded-by-apply test below).
    writeGenerationStamp(dir, {
      generatedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
      switchroomVersion: '1.0.0',
      configHash: computeConfigHash({ model: 'opus' }),
      files: computeStampFilesFromDisk(dir),
    })
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString()
    writeFileSync(
      join(dir, '.switchroom-drift.json'),
      JSON.stringify({
        version: 1,
        generatedAt: twoDaysAgo,
        findings: [
          { surface: 'compose', detail: 'deployed compose differs' },
          { surface: 'hook-scripts', detail: 'image scripts stale' },
        ],
      }),
    )
    const r = await probeDrift(dir)
    expect(r.status).toBe('degraded')
    expect(r.detail).toContain('compose')
    expect(r.detail).toContain('hook-scripts')
    expect(r.detail).toContain('ago') // stale-report age annotation
  })

  it('report older than the stamp (apply healed it) → ok, findings suppressed', async () => {
    // Doctor found drift, then the operator ran `switchroom apply` — the
    // reconcile rewrote the stamp but NOT the doctor report. A freshly
    // applied fleet must be silent; the stale report is superseded.
    writeFileSync(
      join(dir, '.switchroom-drift.json'),
      JSON.stringify({
        version: 1,
        generatedAt: new Date(Date.now() - 3_600_000).toISOString(),
        findings: [{ surface: 'compose', detail: 'was drifted before apply' }],
      }),
    )
    seedAndStamp() // stamp written AFTER the report
    const r = await probeDrift(dir)
    expect(r.status).toBe('ok')
  })

  it('report newer than the stamp still surfaces (drift found after apply)', async () => {
    seedAndStamp()
    writeFileSync(
      join(dir, '.switchroom-drift.json'),
      JSON.stringify({
        version: 1,
        generatedAt: new Date(Date.now() + 1000).toISOString(),
        findings: [{ surface: 'hook-scripts', detail: 'image scripts stale' }],
      }),
    )
    const r = await probeDrift(dir)
    expect(r.status).toBe('degraded')
    expect(r.detail).toContain('hook-scripts')
  })

  it('empty host report (doctor ran clean) → ok', async () => {
    seedAndStamp()
    writeFileSync(
      join(dir, '.switchroom-drift.json'),
      JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), findings: [] }),
    )
    const r = await probeDrift(dir)
    expect(r.status).toBe('ok')
  })

  it('corrupt report is ignored, never degrades the boot card', async () => {
    seedAndStamp()
    writeFileSync(join(dir, '.switchroom-drift.json'), 'not json at all')
    const r = await probeDrift(dir)
    expect(r.status).toBe('ok')
  })
})
