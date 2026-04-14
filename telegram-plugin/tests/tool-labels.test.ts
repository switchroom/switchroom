import { describe, it, expect } from 'vitest'
import { toolLabel } from '../tool-labels.js'

describe('toolLabel', () => {
  it('Read: shortens file paths to project-relative', () => {
    expect(toolLabel('Read', { file_path: '/home/ken/code/clerk/src/foo.ts' })).toBe(
      'clerk/src/foo.ts',
    )
    expect(toolLabel('Read', { file_path: '/home/ken/.claude/settings.json' })).toBe(
      '.claude/settings.json',
    )
  })

  it('Read: falls back to last two segments for unfamiliar paths', () => {
    expect(toolLabel('Read', { file_path: '/opt/project/a/b/c/file.ts' })).toBe('c/file.ts')
  })

  it('Write / Edit / NotebookEdit use file_path', () => {
    expect(toolLabel('Write', { file_path: '/x/clerk/new.ts' })).toBe('clerk/new.ts')
    expect(toolLabel('Edit', { file_path: '/x/clerk/existing.ts' })).toBe('clerk/existing.ts')
    expect(toolLabel('NotebookEdit', { file_path: '/x/clerk/nb.ipynb' })).toBe('clerk/nb.ipynb')
  })

  it('Bash: shows first line of command', () => {
    expect(toolLabel('Bash', { command: 'git status' })).toBe('git status')
    expect(toolLabel('Bash', { command: 'git log\n--oneline' })).toBe('git log')
  })

  it('Bash: truncates long commands', () => {
    const cmd = 'a'.repeat(100)
    const out = toolLabel('Bash', { command: cmd })
    expect(out.length).toBeLessThanOrEqual(60)
    expect(out).toMatch(/…$/)
  })

  it('Grep: quotes pattern and shows path when present', () => {
    expect(toolLabel('Grep', { pattern: 'TODO' })).toBe('"TODO"')
    expect(toolLabel('Grep', { pattern: 'TODO', path: '/home/ken/clerk/src' })).toBe(
      '"TODO" in clerk/src',
    )
  })

  it('Glob: shows pattern', () => {
    expect(toolLabel('Glob', { pattern: '**/*.ts' })).toBe('**/*.ts')
  })

  it('WebFetch / WebSearch: show url / query', () => {
    expect(toolLabel('WebFetch', { url: 'https://example.com/path' })).toBe(
      'https://example.com/path',
    )
    expect(toolLabel('WebSearch', { query: 'claude code 2026' })).toBe('claude code 2026')
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
    expect(toolLabel('MyTool', { file_path: '/x/clerk/foo.ts' })).toBe('clerk/foo.ts')
    expect(toolLabel('MyTool', { url: 'https://a.b' })).toBe('https://a.b')
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
