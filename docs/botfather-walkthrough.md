# BotFather walkthrough — create your switchroom bots

Step-by-step bot creation in Telegram. ~3 minutes per bot. No
screenshots; everything below is exactly what you type or tap.

## Prerequisites

- A Telegram account. Open the Telegram app (mobile, desktop, or web).
- Have your switchroom install ready to receive the tokens (you'll
  paste them into `switchroom setup` and into your `switchroom.yaml`
  for additional agents).

## What you'll create

Switchroom uses **one Telegram bot per agent**. For a minimal install
you create one bot; for an admin-bot setup you create two. There's no
separate "admin bot" concept — an admin agent is just a regular agent
whose gateway intercepts fleet-management slash commands (the
[three-tier model](architecture.md#) — see docs/architecture.md).

| Bot | Purpose | Where the token goes |
|---|---|---|
| **First agent bot** | The bot you actually chat with. Required. | `switchroom setup` (interactive) or vault |
| **Admin agent bot** (optional) | A second bot for an agent with `admin: true` — exposes `/agents`, `/restart`, `/update`, `/logs`, etc. | vault, referenced from the agent's `bot_token` |

You can create more bots later (one per additional agent). The
process is identical.

## Step 1 — Open BotFather

In Telegram, search for `@BotFather` (the official Telegram bot for
making bots — verified blue checkmark). Hit **Start** if you've never
talked to it.

## Step 2 — Create your first agent bot

Send these messages to BotFather, in order:

```
/newbot
```

BotFather replies asking for a name. This is the display name (can
contain spaces, change it later if you want):

```
My Assistant
```

Then it asks for a username. Must end in `bot` (case-insensitive),
must be unique on Telegram, 5-32 characters:

```
my_assistant_agent_bot
```

BotFather replies with a token. **Save it**. Looks like:

```
1234567890:ABCdefGhIjKlMnOpQrStUvWxYz-abcdefghi
```

## Step 3 — (Optional) Create an admin agent bot

Repeat Step 2 with new names if you want a separate bot for
fleet-management slash commands. Example:

```
/newbot
My Fleet Admin
my_fleet_admin_bot
```

Save the token. You'll wire this to an agent with `admin: true` in
your `switchroom.yaml` (see [install.md §4](install.md)).

## Step 4 — Disable privacy mode (optional)

If you plan to use a bot in a group chat (not just DM), tell it to
see all messages, not just commands:

```
/setprivacy
```

Pick the bot, then `Disable`. For DM-only use you can skip this —
privacy mode doesn't affect DMs.

## Step 5 — Use the tokens

In your switchroom host's shell:

```sh
# First agent — interactive setup prompts for the token directly:
switchroom setup

# Admin agent (if you created a second bot) — add the token to the
# vault and reference it from the agent block in switchroom.yaml:
switchroom vault set telegram-admin-bot-token
# (paste the admin bot token at the prompt)
```

Then edit `~/.switchroom/switchroom.yaml`:

```yaml
agents:
  admin:
    topic_name: "Admin"
    bot_token: "vault:telegram-admin-bot-token"
    admin: true                   # gateway intercepts admin commands
    system_prompt_append: |
      You are the fleet admin agent.
```

Run `switchroom apply` after editing.

If you don't know your Telegram user ID, message `@userinfobot` in
Telegram — it replies with your numeric ID immediately. You'll need
it during `switchroom setup` for the `allowFrom` ACL.

## Step 6 — DM your bot once

For each bot, open it in Telegram (search by username, or use the
direct link BotFather sent: `t.me/<bot_username>`) and tap **Start**.

The agent bot won't reply until setup, `switchroom auth login`, and
`docker compose ... up -d` are done.

## Optional: profile picture + description

For each bot, you can set:

```
/setdescription   → text shown above the chat input
/setabouttext     → text on the bot's profile page
/setuserpic       → upload a profile photo
```

Switchroom doesn't care; these are pure cosmetics.

## Troubleshooting

- **"Sorry, this username is already taken."** — Telegram usernames
  are globally unique. Try a more specific variant
  (`my_assistant_2026_bot`).
- **"This username is invalid."** — Must end in `bot`, be 5-32 chars,
  alphanumeric + underscore. No hyphens, no leading numbers.
- **Lost the token** — In BotFather: `/mybots` → pick your bot → API
  Token → Revoke and regenerate.
- **Want a "better" username later** — BotFather: `/setname` /
  `/setusername`. Tokens stay valid.

## Security

- Each token is **bearer authentication** for that bot. Treat them
  like passwords. Don't paste them into chats, gists, screenshots.
- Switchroom stores tokens in its encrypted vault
  (`~/.switchroom/vault/`) after setup. The tokens never go to disk
  in plaintext once setup completes.
- If a token leaks, revoke and rotate via BotFather: `/mybots` →
  pick bot → API Token → Revoke.
