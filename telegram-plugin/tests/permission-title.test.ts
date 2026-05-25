import { describe, test, expect } from 'vitest'
import { summarizeToolForTitle, formatPermissionCardBody } from '../permission-title.js'

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

  test('falls back to bare toolName for non-Skill tools when expected key is missing', () => {
    const input = JSON.stringify({ unrelated: 'x' })
    // Bash has no first-arg fallback (its only identifying field is command).
    expect(summarizeToolForTitle('Bash', input)).toBe('Bash')
  })

  // #1790 — the prior contract was "fall back to bare toolName when no
  // skill-name key matched"; that produced operator-hostile cards like
  // `🔐 Permission: Skill` with zero context. The Skill summarizer now
  // tries `command`, then a first-scalar-arg hint, before giving up.
  test('Skill: when no skill-name key matches, falls back to command field (#1790)', () => {
    const input = JSON.stringify({ command: 'gen calendar event' })
    expect(summarizeToolForTitle('Skill', input)).toBe('Skill: gen calendar event')
  })

  test('Skill: when no skill-name and no command, surfaces the first scalar arg (#1790)', () => {
    const input = JSON.stringify({ unrelated: 'x' })
    expect(summarizeToolForTitle('Skill', input)).toBe('Skill (unrelated: x)')
  })

  test('Skill: skips routing-only keys when surfacing first scalar arg (#1790)', () => {
    // chat_id / message_thread_id / request_id never help an operator
    // decide; the helper skips them and finds the next useful field.
    const input = JSON.stringify({
      chat_id: '12345',
      message_thread_id: '42',
      topic: 'morning summary',
    })
    expect(summarizeToolForTitle('Skill', input)).toBe('Skill (topic: morning summary)')
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

  // Skill-name fallbacks — the user reported a `🔐 Permission: Skill`
  // popup with no brackets. Pre-fix only `input.skill` was checked;
  // these tests pin the wider field set so the skill name lands in
  // brackets even when Claude Code passes the input in a different
  // shape.
  test('Skill: falls back to skill_name field', () => {
    const input = JSON.stringify({ skill_name: 'calendar' })
    expect(summarizeToolForTitle('Skill', input)).toBe('Skill (calendar)')
  })

  test('Skill: falls back to skillName field', () => {
    const input = JSON.stringify({ skillName: 'garmin' })
    expect(summarizeToolForTitle('Skill', input)).toBe('Skill (garmin)')
  })

  test('Skill: falls back to bare name field', () => {
    const input = JSON.stringify({ name: 'home-assistant' })
    expect(summarizeToolForTitle('Skill', input)).toBe('Skill (home-assistant)')
  })

  test('Skill: lifts basename out of a path field', () => {
    const input = JSON.stringify({ path: 'skills/coolify/SKILL.md' })
    expect(summarizeToolForTitle('Skill', input)).toBe('Skill (coolify)')
  })

  test('Skill: lifts basename out of a skill_path directory', () => {
    const input = JSON.stringify({ skill_path: '/x/.switchroom/skills/mail' })
    expect(summarizeToolForTitle('Skill', input)).toBe('Skill (mail)')
  })

  test('Skill: original `skill` field still wins when multiple are present', () => {
    const input = JSON.stringify({ skill: 'mail', name: 'wrong' })
    expect(summarizeToolForTitle('Skill', input)).toBe('Skill (mail)')
  })

  test('MCP curated: agent-config tools render as human verb-phrases (#1215)', () => {
    expect(summarizeToolForTitle('mcp__agent-config__skill_list', undefined)).toBe(
      'List its own installed skills',
    )
    expect(summarizeToolForTitle('mcp__agent-config__cron_list', undefined)).toBe(
      'List its own scheduled tasks',
    )
    expect(summarizeToolForTitle('mcp__agent-config__peers_list', undefined)).toBe(
      'List the other agents on this instance',
    )
  })

  test('MCP curated: hostd tools render as human verb-phrases (#1215)', () => {
    expect(summarizeToolForTitle('mcp__hostd__agent_logs', undefined)).toBe(
      "Read another agent's container logs",
    )
    expect(summarizeToolForTitle('mcp__hostd__agent_exec', undefined)).toBe(
      'Run a read-only inspection inside another agent',
    )
  })

  test('MCP fallback: unknown mcp tool renders as `<server>: <verb with spaces>`', () => {
    expect(summarizeToolForTitle('mcp__some-server__do_thing', undefined)).toBe(
      'some-server: do thing',
    )
  })

  test('MCP malformed: bare mcp__ prefix without __<server>__<verb> shape is left alone', () => {
    expect(summarizeToolForTitle('mcp__bad', undefined)).toBe('mcp__bad')
  })

  // #1790 — append a `(key: value)` hint when an MCP tool's preview
  // carries a scalar arg. Gives operators context on curated and
  // uncurated MCP tools alike without an expand tap.
  test('MCP curated tool appends first-arg hint when input_preview present (#1790)', () => {
    const input = JSON.stringify({ key: 'coolify/api-token' })
    expect(summarizeToolForTitle('mcp__agent-config__config_get', input)).toBe(
      'Read its own merged config (key: coolify/api-token)',
    )
  })

  test('MCP uncurated tool appends first-arg hint (#1790)', () => {
    const input = JSON.stringify({ folder_id: 'abc123' })
    expect(summarizeToolForTitle('mcp__google-workspace__list_files', input)).toBe(
      'google-workspace: list files (folder_id: abc123)',
    )
  })

  test('MCP arg hint skips routing-only keys (#1790)', () => {
    const input = JSON.stringify({ chat_id: '12345', query: 'budget Q3' })
    expect(summarizeToolForTitle('mcp__hindsight__recall', input)).toBe(
      'Recall relevant memories (query: budget Q3)',
    )
  })
})

// ──────────────────────────────────────────────────────────────────────
// #1790 — formatPermissionCardBody: multi-line collapsed-view body
// for approval cards. Mirrors the vault_request_access card layout.
// ──────────────────────────────────────────────────────────────────────

describe('formatPermissionCardBody (#1790)', () => {
  test('renders agent · summary, then a why-line, when both are present', () => {
    const body = formatPermissionCardBody({
      toolName: 'Skill',
      inputPreview: JSON.stringify({ skill: 'mail' }),
      description: 'Compose the morning brief',
      agentName: 'clerk',
    })
    expect(body).toBe(
      [
        '🔐 <b>clerk</b> · Skill (mail)',
        'why: <i>Compose the morning brief</i>',
      ].join('\n'),
    )
  })

  test('renders "why: <i>not provided</i>" when description is missing', () => {
    const body = formatPermissionCardBody({
      toolName: 'Bash',
      inputPreview: JSON.stringify({ command: 'ls /tmp' }),
      description: undefined,
      agentName: 'gymbro',
    })
    expect(body).toBe(
      ['🔐 <b>gymbro</b> · Bash: ls /tmp', 'why: <i>not provided</i>'].join('\n'),
    )
  })

  test('renders "not provided" when description is whitespace-only', () => {
    const body = formatPermissionCardBody({
      toolName: 'Bash',
      inputPreview: JSON.stringify({ command: 'ls /tmp' }),
      description: '   \n  ',
      agentName: 'gymbro',
    })
    expect(body).toContain('why: <i>not provided</i>')
  })

  test('drops the agent prefix when agentName is null (early-boot edge)', () => {
    const body = formatPermissionCardBody({
      toolName: 'Skill',
      inputPreview: JSON.stringify({ skill: 'mail' }),
      description: 'do the thing',
      agentName: null,
    })
    expect(body).toBe(['🔐 Skill (mail)', 'why: <i>do the thing</i>'].join('\n'))
  })

  test('HTML-escapes < > & in agentName / summary / description', () => {
    const body = formatPermissionCardBody({
      toolName: 'Bash',
      inputPreview: JSON.stringify({ command: 'echo "a < b && c > d"' }),
      description: 'compare a < b & c > d',
      agentName: 'agent<test>',
    })
    expect(body).toContain('&lt;test&gt;')
    expect(body).toContain('&amp;')
    expect(body).not.toContain('<test>')
    // The literal "<i>not provided</i>" and "<b>...</b>" wrapping tags
    // around legitimate fields must survive untouched — only the
    // user-supplied content is escaped.
    expect(body).toContain('<b>')
    expect(body).toContain('<i>')
  })

  test('truncates a very long description with an ellipsis', () => {
    const longWhy = 'x'.repeat(500)
    const body = formatPermissionCardBody({
      toolName: 'Skill',
      inputPreview: JSON.stringify({ skill: 'mail' }),
      description: longWhy,
      agentName: 'clerk',
    })
    // 240-char ceiling + trailing ellipsis
    expect(body).toContain('xxxx…</i>')
    // First line still intact
    expect(body.split('\n')[0]).toBe('🔐 <b>clerk</b> · Skill (mail)')
  })

  test('collapses internal whitespace in description so the layout stays one-line', () => {
    const body = formatPermissionCardBody({
      toolName: 'Skill',
      inputPreview: JSON.stringify({ skill: 'mail' }),
      description: 'first\n\nsecond\t\t paragraph',
      agentName: 'clerk',
    })
    expect(body).toContain('why: <i>first second paragraph</i>')
  })
})
