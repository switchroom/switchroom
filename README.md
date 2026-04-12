# Clerk

**Run Claude Code agents 24/7 on a server, talk to them from Telegram.**

Clerk turns a $6/mo Linux server + your Claude Pro/Max subscription into a fleet of always-on AI agents. Each agent is a real Claude Code session — not a wrapper, not a harness, not a proxy. Clerk handles the lifecycle so you don't have to.

## Why Clerk?

**Claude Code native.** Every agent runs the unmodified `claude` CLI binary with official OAuth. No credential interception, no API key routing, no third-party inference. Your subscription, Anthropic's servers, Claude Code's tools and permissions.

**Simpler than the alternatives.** OpenClaw needs Docker containers per agent and a custom runtime. NanoClaw needs the Agents SDK and container orchestration. Clerk is `clerk setup` → talk to your agent from Telegram. One YAML file, one command, done.

**Smart defaults, opt-in complexity.** A minimal agent is two lines of YAML:

```yaml
agents:
  assistant:
    topic_name: "General"
```

Everything else (model, tools, memory, channels, sub-agents, session policy) inherits from sensible defaults. Add complexity only when you need it.

**Designed for compliance.** Each agent authenticates directly with Anthropic via Claude Code's own OAuth flow. Clerk never touches tokens or inference requests. See [docs/compliance-attestation.md](docs/compliance-attestation.md).

## What You Get

- **Telegram as your interface** — talk to agents from your phone, anywhere
- **Persistent memory** via [Hindsight](https://github.com/vectorize-io/hindsight) — agents remember across sessions
- **Session continuity** — agents resume where they left off after restarts
- **Enhanced Telegram plugin** — streaming edits, emoji reactions, message history, rich formatting (10 MCP tools vs 2 in the upstream plugin)
- **Config cascade** — global defaults, named profiles, per-agent overrides. Change one line, all agents update
- **Sub-agent delegation** — main agent on Opus plans and reviews, workers on Sonnet implement in the background
- **Encrypted vault** for secrets (AES-256-GCM)
- **Web dashboard** for monitoring
- **Preflight checks** on start/restart to catch broken configs before they hang

## Quick Start

```bash
# Prerequisites: Ubuntu 24.04 LTS, 4GB RAM, $6/mo server
# One-time install
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

The wizard walks you through Telegram pairing, Claude OAuth, vault, memory, and starting your first agent. After setup, you talk to your agent from Telegram — you don't touch the server again.

## Configuration

Everything lives in one file: `clerk.yaml`. Clerk uses a **three-layer cascade** for agent config:

1. **`defaults:`** — global baseline for every agent
2. **`profiles:`** — named presets agents inherit via `extends:`
3. **`agents:`** — per-agent overrides (only express differences)

### Full Example

```yaml
clerk:
  version: 1

telegram:
  bot_token: "vault:telegram-bot-token"
  forum_chat_id: "-1001234567890"

memory:
  backend: hindsight
  shared_collection: shared

defaults:
  model: claude-opus-4-6
  tools:
    allow: [all]
  system_prompt_append: |
    Always respond concisely.
  subagents:
    worker:
      description: "Implementation tasks"
      model: sonnet
      background: true
      isolation: worktree
    researcher:
      description: "Exploration and investigation"
      model: haiku
      background: true
  session:
    max_idle: 2h

profiles:
  advisor:
    tools:
      deny: [Bash, Edit, Write]
    soul:
      style: warm, empathetic
      boundaries: not a licensed professional

agents:
  assistant:
    topic_name: "General"
    topic_emoji: "💬"
    memory:
      collection: general

  coach:
    topic_name: "Fitness"
    topic_emoji: "🏋️"
    extends: advisor
    soul:
      name: Coach
```

The `assistant` agent inherits everything from defaults (Opus model, all tools, sub-agents, session policy). The `coach` extends the `advisor` profile (restricted tools, warm style) and adds a persona. Both get the default sub-agents, memory, and session management.

### What You Can Configure

| Field | Cascade | Description |
|-------|---------|-------------|
| `model` | override | Claude model (`claude-opus-4-6`, `claude-sonnet-4-6`) |
| `extends` | — | Named profile to inherit from |
| `tools.allow` / `tools.deny` | union | Tool permissions |
| `soul` | per-field merge | Agent persona (name, style, boundaries) |
| `memory` | per-field merge | Hindsight collection and recall settings |
| `hooks` | per-event concat | Claude Code lifecycle hooks |
| `env` | per-key merge | Environment variables for start.sh |
| `mcp_servers` | per-key merge | Additional MCP server configurations |
| `system_prompt_append` | concatenate | Appended to the system prompt |
| `skills` | union | Named skills from the global skills pool |
| `subagents` | per-key merge | Sub-agent definitions (`.claude/agents/*.md`) |
| `session.max_idle` | override | Fresh session after idle period (`2h`, `30m`) |
| `session.max_turns` | override | Fresh session after N user turns |
| `channels.telegram.plugin` | override | `clerk` (default, enhanced) or `official` |
| `channels.telegram.format` | override | Reply format (`html`, `markdownv2`, `text`) |
| `settings_raw` | deep merge | Escape hatch: raw settings.json overrides |
| `claude_md_raw` | concatenate | Escape hatch: append to CLAUDE.md |
| `cli_args` | concatenate | Escape hatch: extra `exec claude` flags |

### Profiles

Profiles live in `clerk.yaml` under `profiles:` or as filesystem directories under `profiles/`. Agents inherit from a profile via `extends: <name>`. Inline profiles take priority over filesystem ones.

```yaml
profiles:
  coder:
    tools:
      allow: [Bash, Read, Write, Edit, Grep, Glob]
    system_prompt_append: |
      You write production-quality code.
    subagents:
      worker:
        model: sonnet
        isolation: worktree
        prompt: "Implement code changes per spec."

agents:
  dev:
    topic_name: "Dev"
    extends: coder
```

### Sub-Agents

Sub-agents are rendered to `.claude/agents/<name>.md` — Claude Code's native custom sub-agent format. They enable the "Opus plans, Sonnet implements" pattern:

```yaml
defaults:
  subagents:
    worker:
      description: "Implementation tasks"
      model: sonnet
      background: true      # non-blocking
      isolation: worktree   # own git branch
      maxTurns: 50
```

The main agent (Opus) dispatches to `@worker` (Sonnet) which runs in the background. The main agent stays available for your next message. The user can always override the model per-invocation.

## Telegram Plugin

Clerk ships an enhanced Telegram MCP plugin (`clerk-telegram`) that replaces the upstream marketplace plugin. It's the default for all agents.

**10 MCP tools**: reply, stream_reply, react, edit_message, delete_message, forward_message, pin_message, send_typing, download_attachment, get_recent_messages

**Emoji status reactions**: 👀 → 🤔 → 👨‍💻 → 🔥 → 👍 (with stall watchdogs)

**SQLite message history** surviving restarts, **rich markdown→HTML formatting**, **per-agent access control**, **forum topic routing**.

To opt out for a specific agent: `channels.telegram.plugin: official`

See [docs/telegram-plugin.md](docs/telegram-plugin.md) for the full feature comparison.

## Session Management

Agents resume their Claude Code session across restarts via `--continue`. Session freshness is configurable:

```yaml
defaults:
  session:
    max_idle: 2h      # fresh session after 2h idle
    max_turns: 50     # fresh session after 50 user turns
```

Combined with Hindsight's auto-recall (every turn) and auto-retain (every 10 turns), agents have three layers of continuity:

1. **Claude Code session** — full conversation context via `--continue`
2. **Hindsight memory** — semantic recall across sessions
3. **Telegram history** — SQLite buffer for chat recovery

## CLI Reference

```bash
# Setup
clerk setup                          # Interactive wizard
clerk doctor                         # Health check
clerk update                         # Pull + reconcile + restart

# Agents
clerk agent list                     # Status of all agents
clerk agent create <name>            # Scaffold a new agent
clerk agent reconcile <name|all>     # Re-apply clerk.yaml
clerk agent start <name|all>         # Start (with preflight check)
clerk agent stop <name|all>          # Stop
clerk agent restart <name|all>       # Restart (with preflight check)
clerk agent attach <name>            # Interactive tmux session
clerk agent logs <name> [-f]         # View logs

# Memory
clerk memory setup                   # Start Hindsight container
clerk memory search <query>          # Search memories
clerk memory stats                   # Collection info

# Telegram
clerk topics sync                    # Create forum topics
clerk topics list                    # Show topic mapping

# Other
clerk vault init / set / get / list  # Encrypted secrets
clerk systemd install / status       # Systemd units
clerk web                            # Web dashboard
```

All commands support `--config <path>`. Use `clerk <command> --help` for details.

## Architecture

```
You (Telegram)
    │
    ▼
@YourBot ──── clerk-telegram MCP ──── Claude Code CLI
                  │                        │
                  ├─ SQLite history         ├─ CLAUDE.md (persona)
                  ├─ Access control         ├─ settings.json (tools, hooks, MCP)
                  ├─ Emoji reactions        ├─ .claude/agents/*.md (sub-agents)
                  └─ Format conversion      ├─ Hindsight plugin (memory)
                                           └─ systemd user service
```

Clerk is **not a harness or wrapper**. It never intercepts authentication or inference. Each agent is a real Claude Code session running the unmodified `claude` binary, authenticated directly with Anthropic.

## Compared To

| | Clerk | OpenClaw | NanoClaw |
|---|---|---|---|
| **Runtime** | Claude Code CLI (native) | Custom runtime | Agents SDK |
| **Auth** | Claude Pro/Max OAuth | API key | API key |
| **Channels** | Telegram (enhanced fork) | WhatsApp, Telegram, Slack, Discord | WhatsApp, Telegram, Slack |
| **Memory** | Hindsight (semantic + graph) | File-based + compaction | Per-container CLAUDE.md |
| **Isolation** | systemd user services | Docker containers | Docker containers |
| **Config** | Single YAML with cascade | JSON/TOML per agent | ENV vars |
| **Sub-agents** | Native Claude Code sub-agents | Custom orchestration | N/A |
| **Setup** | `clerk setup` (1 command) | Docker compose + config | Docker compose + config |

## License

MIT

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).
