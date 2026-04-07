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
- **Provides a CLI and web dashboard** for lifecycle management

## What Clerk Is NOT

Clerk is **not a harness or wrapper**. It never intercepts Claude's authentication or inference. Each agent is a real `claude --channels` session, officially authenticated with your subscription. Clerk is scaffolding and lifecycle management — fully compliant with [Anthropic's usage policy](https://code.claude.com/docs/en/legal-and-compliance).

## Quick Start

### Prerequisites

- Linux with systemd (Ubuntu, Debian, Fedora, etc.)
- [Node.js 22+](https://nodejs.org)
- [Bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`)
- [Claude Code CLI](https://code.claude.com) (`npm install -g @anthropic-ai/claude-code`)
- Claude Pro or Max subscription
- [tmux](https://github.com/tmux/tmux) (`sudo apt install tmux`)
- A Telegram bot token ([create one with @BotFather](https://t.me/BotFather))
- A Telegram group with forum/topics enabled

### 1. Install Clerk

```bash
npm install -g clerk-ai
```

### 2. Create your config

```bash
clerk init --example clerk
```

This copies an example `clerk.yaml` into your current directory with four agents: health-coach, exec-assistant, coding, and general assistant. Edit it to match your setup:

```bash
$EDITOR clerk.yaml
```

At minimum, set your Telegram `forum_chat_id` (the group where topics will be created).

### 3. Set up secrets

```bash
# Create an encrypted vault for sensitive values
clerk vault init

# Store your Telegram bot token
clerk vault set telegram-bot-token
```

The vault uses AES-256-GCM encryption. You'll be prompted for a passphrase.

### 4. Create Telegram forum topics

```bash
# Make sure your bot is an admin in the forum group, then:
export TELEGRAM_BOT_TOKEN=your-bot-token-here
clerk topics sync
```

This creates a forum topic for each agent and saves the mapping.

### 5. Initialize and start

```bash
# Scaffold all agent directories and install systemd units
clerk init

# Start the first agent
clerk agent start health-coach
```

### 6. Complete Claude Code onboarding (once per agent)

```bash
# Attach to the agent's tmux session
clerk agent attach health-coach

# Complete Claude Code's onboarding:
#   - Select theme
#   - Log in (browser OAuth)
#   - Trust the project

# Detach from tmux: Ctrl+B, then D
```

The agent is now running and authenticated. Claude Code manages its own OAuth tokens automatically. Repeat for each agent:

```bash
clerk agent start exec-assistant
clerk agent attach exec-assistant
# Complete onboarding, then Ctrl+B, D

clerk agent start assistant
clerk agent attach assistant
# Complete onboarding, then Ctrl+B, D
```

Check status:
```bash
clerk agent list
clerk auth status
```

That's it. Your agents are running headless, each responding in their own Telegram topic.

### Interacting with agents

- **Send a message** in a Telegram forum topic — the assigned agent responds
- **Use bot commands** in Telegram for instant management (no Claude tokens):
  - `/agents` — check all agent statuses
  - `/clerkstart health-coach` — start an agent
  - `/stop health-coach` — stop an agent
  - `/restart all` — restart all agents
  - `/logs health-coach` — view recent logs
  - `/clerkhelp` — list all bot commands
- **Attach to a session**: `clerk agent attach health-coach` (tmux, Ctrl+B D to detach)
- **View logs**: `clerk agent logs health-coach -f`
- **Web dashboard**: `clerk web` then open http://localhost:8080
- **Check auth**: `clerk auth status`

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

Add a new agent: add a few lines to `clerk.yaml`, run `clerk agent create <name>`, authenticate, start.

## CLI Reference

```bash
# Setup
clerk init [--example <name>]       # Scaffold agents + install systemd units
clerk vault init                    # Create encrypted vault
clerk vault set <key>               # Store a secret
clerk vault get <key>               # Retrieve a secret
clerk vault list                    # List secret key names

# Authentication
clerk auth login <name|all>         # Show onboarding instructions for agent(s)
clerk auth status                   # Token status for all agents
clerk auth refresh <name>           # Show instructions to refresh tokens

# Agent lifecycle
clerk agent list                    # Status of all agents
clerk agent create <name>           # Scaffold + install one agent
clerk agent start <name|all>        # Start agent(s)
clerk agent stop <name|all>         # Stop agent(s)
clerk agent restart <name|all>      # Restart agent(s)
clerk agent attach <name>           # Interactive tmux session
clerk agent logs <name> [-f]        # View/follow logs
clerk agent destroy <name> [-y]     # Remove agent (with confirmation)

# Telegram
clerk topics sync                   # Create forum topics from config
clerk topics list                   # Show topic-to-agent mapping

# Memory (Hindsight)
clerk memory search <query> [--agent <name>]
clerk memory stats                  # Per-agent collection info
clerk memory reflect                # Cross-agent synthesis plan

# Systemd
clerk systemd install               # Generate + enable all units
clerk systemd status                # Show all service statuses
clerk systemd uninstall             # Disable + remove units

# Dashboard
clerk web [--port 8080]             # Start web dashboard
```

All commands support `--config <path>` to specify a custom clerk.yaml location. Use `clerk <command> --help` for detailed options.

## Agent Personas

Each agent has a **SOUL.md** that defines its personality:

```markdown
# Coach

## Communication Style
Motivational but not cheesy. Direct and honest.

## Principles
- Accountability first
- Progress over perfection
- Keep it simple
- Know your limits — not a doctor, recommend professional care
```

And a **CLAUDE.md** that defines its behavior, available tools, and interaction patterns.

## Templates

| Template | Description |
|----------|-------------|
| `default` | General-purpose assistant with all tools |
| `health-coach` | Fitness, nutrition, sleep, and wellness coaching |
| `executive-assistant` | Calendar, tasks, briefings, and executive support |
| `coding` | Software engineering with full tool access |

Create your own templates in `templates/<name>/` with `CLAUDE.md.hbs`, `SOUL.md.hbs`, and optional `skills/`.

## Memory

Clerk integrates [Hindsight](https://github.com/vectorize-io/hindsight) for semantic memory:

- Per-agent memory collections (isolated by default)
- 4-strategy retrieval: semantic + BM25 + entity graph + temporal
- Cross-encoder reranking
- Knowledge graph with entity resolution
- Auto-updating mental models
- Optional cross-agent synthesis via `clerk memory reflect`

Set `isolation: strict` on any agent to prevent its memories from being included in cross-agent reflection.

## Security

- **Encrypted vault**: AES-256-GCM with scrypt key derivation for secrets
- **File permissions**: Sensitive files (.env, credentials, settings) created with mode 0600
- **Agent name validation**: Strict regex prevents command injection
- **Path traversal protection**: Template and config paths are contained
- **Web dashboard**: Binds to localhost only, optional bearer token auth via `CLERK_WEB_TOKEN`
- **No credential interception**: Each agent authenticates directly with Claude Code OAuth

## Telegram Bot Commands

The Telegram bot handles management commands directly — zero Claude tokens, instant response:

| Command | Description |
|---------|-------------|
| `/agents` | Show all agent statuses |
| `/clerkstart <name>` | Start an agent |
| `/stop <name>` | Stop an agent |
| `/restart <name\|all>` | Restart agent(s) |
| `/auth` | Check OAuth token health |
| `/topics` | Show topic-to-agent mapping |
| `/logs <name> [lines]` | View recent log lines |
| `/memory <query>` | Search Hindsight memories |
| `/clerkhelp` | List all commands |

These run on the server via the clerk CLI — no inference needed. Regular messages (not starting with /) go to Claude as normal.

Configure with `CLERK_CLI_PATH` and `CLERK_CONFIG` env vars if clerk is not on the default PATH.

## Clerk MCP Server

Each agent automatically gets a clerk management MCP server configured during scaffolding. This provides 8 tools that agents can call without needing Bash access:

- `clerk_agent_list`, `clerk_agent_start`, `clerk_agent_stop`, `clerk_agent_restart`
- `clerk_auth_status`, `clerk_topics_list`
- `clerk_memory_search`, `clerk_memory_stats`

This means agents with restricted tools (`deny: [bash]`) can still manage other agents.

## In-Session Skill

The `/clerk` skill provides an alternative management interface within conversations:

```
/clerk agents          # List all agents
/clerk start coding    # Start the coding agent
/clerk memory "topic"  # Search memories
```

## Session Optimization

Long-running agents benefit from careful context management. See [docs/session-optimization.md](docs/session-optimization.md) for guidance on:

- Keeping SOUL.md and CLAUDE.md concise (under 500 and 800 words)
- Using Hindsight auto-recall to restore context after compaction
- Scheduling daily session resets for fresh context
- Minimizing tool count per agent to save token budget
- Proactive memory saves before compaction occurs

## Docker Support

Docker Compose support is planned. For now, use the host-native systemd + tmux approach.

## License

MIT

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).
