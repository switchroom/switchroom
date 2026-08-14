# Config Cascade

Switchroom resolves agent configuration through three layers applied bottom-up:

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
| **Union** | `tools.allow`, `tools.deny`, `skills`, `secrets`, `allowed_tools`, `disallowed_tools`, `extra_stable_files` | Combine across all layers, dedup-preserving-order (defaults first) |
| **Override** | `model`, `extends`, `dangerous_mode`, most scalars | Agent wins entirely |
| **Per-key merge** | `mcp_servers`, `env`, `bundled_skills` | Agent wins on key conflict, others preserved |
| **Per-key merge with field-level merge on conflict** | `subagents` | Agent wins per key; on a key present at both layers, fields are merged field-by-field (not a whole-definition replacement — that was the pre-#682 bug) |
| **Per-field merge** | `soul`, `session`, `session_continuity`, `channels`, `reactions`, `reaction_dispatch` | Agent wins per sub-field. `channels` and `reactions`/`reaction_dispatch` sub-arrays (e.g. `trigger_emojis`) use REPLACE semantics, not union. |
| **One-level-deep merge** | `memory` (`recall`/`retain`/`disposition` sub-objects), `litellm` (scalars + per-key `tags`) | Top-level fields override; the named sub-object merges one level deep instead of replacing wholesale, so overriding one knob doesn't drop its siblings |
| **Per-event concat** | `hooks` | Defaults appended first, then agent (no dedup — identical entries may be intentional) |
| **Concatenate** | `schedule`, `system_prompt_append`, `claude_md_raw`, `cli_args` | Defaults prepended |
| **Deep merge** | `settings_raw` | Recursive object merge, agent wins |
| **Replace-if-unset** | `release` | Whole-block replace; an agent-declared `release` is NOT field-merged with defaults (deliberate — a pinned agent must not silently inherit a channel/pin from the fleet, or vice versa) |

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

### subagents per-key merge with field-level merge on conflict
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
        description: "Code implementation with tests"  # overrides only this field
        tools: [Read, Edit, Write, Bash]                # added; model still inherited
    # researcher and reviewer inherited from defaults unchanged
```
`worker`'s resolved definition is `{ description: "Code implementation with
tests", model: sonnet, tools: [Read, Edit, Write, Bash] }` — the agent layer
merges field-by-field onto the matching default key, it does not replace the
whole `worker` definition (`src/config/merge.ts`, `subagents: per-key merge,
with field-level merge on conflict`; whole-def replacement was the pre-#682
bug this fixed).

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

1. **Inline** in `profiles:` section of switchroom.yaml
2. **Filesystem** at `profiles/<name>/` — contains `CLAUDE.md.hbs`, plus optional `SOUL.md.hbs` and `skills/`

An agent inherits from at most one profile via `extends: <name>`. Profiles themselves do not chain.

## Vault references

Secrets in switchroom.yaml use `vault:key-name` syntax; `vault:<key>#<filename>`
additionally inlines one named file's contents as a string from a
`kind: "files"` vault entry (`src/vault/resolver.ts:194`,
`resolveSingleReference`). At scaffold/reconcile time these are resolved
from `~/.switchroom/vault.enc` and written into `start.sh` as environment
variables — never stored in plaintext in switchroom.yaml.

In production, agent-runtime vault reads do NOT go through that scaffold-time
decrypt path — they go through the vault-broker daemon over a local socket
(`resolveVaultReferencesViaBroker`, `src/vault/resolver.ts:288`), which is
what enforces the per-agent grant/deny model (`VAULT-BROKER-DENIED`,
`vault_request_access`) documented for agents at runtime.
