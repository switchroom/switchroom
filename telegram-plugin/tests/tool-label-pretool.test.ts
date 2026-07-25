/**
 * Unit tests for the computeLabel function in hooks/tool-label-pretool.mjs.
 *
 * These tests verify:
 *   1. computeLabel returns non-null for unknown built-in tools (never-null fallthrough)
 *   2. computeLabel returns non-null for unknown MCP tools (humanized name fallback)
 *   3. Surface-tool suppression works for non-switchroom-telegram telegram-suffixed keys
 *      (e.g. clerk-telegram, custom fork) — not just the hardcoded "switchroom-telegram"
 */

import { describe, it, expect } from 'vitest'
// The hook exports computeLabel for unit testing (see "Skip main() when imported" guard).
import { computeLabel } from '../hooks/tool-label-pretool.mjs'

describe('computeLabel — never-null built-in fallthrough', () => {
  it('returns non-null for an unrecognized built-in tool', () => {
    // A future Claude built-in tool that the hook doesn't know about yet.
    // The never-null fallthrough must prevent a dark-turn (no feed, no label).
    expect(computeLabel('SomeFutureBuiltin', {})).not.toBeNull()
    // Must be a non-empty string too.
    expect(computeLabel('SomeFutureBuiltin', {})).toBeTruthy()
  })

  it('returns non-null for an unknown MCP tool (operator-configured server)', () => {
    // An operator-installed MCP server the hook has no explicit label for.
    // Falls through to the humanized-name fallback: "Using dothing".
    expect(computeLabel('mcp__brandnew__dothing', {})).not.toBeNull()
    expect(computeLabel('mcp__brandnew__dothing', {})).toBeTruthy()
  })

  it('humanizes the tool name for an unknown MCP tool with no description', () => {
    expect(computeLabel('mcp__brandnew__dothing', {})).toBe('Using dothing')
    expect(computeLabel('mcp__acme_corp__send_message', {})).toBe('Using send message')
  })

  it('uses the model-authored description for an unknown MCP tool when present', () => {
    expect(
      computeLabel('mcp__brandnew__dothing', { description: 'Fetched the quarterly report' }),
    ).toBe('Fetched the quarterly report')
  })
})

describe('computeLabel — surface-tool suppression is key-agnostic', () => {
  it('returns null for telegram reply under any registration key', () => {
    // Standard switchroom-telegram key.
    expect(computeLabel('mcp__switchroom-telegram__reply', {})).toBeNull()

    // Legacy clerk-telegram key — same plugin, different registration name.
    expect(computeLabel('mcp__clerk-telegram__reply', {})).toBeNull()

    // Hypothetical custom fork.
    expect(computeLabel('mcp__my-custom-telegram__reply', {})).toBeNull()
  })

  it('returns null for telegram react under any registration key', () => {
    expect(computeLabel('mcp__switchroom-telegram__react', {})).toBeNull()
    expect(computeLabel('mcp__clerk-telegram__react', {})).toBeNull()
  })

  it('returns null for telegram send_typing under any registration key', () => {
    expect(computeLabel('mcp__switchroom-telegram__send_typing', {})).toBeNull()
    expect(computeLabel('mcp__clerk-telegram__send_typing', {})).toBeNull()
  })

  it('returns a label (not null) for telegram get_recent_messages', () => {
    // get_recent_messages is a read/query tool, not a surface tool — it should be labeled.
    expect(computeLabel('mcp__switchroom-telegram__get_recent_messages', {})).toBe('Reading chat history')
    expect(computeLabel('mcp__clerk-telegram__get_recent_messages', {})).toBe('Reading chat history')
  })
})

// ─── Bash label without a model-authored description ─────────────────────
//
// `description` is OPTIONAL, so a sub-agent that never writes one used to
// produce the constant "Running a command" for every Bash call — the worker
// feed then deduped every repeat away and the card froze on one line for the
// whole job. The fallback derives a label from the command, but ONLY through
// an allowlist: program basename, plus one bare subcommand for known
// multiplexers. Command lines carry tokens, passwords, credential URLs and
// private paths, and this string is rendered into a Telegram message.
describe('computeLabel — Bash fallback when description is omitted', () => {
  it('prefers the model-authored description when present', () => {
    expect(computeLabel('Bash', { command: 'git push origin main', description: 'Push branch' }))
      .toBe('Push branch')
  })

  it('derives the program name when description is missing', () => {
    expect(computeLabel('Bash', { command: 'grep -r foo .' })).toBe('Running grep')
    expect(computeLabel('Bash', { command: 'ls -la /var/log' })).toBe('Running ls')
  })

  it('adds a bare subcommand for known multiplexers', () => {
    expect(computeLabel('Bash', { command: 'git status --short' })).toBe('Running git status')
    expect(computeLabel('Bash', { command: 'docker ps -a' })).toBe('Running docker ps')
    expect(computeLabel('Bash', { command: 'npm run lint' })).toBe('Running npm run')
  })

  it('produces DISTINCT labels for distinct commands (the frozen-card fix)', () => {
    const labels = [
      'git status', 'npm test', 'ls /tmp', 'grep -n x y', 'docker logs c',
    ].map((c) => computeLabel('Bash', { command: c }))
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('skips navigation prefixes and wrappers to the real program', () => {
    expect(computeLabel('Bash', { command: 'cd /srv/app && git pull' })).toBe('Running git pull')
    expect(computeLabel('Bash', { command: 'sudo systemctl restart nginx' }))
      .toBe('Running systemctl restart')
    expect(computeLabel('Bash', { command: 'FOO=bar deploy.sh' })).toBe('Running deploy.sh')
  })

  it('NEVER echoes arguments, flag values, URLs, or env assignments', () => {
    // Token-shaped literals are assembled at runtime: GitHub Push Protection
    // and check-no-pii-secrets both reject contiguous ones, fake or not
    // (pattern from secret-detect-secretlint.test.ts).
    const fakeAnthropic = 'sk-' + 'ant-oat01-FAKEVALUE'
    const cases = [
      'curl -H "Authorization: Bearer ' + 'sk-' + 'live-abcdef123456" https://api.example.com/v1/x',
      'psql postgres://user:hunter2@db.internal:5432/prod -c "select 1"',
      'aws s3 cp s3://private-bucket/key.pem . --profile prod',
      'export TOKEN=ghp_AAAABBBBCCCCDDDD && ./run',
      `echo "${fakeAnthropic}" > /root/.creds`,
      'ssh deploy@10.0.0.7 -i /root/.ssh/id_ed25519',
      'git clone https://x-access-token:ghs_SECRET@github.com/o/r.git',
    ]
    const forbidden = /sk-|ghp_|ghs_|hunter2|Bearer|SECRET|10\.0\.0\.7|@|:\/\/|=/
    for (const command of cases) {
      const label = computeLabel('Bash', { command })
      expect(label).not.toBeNull()
      expect(label).not.toMatch(forbidden)
      // Whatever it says, it must be short and made of the allowlisted shape.
      expect(label).toMatch(/^Running (a command|[A-Za-z][A-Za-z0-9._+-]{0,19}( [a-z][a-z-]{1,15})?)$/)
    }
  })

  it('never inspects a heredoc / multiline body', () => {
    const label = computeLabel('Bash', {
      command: 'cat <<EOF > /tmp/x\nAPI_KEY=sk-live-shouldnotleak\nEOF',
    })
    expect(label).toBe('Running cat')
  })

  it('falls back to the generic label when nothing safe can be derived', () => {
    expect(computeLabel('Bash', { command: '$(cat /run/secrets/token) --x' })).toBe('Running a command')
    expect(computeLabel('Bash', {})).toBe('Running a command')
    expect(computeLabel('Bash', { command: '   ' })).toBe('Running a command')
  })
})

describe('computeLabel — Bash subcommand is never a flag value', () => {
  it('only accepts the token IMMEDIATELY after a multiplexer', () => {
    // A flag value (a private context/host/profile name) must never surface.
    expect(computeLabel('Bash', { command: 'docker --context prod-internal ps' }))
      .toBe('Running docker')
    expect(computeLabel('Bash', { command: 'git -C /srv/private-app status' }))
      .toBe('Running git')
    expect(computeLabel('Bash', { command: 'aws --profile customer-acme s3 ls' }))
      .toBe('Running aws')
  })

  it('still reads the plain subcommand form', () => {
    expect(computeLabel('Bash', { command: 'git commit -m "wip"' })).toBe('Running git commit')
  })
})
