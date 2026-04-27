import { describe, it, expect } from 'vitest'
import { toolLabel, isHumanDescription } from '../tool-labels.js'

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

    it('Bash: description wins over preamble when both are present', () => {
      expect(
        toolLabel(
          'Bash',
          { command: 'git status', description: 'Check git status' },
          'Running git status real quick',
        ),
      ).toBe('Check git status')
    })

    it('Bash: falls back to preamble when description is absent', () => {
      // Issue #50.1 — post-#41 Bash no longer ignores preamble. When the
      // agent didn't supply a `description`, the preamble (model's preceding
      // text narration) wins over the raw command string.
      expect(
        toolLabel(
          'Bash',
          { command: 'find /home -name "*.tmp" -mtime +30 -exec rm {} \\;' },
          'Sweep stale temp files',
        ),
      ).toBe('Sweep stale temp files')
    })

    it('Bash: raw command fallback when both description and preamble are absent', () => {
      expect(toolLabel('Bash', { command: 'git status' })).toBe('git status')
      expect(toolLabel('Bash', { command: 'git status' }, undefined)).toBe('git status')
      expect(toolLabel('Bash', { command: 'git status' }, '')).toBe('git status')
    })

    it('Bash: multi-line preamble is narrative, not a label → command fallback', () => {
      expect(
        toolLabel(
          'Bash',
          { command: 'git status' },
          "Here's my plan:\n1. check status\n2. commit",
        ),
      ).toBe('git status')
    })

    it('Task / Agent ignore preamble (description / subagent_type is always set)', () => {
      expect(
        toolLabel('Task', { description: 'Research bug' }, 'Kicking off the research agent'),
      ).toBe('Research bug')
      expect(
        toolLabel('Agent', { subagent_type: 'Explore' }, 'Spawning an explorer'),
      ).toBe('Explore')
    })
  })

  describe('ToolSearch', () => {
    it('select form → "Loading schema: <names>"', () => {
      expect(
        toolLabel('ToolSearch', { query: 'select:mcp__hindsight__recall' }),
      ).toBe('Loading schema: mcp__hindsight__recall')
    })

    it('select form with multiple names → comma-separated', () => {
      expect(
        toolLabel('ToolSearch', {
          query: 'select:mcp__hindsight__recall,mcp__switchroom-telegram__stream_reply',
        }),
      ).toBe(
        // Truncated at ~60 chars with an ellipsis suffix — just assert the prefix
        // and that the output is bounded.
        'Loading schema: mcp__hindsight__recall, mcp__switchroom-tel…',
      )
    })

    it('keyword form → "Searching tools: <query>"', () => {
      expect(
        toolLabel('ToolSearch', { query: 'notebook jupyter' }),
      ).toBe('Searching tools: notebook jupyter')
    })

    it('empty / missing query → empty string', () => {
      expect(toolLabel('ToolSearch', {})).toBe('')
      expect(toolLabel('ToolSearch', { query: '' })).toBe('')
    })

    it('label stays under MAX_LABEL_CHARS', () => {
      const long = 'x'.repeat(500)
      expect(toolLabel('ToolSearch', { query: long }).length).toBeLessThanOrEqual(60)
      expect(
        toolLabel('ToolSearch', { query: `select:${long}` }).length,
      ).toBeLessThanOrEqual(60)
    })
  })

  describe('MCP tools (mcp__*)', () => {
    it('derives "<Server>: <action>" with no query', () => {
      expect(toolLabel('mcp__hindsight__recall', {})).toBe('Hindsight: recall')
      expect(toolLabel('mcp__hindsight__reflect', {})).toBe('Hindsight: reflect')
    })

    it('switchroom-telegram → "Telegram: <action>"', () => {
      expect(toolLabel('mcp__switchroom-telegram__reply', {})).toBe('Telegram: reply')
      expect(toolLabel('mcp__switchroom-telegram__stream_reply', {})).toBe('Telegram: stream_reply')
    })

    it('prefers input.description when present', () => {
      expect(
        toolLabel('mcp__hindsight__retain', { description: 'Remember Ken prefers TypeScript' }),
      ).toBe('Remember Ken prefers TypeScript')
    })

    it('appends truncated query preview', () => {
      expect(
        toolLabel('mcp__hindsight__recall', { query: '4 phase Claude auth management' }),
      ).toBe('Hindsight: recall (4 phase Claude auth management)')
    })

    it('long query gets truncated, total stays bounded', () => {
      const q = '4 phase Claude auth management switchroom agents plan phases'
      const out = toolLabel('mcp__hindsight__recall', { query: q })
      expect(out.startsWith('Hindsight: recall (')).toBe(true)
      expect(out.endsWith(')')).toBe(true)
      // Budget: MAX_LABEL_CHARS (60) + some framing slack — assert under ~80.
      expect(out.length).toBeLessThanOrEqual(80)
    })

    it('uses input.text or input.name when no query present', () => {
      expect(
        toolLabel('mcp__hindsight__create_directive', { text: 'Prefer TypeScript' }),
      ).toBe('Hindsight: create_directive (Prefer TypeScript)')
      expect(
        toolLabel('mcp__hindsight__get_mental_model', { name: 'User Profile' }),
      ).toBe('Hindsight: get_mental_model (User Profile)')
    })

    it('malformed mcp name falls back to generic sweep', () => {
      // Only one `__` segment after prefix — no action half.
      expect(toolLabel('mcp__broken', { query: 'foo' })).toBe('foo')
    })

    it('strips HTML tags from preview text', () => {
      // stream_reply accepts Telegram-HTML text; raw tags in the preview
      // would survive escapeHtml() in the renderer and render as literal
      // `<b>` on screen. The label must come back as plain prose.
      const out = toolLabel('mcp__switchroom-telegram__stream_reply', {
        text: '<b>Recommendation, priority-ordered:</b> 1a — scaffold',
      })
      expect(out).not.toContain('<b>')
      expect(out).not.toContain('</b>')
      expect(out).toContain('Recommendation')
    })

    it('strips HTML from description fallback', () => {
      const out = toolLabel('mcp__hindsight__retain', {
        description: 'Remember <i>Ken</i> prefers TypeScript',
      })
      expect(out).toBe('Remember Ken prefers TypeScript')
    })

    it('preserves comparison operators in non-HTML queries', () => {
      // stripHtml's regex requires a letter/slash after `<` so plain-text
      // comparisons like "x < 5 and y > 3" don't get their middle eaten.
      const out = toolLabel('mcp__hindsight__recall', {
        query: 'x < 5 and y > 3',
      })
      expect(out).toBe('Hindsight: recall (x < 5 and y > 3)')
    })
  })

  describe('regression: existing cases still pass with new defaults', () => {
    it('Bash still wins its explicit case', () => {
      expect(toolLabel('Bash', { description: 'Check file size' })).toBe('Check file size')
    })

    it('unknown non-mcp tool still uses generic sweep', () => {
      expect(toolLabel('SomeRandomTool', { description: 'doing a thing' })).toBe('doing a thing')
    })
  })
})

describe('isHumanDescription', () => {
  it('Bash with non-empty description → true', () => {
    expect(isHumanDescription('Bash', { description: 'Check commit state' })).toBe(true)
    expect(isHumanDescription('Bash', { command: 'git status', description: 'Check git status' })).toBe(true)
  })

  it('BashOutput with non-empty description → true', () => {
    expect(isHumanDescription('BashOutput', { description: 'Stream output' })).toBe(true)
  })

  it('Bash with no description, command only → false', () => {
    expect(isHumanDescription('Bash', { command: 'git status' })).toBe(false)
    expect(isHumanDescription('Bash', {})).toBe(false)
    expect(isHumanDescription('Bash', { description: '' })).toBe(false)
    expect(isHumanDescription('Bash', { description: '   ' })).toBe(false)
  })

  it('Task with non-empty description → true', () => {
    expect(isHumanDescription('Task', { description: 'Research the bug' })).toBe(true)
  })

  it('Agent with non-empty description → true', () => {
    expect(isHumanDescription('Agent', { description: 'Deploy the service', subagent_type: 'worker' })).toBe(true)
  })

  it('Task / Agent without description → false', () => {
    expect(isHumanDescription('Task', { subagent_type: 'general-purpose' })).toBe(false)
    expect(isHumanDescription('Agent', {})).toBe(false)
  })

  it('WebFetch → false (tool name provides context)', () => {
    expect(isHumanDescription('WebFetch', { url: 'https://example.com', description: 'Check docs' })).toBe(false)
  })

  it('WebSearch → false', () => {
    expect(isHumanDescription('WebSearch', { query: 'foo', description: 'Search for foo' })).toBe(false)
  })

  it('Read / Edit / Grep → false', () => {
    expect(isHumanDescription('Read', { file_path: '/x/foo.ts' })).toBe(false)
    expect(isHumanDescription('Edit', { file_path: '/x/foo.ts', description: 'Fix the bug' })).toBe(false)
    expect(isHumanDescription('Grep', { pattern: 'TODO' })).toBe(false)
  })

  it('MCP tools → false (handled separately by tool.startsWith("mcp__"))', () => {
    expect(isHumanDescription('mcp__hindsight__recall', { query: 'foo' })).toBe(false)
    expect(isHumanDescription('mcp__hindsight__retain', { description: 'Store user pref' })).toBe(false)
  })

  it('missing or non-object input → false', () => {
    expect(isHumanDescription('Bash', undefined)).toBe(false)
    expect(isHumanDescription('Bash')).toBe(false)
  })
})
