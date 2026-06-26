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
import { resolveScopedAllowChoices } from '../permission-rule.js'

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
  test('renders "<Agent> wants to <action>" + why line (why = caller reason)', () => {
    const body = formatPermissionCardBody({
      toolName: 'Edit',
      inputPreview: JSON.stringify({ file_path: '/work/supplement-log.md', reason: 'logging today\'s lifts' }),
      description: 'Edit a file on disk.',
      agentName: 'gymbro',
    })
    expect(body).toBe(
      ['🔐 <b>Gymbro</b> wants to edit: supplement-log.md', 'why: <i>logging today\'s lifts</i>'].join('\n'),
    )
  })

  // #2469: the `why:` line is the CALLER's reason, never the tool's static
  // schema description (which can contain literal $SWITCHROOM_* tokens).
  test('why is the caller-supplied reason, NOT the schema description (#2469)', () => {
    const body = formatPermissionCardBody({
      toolName: 'mcp__hostd__agent_restart',
      inputPreview: JSON.stringify({ name: 'carrie', reason: 'gateway is wedged, bouncing it' }),
      description: 'Restart an agent via the host-control daemon. cross-agent (`name` ≠ $SWITCHROOM_AGENT_NAME) …',
      agentName: 'carrie',
    })
    expect(body).toContain('why: <i>gateway is wedged, bouncing it</i>')
    expect(body).not.toContain('$SWITCHROOM_AGENT_NAME')
    expect(body).not.toContain('host-control daemon')
  })

  test('why accepts a `why` arg as well as `reason`', () => {
    const body = formatPermissionCardBody({
      toolName: 'Bash',
      inputPreview: JSON.stringify({ command: 'ls /tmp', why: 'listing temp files' }),
      description: 'Run a shell command.',
      agentName: 'gymbro',
    })
    expect(body).toContain('why: <i>listing temp files</i>')
  })

  test('shows "not provided" when no caller reason is present (never the description)', () => {
    const body = formatPermissionCardBody({
      toolName: 'Bash',
      inputPreview: JSON.stringify({ command: 'ls /tmp' }),
      description: 'Run a shell command on the host.',
      agentName: 'gymbro',
    })
    expect(body).toContain('why: <i>not provided</i>')
    expect(body).not.toContain('Run a shell command')
  })

  test('shows "not provided" when caller reason is whitespace only', () => {
    const body = formatPermissionCardBody({
      toolName: 'Bash',
      inputPreview: JSON.stringify({ command: 'ls /tmp', reason: '   \n ' }),
      description: 'Run a shell command.',
      agentName: 'gymbro',
    })
    expect(body).toContain('why: <i>not provided</i>')
  })

  test('drops the agent prefix when agentName is null (early-boot edge)', () => {
    const body = formatPermissionCardBody({
      toolName: 'Skill',
      inputPreview: JSON.stringify({ skill: 'mail', reason: 'do the thing' }),
      description: 'Use a skill.',
      agentName: null,
    })
    expect(body).toBe(['🔐 Use the mail skill', 'why: <i>do the thing</i>'].join('\n'))
  })

  test('HTML-escapes <, >, & in agentName / action / reason', () => {
    const body = formatPermissionCardBody({
      toolName: 'Bash',
      inputPreview: JSON.stringify({ command: 'echo "a < b && c > d"', reason: 'compare a < b & c > d' }),
      description: 'Run a shell command.',
      agentName: 'agent<test>',
    })
    expect(body).toContain('&lt;test&gt;')
    expect(body).toContain('&amp;')
    expect(body).not.toContain('<test>')
    expect(body).toContain('<b>')
    expect(body).toContain('<i>')
  })

  test('truncates a very long caller reason with an ellipsis', () => {
    const body = formatPermissionCardBody({
      toolName: 'Skill',
      inputPreview: JSON.stringify({ skill: 'mail', reason: 'x'.repeat(500) }),
      description: 'Use a skill.',
      agentName: 'clerk',
    })
    expect(body).toContain('xxxx…</i>')
    expect(body.split('\n')[0]).toBe('🔐 <b>Clerk</b> wants to use the mail skill')
  })

  test('collapses internal whitespace in the caller reason', () => {
    const body = formatPermissionCardBody({
      toolName: 'Skill',
      inputPreview: JSON.stringify({ skill: 'mail', reason: 'first\n\nsecond\t\t paragraph' }),
      description: 'Use a skill.',
      agentName: 'clerk',
    })
    expect(body).toContain('why: <i>first second paragraph</i>')
  })

  // config-edit-hardening: upstream Claude Code truncates `inputPreview`
  // to ~200 chars. For config_propose_edit the (NEW-ordered) reason lands
  // inside the surviving prefix, but the truncated JSON is unparseable —
  // the lenient `extractReasonFromRaw` regex fallback must still recover it
  // so the card no longer renders "why: not provided".
  test('recovers reason from a >200-char truncated config_propose_edit input', () => {
    // reason FIRST (the reordered schema), then a huge unified_diff that
    // gets cut by the 200-char truncation → invalid JSON, no closing brace.
    const reason = 'widen klanker tools.allow for the new skill'
    const fullDiff =
      '--- a/switchroom.yaml\n+++ b/switchroom.yaml\n' +
      Array.from({ length: 40 }, (_, i) => `+    - "Bash(tool-${i}:*)"`).join('\n')
    const full = JSON.stringify({
      reason,
      target_path: '/state/config/switchroom.yaml',
      unified_diff: fullDiff,
    })
    const truncated = full.slice(0, 200) // mirror the upstream cut
    expect(() => JSON.parse(truncated)).toThrow() // precondition: unparseable
    const body = formatPermissionCardBody({
      toolName: 'config_propose_edit',
      inputPreview: truncated,
      description: 'Propose a unified-diff patch against switchroom.yaml.',
      agentName: 'klanker',
    })
    expect(body).toContain(`why: <i>${reason}</i>`)
    expect(body).not.toContain('not provided')
  })

  test('recovers reason even when unified_diff precedes it (legacy order)', () => {
    // Even with the OLD key order (diff first), the regex finds reason if it
    // survives the cut — proving the fallback is order-independent.
    const reason = 'self-scope allow rule add'
    const raw =
      '{"unified_diff":"--- a/x\\n+++ b/x\\n+ small","reason":"' + reason + '"}'
    const body = formatPermissionCardBody({
      toolName: 'config_propose_edit',
      inputPreview: raw,
      description: 'desc',
      agentName: 'klanker',
    })
    expect(body).toContain(`why: <i>${reason}</i>`)
  })

  // #2469: hostd agent_* cards must name WHICH agent is targeted, pulled
  // from the `name` input arg — not the static curated phrase.
  test('hostd agent_restart names the target agent in the title (#2469)', () => {
    const body = formatPermissionCardBody({
      toolName: 'mcp__hostd__agent_restart',
      inputPreview: JSON.stringify({ name: 'carrie', reason: 'wedged' }),
      description: 'Restart an agent via the host-control daemon. $SWITCHROOM_AGENT_NAME …',
      agentName: 'klanker',
    })
    expect(body.split('\n')[0]).toBe('🔐 <b>Klanker</b> wants to restart agent `carrie` in the fleet')
  })

  test('hostd start/stop/logs/exec each name the target agent (#2469)', () => {
    const mk = (tool: string) =>
      formatPermissionCardBody({
        toolName: tool,
        inputPreview: JSON.stringify({ name: 'pixel' }),
        description: 'static schema doc',
        agentName: 'klanker',
      }).split('\n')[0]
    expect(mk('mcp__hostd__agent_start')).toBe('🔐 <b>Klanker</b> wants to start agent `pixel` in the fleet')
    expect(mk('mcp__hostd__agent_stop')).toBe('🔐 <b>Klanker</b> wants to stop agent `pixel` in the fleet')
    expect(mk('mcp__hostd__agent_logs')).toBe("🔐 <b>Klanker</b> wants to read agent `pixel`'s container logs")
    expect(mk('mcp__hostd__agent_exec')).toBe('🔐 <b>Klanker</b> wants to run a read-only inspection inside agent `pixel`')
  })

  test('hostd agent verb without a name arg falls back to the generic phrase (no crash) (#2469)', () => {
    const body = formatPermissionCardBody({
      toolName: 'mcp__hostd__agent_restart',
      inputPreview: JSON.stringify({ reason: 'bouncing the fleet' }),
      description: 'static schema doc',
      agentName: 'klanker',
    })
    expect(body.split('\n')[0]).toBe('🔐 <b>Klanker</b> wants to restart an agent in the fleet')
    expect(body).toContain('why: <i>bouncing the fleet</i>')
  })

  test('non-name-arg gated verb (update_apply) stays generic and does not break (#2469)', () => {
    const body = formatPermissionCardBody({
      toolName: 'mcp__hostd__update_apply',
      inputPreview: JSON.stringify({ reason: 'rolling out v0.16' }),
      description: 'static schema doc',
      agentName: 'klanker',
    })
    expect(body.split('\n')[0]).toBe('🔐 <b>Klanker</b> wants to apply a fleet-wide update (pull + recreate)')
    expect(body).toContain('why: <i>rolling out v0.16</i>')
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
        reason: 'sending the priority-access invite',
        body: { subject: 'Priority access', templateId: 12, to: [{ email: 'lisa@example.com' }] },
      }),
      description: 'HIGH RISK: write to the brevo API (POST).',
      agentName: 'marko',
    })
    const lines = body.split('\n')
    expect(lines[0]).toBe('🔐 <b>Marko</b> wants to POST /smtp/email (Brevo)')
    expect(lines[1]).toBe('why: <i>sending the priority-access invite</i>')
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

describe('truncated inputPreview recovery — Edit/Write file_path extraction', () => {
  /**
   * Claude Code produces `input_preview = JSON.stringify(displayInput).slice(0, 200)`.
   * For Edit/Write the serialised form is:
   *   {"file_path":"...","old_string":"<hundreds of chars>","new_string":"..."}
   * which almost always exceeds 200 chars, leaving invalid (truncated) JSON.
   * "file_path" is the first key so its value is intact within 200 chars.
   * The lenient regex fallback must recover it so cards read "edit: module.ts"
   * instead of the generic "edit files".
   */
  function truncatedPreview(filePath: string): string {
    const full = JSON.stringify({
      file_path: filePath,
      old_string:
        'function oldFn() {\n  // many lines of old code that push the JSON way past 200 chars\n  const x = doSomething();\n  return x;\n}',
      new_string: 'function newFn() { return doSomethingElse(); }',
    })
    return full.slice(0, 200)
  }

  test('naturalAction recovers file basename from truncated Edit inputPreview', () => {
    const filePath = '/home/user/project/src/some/long/module.ts'
    const preview = truncatedPreview(filePath)

    // The truncated preview must be invalid JSON (precondition of the bug).
    expect(() => JSON.parse(preview)).toThrow()

    // After fix: basename is recovered via regex fallback.
    expect(naturalAction('Edit', preview)).toBe('edit: module.ts')
  })

  test('naturalAction recovers file basename from truncated Write inputPreview', () => {
    const filePath = '/home/user/project/src/config/settings.json'
    const full = JSON.stringify({
      file_path: filePath,
      content: 'x'.repeat(300),
    })
    const preview = full.slice(0, 200)
    expect(() => JSON.parse(preview)).toThrow()
    expect(naturalAction('Write', preview)).toBe('write: settings.json')
  })

  test('resolveScopedAllowChoices includes a per-file "This file" choice for truncated Edit inputPreview', () => {
    const filePath = '/home/user/project/src/some/long/module.ts'
    const preview = truncatedPreview(filePath)

    // The truncated preview must be invalid JSON (precondition of the bug).
    expect(() => JSON.parse(preview)).toThrow()

    const choices = resolveScopedAllowChoices('Edit', preview)
    expect(choices).not.toBeNull()
    // After fix: specific "This file" choice present with the full path.
    expect(choices!.specific).toBeDefined()
    expect(choices!.specific!.buttonLabel).toBe('This file')
    expect(choices!.specific!.rule).toBe(`Edit(${filePath})`)
    // Broad option also present.
    expect(choices!.broad.buttonLabel).toBe('Any file')
  })
})
