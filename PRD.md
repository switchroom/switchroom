# Clerk — Product Requirements Document

## Overview

Clerk is an open-source multi-agent orchestrator for Claude Code. It manages multiple long-running Claude Code sessions, each with its own persona, memory, tools, and Telegram topic — all using your official Claude Pro/Max subscription.

Clerk is **not a harness or wrapper**. It never intercepts Claude's authentication or inference. It is scaffolding and lifecycle management: it creates directories, generates systemd units, and provides a CLI to manage your agents. Each agent is a real `claude --channels` session, officially authenticated.

## Problem

Running multiple specialized Claude Code agents (health coach, executive assistant, coding agent, etc.) requires:

- Manually creating directories, config files, and systemd units for each agent
- Configuring separate Telegram plugin instances with topic routing
- Managing OAuth authentication across multiple instances
- Setting up isolated memory systems per agent
- No standard way to define agent personas (personality, boundaries, expertise)
- No tooling to manage lifecycle (start, stop, restart, logs) across agents

## Solution

A config-driven CLI that:

1. Reads a single `clerk.yaml` manifest defining all agents
2. Scaffolds agent directories from templates (SOUL.md, CLAUDE.md, settings, skills)
3. Manages OAuth login per agent via `clerk auth login <agent>`
4. Generates systemd + tmux units for headless operation with interactive access
5. Provides a forked Telegram plugin with topic routing (message_thread_id)
6. Integrates Hindsight for per-agent semantic memory with knowledge graphs
7. Manages secrets via an encrypted vault
8. Offers a lightweight web dashboard for monitoring

## Design Principles

- **Subscription-compliant**: Uses Claude Code CLI natively. Each agent authenticates via official OAuth. No Agent SDK, no token proxying, no harness behavior. Fully compliant with Anthropic's April 2026 third-party policy.
- **Config-driven**: One YAML file defines your entire fleet. Add an agent in 10 lines.
- **Convention over configuration**: Sensible defaults. Override only what you need.
- **Claude Code native**: Leverages official channels, hooks, skills, MCP servers, sub-agents.
- **Portable**: Primary path is host-native (systemd + tmux). Optional Docker Compose for container users.
- **Open source**: MIT license. Community templates welcome.

## Architecture

```
┌──────────────────────────────────────┐
│        Telegram Forum Group           │
│  ┌─────────┬───────────┬───────────┐ │
│  │ Health  │ Executive │  General  │ │
│  │ Topic   │  Topic    │  Topic    │ │
│  └────┬────┴─────┬─────┴─────┬─────┘ │
└───────┼──────────┼───────────┼───────┘
        │          │           │
   topic_id=2  topic_id=5  topic_id=8
        │          │           │
        ▼          ▼           ▼
┌────────────┐┌────────────┐┌────────────┐
│  tmux:     ││  tmux:     ││  tmux:     │
│  clerk-    ││  clerk-    ││  clerk-    │
│  health    ││  exec      ││  general   │
│            ││            ││            │
│ claude     ││ claude     ││ claude     │
│ --channels ││ --channels ││ --channels │
│            ││            ││            │
│ SOUL.md    ││ SOUL.md    ││ SOUL.md    │
│ CLAUDE.md  ││ CLAUDE.md  ││ CLAUDE.md  │
│ memory/    ││ memory/    ││ memory/    │
│ skills/    ││ skills/    ││ skills/    │
│ .claude/   ││ .claude/   ││ .claude/   │
└────────────┘└────────────┘└────────────┘
  systemd       systemd       systemd
```

### Auth Model

Each agent gets its own `CLAUDE_CONFIG_DIR` containing an independent `.credentials.json`. This avoids the token refresh race condition (single-use refresh tokens, 8-hour access token lifetime). Clerk manages the login flow:

```
clerk auth login health-coach
  → Sets CLAUDE_CONFIG_DIR=~/.clerk/agents/health-coach/.claude
  → Runs claude auth login
  → Prints URL for browser (works remotely via SSH)
  → Tokens saved to agent's own config dir
  → Auto-refreshes independently every 8 hours
```

Multiple agents can use the same Claude account or different accounts.

### Session Model

Each agent runs as:
- A **systemd user unit** for lifecycle management (boot persistence, auto-restart)
- Inside a **tmux session** for TTY provision and interactive access
- With its own **CLAUDE_CONFIG_DIR** for auth isolation
- With its own **TELEGRAM_STATE_DIR** for Telegram plugin config
- With its own **working directory** containing SOUL.md, CLAUDE.md, memory/, skills/

### Memory Model

Each agent gets a dedicated Hindsight collection:
- `health` collection for health-coach
- `executive` collection for exec-assistant
- `general` collection for general assistant
- `shared` collection for cross-agent insights (opt-in)

Hindsight provides 4-strategy retrieval (semantic + BM25 + entity graph + temporal) with cross-encoder reranking and auto-updating mental models.

### Telegram Model

A forked version of the official `claude-plugins-official` Telegram plugin, adding:
- `message_thread_id` in inbound metadata
- `message_thread_id` parameter in reply/edit tools
- `TELEGRAM_TOPIC_ID` env var for filtering (agent only responds to its assigned topic)
- Topic-aware file sending (sendPhoto/sendDocument with thread_id)

All agents share one Telegram bot token but filter to their own topic.

### Persona Model

Each agent has:
- **SOUL.md**: Who the agent IS — personality, values, tone, approach, relationship to user, boundaries
- **CLAUDE.md**: What the agent DOES — tool usage, behaviors, protocols, memory instructions
- **skills/**: Specialized skills for the agent's domain

Templates provide starting points for common personas (health coach, executive assistant, coding, etc.).

## Manifest Format

```yaml
# clerk.yaml

clerk:
  version: 1
  agents_dir: ~/.clerk/agents    # Where agent directories live

telegram:
  bot_token: "vault:telegram-bot-token"   # From encrypted vault
  forum_chat_id: "-1001234567890"

memory:
  backend: hindsight
  config:
    provider: ollama
    model: nomic-embed-text
    # or: provider: anthropic

vault:
  path: ~/.clerk/vault.enc

agents:
  health-coach:
    template: health-coach
    topic_name: "Health"
    topic_emoji: "🏋️"
    soul:
      name: Coach
      style: motivational, direct, accountability-focused
      boundaries: not a doctor, always recommend professional care
    tools:
      allow: [calendar, notion, web-search, hindsight]
      deny: [bash, edit, write]
    memory:
      collection: health
      auto_recall: true
    schedule:
      - cron: "0 8 * * *"
        prompt: "Morning check-in: ask about sleep and plans for today"
      - cron: "0 20 * * 0"
        prompt: "Weekly review: summarize this week's health activity"

  exec-assistant:
    template: executive-assistant
    topic_name: "Executive"
    topic_emoji: "📋"
    soul:
      name: Friday
      style: efficient, proactive, anticipates needs
      boundaries: summarize before acting, confirm before sending external communications
    tools:
      allow: [calendar, notion, web-search, hindsight]
      deny: [bash, edit, write]
    memory:
      collection: executive
      auto_recall: true

  assistant:
    template: default
    topic_name: "General"
    topic_emoji: "💬"
    tools:
      allow: [all]
    memory:
      collection: general
```

## CLI Specification

### Initialization

```
clerk init                          # Scaffold from clerk.yaml
clerk init --example wellness       # Start from example config
clerk init --docker                 # Generate docker-compose.yml instead
```

### Agent Lifecycle

```
clerk agent list                    # Show all agents + status + uptime
clerk agent create <name> [--template <t>]  # Add agent to manifest + scaffold
clerk agent start <name|all>        # Start systemd unit + tmux session
clerk agent stop <name|all>         # Stop agent
clerk agent restart <name|all>      # Restart agent
clerk agent attach <name>           # tmux attach for interactive access
clerk agent logs <name> [-f]        # Follow journal logs
clerk agent destroy <name>          # Remove agent + data (with confirmation)
```

### Authentication

```
clerk auth login <name|all>         # OAuth login for agent(s)
clerk auth status                   # Show all agents' auth status, subscription, expiry
clerk auth refresh <name>           # Force token refresh
```

### Telegram Topics

```
clerk topics sync                   # Create/update forum topics from manifest
clerk topics list                   # Show topic → agent mapping
```

### Secrets Vault

```
clerk vault init                    # Create encrypted vault
clerk vault set <key>               # Prompt for value, encrypt and store
clerk vault get <key>               # Decrypt and display
clerk vault list                    # Show key names (not values)
clerk vault remove <key>            # Delete a secret
```

### Memory

```
clerk memory search <query> [--agent <name>]   # Search memories
clerk memory stats                              # Per-agent memory counts
clerk memory reflect                            # Cross-agent synthesis
```

### Systemd

```
clerk systemd install               # Generate + enable all units
clerk systemd status                # Show all service statuses
clerk systemd uninstall             # Disable + remove units
```

### Web Dashboard

```
clerk web [--port 8080]             # Start lightweight dashboard
```

## Generated Agent Directory

```
~/.clerk/agents/health-coach/
├── .claude/                        # CLAUDE_CONFIG_DIR for this agent
│   ├── .credentials.json           # OAuth tokens (auto-managed)
│   ├── config.json                 # Claude Code config
│   └── settings.json               # MCP servers, permissions
├── CLAUDE.md                       # Agent behavior instructions
├── SOUL.md                         # Agent persona definition
├── memory/
│   └── MEMORY.md                   # Auto-memory index
├── skills/
│   ├── check-in/SKILL.md
│   └── weekly-review/SKILL.md
├── telegram/
│   ├── .env                        # Bot token (from vault)
│   └── access.json                 # Topic filter + allowlist
└── start.sh                        # Generated launch script
```

## Install Methods

### 1. Host-Native (Primary, Recommended)

```bash
# Prerequisites: Node 22+, Bun, Claude Code CLI, tmux
npm install -g @clerk-ai/clerk    # or: bun install -g @clerk-ai/clerk

clerk init
clerk vault init
clerk vault set telegram-bot-token
clerk auth login --all
clerk topics sync
clerk agent start all
```

### 2. Docker Compose (Optional)

```bash
clerk init --docker
# Edit .env with TELEGRAM_BOT_TOKEN
docker compose up -d
# Auth: docker exec -it clerk-health-coach clerk auth login health-coach
```

### 3. Manual / Bare

Use templates and docs to set up your own process supervision.

## Phased Delivery

### Phase 1 — Foundation
- clerk.yaml schema (Zod validation)
- Config loader
- Agent directory scaffolding from templates
- systemd + tmux unit generation
- CLI: init, agent create/start/stop/list/attach/logs
- Basic README + getting-started docs

### Phase 2 — Telegram
- Fork official Telegram plugin
- Add message_thread_id to inbound metadata
- Add message_thread_id + TELEGRAM_TOPIC_ID filtering to reply tool
- Topic-aware file sending
- clerk topics sync (auto-create forum topics via Bot API)

### Phase 3 — Auth & Secrets
- clerk auth login/status/refresh (OAuth flow per agent)
- Encrypted vault (AES-256-GCM, Argon2id key derivation)
- Secret references in clerk.yaml (vault:key-name)
- CLI: vault init/set/get/list/remove, auth commands

### Phase 4 — Memory
- Hindsight integration (Docker service or local)
- Per-agent collection configuration
- Auto-recall hook (search memories before each response)
- CLI: memory search/stats
- Cross-agent reflect skill

### Phase 5 — Templates & Skills
- health-coach template (SOUL.md, CLAUDE.md, skills)
- executive-assistant template (daily briefing, task prioritization, meeting prep)
- default + coding templates
- /clerk in-session skill for agent management
- Shared skills: cross-reflect, agent-handoff

### Phase 6 — Web Dashboard
- Bun HTTP server + REST API
- Agent cards (status, uptime, memory usage)
- Start/stop/restart controls
- Live log streaming (WebSocket)
- Memory search UI
- Vault key management

### Phase 7 — Enhanced Telegram Plugin
- Read receipt / delivery status indicators
- Streaming control (typing indicators, progress updates)
- Rich message formatting improvements
- Inline keyboard interactions beyond permission buttons
- Voice message transcription integration
- Sticker/GIF responses
- Message pinning
- Poll creation
- Scheduled messages

### Phase 8 — Docker Support
- Base agent Dockerfile (Node 22 + Bun + Claude Code + tmux)
- docker-compose.yml generation from clerk.yaml
- Volume management for credentials, memory, config
- Container health checks
- `clerk init --docker` path

## Non-Goals (v1)

- Not a harness — never intercepts Claude auth or inference
- Not multi-tenant — designed for single-operator use
- Not a hosted service — self-hosted only
- No custom LLM runtime — Claude Code is the runtime
- No mobile app — Telegram IS the mobile interface
- No voice/call channel — Telegram only for now

## Success Criteria

- `clerk init && clerk auth login --all && clerk agent start all` works in under 5 minutes
- Each agent responds only in its assigned Telegram topic
- Agents maintain isolated memory across restarts
- Token refresh works unattended for weeks
- Adding a new agent takes <2 minutes (edit YAML, clerk agent create, clerk auth login)
- Templates provide useful starting points that users customize
- Project runs on any Linux box with Node 22+, Bun, and tmux
