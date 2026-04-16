---
name: switchroom-health
description: Runs a health check and diagnostics on the switchroom setup. Use when the user says 'my agent keeps failing', 'my agents are broken', "what's wrong with my agents", 'agent keeps crashing', 'health check', 'diagnose', 'troubleshoot', "something's wrong", 'can you check my setup', or wants to verify everything is working correctly. Prefer this over logs when the user is reporting a generic failure and wants to know *what* is wrong, not *why* a specific crash happened.
---

# Agent Health Diagnostics

When the user reports an agent failing, says their agents are broken, asks "what's wrong with my agent(s)", mentions errors, asks to diagnose, or asks to troubleshoot the setup, run this skill to perform a full health check. This skill answers the *what's wrong* question by checking the whole stack (CLI, auth, units, files, memory); use `switchroom-logs` only when the user specifically asks for logs of a particular crash.

## Step 1 — Run switchroom doctor

```bash
switchroom doctor --json 2>/dev/null || switchroom doctor 2>/dev/null || echo "switchroom doctor unavailable"
```

If `switchroom doctor` doesn't exist, fall back to manual checks (Step 2).

## Step 2 — Manual checks (if doctor unavailable)

Run these diagnostics with Bash:

```bash
# Check switchroom CLI version
switchroom --version 2>/dev/null || echo "FAIL: switchroom not found"

# Check auth status
switchroom auth status 2>/dev/null || echo "FAIL: auth check failed"

# Check systemd units
systemctl --user list-units "switchroom-*" --no-pager 2>/dev/null || echo "no switchroom systemd units"

# Check for failed units
systemctl --user list-units "switchroom-*" --state=failed --no-pager 2>/dev/null

# Check MCP config exists for each agent
for dir in ~/.switchroom/agents/*/; do
  name=$(basename "$dir")
  if [ -f "$dir/.mcp.json" ]; then
    echo "OK: $name .mcp.json present"
  else
    echo "WARN: $name missing .mcp.json"
  fi
  if [ -f "$dir/start.sh" ]; then
    echo "OK: $name start.sh present"
  else
    echo "FAIL: $name missing start.sh"
  fi
done

# Check bot tokens are set (not empty)
for dir in ~/.switchroom/agents/*/; do
  name=$(basename "$dir")
  if grep -q "TELEGRAM_BOT_TOKEN=" "$dir/start.sh" 2>/dev/null; then
    token=$(grep "TELEGRAM_BOT_TOKEN=" "$dir/start.sh" | head -1 | cut -d= -f2- | tr -d '"')
    if [ -z "$token" ] || [ "$token" = "vault:telegram-bot-token" ]; then
      echo "WARN: $name bot token may not be resolved"
    else
      echo "OK: $name bot token set"
    fi
  fi
done

# Check Hindsight MCP reachable
switchroom memory search "test" --agent assistant 2>/dev/null && echo "OK: memory search works" || echo "WARN: memory search failed"
```

## Step 3 — Interpret and report

For each check, report:
- **PASS** — green light, all good
- **WARN** — something unusual but not necessarily broken
- **FAIL** — action required

Group findings by category:
1. **CLI & Auth** — switchroom installed, authenticated
2. **Systemd units** — services running, no failed units
3. **Agent files** — start.sh, .mcp.json, settings.json present
4. **Bot tokens** — Telegram credentials resolved
5. **Memory backend** — Hindsight reachable

## Step 4 — Suggest fixes

For common failures, give the exact fix:

| Problem | Fix |
|---------|-----|
| `switchroom: command not found` | `npm install -g switchroom-ai` |
| Auth expired | `switchroom auth login` |
| Unit failed | `systemctl --user reset-failed switchroom-<name>`, then restart |
| Missing .mcp.json | `switchroom agent reconcile <name>` |
| Bot token unresolved | Check vault: `switchroom vault list` |
| Memory unreachable | Check Hindsight MCP server is running |

End with a tl;dr: "X issues found — Y critical, Z warnings." If all green: "All health checks passed."
