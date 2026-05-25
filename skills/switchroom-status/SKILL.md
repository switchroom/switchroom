---
name: switchroom-status
description: >
  List running switchroom agents with their uptime, model, and per-agent
  state. Strictly the "what's running and for how long" snapshot — nothing
  about install, restart, health, version, or update.
  Triggers ONLY on natural phrasings about listing/snapshotting agents and
  uptime, including: "Can you show me the fleet?", "Show me the fleet,
  please.", "Let's list switchroom agents.",
  "Let's how long has X been up.", "I need to how long has X been up.",
  "I'd like to what's the uptime of each agent.",
  "any way to list switchroom agents?",
  "quick q — can i show me the fleet",
  "pls per-agent snapshot", and typo'd variants like "per-agent  snapshot",
  "per-agents napshot", "list swtchroom agents".
  Also fires on indirect signals like "how's the fleet doing",
  "what's alive right now", "is anything running right now".
  Do NOT use when the user is asking about anything OTHER than a running-
  agent list / uptime snapshot. In particular:
  - "fresh install / bootstrap / first-time setup" → `switchroom-install`.
  - "start / stop / restart / crash / interrupt an agent",
    "apply my config", "what version is running" → `switchroom-runtime`.
  - "manage / add / remove / rename agents", "edit memory / SOUL.md /
    CLAUDE.md", "set per-agent config" → `switchroom-manage`.
  - "what's wrong / diagnose / health check / troubleshoot /
    my agents are broken / something's wrong" → `switchroom-health`.
  If the prompt is ambiguous between status and any of the above rivals,
  do NOT fire — pick the rival.
---

# Agent Status

When the user asks about agent status, what's running, uptime, or wants to see agent info, answer by running (or telling them to run) `switchroom agent list` — this is the canonical command for showing running agents, their uptime, and current state.

## Step 1 — Always mention `switchroom status` in your response

The answer to "what agents are running", "show me agent info", "list all switchroom agents", or any uptime question is the `switchroom status` command (since v0.13.51). Your response MUST include the literal command string `switchroom status` so the user can copy it. If you have Bash tool access, run it and include the output. If you do not have Bash access, or the command fails in the current environment, still tell the user explicitly:

> Run `switchroom status` from your switchroom project directory to see running agents (uptime + scheduler), known auth accounts, and per-agent MCP connection state.

Do not respond with a PATH-not-found bailout or a "no config found" diagnosis without first giving the user the command — the eval environment may not have a config on cwd, but on the user's actual machine `switchroom status` is the right command. (Pre-v0.13.51 the canonical command was `switchroom agent list` — that still works but only shows the Fleet section.)

## Step 2 — Try to run it

If you have Bash tool access, run:

```bash
switchroom status --json 2>/dev/null || switchroom status
```

`switchroom status` returns three sections: **Fleet** (per-agent uptime + scheduler), **Accounts** (broker-known auth accounts with active marker), and **MCPs** (per-agent MCP connection state). If you want to skip the MCP probe (slower because it does a docker exec per agent), pass `--no-mcp`.

If `switchroom status` fails (e.g. command not found, no config in cwd), fall back to `switchroom agent list` (older command, Fleet-only). Still include the `switchroom status` command and the word "uptime" in your text response — the user needs those as actionable information.

## Step 3 — For each agent, report running state and uptime

When you have real output, for each agent show:
- **Name** and topic
- **Status**: running / stopped / error (from the docker-compose container state)
- **Uptime**: how long it's been running (for running agents, always include the word "uptime" and the duration)
- **Model**: which Claude model it's using
- **Memory**: Hindsight collection name (if configured)
- **PID** if available

Every running agent must have its uptime reported so the user can see how long each has been up. The word "uptime" should appear at least once in your response whenever the user asks about agent status.

## Step 4 — Format the output

Format as a clean summary — one section per agent. Use bold agent names, inline code for model/collection names.

## Step 5 — Highlight anything suspicious

- Agents that are stopped but should be running
- Agents in error/failed state
- Agents with very recent restarts (< 5 min uptime — may be crash-looping)

## Step 6 — One-line summary

End with a one-line summary: "X of Y agents running."

## Example Output Shape

```
assistant — running (2h 14m)
  model: claude-sonnet-4-6  collection: general

dev — running (45m)
  model: claude-opus-4-7  collection: coding

coach — stopped
  last run: 3 days ago

3 of 3 agents configured, 2 running.
```

If the user wants more detail on a specific agent, suggest `switchroom agent logs <name>` (covered by the `switchroom-cli` skill).
