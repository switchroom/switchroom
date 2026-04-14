---
name: switchroom-manage
description: Manage switchroom agents from within a Claude Code session
---

# Switchroom Agent Management

When the user invokes `/switchroom` or asks to manage their switchroom agents, use the Bash tool to run the appropriate `switchroom` CLI command from the table below.

**Prerequisite:** The `switchroom` CLI must be installed and available on PATH.

## Available Commands

| User says | Run |
|---|---|
| `/switchroom agents` or `/switchroom list` | `switchroom agent list` |
| `/switchroom start <name>` | `switchroom agent start <name>` |
| `/switchroom stop <name>` | `switchroom agent stop <name>` |
| `/switchroom restart <name>` | `switchroom agent restart <name>` |
| `/switchroom status` | `switchroom auth status` |
| `/switchroom memory <query>` | `switchroom memory search "<query>"` |
| `/switchroom memory <query> --agent <name>` | `switchroom memory search "<query>" --agent <name>` |
| `/switchroom vault list` | `switchroom vault list` |
| `/switchroom topics` | `switchroom topics list` |

## Behavior

1. Run the matching `switchroom` command using the Bash tool.
2. If the command fails with "command not found", tell the user that `switchroom` is not installed or not on PATH and suggest running `npm install -g switchroom-ai` or checking their installation.
3. Format the output cleanly for the user. For list commands, present results as a table or bulleted list. For start/stop/restart, confirm the action taken.
4. If the user just types `/switchroom` with no subcommand, show this help summary:

```
Switchroom commands:
  /switchroom agents         List all configured agents
  /switchroom start <name>   Start an agent
  /switchroom stop <name>    Stop an agent
  /switchroom restart <name> Restart an agent
  /switchroom status         Show auth status
  /switchroom memory <query> Search agent memory
  /switchroom vault list     List vault secrets
  /switchroom topics         List Telegram topics
```
