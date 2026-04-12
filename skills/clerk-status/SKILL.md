---
name: clerk-status
description: Shows which clerk agents are running, their uptime, and current state. Use when the user asks about status, 'what's running', uptime, 'are my agents OK', or wants an overview of all agents.
---

# Agent Status

When the user asks about agent status, what's running, or whether their agents are OK, run this skill to show a live overview of all configured clerk agents.

## Live Agent Data

Current output from `clerk agent list`:

```
!`clerk agent list --json 2>/dev/null || echo "unavailable"`
```

## Instructions

1. Parse the JSON output above. For each agent show:
   - **Name** and topic
   - **Status**: running / stopped / error (from systemd unit state)
   - **Uptime**: how long it's been running
   - **Model**: which Claude model it's using
   - **Memory**: Hindsight collection name (if configured)
   - **PID** if available

2. If the output is "unavailable" or empty, tell the user `clerk` isn't on PATH and suggest:
   ```
   npm install -g clerk-ai
   # or check that clerk is on your PATH
   ```

3. Format as a clean summary — one section per agent. Use bold agent names, inline code for model/collection names.

4. Highlight anything suspicious:
   - Agents that are stopped but should be running
   - Agents in error/failed state
   - Agents with very recent restarts (< 5 min uptime — may be crash-looping)

5. End with a one-line summary: "X of Y agents running."

## Example Output Shape

```
assistant — running (2h 14m)
  model: claude-sonnet-4-6  collection: general

dev — running (45m)
  model: claude-opus-4-6  collection: coding

coach — stopped
  last run: 3 days ago

3 of 3 agents configured, 2 running.
```

If the user wants more detail on a specific agent, suggest `clerk agent logs <name>` or ask them to use the `clerk-logs` skill.
