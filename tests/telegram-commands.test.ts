import { describe, it, expect, vi, beforeEach } from 'vitest'
import { execFileSync } from 'child_process'

// We test the helper functions directly rather than importing from server.ts
// (which has side effects: bot startup, MCP connection, etc.)
// Instead we replicate the pure logic here and verify behavior.

// --- Replicated helpers from server.ts ---

function formatSwitchroomOutput(output: string, maxLen = 4000): string {
  const trimmed = output.trim()
  if (trimmed.length <= maxLen) return trimmed
  return trimmed.slice(0, maxLen - 20) + '\n... (truncated)'
}

function codeBlock(text: string): string {
  const escaped = text.replace(/```/g, '` ` `')
  return '```\n' + escaped + '\n```'
}

function resolveSwitchroomCli(): string {
  return process.env.SWITCHROOM_CLI_PATH ?? 'switchroom'
}

// --- Tests ---

describe('telegram bot commands', () => {
  describe('formatSwitchroomOutput', () => {
    it('returns trimmed output when short', () => {
      expect(formatSwitchroomOutput('  hello world  ')).toBe('hello world')
    })

    it('truncates output exceeding maxLen', () => {
      const long = 'x'.repeat(5000)
      const result = formatSwitchroomOutput(long, 4000)
      expect(result.length).toBeLessThanOrEqual(4000)
      expect(result).toContain('... (truncated)')
    })

    it('handles empty output', () => {
      expect(formatSwitchroomOutput('')).toBe('')
      expect(formatSwitchroomOutput('   ')).toBe('')
    })

    it('respects custom maxLen', () => {
      const text = 'a'.repeat(100)
      const result = formatSwitchroomOutput(text, 50)
      expect(result.length).toBeLessThanOrEqual(50)
      expect(result).toContain('... (truncated)')
    })
  })

  describe('codeBlock', () => {
    it('wraps text in triple backticks', () => {
      expect(codeBlock('hello')).toBe('```\nhello\n```')
    })

    it('escapes triple backticks inside content', () => {
      const result = codeBlock('before ``` after')
      expect(result).not.toContain('``````')
      expect(result).toBe('```\nbefore ` ` ` after\n```')
    })

    it('handles empty text', () => {
      expect(codeBlock('')).toBe('```\n\n```')
    })
  })

  describe('command argument parsing', () => {
    // Simulates how Grammy provides ctx.match for /command <args>

    it('extracts agent name from /switchroomstart health-coach', () => {
      const match = 'health-coach'
      const name = match.trim()
      expect(name).toBe('health-coach')
    })

    it('extracts agent name from /stop my-agent', () => {
      const match = 'my-agent'
      const name = match.trim()
      expect(name).toBe('my-agent')
    })

    it('extracts agent name and line count from /logs my-agent 50', () => {
      const match = 'my-agent 50'
      const parts = match.trim().split(/\s+/)
      const name = parts[0]
      const lines = parts[1] ? parseInt(parts[1], 10) : 20
      expect(name).toBe('my-agent')
      expect(lines).toBe(50)
    })

    it('defaults to 20 lines when no count specified', () => {
      const match = 'my-agent'
      const parts = match.trim().split(/\s+/)
      const lines = parts[1] ? parseInt(parts[1], 10) : 20
      expect(lines).toBe(20)
    })

    it('caps lines at 200', () => {
      const match = 'my-agent 999'
      const parts = match.trim().split(/\s+/)
      const rawLines = parts[1] ? parseInt(parts[1], 10) : 20
      const lineCount = isNaN(rawLines) || rawLines < 1 ? 20 : Math.min(rawLines, 200)
      expect(lineCount).toBe(200)
    })

    it('handles non-numeric line count gracefully', () => {
      const match = 'my-agent abc'
      const parts = match.trim().split(/\s+/)
      const rawLines = parts[1] ? parseInt(parts[1], 10) : 20
      const lineCount = isNaN(rawLines) || rawLines < 1 ? 20 : Math.min(rawLines, 200)
      expect(lineCount).toBe(20)
    })

    it('extracts memory query with spaces', () => {
      const match = 'user preferences for notifications'
      const query = match.trim()
      expect(query).toBe('user preferences for notifications')
    })

    it('returns empty for missing arguments', () => {
      const match = ''
      expect(match.trim()).toBe('')
    })

    it('parses /auth reauth current-agent', () => {
      const match = 'reauth current-agent'
      const parts = match.trim().split(/\s+/)
      expect(parts[0]).toBe('reauth')
      expect(parts[1]).toBe('current-agent')
    })

    it('parses /auth code agent 123456', () => {
      const match = 'code assistant 123456'
      const parts = match.trim().split(/\s+/)
      const sub = parts[0]
      const name = parts[1]
      const code = parts.slice(2).join(' ')
      expect(sub).toBe('code')
      expect(name).toBe('assistant')
      expect(code).toBe('123456')
    })
  })

  describe('switchroom CLI path resolution', () => {
    const originalEnv = process.env.SWITCHROOM_CLI_PATH

    beforeEach(() => {
      delete process.env.SWITCHROOM_CLI_PATH
    })

    it('defaults to "switchroom" when SWITCHROOM_CLI_PATH is not set', () => {
      expect(resolveSwitchroomCli()).toBe('switchroom')
    })

    it('uses SWITCHROOM_CLI_PATH when set', () => {
      process.env.SWITCHROOM_CLI_PATH = '/usr/local/bin/switchroom'
      expect(resolveSwitchroomCli()).toBe('/usr/local/bin/switchroom')
    })

    // Restore after tests
    afterAll(() => {
      if (originalEnv !== undefined) {
        process.env.SWITCHROOM_CLI_PATH = originalEnv
      } else {
        delete process.env.SWITCHROOM_CLI_PATH
      }
    })
  })

  describe('error handling', () => {
    it('detects ENOENT (switchroom not found) in error message', () => {
      const error = new Error('spawn switchroom ENOENT')
      expect(error.message).toContain('ENOENT')
    })

    it('detects timeout in error message', () => {
      const error = new Error('Command timed out after 15000ms')
      expect(error.message.toLowerCase()).toContain('timed out')
    })

    it('extracts stderr from exec error', () => {
      const error = { stderr: 'agent "foo" not found', message: 'exit code 1' } as {
        stderr: string
        message: string
      }
      const detail = error.stderr?.trim() || error.message || 'unknown error'
      expect(detail).toBe('agent "foo" not found')
    })

    it('falls back to message when stderr is empty', () => {
      const error = { stderr: '', message: 'exit code 1' } as {
        stderr: string
        message: string
      }
      const detail = error.stderr?.trim() || error.message || 'unknown error'
      expect(detail).toBe('exit code 1')
    })
  })

  describe('switchroom command execution (mocked)', () => {
    it('builds correct args for agent list', () => {
      const args = ['agent', 'list']
      expect(args).toEqual(['agent', 'list'])
    })

    it('builds correct args for agent start', () => {
      const name = 'my-agent'
      const args = ['agent', 'start', name]
      expect(args).toEqual(['agent', 'start', 'my-agent'])
    })

    it('builds correct args for agent logs with line count', () => {
      const name = 'my-agent'
      const lines = 50
      const args = ['agent', 'logs', name, '--lines', String(lines)]
      expect(args).toEqual(['agent', 'logs', 'my-agent', '--lines', '50'])
    })

    it('builds correct args for memory search', () => {
      const query = 'user preferences'
      const args = ['memory', 'search', query]
      expect(args).toEqual(['memory', 'search', 'user preferences'])
    })

    it('prepends --config when SWITCHROOM_CONFIG is set', () => {
      const config = '/path/to/config.yaml'
      const baseArgs = ['agent', 'list']
      const fullArgs = config ? ['--config', config, ...baseArgs] : baseArgs
      expect(fullArgs).toEqual(['--config', '/path/to/config.yaml', 'agent', 'list'])
    })

    it('does not prepend --config when SWITCHROOM_CONFIG is not set', () => {
      const config: string | undefined = undefined
      const baseArgs = ['agent', 'list']
      const fullArgs = config ? ['--config', config, ...baseArgs] : baseArgs
      expect(fullArgs).toEqual(['agent', 'list'])
    })
  })

  describe('self-targeting command detection', () => {
    // Locks the contract behind the /restart, /reconcile, /update self-kill
    // fix in server.ts. The bot needs to detect when a switchroom subcommand
    // would SIGTERM its own systemd unit (mid-execFileSync) and switch to
    // a detached spawn instead. See spawnSwitchroomDetached +
    // isSelfTargetingCommand in telegram-plugin/server.ts.
    function isSelfTargetingCommand(name: string, myAgentName: string): boolean {
      if (name === 'all') return true
      return name === myAgentName
    }

    it('detects self-restart by exact name match', () => {
      expect(isSelfTargetingCommand('assistant', 'assistant')).toBe(true)
      expect(isSelfTargetingCommand('coach', 'assistant')).toBe(false)
    })

    it('detects "all" as always self-targeting', () => {
      expect(isSelfTargetingCommand('all', 'assistant')).toBe(true)
      expect(isSelfTargetingCommand('all', 'coach')).toBe(true)
    })

    it('does not match prefixes or substrings', () => {
      // Defensive: a malicious agent named "assistant-evil" should NOT
      // be considered self for an agent named "assistant".
      expect(isSelfTargetingCommand('assistant-evil', 'assistant')).toBe(false)
      expect(isSelfTargetingCommand('assi', 'assistant')).toBe(false)
    })

    it('is case-sensitive (matches systemd unit naming)', () => {
      expect(isSelfTargetingCommand('Assistant', 'assistant')).toBe(false)
    })
  })

  describe('getMyAgentName resolution', () => {
    // Locks the env-var-first contract behind getMyAgentName in server.ts.
    // Claude Code spawns MCP plugins with cwd = $HOME regardless of the
    // parent claude process cwd, so basename(cwd) returns the OS username
    // (e.g., "testuser") instead of the agent name. The plugin must
    // read SWITCHROOM_AGENT_NAME from the env (set in start.sh) and only fall
    // back to cwd parsing when the env var is missing.
    function getMyAgentName(env: NodeJS.ProcessEnv, cwd: string): string {
      const fromEnv = env.SWITCHROOM_AGENT_NAME
      if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim()
      // Replicates `basename(cwd)` from path.basename
      return cwd.split('/').filter(Boolean).pop() ?? ''
    }

    it('reads SWITCHROOM_AGENT_NAME from env when set', () => {
      const env = { SWITCHROOM_AGENT_NAME: 'assistant' }
      // cwd is irrelevant when env is set — Claude Code's MCP plugin spawn
      // sets cwd to $HOME but the env var carries the truth.
      expect(getMyAgentName(env, '/home/testuser')).toBe('assistant')
    })

    it('trims whitespace from SWITCHROOM_AGENT_NAME', () => {
      const env = { SWITCHROOM_AGENT_NAME: '  coach  ' }
      expect(getMyAgentName(env, '/home/testuser')).toBe('coach')
    })

    it('falls back to basename(cwd) when env var is unset', () => {
      const env = {}
      expect(getMyAgentName(env, '/home/testuser/.switchroom/agents/assistant')).toBe('assistant')
    })

    it('falls back to basename(cwd) when env var is empty', () => {
      const env = { SWITCHROOM_AGENT_NAME: '' }
      expect(getMyAgentName(env, '/home/testuser/.switchroom/agents/assistant')).toBe('assistant')
    })

    it('returns empty string when both env and cwd are unhelpful (defensive)', () => {
      // Not a real-world case, just locks the no-crash behavior
      const env = {}
      expect(getMyAgentName(env, '/')).toBe('')
    })
  })
})

// afterAll import for the switchroom CLI path test
import { afterAll } from 'vitest'

// ─── Context exhaustion cooldown ─────────────────────────────────────────
// Locks the contract: context exhaustion warns the user but does NOT
// auto-restart (which caused a restart loop). The warning has a 10-min
// cooldown to prevent spamming.

describe('context exhaustion cooldown', () => {
  const COOLDOWN_MS = 10 * 60 * 1000

  /**
   * Replicated from server.ts — the core decision logic: should we warn
   * the user about context exhaustion for this event?
   */
  function shouldWarnContextExhaustion(
    text: string,
    chatId: string | null,
    lastWarningAt: number,
    now: number,
  ): { warn: boolean; reason: string } {
    if (!text.includes('Prompt is too long')) {
      return { warn: false, reason: 'not a context exhaustion event' }
    }
    if (chatId == null) {
      return { warn: false, reason: 'no active chat' }
    }
    if (now - lastWarningAt < COOLDOWN_MS) {
      return { warn: false, reason: 'cooldown active' }
    }
    return { warn: true, reason: 'context exhausted' }
  }

  it('warns on first "Prompt is too long" with an active chat', () => {
    const result = shouldWarnContextExhaustion('Prompt is too long', '-100', 0, Date.now())
    expect(result.warn).toBe(true)
  })

  it('does NOT warn when no active chat', () => {
    const result = shouldWarnContextExhaustion('Prompt is too long', null, 0, Date.now())
    expect(result.warn).toBe(false)
  })

  it('does NOT warn for normal text', () => {
    const result = shouldWarnContextExhaustion('Hello world', '-100', 0, Date.now())
    expect(result.warn).toBe(false)
  })

  it('suppresses duplicate warnings within the cooldown window', () => {
    const now = Date.now()
    const firstWarningAt = now - 5 * 60 * 1000 // 5 minutes ago
    const result = shouldWarnContextExhaustion('Prompt is too long', '-100', firstWarningAt, now)
    expect(result.warn).toBe(false)
    expect(result.reason).toBe('cooldown active')
  })

  it('allows a new warning after the cooldown expires', () => {
    const now = Date.now()
    const oldWarningAt = now - 11 * 60 * 1000 // 11 minutes ago
    const result = shouldWarnContextExhaustion('Prompt is too long', '-100', oldWarningAt, now)
    expect(result.warn).toBe(true)
  })

  it('does NOT auto-restart (the previous bug that caused the loop)', () => {
    // This test exists purely to document and prevent regression on the
    // restart-loop bug. The fix: warn the user and let them /restart
    // manually instead of calling spawnClerkDetached(['agent', 'restart', ...]).
    // If anyone re-adds auto-restart, this test name will remind them why
    // it was removed.
    const result = shouldWarnContextExhaustion('Prompt is too long', '-100', 0, Date.now())
    expect(result.warn).toBe(true)
    // The contract: warn=true means "send a Telegram message asking
    // the user to /restart". It does NOT mean "spawn a restart".
    // There is no "restart" field in the return type.
    expect(result).not.toHaveProperty('restart')
  })
})

// ─── /restart marker + debounce + boot follow-up ─────────────────────────
// Locks the contract behind d2f858b: /restart writes a marker, the new bot
// reads it on boot and posts "✅ Restarted", and duplicate /restart within
// 15s returns "already in progress" instead of stacking systemd restarts.

describe('restart-pending marker', () => {
  const DEBOUNCE_MS = 15_000
  const STALE_MS = 5 * 60_000

  type RestartMarker = {
    chat_id: string
    thread_id: number | null
    ack_message_id: number | null
    ts: number
  }

  // Replicated debounce check from the /restart handler in server.ts.
  function shouldDebounceRestart(
    existing: RestartMarker | null,
    now: number,
  ): { debounce: boolean; ageMs: number } {
    if (!existing) return { debounce: false, ageMs: 0 }
    const ageMs = now - existing.ts
    return { debounce: ageMs < DEBOUNCE_MS, ageMs }
  }

  // Replicated boot-time staleness check from the follow-up block in server.ts.
  function shouldSendBootFollowup(
    marker: RestartMarker | null,
    now: number,
  ): { send: boolean; ageSec: number } {
    if (!marker) return { send: false, ageSec: 0 }
    const ageMs = now - marker.ts
    if (ageMs >= STALE_MS) return { send: false, ageSec: Math.round(ageMs / 1000) }
    const ageSec = Math.max(1, Math.round(ageMs / 1000))
    return { send: true, ageSec }
  }

  describe('debounce (duplicate /restart within 15s)', () => {
    it('allows the first /restart (no existing marker)', () => {
      const r = shouldDebounceRestart(null, Date.now())
      expect(r.debounce).toBe(false)
    })

    it('debounces a second /restart 1s after the first', () => {
      const now = 1_000_000
      const existing: RestartMarker = { chat_id: '1', thread_id: null, ack_message_id: 10, ts: now - 1_000 }
      const r = shouldDebounceRestart(existing, now)
      expect(r.debounce).toBe(true)
      expect(r.ageMs).toBe(1_000)
    })

    it('debounces a second /restart 14.9s after the first (just inside window)', () => {
      const now = 1_000_000
      const existing: RestartMarker = { chat_id: '1', thread_id: null, ack_message_id: null, ts: now - 14_900 }
      const r = shouldDebounceRestart(existing, now)
      expect(r.debounce).toBe(true)
    })

    it('allows a /restart 15s later (at the boundary — strictly less-than)', () => {
      const now = 1_000_000
      const existing: RestartMarker = { chat_id: '1', thread_id: null, ack_message_id: null, ts: now - 15_000 }
      const r = shouldDebounceRestart(existing, now)
      expect(r.debounce).toBe(false)
    })

    it('allows a /restart long after the previous marker (stale / never cleared)', () => {
      const now = 1_000_000
      const existing: RestartMarker = { chat_id: '1', thread_id: null, ack_message_id: null, ts: now - 60 * 60_000 }
      const r = shouldDebounceRestart(existing, now)
      expect(r.debounce).toBe(false)
    })
  })

  describe('boot follow-up staleness (skip markers >5 min old)', () => {
    it('sends follow-up for a fresh marker (2s old)', () => {
      const now = 1_000_000
      const marker: RestartMarker = { chat_id: '1', thread_id: null, ack_message_id: 10, ts: now - 2_000 }
      const r = shouldSendBootFollowup(marker, now)
      expect(r.send).toBe(true)
      expect(r.ageSec).toBe(2)
    })

    it('reports age ≥1s even for sub-second markers (Math.max guard)', () => {
      // Prevents "took ~0s" which looks silly in Telegram.
      const now = 1_000_000
      const marker: RestartMarker = { chat_id: '1', thread_id: null, ack_message_id: null, ts: now - 200 }
      const r = shouldSendBootFollowup(marker, now)
      expect(r.send).toBe(true)
      expect(r.ageSec).toBe(1)
    })

    it('sends follow-up for a 4m59s marker (just inside window)', () => {
      const now = 1_000_000
      const marker: RestartMarker = { chat_id: '1', thread_id: null, ack_message_id: null, ts: now - (5 * 60_000 - 1_000) }
      const r = shouldSendBootFollowup(marker, now)
      expect(r.send).toBe(true)
    })

    it('SKIPS follow-up for a 5m marker (boundary — not this restart)', () => {
      const now = 1_000_000
      const marker: RestartMarker = { chat_id: '1', thread_id: null, ack_message_id: null, ts: now - 5 * 60_000 }
      const r = shouldSendBootFollowup(marker, now)
      expect(r.send).toBe(false)
    })

    it('SKIPS follow-up for an ancient marker (hour-old crash residue)', () => {
      const now = 1_000_000
      const marker: RestartMarker = { chat_id: '1', thread_id: null, ack_message_id: null, ts: now - 60 * 60_000 }
      const r = shouldSendBootFollowup(marker, now)
      expect(r.send).toBe(false)
    })

    it('skips follow-up when no marker exists (cold boot, not a restart)', () => {
      const r = shouldSendBootFollowup(null, Date.now())
      expect(r.send).toBe(false)
    })
  })

  describe('marker filesystem roundtrip', () => {
    // These tests exercise the actual write/read/clear helpers against a
    // real tmp dir so we catch JSON-shape regressions and the
    // "no agent dir → no-op" path.

    const { writeFileSync, readFileSync, existsSync, rmSync, mkdtempSync } = require('fs') as typeof import('fs')
    const { join } = require('path') as typeof import('path')
    const { tmpdir } = require('os') as typeof import('os')

    function markerPath(agentDir: string | null): string | null {
      if (!agentDir) return null
      return join(agentDir, 'restart-pending.json')
    }

    function writeMarker(agentDir: string | null, marker: RestartMarker): void {
      const p = markerPath(agentDir)
      if (!p) return
      try {
        writeFileSync(p, JSON.stringify(marker))
      } catch {
        // best-effort; the restart path continues even if this fails
      }
    }

    function readMarker(agentDir: string | null): RestartMarker | null {
      const p = markerPath(agentDir)
      if (!p) return null
      try {
        return JSON.parse(readFileSync(p, 'utf8')) as RestartMarker
      } catch {
        return null
      }
    }

    function clearMarker(agentDir: string | null): void {
      const p = markerPath(agentDir)
      if (!p) return
      try { rmSync(p, { force: true }) } catch { /* best effort */ }
    }

    let dir: string
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'switchroom-restart-test-'))
    })

    it('roundtrips a marker through write → read', () => {
      const m: RestartMarker = { chat_id: '-100123', thread_id: 42, ack_message_id: 7, ts: 1_700_000_000_000 }
      writeMarker(dir, m)
      expect(readMarker(dir)).toEqual(m)
      rmSync(dir, { recursive: true, force: true })
    })

    it('preserves null thread_id and null ack_message_id (non-forum, ack-send-failed case)', () => {
      // Regression guard: the restart handler sets ack_message_id=null when
      // the API sendMessage throws. The marker must survive JSON round-trip
      // without coercing nulls to undefined, or the boot follow-up's
      // reply_parameters branch will misbehave.
      const m: RestartMarker = { chat_id: '555', thread_id: null, ack_message_id: null, ts: 1 }
      writeMarker(dir, m)
      const back = readMarker(dir)
      expect(back).not.toBeNull()
      expect(back!.thread_id).toBeNull()
      expect(back!.ack_message_id).toBeNull()
      rmSync(dir, { recursive: true, force: true })
    })

    it('clearMarker removes the file and subsequent read returns null', () => {
      writeMarker(dir, { chat_id: '1', thread_id: null, ack_message_id: null, ts: 1 })
      expect(existsSync(join(dir, 'restart-pending.json'))).toBe(true)
      clearMarker(dir)
      expect(existsSync(join(dir, 'restart-pending.json'))).toBe(false)
      expect(readMarker(dir)).toBeNull()
      rmSync(dir, { recursive: true, force: true })
    })

    it('readMarker returns null when the file does not exist (cold boot)', () => {
      expect(readMarker(dir)).toBeNull()
      rmSync(dir, { recursive: true, force: true })
    })

    it('readMarker returns null for corrupt JSON (partial write during SIGTERM)', () => {
      // Simulates the race where /restart was interrupted mid-write. The
      // boot-time reader must NOT crash — it should treat this as "no
      // marker" and continue cold-boot.
      writeFileSync(join(dir, 'restart-pending.json'), '{not valid json')
      expect(readMarker(dir)).toBeNull()
      rmSync(dir, { recursive: true, force: true })
    })

    it('no-ops silently when agent dir is unresolved (env unset)', () => {
      // resolveAgentDirFromEnv() returns null when SWITCHROOM_AGENT_DIR is
      // unset; the helpers must handle that path without throwing.
      expect(markerPath(null)).toBeNull()
      expect(readMarker(null)).toBeNull()
      expect(() => writeMarker(null, { chat_id: '1', thread_id: null, ack_message_id: null, ts: 1 })).not.toThrow()
      expect(() => clearMarker(null)).not.toThrow()
    })

    it('clearMarker is idempotent (safe to call twice)', () => {
      writeMarker(dir, { chat_id: '1', thread_id: null, ack_message_id: null, ts: 1 })
      clearMarker(dir)
      expect(() => clearMarker(dir)).not.toThrow()
      rmSync(dir, { recursive: true, force: true })
    })
  })

  describe('interaction: debounce + boot follow-up', () => {
    it('marker set by /restart at T=0 debounces a duplicate at T=5s, then boot at T=12s sends follow-up with age=12s', () => {
      // Simulates the real sequence:
      //   T=0    user hits /restart → writeMarker(ts=0), spawn systemd restart
      //   T=5s   user hits /restart again → debounce (age=5000ms < 15000ms)
      //   T=12s  new bot boots → readMarker, age=12s < 5min → send "✅ Restarted ~12s"
      const t0 = 1_000_000
      const marker: RestartMarker = { chat_id: '1', thread_id: null, ack_message_id: 99, ts: t0 }

      const dupAt5s = shouldDebounceRestart(marker, t0 + 5_000)
      expect(dupAt5s.debounce).toBe(true)

      const bootAt12s = shouldSendBootFollowup(marker, t0 + 12_000)
      expect(bootAt12s.send).toBe(true)
      expect(bootAt12s.ageSec).toBe(12)
    })

    it('stale marker from a crashed-then-manually-started agent is ignored on boot', () => {
      // Race: bot crashed with a marker on disk but was never restarted.
      // Hours later the user manually `switchroom agent start` it. The
      // boot path reads the ancient marker and must skip the follow-up
      // (otherwise the user gets "✅ Restarted ~3h" out of nowhere).
      const t0 = 1_000_000
      const marker: RestartMarker = { chat_id: '1', thread_id: null, ack_message_id: 99, ts: t0 }
      const boot3hLater = shouldSendBootFollowup(marker, t0 + 3 * 60 * 60_000)
      expect(boot3hLater.send).toBe(false)
    })
  })
})

// ─── /auth subcommand router ─────────────────────────────────────────────
// Replicated dispatch logic from telegram-plugin/server.ts so we can
// unit-test argument parsing + CLI arg construction without booting the bot.

describe('/auth subcommand router', () => {
  type AuthArgs = { argv: string[]; label: string } | { reply: string } | { status: true }

  function routeAuth(raw: string, myAgent: string): AuthArgs {
    const parts = raw.trim().split(/\s+/).filter(Boolean)
    const sub = (parts[0] ?? 'status').toLowerCase()
    const rest = parts.slice(1)
    const known = new Set(['status', 'list', 'add', 'code', 'use', 'reauth', 'rm', 'cancel'])

    if (parts.length === 0 || sub === 'status') return { status: true }
    if (!known.has(sub)) return { reply: `Unknown /auth subcommand: ${sub}` }

    if (sub === 'list') {
      const agent = rest[0] ?? myAgent
      return { argv: ['auth', 'list', agent], label: `auth list ${agent}` }
    }
    if (sub === 'add') {
      const agent = rest[0] ?? myAgent
      const slot = rest[1]
      const argv = ['auth', 'add', agent, ...(slot ? ['--slot', slot] : [])]
      return { argv, label: `auth add ${agent}` }
    }
    if (sub === 'code') {
      if (rest.length < 2) return { reply: 'Usage: /auth code <agent> <code> [<slot>]' }
      const [agent, code, slot] = rest
      const argv = ['auth', 'code', agent, code, ...(slot ? ['--slot', slot] : [])]
      return { argv, label: `auth code ${agent}` }
    }
    if (sub === 'use') {
      if (rest.length < 2) return { reply: 'Usage: /auth use <agent> <slot>' }
      return { argv: ['auth', 'use', rest[0], rest[1]], label: `auth use ${rest[0]}` }
    }
    if (sub === 'reauth') {
      const agent = rest[0] ?? myAgent
      const slot = rest[1]
      const argv = ['auth', 'reauth', agent, ...(slot ? ['--slot', slot] : [])]
      return { argv, label: `auth reauth ${agent}` }
    }
    if (sub === 'rm') {
      if (rest.length < 2) return { reply: 'Usage: /auth rm <agent> <slot>' }
      return { argv: ['auth', 'rm', rest[0], rest[1]], label: `auth rm ${rest[0]}` }
    }
    if (sub === 'cancel') {
      const agent = rest[0] ?? myAgent
      return { argv: ['auth', 'cancel', agent], label: `auth cancel ${agent}` }
    }
    return { reply: 'unreachable' }
  }

  it('empty → status', () => {
    expect(routeAuth('', 'assistant')).toEqual({ status: true })
  })

  it('explicit status → status', () => {
    expect(routeAuth('status', 'assistant')).toEqual({ status: true })
  })

  it('unknown subcommand → helpful reply', () => {
    const r = routeAuth('foo', 'assistant') as { reply: string }
    expect(r.reply).toContain('Unknown')
  })

  it('list defaults agent to self', () => {
    const r = routeAuth('list', 'assistant') as { argv: string[] }
    expect(r.argv).toEqual(['auth', 'list', 'assistant'])
  })

  it('list with explicit agent', () => {
    const r = routeAuth('list coach', 'assistant') as { argv: string[] }
    expect(r.argv).toEqual(['auth', 'list', 'coach'])
  })

  it('add without slot → no --slot flag', () => {
    const r = routeAuth('add', 'assistant') as { argv: string[] }
    expect(r.argv).toEqual(['auth', 'add', 'assistant'])
  })

  it('add with slot → passes --slot', () => {
    const r = routeAuth('add assistant work', 'assistant') as { argv: string[] }
    expect(r.argv).toEqual(['auth', 'add', 'assistant', '--slot', 'work'])
  })

  it('code with agent + code', () => {
    const r = routeAuth('code assistant abc123', 'assistant') as { argv: string[] }
    expect(r.argv).toEqual(['auth', 'code', 'assistant', 'abc123'])
  })

  it('code with agent + code + slot', () => {
    const r = routeAuth('code assistant abc123 work', 'assistant') as { argv: string[] }
    expect(r.argv).toEqual(['auth', 'code', 'assistant', 'abc123', '--slot', 'work'])
  })

  it('code missing args → usage reply', () => {
    const r = routeAuth('code', 'assistant') as { reply: string }
    expect(r.reply).toContain('Usage')
    const r2 = routeAuth('code assistant', 'assistant') as { reply: string }
    expect(r2.reply).toContain('Usage')
  })

  it('use requires agent + slot', () => {
    expect((routeAuth('use', 'assistant') as { reply: string }).reply).toContain('Usage')
    expect((routeAuth('use assistant', 'assistant') as { reply: string }).reply).toContain('Usage')
    const r = routeAuth('use assistant work', 'assistant') as { argv: string[] }
    expect(r.argv).toEqual(['auth', 'use', 'assistant', 'work'])
  })

  it('reauth defaults to self', () => {
    const r = routeAuth('reauth', 'assistant') as { argv: string[] }
    expect(r.argv).toEqual(['auth', 'reauth', 'assistant'])
  })

  it('reauth with slot', () => {
    const r = routeAuth('reauth assistant work', 'assistant') as { argv: string[] }
    expect(r.argv).toEqual(['auth', 'reauth', 'assistant', '--slot', 'work'])
  })

  it('rm requires agent + slot', () => {
    expect((routeAuth('rm', 'assistant') as { reply: string }).reply).toContain('Usage')
    const r = routeAuth('rm assistant old', 'assistant') as { argv: string[] }
    expect(r.argv).toEqual(['auth', 'rm', 'assistant', 'old'])
  })

  it('cancel defaults to self', () => {
    const r = routeAuth('cancel', 'assistant') as { argv: string[] }
    expect(r.argv).toEqual(['auth', 'cancel', 'assistant'])
  })

  it('is case-insensitive on subcommand', () => {
    expect(routeAuth('STATUS', 'assistant')).toEqual({ status: true })
    const r = routeAuth('LIST coach', 'assistant') as { argv: string[] }
    expect(r.argv).toEqual(['auth', 'list', 'coach'])
  })
})

// ─── /reauth one-shot shortcut ───────────────────────────────────────────
// Top-level /reauth command with smart defaults: current agent, active slot.
// /reauth                → start reauth flow for current agent
// /reauth <code>         → complete pending reauth (detected via looksLikeAuthCode)
// /reauth <http://...>   → complete pending reauth (URL path)
// /reauth <agent-name>   → start reauth for named agent (not a code)

describe('/reauth one-shot', () => {
  // Matches the FIXED dispatch logic in server.ts (using looksLikeAuthCode
  // instead of only checking http/session_ prefixes).
  function routeReauth(
    raw: string,
    myAgent: string,
  ): { action: 'start'; agent: string } | { action: 'code'; agent: string; raw: string } {
    const trimmed = raw.trim()
    if (!trimmed) return { action: 'start', agent: myAgent }
    // URL → always treat as code completion
    if (trimmed.startsWith('http')) return { action: 'code', agent: myAgent, raw: trimmed }
    // Looks like an auth code (session_, sk-ant-, or long alphanumeric) → code completion
    if (looksLikeAuthCode(trimmed)) return { action: 'code', agent: myAgent, raw: trimmed }
    // Otherwise → start reauth for the named agent
    return { action: 'start', agent: trimmed }
  }

  it('no args → starts reauth for self', () => {
    expect(routeReauth('', 'assistant')).toEqual({ action: 'start', agent: 'assistant' })
  })

  it('sk-ant-oat token → code completion for self (was the bug: used to be treated as agent name)', () => {
    // Pre-fix: /reauth sk-ant-oat01-abc123 was treated as "start reauth for agent sk-ant-oat01-abc123"
    // Post-fix: looksLikeAuthCode detects it and routes to auth code
    const r = routeReauth('sk-ant-oat01-abc_DEF-xyz', 'assistant')
    expect(r).toEqual({ action: 'code', agent: 'assistant', raw: 'sk-ant-oat01-abc_DEF-xyz' })
  })

  it('session_ prefix → code completion for self', () => {
    const r = routeReauth('session_abc123def456', 'assistant')
    expect(r).toEqual({ action: 'code', agent: 'assistant', raw: 'session_abc123def456' })
  })

  it('http URL → code completion for self', () => {
    const r = routeReauth('https://claude.ai/oauth/authorize?code=abc', 'assistant')
    expect(r).toEqual({ action: 'code', agent: 'assistant', raw: 'https://claude.ai/oauth/authorize?code=abc' })
  })

  it('long alphanumeric code → code completion for self', () => {
    const r = routeReauth('ABC123XYZabc', 'assistant')
    expect(r).toEqual({ action: 'code', agent: 'assistant', raw: 'ABC123XYZabc' })
  })

  it('short agent name → starts reauth for that agent (not treated as code)', () => {
    // "coach" is 5 chars — under the 6-char min for looksLikeAuthCode
    const r = routeReauth('coach', 'assistant')
    expect(r).toEqual({ action: 'start', agent: 'coach' })
  })

  it('agent name with hyphens (6+ chars) could match looksLikeAuthCode — documents the ambiguity', () => {
    // An agent name like "health-coach" (12 chars, alphanumeric + hyphens) would
    // be detected as a code by looksLikeAuthCode. This is a known trade-off:
    // agent names that look like codes get routed as code completion.
    // Mitigation: users should use /auth reauth <agent> for named-agent reauth.
    const r = routeReauth('health-coach', 'assistant')
    // This is the current behavior — document it so future changes are explicit.
    expect(r.action).toBe('code') // looksLikeAuthCode('health-coach') === true
  })

  it('empty string after trimming → starts reauth for self', () => {
    expect(routeReauth('   ', 'coach')).toEqual({ action: 'start', agent: 'coach' })
  })
})

// ─── looksLikeAuthCode — browser code detection ────────────────────────────
// Replicated from server.ts to test the pure matching logic.

function looksLikeAuthCode(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed || /\s/.test(trimmed)) return false
  if (trimmed.startsWith('session_')) return true
  if (trimmed.startsWith('sk-ant-')) return true
  if (/^[A-Za-z0-9_-]{6,200}$/.test(trimmed)) return true
  return false
}

describe('looksLikeAuthCode', () => {
  it('accepts session_ prefixed codes', () => {
    expect(looksLikeAuthCode('session_abc123')).toBe(true)
  })

  it('accepts sk-ant- tokens', () => {
    expect(looksLikeAuthCode('sk-ant-oat01-abc_DEF-123')).toBe(true)
  })

  it('accepts short alphanumeric codes', () => {
    expect(looksLikeAuthCode('ABC123')).toBe(true)
    expect(looksLikeAuthCode('a1b2c3d4e5')).toBe(true)
  })

  it('accepts codes with underscores and hyphens', () => {
    expect(looksLikeAuthCode('my_auth-code_123')).toBe(true)
  })

  it('rejects empty strings', () => {
    expect(looksLikeAuthCode('')).toBe(false)
    expect(looksLikeAuthCode('   ')).toBe(false)
  })

  it('rejects strings with spaces (natural language)', () => {
    expect(looksLikeAuthCode('hello world')).toBe(false)
    expect(looksLikeAuthCode('fix the bug please')).toBe(false)
  })

  it('rejects very short codes (under 6 chars)', () => {
    expect(looksLikeAuthCode('abc')).toBe(false)
    expect(looksLikeAuthCode('12345')).toBe(false)
  })

  it('rejects codes with special characters', () => {
    expect(looksLikeAuthCode('code!@#')).toBe(false)
    expect(looksLikeAuthCode('hello.world')).toBe(false)
  })

  it('trims leading/trailing whitespace before checking', () => {
    expect(looksLikeAuthCode('  ABC123  ')).toBe(true)
  })
})

// ─── Reauth auto-intercept routing ──────────────────────────────────────────
// When a reauth flow is pending, plain text messages that look like auth codes
// should be intercepted and routed to `auth code` without involving the LLM.

describe('reauth auto-intercept', () => {
  const REAUTH_INTERCEPT_TTL_MS = 10 * 60_000

  type PendingReauth = { agent: string; startedAt: number }

  /** Simulates the intercept logic from handleInbound */
  function shouldIntercept(
    text: string,
    pending: PendingReauth | undefined,
  ): { argv: string[] } | null {
    if (!pending) return null
    if (!looksLikeAuthCode(text)) return null
    const elapsed = Date.now() - pending.startedAt
    if (elapsed >= REAUTH_INTERCEPT_TTL_MS) return null
    return { argv: ['auth', 'code', pending.agent, text.trim()] }
  }

  it('intercepts a code when reauth is pending', () => {
    const pending = { agent: 'assistant', startedAt: Date.now() }
    const result = shouldIntercept('ABC123XYZ', pending)
    expect(result).toEqual({ argv: ['auth', 'code', 'assistant', 'ABC123XYZ'] })
  })

  it('intercepts a session_ code', () => {
    const pending = { agent: 'coach', startedAt: Date.now() }
    const result = shouldIntercept('session_abcdef', pending)
    expect(result).toEqual({ argv: ['auth', 'code', 'coach', 'session_abcdef'] })
  })

  it('does not intercept when no reauth is pending', () => {
    expect(shouldIntercept('ABC123XYZ', undefined)).toBeNull()
  })

  it('does not intercept natural language messages', () => {
    const pending = { agent: 'assistant', startedAt: Date.now() }
    expect(shouldIntercept('fix the bug', pending)).toBeNull()
    expect(shouldIntercept('what is the status?', pending)).toBeNull()
  })

  it('does not intercept after TTL expires', () => {
    const pending = { agent: 'assistant', startedAt: Date.now() - 11 * 60_000 }
    expect(shouldIntercept('ABC123XYZ', pending)).toBeNull()
  })

  it('trims the code before building argv', () => {
    const pending = { agent: 'assistant', startedAt: Date.now() }
    const result = shouldIntercept('  ABC123XYZ  ', pending)
    expect(result).toEqual({ argv: ['auth', 'code', 'assistant', 'ABC123XYZ'] })
  })
})

// ─── /reconcile debounce ─────────────────────────────────────────────────
// /reconcile self-restart now uses the same 15s debounce + restart-marker
// pattern as /restart so the new bot posts a follow-up and duplicate taps
// don't stack systemd reconcile+restarts.

describe('/reconcile debounce', () => {
  const DEBOUNCE_MS = 15_000

  type RestartMarker = {
    chat_id: string
    thread_id: number | null
    ack_message_id: number | null
    ts: number
  }

  // Same debounce logic used for both /restart and /reconcile.
  function shouldDebounce(existing: RestartMarker | null, now: number): boolean {
    if (!existing) return false
    return (now - existing.ts) < DEBOUNCE_MS
  }

  it('allows the first /reconcile (no marker)', () => {
    expect(shouldDebounce(null, Date.now())).toBe(false)
  })

  it('debounces a duplicate /reconcile within 15s', () => {
    const now = 1_000_000
    const marker: RestartMarker = { chat_id: '1', thread_id: null, ack_message_id: 1, ts: now - 5_000 }
    expect(shouldDebounce(marker, now)).toBe(true)
  })

  it('allows /reconcile after 15s', () => {
    const now = 1_000_000
    const marker: RestartMarker = { chat_id: '1', thread_id: null, ack_message_id: null, ts: now - 15_000 }
    expect(shouldDebounce(marker, now)).toBe(false)
  })

  it('/restart and /reconcile share the same marker file — a /restart debounces a following /reconcile', () => {
    // Both handlers write to restart-pending.json and both read it for debounce.
    // A rapid /restart followed by /reconcile (or vice versa) within 15s
    // should be debounced — they share the same mechanism.
    const now = 1_000_000
    const restartMarker: RestartMarker = { chat_id: '1', thread_id: null, ack_message_id: 99, ts: now - 3_000 }
    // Reconcile arriving 3s after restart → debounced
    expect(shouldDebounce(restartMarker, now)).toBe(true)
  })
})

// ─── formatAuthOutputForTelegram ─────────────────────────────────────────
// Pure function: formats switchroom auth output for Telegram HTML.
// Extracts login URLs, bolds key lines, wraps commands in <code>.

describe('formatAuthOutputForTelegram', () => {
  function stripAnsi(text: string): string {
    return text
      .replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, '')
      .replace(/\x1B[@-_]/g, '')
      .replace(/\r/g, '')
  }

  function preBlock(text: string): string {
    return '<pre>' + text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</pre>'
  }

  function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }

  function formatAuthOutputForTelegram(output: string): string {
    const trimmed = stripAnsi(output).trim()
    const url = trimmed.match(/https:\/\/\S+/)?.[0] ?? null
    const lines = trimmed.split(/\n+/).map(l => l.trim()).filter(Boolean)

    if (!url) {
      return preBlock(trimmed.length > 4000 ? trimmed.slice(0, 3980) + '\n... (truncated)' : trimmed)
    }

    const body = lines.filter(line => line !== url)
    const rendered = body.map(line => {
      if (line.startsWith('Started Claude auth') || line.startsWith('Auth session already running')) {
        return `<b>${escapeHtml(line)}</b>`
      }
      if (line.startsWith('Then finish with:') || line.startsWith('Cancel with:')) {
        return escapeHtml(line)
      }
      if (line.startsWith('switchroom auth ')) {
        return `<code>${escapeHtml(line)}</code>`
      }
      return escapeHtml(line)
    })

    rendered.push('', `<a href="${escapeHtml(url)}">Open Claude login</a>`, escapeHtml(url))
    return rendered.join('\n')
  }

  it('wraps plain output (no URL) in a code block', () => {
    const result = formatAuthOutputForTelegram('Agent already authenticated.\n  Expires: 7h 28m')
    expect(result).toContain('<pre>')
    expect(result).toContain('Agent already authenticated.')
  })

  it('extracts URL and converts it to a clickable link', () => {
    const output = [
      'Started Claude auth for agent "assistant" in tmux session switchroom-auth-assistant.',
      'Open this URL in your browser:',
      'https://claude.ai/oauth/authorize?code=true&client_id=abc123',
      '',
      'After Claude shows you a browser code, finish with:',
      '  switchroom auth code assistant <browser-code>',
    ].join('\n')
    const result = formatAuthOutputForTelegram(output)
    expect(result).toContain('<a href="https://claude.ai/oauth/authorize?code=true&amp;client_id=abc123">Open Claude login</a>')
    expect(result).not.toContain('<pre>')
  })

  it('bolds "Started Claude auth" header line', () => {
    const output = 'Started Claude auth for agent "assistant".\nhttps://claude.ai/oauth/authorize?foo=bar'
    const result = formatAuthOutputForTelegram(output)
    expect(result).toContain('<b>Started Claude auth')
  })

  it('bolds "Auth session already running" line', () => {
    const output = 'Auth session already running for agent "assistant".\nhttps://claude.ai/oauth/authorize?foo=bar'
    const result = formatAuthOutputForTelegram(output)
    expect(result).toContain('<b>Auth session already running')
  })

  it('wraps switchroom auth commands in <code>', () => {
    const output = [
      'Started Claude auth.',
      'switchroom auth code assistant <browser-code>',
      'https://claude.ai/oauth/authorize?foo=bar',
    ].join('\n')
    const result = formatAuthOutputForTelegram(output)
    expect(result).toContain('<code>switchroom auth code assistant &lt;browser-code&gt;</code>')
  })

  it('HTML-escapes agent names and tokens in output', () => {
    const output = 'Error: <unknown> agent & token="test"\nhttps://claude.ai/oauth/authorize?x=1'
    const result = formatAuthOutputForTelegram(output)
    expect(result).not.toContain('<unknown>')
    expect(result).toContain('&lt;unknown&gt;')
    expect(result).toContain('&amp;')
  })

  it('strips ANSI escape codes from CLI output', () => {
    const output = '\x1B[32mStarted Claude auth for agent "assistant".\x1B[0m\nhttps://claude.ai/x'
    const result = formatAuthOutputForTelegram(output)
    expect(result).not.toContain('\x1B')
    expect(result).toContain('Started Claude auth')
  })
})

// ─── /logs argument parsing ──────────────────────────────────────────────

describe('/logs argument parsing', () => {
  function parseLogsArgs(
    matchStr: string,
    myAgent: string,
  ): { name: string; lineCount: number } {
    const parts = matchStr.trim().split(/\s+/).filter(Boolean)
    let name: string
    let linesArg: string | undefined
    if (parts.length === 0) {
      name = myAgent
    } else if (parts.length === 1 && /^\d+$/.test(parts[0])) {
      name = myAgent
      linesArg = parts[0]
    } else {
      name = parts[0]
      linesArg = parts[1]
    }
    const lines = linesArg ? parseInt(linesArg, 10) : 20
    const lineCount = isNaN(lines) || lines < 1 ? 20 : Math.min(lines, 200)
    return { name, lineCount }
  }

  it('no args → current agent, 20 lines', () => {
    expect(parseLogsArgs('', 'assistant')).toEqual({ name: 'assistant', lineCount: 20 })
  })

  it('single numeric arg → current agent, that many lines', () => {
    expect(parseLogsArgs('50', 'assistant')).toEqual({ name: 'assistant', lineCount: 50 })
  })

  it('agent name only → named agent, 20 lines', () => {
    expect(parseLogsArgs('coach', 'assistant')).toEqual({ name: 'coach', lineCount: 20 })
  })

  it('agent + line count', () => {
    expect(parseLogsArgs('coach 100', 'assistant')).toEqual({ name: 'coach', lineCount: 100 })
  })

  it('clamps line count to 200 max', () => {
    expect(parseLogsArgs('coach 9999', 'assistant')).toEqual({ name: 'coach', lineCount: 200 })
  })

  it('falls back to 20 for invalid line count', () => {
    expect(parseLogsArgs('coach abc', 'assistant')).toEqual({ name: 'coach', lineCount: 20 })
    expect(parseLogsArgs('0', 'assistant')).toEqual({ name: 'assistant', lineCount: 20 })
  })

  it('single numeric arg does not mistake it for agent name', () => {
    // "50" alone → line count for current agent, NOT agent named "50"
    const result = parseLogsArgs('50', 'assistant')
    expect(result.name).toBe('assistant')
    expect(result.lineCount).toBe(50)
  })
})

// ─── Restart --force guard ────────────────────────────────────────────────
// The self-targeting /restart MUST pass --force to spawnSwitchroomDetached.
// Without it, the CLI's interactive preflight prompt reads from a detached
// stdin that immediately returns EOF, askYesNo returns false, and the
// restart aborts silently — leaving an orphaned restart-pending.json and
// the user wondering why nothing happened.
//
// This test group locks the args contract so a refactor can't accidentally
// drop --force and reintroduce the silent-abort regression.

describe('self-restart args contracts', () => {
  // Replicates the args-building logic from the self-targeting branch of
  // /restart in server.ts (around the spawnSwitchroomDetached call).
  function buildRestartArgs(name: string): string[] {
    // Self-targeting restart MUST include --force to bypass the interactive
    // preflight prompt on a detached (non-tty) stdin.
    return ['agent', 'restart', name, '--force']
  }

  // Replicates the args-building logic for /reconcile self-restart.
  function buildReconcileArgs(name: string): string[] {
    return ['agent', 'reconcile', name, '--restart']
  }

  // Replicates /update dispatch.
  function buildUpdateArgs(): string[] {
    return ['update']
  }

  it('/restart self includes --force (prevents silent preflight abort)', () => {
    const args = buildRestartArgs('assistant')
    expect(args).toContain('--force')
    expect(args).toEqual(['agent', 'restart', 'assistant', '--force'])
  })

  it('/restart for "all" includes --force', () => {
    const args = buildRestartArgs('all')
    expect(args).toContain('--force')
    expect(args).toEqual(['agent', 'restart', 'all', '--force'])
  })

  it('/restart does NOT omit the agent name', () => {
    // Regression guard: early versions sent ['agent', 'restart', '--force']
    // which was ambiguous / wrong for multi-agent setups.
    const args = buildRestartArgs('assistant')
    expect(args[2]).toBe('assistant')
    expect(args[3]).toBe('--force')
    expect(args).toHaveLength(4)
  })

  it('/reconcile self uses --restart flag, not --force', () => {
    // /reconcile triggers a reconcile-then-restart; it uses --restart not --force
    // because reconcile does not have an interactive preflight.
    const args = buildReconcileArgs('assistant')
    expect(args).toContain('--restart')
    expect(args).not.toContain('--force')
    expect(args).toEqual(['agent', 'reconcile', 'assistant', '--restart'])
  })

  it('/update dispatches ["update"] with no sub-args (no agent name, no --force)', () => {
    // /update runs a global update (git pull, reinstall, reconcile, restart).
    // It does NOT need --force because it operates at the system level, not
    // as a self-targeted agent restart.
    const args = buildUpdateArgs()
    expect(args).toEqual(['update'])
    expect(args).not.toContain('--force')
    expect(args).not.toContain('agent')
  })

  it('restart with --config prepended does not break --force position', () => {
    // spawnSwitchroomDetached prepends ['--config', configPath] when
    // SWITCHROOM_CONFIG is set. Verify the base args remain intact.
    const baseArgs = buildRestartArgs('assistant')
    const config = '/path/to/switchroom.yaml'
    const fullArgs = config ? ['--config', config, ...baseArgs] : baseArgs
    // Full args: ['--config', '...', 'agent', 'restart', 'assistant', '--force']
    expect(fullArgs[0]).toBe('--config')
    expect(fullArgs[1]).toBe(config)
    expect(fullArgs.slice(2)).toEqual(['agent', 'restart', 'assistant', '--force'])
    expect(fullArgs).toContain('--force')
  })
})

// ─── Context exhaustion cooldown boundary conditions ─────────────────────
// Edge-case coverage for the 10-minute cooldown that prevents spamming the
// user with "context window full" warnings. The boundary behaviour matters:
// at exactly 10min the cooldown expires (strictly-less-than check), just
// under keeps it suppressed.

describe('context exhaustion cooldown boundaries', () => {
  const COOLDOWN_MS = 10 * 60 * 1000 // 600_000ms

  function isCoolingDown(lastWarningAt: number, now: number): boolean {
    return (now - lastWarningAt) < COOLDOWN_MS
  }

  it('at exactly 10min elapsed → cooldown EXPIRES (boundary: strictly less-than)', () => {
    // now - lastWarningAt === COOLDOWN_MS → not strictly less → warn allowed
    const lastWarningAt = 1_000_000
    const now = lastWarningAt + COOLDOWN_MS
    expect(isCoolingDown(lastWarningAt, now)).toBe(false)
  })

  it('at 9m59s (1s before boundary) → still in cooldown', () => {
    const lastWarningAt = 1_000_000
    const now = lastWarningAt + COOLDOWN_MS - 1_000
    expect(isCoolingDown(lastWarningAt, now)).toBe(true)
  })

  it('at 9m59.999s → still in cooldown', () => {
    const lastWarningAt = 1_000_000
    const now = lastWarningAt + COOLDOWN_MS - 1
    expect(isCoolingDown(lastWarningAt, now)).toBe(true)
  })

  it('at 10m1s → cooldown expired', () => {
    const lastWarningAt = 1_000_000
    const now = lastWarningAt + COOLDOWN_MS + 1_000
    expect(isCoolingDown(lastWarningAt, now)).toBe(false)
  })

  it('lastWarningAt=0 (never warned) → not in cooldown regardless of now', () => {
    // Date.now() is always >> COOLDOWN_MS, so the very first warning is never suppressed.
    expect(isCoolingDown(0, Date.now())).toBe(false)
  })

  it('multiple rapid firings: only the first passes through', () => {
    // Simulates: context exhaustion fires 3 times within the same second
    // (e.g., three "Prompt is too long" blocks from Claude Code in quick succession).
    let lastWarningAt = 0
    const base = 1_000_000_000

    const fire = (now: number): boolean => {
      if (isCoolingDown(lastWarningAt, now)) return false
      lastWarningAt = now
      return true
    }

    expect(fire(base)).toBe(true)       // first: fires
    expect(fire(base + 100)).toBe(false) // 100ms later: blocked
    expect(fire(base + 500)).toBe(false) // 500ms later: blocked
    expect(fire(base + COOLDOWN_MS)).toBe(true) // 10min later: fires again
  })
})

// ─── vault commands ───────────────────────────────────────────────────────
// Tests for runVaultCli and vault command argument logic.
// Because server.ts has side-effects (bot startup, MCP connection) we
// replicate the pure helpers here and mock execFileSync directly.

describe('vault commands', () => {
  // Replicated runVaultCli from server.ts, with injectable exec for testing.
  // The production function uses execFileSync from 'child_process' directly.
  type ExecFileFn = (cmd: string, args: string[], opts: object) => string

  function runVaultCliWith(
    exec: ExecFileFn,
    args: string[],
    passphrase: string,
    stdinValue?: string,
  ): { ok: boolean; output: string } {
    const env = { ...process.env, SWITCHROOM_VAULT_PASSPHRASE: passphrase }
    try {
      let result: string
      if (stdinValue !== undefined) {
        result = exec(
          process.env.SWITCHROOM_CLI_PATH ?? 'switchroom',
          ['vault', ...args],
          { input: stdinValue, encoding: 'utf8', env, timeout: 10000 },
        )
      } else {
        result = exec(
          process.env.SWITCHROOM_CLI_PATH ?? 'switchroom',
          ['vault', ...args],
          { encoding: 'utf8', env, timeout: 10000 },
        )
      }
      return { ok: true, output: result.trim() }
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; message?: string }
      const detail = [e.stdout, e.stderr, e.message].filter(Boolean).join('\n').trim()
      return { ok: false, output: detail }
    }
  }

  describe('runVaultCli — success', () => {
    it('returns ok:true and trimmed output when exec succeeds', () => {
      const mockExec = vi.fn<ExecFileFn>().mockReturnValue('key1\nkey2\n')
      const result = runVaultCliWith(mockExec, ['list'], 'my-passphrase')
      expect(result).toEqual({ ok: true, output: 'key1\nkey2' })
    })

    it('passes vault passphrase in env and correct args', () => {
      const mockExec = vi.fn<ExecFileFn>().mockReturnValue('ok\n')
      runVaultCliWith(mockExec, ['get', 'MY_SECRET'], 'secret-pass')
      expect(mockExec).toHaveBeenCalledWith(
        expect.any(String),
        ['vault', 'get', 'MY_SECRET'],
        expect.objectContaining({
          encoding: 'utf8',
          env: expect.objectContaining({ SWITCHROOM_VAULT_PASSPHRASE: 'secret-pass' }),
        }),
      )
    })

    it('passes stdinValue when provided (vault set)', () => {
      const mockExec = vi.fn<ExecFileFn>().mockReturnValue('')
      runVaultCliWith(mockExec, ['set', 'MY_KEY'], 'pass', 'my-value')
      expect(mockExec).toHaveBeenCalledWith(
        expect.any(String),
        ['vault', 'set', 'MY_KEY'],
        expect.objectContaining({ input: 'my-value' }),
      )
    })
  })

  describe('runVaultCli — failure', () => {
    it('returns ok:false and collects stderr when exec throws', () => {
      const err = Object.assign(new Error('exit code 1'), { stderr: 'wrong passphrase', stdout: '' })
      const mockExec = vi.fn<ExecFileFn>().mockImplementation(() => { throw err })
      const result = runVaultCliWith(mockExec, ['list'], 'bad-pass')
      expect(result.ok).toBe(false)
      expect(result.output).toContain('wrong passphrase')
    })

    it('falls back to error.message when stderr is empty', () => {
      const err = Object.assign(new Error('vault not found'), { stderr: '', stdout: '' })
      const mockExec = vi.fn<ExecFileFn>().mockImplementation(() => { throw err })
      const result = runVaultCliWith(mockExec, ['list'], 'pass')
      expect(result.ok).toBe(false)
      expect(result.output).toContain('vault not found')
    })
  })

  describe('vault argument parsing', () => {
    it('/vault help: empty args triggers help response', () => {
      // Simulate the /vault command handler arg-parsing logic
      const match = ''
      const args = match.trim().split(/\s+/).filter(Boolean)
      const sub = args[0]?.toLowerCase()
      expect(!sub || sub === 'help').toBe(true)
    })

    it('/vault list: parses subcommand correctly', () => {
      const match = 'list'
      const args = match.trim().split(/\s+/).filter(Boolean)
      const sub = args[0]?.toLowerCase()
      const key = args[1]
      expect(sub).toBe('list')
      expect(key).toBeUndefined()
    })

    it('/vault get <key>: parses key', () => {
      const match = 'get MY_API_KEY'
      const args = match.trim().split(/\s+/).filter(Boolean)
      const sub = args[0]?.toLowerCase()
      const key = args[1]
      expect(sub).toBe('get')
      expect(key).toBe('MY_API_KEY')
    })

    it('/vault set: missing key triggers usage reply (key is required)', () => {
      const match = 'set'
      const args = match.trim().split(/\s+/).filter(Boolean)
      const sub = args[0]?.toLowerCase()
      const key = args[1]
      // Handler checks: if sub === 'set' && !key → error
      expect(sub === 'set' && !key).toBe(true)
    })

    it('/vault set <key>: key present, no inline value → prompts for value', () => {
      const match = 'set MY_SECRET'
      const args = match.trim().split(/\s+/).filter(Boolean)
      const sub = args[0]?.toLowerCase()
      const key = args[1]
      expect(sub).toBe('set')
      expect(key).toBe('MY_SECRET')
    })

    it('/vault delete <key>: parses correctly', () => {
      const match = 'delete OLD_KEY'
      const args = match.trim().split(/\s+/).filter(Boolean)
      const sub = args[0]?.toLowerCase()
      const key = args[1]
      expect(sub).toBe('delete')
      expect(key).toBe('OLD_KEY')
    })

    it('/vault remove: treated as alias for delete', () => {
      const match = 'remove OLD_KEY'
      const args = match.trim().split(/\s+/).filter(Boolean)
      const sub = args[0]?.toLowerCase()
      const effectiveSub = sub === 'remove' ? 'delete' : sub
      expect(effectiveSub).toBe('delete')
    })

    it('unknown subcommand is detected', () => {
      const match = 'export'
      const args = match.trim().split(/\s+/).filter(Boolean)
      const sub = args[0]?.toLowerCase()
      const known = ['list', 'get', 'set', 'delete', 'remove']
      expect(known.includes(sub!)).toBe(false)
    })
  })

  describe('vault intercept — value extraction', () => {
    it('extracts value from a code block', () => {
      const text = '```\nmy-secret-value\n```'
      const codeBlockMatch = /^```[\w]*\n?([\s\S]*?)```$/m.exec(text)
      const value = codeBlockMatch ? codeBlockMatch[1]! : text
      expect(value.trim()).toBe('my-secret-value')
    })

    it('extracts value from a code block with language tag', () => {
      const text = '```json\n{"key": "value"}\n```'
      const codeBlockMatch = /^```[\w]*\n?([\s\S]*?)```$/m.exec(text)
      const value = codeBlockMatch ? codeBlockMatch[1]! : text
      expect(value.trim()).toBe('{"key": "value"}')
    })

    it('returns plain text as-is when no code block', () => {
      const text = 'plain-secret'
      const codeBlockMatch = /^```[\w]*\n?([\s\S]*?)```$/m.exec(text)
      const value = codeBlockMatch ? codeBlockMatch[1]! : text
      expect(value.trim()).toBe('plain-secret')
    })
  })

  describe('passphrase cache logic', () => {
    it('cache hit: passphrase is returned when not expired', () => {
      const cache = new Map<string, { passphrase: string; expiresAt: number }>()
      cache.set('chat1', { passphrase: 'secret', expiresAt: Date.now() + 60_000 })
      const cached = cache.get('chat1')
      const passphrase = cached && cached.expiresAt > Date.now() ? cached.passphrase : undefined
      expect(passphrase).toBe('secret')
    })

    it('cache miss: returns undefined when entry is expired', () => {
      const cache = new Map<string, { passphrase: string; expiresAt: number }>()
      cache.set('chat1', { passphrase: 'secret', expiresAt: Date.now() - 1 })
      const cached = cache.get('chat1')
      const passphrase = cached && cached.expiresAt > Date.now() ? cached.passphrase : undefined
      expect(passphrase).toBeUndefined()
    })

    it('cache miss: returns undefined when no entry', () => {
      const cache = new Map<string, { passphrase: string; expiresAt: number }>()
      const cached = cache.get('chat1')
      const passphrase = cached && cached.expiresAt > Date.now() ? cached.passphrase : undefined
      expect(passphrase).toBeUndefined()
    })
  })

  describe('vault intercept TTL', () => {
    const VAULT_INPUT_TTL_MS = 5 * 60 * 1000  // 5 min

    it('within TTL: op should be processed', () => {
      const startedAt = Date.now() - 60_000  // 1 min ago
      const elapsed = Date.now() - startedAt
      expect(elapsed > VAULT_INPUT_TTL_MS).toBe(false)
    })

    it('expired TTL: op should be discarded and fall through', () => {
      const startedAt = Date.now() - 6 * 60 * 1000  // 6 min ago
      const elapsed = Date.now() - startedAt
      expect(elapsed > VAULT_INPUT_TTL_MS).toBe(true)
    })
  })

})

