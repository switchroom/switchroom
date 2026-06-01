/**
 * Tests for the human-readable permission card text (#186, #1790, and
 * the scoped-card work). Three surfaces:
 *   - `naturalAction` — the verb-phrase after "wants to" (no tool ids).
 *   - `formatPermissionCardBody` — the collapsed-view card body.
 *   - `describeGrant` — the after-the-fact confirmation, phrased from
 *     the *scope the operator chose*.
 */

import { describe, test, expect } from 'vitest'
import {
  naturalAction,
  describeGrant,
  formatPermissionCardBody,
  formatPermissionResumeMessage,
} from '../permission-title.js'
import type { ScopeOption } from '../permission-rule.js'

const opt = (rule: string): ScopeOption => ({ rule, buttonLabel: 'x', broad: false })

describe('naturalAction — built-in tools', () => {
  test('file tools surface the basename', () => {
    const input = JSON.stringify({ file_path: '/a/b/server.ts' })
    expect(naturalAction('Edit', input)).toBe('edit: server.ts')
    expect(naturalAction('Write', input)).toBe('write: server.ts')
    expect(naturalAction('Read', input)).toBe('read: server.ts')
  })

  test('file tools fall back to a generic phrase without a path', () => {
    expect(naturalAction('Edit', undefined)).toBe('edit files')
    expect(naturalAction('Write', JSON.stringify({ x: 1 }))).toBe('write files')
  })

  test('Bash surfaces a truncated command', () => {
    const out = naturalAction('Bash', JSON.stringify({ command: 'ls /tmp' }))
    expect(out).toBe('run: ls /tmp')
  })

  test('Bash collapses whitespace and truncates long commands', () => {
    const long = naturalAction(
      'Bash',
      JSON.stringify({ command: 'find /var/log -name "*.log" -mtime -1 -exec gzip {} \\;' }),
    )
    expect(long.startsWith('run: ')).toBe(true)
    expect(long.endsWith('…')).toBe(true)
  })

  test('Skill names the skill', () => {
    expect(naturalAction('Skill', JSON.stringify({ skill: 'mail' }))).toBe('use the mail skill')
    expect(naturalAction('Skill', undefined)).toBe('use a skill')
  })

  test('search / fetch tools surface their query or url', () => {
    expect(naturalAction('Grep', JSON.stringify({ pattern: '**/*.ts' }))).toBe('search files for: **/*.ts')
    expect(naturalAction('WebSearch', JSON.stringify({ query: 'tide times' }))).toBe('search the web for: tide times')
    expect(naturalAction('WebFetch', JSON.stringify({ url: 'https://x.com' }))).toBe('fetch a web page: https://x.com')
  })

  test('agent-ish tools read as plain phrases', () => {
    expect(naturalAction('Task', undefined)).toBe('dispatch a sub-agent')
    expect(naturalAction('TodoWrite', undefined)).toBe('update its task list')
    expect(naturalAction('ExitPlanMode', undefined)).toBe('exit plan mode')
  })

  test('unknown tool falls back to "use <name>"', () => {
    expect(naturalAction('SomeCustomTool', undefined)).toBe('use SomeCustomTool')
  })
})

describe('naturalAction — MCP tools', () => {
  test('curated internal tool reads as a bare verb-phrase', () => {
    expect(naturalAction('mcp__agent-config__skill_list', undefined)).toBe(
      'list its own installed skills',
    )
  })

  test('curated external tool gets a "(Server)" tag', () => {
    expect(naturalAction('mcp__perplexity__search', undefined)).toBe('search the web (Perplexity)')
  })

  test('uncurated internal tool de-snakes the verb', () => {
    expect(naturalAction('mcp__hostd__do_thing', undefined)).toBe('do thing')
  })

  test('uncurated external tool de-snakes and tags the server', () => {
    expect(naturalAction('mcp__google-workspace__list_files', undefined)).toBe(
      'list files (Google Workspace)',
    )
  })
})

describe('formatPermissionCardBody', () => {
  test('renders "<Agent> wants to <action>" + why line', () => {
    const body = formatPermissionCardBody({
      toolName: 'Edit',
      inputPreview: JSON.stringify({ file_path: '/work/supplement-log.md' }),
      description: 'logging today\'s lifts',
      agentName: 'gymbro',
    })
    expect(body).toBe(
      ['🔐 <b>Gymbro</b> wants to edit: supplement-log.md', 'why: <i>logging today\'s lifts</i>'].join('\n'),
    )
  })

  test('shows "not provided" when description is missing or whitespace', () => {
    const body = formatPermissionCardBody({
      toolName: 'Bash',
      inputPreview: JSON.stringify({ command: 'ls /tmp' }),
      description: '   \n ',
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
    expect(body).toBe(['🔐 Use the mail skill', 'why: <i>do the thing</i>'].join('\n'))
  })

  test('HTML-escapes <, >, & in agentName / action / description', () => {
    const body = formatPermissionCardBody({
      toolName: 'Bash',
      inputPreview: JSON.stringify({ command: 'echo "a < b && c > d"' }),
      description: 'compare a < b & c > d',
      agentName: 'agent<test>',
    })
    expect(body).toContain('&lt;test&gt;')
    expect(body).toContain('&amp;')
    expect(body).not.toContain('<test>')
    expect(body).toContain('<b>')
    expect(body).toContain('<i>')
  })

  test('truncates a very long description with an ellipsis', () => {
    const body = formatPermissionCardBody({
      toolName: 'Skill',
      inputPreview: JSON.stringify({ skill: 'mail' }),
      description: 'x'.repeat(500),
      agentName: 'clerk',
    })
    expect(body).toContain('xxxx…</i>')
    expect(body.split('\n')[0]).toBe('🔐 <b>Clerk</b> wants to use the mail skill')
  })

  test('collapses internal whitespace in the description', () => {
    const body = formatPermissionCardBody({
      toolName: 'Skill',
      inputPreview: JSON.stringify({ skill: 'mail' }),
      description: 'first\n\nsecond\t\t paragraph',
      agentName: 'clerk',
    })
    expect(body).toContain('why: <i>first second paragraph</i>')
  })
})

describe('describeGrant — phrased from the chosen scope', () => {
  test('MCP server wildcard → "use any <Server> tool"', () => {
    expect(describeGrant('mcp__perplexity__search', undefined, opt('mcp__perplexity__*'))).toBe(
      'use any Perplexity tool',
    )
  })

  test('scoped file rule → "edit <basename>"', () => {
    expect(describeGrant('Edit', undefined, opt('Edit(/work/supplement-log.md)'))).toBe(
      'edit supplement-log.md',
    )
    expect(describeGrant('Read', undefined, opt('Read(/a/b/notes.md)'))).toBe('read notes.md')
  })

  test('scoped Bash rule → "run <tok> commands"', () => {
    expect(describeGrant('Bash', undefined, opt('Bash(npm:*)'))).toBe('run npm commands')
  })

  test('scoped Skill rule → "use the <name> skill"', () => {
    expect(describeGrant('Skill', undefined, opt('Skill(mail)'))).toBe('use the mail skill')
  })

  test('bare category rules read as "any" grants', () => {
    expect(describeGrant('Edit', undefined, opt('Edit'))).toBe('edit any file')
    expect(describeGrant('Write', undefined, opt('Write'))).toBe('write any file')
    expect(describeGrant('Read', undefined, opt('Read'))).toBe('read any file')
    expect(describeGrant('Bash', undefined, opt('Bash'))).toBe('run any command')
    expect(describeGrant('Skill', undefined, opt('Skill'))).toBe('use any skill')
  })

  test('exact MCP tool grant falls back to the natural action', () => {
    expect(describeGrant('mcp__perplexity__search', undefined, opt('mcp__perplexity__search'))).toBe(
      'search the web (Perplexity)',
    )
  })
})

describe('formatPermissionResumeMessage — agent-voiced verdict ack', () => {
  test('allow names the work it is resuming', () => {
    expect(
      formatPermissionResumeMessage({
        agentName: 'gymbro',
        behavior: 'allow',
        action: 'edit: supplement-log.md',
      }),
    ).toBe('▶️ <b>Gymbro</b> — got it, continuing: <i>edit: supplement-log.md</i>')
  })

  test('deny names what it will skip, lower-cased inline', () => {
    expect(
      formatPermissionResumeMessage({
        agentName: 'ziggy',
        behavior: 'deny',
        action: 'Search the web',
      }),
    ).toBe("🚫 <b>Ziggy</b> — noted, I won't search the web. Continuing without it.")
  })

  test('TTL auto-deny variant reads as a timeout, not a tap', () => {
    expect(
      formatPermissionResumeMessage({
        agentName: 'finn',
        behavior: 'deny',
        action: 'run: deploy.sh',
        timeoutMinutes: 5,
      }),
    ).toBe('🚫 <b>Finn</b> — no answer in 5m, continuing without it (<i>run: deploy.sh</i>).')
  })

  test('HTML-escapes a hostile action phrase (no raw </>& injection)', () => {
    const out = formatPermissionResumeMessage({
      agentName: 'clerk',
      behavior: 'allow',
      action: 'run: echo <b>&"pwned"</b>',
    })
    expect(out).toContain('&lt;b&gt;&amp;')
    expect(out).not.toContain('<b>&"pwned"')
  })

  test('cap-first on the agent name', () => {
    const out = formatPermissionResumeMessage({
      agentName: 'lawgpt',
      behavior: 'allow',
      action: 'read: contract.pdf',
    })
    expect(out).toContain('<b>Lawgpt</b>')
  })

  test('empty action falls back to a generic continue (no dangling phrase)', () => {
    expect(
      formatPermissionResumeMessage({ agentName: 'carrie', behavior: 'allow', action: '' }),
    ).toBe('▶️ <b>Carrie</b> — got it, back to work.')
    expect(
      formatPermissionResumeMessage({ agentName: 'carrie', behavior: 'deny', action: '   ' }),
    ).toBe('🚫 <b>Carrie</b> — noted, continuing without it.')
  })

  test('null agent name degrades to a neutral "Agent" label', () => {
    expect(
      formatPermissionResumeMessage({ agentName: null, behavior: 'allow', action: 'edit: x.md' }),
    ).toBe('▶️ <b>Agent</b> — got it, continuing: <i>edit: x.md</i>')
  })
})
