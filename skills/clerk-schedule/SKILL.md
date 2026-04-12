---
name: clerk-schedule
description: Lists cron jobs, scheduled tasks, and systemd timers with next fire times. Use when the user mentions schedules, cron, timers, recurring tasks, automation, 'what runs automatically', 'when does X run', 'automated tasks', or 'what tasks are configured'.
---

# Scheduled Tasks

When the user asks about scheduled tasks, cron jobs, timers, or what runs automatically — show them the full picture: active systemd timers AND the schedule entries from clerk.yaml.

## Live Timer Data

Current systemd timers:

```
!`systemctl --user list-timers "clerk-*" --no-pager 2>/dev/null || echo "no timers found"`
```

## Step 1 — Parse the timer output

For each timer in the output above, extract:
- Timer name (e.g. `clerk-assistant-cron-0.timer`)
- **Next** fire time
- **Last** fire time
- **Passed** (how long ago it last ran)
- Service unit name

## Step 2 — Read clerk.yaml for prompts

Find and read `~/.clerk/clerk.yaml` (or `$CLERK_CONFIG`). For each schedule entry in the file, show:
- Which agent it belongs to
- The cron expression
- The prompt text (truncated to ~100 chars if long)
- The model (or "default: sonnet" if not specified)

## Step 3 — Cross-reference

Match each systemd timer to its clerk.yaml entry. A timer named `clerk-<agent>-cron-<N>` corresponds to the Nth schedule entry for `<agent>`.

## Step 4 — Display

Show as a table or structured list:

```
Scheduled Tasks
───────────────────────────────────────────────────────
assistant / cron-0
  cron:    0 8 * * 1-5  (weekdays 8:00 AM)
  prompt:  "Morning briefing: today's calendar, top priorities, and blockers"
  model:   claude-sonnet-4-6 (default)
  next:    Mon 2026-04-13 08:00:00
  last:    Fri 2026-04-10 08:00:00 (2 days ago) — OK

coach / cron-0
  cron:    0 8 * * *  (daily 8:00 AM)
  prompt:  "Good morning check-in: ask about sleep, energy, and plans for today"
  model:   claude-sonnet-4-6 (default)
  next:    Sun 2026-04-12 08:00:00
  last:    Sat 2026-04-11 08:00:00 (22 hours ago) — OK
```

## Step 5 — Warn on issues

- Timer exists in systemd but not in clerk.yaml (stale, should be removed with `clerk agent reconcile`)
- Entry in clerk.yaml but no systemd timer (not installed, run `clerk agent reconcile <name>`)
- Last run resulted in a non-zero exit (fetch with `journalctl --user -u <unit> -n 5 --no-pager`)
- Next fire time is far in the past (timer may be stuck)

## Useful follow-up commands

```bash
# Check last run output for a specific task
journalctl --user -u clerk-<agent>-cron-<N>.service --no-pager -n 20

# Manually trigger a task now
systemctl --user start clerk-<agent>-cron-<N>.service

# Check if a timer is enabled
systemctl --user is-enabled clerk-<agent>-cron-<N>.timer
```

Tell the user these commands if they want to investigate a specific task.
