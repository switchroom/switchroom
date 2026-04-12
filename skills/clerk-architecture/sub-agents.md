# Sub-Agent Delegation

Clerk generates Claude Code custom sub-agent files (`.claude/agents/<name>.md`) from `clerk.yaml`. This enables the "Opus plans, Sonnet implements" pattern: the main agent delegates to cheaper models running in the background.

## Default sub-agents

Clerk ships three default sub-agents that every agent inherits:

| Sub-agent | Model | Purpose |
|-----------|-------|---------|
| **worker** | Sonnet | Implementation — writing, editing, building, testing |
| **researcher** | Haiku | Exploration — codebase search, docs, investigation |
| **reviewer** | Sonnet | Quality review — correctness, completeness, security |

These are defined in `defaults.subagents` and flow through the cascade to every agent.

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
| `description` | (required) When the main agent should delegate here |
| `model` | `sonnet`, `opus`, `haiku`, full model ID, or `inherit` |
| `background` | Run non-blocking. Default: false |
| `isolation` | `worktree` — own git branch for file work |
| `tools` | Tool allowlist (inherits all if omitted) |
| `disallowedTools` | Tool denylist |
| `maxTurns` | Auto-stop after N turns |
| `permissionMode` | `default`, `acceptEdits`, `auto`, `bypassPermissions`, `plan` |
| `effort` | `low`, `medium`, `high`, `max` |
| `color` | Display color in task list |
| `memory` | `user`, `project`, or `local` for persistent learning |
| `skills` | Skills to preload |
| `prompt` | System prompt (the markdown body of the sub-agent file) |

## Cascade behavior

Sub-agents are **per-key merged**. An agent overrides a specific sub-agent by declaring one with the same name:

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

## Model resolution order (highest wins)

1. `CLAUDE_CODE_SUBAGENT_MODEL` env var — clerk deliberately doesn't set this (it would override ALL sub-agents including Claude Code built-ins)
2. Per-invocation `model` parameter (user/main-agent override)
3. Sub-agent file's `model` frontmatter (what clerk sets)
4. Main conversation's model

## Coexistence with Claude Code built-ins

| Agent | Model | Origin |
|-------|-------|--------|
| Explore | Haiku | Claude Code built-in |
| Plan | Inherit | Claude Code built-in |
| general-purpose | Inherit | Claude Code built-in |
| worker | Sonnet | Clerk default |
| researcher | Haiku | Clerk default |
| reviewer | Sonnet | Clerk default |

All sub-agents share the same `.claude/agents/` directory. Clerk-generated files don't conflict with Claude Code's built-ins.
