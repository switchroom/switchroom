---
name: switchroom-cli
description: "Run switchroom CLI operations on existing agents: logs, update, restart, version, config inspection, scheduled tasks, and Telegram plugin reference. Use when the user wants to: show logs (\"logs\", \"what happened\", \"check the journal\", \"why did it crash\"); update agents (\"update\", \"pull latest\", \"get new code\", \"upgrade\"); restart agents (\"restart\", \"reboot\", \"bounce\", \"kick\", \"it's stuck\"); check what's running (\"version\", \"what sha\", \"are agents up\", \"health summary\"); apply config changes (\"apply\", \"sync my config\", \"I just edited switchroom.yaml\"); inspect an agent's effective config (\"what model is X using\", \"how is <agent> configured\", \"show the cascade\"); list scheduled tasks (\"cron\", \"timers\", \"what runs automatically\", \"scheduled tasks\"); or ask about Telegram-plugin features (\"what MCP tools does the bot have\", \"how does reply work\"). Do NOT use for adding/removing agents (switchroom-manage), bootstrapping switchroom from scratch (switchroom-install), or \"something is broken\" diagnostics (switchroom-health).
allowed-tools: Bash(switchroom *) Bash(systemctl --user *) Bash(journalctl *)
---

# Switchroom CLI operations

This skill is the reference for running `switchroom` CLI commands against existing agents. Each section below is triggered by a distinct user intent — jump to the relevant one rather than walking top-to-bottom.

**Three commands to know:**
- `switchroom update` — picks up new code (pull, rebuild, reconcile, restart)
- `switchroom restart [agent]` — bounces a stuck or wedged agent
- `switchroom version` — shows what's running (versions + health summary)

**Prerequisite:** the `switchroom` CLI must be on `PATH`. If it isn't, direct the user to the `switchroom-install` skill.

---

## Logs — "show me the logs", "what happened", "why did it crash"

Fetch recent journal output when the user wants to see what an agent did or is debugging a specific crash.

### Step 1 — Identify the agent

If the user didn't name one, ask: *"Which agent do you want logs for?"* Then list available agents:

```bash
switchroom agent list
```

### Step 2 — Tail the logs

Default is the last 20 lines. User can specify a number. Use the CLI if available; fall back to `journalctl` when it's not:

```bash
switchroom agent logs <name> [--lines 50]
# or, when switchroom CLI isn't reachable:
journalctl --user -u switchroom-<name>.service -n 50 --no-pager
```

### Step 3 — Present output

Include the last ~20 lines verbatim, then summarise what you see (crash, stall, normal chatter). If the user asked "why did it crash" and you don't see a clear cause, say so and offer `/doctor` as the next step.

---

## Update — "update", "pull latest", "get new code", "upgrade"

Pull the latest switchroom source, rebuild the CLI binary, reconcile all agents, and restart everything.

```bash
switchroom update
```

This is the single command for "running the latest code". It:
1. `git pull` the switchroom repo
2. Reinstalls deps if package.json changed
3. Regenerates systemd units
4. Reconciles all agent config from switchroom.yaml
5. Restarts all agents that need it
6. Prints a one-line health summary when done

**Idempotent**: running twice = first does work, second is a fast no-op.

---

## Restart — "restart", "reboot", "bounce", "it's stuck"

Restart one agent or all. Also covers "refresh", "kick", "kill and restart", "stop and start".

### Step 1 — Identify the agent

If the user didn't name one, ask which. Accept `all` or no argument as "all agents".

### Step 2 — Run the restart

```bash
# Restart a specific agent (drains in-flight turn by default):
switchroom restart <name>

# Restart all agents:
switchroom restart

# Skip drain — SIGTERM immediately:
switchroom restart <name> --force
```

The `switchroom restart` top-level command reconciles + restarts and prints the health summary. It uses drain semantics by default (waits up to 60s for an in-flight turn to complete before cycling).

For the lower-level per-agent restart without reconcile, `switchroom agent restart <name>` is also available.

### Step 3 — Confirm

Report the outcome. If the agent is being restarted via Telegram (`/restart` handler), the user will see a `🔄 Restarting <name>…` ack followed by a `🎛️ Switchroom restarted — ready` message. Don't double-post.

---

## Version / health summary — "version", "what sha", "are agents up", "health check"

Show switchroom version, claude-code version, and the running status of all agents.

```bash
switchroom version
```

Output format:
```
✓ claude-code 2.1.119
✓ switchroom 0.3.0 / 7278044 (clean)
✓ klanker → up 5m, on 7278044
✓ gymbro → up 4h, on 7278044
✓ foreman → up 2d, on 7278044
```

No side effects. Safe to run at any time.

---

## Config inspection — "what model is X using", "show config for <agent>"

Surface the resolved effective config for a specific agent. Use for "how is X configured", "what tools does X have", or cascade-resolution questions.

### Step 1 — Pick the right inspector

For a high-level view (model, profile, topic, status, uptime):

```bash
switchroom agent list --json
```

For the full merged settings file (tools, hooks, MCP servers):

```bash
cat ~/.switchroom/agents/<name>/.claude/settings.json
```

For the **exact prompt + system message** an agent sends Claude on its next turn:

```bash
switchroom debug turn <name>
```

For the rendered workspace bootstrap block (CLAUDE.md, SOUL.md, skills wiring):

```bash
switchroom workspace render <name>
```

`debug turn` and `workspace render` are the authoritative answers when the user asks "why is X behaving this way" or "what is X actually being told".

### Step 2 — Explain the cascade

Agent config resolves through `defaults → extends profile → agent-specific`, with later keys winning. If the user asks *why* a value is set the way it is, walk them through which layer contributed it.

---

## Auth — "share my Pro account across agents", "auth verbs", "who's logged into what"

Two layers coexist. **Use the new account model when an operator wants one OAuth flow to drive multiple agents.** The legacy per-agent slot model still works for first-time agent auth.

### Per-agent (slot model) — first-time agent auth + the existing Telegram /auth flow

```bash
switchroom auth login <agent>          # interactive OAuth, writes to <agent>/.claude/.credentials.json
switchroom auth status                 # one row per agent
switchroom auth list <agent>           # show the agent's slot pool
switchroom auth use <agent> <slot>     # switch the agent's active slot
switchroom auth refresh-tick           # cron entrypoint for the legacy refresh loop
```

### Anthropic accounts (new model — see `reference/share-auth-across-the-fleet.md`)

The Anthropic account is the unit of authentication. One account → many agents. Storage at `~/.switchroom/accounts/<label>/`. Per-agent `.credentials.json` becomes a passive mirror that the broker keeps in sync.

```bash
# Lift an already-authenticated agent's credentials into a global account
switchroom auth account add <label> --from-agent <agent>

# Or import from a credentials.json file you already have
switchroom auth account add <label> --from-credentials <path>

switchroom auth account list           # accounts + which agents use each + health
switchroom auth account rm <label>     # refused while any agent is enabled

# Wire an account to one or more agents (writes agents.<name>.auth.accounts in switchroom.yaml + immediate fanout)
switchroom auth enable <label> <agent...>
switchroom auth disable <label> <agent...>

# Single account-refresh tick: refresh expiring tokens, fan out to enabled agents
switchroom auth refresh-accounts [--json]
```

### Schema

```yaml
agents:
  foo:
    auth:
      accounts: [work-pro, personal-max]   # ordered priority — first non-quota-exhausted wins
```

When unset, the agent uses the legacy per-agent slot path. The two are not mutually exclusive during the transition.

### Telegram parity

Every CLI verb above has a Telegram twin:

```
/auth account add <label> [--from-agent <name>]
/auth account list
/auth account rm <label>
/auth enable <label> [agents...]    — defaults to the current agent
/auth disable <label> [agents...]   — defaults to the current agent
```

`/auth login`, `/auth code`, `/auth list <agent>` etc. continue to work for the per-agent path.

### When auth-related questions come in

- "I want one Pro/Max subscription on multiple agents" → account model. Walk them through the bootstrap (`auth login` first agent → `auth account add --from-agent` → `auth enable` others).
- "An agent's auth expired" → check `switchroom auth account list` first. If the account is healthy but the agent isn't getting it, the broker fanout may be stale — `switchroom auth refresh-accounts` forces a tick.
- "I hit a quota" → `switchroom auth account list` shows quota-exhausted accounts; auto-fallback handles it if the agent has multiple accounts in priority order.

---

## Scheduled tasks — "what cron runs", "show me the timers"

List cron jobs and scheduled tasks.

### Step 1 — Show live timers

```bash
systemctl --user list-timers --all | grep switchroom
```

### Step 2 — Show declared schedule entries

From `switchroom.yaml`, the `schedule:` array under each agent specifies `cron` + `prompt` + optional `model`. Read the relevant agent block and enumerate the entries with their next-fire times.

---

## Telegram plugin reference — "what MCP tools", "how does reply work"

The `switchroom-telegram` plugin is an enhanced fork of the official Telegram MCP plugin and is the default for all switchroom agents. It exposes **10 MCP tools** (all prefixed `mcp__switchroom-telegram__`):

| Tool | Purpose |
|---|---|
| `reply` | Send a text/photo message, with optional `reply_to` for threaded quotes |
| `stream_reply` | Incrementally stream a long reply (edits the same message as tokens arrive) |
| `react` | Emoji reaction on an inbound or outbound message |
| `edit_message` | Modify an earlier bot message's text |
| `delete_message` | Remove an earlier bot message |
| `forward_message` | Forward a message from another chat |
| `pin_message` | Pin a message in the current chat |
| `send_typing` | Show the "typing…" indicator |
| `download_attachment` | Save a Telegram file attachment to the agent's inbox |
| `get_recent_messages` | Fetch recent history for context |

Additional features:
- **Status reactions** — 👀 queued → 🤔 thinking → 👨‍💻 tool → 🔥 streaming → 👍 done
- **Progress cards** — pinned, live-updating tool-step summary
- **SQLite history** — enables quote-reply defaults
- **PI-safe envelope** — inbound text wrapped in `<channel source="telegram">` for prompt-injection safety
- **Inline approvals** — tool permissions surface as ✅/❌ buttons or via `/approve` `/deny` `/pending`
- **Slash commands** — `/new`, `/reset`, `/approve`, `/deny`, `/pending`, `/restart`, `/update`, `/version`, `/logs`, `/doctor`, `/auth`, `/switchroomhelp` (see `TELEGRAM_MENU_COMMANDS` in `telegram-plugin/welcome-text.ts`)
- **`/auth`** — full auth surface inside Telegram: per-agent slot verbs (`login`/`reauth`/`code`/`add`/`use`/`list`/`rm`) AND account-shaped verbs (`account add`/`account list`/`account rm`/`enable`/`disable`). The account verbs implement the new "one Pro account, many agents" model — see the **Auth** section above.
- **Access control** — `dmPolicy: pairing | allowlist | disabled` per agent

---

## Rule of thumb

If the user is asking **"do X"**, this is your skill. If they're asking **"why is X broken"**, switch to `switchroom-health`. If they're asking **"how do I add/remove an agent"**, switch to `switchroom-manage`. If they're new and don't have switchroom yet, switch to `switchroom-install`.
