# Switchroom — Self-hosted Claude Code agents on your Pro/Max subscription (OpenClaw alternative)

[![Build status](https://badge.buildkite.com/443b450a779c30f5824660f5062f8c29101cd4419831ee3aff.svg)](https://buildkite.com/ken-thompson/switchroom)
[![Tests](https://img.shields.io/endpoint?url=https%3A%2F%2Fgist.githubusercontent.com%2Fmekenthompson%2F002f3482b19111d35e57c1903b3733e2%2Fraw%2Fswitchroom-tests.json)](https://buildkite.com/ken-thompson/switchroom)
[![Trigger evals](https://img.shields.io/endpoint?url=https%3A%2F%2Fgist.githubusercontent.com%2Fmekenthompson%2F002f3482b19111d35e57c1903b3733e2%2Fraw%2Fswitchroom-trigger-evals.json)](https://buildkite.com/ken-thompson/switchroom)
[![Quality evals](https://img.shields.io/endpoint?url=https%3A%2F%2Fgist.githubusercontent.com%2Fmekenthompson%2F002f3482b19111d35e57c1903b3733e2%2Fraw%2Fswitchroom-quality-evals.json)](https://buildkite.com/ken-thompson/switchroom)

**Run Claude Code agents 24/7 on a server, talk to them from Telegram.**

Switchroom turns a $6/mo Linux server plus your Claude Pro ($20/mo) or Claude Max ($100/mo) subscription into a fleet of always-on AI agents. Each agent is a real Claude Code session — not a wrapper, not a harness, not a proxy. Switchroom handles the lifecycle so you don't have to.

Switchroom is an **open-source alternative to OpenClaw and NanoClaw** that works with your **Claude Pro or Max subscription** via official OAuth — no Anthropic API key, no per-token billing, no Docker containers per agent. If you came here because OpenClaw stopped working with Claude subscription accounts, Switchroom is the drop-in path forward.

## Who this is for

- **You're a Claude Pro or Max subscriber** who wants your $20/$100 a month to do more than chat — you want agents that run tasks while you sleep.
- **You were using OpenClaw or NanoClaw** and need an alternative that works with Claude subscriptions instead of an API key.
- **You run a small fleet** (1–20 agents) on a cheap VPS and don't want Docker-per-agent or Kubernetes.

## Why Switchroom?

**Claude Code native.** Every agent runs the unmodified `claude` CLI binary with official OAuth against your Claude Pro or Max account. No credential interception, no API key routing, no third-party inference.

**Simpler than the alternatives.** OpenClaw needs Docker containers per agent and a custom runtime. NanoClaw needs the Agents SDK and container orchestration. Switchroom is `switchroom setup` → talk to your agent from Telegram.

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

| | Switchroom | OpenClaw | NanoClaw |
|---|---|---|---|
| Runtime | Claude Code CLI | Custom runtime | Agents SDK |
| Auth | Pro/Max OAuth | API key | API key |
| Channels | Telegram (enhanced) | WhatsApp, TG, Slack | WhatsApp, TG, Slack |
| Memory | Hindsight (semantic) | File-based | Per-container |
| Scheduling | systemd timers | Built-in cron engine | Built-in scheduler |
| Sub-agents | Native Claude Code | Custom orchestration | N/A |
| Config | YAML with cascade | JSON/TOML per agent | ENV vars |
| Setup | `switchroom setup` | Docker compose | Docker compose |

## Architecture

```
You (Telegram)
    │
    ▼
@YourBot ──── switchroom-telegram MCP ──── Claude Code CLI
                  │                        │
                  ├─ SQLite history         ├─ .claude/agents/*.md (sub-agents)
                  ├─ Emoji reactions        ├─ settings.json (tools, hooks, MCP)
                  └─ Format conversion      ├─ Hindsight plugin (memory)
                                           └─ systemd (agent + cron timers)
```

Switchroom is **not a harness**. Each agent runs the unmodified `claude` binary, authenticated directly with Anthropic.

## Install

```bash
# Install the CLI globally (Node 20.11+ required)
npm install -g switchroom-ai

# Sanity check
switchroom --version

# First-time setup (interactive — installs deps, scaffolds config, links Telegram)
switchroom setup
```

Once installed, `switchroom setup` walks you through prerequisites (claude CLI, tmux, OAuth) and creates your first agent. See **Quick Start** below for the manual path.

## Quick Start

```bash
# Prerequisites: Ubuntu 24.04 LTS, 4GB RAM
sudo apt update && sudo apt install -y tmux expect docker.io
curl -fsSL https://bun.sh/install | bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash && \
  source ~/.bashrc && nvm install 22
npm install -g @anthropic-ai/claude-code
sudo usermod -aG docker $USER && newgrp docker

# Install Switchroom
git clone https://github.com/mekenthompson/switchroom.git ~/code/switchroom
cd ~/code/switchroom && bun install && bun link

# Setup (interactive wizard)
switchroom setup
```

After setup, talk to your agent from Telegram. You don't touch the server again.

## Example Configuration

```yaml
switchroom:
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
switchroom setup                              # Interactive wizard
switchroom doctor                             # Health check
switchroom update                             # Pull + reconcile + restart

switchroom agent list                         # Status of all agents
switchroom agent create <name>                # Scaffold + install timers
switchroom agent reconcile <name|all>         # Re-apply switchroom.yaml
switchroom agent start|stop|restart <name>    # Lifecycle (with preflight)
switchroom agent attach <name>                # Interactive tmux session
switchroom agent logs <name> [-f]             # View logs
switchroom agent grant <name> <tool>          # Grant a tool permission and reconcile
switchroom agent permissions <name>           # Show allow/deny list
switchroom agent dangerous <name> [off]       # Toggle full tool access

switchroom auth login|status|refresh          # Per-agent OAuth
switchroom memory setup|search|stats|reflect  # Hindsight memory
switchroom topics sync|list|cleanup           # Telegram forum topics
switchroom vault init|set|get|list|remove     # Encrypted secrets
switchroom handoff <agent>                    # Cross-session handoff summarizer
switchroom web                                # Web dashboard
```

## Documentation

| Guide | Description |
|-------|-------------|
| **[OpenClaw alternative](docs/vs-openclaw.md)** | Switchroom vs OpenClaw — why subscription auth, config cascade, and no-Docker matter |
| **[NanoClaw alternative](docs/vs-nanoclaw.md)** | Switchroom vs NanoClaw — Claude Code CLI vs Agents SDK tradeoffs |
| **[Configuration](docs/configuration.md)** | Full field reference, cascade semantics, profiles, escape hatches |
| **[Telegram Plugin](docs/telegram-plugin.md)** | Enhanced plugin features, 10 MCP tools, emoji reactions |
| **[Sub-Agents](docs/sub-agents.md)** | Model routing, delegation patterns, frontmatter spec |
| **[Scheduling](docs/scheduling.md)** | Cron tasks, systemd timers, model selection |
| **[Session Management](docs/session-optimization.md)** | Continuity, compaction, freshness policy |
| **[Compliance](docs/compliance-attestation.md)** | Anthropic compliance analysis |
| **[Publishing](docs/publishing.md)** | Cutting a release of the switchroom Claude Code plugin |

## FAQ

### Can I use Switchroom with a Claude Pro or Max subscription instead of the API?
Yes — that's the whole point. Switchroom runs the unmodified `claude` CLI and signs in with the same OAuth flow you use on the desktop app. No API key, no per-token billing. Your $20/mo Pro or $100/mo Max plan powers every agent in your fleet.

### Is Switchroom an alternative to OpenClaw?
Yes. Switchroom covers the same use case — run Claude on a server, talk to it from a chat app — but uses your Claude subscription via OAuth instead of an Anthropic API key, and runs the native `claude` binary instead of a custom runtime in Docker. If you used OpenClaw with a Claude Pro/Max account and can't anymore, Switchroom is built specifically for that workflow.

### How is Switchroom different from OpenClaw and NanoClaw?
OpenClaw requires Docker containers per agent and a custom runtime. NanoClaw uses the Anthropic Agents SDK and container orchestration. Switchroom is a thin lifecycle manager around the real Claude Code CLI — systemd units, YAML cascade, no containers. See [vs-openclaw](docs/vs-openclaw.md) and [vs-nanoclaw](docs/vs-nanoclaw.md) for details.

### Does Switchroom need Docker?
No. Switchroom uses systemd units per agent on a regular Ubuntu server. Docker is listed as a prerequisite only because some sub-agent worktrees use it optionally.

### Can I run multiple agents on one server?
Yes. Switchroom is designed for small fleets (tested from 1 to ~20 agents on a 4GB VPS). Each agent gets its own systemd service, Telegram forum topic, memory collection, and optional cron schedule.

### What does Switchroom cost to run?
One cheap Linux VPS (Hetzner/DigitalOcean/etc, ~$6/mo), plus your existing Claude Pro ($20/mo) or Max ($100/mo) subscription. No per-agent or per-token surcharge from Switchroom itself — it's MIT-licensed open source.

### Is this against Anthropic's terms of service?
Switchroom uses the official `claude` binary with the official OAuth flow — the same way the desktop app authenticates. See [docs/compliance-attestation.md](docs/compliance-attestation.md) for the full analysis.

## License

MIT — See [CONTRIBUTING.md](CONTRIBUTING.md).
