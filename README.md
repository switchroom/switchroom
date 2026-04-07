# Clerk

Multi-agent orchestrator for Claude Code. One Telegram group, many specialized agents.

Clerk manages multiple long-running Claude Code sessions, each with its own persona, memory, tools, and Telegram topic — all using your official Claude Pro/Max subscription.

## What Clerk Does

- **Scaffolds agent directories** from templates (persona, behavior, skills, memory)
- **Manages authentication** per agent via official Claude Code OAuth
- **Generates systemd + tmux units** for headless operation with interactive access
- **Routes Telegram topics** to the right agent (forked official plugin with topic support)
- **Integrates Hindsight** for per-agent semantic memory with knowledge graphs
- **Encrypts secrets** via AES-256-GCM vault
- **Provides a CLI** for lifecycle management (start, stop, restart, logs, attach)

## What Clerk Is NOT

Clerk is **not a harness or wrapper**. It never intercepts Claude's authentication or inference. Each agent is a real `claude --channels` session, officially authenticated with your subscription. Clerk is scaffolding and lifecycle management — fully compliant with [Anthropic's usage policy](https://code.claude.com/docs/en/legal-and-compliance).

## Quick Start

```bash
# Install
npm install -g @clerk-ai/clerk

# Initialize from example config
clerk init --example wellness

# Set up secrets
clerk vault init
clerk vault set telegram-bot-token

# Authenticate each agent (opens browser for OAuth)
clerk auth login --all

# Create Telegram forum topics
clerk topics sync

# Start all agents
clerk agent start all
```

## How It Works

```
Telegram Forum Group
┌─────────┬───────────┬───────────┐
│ Health  │ Executive │  General  │
│ Topic   │  Topic    │  Topic    │
└────┬────┴─────┬─────┴─────┬─────┘
     │          │           │
     ▼          ▼           ▼
  claude      claude      claude
  --channels  --channels  --channels
  (health)    (exec)      (general)
  systemd     systemd     systemd
  + tmux      + tmux      + tmux
```

Each agent runs as:
- A **systemd user unit** (boot persistence, auto-restart on crash)
- Inside a **tmux session** (headless by default, `clerk agent attach` for interactive access)
- With its own **CLAUDE_CONFIG_DIR** (isolated OAuth tokens, independent 8-hour refresh cycle)
- With its own **Telegram topic** (messages routed by `message_thread_id`)
- With its own **persona** (SOUL.md), **behavior** (CLAUDE.md), **memory**, and **skills**

## Configuration

Everything is defined in one file:

```yaml
# clerk.yaml
clerk:
  version: 1

telegram:
  bot_token: "vault:telegram-bot-token"
  forum_chat_id: "-1001234567890"

memory:
  backend: hindsight
  config:
    provider: ollama

agents:
  health-coach:
    template: health-coach
    topic_name: "Health"
    topic_emoji: "🏋️"
    soul:
      name: Coach
      style: motivational, direct
    tools:
      allow: [calendar, notion, hindsight]
      deny: [bash, edit, write]
    memory:
      collection: health
    schedule:
      - cron: "0 8 * * *"
        prompt: "Morning check-in"

  exec-assistant:
    template: executive-assistant
    topic_name: "Executive"
    topic_emoji: "📋"
    tools:
      allow: [calendar, notion, web-search, hindsight]
      deny: [bash, edit, write]
    memory:
      collection: executive

  assistant:
    template: default
    topic_name: "General"
    topic_emoji: "💬"
    tools:
      allow: [all]
```

Add a new agent: add 10 lines to `clerk.yaml`, run `clerk agent create <name>`, authenticate, start.

## CLI

```bash
# Lifecycle
clerk agent list                  # Status of all agents
clerk agent start <name|all>      # Start agent(s)
clerk agent stop <name|all>       # Stop agent(s)
clerk agent attach <name>         # Interactive tmux session
clerk agent logs <name> -f        # Follow logs

# Auth
clerk auth login <name|all>       # OAuth login per agent
clerk auth status                 # Token status for all agents

# Telegram
clerk topics sync                 # Create forum topics from config
clerk topics list                 # Show topic-to-agent mapping

# Secrets
clerk vault set <key>             # Store encrypted secret
clerk vault list                  # List secret keys

# Memory
clerk memory search <query>       # Search across agents
clerk memory stats                # Per-agent memory counts
```

## Agent Personas

Each agent has a **SOUL.md** that defines its personality:

```markdown
You are Coach, a personal health and fitness accountability partner.

Style: motivational, direct, data-driven
Approach: ask about goals, track progress, celebrate wins, push through plateaus

Boundaries:
- You are not a doctor. Always recommend professional care for medical concerns.
- Focus on habits, consistency, and sustainable progress.
- Never prescribe diets or medical treatments.
```

And a **CLAUDE.md** that defines its behavior, available tools, and interaction patterns.

Templates are provided for common personas. Create your own or customize the defaults.

## Templates

| Template | Description |
|----------|-------------|
| `default` | General-purpose assistant with all tools |
| `health-coach` | Fitness, nutrition, sleep, and wellness coaching |
| `executive-assistant` | Calendar, tasks, briefings, and executive support |
| `coding` | Software engineering with full tool access |

## Memory

Clerk integrates [Hindsight](https://github.com/vectorize-io/hindsight) for semantic memory:

- Per-agent memory collections (isolated by default)
- 4-strategy retrieval: semantic + BM25 + entity graph + temporal
- Cross-encoder reranking
- Knowledge graph with entity resolution
- Auto-updating mental models
- Optional cross-agent synthesis via `clerk memory reflect`

## Prerequisites

- Node.js 22+
- [Bun](https://bun.sh)
- [Claude Code CLI](https://code.claude.com)
- Claude Pro or Max subscription
- tmux
- A Telegram bot token ([create one with BotFather](https://t.me/BotFather))

## Install Methods

### Host-Native (Recommended)

```bash
npm install -g @clerk-ai/clerk
```

Requires systemd (Linux). Uses tmux for terminal management.

### Docker Compose (Optional)

```bash
clerk init --docker
docker compose up -d
```

For NAS, VPS, or users who prefer containers.

## License

MIT

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).
