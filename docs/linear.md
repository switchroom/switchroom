# Linear integration

Run a switchroom agent as a **first-class Linear app actor** — it gets its
own avatar in the workspace, is `@`-mentionable, can be assigned/delegated
issues, wakes the instant a Linear agent-session event fires, posts
structured activity back to the issue timeline, and files issues itself.
Its OAuth app token **refreshes itself** so the agent never goes dead.

There are three layers, each opt-in:

1. **First-class agent** (`linear_agent`) — the agent is a Linear app actor;
   mentions/delegations wake it; it replies with `linear_agent_activity` and
   can `linear_create_issue`. This is the headline.
2. **Durable token refresh** — the `actor=app` token is short-lived (~24h),
   so switchroom stores the refresh token and rotates the access token
   automatically, in-container, with zero operator touch.
3. **Webhook dispatch** (optional) — plain Linear webhooks (issue/comment
   events) that wake the agent via a `webhook_dispatch` rule. See
   [`webhook-ingest.md`](webhook-ingest.md); the rest of this doc is the
   first-class-agent + token story.

> **One Linear OAuth app per agent.** An `actor=app` authorization yields one
> app actor identity, so each agent that should be a *distinct* actor (e.g.
> `clerk` vs `carrie`) needs its **own** Linear OAuth application with its own
> `client_id`/`client_secret`.

---

## TL;DR — provision one agent

```bash
# 1. Register a Linear OAuth app (browser, once per agent) — see below.
# 2. Authorize it (actor=app) in a browser and capture the ?code= .
# 3. Exchange the code for an access token + refresh token (POST to
#    https://api.linear.app/oauth/token, grant_type=authorization_code).
# 4. Wire it up — stores the token + the refresh bundle + grants the ACL:
switchroom linear-agent setup \
  --agent <name> \
  --token <access-token> \
  --refresh-token <refresh-token> \
  --token-expires-in <expires_in-seconds> \
  --client-id <app-client-id> \
  --client-secret <app-client-secret>
# 5. switchroom agent restart <name>
```

From then on the token self-heals: on a Linear `401` the agent refreshes
in-container and retries. You only ever touch it again if Linear *revokes*
the refresh token (rare) — surfaced loudly in the log.

---

## Prerequisite — register a Linear OAuth app

In Linear → **Settings → API → OAuth Applications** → *Create new*:

- **Actor:** the app must be able to act as an app (`actor=app`).
- **Scopes:** `read`, `write`, `app:assignable`, `app:mentionable`.
- **Redirect URI:** add `http://localhost:3000/callback` (convenient for the
  copy-the-code flow below) and/or your real callback.
- Note the **client_id** and **client_secret** — switchroom needs both to
  refresh (see [Security](#security--vault-layout)).
- See Linear's own guide: <https://linear.app/developers/agents>.

## Setup — the OAuth dance

The `actor=app` flow needs a browser redirect, so it can't run headless. The
pattern:

**1. Build the authorize URL** (substitute your `client_id`, a registered
`redirect_uri`, and a random `state` for CSRF):

```
https://linear.app/oauth/authorize
  ?client_id=<id>
  &redirect_uri=http://localhost:3000/callback
  &response_type=code
  &scope=read,write,app:assignable,app:mentionable
  &state=<random>
  &actor=app
```

**2. Open it in a browser and approve.** Linear redirects to
`http://localhost:3000/callback?code=…&state=…`. With nothing listening on
:3000 the page fails to load — that's fine; the **`code`** is in the address
bar. Confirm the returned `state` matches what you sent.

**3. Exchange the code** for a token + refresh token:

```bash
curl -s -X POST https://api.linear.app/oauth/token \
  --data-urlencode grant_type=authorization_code \
  --data-urlencode client_id=<id> \
  --data-urlencode client_secret=<secret> \
  --data-urlencode redirect_uri=http://localhost:3000/callback \
  --data-urlencode code=<code> \
  --data-urlencode actor=app
# → { access_token, refresh_token, expires_in, scope, token_type }
```

**4. Wire it up** with `linear-agent setup` (above). Storing the access token
*never* passes it through `switchroom.yaml` — it lands in the vault and the
config holds only a `vault:linear/<agent>/token` reference.

**5. Register the webhook** on the Linear app so agent-session events
(mentions, delegations) reach the agent. The setup output prints the URL:
`https://<your-switchroom-web-host>/webhook/<agent>/linear`. Store Linear's
signing secret in the vault under `webhook/<agent>/linear` (see
[`webhook-ingest.md`](webhook-ingest.md) for the signature contract).

**6. `switchroom agent restart <name>`** to pick up the config + grant.

---

## Durable token refresh

Linear's `actor=app` access tokens are short-lived (`expires_in ≈ 24h`) and
come with a `refresh_token`. switchroom keeps the agent alive **without an
operator** by storing the refresh material and rotating the token itself.

### What `setup` stores

| Vault key | Contents | Used by |
|---|---|---|
| `linear/<agent>/token` | the access token (string) | the runtime, as the `Authorization` header |
| `linear/<agent>/oauth` | JSON bundle `{client_id, client_secret, refresh_token, expires_at}` | the refresh path |

`setup` also adds **both** keys to `agents.<agent>.secrets[]` so the agent
holds the ACL to *read and rotate* them via the vault broker — see below.

### Automatic, in-container (the normal case)

When a Linear API call returns **`401`** (expired/invalid token), the agent
runtime:

1. reads the bundle, exchanges the refresh token at Linear's token endpoint,
2. **persists** the new access token + rotated refresh token + new expiry —
   in-container, via the broker `put` op (no operator passphrase needed), then
3. **retries the call once** with the fresh token.

Rotation happens entirely inside the agent container. The vault broker is
already unlocked and authorizes the agent to rotate a key it can already read
(the "read implies rotate" contract). The retry is bounded to **one** attempt
— no loops.

### Manual / ops refresh

```bash
switchroom linear-agent refresh --agent <name>
```

Host-side: reads the bundle, refreshes, writes the new token + rotated bundle
back to the vault. Useful to pre-seed or recover. A running agent picks up the
new token on its next broker re-mirror or restart (the in-container path above
is what keeps it live without this).

### When you *do* need to act: a revoked refresh token

The one case automatic refresh can't fix is a **revoked** refresh token (Linear
returns `400 invalid_grant`). That's surfaced clearly:

- the runtime logs `telegram gateway: linear token REVOKED agent=<name> …`
  (`grep 'linear token REVOKED'` in the gateway log), and the original `401`
  surfaces to the agent;
- the `refresh` verb exits with `Refresh token is dead (revoked/expired) —
  re-authorize in a browser …`.

Recovery: re-run the **Setup — the OAuth dance** above and `setup` with the new
`--refresh-token`. (Everything else — transient network/HTTP errors — is
treated as retryable and not surfaced as a re-auth ask.)

---

## CLI reference — `switchroom linear-agent`

### `setup`

Provision an agent as a Linear app actor and store its token + refresh bundle.

| Option | Meaning |
|---|---|
| `--agent <name>` | agent slug (must exist in switchroom.yaml) |
| `--token <token>` | the `actor=app` access token from the OAuth exchange |
| `--refresh-token <token>` | the `refresh_token` from the exchange — enables auto-refresh |
| `--token-expires-in <seconds>` | `expires_in` from the token response (records expiry; default 86400) |
| `--client-id <id>` | the app client id — stored, needed to refresh |
| `--client-secret <secret>` | the app client secret — stored in the vault, needed to refresh |
| `--workspace-id <id>` | optional Linear organization id to record in config |
| `--webhook-base <url>` | base URL used to print the webhook registration URL |
| `--dry-run` | print the YAML diff + instructions, write nothing |

Auto-refresh is enabled only when `--refresh-token` **and** `--client-id`
**and** `--client-secret` are all supplied; otherwise only the access token is
stored (and it will expire and need a manual re-auth — `setup` warns about this).

### `refresh`

```bash
switchroom linear-agent refresh --agent <name>
```

Host-side token refresh from the stored bundle (see above).

### `set-team`

```bash
switchroom linear-agent set-team --agent <name> --team <team-id>
switchroom linear-agent set-team --agent <name> --clear
```

Sets the default Linear team new captured issues file into — only needed when
the workspace has more than one team (a single-team workspace auto-resolves).

---

## Config reference

`linear-agent setup` writes the `linear_agent` block + `webhook_via_gateway`
and the `secrets[]` grants (you don't hand-edit those). The
`webhook_sources: [linear]` line is added *separately* when you register the
webhook secret (setup step 5, or `switchroom telegram enable webhook --agent
<name> --source linear --secret <signing-secret>`).

```yaml
agents:
  carrie:
    secrets:
      - linear/carrie/token       # access token (read+rotate ACL)   ← setup
      - linear/carrie/oauth       # refresh bundle (read+rotate ACL)  ← setup
    channels:
      telegram:
        linear_agent:             # ← setup
          enabled: true
          token: "vault:linear/carrie/token"
          workspace_id: "<org-id>"   # optional
          default_team_id: "<team>"  # set via `set-team`, optional
        webhook_via_gateway: true     # ← setup (forwards verified webhooks to the in-container gateway)
        webhook_sources:              # ← added when you register the webhook secret
          - linear
```

`webhook_via_gateway: true` is required under the Docker runtime so the web
receiver forwards the verified Linear webhook to the agent's in-container
gateway (which wakes the session); without it the event is handled host-side
and the agent never sees it.

---

## MCP tools

An agent woken by a Linear session gets two Linear tools (token resolved from
the vault per call; both auto-refresh on a 401):

- **`linear_agent_activity(agent_session_id, type, body)`** — post a
  `thought` / `message` / `complete` / `error` activity to the issue's
  timeline (Linear renders these as status chips). This is how the agent
  "talks" inside a Linear agent session.
- **`linear_create_issue(title, body?, team_id?, priority?, dedup_key?)`** —
  file an issue **as the agent's app actor**. Auto-resolves the team in a
  single-team workspace; `dedup_key` makes capture-on-reaction idempotent.

On a vault denial (no grant for the token) both return actionable text telling
the agent to `vault_request_access` for `linear/<agent>/token` rather than
failing opaquely.

---

## Security & vault layout

- **Tokens never touch `switchroom.yaml`** — the config holds only
  `vault:linear/<agent>/token`; the value lives in the encrypted vault.
- **The client secret is stored in the vault** (`linear/<agent>/oauth`). This
  is required for unattended refresh; the vault is the secret store, and
  storing it there is what lets the token self-heal without the operator.
- **In-container rotation, no passphrase.** Refresh writes the rotated token
  back through the vault broker's `put` op. The broker is already auto-unlocked
  and authorizes an agent to rotate a key it is already allowed to read — so
  the operator's vault passphrase is never needed at runtime. This respects the
  access-model boundary: the operator decides *which* keys exist (the ACL grant
  in `secrets[]`); the agent only *rotates* a value it already holds.
- **Webhook signing:** Linear signs with a bare-hex HMAC-SHA256 of the raw
  body in `Linear-Signature`; the secret lives in the vault under
  `webhook/<agent>/linear`. See [`webhook-ingest.md`](webhook-ingest.md).

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Agent's Linear calls fail `401` and *don't* recover | No refresh bundle stored (`linear/<agent>/oauth` missing) — re-run `setup` with `--refresh-token`/`--client-id`/`--client-secret`. |
| `grep 'linear token REVOKED'` in the gateway log | Refresh token is dead — re-do the browser OAuth dance and `setup` with the new `--refresh-token`. |
| `linear-agent refresh` says "No refresh bundle at 'linear/<agent>/oauth'" | The agent was provisioned before refresh, or without the full bundle — re-run `setup` with all four refresh flags. |
| Agent doesn't wake on a Linear mention | Check `webhook_via_gateway: true`, the webhook is registered at `…/webhook/<agent>/linear`, and the signing secret is in the vault. |
| Two agents show as the **same** Linear actor | They share one OAuth app — give each its own Linear OAuth application (own `client_id`). |

Verify a token by hand (host-side, authoritative — bypasses the broker):

```bash
SWITCHROOM_VAULT_PASSPHRASE=… \
  curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $(switchroom vault get linear/<agent>/token --no-broker)" \
  -X POST https://api.linear.app/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ viewer { id name } }"}'
# 200 = live, 401 = expired/revoked
```
