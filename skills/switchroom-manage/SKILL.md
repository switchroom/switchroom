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
| `/switchroom restart <name>` | `switchroom restart <name>` |
| `/switchroom reinstall <name>` or "reinstall my agents" | `switchroom update` |
| `/switchroom status` | `switchroom auth status` |
| `/switchroom memory <query>` | `switchroom memory search "<query>"` |
| `/switchroom memory <query> --agent <name>` | `switchroom memory search "<query>" --agent <name>` |
| `/switchroom vault list` | `switchroom vault list` |
| `/switchroom topics` | `switchroom topics list` |
| `/switchroom accounts` or "list anthropic accounts" | `switchroom auth account list` |
| "share my Pro subscription across agents" / "add an Anthropic account" | See **Anthropic accounts** below |

### Add / create a new agent

When the user says "add a new agent", "add an agent to my switchroom setup", or "create a new agent", ask for a name (if not provided) and run `switchroom agent create <name>`. This scaffolds the agent directory, installs systemd timers, and wires it into the config cascade.

### Reinstall / reprovision agents

"Reinstall my agents" is a fleet-level reprovisioning operation, **not** a fresh switchroom install. It means: pull the latest code, re-apply `switchroom.yaml`, and restart the agents. Run `switchroom update` for the full fleet. Ask the user to confirm before running if the scope is ambiguous.

### Anthropic accounts (one OAuth, many agents)

The new auth model treats the Anthropic account as the unit of authentication: one `claude setup-token` per account, then enable the account on however many agents you want. See `reference/share-auth-across-the-fleet.md` for the full design.

**Bootstrap flow when the user wants to share one Pro/Max subscription across agents:**

1. Make sure at least one agent is already authenticated the per-agent way (existing `switchroom auth login <agent>` flow). This gives you a valid `.credentials.json` to lift from.
2. **Create the global account** by lifting the agent's credentials:
   ```bash
   switchroom auth account add work-pro --from-agent <existing-agent>
   ```
3. **Enable** the account on every agent that should share it:
   ```bash
   switchroom auth enable work-pro <agent-1> <agent-2> ...
   ```
   This appends to `agents.<name>.auth.accounts` in `switchroom.yaml` and immediately fans out the credentials to each agent's `.claude/credentials.json`.
4. **Restart** the affected agents so claude picks up the new credentials.

Verify with `switchroom auth account list` — shows accounts, which agents use each, health, and expiry. Account-level quota and refresh state replaces the per-agent view: when one account hits its 5-hour cap, every agent on it is failed over together.

**Telegram parity** — the same flow works from inside a chat:

```
/auth login                          # current agent, existing slot flow
/auth account add work-pro           # lifts current agent → global account
/auth enable work-pro <other-agent>  # wires another agent to the same account
```

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
  /switchroom restart <name> Restart an agent (drain by default)
  /switchroom status         Show per-agent auth status
  /switchroom accounts       List Anthropic accounts + which agents use each
  /switchroom memory <query> Search agent memory
  /switchroom vault list     List vault secrets
  /switchroom topics         List Telegram topics

Fleet operations (run directly, not via /switchroom <sub>):
  switchroom update          Pull latest + reconcile + restart everything
  switchroom version         Show versions + running agent health summary
  switchroom auth refresh-accounts  Refresh OAuth tokens + fan out (cron entrypoint)
```
