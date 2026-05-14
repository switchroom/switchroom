# Install switchroom

Zero-to-first-message in ~15 minutes on a fresh Linux host. This is the
canonical new-user guide. Follow it top to bottom.

If you already have switchroom running and just want to update it, run
`switchroom update` (pulls images, refreshes scaffolds, recreates
containers).

## System requirements

| Item | Minimum | Recommended |
|---|---|---|
| OS | Ubuntu 24.04 LTS (or recent Debian-derivative) | Ubuntu 24.04+ LTS |
| RAM | 4 GiB | 8 GiB |
| Disk | 20 GiB free on `/` | 40 GiB free |
| Network | Outbound HTTPS to GitHub, Anthropic, Telegram, GHCR | — |

> **Why 4 GiB minimum.** Each agent runs a Claude Code process plus the
> Bun-runtime gateway sidecar inside a container, with the vault broker
> and approval kernel as shared singletons. Two agents + docker daemon
> + npm install will OOM a 2 GiB box. We've seen it. The installer
> warns if you're below 4 GiB but does not block.

## Step 1 — Install dependencies (one script)

```sh
curl -fsSL https://github.com/switchroom/switchroom/raw/main/scripts/install-deps.sh | sudo bash
```

This installs:

- **Docker Engine + Compose v2** — agent containers + broker + kernel run as a docker-compose project.
- **Node.js 20.11+** — for `@anthropic-ai/claude-code`.
- **Bun 1.x** — required runtime for the `switchroom` CLI binary.
- **`@anthropic-ai/claude-code`** — the Claude Code CLI; agents run this unmodified inside containers.
- **`switchroom`** — the operator CLI.

The script is idempotent; re-run it any time. It adds you to the
`docker` group, so **log out and back in** (or `newgrp docker`) before
proceeding to Step 2.

### Manual alternative (non-Ubuntu / non-apt distros)

If you can't run the script, install the same things by hand:

```sh
# 1. Docker (per https://docs.docker.com/engine/install/ for your distro)
# 2. Node 20.11+ (from your package manager or NodeSource)
# 3. The CLIs:
sudo npm install -g bun @anthropic-ai/claude-code switchroom
```

## Step 2 — Create your bots in BotFather

Switchroom uses one Telegram bot per agent. For a minimal install you
need **one** bot — the agent you'll talk to. If you want a separate
"admin" bot that exposes fleet-management slash commands (`/agents`,
`/restart`, `/update apply`, etc.), create **two** bots and flag one
agent with `admin: true` in your `switchroom.yaml`. There's no
separate "admin bot" concept — admin agents are regular agents whose
gateway intercepts admin slash commands before Claude sees them.

See [BotFather walkthrough](botfather-walkthrough.md) for the exact
steps. Total time: ~3 minutes per bot. Keep the HTTP API tokens in a
scratch buffer for Step 3.

## Step 3 — Run setup

```sh
switchroom setup
```

Interactive wizard. You'll be prompted for:

- **Your first agent's bot token** — paste the token from BotFather.
- **Your Telegram user ID** — the wizard will DM you a pairing link;
  open it from your Telegram account and the wizard resolves your ID
  automatically. (If pairing fails, get your ID from `@userinfobot` and
  pass `--user-id <id>`.)
- **Vault passphrase** — used to encrypt secrets on disk. Save it in
  your password manager; you'll need it for unattended boots unless you
  enable auto-unlock at the end of the wizard.
- **Memory backend** — pick `none` for a minimal install, or `hindsight`
  if you want semantic memory across sessions.

The wizard scaffolds your first agent (`assistant` by default) and
writes `~/.switchroom/switchroom.yaml` and
`~/.switchroom/agents/assistant/`. It does **not** start any docker
containers — that's Step 5.

### Non-interactive setup (CI / scripting)

```sh
TELEGRAM_BOT_TOKEN=<agent bot token> \
  SWITCHROOM_VAULT_PASSPHRASE=<passphrase> \
  SWITCHROOM_MEMORY_BACKEND=none \
  switchroom setup --non-interactive --user-id <telegram user id>
```

Recognised env vars:

| Var | Meaning |
|---|---|
| `TELEGRAM_BOT_TOKEN` | First agent bot token |
| `USER_ID` / `--user-id` | Your Telegram user ID |
| `SWITCHROOM_VAULT_PASSPHRASE` | Vault passphrase (prompt-free unlock) |
| `SWITCHROOM_MEMORY_BACKEND` | `hindsight` or `none` (default `hindsight`) |
| `HINDSIGHT_API_LLM_API_KEY` | Required if memory backend is `hindsight` |
| `SWITCHROOM_DANGEROUS_MODE` | `1` to skip approval prompts globally (not recommended) |

## Step 4 — (Optional) Add an admin agent for fleet-management commands

If you want a separate Telegram bot for fleet-management slash
commands (`/agents`, `/restart`, `/update`, `/logs`, etc.), add a
second agent to `~/.switchroom/switchroom.yaml` with `admin: true`:

```yaml
agents:
  admin:
    topic_name: "Admin"
    bot_token: "vault:telegram-admin-bot-token"
    admin: true             # gateway intercepts admin slash commands
    system_prompt_append: |
      You are the fleet admin agent.
```

Add the token to the vault (`switchroom vault set
telegram-admin-bot-token`), then `switchroom apply`. The admin
agent's gateway will handle fleet-management commands locally
without invoking Claude — Claude only sees conversational messages.

Per-agent commands like `/auth list`, `/auth reauth`, `/interrupt`,
`/restart` (self), `/new`, and `/reset` work on **every** agent's
gateway regardless of `admin: true` — they're independent of the
LLM's health, so they keep working even when Claude is rate-limited
or the OAuth token is expired.

You can skip this step for a single-agent install.

## Step 5 — Authenticate with your Claude subscription

```sh
switchroom auth add me --from-oauth
switchroom auth use me
```

`auth add` opens an OAuth browser flow — log in with your Claude Pro or
Max account, paste the code back at the prompt. `auth use` makes that
account the fleet-wide active account; every agent inherits.

One OAuth flow per Anthropic account, ever. New agents you add later
don't need their own login — they inherit the fleet active. See
[`docs/auth.md`](auth.md) for the full model.

> **No API keys.** The whole point: this uses your existing Pro/Max
> subscription via OAuth, exactly like the desktop app. No per-token
> billing.

## Step 6 — Bring the fleet up

```sh
switchroom apply
docker compose -p switchroom -f ~/.switchroom/compose/docker-compose.yml up -d
```

`apply` regenerates `docker-compose.yml` from your yaml. The `up -d`
pulls images from GHCR (first run is slow — ~1-2 GiB across 4 images)
and starts the broker, kernel, and your agent container(s).

Check status:

```sh
switchroom agent list
docker compose -p switchroom -f ~/.switchroom/compose/docker-compose.yml ps
```

## Step 7 — Verify in Telegram

1. Open Telegram, search for your agent bot's username, hit `/start`.
2. Send "hello".
3. You should see a pinned **progress card** appear within a couple of
   seconds, then a reply from the agent.

If anything's off, run `switchroom doctor` — it sweeps deps, vault,
agents, and MCP wireup, and prints actionable fixes.

## Troubleshooting

- **`switchroom: command not found`** — npm install probably finished
  but `/usr/local/bin` isn't on your PATH. Confirm with
  `which switchroom`; if empty, `echo $PATH` and check.
- **`env: 'bun': No such file or directory`** when running switchroom —
  bun didn't install. Re-run `sudo npm install -g bun`.
- **`Cannot find module … examples/…`** on `switchroom setup` — you're
  on an older switchroom whose npm package didn't ship the `examples/`
  directory. Fixed on `main` after PR #1231; re-install once the next
  release lands: `sudo npm install -g switchroom@latest`.
- **`permission denied … /usr/local/lib/node_modules/switchroom/profiles/…`**
  during setup — switchroom is trying to write to its own install dir.
  Tracked work; see the install-validation follow-up that moves profile
  rendering to a user-writable cache dir.
- **Telegram bot doesn't reply** — `switchroom agent logs assistant -f`
  and `switchroom doctor`. The most common cause is OAuth not yet
  completed (`switchroom auth list` — confirm an account is present
  and `auth.active` is set).
- **`unauthorized` on `docker compose pull`** — see
  [`operators/install.md#ghcr-auth`](operators/install.md#ghcr-auth).

## Where to next

- [Configuration reference](configuration.md) — every yaml field, the
  cascade, profiles.
- [Adding more agents](../README.md#cli-reference) — `switchroom agent add`
  walks you through it.
- [Telegram features](telegram-features.md) — voice-in, long replies,
  scheduled tasks.
