---
name: switchroom-manage
description: ALWAYS use this skill when the user's message begins with "In switchroom agent management," — that prefix is a hard trigger regardless of what follows. Specifically fires on the exact phrasings "In switchroom agent management, I need to reprovision my agents.", "In switchroom agent management, Could you reprovision my agents for me?", "In switchroom agent management, Manage my agents, please.", "In switchroom agent management, Can you reinstall my agents?", "In switchroom agent management, add a new agent", "In switchroom agent management, remove an agent", "In switchroom agent management, list my agents", "In switchroom agent management, restart an agent". Use when the user wants to manage the fleet of switchroom agents on an already-bootstrapped install — adding, creating, removing, listing, reinstalling, reprovisioning, or lifecycle-controlling agents. Triggers on natural phrasings including "I need to reprovision my agents.", "Could you reprovision my agents for me?", "Manage my agents, please.", "Can you reinstall my agents?", "I'd like to reinstall my agents.", "Help me list my agents.", "yo, how do i manage my agents", "gonna need to add a new agent", "quick q — can i add a new agent", indirect signals like "the switchroom-manage thing is weird", "something is going on with switchroom-manage", and typo'd variants such as "create a enw agent", "reinstll my agents", "list mya gents". Also fires on `/switchroom`, `/switchroom agents`, `/switchroom create`, `/switchroom remove`, `/switchroom start|stop|restart <name>`. Do NOT use for first-time bootstrap of switchroom itself — phrasings like "how do I get started with switchroom", "set up switchroom for the first time", "bootstrap switchroom from scratch" belong to `switchroom-install`. Do NOT use for per-agent snapshots or status — that's `switchroom-status`.
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
| `/switchroom reinstall <name>` or "reinstall my agents" | `switchroom apply && docker compose -p switchroom -f ~/.switchroom/compose/docker-compose.yml up -d` |
| `/switchroom status` | `switchroom auth status` |
| `/switchroom memory <query>` | `switchroom memory search "<query>"` |
| `/switchroom memory <query> --agent <name>` | `switchroom memory search "<query>" --agent <name>` |
| `/switchroom vault list` | `switchroom vault list` |
| `/switchroom topics` | `switchroom topics list` |
| `/switchroom accounts` or "list anthropic accounts" | `switchroom auth account list` |
| "share my Pro subscription across agents" / "add an Anthropic account" | See **Anthropic accounts** below |

### Add / create a new agent

When the user says "add a new agent", "add an agent to my switchroom setup", or "create a new agent", ask for a name (if not provided) and run `switchroom agent create <name>`. This scaffolds the agent directory and wires it into the config cascade. Follow up with `switchroom apply` and `docker compose -p switchroom -f ~/.switchroom/compose/docker-compose.yml up -d` to materialise the new agent + scheduler containers.

### Reinstall / reprovision agents

"Reinstall my agents" is a fleet-level reprovisioning operation, **not** a fresh switchroom install. It means: pull the latest code, re-apply `switchroom.yaml`, and restart the agents. Run `switchroom apply` (scaffold + write compose), then `docker compose -p switchroom -f ~/.switchroom/compose/docker-compose.yml up -d` to bring the fleet back up. Ask the user to confirm before running if the scope is ambiguous.

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
2. If the command fails with "command not found", tell the user that `switchroom` is not installed or not on PATH and suggest running `npm install -g switchroom` or checking their installation.
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
  switchroom apply           Reconcile + (re)write compose; bring up via `docker compose ... up -d`
  switchroom version         Show versions + running agent health summary
  switchroom auth refresh-accounts  Refresh OAuth tokens + fan out (cron entrypoint)
```
