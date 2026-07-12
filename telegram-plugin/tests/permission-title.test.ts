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
      ['🔐 **Gymbro** wants to edit: supplement-log.md', 'why: _logging today\'s lifts_'].join('\n'),
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
    expect(body).toContain('why: _gateway is wedged, bouncing it_')
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
    expect(body).toContain('why: _listing temp files_')
  })

  // #3167: no caller reason → an honest synthesized `context:` line built
  // from the tool's salient input, NEVER a bare "why: not provided" and never
  // the static schema description. The distinct `context:` label keeps the
  // agent's omission of a rationale visible.
  test('synthesizes a context line when no caller reason is present (never "not provided" / the description)', () => {
    const body = formatPermissionCardBody({
      toolName: 'Bash',
      inputPreview: JSON.stringify({ command: 'ls /tmp' }),
      description: 'Run a shell command on the host.',
      agentName: 'gymbro',
    })
    expect(body).not.toContain('not provided')
    expect(body).not.toContain('Run a shell command')
    expect(body).toContain('context: _command: ls /tmp_')
  })

  test('synthesizes context when the caller reason is whitespace only', () => {
    const body = formatPermissionCardBody({
      toolName: 'Bash',
      inputPreview: JSON.stringify({ command: 'ls /tmp', reason: '   \n ' }),
      description: 'Run a shell command.',
      agentName: 'gymbro',
    })
    expect(body).not.toContain('not provided')
    expect(body).toContain('context: _command: ls /tmp_')
  })

  // #3167 root case: the `reply` tool (and react/edit_message/…) carries NO
  // `reason` argument, so its cards used to render a contentless
  // "🔐 Clerk wants to reply / why: not provided". Now the reply text is
  // synthesized onto a `context:` line so the operator has something to judge.
  test('reply (no reason arg) synthesizes the reply text as context, not "not provided"', () => {
    const body = formatPermissionCardBody({
      toolName: 'mcp__switchroom-telegram__reply',
      inputPreview: JSON.stringify({
        chat_id: '12345',
        text: "On it — pulling yesterday's GitHub activity now.",
        format: 'html',
        disable_notification: true,
      }),
      description: 'Reply on Telegram.',
      agentName: 'clerk',
    })
    const lines = body.split('\n')
    expect(lines[0]).toBe('🔐 **Clerk** wants to reply')
    expect(body).not.toContain('not provided')
    // Salient field surfaced (truncated); id/routing/formatting noise stripped.
    expect(body).toContain('context: _text: On it — pulling')
    expect(body).toMatch(/context: _text: On it — pulling[^_]*…_/)
    expect(body).not.toContain('chat_id')
    expect(body).not.toContain('disable_notification')
    expect(body).not.toContain('format')
  })

  test('a reason ON a reply card still renders as why:, not context: (#3167)', () => {
    const body = formatPermissionCardBody({
      toolName: 'mcp__switchroom-telegram__reply',
      inputPreview: JSON.stringify({
        chat_id: '12345',
        text: 'done',
        reason: 'answering the operator’s status question',
      }),
      description: 'Reply on Telegram.',
      agentName: 'clerk',
    })
    expect(body).toContain('why: _answering the operator’s status question_')
    expect(body).not.toContain('context:')
  })

  test('synthesized context redacts secrets in the salient input (#3167)', () => {
    const fakeToken = 'sk-ant-' + 'api03-' + 'B'.repeat(48)
    const body = formatPermissionCardBody({
      toolName: 'mcp__switchroom-telegram__reply',
      inputPreview: JSON.stringify({ chat_id: '1', text: `here is the key: ${fakeToken}` }),
      description: 'Reply on Telegram.',
      agentName: 'clerk',
    })
    expect(body).toContain('context:')
    expect(body).not.toContain(fakeToken)
  })

  test('falls back to the natural action when the input exposes nothing salient (#3167)', () => {
    const body = formatPermissionCardBody({
      toolName: 'ExitPlanMode',
      inputPreview: undefined,
      description: 'Exit plan mode.',
      agentName: 'clerk',
    })
    expect(body).not.toContain('not provided')
    expect(body).toContain('context: _exit plan mode_')
  })

  // #3167 review (HIGH/MEDIUM): the salient-value redactor must catch secrets
  // the bare-value path missed. redact() excludes generic_high_entropy and the
  // contextual kv detectors need a `key=value` shape — so a prefixless token
  // under a credential-shaped key leaked verbatim. These FAIL pre-fix.
  test('hard-masks a prefixless high-entropy value under a `token` key (#3167)', () => {
    // No sk-/ghp-/JWT prefix — shape detection alone cannot catch it; only the
    // key-name signal ("token") does.
    const bare = 'Zx8Kq2Lm9Rn4Tv6Wb1Yc3Hd5Jf7Ug0Pe'
    const body = formatPermissionCardBody({
      toolName: 'mcp__acme__do',
      inputPreview: JSON.stringify({ token: bare, note: 'ping' }),
      description: 'do a thing',
      agentName: 'clerk',
    })
    expect(body).not.toContain(bare)
    // `token` value is hard-masked; the benign `note` still surfaces.
    expect(body).toContain('token:')
    expect(body).toContain('REDACTED')
    expect(body).toContain('note: ping')
  })

  test('hard-masks a 40-hex secret under a `secret`-shaped key (#3167)', () => {
    const hex = 'a3f1'.repeat(10) // 40 hex chars, no prefix
    const body = formatPermissionCardBody({
      toolName: 'mcp__acme__do',
      inputPreview: JSON.stringify({ webhook_secret: hex }),
      description: 'do a thing',
      agentName: 'clerk',
    })
    expect(body).not.toContain(hex)
    expect(body).toContain('REDACTED')
  })

  test('masks a non-http DSN credential embedded in free text (redactUrls misses it) (#3167)', () => {
    // Under a benign key (`text`) so the hard-mask key path does NOT fire —
    // this exercises the NON_HTTP_DSN_RE scheme coverage specifically.
    const dsn = 'postgres://user:S3cretPass99@db.host:5432/app'
    const body = formatPermissionCardBody({
      toolName: 'mcp__switchroom-telegram__reply',
      inputPreview: JSON.stringify({ chat_id: '1', text: `connect via ${dsn} then run` }),
      description: 'Reply on Telegram.',
      agentName: 'clerk',
    })
    expect(body).not.toContain('S3cretPass99')
    expect(body).not.toContain(dsn)
    expect(body).toContain('REDACTED')
  })

  test('hard-masks a DATABASE_URL under a url-shaped key (#3167)', () => {
    const dsn = 'postgres://admin:hunter2pass@10.0.0.5/prod'
    const body = formatPermissionCardBody({
      toolName: 'mcp__acme__migrate',
      inputPreview: JSON.stringify({ database_url: dsn }),
      description: 'run a migration',
      agentName: 'clerk',
    })
    expect(body).not.toContain('hunter2pass')
    expect(body).not.toContain(dsn)
    expect(body).toContain('REDACTED')
  })

  // #3167 review (LOW-2): acceptance asks for "tool + summarized input +
  // originating turn" — surface a compact origin-turn reference when present.
  test('appends a compact originating-turn reference when origin_turn_id is present (#3167)', () => {
    const body = formatPermissionCardBody({
      toolName: 'mcp__switchroom-telegram__reply',
      inputPreview: JSON.stringify({ chat_id: '1', text: 'hi', origin_turn_id: 'turn-abcdef123456' }),
      description: 'Reply on Telegram.',
      agentName: 'clerk',
    })
    expect(body).toContain('· turn …ef123456')
    // The raw routing id is NOT dumped as its own kv pair.
    expect(body).not.toContain('origin_turn_id:')
  })

  // #3167 review (LOW-3): raw commands/text now reach the context line, so a
  // markdown metachar in the value must be escaped or it can spoof/break the
  // card's own `_italic_` / `code` formatting.
  test('escapes markdown metachars in the synthesized context value (#3167)', () => {
    const body = formatPermissionCardBody({
      toolName: 'Bash',
      inputPreview: JSON.stringify({ command: 'echo _a_ *b* `c`' }),
      description: 'run a shell command',
      agentName: 'clerk',
    })
    // The metachars are backslash-escaped so they can't open emphasis/code.
    expect(body).toContain('\\_a\\_')
    expect(body).toContain('\\*b\\*')
    expect(body).toContain('\\`c\\`')
    expect(body).not.toContain('echo _a_ *b* `c`')
  })

  test('drops the agent prefix when agentName is null (early-boot edge)', () => {
    const body = formatPermissionCardBody({
      toolName: 'Skill',
      inputPreview: JSON.stringify({ skill: 'mail', reason: 'do the thing' }),
      description: 'Use a skill.',
      agentName: null,
    })
    expect(body).toBe(['🔐 Use the mail skill', 'why: _do the thing_'].join('\n'))
  })

  test('markdown-escapes emphasis specials in agentName / action / reason; passes < > & through (#2669)', () => {
    const body = formatPermissionCardBody({
      toolName: 'Bash',
      inputPreview: JSON.stringify({ command: 'echo "a_b *c*"', reason: 'compare a_b and c < d' }),
      description: 'Run a shell command.',
      agentName: 'agent_test',
    })
    // < > & are literal in rich markdown; the underscore in the agent name is
    // backslash-escaped so it can't open an italic run.
    expect(body).toContain('Agent\\_test')
    expect(body).toContain('c < d')
    // The card's own wrappers (** for the name, _ for the why line) are present.
    expect(body).toContain('**')
    expect(body).toContain('why: _')
  })

  test('truncates a very long caller reason with an ellipsis', () => {
    const body = formatPermissionCardBody({
      toolName: 'Skill',
      inputPreview: JSON.stringify({ skill: 'mail', reason: 'x'.repeat(500) }),
      description: 'Use a skill.',
      agentName: 'clerk',
    })
    expect(body).toContain('xxxx…_')
    expect(body.split('\n')[0]).toBe('🔐 **Clerk** wants to use the mail skill')
  })

  test('collapses internal whitespace in the caller reason', () => {
    const body = formatPermissionCardBody({
      toolName: 'Skill',
      inputPreview: JSON.stringify({ skill: 'mail', reason: 'first\n\nsecond\t\t paragraph' }),
      description: 'Use a skill.',
      agentName: 'clerk',
    })
    expect(body).toContain('why: _first second paragraph_')
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
    expect(body).toContain(`why: _${reason}_`)
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
    expect(body).toContain(`why: _${reason}_`)
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
    expect(body.split('\n')[0]).toBe('🔐 **Klanker** wants to restart agent `carrie` in the fleet')
  })

  test('hostd start/stop/logs/exec each name the target agent (#2469)', () => {
    const mk = (tool: string) =>
      formatPermissionCardBody({
        toolName: tool,
        inputPreview: JSON.stringify({ name: 'pixel' }),
        description: 'static schema doc',
        agentName: 'klanker',
      }).split('\n')[0]
    expect(mk('mcp__hostd__agent_start')).toBe('🔐 **Klanker** wants to start agent `pixel` in the fleet')
    expect(mk('mcp__hostd__agent_stop')).toBe('🔐 **Klanker** wants to stop agent `pixel` in the fleet')
    expect(mk('mcp__hostd__agent_logs')).toBe("🔐 **Klanker** wants to read agent `pixel`'s container logs")
    expect(mk('mcp__hostd__agent_exec')).toBe('🔐 **Klanker** wants to run a read-only inspection inside agent `pixel`')
  })

  test('hostd agent verb without a name arg falls back to the generic phrase (no crash) (#2469)', () => {
    const body = formatPermissionCardBody({
      toolName: 'mcp__hostd__agent_restart',
      inputPreview: JSON.stringify({ reason: 'bouncing the fleet' }),
      description: 'static schema doc',
      agentName: 'klanker',
    })
    expect(body.split('\n')[0]).toBe('🔐 **Klanker** wants to restart an agent in the fleet')
    expect(body).toContain('why: _bouncing the fleet_')
  })

  test('non-name-arg gated verb (update_apply) stays generic and does not break (#2469)', () => {
    const body = formatPermissionCardBody({
      toolName: 'mcp__hostd__update_apply',
      inputPreview: JSON.stringify({ reason: 'rolling out v0.16' }),
      description: 'static schema doc',
      agentName: 'klanker',
    })
    expect(body.split('\n')[0]).toBe('🔐 **Klanker** wants to apply a fleet-wide update (pull + recreate)')
    expect(body).toContain('why: _rolling out v0.16_')
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
    expect(lines[0]).toBe('🔐 **Marko** wants to POST /smtp/email (Brevo)')
    expect(lines[1]).toBe('why: _sending the priority-access invite_')
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

// Bug 1: the hostd rollout verb gained an optional `reason` (which the agent
// can now actually supply) and a curated MCP_TOOL_DESCRIPTIONS title, so the
// card stops rendering the generic "rollout (Hostd)" with "why: not provided".
describe('formatPermissionCardBody — hostd rollout (Bug 1)', () => {
  test('renders the caller-supplied reason on the why: line', () => {
    const body = formatPermissionCardBody({
      toolName: 'mcp__hostd__rollout',
      inputPreview: JSON.stringify({
        reason: 'promote canary-green v0.16.24 to the fleet',
        pin: 'v0.16.24',
      }),
      description: 'SAFELY roll the fleet to a pinned SEMVER version …',
      agentName: 'overlord',
    })
    expect(body).toContain('why: _promote canary-green v0.16.24 to the fleet_')
    // #2469: never the schema description.
    expect(body).not.toContain('SAFELY roll the fleet')
  })

  test('renders the clean MCP_TOOL_DESCRIPTIONS title, not the raw tool id', () => {
    const body = formatPermissionCardBody({
      toolName: 'mcp__hostd__rollout',
      inputPreview: JSON.stringify({
        reason: 'rollback to last-good tag',
        pin: 'v0.16.20',
      }),
      description: 'desc',
      agentName: 'overlord',
    })
    const firstLine = body.split('\n')[0]
    // Curated phrase from MCP_TOOL_DESCRIPTIONS["mcp__hostd__rollout"].
    expect(firstLine).toBe('🔐 **Overlord** wants to roll the fleet to a pinned version')
    expect(firstLine).not.toContain('mcp__hostd__rollout')
    expect(firstLine).not.toMatch(/rollout \(Hostd\)/i)
  })

  test('naturalAction surfaces the curated title for the rollout verb', () => {
    expect(naturalAction('mcp__hostd__rollout', undefined)).toBe(
      'roll the fleet to a pinned version',
    )
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
    ).toBe('▶️ **Gymbro** — got it, continuing: _edit: supplement-log.md_')
  })

  test('deny names what it will skip, lower-cased inline', () => {
    expect(
      formatPermissionResumeMessage({
        agentName: 'ziggy',
        behavior: 'deny',
        action: 'Search the web',
      }),
    ).toBe("🚫 **Ziggy** — noted, I won't search the web. Continuing without it.")
  })

  test('TTL auto-deny variant reads as a timeout, not a tap', () => {
    expect(
      formatPermissionResumeMessage({
        agentName: 'finn',
        behavior: 'deny',
        action: 'run: deploy.sh',
        timeoutMinutes: 5,
      }),
    ).toBe('🚫 **Finn** — no answer in 5m, continuing without it (_run: deploy.sh_).')
  })

  test('markdown-escapes a hostile action phrase (no raw ** emphasis injection) (#2669)', () => {
    const out = formatPermissionResumeMessage({
      agentName: 'clerk',
      behavior: 'allow',
      action: 'run: echo **pwned**',
    })
    // The injected ** markers are backslash-escaped so they render literally
    // and cannot hijack the card's own emphasis.
    expect(out).toContain('\\*\\*pwned\\*\\*')
    expect(out).not.toContain('echo **pwned**')
  })

  test('cap-first on the agent name', () => {
    const out = formatPermissionResumeMessage({
      agentName: 'lawgpt',
      behavior: 'allow',
      action: 'read: contract.pdf',
    })
    expect(out).toContain('**Lawgpt**')
  })

  test('empty action falls back to a generic continue (no dangling phrase)', () => {
    expect(
      formatPermissionResumeMessage({ agentName: 'carrie', behavior: 'allow', action: '' }),
    ).toBe('▶️ **Carrie** — got it, back to work.')
    expect(
      formatPermissionResumeMessage({ agentName: 'carrie', behavior: 'deny', action: '   ' }),
    ).toBe('🚫 **Carrie** — noted, continuing without it.')
  })

  test('null agent name degrades to a neutral "Agent" label', () => {
    expect(
      formatPermissionResumeMessage({ agentName: null, behavior: 'allow', action: 'edit: x.md' }),
    ).toBe('▶️ **Agent** — got it, continuing: _edit: x.md_')
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
