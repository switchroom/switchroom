---
name: clerk-install
description: Install and set up clerk on a fresh machine. Use when the user says 'install clerk', 'set up clerk', 'bootstrap clerk', 'get clerk running', 'I'm new to clerk', or asks how to get started with clerk from scratch.
---

# Install Clerk

When the user asks to install, set up, or bootstrap clerk, walk them through this flow. Clerk turns a Linux server + their Claude Pro/Max subscription into always-on Claude Code agents reachable from Telegram.

## Step 0 — Detect existing install

Before doing anything, check whether clerk is already installed:

```bash
command -v clerk && clerk --version 2>/dev/null
```

If clerk is present, **stop** and tell the user it's already installed. Offer to run `clerk setup` (re-run the wizard), `clerk doctor` (diagnose), or `clerk agent list` (see what's running). Do not reinstall.

## Step 1 — Verify prerequisites

Clerk requires Ubuntu 24.04 LTS (or compatible Debian-based Linux) with ≥4GB RAM. Check:

```bash
. /etc/os-release && echo "$PRETTY_NAME"
free -h | awk '/^Mem:/ {print $2}'
uname -m
```

If the user is on macOS or Windows, stop and explain: clerk runs on Linux servers (typically a $6/mo VPS). Point them at the README's "Quick Start" — they'll want to provision a Linux box first.

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

## Step 3 — Clone and build clerk

```bash
git clone https://github.com/mekenthompson/clerk.git ~/code/clerk
cd ~/code/clerk && bun install && bun link
```

Verify:

```bash
clerk --version
```

## Step 4 — Run setup wizard

`clerk setup` is an interactive wizard that configures the Telegram bot token, forum chat, and first agent. **It requires a terminal the user controls** — if you're running inside an agent session, you cannot drive it yourself. Tell the user:

> Run `clerk setup` in your own terminal. It'll ask for your Telegram bot token and walk you through creating your first agent. Come back when it finishes and I can verify with `clerk doctor`.

## Step 5 — Verify

After `clerk setup` completes:

```bash
clerk doctor
clerk agent list
```

If `clerk doctor` reports healthy and at least one agent is listed, installation is complete. Offer to invoke the `clerk-status` or `clerk-health` skill for a deeper look.

## What not to do

- **Do not** run `clerk setup` non-interactively or pipe input to it — it's designed for a human.
- **Do not** edit `~/.clerk/vault.enc` or any file under `~/.clerk/` directly. Use the CLI.
- **Do not** install clerk system-wide (no `sudo npm install -g clerk`). Clerk is a bun-linked binary from a user-owned checkout.
- **Do not** reinstall over an existing install without asking. If the user wants a clean slate, have them run `clerk uninstall` first (or confirm they want to blow away `~/.clerk/`).
