---
name: clerk-config
description: Shows what model, tools, and settings an agent is using. Use when the user asks 'what model is X using', 'show me the config', 'how is it configured', agent settings, effective configuration, or wants to inspect an agent's current setup.
---

# Agent Configuration Viewer

When the user asks about configuration, what model an agent uses, what settings are active, or how the cascade works for a specific agent — use this skill to show the resolved effective config.

## Step 1 — Find clerk.yaml

```bash
# Try CLERK_CONFIG env var first, then common locations
echo "${CLERK_CONFIG:-}"
ls ~/.clerk/clerk.yaml 2>/dev/null
ls ~/clerk.yaml 2>/dev/null
ls ~/.config/clerk/clerk.yaml 2>/dev/null
```

Read the file at whichever path exists. Most commonly: `~/.clerk/clerk.yaml`.

## Step 2 — Resolve the requested agent

If the user named a specific agent (e.g. "show config for dev"), find that agent in `agents:`. If no agent was named, ask: "Which agent? Here are the configured ones: [list names from agents: section]"

## Step 3 — Show the cascade

Walk the three layers and display the resolved value for each field, annotated with its source:

```
Resolved config for: dev
─────────────────────────────────────
model:           claude-opus-4-6        (from: agents.dev)
extends:         coder                  (from: agents.dev)
tools.allow:     [Bash, Read, Write, Edit, Grep, Glob]  (union: defaults + profile.coder)
tools.deny:      —
skills:          [checkin, code-review, architecture]   (union: defaults + profile.coder)
memory.collection: coding              (from: agents.dev)
topic_name:      Code                  (from: agents.dev)
topic_emoji:     💻                    (from: agents.dev)
channels.telegram.format: html         (from: defaults)
system_prompt_append:
  1. "Always respond concisely."       (from: defaults)
  2. "You write production-quality TypeScript. Prefer explicit types." (from: profile.coder)
schedule:        —
subagents:       worker, researcher, reviewer  (from: defaults)
hooks.PreToolUse: ["/opt/clerk-audit.sh"]  (from: defaults)
```

## Step 4 — Cascade merge rules

Apply these rules when combining layers:

| Merge type | Fields |
|---|---|
| **Union** | `tools.allow`, `tools.deny`, `skills` — combine all layers, dedup |
| **Override** | `model`, `extends`, `dangerous_mode`, most scalars — agent wins |
| **Per-key merge** | `mcp_servers`, `env`, `subagents` — agent wins on key conflict |
| **Per-field merge** | `soul`, `memory`, `session`, `channels` — agent wins per sub-field |
| **Concatenate** | `schedule`, `system_prompt_append`, `claude_md_raw`, `cli_args` — defaults first |
| **Per-event concat** | `hooks` — defaults first, then agent |
| **Deep merge** | `settings_raw` — recursive, agent wins |

## Step 5 — Profile resolution

If `extends: <name>` is set:
1. Check `profiles:` section of clerk.yaml for inline profile
2. Check `profiles/<name>/` filesystem directory

Show which profile is active and what it contributes.

## Notes

- Vault references (e.g. `vault:telegram-bot-token`) are shown as-is — don't try to resolve them
- If `clerk.yaml` can't be found, tell the user and suggest setting `CLERK_CONFIG=/path/to/clerk.yaml`
- If the user wants to see the raw file, just read and display `clerk.yaml` directly
