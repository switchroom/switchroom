---
name: switchroom-install
description: Install switchroom and its dependencies (bun, node, docker, tmux, claude CLI) on a fresh machine. Use for onboarding and first-time setup — when the user says 'install switchroom on this machine', 'set up switchroom for the first time', 'bootstrap switchroom from scratch', 'get switchroom running', 'how do I get started with switchroom', "I'm new to switchroom, where do I begin", or asks about switchroom dependencies or prerequisites. This is the onboarding entry point, not for managing existing agents.
---

# Install Switchroom

When the user asks to install, set up, bootstrap, or get started with switchroom — or when they're new to switchroom and want to know where to begin — walk them through this flow. Switchroom turns a Linux server + their Claude Pro/Max subscription into always-on Claude Code agents reachable from Telegram.

Switchroom's dependencies are: **bun** (TypeScript runtime), **node** 22+ (via nvm), **docker** (for plugins), **tmux** (for agent sessions), and the **claude** Code CLI (authenticates against Claude Pro/Max). Always enumerate these explicitly when the user asks about dependencies or prerequisites.

## Step 0 — Detect existing install

Before doing anything, check whether switchroom is already installed:

```bash
command -v switchroom && switchroom --version 2>/dev/null
```

If switchroom is present, tell the user it's already installed and then — regardless — run the dependency audit in Step 2 so they see the state of **bun**, **node**, **docker**, **tmux**, and **claude**. Users who ask "install switchroom and its dependencies" want to see the dependency inventory even when switchroom itself is already installed. After the audit, offer `switchroom setup` (re-run the wizard), `switchroom doctor` (diagnose), or `switchroom agent list` (see what's running). Do not reinstall switchroom itself without explicit confirmation.

## Step 1 — Verify prerequisites

Switchroom requires Ubuntu 24.04 LTS (or compatible Debian-based Linux) with ≥4GB RAM. Check:

```bash
. /etc/os-release && echo "$PRETTY_NAME"
free -h | awk '/^Mem:/ {print $2}'
uname -m
```

If the user is on macOS or Windows, stop and explain: switchroom runs on Linux servers (typically a $6/mo VPS). Point them at the README's "Quick Start" — they'll want to provision a Linux box first.

## Step 2 — Install system dependencies

Only install what's missing. Check each first:

```bash
# System packages
for pkg in tmux expect docker.io; do
  dpkg -s "$pkg" >/dev/null 2>&1 || echo "MISSING: $pkg"
done

# Bun
command -v bun || echo "MISSING: bun"

# Node 22+ (via nvm)
node -v 2>/dev/null || echo "MISSING: node"

# Claude Code CLI
command -v claude || echo "MISSING: claude"
```

For anything missing, run the corresponding install step:

```bash
# apt packages
sudo apt update && sudo apt install -y tmux expect docker.io

# bun
curl -fsSL https://bun.sh/install | bash

# nvm + node 22
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc
nvm install 22

# claude code
npm install -g @anthropic-ai/claude-code

# docker group (user needs to log out/in or newgrp)
sudo usermod -aG docker "$USER"
```

**Important:** After `usermod -aG docker`, the user needs a new shell for group membership to apply. Mention this explicitly.

## Step 3 — Clone and build switchroom

```bash
git clone https://github.com/mekenthompson/switchroom.git ~/code/switchroom
cd ~/code/switchroom && bun install && bun link
```

Verify:

```bash
switchroom --version
```

## Step 4 — Run setup wizard

`switchroom setup` is an interactive wizard that configures the Telegram bot token, forum chat, and first agent. **It requires a terminal the user controls** — if you're running inside an agent session, you cannot drive it yourself. Tell the user:

> Run `switchroom setup` in your own terminal. It'll ask for your Telegram bot token and walk you through creating your first agent. Come back when it finishes and I can verify with `switchroom doctor`.

## Step 5 — Verify

After `switchroom setup` completes:

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
- **Do not** install switchroom system-wide (no `sudo npm install -g switchroom`). Switchroom is a bun-linked binary from a user-owned checkout.
- **Do not** reinstall over an existing install without asking. If the user wants a clean slate, have them run `switchroom uninstall` first (or confirm they want to blow away `~/.switchroom/`).
