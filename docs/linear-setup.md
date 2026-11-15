# Set up Linear for a Switchroom agent

This guide takes one agent from no Linear connection to tracked work: create the agent's
Linear OAuth app, install it, put the credential in the agent's private state, turn the plugin
on and check it works. It has two parts:

1. **[Chat-started work](#part-1-chat-started-work)**: you ask the agent in Telegram, Slack,
   Desktop or the TUI to do something longer, and it creates or picks up a Linear issue, does the
   work as a native Kanban task, and reports checkpoints and the result on the issue. **This needs
   only the agent's Linear OAuth app.** No webhook receiver, public URL or inbound port.
2. **[Assign from Linear](#part-2-assign-from-linear)**: a person assigns or @mentions the agent
   in Linear and it picks the work up. **This also needs the webhook receiver** from the starter
   overlay's sidecars, and a public HTTPS URL for it (a tunnel or reverse proxy).

[Part 3](#part-3-handoff-between-two-agents) covers taking work over from another agent, which
also runs without the receiver.

All names, IDs and keys below are synthetic (`ABC-123`, `Example-A`, `example-...`). Replace them
with your own in your overlay, never in this repository. How the plugin behaves once it runs is in
[`plugins/linear/README.md`](../plugins/linear/README.md); the model behind it is in
[`linear-native-execution.md`](linear-native-execution.md).

## What you need

| Piece | Chat-started work | Assign from Linear |
| --- | --- | --- |
| One Linear OAuth app per agent, installed with `actor=app` | yes | yes |
| Scopes `read,write,app:assignable` | yes | yes |
| Scope `app:mentionable` | no | yes, for @mentions |
| Webhooks on the OAuth app | **off** | on: Agent session events, Issues |
| Webhook receiver writing the agent's Linear inbox | no | yes (`linear-receiver` sidecar) |
| A public HTTPS URL that reaches the receiver | no | yes |
| The agent's gateway running (the plugin's reporting service lives there) | yes | yes |
| A Fleet image from this repository's pinned Agent release (guarded native admission) | yes | yes |
| `platforms.linear` gateway platform | no | yes |

Each agent gets its **own** OAuth app. Linear shows the app's name and icon as the agent, the
app's user ID is the agent's identity, and the hourly API budget (5,000 requests per app user) is
per app. Two agents sharing one app would look like one agent in Linear and could not hand work to
each other.

## Part 1: chat-started work

### 1. Create the OAuth app

In Linear, as a workspace admin: **Settings → API → OAuth applications → New**.

- **Name and icon**: what people see for this agent in Linear, for example `Example-A`. Keep it
  short and unique; it appears in the assignee and mention menus.
- **Callback URL**: any URL you control, used once in step 3 to receive the authorization code.
  The plugin has no callback endpoint and needs none at runtime. `http://localhost:8765/callback`
  works: the browser shows a failed page load, and the code is in the address bar.
- **Webhooks**: leave **off** for chat-started work. Linear documents that once Agent session
  events are enabled it shows Agent Session UI and expects a reply within 10 seconds of each new
  session, or marks the session unresponsive. Without a receiver nothing would answer.
- **Client credentials**: leave off. The plugin's refreshing credential mode uses the
  authorization-code grant, and Linear documents that a client-credentials request replaces an
  existing authorization-code installation.

Keep the client ID and client secret for step 3. Store the secret in your secret manager straight
away; do not paste it into a chat, a ticket or a git file.

### 2. Choose the scopes

| Scope | Why the plugin needs it |
| --- | --- |
| `read` | Issue, comment, history, team and project reads, and the identity check on every request. |
| `write` | Issue creation, comments, status changes, descriptions, projects and issue links. |
| `app:assignable` | Lets the plugin set this app as the issue's **delegate**, which is how Linear shows which agent is working. Without it the work still runs and reports, but the delegate write is refused and stays held. |
| `app:mentionable` | Only for Part 2: people can @mention the agent. |

Do not request `admin`; Linear does not allow it together with `actor=app`.

### 3. Install the app and get its refresh token

Open this URL in a browser as a workspace admin (one line, values synthetic):

```text
https://linear.app/oauth/authorize?client_id=example-client-id&redirect_uri=http%3A%2F%2Flocalhost%3A8765%2Fcallback&response_type=code&scope=read,write,app:assignable&actor=app&state=example-random-state
```

`actor=app` makes the token act as the app, so comments and status changes come from the agent,
not from you. Approve, then copy `code` from the callback URL and check `state` matches.

Exchange the code once, in a private terminal on a machine you trust, with the client secret read
from your secret manager rather than typed into shell history:

```bash
curl -s https://api.linear.app/oauth/token \
  -d grant_type=authorization_code -d code="$CODE" \
  -d redirect_uri=http://localhost:8765/callback \
  -d client_id="$CLIENT_ID" -d client_secret="$CLIENT_SECRET"
```

The reply holds an `access_token` (24 hours) and a `refresh_token` (30 days, renewed on every
refresh). Only the refresh token is kept. If the exchange fails, repeat the authorize step for a
fresh code.

*Not yet published*: a guided install command that does this exchange and writes the credential
for you. Until it ships, this step is manual.

### 4. Find the app's IDs

With the access token from step 3:

```bash
curl -s https://api.linear.app/graphql -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"query":"{ viewer { id name } organization { id urlKey } }"}'
```

`viewer.id` is this app's user in your workspace and becomes `identity.viewer_id`;
`organization.id` becomes `identity.organization_id`. The plugin checks every credential against
both before it reads or writes (`BoundLinearAPI._verified_credential`), so a token for another app
or workspace is refused rather than used.

### 5. Put the credential in the agent's private state

Credentials live on the agent's state volume (`/opt/data` inside its container), never in the
overlay git tree, the image or managed YAML. Pick one mode.

**`connect` (recommended): refreshes itself.** Create one 1Password item per agent with three
fields: `client_id`, `client_secret` and `refresh_token`. Give the agent a 1Password Connect token
that can read and write only that item, and write it to `/opt/data/.op.env`:

```bash
OP_CONNECT_HOST=https://connect.example.internal
OP_CONNECT_TOKEN=<from your secret manager>
```

The file must be owned by the agent's user (UID 1000) with mode `600`; the plugin refuses
anything else. The plugin refreshes the access token before it expires, writes each rotated
refresh token back to the item and keeps only the short-lived access token in
`/opt/data/secrets/linear-oauth.json`. Deleting that cache is safe: the next call rebuilds it
from the item. Because the refresh token rotates, give each item to exactly one agent.

**`token_file`: a fixed token.** A file, default `/opt/data/secrets/linear-token`, UID 1000, mode
`600`, holding one access token. The plugin reads it on each call and never refreshes it. An
authorization-code access token lasts 24 hours, so this mode needs something outside the plugin
to keep the file current. Use it for short tests, or when you already run a token refresher.

### 6. Mount the plugin and turn it on

Mount this repository's `plugins/linear/` read-only at `/opt/data/plugins/linear` in the agent's
container. Then add the plugin block to that agent's profile config (`/opt/data/config.yaml`):

```yaml
plugins:
  enabled: [linear]
  entries:
    linear:
      settings:
        enabled: true
        identity:
          viewer_id: example-app-user-id          # viewer.id from step 4
          organization_id: example-workspace-id   # organization.id from step 4
        credentials:
          mode: connect
          vault_id: example-vault-id
          item_id: example-item-id
          connect_env_file: /opt/data/.op.env
          cache_file: /opt/data/secrets/linear-oauth.json
        states:
          todo: Todo
          in_progress: In Progress
          in_review: In Review
          done: Done
          blocked: Blocked
```

For `token_file` use `credentials: {mode: token_file, path: /opt/data/secrets/linear-token}`.
Optional `identity.teams` and `identity.projects` restrict which issues the agent may read and
write. `states` names your teams' workflow states; a team without one of them uses its first
state of the same type. The rest of the settings are in the
[plugin README](../plugins/linear/README.md#configuration).

The `linear` tool must reach the chat platforms you use: check that each platform's toolsets
include `linear` (Desktop and the TUI resolve under `cli`). If a platform cannot reach it, the
plugin logs `chat.guard outcome=skipped reason=linear_unreachable` for that turn.

If your overlay renders profile config from `fleet-config/`, add these keys to your own
`fleet-config/schema.yaml` allowlist first; the sample schema does not list them. *Not yet
published*: the starter overlay that turns Linear on for every agent
([default-on decision](../reference/rfcs/default-on-distribution.md)). Until it ships, Linear stays
off unless you add this block.

### 7. Restart the gateway and check it works

Restart that agent's gateway. Then, inside the agent's container:

1. **Service started.** `gateway.log` has one `linear.evt action=service.start outcome=started`
   line. A repeating `action=service.start outcome=retry reason=identity_unavailable` means the
   credential or IDs are wrong; `reason=auth_unavailable` means Linear refused the refresh token
   and the app must be installed again (step 3).
2. **Nothing held.** `hermes linear status` lists no held work on a fresh agent.
3. **A read from chat.** Ask the agent "what's the status of ABC-123?" for any issue it may see.
   It answers from Linear and starts nothing.
4. **A small tracked job.** Ask "create a Linear issue in project Example to write a one-line
   hello file, and do it now". The agent calls `create_issue` with `start_work`. In Linear the
   new issue shows this app as delegate (human assignee unchanged), moves to In Progress when the
   worker claims it, gets a "Started" comment and checkpoint comments, and closes with one full
   result comment. The chat gets the checkpoints and the result.

### What you see without the receiver

- Progress and the result arrive as regular issue comments. The plugin only posts to an Agent
  Session that a webhook told it about, so without the receiver it never uses one. Linear
  documents that its Agent Session UI appears once Agent session events are enabled; with
  webhooks off we expect no session panel, but that has not yet been checked in a live workspace.
- A follow-up from another chat on the same agent reaches the same task: say "work on ABC-123"
  (that chat now also gets updates) or send a follow-up note. Neither starts a second task.
- Comments people write on the issue do **not** reach the agent as messages; talk to the agent in
  chat. The plugin still rereads the issue before each status write and on its five-minute
  recheck, so a person closing, reassigning or undelegating the issue wins.
- A Linear Stop button only exists in an Agent Session, so stop work from chat or with native
  Kanban controls.

## Part 2: assign from Linear

Assigning (delegating) an issue to the agent, or @mentioning it, reaches the agent as a Linear
webhook. The plugin does not listen on a port. It reads verified deliveries from a local SQLite
inbox, by default `/opt/data/workspace/linear/ingress.db`, and skips the inbox entirely when that
file does not exist. The **webhook receiver** (`linear-receiver` in the starter overlay's
`compose.sidecars.yaml`, source in [`sidecars/linear-receiver/`](../sidecars/linear-receiver/))
accepts Linear's webhooks and writes each verified one into that inbox for the right agent.

### What the receiver accepts

For every delivery, in this order:

| Check | Fails as |
| --- | --- |
| The URL path is exactly `/linear/<agent>` for an agent in `linear-receiver.json` whose signing secret is set | 404 |
| `linear-signature` is the HMAC-SHA256 of the exact raw body with that agent's signing secret (constant-time compare) | 401 |
| A `Linear-Delivery` id is present | 400 |
| The signed `webhookTimestamp` is within one minute of the receiver's clock | 401 |
| Neither the delivery id nor the body was seen before for this agent; a repeat, or the same signed body under a new id (the id header is not signed), is acknowledged and never filed twice, the same id with other content is refused | 200 `duplicate` / 400 |
| `organizationId` is the agent's workspace, and `oauthClientId` its app if you set `oauth_client_id` | 200 `ignored` |
| An Agent Session event names the agent's own app user (`appUserId`), is `created` or `prompted`, and comes from a person in `allowed_actor_ids` (`agentSession.creatorId` or `agentActivity.userId`) | 200 `ignored` |
| An Issue event delegates or assigns to, or used to delegate or assign to, this app | 200 `ignored` |

Only then is the raw body committed to the agent's inbox, before the receiver answers 200.
"Ignored" deliveries are answered 200 so Linear does not retry them, and are dropped: they never
reach the agent. Nothing in a payload adds permission; it only has to match what you configured.
The receiver holds no OAuth token and never calls Linear. A session Linear opens with no person
behind it, or with the agent itself as the actor (for example when the agent delegates an issue
to itself from chat), is dropped, so chat-started work keeps reporting through issue comments.

Unknown event types (comments, projects and so on) are dropped too. The plugin still checks every
person against `platforms.linear.allowed_users` and rereads the session from Linear before it
acts; the receiver's allowlist is an outer gate, not a replacement.

### Steps

1. Add `app:mentionable` to the scopes and install again with `update_scopes_on_existing_token=true`
   on the authorize URL; Linear then issues a new refresh token, which replaces the one in your
   1Password item.
2. **Give the receiver a public HTTPS URL.** Linear must reach it from the internet; the
   receiver only listens on `127.0.0.1:8646` on the Docker host (change the host port with
   `LINEAR_RECEIVER_PORT`). Put a tunnel or a reverse proxy in front of it and forward only
   the `/linear/` paths. With a tunnel such as Cloudflare Tunnel, a public hostname
   `linear-hooks.example.com` with service `http://localhost:8646`. With a reverse proxy, for
   example Caddy on the same host:

   ```text
   linear-hooks.example.com {
       handle /linear/* {
           reverse_proxy 127.0.0.1:8646
       }
       respond 404
   }
   ```

   Keep TLS at the tunnel or proxy, and do not let it rewrite or re-encode the request body:
   the signature covers the exact bytes Linear sent.
3. **Configure the receiver** in your overlay, one entry per agent, in `linear-receiver.json`
   beside the compose files (synthetic values):

   ```json
   {
     "agents": [
       {
         "name": "ops",
         "organization_id": "example-workspace-id",
         "app_user_id": "example-ops-app-user-id",
         "allowed_actor_ids": ["example-linear-user-id"],
         "secret_env": "LINEAR_WEBHOOK_SECRET_OPS"
       }
     ]
   }
   ```

   `name` is the agent's profile and inbox name, `organization_id` and `app_user_id` are the
   `organization.id` and `viewer.id` from [step 4](#4-find-the-apps-ids), and
   `allowed_actor_ids` are the Linear user IDs of the people who may start or steer work (the
   same people as `allowed_users` below). Optional `oauth_client_id` also pins the app's client
   ID. Unknown keys, duplicates and an empty allowlist turn the receiver off.
4. **On the OAuth app**, turn webhooks on with the URL `https://linear-hooks.example.com/linear/ops`
   (your hostname, then `/linear/<name>`) and select **Agent session events** and **Issues**.
   Copy the webhook signing secret into `secrets/linear-receiver.env`, which `.gitignore` keeps
   out of git, together with the public URL:

   ```bash
   LINEAR_RECEIVER_PUBLIC_URL=https://linear-hooks.example.com
   LINEAR_WEBHOOK_SECRET_OPS=<the app's webhook signing secret>
   ```

   Each agent has its own app, so each has its own secret and its own variable. Only the
   receiver gets this file; the agent never needs the signing secret.
5. Turn on the Linear gateway platform in the profile config, with the Linear user IDs allowed to
   talk to the agent:

   ```yaml
   platforms:
     linear:
       enabled: true
       allowed_users: ["example-linear-user-id"]
   platform_toolsets:
     linear: [linear, kanban]
   ```

6. **Start it**: `docker compose -f compose.yaml -f compose.sidecars.yaml up -d`. The compose
   file gives each agent its own inbox volume at `/opt/data/workspace/linear`, and only the
   receiver can write to it from outside the agent. Set the plugin's `ingress_profile` only if
   the receiver files this agent's deliveries under a different name than its profile.
7. **Check the setup.** Run the setup check with the receiver config:

   ```bash
   # from the Fleet checkout, as in the overlay README's setup check
   python3 scripts/switchroom-doctor.py \
     --config ~/my-fleet-overlay/managed/ops.yaml \
     --linear-receiver-config ~/my-fleet-overlay/linear-receiver.json
   ```

   It reads `secrets/linear-receiver.env` beside that file (or `--linear-receiver-env`) and never
   prints a secret.

   It prints `linear-receiver: on`, or `linear-receiver: off: <reason>` (for example
   `LINEAR_RECEIVER_PUBLIC_URL is not set` or `no agent has its webhook signing secret set`), plus
   a `linear-receiver.<agent>: off: ...` line for each agent without its secret. The receiver
   prints the same line when it starts (`docker compose logs linear-receiver`), with the webhook
   URL for each agent it serves, and exits when it is off.
8. **Check it end to end**: delegate a test issue to the agent. The receiver logs nothing for a
   filed delivery and one `outcome=...` line for anything it refused or ignored. Within seconds
   the plugin starts one native task (`session.admit` in `gateway.log`). Repeating the
   delegation never starts a second task.

What is proven so far: the receiver's checks above are covered by unit tests over real HTTP
(`tests/test_linear_receiver.py`), its inbox has the exact table the plugin drains, and
`docker compose config` accepts the layered files. Not yet checked: the receiver in running
containers against a live Linear workspace, so the Agent Session panel showing progress
(step 8) is what the plugin is built to do, not yet something this guide has observed.

## Part 3: handoff between two agents

"Take over ABC-123 from Example-A" works without the receiver. Each agent keeps its own OAuth app;
neither borrows the other's credentials. The taking agent asks the owner, through a command you
configure, to stop and prove its run ended, then starts the remaining work and replaces the
delegate. On the taking agent (`Example-B`):

```yaml
        takeover:
          name: Example-B
          agents:
            - name: Example-A
              delegate_id: example-a-app-user-id   # Example-A's viewer.id
              command: [example-host-bridge, profile, example-a, --, hermes, --profile, default]
              wait_seconds: 90
```

`command` must run Example-A's own `hermes` CLI in Example-A's profile and pass arguments through
unchanged (for example `docker exec ...` or a host bridge). Never wrap it in `ssh` or `sh -c`. Give
every agent a distinct `takeover.name`. Without this block `take_over` refuses and changes nothing.
The full flow and its limits are in
[Take over from another agent](../plugins/linear/README.md#take-over-from-another-agent).

## Troubleshooting

| You see | It means |
| --- | --- |
| `Linear actor/workspace does not match configured identity` | The token belongs to another app or workspace; recheck step 4. |
| `... must be a regular file owned by this user with mode 600` | Fix ownership (UID 1000) and mode of `.op.env`, the token file or the cache. |
| `reason=auth_unavailable` (on `service.start` or `auth.reauth_required` in `gateway.log`) | Linear refused the refresh token: revoked, expired or rotated by another process. Repeat step 3 and update the item. |
| The chat says the delegate update is held | Usually `app:assignable` is missing, or a person changed the issue's routing first. The work still runs. |
| Assigning in Linear does nothing | Without the receiver this is expected (Part 2). With it, run the setup check (Part 2, step 7) and read `docker compose logs linear-receiver`. |
| `outcome=refused:bad_signature` | The secret in `secrets/linear-receiver.env` is not this app's webhook signing secret, or the proxy changed the body. |
| `outcome=refused:stale_or_missing_timestamp` | The host clock is more than a minute off, or something is replaying old deliveries. |
| `outcome=ignored:unknown_actor` | The person is not in `allowed_actor_ids`, or Linear opened the session without a person behind it. |
| `outcome=ignored:unknown_workspace` / `unknown_app` | `organization_id`, `app_user_id` or `oauth_client_id` in `linear-receiver.json` does not match this app (step 4 of Part 1). |
| `context_or_service_unavailable` from the tool | The gateway, and with it the reporting service, is not running for this profile. |
