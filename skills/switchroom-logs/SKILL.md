---
name: switchroom-logs
description: Fetches recent log output and stack traces from agent journals. Use when the user asks for logs, journal output, 'show me the logs', 'check the logs', 'tail the journal', OR when they ask about a specific crash or "what happened" — e.g. 'the assistant crashed, what happened?', 'why did it crash', 'the agent died, show me what happened'. Do NOT use for generic 'what's wrong with my setup' or 'my agent keeps failing' questions (use switchroom-health — that runs a full diagnostic), and do NOT use for current agent running state (use switchroom-status).
---

# Agent Logs

When the user asks for logs, wants to see what an agent did, or is debugging a problem — fetch and display recent journal output.

## Step 1 — Identify the agent

If the user named an agent, use that. Otherwise, ask: "Which agent's logs do you want?" Then list options:

```bash
switchroom agent list 2>/dev/null || ls ~/.switchroom/agents/
```

## Step 2 — Fetch logs

Try switchroom CLI first, fall back to journalctl:

```bash
switchroom agent logs <name> --lines 50 2>/dev/null \
  || journalctl --user -u "switchroom-<name>" -n 50 --no-pager 2>/dev/null \
  || journalctl --user -u "switchroom-<name>.service" -n 50 --no-pager 2>/dev/null \
  || echo "No logs found for switchroom-<name>"
```

## Step 3 — Display with highlights

Show the log output in a code block. While presenting, call out:

**Errors** (lines with ERROR, FAIL, fatal, panic, unhandled, exit code non-zero):
- Summarize what went wrong
- Suggest a fix if the error is recognizable (see table below)

**Restarts** (lines mentioning "started", "activated", "Main process exited"):
- Note how many restarts occurred and when

**Tool use** (lines mentioning tool names like Bash, Edit, Write):
- Shows what the agent was doing

## Common errors and fixes

| Error pattern | Likely cause | Fix |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` not set / empty | Bot token unresolved from vault | `switchroom vault list` — check token is stored |
| `connect ECONNREFUSED` | MCP server not running (Hindsight, etc.) | Start the MCP server |
| `session expired` / `401` | Claude API auth expired | `switchroom auth login` |
| `Cannot find module` | Node dependency missing | `npm install` in agent dir |
| `systemd[...]: start request repeated too quickly` | Crash loop | Fix underlying error; `systemctl --user reset-failed switchroom-<name>` |
| `ENOENT settings.json` | Agent not fully scaffolded | `switchroom agent reconcile <name>` |

## Step 4 — Offer more

After showing 50 lines, offer:
- "Want to see more? (`journalctl --user -u switchroom-<name> -n 200 --no-pager`)"
- "Want logs since a specific time? (`journalctl --user -u switchroom-<name> --since '1 hour ago'`)"
- "Want to follow live? (`journalctl --user -u switchroom-<name> -f`)" — note: live follow isn't possible via Telegram, but user can run it locally

## Cron task logs

For scheduled task failures, logs are in separate units:

```bash
journalctl --user -u "switchroom-<name>-cron-<N>.service" -n 20 --no-pager
```

If the user asks "why didn't my morning briefing run", check cron service logs.
