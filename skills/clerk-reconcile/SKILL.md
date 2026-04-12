---
name: clerk-reconcile
description: Re-applies clerk.yaml configuration to existing agents. Updates settings.json, start.sh, .mcp.json, sub-agent files, and cron scripts without touching CLAUDE.md. Use when the user changed clerk.yaml, asks to 'apply config', 'update settings', 'reconcile', or 'sync my config'.
allowed-tools: Bash(clerk *)
---

# Agent Reconcile

When the user changes `clerk.yaml` and wants to apply it, or asks to reconcile/sync config — use this skill to re-apply configuration to one or all agents.

## Step 1 — Understand scope

Determine whether to reconcile:
- **One agent**: user named a specific agent
- **All agents**: user said "all", "everything", or didn't specify

## Step 2 — Show what will change

Before reconciling, read the current `~/.clerk/clerk.yaml` (or `$CLERK_CONFIG`) and describe what will be updated:

For **one agent** (`<name>`):
- Scan `agents.<name>` and its inherited profile/defaults
- List the files that reconcile touches: `start.sh`, `settings.json`, `.mcp.json`, `.claude/agents/*.md` (sub-agents), `telegram/cron-N.sh`, systemd timers

For **all agents**:
- List every agent in `agents:` and note "same files for each"

## Step 3 — Confirm with the user

**Before reconciling, tell the user what will be updated and ask for confirmation.**

Example: "I'll reconcile the **dev** agent — updating `start.sh`, `settings.json`, `.mcp.json`, and sub-agent files from clerk.yaml. CLAUDE.md will not be touched. Confirm?"

Only proceed after an affirmative reply.

## Step 4 — Reconcile

For a single agent:
```bash
clerk agent reconcile <name>
```

For all agents:
```bash
clerk agent reconcile --all
```

If `reconcile` isn't available, try:
```bash
clerk agent apply <name>
```

## Step 5 — Report results

Show the output from the reconcile command. Highlight:
- Files updated (✓)
- Files unchanged (—)
- Errors (✗)

If systemd timers were updated, note that they're live immediately — no restart needed for timers.

If `start.sh` or `.mcp.json` changed, suggest restarting the affected agents: "The agent's startup script changed. Restart it to apply? (`clerk agent restart <name>`)"

## What reconcile does NOT touch

- `CLAUDE.md` — never overwritten after initial scaffold (protects customizations)
- `telegram/history.db` — conversation history preserved
- `access.json` — access control list preserved
- Hindsight memory banks — not affected

## When to use reconcile vs restart

| Changed | Action |
|---------|--------|
| `model`, `tools`, `env`, `hooks`, `skills` | Reconcile + restart |
| `schedule` (add/remove tasks) | Reconcile only (timers update live) |
| `system_prompt_append`, `claude_md_raw` | Reconcile + restart (only affects new sessions) |
| `subagents` | Reconcile only (Claude Code reads sub-agent files per-session) |
| `mcp_servers` | Reconcile + restart |
