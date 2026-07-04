import { describe, it, expect } from 'vitest'
import { describeToolUse } from '../tool-activity-summary.js'
import { computeLabel } from '../hooks/tool-label-pretool.mjs'

/**
 * SINGLE STATUS-VOCABULARY GUARANTEE (know-what-my-agent-is-doing).
 *
 * Every activity surface renders per-tool status wording from ONE composer:
 * `computeLabel` (hooks/tool-label-pretool.mjs). The consumers:
 *
 *   - real-time live feed  — the PreToolUse sidecar runs computeLabel at
 *     tool-call time (`tool_label` events → appendActivityLabel);
 *   - flush-time feed      — appendActivityLine → describeToolUse;
 *   - nested sub-agent / worker-card steps — subagent-watcher →
 *     describeToolUse (whose lines the 🛠 Worker card renders via
 *     renderStatusCard).
 *
 * `describeToolUse` is a thin delegating wrapper over computeLabel. Before
 * the delegation the two tables had drifted (same action, different copy on
 * different surfaces — the wording drift the spec bars). This test is the
 * anti-drift lock: it sweeps a corpus of every tool shape both composers
 * handle and asserts they emit IDENTICAL labels. If someone re-forks the
 * vocabulary — a second wording table in describeToolUse, a hook-only
 * rewording — this fails CI.
 */

// Corpus: (toolName, input) pairs spanning every branch of the composer.
const CORPUS: Array<[string, Record<string, unknown>]> = [
  ['Bash', { command: 'ls -la', description: 'List repo files' }],
  ['Bash', { command: 'grep -r foo .' }],
  ['BashOutput', {}],
  ['KillShell', {}],
  ['Read', { file_path: '/home/u/code/gateway.ts' }],
  ['Read', {}],
  ['Edit', { file_path: '/a/b/CLAUDE.md' }],
  ['MultiEdit', { file_path: '/a/b/x.ts' }],
  ['Edit', {}],
  ['Write', { file_path: 'notes.txt' }],
  ['Write', {}],
  ['NotebookEdit', { notebook_path: '/n/analysis.ipynb' }],
  ['NotebookEdit', {}],
  ['Grep', { pattern: 'TODO' }],
  ['Grep', { pattern: 'TODO', path: 'src/' }],
  ['Grep', {}],
  ['Glob', { pattern: '**/*.ts' }],
  ['Glob', {}],
  ['WebFetch', { url: 'https://www.example.com/path?q=1' }],
  ['WebFetch', {}],
  ['WebSearch', { query: 'best running shoes' }],
  ['WebSearch', {}],
  ['Task', { description: 'Review the migration' }],
  ['Agent', {}],
  ['TodoWrite', {}],
  ['TaskCreate', {}],
  ['TaskUpdate', {}],
  ['TaskList', {}],
  ['ToolSearch', {}],
  ['Skill', { skill: 'switchroom' }],
  ['SomeFutureBuiltin', {}],
  ['mcp__hindsight__recall', { query: 'x' }],
  ['mcp__hindsight__reflect', { query: 'x' }],
  ['mcp__hindsight__retain', {}],
  ['mcp__hindsight__update_memory', {}],
  ['mcp__hindsight__list_memories', {}],
  ['mcp__claude_ai_Google_Calendar__list_events', {}],
  ['mcp__claude_ai_Gmail__search', {}],
  ['mcp__claude_ai_Google_Drive__search_files', {}],
  ['mcp__claude_ai_Notion__notion-search', {}],
  ['mcp__perplexity__perplexity_search', { query: 'weather sydney' }],
  ['mcp__webkite__read', { url: 'https://example.org/docs' }],
  ['mcp__acme__do_thing', { description: 'Fetched the report' }],
  ['mcp__acme__do_thing', {}],
  ['mcp__switchroom-telegram__get_recent_messages', {}],
]

// Suppressed-on-both corpus: surfaces must agree these render NOTHING.
const SUPPRESSED: Array<[string, Record<string, unknown>]> = [
  ['mcp__switchroom-telegram__reply', { text: 'hi' }],
  ['mcp__switchroom-telegram__stream_reply', {}],
  ['mcp__switchroom-telegram__edit_message', {}],
  ['mcp__switchroom-telegram__react', {}],
  ['mcp__clerk-telegram__reply', {}],
  ['mcp__hindsight__sync_retain', {}],
  ['Skill', {}], // empty-slug Skill stays suppressed (#2111 sidecar contract)
]

describe('single status-vocabulary composer (drift fails CI)', () => {
  it('describeToolUse and computeLabel emit identical labels across the corpus', () => {
    for (const [tool, input] of CORPUS) {
      expect(describeToolUse(tool, input), `label drift for ${tool}`).toBe(
        computeLabel(tool, input),
      )
    }
  })

  it('both composers agree on suppression (never a surfaced reply/control tool)', () => {
    for (const [tool, input] of SUPPRESSED) {
      expect(describeToolUse(tool, input), `describeToolUse must suppress ${tool}`).toBeNull()
      expect(computeLabel(tool, input), `computeLabel must suppress ${tool}`).toBeNull()
    }
  })

  it('the previously-drifted wordings are unified (the Ken-observed drift)', () => {
    // These exact pairs rendered DIFFERENT copy per surface before the
    // unification. Pin the unified form on both composers.
    expect(computeLabel('Grep', { pattern: 'TODO' })).toBe('Searching for TODO')
    expect(describeToolUse('Grep', { pattern: 'TODO' })).toBe('Searching for TODO')
    expect(computeLabel('WebFetch', { url: 'https://www.example.com/path?q=1' })).toBe(
      'Reading example.com',
    )
    expect(describeToolUse('WebFetch', { url: 'https://www.example.com/path?q=1' })).toBe(
      'Reading example.com',
    )
    expect(computeLabel('mcp__hindsight__retain', {})).toBe('Saving to memory')
    expect(describeToolUse('mcp__hindsight__retain', {})).toBe('Saving to memory')
  })

  it('never emits raw shell/query syntax from either composer', () => {
    for (const [tool, input] of CORPUS) {
      const label = computeLabel(tool, input)
      if (label == null) continue
      expect(label, `raw syntax leaked for ${tool}`).not.toMatch(/grep -r|ls -la/)
    }
  })
})
