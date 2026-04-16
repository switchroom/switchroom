---
name: switchroom-manage
description: Manage the fleet of switchroom agents from a Claude Code session — add, create, remove, reinstall, reprovision, or lifecycle-control agents. Use when the user says 'add a new agent', 'add an agent to my setup', 'create a new agent', 'remove an agent', 'reinstall my agents', 'reprovision my agents', 'list my agents', 'manage my agents', or invokes `/switchroom`. This is the right skill for fleet-level changes (adding/removing agents) even when the phrasing includes 'install' or 'reinstall' — use switchroom-install only for bootstrapping switchroom itself on a fresh machine.
---

# Switchroom Agent Management

When the user invokes `/switchroom` or asks to add, create, remove, reinstall, reprovision, or otherwise manage their switchroom agents, use the Bash tool to run the appropriate `switchroom` CLI command from the table below.

**Prerequisite:** The `switchroom` CLI must be installed and available on PATH. If it isn't, direct the user to the `switchroom-install` skill to bootstrap switchroom itself first.

## Available Commands

| User says | Run |
|---|---|
| `/switchroom agents` or `/switchroom list` | `switchroom agent list` |
| `/switchroom create <name>` or "add a new agent" | `switchroom agent create <name>` |
| `/switchroom remove <name>` | `switchroom agent remove <name>` |
| `/switchroom start <name>` | `switchroom agent start <name>` |
| `/switchroom stop <name>` | `switchroom agent stop <name>` |
| `/switchroom restart <name>` | `switchroom agent restart <name>` |
| `/switchroom reinstall <name>` or "reinstall my agents" | `switchroom agent reconcile <name>` then `switchroom agent restart <name>` |
| `/switchroom status` | `switchroom auth status` |
| `/switchroom memory <query>` | `switchroom memory search "<query>"` |
| `/switchroom memory <query> --agent <name>` | `switchroom memory search "<query>" --agent <name>` |
| `/switchroom vault list` | `switchroom vault list` |
| `/switchroom topics` | `switchroom topics list` |

### Add / create a new agent

When the user says "add a new agent", "add an agent to my switchroom setup", or "create a new agent", ask for a name (if not provided) and run `switchroom agent create <name>`. This scaffolds the agent directory, installs systemd timers, and wires it into the config cascade.

### Reinstall / reprovision agents

"Reinstall my agents" is a fleet-level reprovisioning operation, **not** a fresh switchroom install. It means: re-apply `switchroom.yaml` and restart the agents. For a single named agent run `switchroom agent reconcile <name>` then `switchroom agent restart <name>`; for all agents use `switchroom agent reconcile all` then restart each. Ask which agents the user wants to reprovision if the scope is ambiguous.

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
