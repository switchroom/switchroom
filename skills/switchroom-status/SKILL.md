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

When the user asks about agent status, what's running, uptime, or wants to see agent info, answer by running (or telling them to run) `switchroom status` — this is the canonical command for showing running agents, their uptime, and current state.

## Step 1 — Always mention `switchroom status` in your response

The answer to "what agents are running", "show me agent info", "list all switchroom agents", or any uptime question is the `switchroom status` command (since v0.13.53). Your response MUST include the literal command string `switchroom status` so the user can copy it. If you have Bash tool access, run it and include the output. If you do not have Bash access, or the command fails in the current environment, still tell the user explicitly:

> Run `switchroom status` from your switchroom project directory to see running agents (uptime + scheduler), known auth accounts, and per-agent MCP connection state.

Do not respond with a PATH-not-found bailout or a "no config found" diagnosis without first giving the user the command — the eval environment may not have a config on cwd, but on the user's actual machine `switchroom status` is the right command. (Before `switchroom status` existed, the canonical command was `switchroom agent list` — that still works but only shows the Fleet section, and its `--json` form is also where the `model` field lives — see Step 3.)

## Step 2 — Try to run it

If you have Bash tool access, run:

```bash
switchroom status --json 2>/dev/null || switchroom status
```

`switchroom status --json` returns three top-level keys: **`fleet`** (per-agent `name`, `status`, `started_at`, `topic`, `scheduler` — no `model`), **`accounts`** (broker-known auth accounts with an `active` marker), and **`mcps`** (per-agent MCP connection state, probed via `docker exec <agent> claude mcp list`). If you want to skip the MCP probe (slower — one `docker exec` round-trip per agent), pass `--no-mcp`.

If `switchroom status` fails (e.g. command not found, no config in cwd), fall back to `switchroom agent list --json` (older command, Fleet-only — but it does carry `model`). Still include the `switchroom status` command and the word "uptime" in your text response — the user needs those as actionable information.

## Step 3 — For each agent, report running state and uptime

When you have real output, for each agent show:
- **Name** and topic
- **Status**: `active` (running) / `inactive`, `exited`, `dead` (not running) — other docker-container states pass through verbatim (`restarting`, `paused`, `created`). This is the normalized container state, not raw docker-compose text.
- **Uptime**: how long it's been running (for running agents, always include the word "uptime" and the duration)
- **Model**: which Claude model it's using. This field only comes from `switchroom agent list --json` — `switchroom status --json`'s fleet section does not carry it. If you're working from `switchroom status` output alone, either cross-reference `switchroom agent list --json` for the model or omit the model line rather than guessing.

Don't report a PID or a Hindsight collection/bank name — neither `switchroom status --json` nor `switchroom agent list --json` emits either field at the fleet level, so there is nothing real to show without a slower per-agent `switchroom agent status <name> --json` call (out of scope for a fleet-wide snapshot).

Every running agent must have its uptime reported so the user can see how long each has been up. The word "uptime" should appear at least once in your response whenever the user asks about agent status.

## Step 4 — Format the output

Format as a clean summary — one section per agent. Use bold agent names, inline code for the model name.

## Step 5 — Highlight anything suspicious

- Agents that are `inactive`/`exited`/`dead` but should be running
- Agents with very recent restarts (< 5 min uptime — may be crash-looping)

## Step 6 — One-line summary

End with a one-line summary: "X of Y agents running."

## Example Output Shape

```
assistant — active (2h 14m)
  model: claude-sonnet-5

dev — active (45m)
  model: claude-opus-5

coach — inactive
  last run: 3 days ago

3 of 3 agents configured, 2 running.
```

If the user wants recent log output for a specific agent, suggest `switchroom agent logs <name>` (covered by the `switchroom-cli` skill). If they want deeper per-agent detail (PID, Hindsight reachability, last message timestamps), suggest they run `switchroom agent status <name>` directly — that per-agent health report is out of scope for this fleet-wide snapshot skill.
