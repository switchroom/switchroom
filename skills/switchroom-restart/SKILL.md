---
name: switchroom-restart
description: Restarts or reboots switchroom agents with preflight safety checks (runs `switchroom agent restart <name>` or iterates over all agents). Use whenever the user wants to restart, reboot, refresh, bounce, 'kick', 'kill and restart', or 'stop and start' agents — whether a single named agent or "all agents". Also matches 'it seems stuck'. Do NOT use for 'reinstall my agents' or 'reprovision my agents' (those imply re-applying config — use switchroom-manage).
allowed-tools: Bash(switchroom *) Bash(systemctl --user *)
---

# Agent Restart

When the user asks to restart an agent, follow these steps carefully.

## Step 1 — Identify the agent

If the user didn't name an agent, ask: "Which agent do you want to restart?" Then list available agents:

```bash
switchroom agent list 2>/dev/null || ls ~/.switchroom/agents/
```

## Step 2 — Confirm with the user

**Before restarting, tell the user which agent you'll restart and ask for confirmation.**

Say something like: "I'll restart the **<name>** agent. This will interrupt any active conversation it has. Confirm?"

Only proceed after they say yes, confirm, ok, or similar affirmative.

## Step 3 — Preflight checks

Before restarting, verify:

```bash
AGENT_DIR="$HOME/.switchroom/agents/<name>"

# Check start.sh exists and is executable
[ -x "$AGENT_DIR/start.sh" ] && echo "OK: start.sh" || echo "FAIL: start.sh missing or not executable"

# Check settings.json exists
[ -f "$AGENT_DIR/settings.json" ] && echo "OK: settings.json" || echo "WARN: settings.json missing"

# Check .mcp.json exists
[ -f "$AGENT_DIR/.mcp.json" ] && echo "OK: .mcp.json" || echo "WARN: .mcp.json missing"

# Check systemd unit is known
systemctl --user cat "switchroom-<name>.service" &>/dev/null && echo "OK: systemd unit exists" || echo "WARN: no systemd unit"

# Check bot token in start.sh is not empty/placeholder
grep -q "TELEGRAM_BOT_TOKEN=" "$AGENT_DIR/start.sh" && echo "OK: bot token field present" || echo "WARN: no bot token in start.sh"
```

If any **FAIL** check fires, abort and tell the user: "Preflight failed — [issue]. Run `switchroom agent reconcile <name>` first."

Warnings (WARN) are informational — proceed unless the user says stop.

## Step 4 — Restart

```bash
switchroom agent restart <name>
```

If `switchroom agent restart` isn't available:

```bash
systemctl --user restart "switchroom-<name>.service"
```

## Step 5 — Verify

Wait a moment, then check the new status:

```bash
systemctl --user status "switchroom-<name>.service" --no-pager -n 10
```

Report back:
- **Success**: "Agent **<name>** restarted successfully. It's been running for Xs."
- **Failure**: Show the last 10 journal lines and suggest `switchroom agent logs <name>` for more.

## Error recovery

If restart fails with a failed unit:

```bash
systemctl --user reset-failed "switchroom-<name>.service"
systemctl --user start "switchroom-<name>.service"
```
