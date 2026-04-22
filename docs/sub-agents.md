# Sub-Agent Delegation

Switchroom generates Claude Code custom sub-agent files (`.claude/agents/<name>.md`) from your switchroom.yaml config. This enables the "Opus plans, Sonnet implements" pattern. The main agent delegates to cheaper models running in the background.

## Quick Start

```yaml
defaults:
  subagents:
    worker:
      description: "Implementation tasks"
      model: sonnet
      background: true
      isolation: worktree
    researcher:
      description: "Exploration and investigation"
      model: haiku
      background: true
    reviewer:
      description: "Quality review"
      model: sonnet
```

After `switchroom agent create` or `switchroom agent reconcile`, these become `.claude/agents/worker.md`, `.claude/agents/researcher.md`, etc. Claude Code loads them automatically.

## How Delegation Works

1. The main agent (e.g. Opus) receives your request
2. It dispatches to `@worker`, a Sonnet sub-agent running in the background
3. The main agent responds immediately ("working on it") and stays available
4. The worker implements in its own git worktree
5. When done, the main agent reviews the result

The user can always override the model per-invocation: "use @worker but run it on opus for this one."

## Configuration

Each sub-agent supports the full Claude Code frontmatter spec:

| Field | Description |
|-------|-------------|
| `description` | (required) When to delegate to this sub-agent |
| `model` | `sonnet`, `opus`, `haiku`, full ID, or `inherit` |
| `background` | Run in background (non-blocking). Default: false |
| `isolation` | `worktree` for own git branch |
| `tools` | Tool allowlist (inherits all if omitted) |
| `disallowedTools` | Tool denylist |
| `maxTurns` | Auto-stop after N turns |
| `permissionMode` | `default`, `acceptEdits`, `auto`, `dontAsk`, `bypassPermissions`, `plan` |
| `effort` | `low`, `medium`, `high`, `max` |
| `color` | Display color in task list |
| `memory` | `user`, `project`, or `local` for persistent learning |
| `skills` | Skills to preload |
| `prompt` | System prompt (markdown body) |

## Model Resolution

Claude Code resolves the model in this order (highest wins):

1. `CLAUDE_CODE_SUBAGENT_MODEL` env var (switchroom doesn't set this)
2. Per-invocation `model` parameter (user/agent can override)
3. Sub-agent definition's `model` frontmatter (what switchroom sets)
4. Main conversation's model

This means switchroom's sub-agent files set sensible defaults at level 3, but the user can always override at level 2.

## Cascade Behavior

Sub-agents are **per-key merged** across cascade layers. An agent can override a default sub-agent by declaring one with the same name:

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
        prompt: "Always write tests. Always run them before reporting done."
```

The dev agent's `worker` completely replaces the default `worker`.

## Design Principles

- **Generic, not domain-specific.** Default sub-agents are `worker`, `researcher`, `reviewer`. Domain-agnostic names that work for any agent type.
- **Smart defaults.** Ship with useful sub-agents out of the box. Override per-profile or per-agent when needed.
- **Don't fight Claude Code.** Sub-agent files use Claude Code's native spec. No wrapper, no custom runtime.
- **No `CLAUDE_CODE_SUBAGENT_MODEL`.** That env var overrides ALL sub-agents including built-in Explore (Haiku). Per-file model control is the right granularity.

## Built-in Claude Code Sub-Agents

Switchroom's custom sub-agents coexist with Claude Code's built-in ones:

| Agent | Model | Purpose |
|-------|-------|---------|
| **Explore** (built-in) | Haiku | Fast codebase search |
| **Plan** (built-in) | Inherit | Research for planning |
| **general-purpose** (built-in) | Inherit | Complex multi-step tasks |
| **worker** (switchroom) | Sonnet | Implementation tasks |
| **researcher** (switchroom) | Haiku | Exploration and investigation |
| **reviewer** (switchroom) | Sonnet | Quality review |
