---
name: switchroom-install
description: Install switchroom and its dependencies (docker, claude CLI, switchroom binary) on a fresh machine. Use for onboarding and first-time setup — when the user says 'install switchroom on this machine', 'set up switchroom for the first time', 'bootstrap switchroom from scratch', 'get switchroom running', 'how do I get started with switchroom', "I'm new to switchroom, where do I begin", or asks about switchroom dependencies or prerequisites. This is the onboarding entry point, not for managing existing agents. Do NOT use when the user's message starts with "In switchroom agent management," — that prefix is a hard trigger for `switchroom-manage` even when the action mentions "reinstall my agents" or "set up my agents"; agent-management prefix means fleet operations on an already-installed switchroom, not first-time host bootstrap.
---

# Install Switchroom

When the user asks to install, set up, bootstrap, or get started with switchroom — or when they're new to switchroom and want to know where to begin — walk them through this flow. Switchroom turns a Linux server + their Claude Pro/Max subscription into always-on Claude Code agents reachable from Telegram.

Switchroom v0.7+ ships as a self-contained static binary (no host bun or node runtime required) and runs the agent fleet in Docker containers pulled from GHCR. The two host dependencies are: **docker** (engine 24+ with the compose v2 plugin) and the **claude** Code CLI (used for OAuth login against your Pro/Max subscription).

## Step 0 — Detect existing install

Before doing anything, check whether switchroom is already installed:

```bash
command -v switchroom && switchroom --version 2>/dev/null
```

If switchroom is present, tell the user it's already installed and then — regardless — run the dependency audit in Step 2 so they see the state of **docker** and **claude**. After the audit, offer `switchroom setup` (re-run the wizard), `switchroom doctor` (diagnose), or `switchroom agent list` (see what's running). Do not reinstall switchroom itself without explicit confirmation.

## Step 1 — Verify prerequisites

Switchroom requires Linux with Docker (Ubuntu 24.04 LTS canonical; ≥4GB RAM):

```bash
. /etc/os-release && echo "$PRETTY_NAME"
free -h | awk '/^Mem:/ {print $2}'
uname -m
```

If the user is on macOS or Windows, stop and explain: switchroom's release-validated production runtime is Linux. macOS (Docker Desktop) works for development but isn't yet release-gated. Windows users need WSL2.

## Step 2 — Install host dependencies

Only install what's missing. Check each first:

```bash
# Docker
command -v docker || echo "MISSING: docker"
docker compose version >/dev/null 2>&1 || echo "MISSING: docker compose v2"

# Claude Code CLI (needed for switchroom auth login)
command -v claude || echo "MISSING: claude"
```

For anything missing:

```bash
# Docker (Ubuntu/Debian)
sudo apt update && sudo apt install -y docker.io docker-compose-plugin
sudo usermod -aG docker "$USER"   # log out/in or `newgrp docker` to apply

# Claude Code CLI (needs Node 20.11+)
npm install -g @anthropic-ai/claude-code
```

**Important:** After `usermod -aG docker`, the user needs a new shell for group membership to apply. Mention this explicitly.

## Step 3 — Install the switchroom binary

The recommended path is the static-binary one-liner — auto-detects platform/arch, downloads the matching pre-built binary from the latest GitHub release, verifies its SHA256, and installs to `/usr/local/bin` (or `~/.local/bin` if not writable):

```bash
curl -fsSL https://github.com/switchroom/switchroom/raw/main/install.sh | sh
```

Verify:

```bash
switchroom --version
```

(For development against a source checkout, `git clone` + `bun install` + `bun link` still works — see `docs/operators/install.md`. Don't suggest the source path for first-time users.)

## Step 4 — Run setup wizard

`switchroom setup` is an interactive wizard that wires the operator's Telegram bot token, sets up the vault, and scaffolds a first agent. DM-only by default — no forum chat ID required up front. **It requires a terminal the user controls** — if you're running inside an agent session, you cannot drive it yourself. Tell the user:

> Run `switchroom setup` in your own terminal. It'll ask for your Telegram bot token and walk you through creating your first agent. Come back when it finishes and I can verify with `switchroom doctor`.

## Step 5 — Apply and bring up the fleet

After `switchroom setup` completes, three commands take you from config to a running fleet:

```bash
switchroom apply
docker compose -p switchroom -f ~/.switchroom/compose/docker-compose.yml pull
docker compose -p switchroom -f ~/.switchroom/compose/docker-compose.yml up -d --remove-orphans
```

`switchroom apply` reconciles every agent declared in `switchroom.yaml` and writes `~/.switchroom/compose/docker-compose.yml`. The CLI deliberately does not run `docker` for you — operators own the bring-up. The first `pull` fetches the 5 GHCR images (~1-2 GB total); subsequent pulls are layer-only.

## Step 6 — Verify

```bash
switchroom doctor
switchroom agent list
```

If `switchroom doctor` reports healthy and at least one agent is listed, installation is complete. Offer to invoke the `switchroom-status` or `switchroom-health` skill for a deeper look.

### Optional follow-up: share one Anthropic account across multiple agents

Once the first agent is up and authenticated, the user can promote that agent's auth to a global Anthropic account so additional agents share the same Pro/Max subscription without each running its own OAuth flow. See `switchroom-manage` (Anthropic accounts section) for the bootstrap flow. This is the path most users want when they add a second agent — flag it as soon as they ask "how do I add another agent?".

## What not to do

- **Do not** run `switchroom setup` non-interactively or pipe input to it — it's designed for a human.
- **Do not** edit `~/.switchroom/vault.enc` or any file under `~/.switchroom/` directly. Use the CLI.
- **Do not** run `docker build` on the operator's host. The 5 fleet images are published on GHCR; `switchroom apply` writes a compose file that pulls them.
- **Do not** suggest the legacy `switchroom up` / `switchroom init` / `switchroom update` verbs — they were removed in v0.7. The current flow is `switchroom apply && docker compose pull && docker compose up -d`.
- **Do not** reinstall over an existing install without asking. If the user wants a clean slate, have them run `switchroom uninstall` first (or confirm they want to blow away `~/.switchroom/`).
