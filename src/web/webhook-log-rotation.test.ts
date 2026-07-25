/**
 * #3596 — `<agent>/telegram/webhook-events.jsonl` had NO size check and
 * NO reaper. On the live host one agent's log reached 121,772,086 bytes
 * (vs 328 KB for the next-busiest) on shared, bind-mounted host disk.
 *
 * These tests assert outcomes an unbounded writer fails: the file stays
 * bounded across many events, retention caps total on-disk history, and
 * the documented consumer (`readWebhookLog`, schema.ts:1554 — "for the
 * agent to read on demand") still sees events written before a rotation.
 *
 * All I/O is pinned to an isolated tmpdir — never `~/.switchroom`.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, readdirSync, statSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  recordWebhookEvent,
  type WebhookGatewayRecord,
  type RecordDeps,
} from './webhook-gateway-record.js'
import { readWebhookLog, type DedupStore } from './webhook-handler.js'

const NOW = 1_700_000_000_000
const roots: string[] = []

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
  delete process.env.SWITCHROOM_WEBHOOK_LOG_MAX_BYTES
  delete process.env.SWITCHROOM_WEBHOOK_LOG_MAX_FILES
})

function makeTmpResolveAgentDir(): {
  resolveAgentDir: (a: string) => string
  root: string
} {
  const root = mkdtempSync(join(tmpdir(), 'webhook-rot-'))
  roots.push(root)
  return { root, resolveAgentDir: (agent: string) => join(root, agent) }
}

/** Never dedups — every record is a fresh delivery. */
function noDedup(): DedupStore {
  return { check: () => undefined }
}

function record(i: number): WebhookGatewayRecord {
  return {
    agent: 'reggie',
    source: 'github',
    event_type: 'push',
    ts: NOW + i,
    rendered_text: `event ${i}`,
    payload: { seq: i, filler: 'p'.repeat(1000) },
    delivery_id: `d-${i}`,
  }
}

function deps(resolveAgentDir: (a: string) => string): RecordDeps {
  return {
    resolveAgentDir,
    dedupStore: noDedup(),
    log: () => {},
    loadConfig: () => ({}) as unknown as ReturnType<NonNullable<RecordDeps['loadConfig']>>,
  }
}

function logDir(root: string): string {
  return join(root, 'reggie', 'telegram')
}

function totalLogBytes(root: string): number {
  const d = logDir(root)
  return readdirSync(d)
    .filter((f) => f.startsWith('webhook-events.jsonl'))
    .reduce((n, f) => n + statSync(join(d, f)).size, 0)
}

describe('webhook-events.jsonl rotation (#3596)', () => {
  it('bounds the log across many events instead of growing unbounded', () => {
    process.env.SWITCHROOM_WEBHOOK_LOG_MAX_BYTES = String(16 * 1024)
    process.env.SWITCHROOM_WEBHOOK_LOG_MAX_FILES = '2'
    const { resolveAgentDir, root } = makeTmpResolveAgentDir()
    const d = deps(resolveAgentDir)
    // 200 events × ~1 KB ≈ 200 KB unbounded.
    for (let i = 0; i < 200; i++) {
      expect(recordWebhookEvent(record(i), d).status).toBe('ok')
    }
    const active = statSync(join(logDir(root), 'webhook-events.jsonl')).size
    expect(active).toBeLessThan(16 * 1024 + 4 * 1024)
    expect(totalLogBytes(root)).toBeLessThan(3 * (16 * 1024 + 4 * 1024))
    expect(totalLogBytes(root)).toBeLessThan(180 * 1024) // ≪ unbounded
  })

  it('enforces retention — no generation beyond maxFiles survives', () => {
    process.env.SWITCHROOM_WEBHOOK_LOG_MAX_BYTES = String(8 * 1024)
    process.env.SWITCHROOM_WEBHOOK_LOG_MAX_FILES = '2'
    const { resolveAgentDir, root } = makeTmpResolveAgentDir()
    const d = deps(resolveAgentDir)
    for (let i = 0; i < 200; i++) recordWebhookEvent(record(i), d)
    const base = join(logDir(root), 'webhook-events.jsonl')
    expect(existsSync(`${base}.1`)).toBe(true)
    expect(existsSync(`${base}.2`)).toBe(true)
    expect(existsSync(`${base}.3`)).toBe(false)
  })

  it('the documented consumer still reads pre-rotation events, in order', () => {
    process.env.SWITCHROOM_WEBHOOK_LOG_MAX_BYTES = String(16 * 1024)
    process.env.SWITCHROOM_WEBHOOK_LOG_MAX_FILES = '2'
    const { resolveAgentDir, root } = makeTmpResolveAgentDir()
    const d = deps(resolveAgentDir)
    for (let i = 0; i < 40; i++) recordWebhookEvent(record(i), d)
    const base = join(logDir(root), 'webhook-events.jsonl')
    expect(existsSync(`${base}.1`)).toBe(true) // a seam exists

    const events = readWebhookLog('reggie', resolveAgentDir)
    const seqs = events.map((e) => (e.payload as { seq: number }).seq)
    // Events from before the rotation are still visible…
    expect(seqs).toContain(0)
    expect(seqs).toContain(39)
    // …and chronological order survives the seam.
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
  })

  it('a negative cap disables rotation (operator escape hatch)', () => {
    process.env.SWITCHROOM_WEBHOOK_LOG_MAX_BYTES = '-1'
    const { resolveAgentDir, root } = makeTmpResolveAgentDir()
    const d = deps(resolveAgentDir)
    for (let i = 0; i < 40; i++) recordWebhookEvent(record(i), d)
    const base = join(logDir(root), 'webhook-events.jsonl')
    expect(existsSync(`${base}.1`)).toBe(false)
    expect(statSync(base).size).toBeGreaterThan(30 * 1000)
  })
})
