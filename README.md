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

Switchroom is the third option. Subscription-honest, and the UX done properly. The headline is a live progress card that pins to the chat and shows every step as it happens.

## See it work

Every time an agent starts work a progress card pins into its Telegram topic and updates in place as tools run. Each Read, Bash, Edit, Grep shows as it happens, with elapsed time so you can tell if something is stuck. Sub-agents surface in the same card. When the agent finishes, the card flips to Done and unpins.

No silent gaps. No ghosts. No squinting into a black box.

```
⚙️ Working… · ⏱ 12s
💬 refactor the auth module to use JWT
  ─ ─ ─
  … (+3 more earlier steps)
  ✅ Read src/auth/session.ts
  ✅ Grep "cookie" (in src/)
  🤖 Edit src/auth/jwt.ts · 4s
```

<p align="center"><img src="docs/diagrams/progress-card-anatomy.svg" width="700" alt="Annotated progress card: pin badge, user quote, last 5 steps, collapsed older, in-flight pulse, elapsed timer, sub-agent indent"></p>

The card is the headline. The rest of the product keeps it honest: updates throttled to once every 5 seconds, last 5 steps visible with older ones collapsed, deterministic tool labels written by a `PreToolUse` hook so the card never lies about what is running. Two agents at once each get their own card, labelled `(1/2)` and `(2/2)`. [Full card behaviour →](docs/telegram-plugin.md)

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
| **Progress cards** | Pinned, in-place, every tool call visible. The headline UX. Every edit also appended to a local `card-events.jsonl` audit log. |
| **Claude Pro/Max auth** | OAuth, not API keys. No per-token billing. Fleet-wide active account plus fallback order, broker-owned refresh and credential fanout. |
| **Approval kernel** | Inline Allow/Deny cards in Telegram for every gated tool. TTL'd grants, full audit trail. |
| **Sub-agents** | Opus plans, Sonnet implements. Sub-agent work surfaces in the parent card. |
| **Config cascade** | Defaults, then profiles, then per-agent YAML. Change one line, every agent updates. |
| **Scheduled tasks** | Cron-syntax tasks that fire across reboots. Headless secret access through the vault broker. |
| **Persistent memory** | Hindsight semantic memory with knowledge graphs and mental models. |
| **Always-on** | Long-running service per agent. Survives reboots, network drops, your laptop closing. Resumes mid-turn with a wake-audit. |
| **Encrypted vault** | AES-256-GCM for secrets. Optional auto-unlock keyed off `/etc/machine-id`. |
| **15 Telegram MCP tools** | Reply, stream, edit, pin, react, native checklists, sticker aliases, voice-in transcription, attachments, history. Plus per-agent Google Drive read. |

## Subscription-honest, and safe by default

**Stock CLI, real OAuth.** Each agent runs the unmodified `claude` binary, authenticated with Anthropic through the same OAuth flow you use on the desktop app. No API key. No harness. No patched CLI. No proxied inference. One bill, the one you already pay. See the [Compliance Attestation](docs/compliance-attestation.md) for the full analysis against Anthropic's April 2026 third-party policy.

**Approval kernel.** Tools that touch the world (Bash, Edit, Write, anything off an agent's allowlist) pause for an inline Telegram card showing the actual diff or command. Tap Allow and the tool resumes. Tap Deny and the agent gets a clean refusal it can recover from. TTL'd grants expire on their own, every grant and denial is logged, and a per-agent allowlist covers the boring tools you do not want to be asked about. The agent never decides its own permissions. It asks and waits.

<p align="center"><img src="docs/diagrams/approval-grant-flow.svg" width="700" alt="Approval grant flow: agent tool call pauses at the kernel, broker writes pending grant to sqlite, user taps Allow on the Telegram card, broker releases the gate, tool resumes"></p>

**Encrypted vault.** Secrets sit in an AES-256-GCM store. Scheduled tasks run headless, so they cannot prompt for a passphrase. The vault broker holds the vault decrypted in memory after a one-time unlock, and a cron only ever reads the specific keys it declares, over a per-agent unix socket whose identity is the bind path and cannot be spoofed by a compromised agent. Optional boot auto-unlock derives a key from `/etc/machine-id` for unattended hosts. [Vault guide](docs/vault.md) and [auto-unlock threat model](docs/auto-unlock.md).

## Survives real life

Always-on is not enough on its own. Things still die. The product has to handle that or the illusion breaks.

<p align="center"><img src="docs/diagrams/wake-audit-lifecycle.svg" width="700" alt="Wake-audit lifecycle: kill, crash-pane snapshot, auto-restart, agent boots with SWITCHROOM_PENDING_TURN, acks with three options"></p>

- **Auto-restart.** Agent containers come up with `restart: unless-stopped` and a healthcheck. A crashed or wedged agent is brought back automatically. No silent dropped work.
- **Resume protocol.** When an agent reboots mid-turn it boots with `SWITCHROOM_PENDING_TURN` plus the original chat ids. Its first action is to acknowledge the gap and ask how to proceed: start over, summarise and continue, or drop it.
- **Wake-audit.** On every fresh boot the agent checks for owed replies, orphan sub-agents, and stale todos. Clean means it stays quiet. If it owed you a reply, it tells you.
- **Token refresh.** The `switchroom-auth-broker` owns the refresh loop and is the sole writer of every `credentials.json`. Per-account quota state fans out across the fleet in seconds, and `auth.fallback_order` cycles when an account is exhausted.

## How it stacks up

| | Switchroom | Claude Code channels | OpenClaw | NanoClaw |
|---|---|---|---|---|
| Progress visibility | Live cards, pinned | Black box | None | None |
| Runtime | Claude Code CLI | Claude Code CLI | Custom runtime | Agents SDK |
| Auth | Pro/Max OAuth | Pro/Max OAuth | API key | API key |
| Sub-agent tracking | Yes, in card | No | No | No |
| Parallel task display | Labelled cards `(1/N)` | No | No | No |
| Approval UX | Inline Telegram cards | None | None | None |
| Config | YAML with cascade | None | JSON/TOML | Env vars |
| Setup | `switchroom setup` | Built-in (limited) | Docker compose | Docker compose |

The wedge against OpenClaw and NanoClaw is not the substrate. It is the stock `claude` CLI under your subscription, instead of a custom runtime under your API key. [vs OpenClaw](docs/vs-openclaw.md) and [vs NanoClaw](docs/vs-nanoclaw.md).

## Architecture

One long-running service per agent. Each agent runs the stock `claude` CLI, not a fork, not the Agents SDK, not a wrapped harness, authenticated directly with Anthropic over official OAuth. Switchroom is scaffolding and lifecycle around the CLI you would run by hand: a Telegram bot, an approval broker, a vault broker, an auth broker, and Docker Compose for supervision.

```
You (Telegram)
    │
    ▼
@YourBot ──┬── switchroom-telegram MCP ──┬── agent supervisor ─── Claude Code CLI
           │       (15 tools)            │     (per-agent)        │
           │                             │                        ├─ .claude/agents/*.md (sub-agents)
           ├─ Progress cards             ├─ Approval kernel ◄─────┤   settings.json (tools, hooks, MCP)
           ├─ Pin / unpin lifecycle      │   (allow/deny broker)  ├─ Hindsight plugin (memory)
           ├─ SQLite history             ├─ Vault broker ◄────────┤   Drive MCP, Playwright MCP, …
           ├─ Card-events.jsonl audit    ├─ Auth broker ◄─────────┤   in-agent scheduler sidecar
           ├─ Emoji reactions            │   (OAuth refresh,       └─ (cron, fires across reboots)
           └─ Format conversion          │    sole creds writer)
                                         ├─ hostd (host-control:
                                         │   /restart, /update apply)
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
| **[Telegram Plugin](docs/telegram-plugin.md)** | Progress cards, 15 MCP tools, native checklists, sticker aliases, voice-in |
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
The built-in channel is message in, message out, with no visibility into what the agent is doing in between. Switchroom adds live progress cards that pin to the top of each topic and update as tools run. You can always see what is happening, which is the bit the built-in channel gets wrong.

**Does it work with multiple agents at the same time?**
Yes. Each agent gets its own Telegram forum topic. When several work at once, each has its own pinned progress card labelled `(1/N)`, `(2/N)`, and so on. Sub-agent work shows up indented inside the parent's card.

**What does it cost to run?**
A cheap Linux VPS (around $6/mo on Hetzner, DigitalOcean, wherever), plus your existing Claude Pro ($20/mo) or Max ($100/mo) subscription. Switchroom itself is MIT-licensed, free.

**Is this against Anthropic's terms of service?**
No. Switchroom uses the official `claude` binary with the official OAuth flow. See [docs/compliance-attestation.md](docs/compliance-attestation.md) for the full analysis.

## Telemetry

Switchroom reports anonymous usage events and errors to PostHog so I can spot regressions and see which commands are used. **No personal data, code, or message content leaves your machine.** The anonymous ID at `~/.switchroom/analytics-id` is a random UUID, not tied to your username, email, IP, or machine identifier. Opt out with `export SWITCHROOM_TELEMETRY_DISABLED=1`. Full event catalogue at [docs/posthog.md](docs/posthog.md).

## License

MIT. See [CONTRIBUTING.md](CONTRIBUTING.md).
