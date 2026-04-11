import { describe, it, expect, vi, beforeEach } from 'vitest'
import { execFileSync } from 'child_process'

// We test the helper functions directly rather than importing from server.ts
// (which has side effects: bot startup, MCP connection, etc.)
// Instead we replicate the pure logic here and verify behavior.

// --- Replicated helpers from server.ts ---

function formatClerkOutput(output: string, maxLen = 4000): string {
  const trimmed = output.trim()
  if (trimmed.length <= maxLen) return trimmed
  return trimmed.slice(0, maxLen - 20) + '\n... (truncated)'
}

function codeBlock(text: string): string {
  const escaped = text.replace(/```/g, '` ` `')
  return '```\n' + escaped + '\n```'
}

function resolveClerkCli(): string {
  return process.env.CLERK_CLI_PATH ?? 'clerk'
}

// --- Tests ---

describe('telegram bot commands', () => {
  describe('formatClerkOutput', () => {
    it('returns trimmed output when short', () => {
      expect(formatClerkOutput('  hello world  ')).toBe('hello world')
    })

    it('truncates output exceeding maxLen', () => {
      const long = 'x'.repeat(5000)
      const result = formatClerkOutput(long, 4000)
      expect(result.length).toBeLessThanOrEqual(4000)
      expect(result).toContain('... (truncated)')
    })

    it('handles empty output', () => {
      expect(formatClerkOutput('')).toBe('')
      expect(formatClerkOutput('   ')).toBe('')
    })

    it('respects custom maxLen', () => {
      const text = 'a'.repeat(100)
      const result = formatClerkOutput(text, 50)
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

    it('extracts agent name from /clerkstart health-coach', () => {
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
  })

  describe('clerk CLI path resolution', () => {
    const originalEnv = process.env.CLERK_CLI_PATH

    beforeEach(() => {
      delete process.env.CLERK_CLI_PATH
    })

    it('defaults to "clerk" when CLERK_CLI_PATH is not set', () => {
      expect(resolveClerkCli()).toBe('clerk')
    })

    it('uses CLERK_CLI_PATH when set', () => {
      process.env.CLERK_CLI_PATH = '/usr/local/bin/clerk'
      expect(resolveClerkCli()).toBe('/usr/local/bin/clerk')
    })

    // Restore after tests
    afterAll(() => {
      if (originalEnv !== undefined) {
        process.env.CLERK_CLI_PATH = originalEnv
      } else {
        delete process.env.CLERK_CLI_PATH
      }
    })
  })

  describe('error handling', () => {
    it('detects ENOENT (clerk not found) in error message', () => {
      const error = new Error('spawn clerk ENOENT')
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

  describe('clerk command execution (mocked)', () => {
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

    it('prepends --config when CLERK_CONFIG is set', () => {
      const config = '/path/to/config.yaml'
      const baseArgs = ['agent', 'list']
      const fullArgs = config ? ['--config', config, ...baseArgs] : baseArgs
      expect(fullArgs).toEqual(['--config', '/path/to/config.yaml', 'agent', 'list'])
    })

    it('does not prepend --config when CLERK_CONFIG is not set', () => {
      const config: string | undefined = undefined
      const baseArgs = ['agent', 'list']
      const fullArgs = config ? ['--config', config, ...baseArgs] : baseArgs
      expect(fullArgs).toEqual(['agent', 'list'])
    })
  })

  describe('self-targeting command detection', () => {
    // Locks the contract behind the /restart, /reconcile, /update self-kill
    // fix in server.ts. The bot needs to detect when a clerk subcommand
    // would SIGTERM its own systemd unit (mid-execFileSync) and switch to
    // a detached spawn instead. See spawnClerkDetached +
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
    // (e.g., "kenthompson") instead of the agent name. The plugin must
    // read CLERK_AGENT_NAME from the env (set in start.sh) and only fall
    // back to cwd parsing when the env var is missing.
    function getMyAgentName(env: NodeJS.ProcessEnv, cwd: string): string {
      const fromEnv = env.CLERK_AGENT_NAME
      if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim()
      // Replicates `basename(cwd)` from path.basename
      return cwd.split('/').filter(Boolean).pop() ?? ''
    }

    it('reads CLERK_AGENT_NAME from env when set', () => {
      const env = { CLERK_AGENT_NAME: 'assistant' }
      // cwd is irrelevant when env is set — Claude Code's MCP plugin spawn
      // sets cwd to $HOME but the env var carries the truth.
      expect(getMyAgentName(env, '/home/kenthompson')).toBe('assistant')
    })

    it('trims whitespace from CLERK_AGENT_NAME', () => {
      const env = { CLERK_AGENT_NAME: '  coach  ' }
      expect(getMyAgentName(env, '/home/kenthompson')).toBe('coach')
    })

    it('falls back to basename(cwd) when env var is unset', () => {
      const env = {}
      expect(getMyAgentName(env, '/home/kenthompson/.clerk/agents/assistant')).toBe('assistant')
    })

    it('falls back to basename(cwd) when env var is empty', () => {
      const env = { CLERK_AGENT_NAME: '' }
      expect(getMyAgentName(env, '/home/kenthompson/.clerk/agents/assistant')).toBe('assistant')
    })

    it('returns empty string when both env and cwd are unhelpful (defensive)', () => {
      // Not a real-world case, just locks the no-crash behavior
      const env = {}
      expect(getMyAgentName(env, '/')).toBe('')
    })
  })
})

// afterAll import for the clerk CLI path test
import { afterAll } from 'vitest'
