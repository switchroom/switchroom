# Config Cascade

Clerk resolves agent configuration through three layers applied bottom-up:

```
defaults:    ← global baseline
  ↓
profiles:    ← named presets (agent opts in with extends:)
  ↓
agents:      ← per-agent overrides (only express differences)
```

The resolved value at any field is determined by the **merge type** for that field.

## Merge Types

| Merge type | Fields | Behavior |
|---|---|---|
| **Union** | `tools.allow`, `tools.deny`, `skills` | Combine across all layers, dedup |
| **Override** | `model`, `extends`, `dangerous_mode`, most scalars | Agent wins entirely |
| **Per-key merge** | `mcp_servers`, `env`, `subagents` | Agent wins on key conflict, others preserved |
| **Per-field merge** | `soul`, `memory`, `session`, `channels` | Agent wins per sub-field |
| **Per-event concat** | `hooks` | Defaults appended first, then agent |
| **Concatenate** | `schedule`, `system_prompt_append`, `claude_md_raw`, `cli_args` | Defaults prepended |
| **Deep merge** | `settings_raw` | Recursive object merge, agent wins |

## Examples

### Tools union
```yaml
defaults:
  tools:
    allow: [all]

profiles:
  coder:
    tools:
      allow: [Bash, Read, Write, Edit]  # union: [all, Bash, Read, ...]

agents:
  dev:
    extends: coder
    tools:
      deny: [WebSearch]                 # union: deny=[WebSearch]
```

### system_prompt_append concatenation
```yaml
defaults:
  system_prompt_append: "Always respond concisely."

profiles:
  coder:
    system_prompt_append: "Prefer TypeScript."

agents:
  dev:
    extends: coder
    system_prompt_append: "Never use `any`."
```
Resolved for dev:
```
Always respond concisely.
Prefer TypeScript.
Never use `any`.
```

### subagents per-key merge
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
        description: "Code implementation with tests"  # replaces default worker
        model: sonnet
        tools: [Read, Edit, Write, Bash]
    # researcher and reviewer inherited from defaults unchanged
```

### hooks per-event concat
```yaml
defaults:
  hooks:
    PreToolUse:
      - command: "/opt/audit.sh"

agents:
  dev:
    hooks:
      PreToolUse:
        - command: "/opt/dev-extra-check.sh"
# Resolved: audit.sh runs first, then dev-extra-check.sh
```

## Profile Resolution

Profiles can be defined in two places (inline takes priority):

1. **Inline** in `profiles:` section of clerk.yaml
2. **Filesystem** at `profiles/<name>/` — contains `CLAUDE.md.hbs`, `SOUL.md.hbs`, optional `skills/`

An agent inherits from at most one profile via `extends: <name>`. Profiles themselves do not chain.

## Vault references

Secrets in clerk.yaml use `vault:key-name` syntax. They're resolved at scaffold/reconcile time from `~/.clerk/vault.enc`. Vault values are written into `start.sh` as environment variables — never stored in plaintext in clerk.yaml.
