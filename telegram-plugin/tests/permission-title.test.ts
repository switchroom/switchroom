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

  // Clarity fix: REST-wrapper MCP tools (brevo/meta/postiz via rest-server.mjs)
  // take a `path` — surface it so "post (Brevo)" becomes "POST /smtp/email
  // (Brevo)" and the operator can see WHICH endpoint is being written.
  test('REST-wrapper write names the endpoint with an uppercased HTTP verb', () => {
    expect(
      naturalAction('mcp__brevo__post', JSON.stringify({ path: '/smtp/email', body: { to: 'x' } })),
    ).toBe('POST /smtp/email (Brevo)')
    expect(
      naturalAction('mcp__brevo__put', JSON.stringify({ path: '/contacts/123', body: {} })),
    ).toBe('PUT /contacts/123 (Brevo)')
  })

  test('REST-wrapper read surfaces the path too', () => {
    expect(
      naturalAction('mcp__brevo__get', JSON.stringify({ path: '/contacts', query: { limit: 10 } })),
    ).toBe('GET /contacts (Brevo)')
  })

  test('falls back to the plain verb phrase when there is no resource key', () => {
    // No path → today's behavior, unchanged (defensive for unknown shapes).
    expect(naturalAction('mcp__brevo__post', undefined)).toBe('post (Brevo)')
    expect(naturalAction('mcp__brevo__post', JSON.stringify({ foo: 1 }))).toBe('post (Brevo)')
  })

  test('internal REST-ish tool is NOT endpoint-enriched (stays a bare verb)', () => {
    // hostd is internal → no "(Server)" tag, no path enrichment.
    expect(naturalAction('mcp__hostd__do_thing', JSON.stringify({ path: '/x' }))).toBe('do thing')
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

  // Clarity fix: the card gains a third "↳" line summarizing the REST
  // payload so the operator can see WHAT is being written, not just the
  // endpoint. Values are redaction-passed + truncated; nested objects show
  // as a bare key name.
  test('REST write card: endpoint in the title + a payload summary line', () => {
    const body = formatPermissionCardBody({
      toolName: 'mcp__brevo__post',
      inputPreview: JSON.stringify({
        path: '/smtp/email',
        body: { subject: 'Priority access', templateId: 12, to: [{ email: 'lisa@example.com' }] },
      }),
      description: 'HIGH RISK: write to the brevo API (POST).',
      agentName: 'marko',
    })
    const lines = body.split('\n')
    expect(lines[0]).toBe('🔐 <b>Marko</b> wants to POST /smtp/email (Brevo)')
    expect(lines[1]).toBe('why: <i>HIGH RISK: write to the brevo API (POST).</i>')
    // Third line: scalar keys show value; the nested `to` array shows key-only.
    expect(lines[2]).toContain('↳')
    expect(lines[2]).toContain('subject: Priority access')
    expect(lines[2]).toContain('templateId: 12')
    expect(lines[2]).toContain('to') // key-only, not the email object dumped
    expect(lines[2]).not.toContain('lisa@example.com')
  })

  test('no payload → no third line (DM / non-REST cards unchanged)', () => {
    const body = formatPermissionCardBody({
      toolName: 'Edit',
      inputPreview: JSON.stringify({ file_path: '/a/b.md' }),
      description: 'edit it',
      agentName: 'clerk',
    })
    expect(body.split('\n')).toHaveLength(2)
    expect(body).not.toContain('↳')
  })

  test('redaction is load-bearing: a token in the payload is masked, never shown', () => {
    // Build the fake token at runtime so the source file never holds a
    // contiguous token literal (repo push-protection rule).
    const fakeToken = 'sk-ant-' + 'api03-' + 'A'.repeat(48)
    const body = formatPermissionCardBody({
      toolName: 'mcp__brevo__post',
      inputPreview: JSON.stringify({ path: '/contacts', body: { apiKey: fakeToken, name: 'Lisa' } }),
      description: 'create a contact',
      agentName: 'marko',
    })
    expect(body).not.toContain(fakeToken)
    expect(body).toContain('name: Lisa') // benign value still surfaces
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
