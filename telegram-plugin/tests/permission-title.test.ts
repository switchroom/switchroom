import { describe, test, expect } from 'vitest'
import { summarizeToolForTitle } from '../permission-title.js'

describe('summarizeToolForTitle (#186)', () => {
  test('Skill: surfaces the skill name in brackets', () => {
    const input = JSON.stringify({ skill: 'mail' })
    expect(summarizeToolForTitle('Skill', input)).toBe('Skill (mail)')
  })

  test('Bash: truncates long commands', () => {
    const input = JSON.stringify({
      command: 'find /var/log -name "*.log" -mtime -1 -exec gzip {} \\;',
    })
    const out = summarizeToolForTitle('Bash', input)
    expect(out.startsWith('Bash: ')).toBe(true)
    expect(out.length).toBeLessThanOrEqual(60)
    expect(out.endsWith('…')).toBe(true)
  })

  test('Read/Edit/Write: shows basename only', () => {
    const input = JSON.stringify({ file_path: '/long/absolute/path/to/server.ts' })
    expect(summarizeToolForTitle('Read', input)).toBe('Read: server.ts')
    expect(summarizeToolForTitle('Edit', input)).toBe('Edit: server.ts')
    expect(summarizeToolForTitle('Write', input)).toBe('Write: server.ts')
  })

  test('Glob/Grep: surfaces the pattern', () => {
    const input = JSON.stringify({ pattern: '**/*.ts' })
    expect(summarizeToolForTitle('Glob', input)).toBe('Glob: **/*.ts')
    expect(summarizeToolForTitle('Grep', input)).toBe('Grep: **/*.ts')
  })

  test('WebFetch: surfaces the URL', () => {
    const input = JSON.stringify({ url: 'https://example.com/some/page' })
    expect(summarizeToolForTitle('WebFetch', input)).toBe(
      'WebFetch: https://example.com/some/page',
    )
  })

  test('falls back to bare toolName for unrecognised tools', () => {
    expect(summarizeToolForTitle('SomeCustomTool', JSON.stringify({ x: 1 }))).toBe(
      'SomeCustomTool',
    )
  })

  test('falls back to bare toolName when input_preview is malformed', () => {
    expect(summarizeToolForTitle('Skill', 'not-json')).toBe('Skill')
    expect(summarizeToolForTitle('Skill', '')).toBe('Skill')
    expect(summarizeToolForTitle('Skill', undefined)).toBe('Skill')
  })

  test('falls back to bare toolName when expected key is missing', () => {
    const input = JSON.stringify({ unrelated: 'x' })
    expect(summarizeToolForTitle('Skill', input)).toBe('Skill')
    expect(summarizeToolForTitle('Bash', input)).toBe('Bash')
  })

  test('Bash: collapses internal whitespace before truncating', () => {
    const input = JSON.stringify({
      command: 'echo  \t  hello\nworld',
    })
    expect(summarizeToolForTitle('Bash', input)).toBe('Bash: echo hello world')
  })

  test('NotebookEdit: prefers notebook_path when file_path absent', () => {
    const input = JSON.stringify({ notebook_path: '/work/analysis.ipynb' })
    expect(summarizeToolForTitle('NotebookEdit', input)).toBe(
      'NotebookEdit: analysis.ipynb',
    )
  })
})
