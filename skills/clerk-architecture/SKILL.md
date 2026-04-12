---
name: clerk-architecture
description: Provides context about clerk's architecture — config cascade, profile system, sub-agent delegation, session management, Telegram plugin, and scheduling. Use when answering questions about how clerk works, its design, or internal architecture.
user-invocable: false
---

# Clerk Architecture Overview

Clerk is a multi-agent orchestrator built on Claude Code. It manages multiple Claude agents, each running as a persistent process with its own Telegram bot, memory collection, and configuration.

## Key concepts

**One `clerk.yaml` to rule them all.** All agents are configured from a single file using a three-layer cascade. See [cascade.md](cascade.md) for full merge semantics.

**Agents as systemd services.** Each agent runs as a long-lived `claude` process managed by a systemd user service (`clerk-<name>.service`). The `start.sh` script sets environment variables and execs into `claude`. Claude Code handles session persistence and tool execution.

**Telegram as the primary interface.** The `clerk-telegram` MCP plugin connects Claude Code to Telegram, providing 10 tools for message handling. See [telegram.md](telegram.md) for details.

**Hindsight for memory.** Cross-session memory uses the Hindsight MCP server — a semantic vector store with knowledge graphs, mental models, and directives. Each agent has its own named collection.

**Skills as reusable behavior.** Shared skills live in `~/.clerk/skills/` (or `clerk.skills_dir`). Scaffold symlinks selected skills into each agent's `skills/` directory. Claude Code loads them at session start.

## Directory layout

```
~/.clerk/
├── clerk.yaml              # master config
├── vault.enc               # encrypted secrets
├── skills/                 # global skills pool (symlinked per agent)
│   └── <skill-name>/
│       └── SKILL.md
└── agents/
    └── <name>/
        ├── start.sh        # launcher (sets env, execs claude)
        ├── settings.json   # Claude Code settings
        ├── .mcp.json       # MCP server config
        ├── CLAUDE.md       # agent identity (never overwritten by reconcile)
        ├── skills/         # symlinks to ~/.clerk/skills/<name>/
        ├── .claude/
        │   └── agents/     # sub-agent definition files
        └── telegram/
            ├── history.db  # SQLite message buffer
            └── access.json # per-agent access control
```

## Lifecycle

1. `clerk agent create <name>` — scaffold agent from clerk.yaml
2. `systemctl --user start clerk-<name>` — start the process
3. Claude Code boots, loads CLAUDE.md + skills + .mcp.json
4. MCP servers connect (Hindsight, clerk-telegram, others)
5. Telegram plugin polls for messages
6. User sends message → plugin fires `UserPromptSubmit` hook → Claude responds
7. `clerk agent reconcile <name>` — re-apply clerk.yaml (no CLAUDE.md touch)

## Deep dives

- [cascade.md](cascade.md) — three-layer config cascade semantics
- [sub-agents.md](sub-agents.md) — delegation patterns and model routing
- [telegram.md](telegram.md) — enhanced Telegram plugin features
