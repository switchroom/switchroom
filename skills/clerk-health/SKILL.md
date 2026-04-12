---
name: clerk-health
description: Runs diagnostic health checks on clerk agents — dependencies, config validity, MCP wireup, auth tokens, memory backends, systemd units. Use when something seems broken, the user mentions errors, asks to diagnose or troubleshoot, or asks 'what's wrong'.
---

# Agent Health Diagnostics

When the user reports something broken, mentions errors, asks to diagnose, or asks "what's wrong with my agents", run this skill to perform a full health check.

## Step 1 — Run clerk doctor

```bash
clerk doctor --json 2>/dev/null || clerk doctor 2>/dev/null || echo "clerk doctor unavailable"
```

If `clerk doctor` doesn't exist, fall back to manual checks (Step 2).

## Step 2 — Manual checks (if doctor unavailable)

Run these diagnostics with Bash:

```bash
# Check clerk CLI version
clerk --version 2>/dev/null || echo "FAIL: clerk not found"

# Check auth status
clerk auth status 2>/dev/null || echo "FAIL: auth check failed"

# Check systemd units
systemctl --user list-units "clerk-*" --no-pager 2>/dev/null || echo "no clerk systemd units"

# Check for failed units
systemctl --user list-units "clerk-*" --state=failed --no-pager 2>/dev/null

# Check MCP config exists for each agent
for dir in ~/.clerk/agents/*/; do
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
for dir in ~/.clerk/agents/*/; do
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
clerk memory search "test" --agent assistant 2>/dev/null && echo "OK: memory search works" || echo "WARN: memory search failed"
```

## Step 3 — Interpret and report

For each check, report:
- **PASS** — green light, all good
- **WARN** — something unusual but not necessarily broken
- **FAIL** — action required

Group findings by category:
1. **CLI & Auth** — clerk installed, authenticated
2. **Systemd units** — services running, no failed units
3. **Agent files** — start.sh, .mcp.json, settings.json present
4. **Bot tokens** — Telegram credentials resolved
5. **Memory backend** — Hindsight reachable

## Step 4 — Suggest fixes

For common failures, give the exact fix:

| Problem | Fix |
|---------|-----|
| `clerk: command not found` | `npm install -g clerk-ai` |
| Auth expired | `clerk auth login` |
| Unit failed | `systemctl --user reset-failed clerk-<name>`, then restart |
| Missing .mcp.json | `clerk agent reconcile <name>` |
| Bot token unresolved | Check vault: `clerk vault list` |
| Memory unreachable | Check Hindsight MCP server is running |

End with a tl;dr: "X issues found — Y critical, Z warnings." If all green: "All health checks passed."
