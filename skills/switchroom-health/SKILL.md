---
name: switchroom-health
description: >
  Runs a health check and diagnostics on the switchroom setup. Use when the
  user reports a generic failure or wants to verify everything is working
  correctly, and answers the "what's wrong" question by checking the whole
  stack (CLI, auth, units, files, memory).
  Triggers on natural phrasings including: "Help me run a health check.",
  "What's wrong with my agents, please.",
  "Could you what's wrong with my agents for me?",
  "I'd like to my agent keeps failing.", "Help me can you check my setup.",
  "Can you something's wrong?", "hey, can you check my setup?",
  "hey, something's wrong?", "any way to run a health check?",
  and typo'd variants like "diagnose my switchroom setup",
  "diagnose y switchroom setup", "my agets are broken".
  Also fires on indirect signals like "things feel off", "the fleet is
  sluggish", "my agents are acting weird", plus literal phrases:
  'my agent keeps failing', 'my agents are broken', 'agent keeps crashing',
  'health check', 'diagnose', 'troubleshoot', "something's wrong",
  'can you check my setup'.
  Prefer this over logs when the user is reporting a generic failure and
  wants to know *what* is wrong, not *why* a specific crash happened.
  Do NOT use for a per-agent uptime/listing snapshot (that's
  `switchroom-status`), for restart/crash/interrupt actions (that's
  `switchroom-runtime`), or for fresh install/setup (that's
  `switchroom-install`).
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

# Check auth status (per-agent legacy view)
switchroom auth status 2>/dev/null || echo "FAIL: auth check failed"

# Check Anthropic accounts (new model — see reference/share-auth-across-the-fleet.md)
# Shows accounts at ~/.switchroom/accounts/<label>/, which agents use each,
# and per-account health (healthy / quota-exhausted / expired / missing-refresh-token).
switchroom auth account list 2>/dev/null || echo "INFO: no Anthropic accounts configured (legacy per-agent slot model in use)"

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
| Per-agent auth expired (slot model) | `switchroom auth login <agent>` |
| Account expired (new model — `auth account list` shows red ✗) | `switchroom auth refresh-accounts` (one tick); if no refresh-token, the account needs re-adding |
| Account quota-exhausted (yellow ⊘ in `auth account list`) | Auto-fallback handles it if the agent has multiple accounts; otherwise wait for the reset window or `switchroom auth enable <other-account> <agent>` |
| Container unhealthy | `docker compose -p switchroom -f ~/.switchroom/compose/docker-compose.yml restart switchroom-<name>` |
| Missing .mcp.json | `switchroom apply` (full reconcile + rewrite compose; bring up via `docker compose ... up -d`) or `switchroom agent reconcile <name>` (targeted) |
| Bot token unresolved | Check vault: `switchroom vault list` |
| Memory unreachable | Check Hindsight MCP server is running |

End with a tl;dr: "X issues found — Y critical, Z warnings." If all green: "All health checks passed."
