---
name: switchroom-manage
description: Manage the fleet of switchroom agents on an already-bootstrapped install — adding, creating, removing, listing, reinstalling, reprovisioning, or lifecycle-controlling agents. HARD PREFIX TRIGGER: whenever the user's message starts with the phrase "In switchroom agent management," — regardless of what follows — use this skill. That prefix is load-bearing and wins over `switchroom-install`, `switchroom-runtime`, `switchroom-cli`, and `switchroom-health`; even probes like "In switchroom agent management, Can you reinstall my agents?", "In switchroom agent management, I need to reprovision my agents.", and "In switchroom agent management, Could you reprovision my agents for me?" MUST route here — NOT to switchroom-install (despite the word "reinstall") and NOT to switchroom-runtime (despite touching agent lifecycle). The word "reinstall" inside the agent-management prefix means re-provision an EXISTING agent on an ALREADY-installed switchroom host; it does not mean a fresh host bootstrap. Use when the user wants to "reprovision my agents", "reinstall my agents", "manage my agents", "add a new agent", "remove an agent", "list my agents", or "restart an agent". Triggers on phrasings including "I need to reprovision my agents.", "Could you reprovision my agents for me?", "Manage my agents, please.", "Can you reinstall my agents?", "I'd like to reinstall my agents.", "Help me list my agents.", "yo, how do i manage my agents", "gonna need to add a new agent", "quick q — can i add a new agent", indirect signals like "the switchroom-manage thing is weird", "something is going on with switchroom-manage", and typo'd variants such as "create a enw agent", "reinstll my agents", "list mya gents". Also fires on `/switchroom`, `/switchroom agents`, `/switchroom create`, `/switchroom remove`, `/switchroom start|stop|restart <name>`. Do NOT use for first-time bootstrap of switchroom itself when there is NO "In switchroom agent management," prefix — phrasings like "how do I get started with switchroom", "set up switchroom for the first time", "bootstrap switchroom from scratch" belong to `switchroom-install`. Do NOT use for per-agent snapshots or status — that's `switchroom-status`. Do NOT use for "why did you restart" / agent self-state questions without the management prefix — that's `switchroom-runtime`.
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
| `/switchroom status` | `switchroom auth show` |
| `/switchroom memory <query>` | `switchroom memory search "<query>"` |
| `/switchroom memory <query> --agent <name>` | `switchroom memory search "<query>" --agent <name>` |
| `/switchroom vault list` | `switchroom vault list` |
| `/switchroom topics` | `switchroom topics list` |
| `/switchroom accounts` or "list anthropic accounts" | `switchroom auth list` |
| "share my Pro subscription across agents" / "add an Anthropic account" | See **Anthropic accounts** below |

### Add / create a new agent

When the user says "add a new agent", "add an agent to my switchroom setup", or "create a new agent", ask for a name (if not provided) and run `switchroom agent create <name>`. This scaffolds the agent directory and wires it into the config cascade. Follow up with `switchroom apply` and `docker compose -p switchroom -f ~/.switchroom/compose/docker-compose.yml up -d` to materialise the new agent + scheduler containers.

### Reinstall / reprovision agents

"Reinstall my agents" is a fleet-level reprovisioning operation, **not** a fresh switchroom install. It means: pull the latest code, re-apply `switchroom.yaml`, and restart the agents. Run `switchroom apply` (scaffold + write compose), then `docker compose -p switchroom -f ~/.switchroom/compose/docker-compose.yml up -d` to bring the fleet back up. Ask the user to confirm before running if the scope is ambiguous.

### Anthropic accounts (one OAuth, many agents)

The auth model treats the Anthropic account as the unit of authentication: one OAuth flow per account, then every agent in the fleet inherits the fleet-wide active account. The `switchroom-auth-broker` daemon owns the refresh loop and is the sole writer of every `credentials.json`. See `docs/auth.md` for the operator guide and `reference/share-auth-across-the-fleet.md` for the design.

**Bootstrap flow when the user wants to share one Pro/Max subscription across agents:**

1. **Add the account** (one OAuth flow, ever):
   ```bash
   switchroom auth add work-pro --from-oauth
   ```
   Alternatively, seed from an already-authenticated agent's credentials: `switchroom auth add work-pro --from-agent <existing-agent>`.
2. **Activate it fleet-wide:**
   ```bash
   switchroom auth use work-pro
   ```
   This sets `auth.active: work-pro` in `switchroom.yaml`. Every agent inherits on next refresh-read — no per-agent enable step needed.
3. The broker fans out the credentials to each agent's `.claude/credentials.json` automatically. No manual restart required in the common case.

Verify with `switchroom auth list` — shows accounts, health, and which one is fleet-active. Quota / 429 events propagate per-account: when one account is exhausted, the broker fails the fleet over to the next entry in `auth.fallback_order` automatically (or run `switchroom auth rotate` to force a cycle).

**Edge case — per-agent override.** If one agent needs a different account than the fleet active (e.g. a personal-only experiment running on `personal-max`), use:

```bash
switchroom auth agent override klanker personal-max
switchroom auth agent override klanker --clear   # back to fleet active
```

**Telegram parity** — three commands from any agent's chat:

```
/auth show                # read-only fleet snapshot, open to any agent
/auth use work-pro        # admin agents only
/auth rotate              # admin agents only — cycle fallback_order
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
  /switchroom status         Show fleet auth state (active account, agents, health)
  /switchroom accounts       List Anthropic accounts + health
  /switchroom memory <query> Search agent memory
  /switchroom vault list     List vault secrets
  /switchroom topics         List Telegram topics

Fleet operations (run directly, not via /switchroom <sub>):
  switchroom apply           Reconcile + (re)write compose; bring up via `docker compose ... up -d`
  switchroom version         Show versions + running agent health summary
  switchroom auth refresh    Force a refresh tick (diagnostic; broker owns the loop)
```
