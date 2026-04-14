# Clerk vs OpenClaw — an OpenClaw alternative that works with Claude Pro/Max

If you came here because OpenClaw stopped working with your Claude subscription, or because you don't want to run Docker containers per agent, Clerk is built for the same use case with a different set of tradeoffs.

## TL;DR

- **Clerk uses your Claude Pro/Max subscription via OAuth.** OpenClaw requires an Anthropic API key and bills per token.
- **Clerk runs the unmodified `claude` CLI.** OpenClaw runs a custom runtime that re-implements parts of Claude Code.
- **Clerk uses systemd units.** OpenClaw uses Docker containers per agent.
- **Clerk has a YAML config cascade** (defaults → profiles → per-agent). OpenClaw uses per-agent JSON/TOML files.

## Side-by-side

| | Clerk | OpenClaw |
|---|---|---|
| Auth | Claude Pro/Max OAuth | Anthropic API key |
| Billing | Your existing subscription | Per-token API billing |
| Runtime | Official `claude` CLI | Custom runtime |
| Isolation | systemd unit per agent | Docker container per agent |
| Channels | Telegram (enhanced fork with 10 MCP tools) | WhatsApp, Telegram, Slack |
| Memory | Hindsight (semantic, knowledge graph, mental models) | File-based |
| Scheduling | systemd timers | Built-in cron engine |
| Sub-agents | Native Claude Code sub-agents | Custom orchestration |
| Config | YAML with cascade + profiles | JSON/TOML per agent |
| Install | `clerk setup` wizard | `docker compose up` |
| License | MIT | — |

## Why subscription auth matters

Claude Pro is $20/month and Claude Max is $100/month. For an always-on agent fleet, that's effectively flat-rate inference. API billing for the same workload — even with prompt caching — frequently runs higher for interactive/long-running agents, and you pay per response whether the output was useful or not.

Using OAuth also means:
- The same auth flow as the desktop app, so your account history and rate limits are unified.
- No API key sitting on a server that could leak.
- No separate billing relationship with Anthropic to manage.

## Why `claude` CLI matters

OpenClaw re-implements Claude's agent loop in a custom runtime. That means when Anthropic ships a new Claude Code feature — sub-agents, skills, MCP improvements, memory tool, code execution — OpenClaw has to catch up. Clerk inherits every upstream feature the day it lands, because each agent is literally the `claude` binary.

Examples of upstream features Clerk gets for free:
- Native sub-agents (Plan, Explore, general-purpose)
- Claude-native skills
- MCP server support with all transports
- `--continue` for session continuity
- Hooks (PreToolUse, PostToolUse, Stop, UserPromptSubmit)

## Why no Docker (per agent) matters

Docker-per-agent is fine for isolation but expensive in practice:
- Container image builds and updates take minutes.
- Memory overhead per container adds up on a small VPS.
- Filesystem mounts, networking, and secret injection need per-agent configuration.
- Debugging requires `docker exec` detours.

Clerk uses systemd units. Starting an agent is `systemctl start clerk-agent@name`. Logs are `journalctl -u clerk-agent@name`. Preflight checks catch broken configs before the unit is even loaded. Worktrees handle code isolation when sub-agents need it, without containers.

## When OpenClaw might still be the right call

- You need WhatsApp or Slack channels today and don't want to wait for Clerk to ship them.
- You specifically want API-key billing for compliance/procurement reasons.
- You need the custom runtime's behavior for a feature Clerk doesn't replicate.

## Migrating from OpenClaw

1. Install Clerk: `git clone https://github.com/mekenthompson/clerk.git ~/code/clerk && cd ~/code/clerk && bun install && bun link`
2. Run `clerk setup` — the wizard handles OAuth login, Telegram bot registration, and the first agent.
3. Translate each OpenClaw agent's config into a block under `agents:` in `clerk.yaml`. Most settings have a direct equivalent; see [configuration.md](configuration.md).
4. Import memory: if you stored anything in OpenClaw's file-based memory, `clerk memory` can ingest arbitrary text into a Hindsight bank.
5. Point your existing Telegram bot token at Clerk (or create a new bot), and `clerk agent start` each agent.

## See also

- [Configuration reference](configuration.md)
- [Telegram plugin features](telegram-plugin.md)
- [Sub-agents](sub-agents.md)
- [Compliance attestation](compliance-attestation.md)
