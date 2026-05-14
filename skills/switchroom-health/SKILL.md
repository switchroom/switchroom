---
name: switchroom-health
description: >
  Use for diagnosing switchroom problems and running health checks across the
  full stack. HARD PREFIX TRIGGER: any message starting with "For switchroom
  doctor / health," — regardless of what follows — MUST use this skill
  immediately. Beyond that prefix, use when the user: reports something is wrong
  with agents, wants to verify their setup works, asks to diagnose or
  troubleshoot, says agents are failing/broken/crashing/acting weird, or asks
  "what's wrong" without a specific crash to investigate. Checks CLI, auth,
  docker containers, agent files, bot tokens, and memory backend. Do NOT use
  for: per-agent status/uptime listing (switchroom-status), restart or interrupt
  actions (switchroom-runtime), or fresh installs (switchroom-install). Do NOT
  use when message starts with "In switchroom (the CLI)," — that prefix always
  routes to switchroom-cli, even if the body mentions diagnosis or errors.
---

# Agent Health Diagnostics

When the user reports an agent failing, says their agents are broken, asks "what's wrong with my agent(s)", mentions errors, asks to diagnose, or asks to troubleshoot the setup, run this skill to perform a full health check. This skill answers the *what's wrong* question by checking the whole stack (CLI, auth, units, files, memory); defer to `switchroom-cli` (logs section) only when the user specifically asks for logs of a particular crash.

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

# Check Anthropic accounts + fleet auth state (see docs/auth.md)
# Shows accounts at ~/.switchroom/accounts/<label>/, the fleet-wide active
# account, and per-account health (healthy / quota-exhausted / expired /
# missing-refresh-token). The auth-broker is the sole writer of credentials.
switchroom auth list 2>/dev/null || echo "FAIL: auth check failed"

# Full snapshot — fleet + per-agent effective accounts + consumers
switchroom auth show 2>/dev/null || echo "INFO: switchroom auth show unavailable"

# Check docker-compose service health
docker compose -p switchroom -f ~/.switchroom/compose/docker-compose.yml ps 2>/dev/null || echo "no switchroom docker fleet"

# Check for unhealthy or exited containers
docker compose -p switchroom -f ~/.switchroom/compose/docker-compose.yml ps --status exited --status unhealthy 2>/dev/null

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
2. **Docker fleet** — containers running, no unhealthy/exited services
3. **Agent files** — start.sh, .mcp.json, settings.json present
4. **Bot tokens** — Telegram credentials resolved
5. **Memory backend** — Hindsight reachable

## Step 4 — Suggest fixes

For common failures, give the exact fix:

| Problem | Fix |
|---------|-----|
| `switchroom: command not found` | `npm install -g switchroom` |
| Account expired (`auth list` shows red ✗) | `switchroom auth refresh <label>` (force a tick; broker normally handles this on its own loop). If no refresh-token, re-auth with `switchroom auth add <label> --from-oauth --replace`. |
| Account quota-exhausted (yellow ⊘ in `auth list`) | `switchroom auth rotate` cycles to the next account in `auth.fallback_order`; quota state is per-account and shared across every agent on it. |
| Fleet on the wrong account | `switchroom auth use <label>` (fleet-wide) or `switchroom auth agent override <agent> <label>` (one agent) |
| Container unhealthy | `docker compose -p switchroom -f ~/.switchroom/compose/docker-compose.yml restart switchroom-<name>` |
| Missing .mcp.json | `switchroom apply` (full reconcile + rewrite compose; bring up via `docker compose ... up -d`) or `switchroom agent reconcile <name>` (targeted) |
| Bot token unresolved | Check vault: `switchroom vault list` |
| Memory unreachable | Check Hindsight MCP server is running |

End with a tl;dr: "X issues found — Y critical, Z warnings." If all green: "All health checks passed."
