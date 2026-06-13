import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  emitRuntimeMetric,
  __setRuntimeMetricsPathForTests,
  __getRuntimeMetricsPathForTests,
  __isJsonlEnabledForTests,
} from '../runtime-metrics.js'

let tmpDir: string
let metricsPath: string
const ORIGINAL_TELEMETRY = process.env.SWITCHROOM_TELEMETRY_DISABLED
const ORIGINAL_JSONL_DISABLED = process.env.SWITCHROOM_RUNTIME_METRICS_JSONL_DISABLED

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'runtime-metrics-test-'))
  metricsPath = join(tmpDir, 'runtime-metrics.jsonl')
  __setRuntimeMetricsPathForTests(metricsPath)
  // Disable PostHog for unit tests — we only want to exercise the JSONL sink.
  // Real PostHog wiring is covered indirectly by analytics-posthog itself.
  process.env.SWITCHROOM_TELEMETRY_DISABLED = '1'
  delete process.env.SWITCHROOM_RUNTIME_METRICS_JSONL_DISABLED
})

afterEach(() => {
  __setRuntimeMetricsPathForTests(null)
  rmSync(tmpDir, { recursive: true, force: true })
  if (ORIGINAL_TELEMETRY != null) process.env.SWITCHROOM_TELEMETRY_DISABLED = ORIGINAL_TELEMETRY
  else delete process.env.SWITCHROOM_TELEMETRY_DISABLED
  if (ORIGINAL_JSONL_DISABLED != null) process.env.SWITCHROOM_RUNTIME_METRICS_JSONL_DISABLED = ORIGINAL_JSONL_DISABLED
  else delete process.env.SWITCHROOM_RUNTIME_METRICS_JSONL_DISABLED
})

describe('runtime-metrics — JSONL sink', () => {
  it('writes one JSON line per event', () => {
    emitRuntimeMetric({
      kind: 'inbound_status_query',
      chat_id: '123',
      message_id: 42,
      thread_id: null,
      text_length: 7,
      prior_turn_in_flight: true,
      seconds_since_turn_start: 12,
    })
    emitRuntimeMetric({
      kind: 'turn_started',
      chat_id: '123',
      message_id: 43,
      thread_id: null,
      inbound_classified_as_status_query: false,
    })
    const raw = readFileSync(metricsPath, 'utf-8')
    const lines = raw.trim().split('\n')
    expect(lines).toHaveLength(2)
    const first = JSON.parse(lines[0]!)
    expect(first.kind).toBe('inbound_status_query')
    expect(first.chat_id).toBe('123')
    expect(first.message_id).toBe(42)
    expect(first.text_length).toBe(7)
    expect(typeof first.ts).toBe('number')
  })

  it('turn_ended carries TTFO + outbound gap fields', () => {
    emitRuntimeMetric({
      kind: 'turn_ended',
      chat_id: 'c1',
      thread_id: 7,
      duration_ms: 8400,
      ttfo_ms: 1200,
      outbound_count: 3,
      longest_silent_gap_ms: 5500,
      ended_via: 'reply',
    })
    const raw = readFileSync(metricsPath, 'utf-8')
    const parsed = JSON.parse(raw.trim())
    expect(parsed.kind).toBe('turn_ended')
    expect(parsed.ttfo_ms).toBe(1200)
    expect(parsed.outbound_count).toBe(3)
    expect(parsed.longest_silent_gap_ms).toBe(5500)
    expect(parsed.ended_via).toBe('reply')
  })

  it('cron_fell_back_to_main carries agent + prompt_key (#2307 Tier-1)', () => {
    emitRuntimeMetric({ kind: 'cron_fell_back_to_main', agent: 'clerk', prompt_key: 'abc123' })
    const parsed = JSON.parse(readFileSync(metricsPath, 'utf-8').trim())
    expect(parsed.kind).toBe('cron_fell_back_to_main')
    expect(parsed.agent).toBe('clerk')
    expect(parsed.prompt_key).toBe('abc123')
    expect(typeof parsed.ts).toBe('number')
  })

  it('appends — does not overwrite — across calls', () => {
    for (let i = 0; i < 5; i++) {
      emitRuntimeMetric({
        kind: 'turn_started',
        chat_id: 'c1',
        message_id: i,
        thread_id: null,
        inbound_classified_as_status_query: false,
      })
    }
    const raw = readFileSync(metricsPath, 'utf-8')
    const lines = raw.trim().split('\n')
    expect(lines).toHaveLength(5)
  })

  it('creates the parent directory if missing', () => {
    const nested = join(tmpDir, 'a', 'b', 'c', 'runtime-metrics.jsonl')
    __setRuntimeMetricsPathForTests(nested)
    emitRuntimeMetric({
      kind: 'turn_started',
      chat_id: 'c1',
      message_id: 1,
      thread_id: null,
      inbound_classified_as_status_query: false,
    })
    expect(existsSync(nested)).toBe(true)
  })

  it('SWITCHROOM_RUNTIME_METRICS_JSONL_DISABLED=1 skips the JSONL write', () => {
    process.env.SWITCHROOM_RUNTIME_METRICS_JSONL_DISABLED = '1'
    expect(__isJsonlEnabledForTests()).toBe(false)
    emitRuntimeMetric({
      kind: 'turn_started',
      chat_id: 'c1',
      message_id: 1,
      thread_id: null,
      inbound_classified_as_status_query: false,
    })
    expect(existsSync(metricsPath)).toBe(false)
  })

  it('resolves SWITCHROOM_RUNTIME_METRICS_PATH override', () => {
    const overridePath = join(tmpDir, 'override.jsonl')
    __setRuntimeMetricsPathForTests(overridePath)
    expect(__getRuntimeMetricsPathForTests()).toBe(overridePath)
  })

  it('emit never throws even if all sinks are disabled', () => {
    process.env.SWITCHROOM_RUNTIME_METRICS_JSONL_DISABLED = '1'
    process.env.SWITCHROOM_TELEMETRY_DISABLED = '1'
    expect(() => {
      emitRuntimeMetric({
        kind: 'turn_started',
        chat_id: 'c1',
        message_id: 1,
        thread_id: null,
        inbound_classified_as_status_query: false,
      })
    }).not.toThrow()
  })
})
