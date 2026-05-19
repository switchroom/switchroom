<p align="center">
  <img src="docs/assets/switchroom-hero-wide.png" alt="Switchroom: opinionated Telegram UX for Claude Code on your Pro or Max subscription" width="100%">
</p>

# Switchroom

[![Tests](https://github.com/switchroom/switchroom/actions/workflows/ci-tests-core.yml/badge.svg?branch=main)](https://github.com/switchroom/switchroom/actions/workflows/ci-tests-core.yml)
[![Plugin tests](https://github.com/switchroom/switchroom/actions/workflows/ci-tests-plugin.yml/badge.svg?branch=main)](https://github.com/switchroom/switchroom/actions/workflows/ci-tests-plugin.yml)
[![Docker e2e](https://github.com/switchroom/switchroom/actions/workflows/docker-e2e.yml/badge.svg?branch=main)](https://github.com/switchroom/switchroom/actions/workflows/docker-e2e.yml)
[![Trigger evals](https://img.shields.io/endpoint?url=https%3A%2F%2Fgist.githubusercontent.com%2Fmekenthompson%2F002f3482b19111d35e57c1903b3733e2%2Fraw%2Fswitchroom-trigger-evals.json)](https://github.com/switchroom/switchroom/actions/workflows/ci-evals.yml)
[![Quality evals](https://img.shields.io/endpoint?url=https%3A%2F%2Fgist.githubusercontent.com%2Fmekenthompson%2F002f3482b19111d35e57c1903b3733e2%2Fraw%2Fswitchroom-quality-evals.json)](https://github.com/switchroom/switchroom/actions/workflows/ci-evals.yml)

**A switchboard for your Pro or Max.** Your Claude subscription, run as a fleet of always-on specialist agents you talk to from Telegram. Opinionated UX, done properly.

[Latest release notes →](CHANGELOG.md)

## Why this exists

> *I loved OpenClaw + Telegram. I wanted my Claude subscription. And the UX done properly. So I built this.*

You had the obvious idea. Run Claude Code agents 24/7 on a cheap Linux box, talk to them from Telegram, use the Pro or Max subscription you already pay for.

Two ways to do that today. Both miss:

- **OpenClaw + Telegram.** Great UX. But it hits the Anthropic API on your own key, so a token bill ticks over in the background. You signed up to use your subscription, not to buy API credits on top of it.
- **Claude Code's built-in Telegram channel.** Uses the subscription correctly. But it's an MVP black box. Send a message, wait, eventually something comes back. What did the agent actually do? Which tools ran? Did it get stuck? No idea.

Switchroom is the third option. Subscription-honest, and the UX done properly. The headline: the agent is never a black box and never silent. You always see what it is doing, what it is waiting on, and when it is done.

## See it work

Switchroom's UX is deterministic. Every agent topic carries a status line that is always one of three honest states, never a guess and never nothing:

```
🟡 quiet · no turns yet
⚙️ working since 2m ago
🟢 idle · last reply 5m ago
```

While the agent works, the reply streams in place (about once a second, not one delayed dump at the end) and tool steps render as they run with `MM:SS` durations. Long-running work gets a Steer button so you can redirect mid-turn without killing it. When an agent delegates, a sub-agent block shows the live fleet, up to 5 members, each with its role and current tool:

```
⚙️ Working…  ·  00:12
refactor the auth module to use JWT

✅ Read session.ts
✅ Grep "cookie"
🔵 Edit jwt.ts  ·  00:04

Sub-agents · 2 running
🔵 implement  ·  Edit jwt.ts
🔵 test-runner  ·  Bash npm test
                                   [ Steer ]
```

Older sub-agents collapse to `+N more` once the live set passes 5. Tool arguments are sanitised before they render: file paths show the basename only, token-shaped strings get redacted, so a secret never lands in a status message. The card is posted and edited in the topic, not pinned, so it never leaves a stale `⚙️ Working…` stranded at the top of your chat. [Full UX behaviour →](docs/telegram-plugin.md)

## Quickstart

Runs on the box you already have. Supported production runtime is Linux + Docker. Canonical target: Ubuntu 24.04 LTS, 4 GiB RAM minimum, 8 GiB once you run more than one agent. macOS (Docker Desktop) works for development, not yet release-validated.

**Fresh Linux box, one script:**

```bash
curl -fsSL https://github.com/switchroom/switchroom/raw/main/scripts/install-deps.sh | sudo bash
```

Installs Docker Engine + Compose v2, Node.js 20.11+, Bun, and the `@anthropic-ai/claude-code` + `switchroom` CLIs. Idempotent. Log out and back in so the docker group takes effect, then:

```bash
switchroom setup                       # interactive: Telegram + vault + first agent
switchroom apply                       # generate ~/.switchroom/compose/docker-compose.yml
docker compose -p switchroom -f ~/.switchroom/compose/docker-compose.yml up -d
switchroom auth add default --via-claude   # OAuth your Pro/Max account, AFTER the fleet is up
switchroom auth use default                # make it the fleet-wide active account
```

Auth comes after the fleet is up on purpose. The `switchroom-auth-broker` is the sole writer of credentials and does not exist until the compose stack is running. After this you talk to the agent from Telegram and never touch the server again. To catch a running host up later use `switchroom update`, not a raw `docker compose up` (a bare compose-up on a live fleet skips the operator restart-marker, so boot cards render as crashes).

**Already in Claude Code?** Shortest path. Inside any session:

```
/plugin marketplace add switchroom/switchroom
/plugin install switchroom@switchroom
/switchroom:setup
```

Full new-user walkthrough, zero to first Telegram message in ~15 minutes, plus the npm-only path, the no-wizard one-shot, the BotFather steps, and static-binary status: **[docs/install.md](docs/install.md)**.

## What you get

| Feature | What it does |
|---|---|
| **Deterministic UX** | Every topic shows an honest state: quiet, working since, or idle. Never a black box, never silent. The headline. |
| **Live step streaming** | The reply streams in place while tools run, with durations and a Steer button to redirect mid-turn. Not pinned, no stale cards. |
| **Sub-agent fleet view** | Delegated workers surface as live rows (up to 5, then `+N more`), each with role and current tool. Args sanitised before render. |
| **Claude Pro/Max auth** | OAuth, not API keys. No per-token billing. Fleet-wide active account plus fallback order, broker-owned refresh and credential fanout. |
| **Vault + approval kernel** | AES-256-GCM secrets. Per-agent least-privilege ACL. Anything extra needs your tap on an inline Telegram Approve/Deny card. |
| **Sub-agents** | Opus plans, Sonnet implements. Sub-agent work surfaces in the fleet block. |
| **Config cascade** | Defaults, then profiles, then per-agent YAML. Change one line, every agent updates. |
| **Scheduled tasks** | Cron-syntax tasks that fire across reboots. Headless secret access through the vault broker. |
| **Persistent memory** | Hindsight semantic memory, including a per-user mental model that carries across conversations. |
| **Always-on** | Long-running service per agent. Survives reboots, network drops, your laptop closing. Resumes mid-turn with a wake-audit. |
| **17 Telegram MCP tools** | reply, stream, react, edit, pin, delete, forward, typing, history, checklists (+update), stickers, GIFs, attachment download, ask-user, vault request access/save. |

## Subscription-honest, and safe by default

**Stock CLI, real OAuth.** Each agent runs the unmodified `claude` binary, authenticated with Anthropic through the same OAuth flow you use on the desktop app. No API key. No harness. No patched CLI. No proxied inference. One bill, the one you already pay. See the [Compliance Attestation](docs/compliance-attestation.md) for the full analysis against Anthropic's April 2026 third-party policy.

**Least privilege, and you hold the keys.** This is the core opinion. An agent never holds the vault passphrase and never sees a secret it was not given. Secrets live in an AES-256-GCM vault. Each agent reaches the vault broker over its own socket whose identity is the bind path, so a compromised agent cannot pose as another. An agent can read a key only if you listed it for that agent's task: that is the standing, least-privilege ACL. Anything beyond that is just-in-time. The agent asks, you get an inline Telegram Approve/Deny card showing exactly what and why, and only your tap mints a scoped, expiring grant. The agent cannot self-elevate.

<p align="center"><img src="docs/diagrams/approval-grant-flow.svg" width="700" alt="Approval grant flow: agent requests a key it does not have, broker stages a pending grant, you tap Allow on the Telegram card, broker mints a scoped TTL grant, the read proceeds"></p>

**The approval kernel gates risky actions too.** A separate kernel daemon handles action approvals on the same model: an agent that wants to write to a Google Doc requests it, ends its turn, and waits. You see the diff and tap Allow or Deny. Nothing destructive happens on the agent's say-so alone. TTL'd decisions expire, and every grant and denial is logged.

### How agents collaborate on files

Switchroom's position: agents should collaborate with you on real documents, not paste walls of text into chat. The supported path is Google Drive. An agent reads and proposes changes, and every write or suggestion is gated through the approval kernel exactly like a credential request, so an agent never silently edits your Drive. Today Drive is opt-in per agent: you connect a Google account and enable it for the agents that should have it (`switchroom drive connect <agent>`), and the broker enforces that allowlist at runtime. It is not on by default for a fresh agent.

## Survives real life

Always-on is not enough on its own. Things still die. The product has to handle that or the illusion breaks.

<p align="center"><img src="docs/diagrams/wake-audit-lifecycle.svg" width="700" alt="Wake-audit lifecycle: kill, crash-pane snapshot, auto-restart, agent boots with SWITCHROOM_PENDING_TURN, acks with three options"></p>

- **Auto-restart.** Agent containers run with `restart: unless-stopped` and only start once the auth-broker's healthcheck passes. The vault broker, approval kernel, and auth broker each have their own healthchecks, so a wedged dependency is caught instead of silently breaking agents.
- **Resume protocol.** When an agent reboots mid-turn it boots with `SWITCHROOM_PENDING_TURN` plus the original chat ids. Its first action is to acknowledge the gap and ask how to proceed: start over, summarise and continue, or drop it.
- **Wake-audit.** On every fresh boot the agent checks for owed replies, orphan sub-agents, and stale todos. Clean means it stays quiet. If it owed you a reply, it tells you.
- **Token refresh.** The `switchroom-auth-broker` owns the refresh loop and is the sole writer of every `credentials.json`. Per-account quota state fans out across the fleet in seconds, and `auth.fallback_order` cycles when an account is exhausted.

## How it stacks up

| | Switchroom | Claude Code channels | OpenClaw | NanoClaw |
|---|---|---|---|---|
| Progress visibility | Deterministic status, never silent | Black box | None | None |
| Runtime | Claude Code CLI | Claude Code CLI | Custom runtime | Agents SDK |
| Auth | Pro/Max OAuth | Pro/Max OAuth | API key | API key |
| Sub-agent tracking | Yes, live fleet block | No | No | No |
| Parallel display | Shared fleet status, up to 5 rows | No | No | No |
| Approval UX | Inline Telegram cards | None | None | None |
| Config | YAML with cascade | None | JSON/TOML | Env vars |
| Setup | `switchroom setup` | Built-in (limited) | Docker compose | Docker compose |

The wedge against OpenClaw and NanoClaw is not the substrate. It is the stock `claude` CLI under your subscription, instead of a custom runtime under your API key. [vs OpenClaw](docs/vs-openclaw.md) and [vs NanoClaw](docs/vs-nanoclaw.md).

## Architecture

One long-running service per agent. Each agent runs the stock `claude` CLI, not a fork, not the Agents SDK, not a wrapped harness, authenticated directly with Anthropic over official OAuth. Switchroom is scaffolding and lifecycle around the CLI you would run by hand: a Telegram bot, an approval kernel, a vault broker, an auth broker, and Docker Compose for supervision.

```
You (Telegram)
    │
    ▼
@YourBot ──┬── switchroom-telegram MCP ──┬── agent supervisor ─── Claude Code CLI
           │       (17 tools)            │     (per-agent)        │
           │                             │                        ├─ .claude/agents/*.md (sub-agents)
           ├─ Deterministic status       ├─ Approval kernel ◄─────┤   settings.json (tools, hooks, MCP)
           │   (quiet/working/idle)      │   (action grants)      ├─ Hindsight plugin (memory)
           ├─ Live step streaming        ├─ Vault broker ◄────────┤   Drive MCP, Playwright MCP, …
           ├─ Sub-agent fleet block      │   (per-agent ACL)      ├─ in-agent scheduler sidecar
           ├─ SQLite history             ├─ Auth broker ◄─────────┤   (cron, fires across reboots)
           └─ Emoji reactions            │   (OAuth refresh,       │
                                         │    sole creds writer)   │
                                         ├─ hostd (host-control:   │
                                         │   /restart, /update)    │
                                         └─ Docker Compose restart (unless-stopped)
```

See [`docs/architecture.md`](docs/architecture.md) for the process model, IPC layout, supervisor choice, and how each layer maps to the `claude` CLI.

## Documentation

| Guide | Description |
|---|---|
| **[Install](docs/install.md)** | Zero-to-first-message new-user walkthrough |
| **[BotFather walkthrough](docs/botfather-walkthrough.md)** | Step-by-step bot creation in Telegram |
| **[Configuration](docs/configuration.md)** | Full field reference, cascade semantics, profiles, example config |
| **[CLI reference](docs/cli-reference.md)** | Every verb, grouped, with behaviour and usage |
| **[Vault](docs/vault.md)** | Architecture, per-cron secrets, ACL, audit log, threat model |
| **[Telegram Plugin](docs/telegram-plugin.md)** | Deterministic UX, 17 MCP tools, checklists, sticker aliases, voice-in |
| **[Sub-Agents](docs/sub-agents.md)** | Model routing, delegation patterns, frontmatter spec |
| **[Scheduling](docs/scheduling.md)** | Cron tasks (in-agent scheduler sidecar), model selection |
| **[Session Management](docs/session-optimization.md)** | Continuity, compaction, freshness policy |
| **[Compliance](docs/compliance-attestation.md)** | Anthropic compliance analysis |
| **[Changelog](CHANGELOG.md)** | Release notes, every version |
| **[Telemetry](docs/posthog.md)** | What Switchroom reports to PostHog and how to opt out |

## FAQ

**Can I use a Claude Pro or Max subscription instead of an API key?**
Yes. That is the whole point. Switchroom runs the unmodified `claude` CLI with the same OAuth flow you use on the desktop app. No API key. No per-token billing.

**How is this different from Claude Code's built-in Telegram channel?**
The built-in channel is message in, message out, with no visibility into what the agent is doing in between. Switchroom shows a deterministic status on every topic (quiet, working, idle) and streams the steps in place as tools run. You always know the state, which is the bit the built-in channel gets wrong.

**Does it work with multiple agents at the same time?**
Yes. Each agent gets its own Telegram forum topic with its own status. When an agent delegates, its sub-agents show up as live rows in a shared fleet block (up to 5, then `+N more`), each with role and current tool.

**What does it cost to run?**
A cheap Linux VPS (around $6/mo on Hetzner, DigitalOcean, wherever), plus your existing Claude Pro ($20/mo) or Max ($100/mo) subscription. Switchroom itself is MIT-licensed, free.

**Is this against Anthropic's terms of service?**
No. Switchroom uses the official `claude` binary with the official OAuth flow. See [docs/compliance-attestation.md](docs/compliance-attestation.md) for the full analysis.

## Telemetry

Switchroom reports anonymous usage events and errors to PostHog so I can spot regressions and see which commands are used. **No personal data, code, or message content leaves your machine.** The anonymous ID at `~/.switchroom/analytics-id` is a random UUID, not tied to your username, email, IP, or machine identifier. Opt out with `export SWITCHROOM_TELEMETRY_DISABLED=1`. Full event catalogue at [docs/posthog.md](docs/posthog.md).

## License

MIT. See [CONTRIBUTING.md](CONTRIBUTING.md).
