# Webhook ingest (#577)

External systems can push events into a specific agent's log. Verified events land in `~/.switchroom/agents/<agent>/telegram/webhook-events.jsonl` — the agent reads them on demand via Bash. (Auto-posting to Telegram + autonomous agent reactions are deferred to a follow-up.)

## Setup — GitHub example

1. **Allow the source per agent.** In `~/.switchroom/switchroom.yaml`:
   ```yaml
   agents:
     finn:
       webhook_sources: [ github ]
   ```
   Off by default. No allowlist = all webhook requests for that agent return 403.

2. **Add the secret.** Edit `~/.switchroom/webhook-secrets.json` (mode 0600):
   ```json
   {
     "finn": { "github": "<your-shared-secret>" }
   }
   ```
   Use a long random string (`openssl rand -hex 32`). The same secret goes into GitHub's webhook config.

3. **Configure GitHub.** Repo → Settings → Webhooks → Add webhook:
   - Payload URL: `https://<your-host>/webhook/finn/github`
   - Content type: `application/json`
   - Secret: paste the same string from step 2.
   - Events: pick what you want (push, pull_request, issues).

4. **Verify.** Trigger an event. Tail the log:
   ```sh
   tail -f ~/.switchroom/agents/finn/telegram/webhook-events.jsonl
   ```

## Setup — generic Bearer token

Use this for in-house tools that can't HMAC-sign:

1. `webhook_sources: [ generic ]` in switchroom.yaml.
2. Put the token in `webhook-secrets.json`: `{ "finn": { "generic": "<token>" } }`.
3. Sender adds `Authorization: Bearer <token>` to its POST.

The body must be JSON. Common fields (`title`, `message`, `text`) are auto-rendered into the stored Telegram-ready text; otherwise a JSON snippet is used.

## Setup — Linear (#2272)

> For making an agent a **first-class Linear app actor** (OAuth `actor=app`
> setup, the `linear-agent` CLI, self-refreshing tokens, the
> `linear_agent_activity` / `linear_create_issue` MCP tools), see
> **[`linear.md`](linear.md)**. This section covers only the plain
> webhook-ingest + dispatch path.

Linear signs its webhooks with a **bare hex HMAC-SHA256 of the raw body** in the `Linear-Signature` header (no `sha256=` prefix, no Bearer auth).

1. `webhook_sources: [ linear ]` in switchroom.yaml.
2. Put the signing secret in `webhook-secrets.json`: `{ "finn": { "linear": "<linear-webhook-secret>" } }`.
3. In Linear → Settings → API → Webhooks, point the URL at `https://<your-host>/webhook/finn/linear` and copy the generated signing secret into step 2.
4. Pick the resources to deliver (Issues, Comments).

`event_type` is the lower-cased Linear `type` (`issue`, `comment`). Issue and comment events render the identifier (e.g. `ENG-42`), action, assignee, title/body and URL.

## Auto-dispatch (waking the agent)

When an event matches a `webhook_dispatch` rule, switchroom injects the rendered prompt as a synthesized turn into the agent's live `claude` session (never a headless `claude -p`). Dispatch works for **github, generic, and linear** sources (#2272 — previously github-only). Rules are keyed by source:

```yaml
agents:
  clerk:
    channels:
      telegram:
        webhook_sources: [ linear ]
        webhook_dispatch:
          linear:
            - description: "Act on issues assigned to me"
              match:
                event: issue          # linear `type`, lower-cased
                actions: [create, update]
                assignee_any: [clerk]  # match on assignee display name
              prompt: |
                Linear {{number}} assigned to you: {{title}}
                {{html_url}}
              cooldown: 2m
            - description: "Respond when @mentioned in a comment"
              match:
                event: comment
                mentions_any: ["@clerk"]  # case-insensitive substring of the comment body
              prompt: "You were mentioned on {{number}} — take a look:\n{{html_url}}"
```

Matcher knobs by source:

| field | github | linear | generic |
|---|---|---|---|
| `event` (required) | event header | `type` (lower) | source name |
| `actions` | yes | yes | yes |
| `labels_any` / `labels_all` | yes | yes | yes |
| `exclude_authors` | yes | yes | yes |
| `assignee_any` | — | yes | yes |
| `mentions_any` | — | yes | yes |

All sources support the `cooldown` and `quiet_hours` knobs; the ingest path's `webhook_rate_limit` and github delivery-id dedup apply uniformly. Template fields available in `prompt`: `{{repo}}`, `{{number}}`, `{{title}}`, `{{html_url}}`, `{{author}}`, `{{assignee}}`, `{{labels}}`, `{{action}}`, `{{event}}`.

## What the agent sees

Each verified event becomes one JSONL line at `<agent>/telegram/webhook-events.jsonl`:

```json
{
  "ts": 1777699200000,
  "source": "github",
  "event_type": "pull_request",
  "rendered_text": "🐙 <b>org/repo</b> PR #123 opened by @user\n…",
  "payload": { "...full GitHub payload..." }
}
```

Tell the agent (or have it know via CLAUDE.md) to `cat` or `tail` this file when checking for new events. The `rendered_text` field is mobile-friendly HTML safe to repost; `payload` carries the full structured record for follow-up actions.

## Security

- HMAC-SHA256 verification for `github` (`X-Hub-Signature-256`, `sha256=`-prefixed hex, constant-time compare).
- HMAC-SHA256 verification for `linear` (`Linear-Signature`, bare hex of the raw body, constant-time compare).
- Bearer token verification for `generic` (constant-time compare, length-pre-checked).
- Dispatched events are treated as **data, not instructions** — every rendered field is HTML-escaped before it reaches the agent's prompt.
- Source not in agent's allowlist → 403, no further processing.
- Source unknown → 400.
- Verification fails → 401 with a generic body, but the operator log line carries the specific reason for debugging.

## Deployment — the receiver container

The webhook receiver is the GitHub-webhook half of the `switchroom web`
server (the other half is the dashboard). It can run two ways:

- **Legacy (systemd):** `switchroom-web.service` runs the server straight
  off the source checkout. Fragile — another agent's worktree activity
  can delete the shared `node_modules` out from under the long-lived
  process, crash-looping the next restart on ENOENT.

- **Container (preferred):** `switchroom webd install` packages it as an
  image-pinned container in its own compose project (`switchroom-web`),
  separate from the agent fleet so the fleet's `compose up -d
  --remove-orphans` cycle can't recreate it mid-request. Three load-
  bearing properties of the compose shape (`src/cli/webd.ts`):
  - `network_mode: host` — the server must own host loopback
    `127.0.0.1:8080`, where the cloudflared tunnel (webhooks) and
    `tailscale serve` (dashboard) both reach it. The dashboard CSRF gate
    trusts the `Tailscale-User-Login` header only on loopback (PR #1380),
    which only host networking preserves.
  - runs as the **operator uid** — the receiver's forward to each agent's
    `webhook.sock` is peercred-gated to `{agent uid,
    SWITCHROOM_WEBHOOK_RECEIVER_UID = operator uid}`. Any other uid → 503.
  - **no docker socket, no added caps** — minimal surface for the one
    internet-facing component.

  Manage it with `switchroom webd <install|status|uninstall>`. Cutover
  from systemd: bring the container up, verify, then `systemctl --user
  stop && disable switchroom-web.service`. To keep the container refreshed
  by `switchroom update`, set `web_service.managed: true` in
  `switchroom.yaml` (default `false`, so existing systemd installs are
  untouched).

## Out of scope

- Auto-posting to Telegram. Today the user has to ask the agent ("anything new from GitHub?"). Auto-post requires bot-token resolution + topic mapping; future PR.
- Triggering a fresh agent turn from a webhook event. Requires gateway-IPC integration with a new "synthetic-user-message" envelope. Future PR.
- Vault-backed secret storage. `webhook-secrets.json` works today; vault integration is a future hardening.
