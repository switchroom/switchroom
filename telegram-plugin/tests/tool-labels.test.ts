import { describe, it, expect } from 'vitest'
import { toolLabel } from '../tool-labels.js'

describe('toolLabel', () => {
  it('Read: uses basename of file_path', () => {
    expect(toolLabel('Read', { file_path: '/home/ken/code/clerk/src/foo.ts' })).toBe('foo.ts')
    expect(toolLabel('Read', { file_path: '/home/ken/.claude/settings.json' })).toBe(
      'settings.json',
    )
  })

  it('Read: basename for deeply nested paths', () => {
    expect(toolLabel('Read', { file_path: '/opt/project/a/b/c/file.ts' })).toBe('file.ts')
  })

  it('Write / Edit / NotebookEdit use file_path basename', () => {
    expect(toolLabel('Write', { file_path: '/x/clerk/new.ts' })).toBe('new.ts')
    expect(toolLabel('Edit', { file_path: '/x/clerk/existing.ts' })).toBe('existing.ts')
    expect(toolLabel('NotebookEdit', { file_path: '/x/clerk/nb.ipynb' })).toBe('nb.ipynb')
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

  it('Grep: quotes pattern and shows "(in <path>)" always', () => {
    // No path given → "(in repo)"
    expect(toolLabel('Grep', { pattern: 'TODO' })).toBe('"TODO" (in repo)')
    // Directory path → shows dir with trailing slash
    expect(toolLabel('Grep', { pattern: 'clerk vault', path: 'src' })).toBe(
      '"clerk vault" (in src/)',
    )
    // File path → basename
    expect(toolLabel('Grep', { pattern: 'x', path: '/home/ken/clerk/src/foo.ts' })).toBe(
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
    expect(toolLabel('MyTool', { file_path: '/x/clerk/foo.ts' })).toBe('foo.ts')
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
})
