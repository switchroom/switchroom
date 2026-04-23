import { describe, it, expect } from 'vitest'
import { StagingMap } from '../secret-detect/staging.js'
import type { Detection } from '../secret-detect/index.js'

function mkDetection(slug = 'FOO'): Detection {
  return {
    rule_id: 'kv_entropy',
    matched_text: 'abc',
    start: 0,
    end: 3,
    confidence: 'ambiguous',
    suppressed: false,
    suggested_slug: slug,
  }
}

describe('StagingMap', () => {
  it('round-trips a set/get', () => {
    const map = new StagingMap(5_000)
    map.set({ chat_id: 'c', message_id: 1, detection: mkDetection(), staged_at: Date.now() })
    const found = map.get('c', 1)
    expect(found).toBeDefined()
    expect(found!.detection.suggested_slug).toBe('FOO')
  })
  it('expires entries past the TTL', () => {
    const map = new StagingMap(10)
    map.set({ chat_id: 'c', message_id: 1, detection: mkDetection(), staged_at: Date.now() - 1_000 })
    expect(map.get('c', 1)).toBeUndefined()
  })
  it('latestForChat returns the newest non-expired entry', () => {
    const map = new StagingMap(60_000)
    const now = Date.now()
    map.set({ chat_id: 'c', message_id: 1, detection: mkDetection('A'), staged_at: now - 3000 })
    map.set({ chat_id: 'c', message_id: 2, detection: mkDetection('B'), staged_at: now - 2000 })
    map.set({ chat_id: 'c', message_id: 3, detection: mkDetection('C'), staged_at: now - 1000 })
    const latest = map.latestForChat('c')
    expect(latest?.detection.suggested_slug).toBe('C')
  })
  it('delete removes the entry', () => {
    const map = new StagingMap(5_000)
    map.set({ chat_id: 'c', message_id: 1, detection: mkDetection(), staged_at: Date.now() })
    expect(map.delete('c', 1)).toBe(true)
    expect(map.get('c', 1)).toBeUndefined()
  })
})
