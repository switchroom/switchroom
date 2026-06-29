/**
 * Unit tests for the config-snapshot module (config-snapshot.ts).
 *
 * Covers:
 *   1. captureConfigSnapshot — field normalization, null handling
 *   2. diffSnapshots — model changed only; tools changed only; everything
 *      changed; nothing changed; first boot (previous=null)
 *   3. renderConfigChangeDim — verbatim for model/memory, coarse for tools/skills
 *   4. loadSnapshot / persistSnapshot — round-trip, corrupt file, first boot
 *   5. hashStringArray — deterministic, order-independent, null/empty handling
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  captureConfigSnapshot,
  diffSnapshots,
  renderConfigChangeDim,
  hashStringArray,
  normalizeModel,
  loadSnapshot,
  persistSnapshot,
  type ConfigSnapshot,
  type ConfigDiff,
} from '../gateway/config-snapshot.js'

let tmp: string
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'cfg-snap-')) })
afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

// ── hashStringArray ───────────────────────────────────────────────────────────

describe('hashStringArray', () => {
  it('returns null for null input', () => {
    expect(hashStringArray(null)).toBeNull()
  })

  it('returns null for empty array', () => {
    expect(hashStringArray([])).toBeNull()
  })

  it('returns a 12-char hex string for a non-empty array', () => {
    const h = hashStringArray(['bash', 'computer'])
    expect(typeof h).toBe('string')
    expect(h!.length).toBe(12)
    expect(/^[0-9a-f]{12}$/.test(h!)).toBe(true)
  })

  it('is order-independent — sorted before hashing', () => {
    const h1 = hashStringArray(['bash', 'computer', 'str_replace_based_edit_tool'])
    const h2 = hashStringArray(['str_replace_based_edit_tool', 'bash', 'computer'])
    expect(h1).toBe(h2)
  })

  it('produces different hashes for different content', () => {
    const h1 = hashStringArray(['bash'])
    const h2 = hashStringArray(['computer'])
    expect(h1).not.toBe(h2)
  })
})

// ── normalizeModel ────────────────────────────────────────────────────────────

describe('normalizeModel', () => {
  it('lowercases the model string', () => {
    expect(normalizeModel('Claude-Sonnet-4-5')).toBe('claude-sonnet-4-5')
  })

  it('trims whitespace', () => {
    expect(normalizeModel('  claude-opus-4  ')).toBe('claude-opus-4')
  })

  it('returns null for null, undefined, or empty string', () => {
    expect(normalizeModel(null)).toBeNull()
    expect(normalizeModel(undefined)).toBeNull()
    expect(normalizeModel('')).toBeNull()
    expect(normalizeModel('   ')).toBeNull()
  })
})

// ── captureConfigSnapshot ────────────────────────────────────────────────────

describe('captureConfigSnapshot', () => {
  it('captures all fields from config', () => {
    const snap = captureConfigSnapshot({
      agentName: 'finn',
      model: 'claude-sonnet-4-5',
      toolsAllow: ['bash', 'computer'],
      skills: ['search'],
      memoryCollection: 'finn-memories',
      now: () => 1000,
    })
    expect(snap.schema).toBe(1)
    expect(snap.capturedAtMs).toBe(1000)
    expect(snap.model).toBe('claude-sonnet-4-5')
    expect(snap.toolsHash).not.toBeNull()
    expect(snap.skillsHash).not.toBeNull()
    expect(snap.memoryBackend).toBe('finn-memories')
  })

  it('produces null fields when config fields are absent', () => {
    const snap = captureConfigSnapshot({ agentName: 'finn' })
    expect(snap.model).toBeNull()
    expect(snap.toolsHash).toBeNull()
    expect(snap.skillsHash).toBeNull()
    expect(snap.memoryBackend).toBeNull()
  })

  it('normalizes model to lowercase', () => {
    const snap = captureConfigSnapshot({ agentName: 'finn', model: 'Claude-Sonnet-4-5' })
    expect(snap.model).toBe('claude-sonnet-4-5')
  })

  it('tools hash is order-independent', () => {
    const a = captureConfigSnapshot({ agentName: 'x', toolsAllow: ['bash', 'computer'] })
    const b = captureConfigSnapshot({ agentName: 'x', toolsAllow: ['computer', 'bash'] })
    expect(a.toolsHash).toBe(b.toolsHash)
  })
})

// ── diffSnapshots ─────────────────────────────────────────────────────────────

function makeSnap(overrides: Partial<ConfigSnapshot> = {}): ConfigSnapshot {
  return {
    schema: 1,
    capturedAtMs: 1000,
    model: 'claude-sonnet-4-5',
    toolsHash: hashStringArray(['bash', 'computer']),
    skillsHash: hashStringArray(['search']),
    memoryBackend: 'finn',
    ...overrides,
  }
}

describe('diffSnapshots', () => {
  it('returns empty diff when previous is null (first boot)', () => {
    const current = makeSnap()
    expect(diffSnapshots(current, null)).toEqual([])
  })

  it('returns empty diff when nothing changed', () => {
    const snap = makeSnap()
    expect(diffSnapshots(snap, snap)).toEqual([])
  })

  it('detects model change only', () => {
    const prev = makeSnap({ model: 'claude-opus-4' })
    const curr = makeSnap({ model: 'claude-sonnet-4-5' })
    const diff = diffSnapshots(curr, prev)
    expect(diff).toHaveLength(1)
    expect(diff[0].field).toBe('model')
    expect(diff[0].from).toBe('claude-opus-4')
    expect(diff[0].to).toBe('claude-sonnet-4-5')
  })

  it('detects tools allowlist change only', () => {
    const prevHash = hashStringArray(['bash'])
    const currHash = hashStringArray(['bash', 'computer'])
    const prev = makeSnap({ toolsHash: prevHash })
    const curr = makeSnap({ toolsHash: currHash })
    const diff = diffSnapshots(curr, prev)
    expect(diff).toHaveLength(1)
    expect(diff[0].field).toBe('tools')
  })

  it('detects skills change only', () => {
    const prev = makeSnap({ skillsHash: hashStringArray(['search']) })
    const curr = makeSnap({ skillsHash: hashStringArray(['search', 'code']) })
    const diff = diffSnapshots(curr, prev)
    expect(diff).toHaveLength(1)
    expect(diff[0].field).toBe('skills')
  })

  it('detects memory backend change only', () => {
    const prev = makeSnap({ memoryBackend: 'finn' })
    const curr = makeSnap({ memoryBackend: 'finn-v2' })
    const diff = diffSnapshots(curr, prev)
    expect(diff).toHaveLength(1)
    expect(diff[0].field).toBe('memoryBackend')
    expect(diff[0].from).toBe('finn')
    expect(diff[0].to).toBe('finn-v2')
  })

  it('detects all four fields changing at once', () => {
    const prev = makeSnap({
      model: 'claude-opus-4',
      toolsHash: hashStringArray(['bash']),
      skillsHash: hashStringArray(['search']),
      memoryBackend: 'old-bank',
    })
    const curr = makeSnap({
      model: 'claude-sonnet-4-5',
      toolsHash: hashStringArray(['bash', 'computer']),
      skillsHash: hashStringArray(['search', 'code']),
      memoryBackend: 'new-bank',
    })
    const diff = diffSnapshots(curr, prev)
    expect(diff).toHaveLength(4)
    const fields = diff.map(d => d.field)
    expect(fields).toContain('model')
    expect(fields).toContain('tools')
    expect(fields).toContain('skills')
    expect(fields).toContain('memoryBackend')
  })

  it('does not fire when both sides have null for the same field', () => {
    const prev = makeSnap({ model: null })
    const curr = makeSnap({ model: null })
    const diff = diffSnapshots(curr, prev)
    const modelDiff = diff.find(d => d.field === 'model')
    expect(modelDiff).toBeUndefined()
  })

  it('fires when model transitions from null to a value (first explicit model set)', () => {
    const prev = makeSnap({ model: null })
    const curr = makeSnap({ model: 'claude-sonnet-4-5' })
    const diff = diffSnapshots(curr, prev)
    const modelDiff = diff.find(d => d.field === 'model')
    expect(modelDiff).toBeDefined()
    expect(modelDiff!.from).toBeNull()
    expect(modelDiff!.to).toBe('claude-sonnet-4-5')
  })
})

// ── renderConfigChangeDim ─────────────────────────────────────────────────────

describe('renderConfigChangeDim', () => {
  it('model: shows verbatim from → to', () => {
    const row = renderConfigChangeDim({
      field: 'model',
      from: 'claude-opus-4',
      to: 'claude-sonnet-4-5',
    })
    expect(row).toContain('claude-opus-4')
    expect(row).toContain('claude-sonnet-4-5')
    expect(row).toContain('→')
    expect(row).toContain('model:')
  })

  it('model: shows "(default)" when from or to is null', () => {
    const row = renderConfigChangeDim({ field: 'model', from: null, to: 'claude-sonnet-4-5' })
    expect(row).toContain('(default)')
    expect(row).toContain('claude-sonnet-4-5')
  })

  it('memoryBackend: shows verbatim from → to', () => {
    const row = renderConfigChangeDim({
      field: 'memoryBackend',
      from: 'finn',
      to: 'finn-v2',
    })
    expect(row).toContain('finn')
    expect(row).toContain('finn-v2')
    expect(row).toContain('memory backend:')
  })

  it('tools: coarse message with /status hint', () => {
    const row = renderConfigChangeDim({
      field: 'tools',
      from: 'abc123',
      to: 'def456',
    })
    expect(row).toContain('tools allowlist changed')
    expect(row).toContain('/status')
    // Should NOT contain raw hashes in the user-facing text.
    expect(row).not.toContain('abc123')
    expect(row).not.toContain('def456')
  })

  it('skills: coarse message with /status hint', () => {
    const row = renderConfigChangeDim({
      field: 'skills',
      from: 'abc123',
      to: 'def456',
    })
    expect(row).toContain('skills changed')
    expect(row).toContain('/status')
  })

  it('all rows start with the ⚙️ Config prefix', () => {
    const fields: Array<ConfigDiff[number]['field']> = ['model', 'tools', 'skills', 'memoryBackend']
    for (const field of fields) {
      const row = renderConfigChangeDim({ field, from: 'a', to: 'b' })
      expect(row).toContain('⚙️')
      expect(row).toContain('**Config**')
    }
  })
})

// ── loadSnapshot / persistSnapshot ───────────────────────────────────────────

describe('loadSnapshot / persistSnapshot — persistence', () => {
  it('returns null when file does not exist (first boot)', () => {
    const path = join(tmp, 'snap.json')
    expect(loadSnapshot(path)).toBeNull()
  })

  it('round-trips: persist then load yields the same snapshot', () => {
    const path = join(tmp, 'snap.json')
    const snap = makeSnap({ capturedAtMs: 9999 })
    persistSnapshot(path, snap)
    expect(existsSync(path)).toBe(true)
    const loaded = loadSnapshot(path)
    expect(loaded).not.toBeNull()
    expect(loaded!.model).toBe(snap.model)
    expect(loaded!.toolsHash).toBe(snap.toolsHash)
    expect(loaded!.skillsHash).toBe(snap.skillsHash)
    expect(loaded!.memoryBackend).toBe(snap.memoryBackend)
    expect(loaded!.capturedAtMs).toBe(9999)
  })

  it('corrupt JSON file is renamed aside and null is returned', () => {
    const path = join(tmp, 'snap.json')
    writeFileSync(path, 'not-valid-json-{{{')
    const loaded = loadSnapshot(path, () => 55555)
    expect(loaded).toBeNull()
    // Corrupt file preserved with timestamp suffix.
    expect(existsSync(`${path}.corrupt-55555`)).toBe(true)
  })

  it('schema mismatch returns null', () => {
    const path = join(tmp, 'snap.json')
    writeFileSync(path, JSON.stringify({ schema: 99, capturedAtMs: 1, model: null, toolsHash: null, skillsHash: null, memoryBackend: null }))
    expect(loadSnapshot(path)).toBeNull()
  })

  it('persists and overwrites on subsequent calls (baseline update)', () => {
    const path = join(tmp, 'snap.json')
    const first = makeSnap({ model: 'claude-opus-4' })
    const second = makeSnap({ model: 'claude-sonnet-4-5' })
    persistSnapshot(path, first)
    persistSnapshot(path, second)
    const loaded = loadSnapshot(path)
    expect(loaded!.model).toBe('claude-sonnet-4-5')
  })
})

// ── Integration: full boot-to-boot lifecycle ──────────────────────────────────

describe('boot-to-boot lifecycle', () => {
  it('first boot: no diff; subsequent boot with same config: no diff', () => {
    const path = join(tmp, 'snap.json')
    const snap1 = captureConfigSnapshot({
      agentName: 'finn',
      model: 'claude-sonnet-4-5',
      toolsAllow: ['bash'],
      skills: ['search'],
      memoryCollection: 'finn',
      now: () => 1000,
    })

    // First boot: no prior snapshot → no diff.
    const prev1 = loadSnapshot(path)
    const diff1 = diffSnapshots(snap1, prev1)
    expect(diff1).toEqual([])
    persistSnapshot(path, snap1)

    // Second boot with SAME config → no diff.
    const snap2 = captureConfigSnapshot({
      agentName: 'finn',
      model: 'claude-sonnet-4-5',
      toolsAllow: ['bash'],
      skills: ['search'],
      memoryCollection: 'finn',
      now: () => 2000,
    })
    const prev2 = loadSnapshot(path)
    const diff2 = diffSnapshots(snap2, prev2)
    expect(diff2).toEqual([])
    persistSnapshot(path, snap2)
  })

  it('third boot after model change: diff fires once, then silent again', () => {
    const path = join(tmp, 'snap.json')

    // Boot 1: snapshot with old model.
    const snap1 = captureConfigSnapshot({
      agentName: 'finn',
      model: 'claude-opus-4',
      now: () => 1000,
    })
    persistSnapshot(path, snap1)

    // Boot 2: model changed.
    const snap2 = captureConfigSnapshot({
      agentName: 'finn',
      model: 'claude-sonnet-4-5',
      now: () => 2000,
    })
    const prev2 = loadSnapshot(path)
    const diff2 = diffSnapshots(snap2, prev2)
    expect(diff2).toHaveLength(1)
    expect(diff2[0].field).toBe('model')
    persistSnapshot(path, snap2)

    // Boot 3: same model as boot 2 → no diff.
    const snap3 = captureConfigSnapshot({
      agentName: 'finn',
      model: 'claude-sonnet-4-5',
      now: () => 3000,
    })
    const prev3 = loadSnapshot(path)
    const diff3 = diffSnapshots(snap3, prev3)
    expect(diff3).toEqual([])
  })
})
