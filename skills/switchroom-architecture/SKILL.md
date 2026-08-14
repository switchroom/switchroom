---
name: switchroom-architecture
description: Explains how switchroom works internally — config cascade, profiles, settings resolution, agent lifecycle, plugin system. Use when the user asks 'how does switchroom work internally', 'how does the cascade decide', 'which settings apply', architecture, design, or internals. Do NOT use for onboarding or getting-started questions ('how do I get started', 'I'm new to switchroom', 'bootstrap from scratch', 'set up for the first time') — those belong to switchroom-install.
user-invocable: false
---

# Switchroom Architecture Overview

Switchroom is a multi-agent orchestrator built on Claude Code. It manages multiple Claude agents, each running as a persistent process with its own Telegram bot, memory collection, and configuration.

## Key concepts

**One `switchroom.yaml` to rule them all.** All agents are configured from a single file using a three-layer cascade. See [cascade.md](cascade.md) for full merge semantics.

**Agents as Docker containers.** Each agent runs as a long-lived `claude` process inside its own container (`switchroom-<name>`), supervised by Docker Compose with `restart: always` (`src/agents/compose.ts`). The agent service itself has NO healthcheck — it `depends_on` `vault-broker` (`service_started`), `approval-kernel` (`service_started`), and `switchroom-auth-broker` (`service_healthy`), so it waits on the auth-broker's healthcheck before booting. Healthchecks exist on `vault-broker`, `approval-kernel`, `switchroom-auth-broker`, and `voice-sidecar` — not on the agent container. The `start.sh` script sets environment variables and execs into `claude`. Claude Code handles session persistence and tool execution.

**Telegram as the primary interface.** The `switchroom-telegram` MCP plugin connects Claude Code to Telegram, providing message-handling tools (see [telegram.md](telegram.md) for the current tool list and categories — don't hard-code a count here, it drifts).

**Hindsight for memory.** Cross-session memory uses the Hindsight MCP server — a semantic vector store with knowledge graphs, mental models, and directives. Each agent has its own named collection.

**Skills as reusable behavior.** Shared skills live in `~/.switchroom/skills/` (or `switchroom.skills_dir`). Scaffold symlinks selected skills into each agent's `.claude/skills/` directory (`src/agents/scaffold.ts`; `migrateLegacySkillsDir` migrates any pre-existing symlinks from the old `<agentDir>/skills/` location). Claude Code loads them at session start.

**Beyond the agent containers.** The agent fleet's compose file (`generateCompose`, `src/agents/compose.ts`) emits the per-agent `switchroom-<name>` services plus three shared services every agent depends on: `vault-broker`, `approval-kernel`, and `switchroom-auth-broker` (agent `depends_on`, `src/agents/compose.ts` around `emitAgentService`'s `depends_on` block). Optionally, per-agent `voice-sidecar` services are emitted too. `hostd` (`src/cli/hostd.ts`) and `web` (`src/cli/webd.ts`) run as their OWN separate compose projects (`switchroom-hostd`, `switchroom-web`) — not part of the agent fleet compose file, and not self-healing on an image-pin bump the way agents are.

## Directory layout

```
~/.switchroom/
├── switchroom.yaml              # master config
├── vault.enc               # encrypted secrets
├── skills/                 # global skills pool (symlinked per agent)
│   └── <skill-name>/
│       └── SKILL.md
└── agents/
    └── <name>/
        ├── start.sh        # launcher (sets env, execs claude)
        ├── settings.json   # Claude Code settings
        ├── .mcp.json       # MCP server config
        ├── CLAUDE.md       # agent identity (reconcile rewrites content ABOVE the
        │                   # `# --- Yours ---` marker; below it always survives.
        │                   # `--preserve-claude-md` opts out of the rewrite.)
        ├── .claude/
        │   ├── agents/     # sub-agent definition files
        │   └── skills/     # symlinks to ~/.switchroom/skills/<name>/
        └── telegram/
            ├── history.db  # SQLite message buffer
            └── access.json # per-agent access control
```

## Lifecycle

1. `switchroom agent create <name>` — scaffold agent from switchroom.yaml
2. `switchroom apply` — write `~/.switchroom/compose/docker-compose.yml`
3. `docker compose -p switchroom -f ~/.switchroom/compose/docker-compose.yml up -d` — start the container
4. Claude Code boots, loads CLAUDE.md + skills + .mcp.json
5. MCP servers connect (Hindsight, switchroom-telegram, others)
6. Telegram plugin polls for messages
7. User sends message → plugin fires `UserPromptSubmit` hook → Claude responds
8. `switchroom agent reconcile <name>` — re-apply switchroom.yaml (rewrites `.mcp.json` + `settings.json` + `start.sh` + CLAUDE.md's managed section above the `# --- Yours ---` marker; pass `--preserve-claude-md` to skip the CLAUDE.md rewrite)

## Deep dives

- [cascade.md](cascade.md) — three-layer config cascade semantics
- [sub-agents.md](sub-agents.md) — delegation patterns and model routing
- [telegram.md](telegram.md) — enhanced Telegram plugin features

**Why it's built this way** lives in the repo's `reference/` directory — the
design contract (`reference/README.md` is the map: vision, principles,
invariants, product spec, job specs, RFCs). For "why does switchroom do X"
questions, that is the source of truth; `docs/` is usage/operation only.
