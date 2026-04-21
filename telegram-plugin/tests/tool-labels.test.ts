import { describe, it, expect } from 'vitest'
import { toolLabel } from '../tool-labels.js'

describe('toolLabel', () => {
  it('Read: uses basename of file_path', () => {
    expect(toolLabel('Read', { file_path: '/home/ken/code/switchroom/src/foo.ts' })).toBe('foo.ts')
    expect(toolLabel('Read', { file_path: '/home/ken/.claude/settings.json' })).toBe(
      'settings.json',
    )
  })

  it('Read: basename for deeply nested paths', () => {
    expect(toolLabel('Read', { file_path: '/opt/project/a/b/c/file.ts' })).toBe('file.ts')
  })

  it('Write / Edit / NotebookEdit use file_path basename', () => {
    expect(toolLabel('Write', { file_path: '/x/switchroom/new.ts' })).toBe('new.ts')
    expect(toolLabel('Edit', { file_path: '/x/switchroom/existing.ts' })).toBe('existing.ts')
    expect(toolLabel('NotebookEdit', { file_path: '/x/switchroom/nb.ipynb' })).toBe('nb.ipynb')
  })

  it('Bash: shows first line of command', () => {
    expect(toolLabel('Bash', { command: 'git status' })).toBe('git status')
    expect(toolLabel('Bash', { command: 'git log\n--oneline' })).toBe('git log')
  })

  it('Bash: truncates commands at ~40 chars', () => {
    const cmd = 'a'.repeat(100)
    const out = toolLabel('Bash', { command: cmd })
    expect(out.length).toBeLessThanOrEqual(40)
    expect(out).toMatch(/…$/)
  })

  it('Bash: prefers description over raw command when present', () => {
    expect(
      toolLabel('Bash', {
        command: 'find /home -name "*.tmp" -mtime +30 -exec rm {} \\;',
        description: 'Delete old temp files',
      }),
    ).toBe('Delete old temp files')
  })

  it('Bash: description gets a higher cap than raw command', () => {
    const longDesc = 'Run the migration script and verify schema integrity across all shards'
    expect(toolLabel('Bash', { command: 'x', description: longDesc })).toBe(longDesc)
  })

  it('Grep: quotes pattern and shows "(in <path>)" always', () => {
    // No path given → "(in repo)"
    expect(toolLabel('Grep', { pattern: 'TODO' })).toBe('"TODO" (in repo)')
    // Directory path → shows dir with trailing slash
    expect(toolLabel('Grep', { pattern: 'switchroom vault', path: 'src' })).toBe(
      '"switchroom vault" (in src/)',
    )
    // File path → basename
    expect(toolLabel('Grep', { pattern: 'x', path: '/home/ken/switchroom/src/foo.ts' })).toBe(
      '"x" (in foo.ts)',
    )
  })

  it('Glob: shows pattern', () => {
    expect(toolLabel('Glob', { pattern: '**/*.ts' })).toBe('**/*.ts')
  })

  it('WebFetch: extracts host from URL', () => {
    expect(toolLabel('WebFetch', { url: 'https://example.com/path' })).toBe('example.com')
    expect(toolLabel('WebFetch', { url: 'not a url' })).toBe('not a url')
  })

  it('WebSearch: quotes the query', () => {
    expect(toolLabel('WebSearch', { query: 'claude code 2026' })).toBe('"claude code 2026"')
  })

  it('Task / Agent: show description (or subagent_type fallback)', () => {
    expect(toolLabel('Task', { description: 'Research bug', subagent_type: 'general-purpose' }))
      .toBe('Research bug')
    expect(toolLabel('Agent', { subagent_type: 'Explore' })).toBe('Explore')
  })

  it('Todo* and Task* housekeeping tools return empty (name alone is enough)', () => {
    expect(toolLabel('TodoWrite', { todos: [] })).toBe('')
    expect(toolLabel('TaskCreate', { description: 'x' })).toBe('')
  })

  it('unknown tools try common keys', () => {
    expect(toolLabel('MyTool', { file_path: '/x/switchroom/foo.ts' })).toBe('foo.ts')
    expect(toolLabel('MyTool', { url: 'https://a.b' })).toBe('a.b')
    expect(toolLabel('MyTool', { command: 'ls\nmore' })).toBe('ls')
    expect(toolLabel('MyTool', {})).toBe('')
  })

  it('no input / undefined → empty string', () => {
    expect(toolLabel('Read')).toBe('')
    expect(toolLabel('Bash', undefined)).toBe('')
  })

  it('survives hostile inputs', () => {
    expect(toolLabel('Read', { file_path: '' })).toBe('')
    expect(toolLabel('Read', { file_path: 42 as unknown as string })).toBe('')
  })

  describe('preamble pairing (file/search tools)', () => {
    it('Read: preamble wins over filename fallback when short single-line', () => {
      expect(
        toolLabel(
          'Read',
          { file_path: '/x/switchroom/foo.ts' },
          'Checking the progress card reducer',
        ),
      ).toBe('Checking the progress card reducer')
    })

    it('Read: no preamble → basename fallback preserved', () => {
      expect(toolLabel('Read', { file_path: '/x/switchroom/foo.ts' })).toBe('foo.ts')
      expect(toolLabel('Read', { file_path: '/x/switchroom/foo.ts' }, undefined)).toBe('foo.ts')
      expect(toolLabel('Read', { file_path: '/x/switchroom/foo.ts' }, '')).toBe('foo.ts')
    })

    it('Read: multi-line preamble is a narrative, not a label → basename fallback', () => {
      expect(
        toolLabel(
          'Read',
          { file_path: '/x/switchroom/foo.ts' },
          "Here's my plan:\n1. check the file\n2. fix the bug",
        ),
      ).toBe('foo.ts')
    })

    it('Read: preamble over 160 chars falls back to basename', () => {
      const long = 'a'.repeat(161)
      expect(toolLabel('Read', { file_path: '/x/switchroom/foo.ts' }, long)).toBe('foo.ts')
      // exactly 160 chars still counts as preamble
      const atCap = 'b'.repeat(160)
      expect(toolLabel('Read', { file_path: '/x/switchroom/foo.ts' }, atCap)).toBe(atCap)
    })

    it('Read: whitespace-only preamble falls back to basename', () => {
      expect(toolLabel('Read', { file_path: '/x/switchroom/foo.ts' }, '   ')).toBe('foo.ts')
    })

    it('Write / Edit / Grep / Glob all prefer preamble', () => {
      expect(
        toolLabel('Write', { file_path: '/x/new.ts' }, 'Creating the new helper'),
      ).toBe('Creating the new helper')
      expect(
        toolLabel('Edit', { file_path: '/x/existing.ts' }, 'Patching the reducer'),
      ).toBe('Patching the reducer')
      expect(
        toolLabel('Grep', { pattern: 'TODO' }, 'Searching for leftover TODOs'),
      ).toBe('Searching for leftover TODOs')
      expect(
        toolLabel('Glob', { pattern: '**/*.ts' }, 'Listing all TypeScript sources'),
      ).toBe('Listing all TypeScript sources')
    })

    it('Bash / Task / Agent ignore preamble (they already use input.description)', () => {
      expect(
        toolLabel(
          'Bash',
          { command: 'git status', description: 'Check git status' },
          'Running git status real quick',
        ),
      ).toBe('Check git status')
      expect(
        toolLabel('Task', { description: 'Research bug' }, 'Kicking off the research agent'),
      ).toBe('Research bug')
      expect(
        toolLabel('Agent', { subagent_type: 'Explore' }, 'Spawning an explorer'),
      ).toBe('Explore')
    })
  })
})
