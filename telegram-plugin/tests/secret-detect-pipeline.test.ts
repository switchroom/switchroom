import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { runPipeline } from '../secret-detect/pipeline.js'
import { setAuditSink } from '../secret-detect/audit.js'
import type { VaultWriteFn, VaultListFn } from '../secret-detect/vault-write.js'

function mkFakeVault(): {
  write: VaultWriteFn
  list: VaultListFn
  store: Map<string, string>
} {
  const store = new Map<string, string>()
  const write: VaultWriteFn = (slug, value) => {
    store.set(slug, value)
    return { ok: true, output: 'ok' }
  }
  const list: VaultListFn = () => ({ ok: true, keys: [...store.keys()] })
  return { write, list, store }
}

describe('pipeline.runPipeline', () => {
  const captured: string[] = []
  beforeEach(() => {
    captured.length = 0
    setAuditSink((line) => captured.push(line))
  })
  afterEach(() => setAuditSink(null))

  it('stores a high-confidence hit and rewrites the prompt', () => {
    const { write, list, store } = mkFakeVault()
    const text = 'hey here is my key: sk-ant-Apq13yqRnPzx4MxK0TfAbY98Qw22 thanks'
    const res = runPipeline({
      chat_id: '-100',
      message_id: 5,
      text,
      passphrase: 'pw',
      vaultWrite: write,
      vaultList: list,
    })
    expect(res.stored).toHaveLength(1)
    expect(res.rewritten_text).toContain('[secret stored as vault:')
    expect(res.rewritten_text).not.toContain('sk-ant-Apq13yqRnPzx4MxK0TfAbY98Qw22')
    // The raw secret made it to the vault under the generated slug.
    expect([...store.values()]).toContain('sk-ant-Apq13yqRnPzx4MxK0TfAbY98Qw22')
    // Audit emitted once with action=stored.
    const storedLogs = captured.filter((l) => l.includes('"action":"stored"'))
    expect(storedLogs).toHaveLength(1)
    // Raw value never in logs.
    expect(captured.some((l) => l.includes('Apq13yqRnPzx4MxK0TfAbY98Qw22'))).toBe(false)
  })

  it('stages ambiguous hits without writing to the vault', () => {
    const { write, list, store } = mkFakeVault()
    const text = 'my_password=B4k9NzQ1mT5vR8wP2xY7jH3fL6cD0sA'
    const res = runPipeline({
      chat_id: '-100',
      message_id: 6,
      text,
      passphrase: 'pw',
      vaultWrite: write,
      vaultList: list,
    })
    expect(res.stored).toHaveLength(0)
    expect(res.ambiguous.length).toBeGreaterThan(0)
    // Nothing stored.
    expect(store.size).toBe(0)
    // Text unchanged.
    expect(res.rewritten_text).toBe(text)
    // Audit action=ambiguous.
    expect(captured.some((l) => l.includes('"action":"ambiguous"'))).toBe(true)
  })

  it('treats suppressed high-confidence hits as ambiguous', () => {
    const { write, list, store } = mkFakeVault()
    const text = 'test sk-ant-Apq13yqRnPzx4MxK0TfAbY98Qw22'
    const res = runPipeline({
      chat_id: 'c',
      message_id: 1,
      text,
      passphrase: 'pw',
      vaultWrite: write,
      vaultList: list,
    })
    expect(res.stored).toHaveLength(0)
    expect(res.ambiguous.length).toBeGreaterThan(0)
    expect(store.size).toBe(0)
  })

  it('avoids slug collisions when writing multiple hits', () => {
    const { write, list, store } = mkFakeVault()
    store.set('anthropic_api_key_20260423', 'preexisting')
    const text =
      'first: sk-ant-Apq13yqRnPzx4MxK0TfAbY98Qw22 second: sk-ant-BqZ13yqRnPzx4MxK0TfAbY98Qw22'
    const res = runPipeline({
      chat_id: 'c',
      message_id: 2,
      text,
      passphrase: 'pw',
      vaultWrite: write,
      vaultList: list,
    })
    expect(res.stored).toHaveLength(2)
    const slugs = res.stored.map((s) => s.actual_slug)
    // All unique and none collide with the preexisting key.
    expect(new Set(slugs).size).toBe(slugs.length)
    expect(slugs).not.toContain('anthropic_api_key_20260423')
  })

  it('reports failures without crashing', () => {
    const failingWrite: VaultWriteFn = () => ({ ok: false, output: 'vault busy' })
    const list: VaultListFn = () => ({ ok: true, keys: [] })
    const res = runPipeline({
      chat_id: 'c',
      message_id: 3,
      text: 'key is sk-ant-Apq13yqRnPzx4MxK0TfAbY98Qw22',
      passphrase: 'pw',
      vaultWrite: failingWrite,
      vaultList: list,
    })
    expect(res.stored).toHaveLength(0)
    expect(res.failed).toHaveLength(1)
    expect(captured.some((l) => l.includes('"action":"failed"'))).toBe(true)
  })
})
