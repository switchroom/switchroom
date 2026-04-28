# Scheduled Tasks

Switchroom runs scheduled tasks as **systemd user timers** — reliable, OS-level, survive reboots and session crashes. Each task fires a one-shot `claude -p` call with the configured model and sends output to Telegram.

## Quick Start

```yaml
defaults:
  schedule:
    - cron: "0 8 * * 1-5"
      prompt: "Morning briefing: today's calendar, top priorities, and blockers"
    - cron: "0 20 * * 0"
      prompt: "Weekly review: summarize this week's progress and next week's goals"
      model: claude-opus-4-6    # override for important tasks
```

Run `switchroom agent create <name>` or `switchroom agent reconcile <name>` to install the timers.

## How It Works

For each schedule entry, switchroom generates:

1. **`telegram/cron-N.sh`** — self-contained bash script that:
   - Sources nvm (so `claude` is on PATH)
   - Runs `claude -p "prompt" --model <model> --no-session-persistence`
   - Sends the output to your Telegram DM via curl

2. **`switchroom-<agent>-cron-N.timer`** — systemd timer with `OnCalendar` converted from the cron expression

3. **`switchroom-<agent>-cron-N.service`** — systemd oneshot service that runs the script

## Configuration

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `cron` | Yes | — | Standard 5-field cron expression |
| `prompt` | Yes | — | The prompt sent to Claude |
| `model` | No | `claude-sonnet-4-6` | Model for this task |
| `secrets` | No | `[]` | Vault keys this task may read via the broker. See [configuration.md#vault-broker-linux-only](configuration.md#vault-broker-linux-only). |

> **`suppress_stdout` was removed in [#269](https://github.com/switchroom/switchroom/issues/269).** All cron tasks now route their Telegram message through the MCP `reply` tool — see below.

### How cron tasks deliver to Telegram

Cron-scheduled tasks run as one-shot `claude -p` invocations with no live Telegram session. The cron script:

1. Wraps the configured `prompt` with delivery guidance instructing the model to call `mcp__switchroom-telegram__reply` with the chat ID and emit `HEARTBEAT_OK` to stdout.
2. Executes `claude -p` with stdout routed to `/dev/null` so the discarded `HEARTBEAT_OK` (and any incidental model output) never reaches Telegram.
3. The MCP `reply` tool applies the same markdown→HTML conversion, smart chunking, and sanitization as a live session — output renders identically regardless of trigger.

If a cron task has nothing meaningful to say (data is dull, all signals nominal), the model emits `HEARTBEAT_OK` without calling `reply`. A silent heartbeat is correct behaviour, not an error — the user is not pinged unnecessarily.

This replaces the previous flow (raw `claude -p` stdout piped through `curl ... -d parse_mode=HTML`), which produced broken markdown rendering on phones (literal `**asterisks**`) and the duplicate-message bug tracked in [#251](https://github.com/switchroom/switchroom/issues/251).

### Cron Expression Examples

| Expression | Meaning |
|---|---|
| `0 8 * * *` | Every day at 8:00 AM |
| `0 8 * * 1-5` | Weekdays at 8:00 AM |
| `0 20 * * 0` | Sundays at 8:00 PM |
| `0 9,17 * * *` | 9:00 AM and 5:00 PM daily |
| `0 */3 * * *` | Every 3 hours |

## Model Selection

Tasks default to `claude-sonnet-4-6` (cheap, fast). Override per-task for important work:

```yaml
schedule:
  - cron: "0 8 * * 1-5"
    prompt: "Quick morning check-in"
    # uses sonnet (default) — fast, cheap

  - cron: "0 20 * * 5"
    prompt: "End-of-week deep analysis: review all PRs, summarize decisions"
    model: claude-opus-4-6
    # uses opus — complex reasoning, worth the tokens
```

## Cascade Behavior

Schedule entries are **concatenated** across cascade layers (defaults first, then profile, then agent):

```yaml
defaults:
  schedule:
    - cron: "0 8 * * 1-5"
      prompt: "Global morning briefing"

agents:
  coach:
    schedule:
      - cron: "0 7 * * *"
        prompt: "Daily check-in: sleep, energy"
```

The coach agent gets BOTH schedules: the global 8am briefing AND its own 7am check-in.

## Independence from Agent Sessions

Scheduled tasks are **not** part of the running agent session. They:

- Run as fresh one-shot `claude -p` calls (no persistent session)
- Don't consume context in the main agent's conversation
- Fire even if the agent is down, restarting, or in a broken state
- Use their own model (Sonnet by default) regardless of the agent's model

This means a scheduled task won't see the agent's conversation history or Hindsight memories. It's a clean, isolated execution — ideal for briefings, reminders, and periodic checks.

## Managing Timers

```bash
# List all active timers
systemctl --user list-timers "switchroom-*"

# Check a specific timer
systemctl --user status switchroom-assistant-cron-0.timer

# Manually trigger a scheduled task
systemctl --user start switchroom-assistant-cron-0.service

# View output from the last run
journalctl --user -u switchroom-assistant-cron-0.service --no-pager -n 20
```

## Comparison with Claude Code's Native Scheduling

| | Switchroom (systemd timers) | Claude Code CronCreate | Claude Code Desktop |
|---|---|---|---|
| **Survives restart** | Yes (OS-level) | No (session-scoped) | Yes (app must be open) |
| **Headless** | Yes | Yes | No (Desktop app only) |
| **Model selection** | Per-task | Inherits session | Per-task |
| **Context isolation** | Fully isolated | Shares session | Isolated |
| **Persistence bug** | No | Yes (#40228) | No |
