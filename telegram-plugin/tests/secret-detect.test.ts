import { describe, it, expect } from 'vitest'
import { detectSecrets, maskToken, redactUrls, deriveSlug } from '../secret-detect/index.js'
import { shannonEntropy } from '../secret-detect/entropy.js'
import { scanKeyValue, KV_ENTROPY_THRESHOLD } from '../secret-detect/kv-scanner.js'
import { chunk, CHUNK_THRESHOLD } from '../secret-detect/chunker.js'
import { isSuppressed } from '../secret-detect/suppressor.js'
import { sanitizeKeyName } from '../secret-detect/slug.js'
import { rewritePrompt } from '../secret-detect/rewrite.js'

describe('mask.maskToken', () => {
  it('reveals first 6 + last 4 when length ≥ 18', () => {
    const tok = 'sk-ant-abc123XYZdefGHI456789'
    expect(maskToken(tok)).toBe(`${tok.slice(0, 6)}...${tok.slice(-4)}`)
  })
  it('returns *** for short inputs', () => {
    expect(maskToken('short')).toBe('***')
    expect(maskToken('a'.repeat(17))).toBe('***')
  })
  it('boundary at length 18 reveals prefix/suffix', () => {
    const s = 'abcdefghijklmnopqr' // 18 chars
    expect(maskToken(s)).toBe('abcdef...opqr')
  })
})

describe('entropy.shannonEntropy', () => {
  it('returns 0 for empty', () => {
    expect(shannonEntropy('')).toBe(0)
  })
  it('returns 0 for a single repeated char', () => {
    expect(shannonEntropy('aaaaaaaa')).toBe(0)
  })
  it('returns log2(n) for n uniformly distributed chars', () => {
    const s = 'abcdefgh'
    expect(shannonEntropy(s)).toBeCloseTo(Math.log2(8), 6)
  })
  it('random-looking strings clear the 4.0 threshold', () => {
    expect(shannonEntropy('B4k9NzQ1mT5vR8wP2xY7jH3fL6cD0sA')).toBeGreaterThan(4.0)
  })
})

describe('kv-scanner.scanKeyValue', () => {
  it('flags mixed-case key=value with high entropy', () => {
    const text = 'my_password=B4k9NzQ1mT5vR8wP2xY7jH3fL6cD0sA'
    const hits = scanKeyValue(text)
    expect(hits).toHaveLength(1)
    expect(hits[0]!.confidence).toBe('ambiguous')
    expect(hits[0]!.key_name).toBe('my_password')
    expect(hits[0]!.matched_text).toBe('B4k9NzQ1mT5vR8wP2xY7jH3fL6cD0sA')
  })
  it('skips low-entropy placeholders', () => {
    expect(scanKeyValue('password=changeme')).toHaveLength(0)
    expect(scanKeyValue('token=aaaaaaaaaaaaaaaa')).toHaveLength(0)
  })
  it('threshold constant is 4.0 as specified', () => {
    expect(KV_ENTROPY_THRESHOLD).toBe(4.0)
  })
})

describe('url-redact.redactUrls', () => {
  it('strips user:pass@ and masks sensitive query params', () => {
    const out = redactUrls('check https://user:pass@api.example.com/x?api_key=abc123&trace=42 please')
    expect(out).toContain('***@api.example.com')
    expect(out).toContain('api_key=***')
    expect(out).toContain('trace=42')
  })
  it('leaves urls without credentials alone', () => {
    const u = 'https://api.example.com/x?trace=42'
    expect(redactUrls(u)).toBe(u)
  })
  it('handles invalid urls gracefully', () => {
    const broken = 'https://this is not a url'
    expect(redactUrls(broken)).toBe(broken)
  })
})

describe('chunker.chunk', () => {
  it('returns a single window for short input', () => {
    const windows = chunk('hello world')
    expect(windows).toHaveLength(1)
    expect(windows[0]!.offset).toBe(0)
  })
  it('splits large input into overlapping windows', () => {
    const big = 'x'.repeat(CHUNK_THRESHOLD + 1000)
    const windows = chunk(big)
    expect(windows.length).toBeGreaterThan(1)
    // First window at offset 0.
    expect(windows[0]!.offset).toBe(0)
    // Each subsequent window overlaps the previous.
    for (let i = 1; i < windows.length; i++) {
      const prev = windows[i - 1]!
      const curr = windows[i]!
      expect(curr.offset).toBeLessThan(prev.offset + prev.text.length)
    }
  })
})

describe('suppressor.isSuppressed', () => {
  it('demotes hits near test/mock/example/fixture/dummy', () => {
    const text = 'test: sk-ant-abc123defgh456789'
    const start = text.indexOf('sk-ant-')
    const end = text.length
    expect(isSuppressed(text, start, end)).toBe(true)
  })
  it('ignores markers more than 40 chars away', () => {
    // 80 chars of filler between "test" and the secret
    const filler = ' '.repeat(80)
    const text = `test${filler}sk-ant-abc123defgh456789`
    const start = text.indexOf('sk-ant-')
    const end = text.length
    expect(isSuppressed(text, start, end)).toBe(false)
  })
  it('whole-word only — "tested" does not trigger', () => {
    const text = 'untested sk-ant-abc123defgh456789'
    const start = text.indexOf('sk-ant-')
    const end = text.length
    expect(isSuppressed(text, start, end)).toBe(false)
  })
})

describe('slug.sanitizeKeyName + deriveSlug', () => {
  it('uppercases and strips illegal chars', () => {
    expect(sanitizeKeyName('my-api.key')).toBe('MY_API_KEY')
  })
  it('fallback to rule_id + date when no key_name', () => {
    const now = new Date(Date.UTC(2026, 3, 23))
    const slug = deriveSlug({ rule_id: 'anthropic_api_key', now }, new Set())
    expect(slug).toBe('anthropic_api_key_20260423')
  })
  it('appends _2 on collision', () => {
    const existing = new Set(['OPENAI_KEY'])
    expect(deriveSlug({ key_name: 'OPENAI_KEY', rule_id: 'env' }, existing)).toBe('OPENAI_KEY_2')
  })
  it('walks past existing _2 to _3 etc.', () => {
    const existing = new Set(['FOO', 'FOO_2', 'FOO_3'])
    expect(deriveSlug({ key_name: 'FOO', rule_id: 'env' }, existing)).toBe('FOO_4')
  })
})

describe('rewrite.rewritePrompt', () => {
  it('replaces each detection range with the vault marker', () => {
    // Needs a high-entropy value; the structured env_key_value pattern
    // doesn't gate on entropy but the all-caps LHS requirement is met by
    // TOKEN, and the value clears the entropy gate as a nice-to-have.
    const text = 'TOKEN=B4k9NzQ1mT5vR8wP2xY end'
    const detections = detectSecrets(text)
    expect(detections.length).toBeGreaterThan(0)
    const targets = detections.map((d) => ({ detection: d, actual_slug: 'TOKEN' }))
    const out = rewritePrompt(text, targets)
    expect(out).not.toContain('B4k9NzQ1mT5vR8wP2xY')
    expect(out).toContain('[secret stored as vault:TOKEN]')
  })
  it('preserves non-secret substrings verbatim', () => {
    const text = 'please stash api key ANTHROPIC_API_KEY=sk-ant-ABCDEFGHIJKLMNOP now'
    const detections = detectSecrets(text)
    expect(detections.length).toBeGreaterThan(0)
    const targets = detections.map((d) => ({ detection: d, actual_slug: 'ANTHROPIC_API_KEY' }))
    const out = rewritePrompt(text, targets)
    expect(out).toContain('please stash api key ANTHROPIC_API_KEY=[secret stored as vault:ANTHROPIC_API_KEY]')
  })
})

describe('detectSecrets — end-to-end', () => {
  it('finds an anthropic key', () => {
    const text = 'here you go: sk-ant-Apq13yqRnPzx4MxK0TfAbY98Qw22'
    const d = detectSecrets(text)
    expect(d).toHaveLength(1)
    expect(d[0]!.rule_id).toBe('anthropic_api_key')
    expect(d[0]!.confidence).toBe('high')
    expect(d[0]!.suppressed).toBe(false)
  })
  it('finds a GitHub PAT', () => {
    const text = 'token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 expires tomorrow'
    const d = detectSecrets(text)
    expect(d.some((h) => h.rule_id === 'github_pat_classic')).toBe(true)
  })
  it('captures only the value for KEY=VALUE patterns', () => {
    const text = 'ANTHROPIC_API_KEY=sk-ant-Apq13yqRnPzx4MxK0TfAbY98Qw22'
    const d = detectSecrets(text)
    const envHit = d.find((h) => h.rule_id === 'env_key_value' || h.rule_id === 'anthropic_api_key')
    expect(envHit).toBeDefined()
    // The detection covers the value only — never the `ANTHROPIC_API_KEY=` prefix
    expect(envHit!.matched_text.startsWith('sk-ant-')).toBe(true)
  })
  it('flags suppressed on nearby "test"', () => {
    const text = 'test token: sk-ant-Apq13yqRnPzx4MxK0TfAbY98Qw22'
    const d = detectSecrets(text)
    expect(d.length).toBeGreaterThan(0)
    expect(d[0]!.suppressed).toBe(true)
  })
  it('handles Authorization: Bearer', () => {
    const text = 'Authorization: Bearer eyJABCDEFGHIJKL.eyJABCDEFGHIJKL.SIGSIGSIGSIG'
    const d = detectSecrets(text)
    expect(d.length).toBeGreaterThan(0)
    expect(d.some((h) => h.rule_id === 'bearer_auth_header' || h.rule_id === 'jwt')).toBe(true)
  })
  it('handles PEM private keys as a single hit', () => {
    const pem = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA1234567890abcdefghijklmnopqrstuvwxyz
-----END RSA PRIVATE KEY-----`
    const text = `here: ${pem}`
    const d = detectSecrets(text)
    expect(d.some((h) => h.rule_id === 'pem_private_key')).toBe(true)
  })
  it('flags telegram bot tokens', () => {
    const text = 'bot123456789:ABCdefGHIjklMNOpqrsTUVwxyz012345'
    const d = detectSecrets(text)
    expect(d.some((h) => h.rule_id === 'telegram_bot_token_prefixed')).toBe(true)
  })
  it('returns empty for innocuous text', () => {
    expect(detectSecrets('hello, how are you today?')).toEqual([])
  })
  it('ReDoS input 100KB random text completes under 200ms', () => {
    // Seeded-ish pseudo-random — enough to defeat aggressive backtracking.
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-_=:'
    let s = ''
    for (let i = 0; i < 100_000; i++) s += chars[i * 2654435761 % chars.length]
    const t0 = performance.now()
    detectSecrets(s)
    const elapsed = performance.now() - t0
    expect(elapsed).toBeLessThan(200)
  })
})
