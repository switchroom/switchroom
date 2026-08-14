# Sub-Agent Delegation

Switchroom generates Claude Code custom sub-agent files (`.claude/agents/<name>.md`) from `switchroom.yaml`. This enables the "Opus plans, Sonnet implements" pattern: the main agent delegates to cheaper models running in the background.

## Default sub-agents (starter template, not a hard-coded default)

`subagents` is `.optional()` with no schema-level `.default()`
(`src/config/schema.ts`), and nothing in `src/agents/scaffold.ts` injects a
worker/researcher/reviewer set — an agent with no `subagents` block anywhere
in its cascade simply has none. The three-sub-agent pattern below is the
**starter template** shipped in `examples/switchroom.yaml` (`worker` at
`:111`, `researcher` at `:137`, `reviewer` at `:149`), not something
switchroom ships by default:

| Sub-agent | Model | Purpose |
|-----------|-------|---------|
| **worker** | Sonnet | Implementation — writing, editing, building, testing |
| **researcher** | Haiku | Exploration — codebase search, docs, investigation |
| **reviewer** | Sonnet | Quality review — correctness, completeness, security |

If you want this pattern, declare it under `defaults.subagents` (or a
profile) yourself — copy it from `examples/switchroom.yaml` — and it will
then flow through the cascade to every agent.

## How delegation works

1. Main agent (e.g. Opus) receives user request
2. Dispatches to `@worker` — Sonnet running in background
3. Main agent responds immediately ("on it") and stays available for new messages
4. Worker implements in its own git worktree (if `isolation: worktree`)
5. Worker reports back; main agent reviews and responds to user

The user can override per-invocation: "use @worker but run it on opus for this one."

## Configuration fields

Each sub-agent supports the full Claude Code frontmatter spec:

| Field | Description |
|-------|-------------|
| `description` | Schema-optional (a partial override, e.g. `isolation` only, need not restate it — the cascade retains the base definition's description on merge) but effectively required for a fresh, non-overriding definition: when the main agent should delegate here |
| `model` | `sonnet`, `opus`, `haiku`, full model ID, or `inherit` |
| `background` | Run non-blocking. Default: false |
| `isolation` | `worktree` — own git branch for file work |
| `tools` | Tool allowlist (inherits all if omitted) |
| `disallowedTools` | Tool denylist |
| `maxTurns` | Auto-stop after N turns |
| `permissionMode` | `default`, `acceptEdits`, `auto`, `dontAsk`, `bypassPermissions`, `plan` |
| `effort` | `low`, `medium`, `high`, `xhigh`, `max` |
| `color` | Display color in task list |
| `memory` | `user`, `project`, or `local` for persistent learning |
| `skills` | Skills to preload |
| `prompt` | System prompt (the markdown body of the sub-agent file) |

## Cascade behavior

Sub-agents are **per-key merged, with field-level merge on conflict** (`src/config/merge.ts`) — see [cascade.md](cascade.md). An agent overrides a specific sub-agent by declaring one with the same name; only the fields it sets are replaced, everything else is inherited from the base definition:

```yaml
defaults:
  subagents:
    worker:
      description: "Generic implementation"
      model: sonnet

agents:
  dev:
    subagents:
      worker:
        description: "Code implementation with test coverage"
        model: sonnet
        tools: [Read, Edit, Write, Bash, Grep, Glob]
        prompt: "Always write tests. Run them before reporting done."
      # researcher and reviewer inherited unchanged from defaults
```

## Model resolution and Claude Code's built-in sub-agents

How Claude Code itself resolves a sub-agent's model (env var precedence,
per-invocation overrides) and how switchroom-generated `.claude/agents/*.md`
files coexist with Claude Code's own built-in sub-agents (e.g. Explore,
Plan, general-purpose) is upstream Claude Code CLI behaviour — this repo's
`src/` has no code that reads or sets a `CLAUDE_CODE_SUBAGENT_MODEL` env var,
so switchroom's own source cannot confirm or deny any specific precedence
order or built-in roster here. Consult Anthropic's Claude Code documentation
for the authoritative answer; all switchroom does is render one `.md` file
per configured sub-agent into `.claude/agents/<name>.md` and let Claude Code
own everything downstream of that file.
