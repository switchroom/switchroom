# Switchroom — Product Requirements Document

> **⚠️ Historical design document.** This PRD reflects the original product
> design and remains useful for understanding switchroom's intent and architectural
> rationale. Several sections are now out of date relative to the shipped
> code — in particular the Telegram plugin model (the switchroom fork is now the
> default, with `channels.telegram.plugin: official` as the opt-out — the
> old `use_switchroom_plugin: true` key no longer exists), the CLI surface
> (`switchroom setup`, `switchroom doctor`, `switchroom update`, `switchroom agent reconcile`,
> `switchroom agent grant|dangerous|permissions` are not listed below), and the
> memory model (file-based `MEMORY.md` auto-memory is disabled in favour of
> Hindsight). For current behaviour, treat the canonical sources as:
>
> - [`README.md`](README.md) — what switchroom is and how to use it
> - [`docs/configuration.md`](docs/configuration.md) — config schema & cascade
> - [`docs/telegram-plugin.md`](docs/telegram-plugin.md) — Telegram plugin
> - [`docs/sub-agents.md`](docs/sub-agents.md) — sub-agent delegation
> - [`docs/scheduling.md`](docs/scheduling.md) — scheduled tasks
> - [`docs/compliance-attestation.md`](docs/compliance-attestation.md) — compliance
>
> The "Phased Delivery" roadmap below is largely complete; phases are kept
> here as a record of the project's evolution rather than a forward plan.

## Overview

Switchroom is an open-source multi-agent orchestrator for Claude Code. It manages multiple long-running Claude Code sessions, each with its own persona, memory, tools, and Telegram topic — all using your official Claude Pro/Max subscription.

Switchroom is **not a harness or wrapper**. It never intercepts Claude's authentication or inference. It is scaffolding and lifecycle management: it creates directories, generates systemd units, and provides a CLI to manage your agents. Each agent is a real `claude --channels` session, officially authenticated.

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

1. Reads a single `switchroom.yaml` manifest defining all agents
2. Scaffolds agent directories from templates (SOUL.md, CLAUDE.md, settings, skills)
3. Manages OAuth login per agent via `switchroom auth login <agent>`
4. Generates systemd + tmux units for headless operation with interactive access
5. Assigns one Telegram bot per agent, each using the official `plugin:telegram@claude-plugins-official`
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

One bot per agent. Each agent uses the official Telegram plugin.

```
┌──────────────────────────────────────┐
│        Telegram Forum Group           │
│  ┌─────────┬───────────┬───────────┐ │
│  │ Fitness │ Executive │  General  │ │
│  │ Topic   │  Topic    │  Topic    │ │
│  └────┬────┴─────┬─────┴─────┬─────┘ │
└───────┼──────────┼───────────┼───────┘
        │          │           │
     @CoachBot  @ExecBot   @AssistBot
        │          │           │
        ▼          ▼           ▼
┌────────────┐┌────────────┐┌────────────┐
│  tmux:     ││  tmux:     ││  tmux:     │
│  switchroom-    ││  switchroom-    ││  switchroom-    │
│  coach     ││  exec      ││  general   │
│            ││            ││            │
│ claude     ││ claude     ││ claude     │
│ --channels ││ --channels ││ --channels │
│ plugin:tg  ││ plugin:tg  ││ plugin:tg  │
│            ││            ││            │
│ SOUL.md    ││ SOUL.md    ││ SOUL.md    │
│ CLAUDE.md  ││ CLAUDE.md  ││ CLAUDE.md  │
│ memory/    ││ memory/    ││ memory/    │
│ skills/    ││ skills/    ││ skills/    │
│ .claude/   ││ .claude/   ││ .claude/   │
│ telegram/  ││ telegram/  ││ telegram/  │
│  .env      ││  .env      ││  .env      │
│  access.json  access.json  access.json │
└────────────┘└────────────┘└────────────┘
  systemd       systemd       systemd
```

### Auth Model

Each agent gets its own `CLAUDE_CONFIG_DIR` containing an independent `.credentials.json`. This avoids the token refresh race condition (single-use refresh tokens, 8-hour access token lifetime). Switchroom manages the login flow:

```
switchroom auth login health-coach
  → Sets CLAUDE_CONFIG_DIR=~/.switchroom/agents/health-coach/.claude
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

Each agent gets its own Telegram bot. Switchroom supports **two channel modes** per agent:

**Mode A — Official plugin (default):**
- Launches with `claude --channels plugin:telegram@claude-plugins-official`
- Uses Anthropic's approved marketplace plugin — no prompts, no dev-channel flag
- Simplest path, minimal dependencies

**Mode B — Switchroom enhanced plugin (`use_switchroom_plugin: true`):**
- Launches with `claude --dangerously-load-development-channels server:switchroom-telegram`
- MCP server definition is read from a project-level `.mcp.json` in the agent's working directory (NOT from `settings.json`)
- Adds HTML formatting, smart message chunking, coalescing, bot commands, and richer attachment handling
- Requires `expect` to auto-accept the dev-channel confirmation prompt at startup (`bin/autoaccept.exp`)
- MCP tool names (`mcp__switchroom-telegram__*`) are pre-approved in `settings.json` so the agent never blocks on a permission prompt
- Targets Ubuntu 24.04 LTS (TIOCSTI is blocked on modern kernels; we use `expect` instead)

Shared across both modes:
- One bot per agent, each with its own `TELEGRAM_BOT_TOKEN` in `telegram/.env` (Telegram long-poll locks per token — sharing tokens drops messages)
- Privacy mode disabled on each bot **before** adding it to the group so it sees all messages
- All bots added to the same forum group as admins
- `access.json` controls which groups the bot responds in (`requireMention: false`)
- No daemon, no routing — each bot is an independent Telegram poller

### Persona Model

Each agent has:
- **SOUL.md**: Who the agent IS — personality, values, tone, approach, relationship to user, boundaries
- **CLAUDE.md**: What the agent DOES — tool usage, behaviors, protocols, memory instructions
- **skills/**: Specialized skills for the agent's domain

Templates provide starting points for common personas (health coach, executive assistant, coding, etc.).

## Manifest Format

```yaml
# switchroom.yaml

switchroom:
  version: 1
  agents_dir: ~/.switchroom/agents    # Where agent directories live

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
  path: ~/.switchroom/vault.enc

agents:
  coach:
    bot_token: "vault:coach-bot-token"     # Per-agent bot token
    template: health-coach
    topic_name: "Fitness"
    topic_emoji: "🏋️"
    soul:
      name: Coach
      style: motivational, direct, accountability-focused
      boundaries: not a licensed professional, always recommend consulting a qualified expert
    tools:
      allow: [calendar, notion, web-search, hindsight]
      deny: [bash, edit, write]
    memory:
      collection: fitness
      auto_recall: true
    schedule:
      - cron: "0 8 * * *"
        prompt: "Morning check-in: ask about sleep and plans for today"
      - cron: "0 20 * * 0"
        prompt: "Weekly review: summarize this week's activity"

  exec-assistant:
    bot_token: "vault:exec-bot-token"
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
    bot_token: "vault:assistant-bot-token"
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
switchroom init                          # Scaffold from switchroom.yaml
switchroom init --example wellness       # Start from example config
switchroom init --docker                 # Generate docker-compose.yml instead
```

### Agent Lifecycle

```
switchroom agent list                    # Show all agents + status + uptime
switchroom agent create <name> [--template <t>]  # Add agent to manifest + scaffold
switchroom agent start <name|all>        # Start systemd unit + tmux session
switchroom agent stop <name|all>         # Stop agent
switchroom agent restart <name|all>      # Restart agent
switchroom agent attach <name>           # tmux attach for interactive access
switchroom agent logs <name> [-f]        # Follow journal logs
switchroom agent destroy <name>          # Remove agent + data (with confirmation)
```

### Authentication

```
switchroom auth login <name|all>         # OAuth login for agent(s)
switchroom auth status                   # Show all agents' auth status, subscription, expiry
switchroom auth refresh <name>           # Force token refresh
```

### Telegram Topics

```
switchroom topics sync                   # Create/update forum topics from manifest
switchroom topics list                   # Show topic → agent mapping
```

### Secrets Vault

```
switchroom vault init                    # Create encrypted vault
switchroom vault set <key>               # Prompt for value, encrypt and store
switchroom vault get <key>               # Decrypt and display
switchroom vault list                    # Show key names (not values)
switchroom vault remove <key>            # Delete a secret
```

### Memory

```
switchroom memory search <query> [--agent <name>]   # Search memories
switchroom memory stats                              # Per-agent memory counts
switchroom memory reflect                            # Cross-agent synthesis
```

### Systemd

```
switchroom systemd install               # Generate + enable all units
switchroom systemd status                # Show all service statuses
switchroom systemd uninstall             # Disable + remove units
```

### Web Dashboard

```
switchroom web [--port 8080]             # Start lightweight dashboard
```

## Generated Agent Directory

```
~/.switchroom/agents/health-coach/
├── .claude/                        # CLAUDE_CONFIG_DIR for this agent
│   ├── .credentials.json           # OAuth tokens (auto-managed)
│   ├── config.json                 # Claude Code config
│   └── settings.json               # MCP servers, permissions (defaultMode acceptEdits
│                                   #   when tools.allow has "all")
├── .mcp.json                       # Project-level MCP server config
│                                   #   (only when use_switchroom_plugin: true —
│                                   #    dev-channel loader reads from here,
│                                   #    not from settings.json)
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
└── start.sh                        # Generated launch script (sources nvm)
```

## Install Methods

### 1. Host-Native (Primary, Recommended)

```bash
# Prerequisites: Node 22+, Bun, Claude Code CLI, tmux
npm install -g @switchroom-ai/switchroom    # or: bun install -g @switchroom-ai/switchroom

switchroom init
switchroom vault init
switchroom vault set telegram-bot-token
switchroom auth login --all
switchroom topics sync
switchroom agent start all
```

### 2. Docker Compose (Optional)

```bash
switchroom init --docker
# Edit .env with TELEGRAM_BOT_TOKEN
docker compose up -d
# Auth: docker exec -it switchroom-health-coach switchroom auth login health-coach
```

### 3. Manual / Bare

Use templates and docs to set up your own process supervision.

## Phased Delivery

### Phase 1 — Foundation
- switchroom.yaml schema (Zod validation)
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
- switchroom topics sync (auto-create forum topics via Bot API)

### Phase 3 — Auth & Secrets
- switchroom auth login/status/refresh (OAuth flow per agent)
- Encrypted vault (AES-256-GCM, Argon2id key derivation)
- Secret references in switchroom.yaml (vault:key-name)
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
- /switchroom in-session skill for agent management
- Shared skills: cross-reflect, agent-handoff

### Phase 6 — Web Dashboard
- Bun HTTP server + REST API
- Agent cards (status, uptime, memory usage)
- Start/stop/restart controls
- Live log streaming (WebSocket)
- Memory search UI
- Vault key management

### Phase 7 — Enhanced Telegram Plugin
Opt-in via `use_switchroom_plugin: true` on any agent. Implemented as a forked MCP server in `telegram-plugin/`, loaded as a Claude Code development channel.

- HTML message formatting (bold, italics, code blocks, links)
- Smart message chunking (respects Telegram's 4096-char limit)
- Message coalescing (groups rapid updates to reduce notification spam)
- Bot commands registration via `setMyCommands`
- Typing indicators and progress edits
- Attachment download helpers (photos, files, voice)
- Pre-approved MCP tool permissions (no runtime prompts)
- `expect`-based auto-accept for the dev-channel confirmation prompt at startup
- Project-level `.mcp.json` scaffolding with `TELEGRAM_STATE_DIR`, `SWITCHROOM_CONFIG`, `SWITCHROOM_CLI_PATH` env

### Phase 8 — Docker Support
- Base agent Dockerfile (Node 22 + Bun + Claude Code + tmux)
- docker-compose.yml generation from switchroom.yaml
- Volume management for credentials, memory, config
- Container health checks
- `switchroom init --docker` path

## Non-Goals (v1)

- Not a harness — never intercepts Claude auth or inference
- Not multi-tenant — designed for single-operator use
- Not a hosted service — self-hosted only
- No custom LLM runtime — Claude Code is the runtime
- No mobile app — Telegram IS the mobile interface
- No voice/call channel — Telegram only for now

## Success Criteria

- `switchroom init && switchroom auth login --all && switchroom agent start all` works in under 5 minutes
- Each agent responds only in its assigned Telegram topic
- Agents maintain isolated memory across restarts
- Token refresh works unattended for weeks
- Adding a new agent takes <2 minutes (edit YAML, switchroom agent create, switchroom auth login)
- Templates provide useful starting points that users customize
- Project runs on any Linux box with Node 22+, Bun, and tmux
