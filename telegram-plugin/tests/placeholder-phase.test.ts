import { describe, expect, it } from 'vitest'

import {
  PHASES,
  toolUseToPhase,
  isReadOnlyBashCommand,
  recallTextToPhase,
  type PhaseKind,
} from '../placeholder-phase.js'

describe('PHASES — canonical labels', () => {
  it('exposes all 8 phases from the design doc', () => {
    const expected: PhaseKind[] = [
      'acknowledged',
      'recalling',
      'thinking',
      'looking_up',
      'checking',
      'working',
      'asking_specialist',
      'writing_reply',
    ]
    expect(Object.keys(PHASES).sort()).toEqual(expected.sort())
  })

  it('every label starts with an emoji (visual cue) and contains no technical jargon', () => {
    const technicalWords = [
      'grep', 'CLAUDE.md', 'bash', 'Edit(',
      'Read(', 'Task(', 'Agent(', 'Bash(',
      'subagent_type', 'JSONL', 'API',
      'mcp__', 'sendMessage', 'tool_use',
    ]
    for (const phase of Object.values(PHASES)) {
      // Has a leading emoji-ish character (any non-ASCII letter)
      expect(phase.label).toMatch(/^[^\x00-\x7F]/)
      // No technical leakage
      for (const tech of technicalWords) {
        expect(phase.label).not.toContain(tech)
      }
    }
  })

  it('labels are short enough for Telegram + room for elapsed suffix', () => {
    // Composed text is `${label} · ${elapsed}` — Telegram caps at
    // 4096 chars but the placeholder should be much shorter for UX.
    // Pin a soft cap so labels stay scannable.
    for (const phase of Object.values(PHASES)) {
      expect(phase.label.length).toBeLessThan(80)
    }
  })

  it('every kind matches its key', () => {
    for (const [key, phase] of Object.entries(PHASES)) {
      expect(phase.kind).toBe(key)
    }
  })
})

describe('toolUseToPhase — built-in tool mapping', () => {
  describe('looking_up phase', () => {
    it('Read → looking_up', () => {
      expect(toolUseToPhase('Read')?.kind).toBe('looking_up')
    })
    it('Grep → looking_up', () => {
      expect(toolUseToPhase('Grep')?.kind).toBe('looking_up')
    })
    it('Glob → looking_up', () => {
      expect(toolUseToPhase('Glob')?.kind).toBe('looking_up')
    })
    it('WebFetch → looking_up', () => {
      expect(toolUseToPhase('WebFetch')?.kind).toBe('looking_up')
    })
    it('WebSearch → looking_up', () => {
      expect(toolUseToPhase('WebSearch')?.kind).toBe('looking_up')
    })
  })

  describe('working phase', () => {
    it('Edit → working', () => {
      expect(toolUseToPhase('Edit')?.kind).toBe('working')
    })
    it('Write → working', () => {
      expect(toolUseToPhase('Write')?.kind).toBe('working')
    })
    it('NotebookEdit → working', () => {
      expect(toolUseToPhase('NotebookEdit')?.kind).toBe('working')
    })
  })

  describe('asking_specialist phase', () => {
    it('Task → asking_specialist', () => {
      expect(toolUseToPhase('Task')?.kind).toBe('asking_specialist')
    })
    it('Agent → asking_specialist', () => {
      expect(toolUseToPhase('Agent')?.kind).toBe('asking_specialist')
    })
  })

  describe('writing_reply phase', () => {
    it('reply → writing_reply', () => {
      expect(toolUseToPhase('reply')?.kind).toBe('writing_reply')
    })
    it('stream_reply → writing_reply', () => {
      expect(toolUseToPhase('stream_reply')?.kind).toBe('writing_reply')
    })
  })

  describe('no_change tools', () => {
    it.each([
      'react', 'send_typing', 'edit_message', 'delete_message',
      'forward_message', 'pin_message', 'download_attachment',
      'get_recent_messages', 'TodoWrite', 'AskUserQuestion',
    ])('%s returns null (no phase change)', (name) => {
      expect(toolUseToPhase(name)).toBeNull()
    })
  })

  describe('unknown tools', () => {
    it('returns null for tools not in the table', () => {
      expect(toolUseToPhase('SomeRandomTool')).toBeNull()
      expect(toolUseToPhase('CompletelyMadeUp')).toBeNull()
    })
    it('returns null for empty toolName', () => {
      expect(toolUseToPhase('')).toBeNull()
    })
  })

  describe('MCP-prefixed tools', () => {
    it('strips mcp__server__ prefix and matches the unqualified name', () => {
      // `mcp__switchroom-telegram__reply` should map the same as `reply`
      expect(toolUseToPhase('mcp__switchroom-telegram__reply')?.kind)
        .toBe('writing_reply')
      expect(toolUseToPhase('mcp__hindsight__sync_retain')).toBeNull()
    })
  })
})

describe('isReadOnlyBashCommand', () => {
  describe('read-only commands → true', () => {
    it.each([
      'ls',
      'ls -la',
      'cat README.md',
      'pwd',
      'which node',
      'head -5 file.txt',
      'tail -f log',
      'echo hello',
      'git status',
      'git log --oneline -10',
      'git diff HEAD',
      'git show abc123',
      'git branch -a',
      'git remote -v',
      'git config --list',
      'wc -l *.ts',
      'env',
      'printenv PATH',
      'whoami',
      'date',
    ])('"%s" is read-only', (cmd) => {
      expect(isReadOnlyBashCommand(cmd)).toBe(true)
    })

    it('classifies pipelines starting with read-only as read-only', () => {
      expect(isReadOnlyBashCommand('ls | grep ts')).toBe(true)
      expect(isReadOnlyBashCommand('cat file.txt | head -5')).toBe(true)
    })
  })

  describe('write/destructive commands → false', () => {
    it.each([
      'rm -rf /tmp/foo',
      'cp src dst',
      'mv old new',
      'mkdir -p /foo',
      'touch newfile',
      'chmod +x script',
      'npm install',
      'bun test',
      'git push',
      'git commit -m "x"',
      'git checkout main',
      'git stash',
      'git rebase',
      'sed -i "s/foo/bar/" file',
      'tee output',
      'curl -X POST url',
    ])('"%s" is NOT read-only', (cmd) => {
      expect(isReadOnlyBashCommand(cmd)).toBe(false)
    })

    it('git stash / git push / git rebase are NOT read-only (despite git prefix)', () => {
      expect(isReadOnlyBashCommand('git stash')).toBe(false)
      expect(isReadOnlyBashCommand('git push origin main')).toBe(false)
      expect(isReadOnlyBashCommand('git rebase upstream/main')).toBe(false)
    })

    it('classifies pipelines starting with write as write', () => {
      // The whole pipeline is classified by the FIRST command —
      // imperfect (pipe-into-write is rare but would misclassify) —
      // safer to default to working.
      expect(isReadOnlyBashCommand('rm file.txt')).toBe(false)
      expect(isReadOnlyBashCommand('mv old new && echo done')).toBe(false)
    })
  })

  describe('edge cases', () => {
    it('empty command → false', () => {
      expect(isReadOnlyBashCommand('')).toBe(false)
      expect(isReadOnlyBashCommand('   ')).toBe(false)
    })

    it('only whitespace + pipe → false', () => {
      expect(isReadOnlyBashCommand(' | ')).toBe(false)
    })

    it('git with no subcommand → false (defensive)', () => {
      expect(isReadOnlyBashCommand('git')).toBe(false)
    })
  })
})

describe('toolUseToPhase — Bash branching', () => {
  it('Bash with read-only command → checking', () => {
    expect(toolUseToPhase('Bash', { command: 'ls -la' })?.kind).toBe('checking')
    expect(toolUseToPhase('Bash', { command: 'git status' })?.kind).toBe('checking')
  })

  it('Bash with destructive command → working', () => {
    expect(toolUseToPhase('Bash', { command: 'rm -rf /tmp/x' })?.kind).toBe('working')
    expect(toolUseToPhase('Bash', { command: 'npm install' })?.kind).toBe('working')
  })

  it('Bash with no command (defensive) → working', () => {
    // Missing input → assume worst case → working
    expect(toolUseToPhase('Bash')?.kind).toBe('working')
    expect(toolUseToPhase('Bash', {})?.kind).toBe('working')
  })

  it('Bash with non-string command (defensive) → working', () => {
    expect(toolUseToPhase('Bash', { command: 42 })?.kind).toBe('working')
    expect(toolUseToPhase('Bash', { command: null })?.kind).toBe('working')
  })
})

describe('recallTextToPhase — backward compat with recall.py', () => {
  it('maps current recall.py texts to phases', () => {
    expect(recallTextToPhase('📚 recalling memories')?.kind).toBe('recalling')
    expect(recallTextToPhase('💭 thinking')?.kind).toBe('thinking')
  })

  it('maps pre-#496 texts (with trailing ellipsis) too', () => {
    expect(recallTextToPhase('📚 recalling memories…')?.kind).toBe('recalling')
    expect(recallTextToPhase('💭 thinking…')?.kind).toBe('thinking')
  })

  it('returns null for unknown text (allows custom literals to pass through)', () => {
    expect(recallTextToPhase('🤖 doing something custom')).toBeNull()
    expect(recallTextToPhase('hello world')).toBeNull()
  })

  it('handles whitespace defensively', () => {
    expect(recallTextToPhase('  📚 recalling memories  ')?.kind).toBe('recalling')
  })

  it('returns null for empty / whitespace-only', () => {
    expect(recallTextToPhase('')).toBeNull()
    expect(recallTextToPhase('   ')).toBeNull()
  })
})
