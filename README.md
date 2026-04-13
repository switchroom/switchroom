# Clerk

**Run Claude Code agents 24/7 on a server, talk to them from Telegram.**

Clerk turns a $6/mo Linux server + your Claude Pro/Max subscription into a fleet of always-on AI agents. Each agent is a real Claude Code session — not a wrapper, not a harness, not a proxy. Clerk handles the lifecycle so you don't have to.

## Why Clerk?

**Claude Code native.** Every agent runs the unmodified `claude` CLI binary with official OAuth. No credential interception, no API key routing, no third-party inference.

**Simpler than the alternatives.** OpenClaw needs Docker containers per agent and a custom runtime. NanoClaw needs the Agents SDK and container orchestration. Clerk is `clerk setup` → talk to your agent from Telegram.

**Smart defaults, opt-in complexity.** A minimal agent is two lines of YAML:

```yaml
agents:
  assistant:
    topic_name: "General"
```

Everything else (model, tools, memory, channels, sub-agents, session policy, scheduled tasks) inherits from sensible defaults.

## What You Get

| Feature | Description |
|---------|-------------|
| **Telegram interface** | Talk to agents from your phone, anywhere |
| **Config cascade** | Defaults → profiles → per-agent. Change one line, all agents update |
| **Sub-agent delegation** | Opus plans, Sonnet implements in the background |
| **Scheduled tasks** | Cron-based, systemd timers, survive reboots |
| **Persistent memory** | Hindsight semantic memory with knowledge graphs |
| **Session continuity** | Resume sessions across restarts with freshness gating |
| **Enhanced Telegram** | 10 MCP tools, emoji reactions, message history, rich formatting |
| **Encrypted vault** | AES-256-GCM for secrets |
| **Preflight checks** | Catch broken configs before they hang |

## Compared To

| | Clerk | OpenClaw | NanoClaw |
|---|---|---|---|
| Runtime | Claude Code CLI | Custom runtime | Agents SDK |
| Auth | Pro/Max OAuth | API key | API key |
| Channels | Telegram (enhanced) | WhatsApp, TG, Slack | WhatsApp, TG, Slack |
| Memory | Hindsight (semantic) | File-based | Per-container |
| Scheduling | systemd timers | Built-in cron engine | Built-in scheduler |
| Sub-agents | Native Claude Code | Custom orchestration | N/A |
| Config | YAML with cascade | JSON/TOML per agent | ENV vars |
| Setup | `clerk setup` | Docker compose | Docker compose |

## Architecture

```
You (Telegram)
    │
    ▼
@YourBot ──── clerk-telegram MCP ──── Claude Code CLI
                  │                        │
                  ├─ SQLite history         ├─ .claude/agents/*.md (sub-agents)
                  ├─ Emoji reactions        ├─ settings.json (tools, hooks, MCP)
                  └─ Format conversion      ├─ Hindsight plugin (memory)
                                           └─ systemd (agent + cron timers)
```

Clerk is **not a harness**. Each agent runs the unmodified `claude` binary, authenticated directly with Anthropic.

## Quick Start

```bash
# Prerequisites: Ubuntu 24.04 LTS, 4GB RAM
sudo apt update && sudo apt install -y tmux expect docker.io
curl -fsSL https://bun.sh/install | bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash && \
  source ~/.bashrc && nvm install 22
npm install -g @anthropic-ai/claude-code
sudo usermod -aG docker $USER && newgrp docker

# Install Clerk
git clone https://github.com/mekenthompson/clerk.git ~/code/clerk
cd ~/code/clerk && bun install && bun link

# Setup (interactive wizard)
clerk setup
```

After setup, talk to your agent from Telegram. You don't touch the server again.

## Example Configuration

```yaml
clerk:
  version: 1

telegram:
  bot_token: "vault:telegram-bot-token"
  forum_chat_id: "-1001234567890"

memory:
  backend: hindsight

defaults:
  model: claude-opus-4-6
  tools: { allow: [all] }
  subagents:
    worker:
      description: "Implementation tasks"
      model: sonnet
      background: true
      isolation: worktree
  schedule:
    - cron: "0 8 * * 1-5"
      prompt: "Morning briefing"
  session:
    max_idle: 2h

profiles:
  advisor:
    tools: { deny: [Bash, Edit, Write] }
    soul:
      style: "warm, empathetic"

agents:
  assistant:
    topic_name: "General"
    memory: { collection: general }

  coach:
    topic_name: "Coach"
    extends: advisor
    soul:
      name: Coach
```

See [docs/configuration.md](docs/configuration.md) for the full reference.

## CLI Reference

```bash
clerk setup                              # Interactive wizard
clerk doctor                             # Health check
clerk update                             # Pull + reconcile + restart

clerk agent list                         # Status of all agents
clerk agent create <name>                # Scaffold + install timers
clerk agent reconcile <name|all>         # Re-apply clerk.yaml
clerk agent start|stop|restart <name>    # Lifecycle (with preflight)
clerk agent attach <name>                # Interactive tmux session
clerk agent logs <name> [-f]             # View logs
clerk agent grant <name> <tool>          # Grant a tool permission and reconcile
clerk agent permissions <name>           # Show allow/deny list
clerk agent dangerous <name> [off]       # Toggle full tool access

clerk auth login|status|refresh          # Per-agent OAuth
clerk memory setup|search|stats|reflect  # Hindsight memory
clerk topics sync|list|cleanup           # Telegram forum topics
clerk vault init|set|get|list|remove     # Encrypted secrets
clerk handoff <agent>                    # Cross-session handoff summarizer
clerk web                                # Web dashboard
```

## Documentation

| Guide | Description |
|-------|-------------|
| **[Configuration](docs/configuration.md)** | Full field reference, cascade semantics, profiles, escape hatches |
| **[Telegram Plugin](docs/telegram-plugin.md)** | Enhanced plugin features, 10 MCP tools, emoji reactions |
| **[Sub-Agents](docs/sub-agents.md)** | Model routing, delegation patterns, frontmatter spec |
| **[Scheduling](docs/scheduling.md)** | Cron tasks, systemd timers, model selection |
| **[Session Management](docs/session-optimization.md)** | Continuity, compaction, freshness policy |
| **[Compliance](docs/compliance-attestation.md)** | Anthropic compliance analysis |
| **[Publishing](docs/publishing.md)** | Cutting a release of the clerk Claude Code plugin |

## License

MIT — See [CONTRIBUTING.md](CONTRIBUTING.md).
