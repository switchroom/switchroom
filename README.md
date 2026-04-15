# Switchroom — Transparent Claude Code agents on Telegram

[![Build status](https://badge.buildkite.com/443b450a779c30f5824660f5062f8c29101cd4419831ee3aff.svg)](https://buildkite.com/ken-thompson/switchroom)
[![Tests](https://img.shields.io/endpoint?url=https%3A%2F%2Fgist.githubusercontent.com%2Fmekenthompson%2F002f3482b19111d35e57c1903b3733e2%2Fraw%2Fswitchroom-tests.json)](https://buildkite.com/ken-thompson/switchroom)
[![Trigger evals](https://img.shields.io/endpoint?url=https%3A%2F%2Fgist.githubusercontent.com%2Fmekenthompson%2F002f3482b19111d35e57c1903b3733e2%2Fraw%2Fswitchroom-trigger-evals.json)](https://buildkite.com/ken-thompson/switchroom)
[![Quality evals](https://img.shields.io/endpoint?url=https%3A%2F%2Fgist.githubusercontent.com%2Fmekenthompson%2F002f3482b19111d35e57c1903b3733e2%2Fraw%2Fswitchroom-quality-evals.json)](https://buildkite.com/ken-thompson/switchroom)

**Run Claude Code agents 24/7 on a server, talk to them from Telegram — and see exactly what they're doing.**

## The problem with Claude Code's built-in Telegram channel

Claude Code ships a Telegram channel integration. It works, barely. You send a message, the agent does something, eventually a reply shows up. What happens in between is a complete black box. There's no visibility into what tools are running, whether the agent is stuck, whether it spawned a sub-agent, or how long anything took. It ghosts you.

That's the problem Switchroom solves.

## What Switchroom does differently

Switchroom is a **Telegram-native orchestration layer** built on top of Claude Code — not a fork, not a wrapper, fully compliant with the official `claude` CLI and OAuth. It extends Claude Code's channel integration with live progress tracking you can actually follow.

Every time an agent starts work, a **progress card** appears in Telegram and stays pinned while the task is running. The card updates in place as tools execute — you see each step as it happens, not just the final answer.

```
⚙️ Working… · ⏱ 12s
💬 refactor the auth module to use JWT
─ ─ ─
  … (+3 more earlier steps)
✅ Read src/auth/session.ts
✅ Grep "cookie" (in src/)
🤖 Edit src/auth/jwt.ts · 4s
```

When the task finishes, the card updates to Done and unpins. If two tasks are running in parallel (different agents, different topics), cards are labeled `(1/2)` and `(2/2)` so you can track both at a glance.

**Key UX guarantees:**
- Cards update at most every 5 seconds — fast enough to follow, no flood
- The last 5 steps are always visible; older ones collapse into `(+N more earlier steps)`
- Running steps show elapsed time so you can see if something is stuck
- Sub-agents get their own section in the card — you see nested work, not just top-level calls
- No silent gaps. No ghosts.

## Architecture

```
You (Telegram)
    │
    ▼
@YourBot ──── switchroom-telegram MCP ──── Claude Code CLI
                  │                        │
                  ├─ Progress cards         ├─ .claude/agents/*.md (sub-agents)
                  ├─ Pin / unpin lifecycle  ├─ settings.json (tools, hooks, MCP)
                  ├─ SQLite history         ├─ Hindsight plugin (memory)
                  ├─ Emoji reactions        └─ systemd (agent + cron timers)
                  └─ Format conversion
```

Switchroom is **not a harness**. Each agent runs the unmodified `claude` binary, authenticated directly with Anthropic via official OAuth. No credential interception, no API key routing.

## Everything else you get

| Feature | Description |
|---------|-------------|
| **Claude Pro/Max auth** | OAuth — no API key, no per-token billing |
| **Multi-agent** | Opus plans, Sonnet implements in the background. Sub-agent activity surfaces in the card. |
| **Config cascade** | Defaults → profiles → per-agent YAML. Change one line, all agents update. |
| **Scheduled tasks** | Cron-based systemd timers, survive reboots |
| **Persistent memory** | Hindsight semantic memory with knowledge graphs |
| **Session continuity** | Resume sessions across restarts with freshness gating |
| **Encrypted vault** | AES-256-GCM for secrets |
| **10 Telegram MCP tools** | Reply, pin, react, history, attachments, stream progress, and more |

## Compared to alternatives

| | Switchroom | Claude Code channels | OpenClaw | NanoClaw |
|---|---|---|---|---|
| Progress visibility | Live progress cards, pinned | None — black box | None | None |
| Runtime | Claude Code CLI | Claude Code CLI | Custom runtime | Agents SDK |
| Auth | Pro/Max OAuth | Pro/Max OAuth | API key | API key |
| Sub-agent tracking | Yes, visible in card | No | No | No |
| Parallel task display | Labeled cards (1/N) | No | No | No |
| Config | YAML with cascade | None | JSON/TOML | ENV vars |
| Setup | `switchroom setup` | Built-in (limited) | Docker compose | Docker compose |

## Install

```bash
# Node 20.11+ required
npm install -g switchroom-ai

switchroom --version

# Interactive wizard — installs deps, scaffolds config, links Telegram
switchroom setup
```

## Quick Start (manual)

```bash
# Prerequisites: Ubuntu 24.04 LTS, 4GB RAM
sudo apt update && sudo apt install -y tmux expect
curl -fsSL https://bun.sh/install | bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash && \
  source ~/.bashrc && nvm install 22
npm install -g @anthropic-ai/claude-code

# Install Switchroom
git clone https://github.com/switchroom/switchroom.git ~/code/switchroom
cd ~/code/switchroom && bun install && bun link

# Setup
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
switchroom agent grant <name> <tool>          # Grant a tool permission
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
| **[Configuration](docs/configuration.md)** | Full field reference, cascade semantics, profiles |
| **[Telegram Plugin](docs/telegram-plugin.md)** | Progress cards, 10 MCP tools, emoji reactions |
| **[Sub-Agents](docs/sub-agents.md)** | Model routing, delegation patterns, frontmatter spec |
| **[Scheduling](docs/scheduling.md)** | Cron tasks, systemd timers, model selection |
| **[Session Management](docs/session-optimization.md)** | Continuity, compaction, freshness policy |
| **[OpenClaw alternative](docs/vs-openclaw.md)** | Switchroom vs OpenClaw |
| **[NanoClaw alternative](docs/vs-nanoclaw.md)** | Switchroom vs NanoClaw |
| **[Compliance](docs/compliance-attestation.md)** | Anthropic compliance analysis |

## FAQ

**Can I use a Claude Pro or Max subscription instead of an API key?**
Yes — that's the whole point. Switchroom runs the unmodified `claude` CLI with the same OAuth flow you use on the desktop app. No API key, no per-token billing.

**How is this different from Claude Code's built-in Telegram channel?**
The built-in channel gives you a message in, message out experience with no visibility into what the agent is doing. Switchroom adds live progress cards that pin to the top of each topic and update in real time as tools execute. You can always see what's happening.

**Does it work with multiple agents at the same time?**
Yes. Each agent gets its own Telegram forum topic. When multiple agents are working simultaneously, each has its own pinned progress card labeled `(1/N)`, `(2/N)` etc.

**Can I see what sub-agents are doing?**
Yes. When an agent delegates to a sub-agent (e.g. a worker or researcher), the sub-agent's activity appears in its own section of the progress card. You see the full hierarchy, not just the top-level agent.

**What does Switchroom cost to run?**
A cheap Linux VPS (~$6/mo on Hetzner/DigitalOcean/etc), plus your existing Claude Pro ($20/mo) or Max ($100/mo) subscription. Switchroom itself is MIT-licensed open source.

**Is this against Anthropic's terms of service?**
Switchroom uses the official `claude` binary with the official OAuth flow. See [docs/compliance-attestation.md](docs/compliance-attestation.md) for the full analysis.

**Is Switchroom an alternative to OpenClaw?**
Yes. Switchroom covers the same use case but uses your Claude subscription via OAuth instead of an API key, and runs the native `claude` binary instead of a custom runtime in Docker. See [vs-openclaw](docs/vs-openclaw.md).

## License

MIT — See [CONTRIBUTING.md](CONTRIBUTING.md).
