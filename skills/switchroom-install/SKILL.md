---
name: switchroom-install
description: Install and set up switchroom on a fresh machine. Use when the user says 'install switchroom', 'set up switchroom', 'bootstrap switchroom', 'get switchroom running', 'I'm new to switchroom', or asks how to get started with switchroom from scratch.
---

# Install Switchroom

When the user asks to install, set up, or bootstrap switchroom, walk them through this flow. Switchroom turns a Linux server + their Claude Pro/Max subscription into always-on Claude Code agents reachable from Telegram.

## Step 0 — Detect existing install

Before doing anything, check whether switchroom is already installed:

```bash
command -v switchroom && switchroom --version 2>/dev/null
```

If switchroom is present, **stop** and tell the user it's already installed. Offer to run `switchroom setup` (re-run the wizard), `switchroom doctor` (diagnose), or `switchroom agent list` (see what's running). Do not reinstall.

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

## What not to do

- **Do not** run `switchroom setup` non-interactively or pipe input to it — it's designed for a human.
- **Do not** edit `~/.switchroom/vault.enc` or any file under `~/.switchroom/` directly. Use the CLI.
- **Do not** install switchroom system-wide (no `sudo npm install -g switchroom`). Switchroom is a bun-linked binary from a user-owned checkout.
- **Do not** reinstall over an existing install without asking. If the user wants a clean slate, have them run `switchroom uninstall` first (or confirm they want to blow away `~/.switchroom/`).
