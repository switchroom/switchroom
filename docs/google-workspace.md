# Google Workspace

Switchroom agents can read your Google Docs, Sheets, Slides, and folders
on your behalf, suggest edits inline in Drive, and collaborate on docs
with you over Telegram. Auth is per-user OAuth — the agent uses your
Google account, not a service account. Nothing leaves your subscription.

> **Status (2026-05-15).** The Phase 1 primitives are merged; the
> end-to-end Telegram flow lands as a series of follow-up wiring PRs
> (see `reference/rfcs/doc-connection-completion.md` §10 for the
> still-outstanding pieces). This guide describes the model — sections
> tagged **(pending wire-up)** are not yet operator-visible.

## TL;DR

```bash
# 0. One-time per install — create + register your Google OAuth client.
#    The wizard walks you through the GCP Console, stores the client
#    id/secret in the vault, and writes the google_workspace: config
#    block for you. (Manual equivalent: see "Prerequisite" below.)
switchroom auth google connect

# 1. Connect a Google account to the auth-broker (one-time per account).
#    <account> is the Google EMAIL, not a label.
switchroom auth google account add you@gmail.com

# 2. Allow an agent to use that account (the ACL — enabled_for[]).
switchroom auth google enable you@gmail.com klanker

# 3. REQUIRED, separate from step 2: set the agent's account selector
#    in switchroom.yaml, then reconcile. Without this the broker returns
#    ACCOUNT_NOT_FOUND and the agent silently has no Drive.
#      agents: { klanker: { google_workspace: { account: you@gmail.com } } }
switchroom agent restart klanker      # or `switchroom update` for the fleet

# 4. Verify (catches the step-3 trap up front):
switchroom doctor                     # see the "Google Drive" section

# 5. (Optional) Pick the Workspace tier — defaults to "core".
#    See docs/configuration.md § google_workspace for the cascade.
```

Step 0 is **required and one-time per switchroom install** — switchroom
deliberately ships no OAuth client (see "Prerequisite" below for why).
Steps 1–2 are the per-account / per-agent surface. Everything else is
one of:
- The agent already having access and doing the right thing.
- Telegram approval cards the operator taps when the agent asks.

## The model in 30 seconds

```
            ┌─ auth-broker ──────────────────────┐
            │                                    │
operator ───▶ google account add <email>          │
            │   → loopback OAuth                 │
            │   → refresh_token stored in        │
            │     ~/.switchroom/auth-broker/     │
            │                                    │
operator ───▶ google enable <email> <agents…>     │
            │   → adds agents to the per-        │
            │     account ACL (enabled_for[])    │
            │                                    │
operator ───▶ set agents.<name>.google_workspace. │
            │   account: <email>  (REQUIRED —    │
            │   the broker selects the account   │
            │   from this, not a per-call arg)   │
            │                                    │
agent ──────▶ get_credentials(provider=google)    │
            │   → broker derives account from    │
            │     the agent's config + enforces  │
            │     enabled_for[] → access_token   │
            └────────────────────────────────────┘
```

**Accounts are identified by Google email, not an arbitrary label.**
`account add`, `google_accounts:` keys, and `google_workspace.account`
are all the email (validated + lowercased). One Google account → many
agents (gated by `enabled_for[]`); one agent → exactly one Google
account, named in its `google_workspace.account`. Granting access is
**two fields, both required** — `enabled_for[]` *and* the per-agent
`google_workspace.account` (see "Granting an agent access"). RFC G §4.4
spells out why this shape is load-bearing.

## Prerequisite — your OAuth client (one-time per install)

Before any agent can touch Drive you need **one Google OAuth client,
registered with switchroom**. Switchroom intentionally ships no shared
client: per-user OAuth against *your* client is what keeps the
integration subscription-honest (no service account, nothing routed
through a switchroom-owned credential), and Google's terms expect one
OAuth client per install. So this step is unavoidable by design — but
it's one-time, and the wizard does the mechanical parts.

> **This is not the host-side example.**
> `examples/personal-google-workspace-mcp/` sets up a *different* OAuth
> client for your own host Claude Code's pair-design loop. It is
> deliberately separate and its client must **not** be reused for the
> agent fleet — different trust posture (approval-kernel-mediated vs.
> single-identity). If you followed that README, you still need this
> step for agents.

### The native way

```bash
switchroom auth google connect
```

The wizard:

1. Walks you through the GCP Console screens (create project → enable
   Drive/Docs/Sheets/Calendar APIs → OAuth consent screen, add yourself
   as a test user → create an OAuth client of type **"Desktop app"**
   — Drive uses the loopback flow; see the client-type note below).
2. Prompts for the client id + secret and stores them in the vault
   **via the vault-broker** (`google-oauth-client-id` /
   `google-oauth-client-secret`) — the broker owns `vault.enc`, so the
   write works regardless of file ownership. The vault passphrase you
   enter is forwarded to the broker as operator attestation; it must
   match the passphrase the broker is unlocked with.
3. Offers to write the `google_workspace:` block into your
   `switchroom.yaml` (atomic write, comment-preserving; it
   re-validates the file afterward and never overwrites an existing
   block).
4. Points you at `switchroom auth google account add` to continue.

### The manual equivalent

If you'd rather do it by hand (the wizard automates exactly this):

1. **GCP Console** (≈5 min) — at <https://console.cloud.google.com>:
   create a project; under *APIs & Services → Library* enable the
   **Google Drive, Docs, Sheets, and Calendar** APIs; under *OAuth
   consent screen* pick **External**, add yourself as a **Test user**;
   under *Credentials → Create credentials → OAuth client ID* choose
   **"Desktop app"**. Copy the client id and secret.

   > **Client type matters — Desktop app.** Drive auth uses Google's
   > **loopback** flow, which requires a Desktop client. The other two
   > flows are dead ends for Drive: **device-code** returns
   > `invalid_scope` for Drive scopes (Google does not allow Drive on
   > device flow), and **OOB** was retired by Google in 2022. On a
   > **headless server** you can complete the single browser step over an
   > SSH port-forward — `switchroom auth google account add` prints the
   > exact URL and `localhost` port; you `ssh -L <port>:127.0.0.1:<port>`,
   > open the URL, approve. Or skip SSH entirely and run it from Telegram
   > with `/auth google add <email>` (issue #2582) — the agent relays the
   > consent URL to chat and you paste the redirect back. Same
   > Desktop+loopback shape the `examples/personal-google-workspace-mcp/`
   > host MCP uses.
2. **Vault the secrets** so they never land in YAML:

   ```bash
   switchroom vault set google-oauth-client-id
   switchroom vault set google-oauth-client-secret
   ```

3. **Add the block** to `~/.switchroom/switchroom.yaml` (top-level —
   the client id/secret are install-wide, not per-agent):

   ```yaml
   google_workspace:
     google_client_id: "vault:google-oauth-client-id"
     google_client_secret: "vault:google-oauth-client-secret"
     approvers: [123456789]   # your Telegram numeric user id
     tier: core               # core | extended | complete (default: core)
   ```

   See `docs/configuration.md` § `google_workspace` for the cascade
   and every field. `SWITCHROOM_GOOGLE_CLIENT_ID` /
   `SWITCHROOM_GOOGLE_CLIENT_SECRET` env vars override the block for
   one-off operator debugging, but the vault + YAML block is the
   persistent baseline switchroom expects.

## Connecting an account

```bash
switchroom auth google account add you@gmail.com
```

`<account>` is the **Google account email** — it is validated and
lowercased, not a free-form label. This runs Google's **loopback** flow
(device-code and OOB do not work for Drive — see the client-type note
above):

1. Prints a consent URL and binds an ephemeral `127.0.0.1:<port>`
   listener.
2. Open the URL, sign in, approve. On a headless server, first
   `ssh -L <port>:127.0.0.1:<port> …` so the browser callback reaches
   the listener.
3. The listener exchanges the code and stores the refresh token in the
   broker (encrypted at rest — same machine-bound vault posture as the
   rest of switchroom).
4. Account is now visible in `switchroom auth google account list`.

**No SSH needed — do it from Telegram instead (issue #2582).** The
loopback flow is fully relayable over chat, so you never need the
keyboard or an SSH port-forward. From a chat with the admin agent that
holds (or will hold) the grant:

```
/auth google add you@gmail.com            # add or re-auth
/auth google add you@gmail.com --replace  # re-consent an existing account
/auth google add you@gmail.com --write    # request Drive write scope
/auth google add you@gmail.com --calendar # request read-only Calendar scope
```

The agent runs the loopback flow **in its own container**, relays the
consent URL to chat, you approve on your phone (the redirect to
`127.0.0.1` fails to load — that's expected), then paste the full URL
from your address bar (`?code=...&state=...`) back into chat. The
gateway validates `state` and hands the code to the waiting listener.
`/auth google cancel` aborts. Run it against the agent that should hold
the grant — `google/client-secret` is an admin-only vault key that
can't be minted to the root agent, so "the agent that holds the grant"
is the right place to run it.

If you have multiple Google accounts to attach, repeat with each
account's email. Agents reference accounts by that email everywhere
(`google_accounts:` keys, `google_workspace.account`) — there is no
separate label.

### Scopes — read by default, write is opt-in

`account add` requests **read-only** scopes by default:

- `drive.readonly` — read doc/sheet bodies
- `drive.metadata.readonly` — list folders + files

A read grant **never silently becomes a write grant** (RFC D §12). To
let agents *create and edit* docs (e.g. draft a new doc into a folder),
pass `--write`:

```bash
switchroom auth google account add you@gmail.com --write
# re-consent an already-connected account to add write:
switchroom auth google account add you@gmail.com --replace --write
```

`--write` adds **`drive.file`** — least-privilege: agents can create
files and edit files **they create**, but cannot edit your pre-existing
unrelated Drive files (that would be the full `drive` scope, which
switchroom deliberately does not request). It does **not** change
behaviour for read-only accounts.

#### Calendar is read-only and opt-in

The `gdrive` MCP exposes Calendar tools (`list_calendars`, `get_events`)
at **every** tier, but the token switchroom mints carries no Calendar
scope by default, so those tools 403 — and the upstream MCP then falls
back to its own browser OAuth, which cannot complete inside a container.

Pass `--calendar` to mint `calendar.readonly` alongside the Drive scopes:

```bash
switchroom auth google account add you@gmail.com --calendar
# add Calendar read to an already-connected account (re-consent):
switchroom auth google account add you@gmail.com --replace --calendar
```

Two deliberate limits:

- **Read-only only.** `calendar.readonly` lists calendars and reads
  events. switchroom never requests the read/write `calendar` or
  `calendar.events` scopes — creating or moving events is a write
  surface with its own approval shape (same argument RFC G §5 makes
  about Gmail).
- **Never a tier default.** No tier grants Calendar. Folding it into a
  tier's default set would mean an operator re-minting after an
  unrelated tier bump silently hands over their whole calendar — a read
  grant must never silently widen (RFC D §12), which is exactly why
  `--write` is a flag too.

#### Re-consent carries existing scopes forward

OAuth scopes are fixed at consent time, so `--replace` mints exactly the
set the flags describe. To stop an unrelated re-consent from silently
revoking capability, `account add` reads the scopes the broker already
holds for the account and **unions the opt-ins forward**: re-running
with `--replace --calendar` on a write-capable account keeps
`drive.file`, and prints a line saying so. The union only flows one way
— a capability you did not ask for and the token does not already hold
is never requested.

Asking for a scope the stored token lacks *without* `--replace` is
refused with an explicit "scopes are fixed at consent time, re-consent
like this" error rather than appearing to succeed.

#### Workspace API scopes are tied to the tier

Creating or editing **native Google Docs / Sheets / Slides** needs
product-specific OAuth scopes on top of the Drive scopes — `drive.file`
alone authorizes a Drive *file object*, not a `documents.batchUpdate` /
`spreadsheets.batchUpdate` / `presentations.batchUpdate` call. So
`account add` mints those scopes alongside Drive, and **ties the set to
the `tier`** in your `google_workspace:` block:

| tier       | Workspace API scopes minted             |
|------------|-----------------------------------------|
| `core`     | `documents`, `spreadsheets`             |
| `extended` | `documents`, `spreadsheets`, `presentations` |
| `complete` | `documents`, `spreadsheets`, `presentations` |

`presentations` (Slides) is added at `extended`/`complete` because
Slides tools first appear at the `extended` tier. Forms / Tasks / Chat /
Gmail scopes are **not** minted — that is a separate, larger decision
(Gmail in particular has an unresolved approval shape; see RFC G §5).
Calendar is available, but only read-only and only via the explicit
`--calendar` flag — never as a tier default (see above).

**Changing the tier requires re-running `account add`.** OAuth scopes
are fixed at consent time — raising `tier: core` → `tier: extended`
does **not** retroactively widen an already-minted token. After a tier
change, re-mint:

```bash
switchroom auth google account add you@gmail.com --replace [--write] [--calendar]
```

If you skip the re-mint, the `gdrive` MCP launcher prints a loud
warning at startup naming the missing scopes and the exact recovery
command — and the affected tools (Docs/Sheets/Slides create+edit) fail
cleanly instead of triggering the upstream MCP's own browser OAuth
(which binds a callback port that is unrecoverable inside a container).
`switchroom auth google account list` shows each token's effective
scopes.

> **Port override.** That doomed upstream OAuth fallback binds a
> callback server on a local port. The launcher moves it off the
> upstream default (`8000`, commonly taken on a shared host) to
> `8631`. If `8631` also collides, set `SWITCHROOM_GDRIVE_MCP_PORT`
> in the agent's environment to a free port. This only affects the
> never-meant-to-run fallback path — the seeded, browserless flow
> doesn't bind a port at all.

### Removing an account

```bash
switchroom auth google account remove you@gmail.com
```

Deletes the refresh token from the broker AND best-effort-revokes it
at Google. Idempotent — re-run if the first call fails to reach
Google.

## Granting an agent access

Granting an agent Drive access is **two required steps** — doing only
the first is the most common failure mode (it fails *silently* until
the agent is asked to use Drive).

**Step 1 — the ACL.** By default a new account is reachable by no
agents. Add agents to its `enabled_for[]`:

```bash
# "all" expands to every declared agent:
switchroom auth google enable you@gmail.com klanker
switchroom auth google enable you@gmail.com klanker clerk
switchroom auth google enable you@gmail.com all

# Inspect / revoke:
switchroom auth google list                       # full agent × account matrix
switchroom auth google disable you@gmail.com klanker
```

**Step 2 — the per-agent account selector (REQUIRED, separate).**
`auth google enable` only writes `enabled_for[]`. The broker selects
which account to return for an agent from that agent's own
`google_workspace.account` (path-as-identity — the launcher passes no
account). Without it the broker returns `ACCOUNT_NOT_FOUND` and the
agent has no Drive tools, with **no error at config time**:

```yaml
agents:
  klanker:
    google_workspace:
      account: you@gmail.com    # must match a google_accounts: key
```

Then apply the scaffold so the agent's `.mcp.json` + trust are
regenerated: `switchroom update` (fleet) or `switchroom agent restart
klanker`. A *pure* `enabled_for[]` change on an already-wired agent
takes effect on the next `get_credentials` call with no restart; adding
a brand-new Drive agent needs the reconcile because its MCP wiring
doesn't exist yet.

**Verify.** `switchroom doctor` has a **Google Drive** section that
flags every `enabled_for[]` ↔ `google_workspace.account` mismatch and
the deployed scaffold wiring — run it after any change here instead of
discovering the gap when an agent says "Drive's blocked". The
auth-broker is the source of truth (RFC G §4.4 + RFC H Phase 3b).

## Working with the agent over Telegram

Once an agent has Drive access, the day-to-day shape:

### Reading docs

The agent can list folders / files / docs / sheets without further
prompts — `core` tier grants standing read access. The kernel's
approval flow doesn't gate read calls; you grant read access once at
account-enable time.

### Suggesting writes **(pending wire-up)**

When the agent wants to *edit* a doc — add a paragraph, replace a
TBD line, append meeting notes — it posts an approval card:

```
✏️ klanker wants to add to "Q3 Strategy Notes"
📍 after heading 'Goals' (level 2)
+47 lines / -0 lines
💬 "Added Hiring section after 'Goals'"
[ 📖 Open in Drive ]  [ ✅ Apply as suggestion ]
[ ⚠ Apply directly ]   [ 🚫 Cancel ]
```

Three things on this card are **wrapper-attested** — meaning the agent
cannot fake them:

- `📍` — where in the doc the edit lands (computed from the resolved
  anchor, not from anything the agent said).
- `+N / -M lines` — the actual line delta.
- `📖 Open in Drive` — the deep link to the actual doc.

The agent's `💬` summary is shown alongside but is the agent's framing,
not wrapper truth. If those two diverge, you can see it at a glance.

### Anchors

The agent doesn't say "insert at character offset 14732" — that's
brittle. It uses a stable anchor:

```typescript
// Headed doc (preferred)
{ after_heading: "Goals", level: 2 }
{ append_to_section: "Hiring", level: 2 }

// Unheaded doc (meeting notes, draft prose)
{ after_line_containing: "we agreed to ship by Q3" }
{ before_line_containing: "Action items:" }
{ replace_line_matching: /TBD: hiring section/ }

// Empty / very short docs
{ at_start: true }
{ at_end: true }
```

If an anchor doesn't resolve (heading renamed, snippet text changed),
the agent gets `HEADING_NOT_FOUND` / `SNIPPET_AMBIGUOUS` and asks you
in chat which one it should land on. No silent guess.

### Folder picker **(pending wire-up)**

`switchroom drive folders <agent>` posts a Telegram card with your
top-level folders. Tap one and you've authorised the agent for that
folder *and every doc inside it*. No need to grant per-doc when the
agent is going to work in `/Work/2026/Q3` for the next hour.

### Document recovery **(pending wire-up)**

If you trash a doc and later un-trash it, the reconciler notices and
the agent posts:

```
↻ 'Q3 Strategy Notes' is back — let me know if you want me to pick
up where I left off.
```

You don't have to re-grant access; the existing grant just becomes
reachable again. RFC E §4.4 spells out why this is asymmetric (we
treat un-trash as a recovery signal, but missing→missing isn't).

## Configuration cascade

The `google_workspace:` block (alias: `drive:`) lives in `switchroom.yaml`.
Defaults → profile → per-agent override, same as everything else
(see `docs/configuration.md` for the general cascade rules). The
minimum:

```yaml
google_workspace:
  tier: core            # core | extended | complete
  # tools: { include: [...], exclude: [...] }  # optional per-tool override
```

Two distinct knobs, don't conflate them: the **ACL**
(`google_accounts.<email>.enabled_for[]`) is set via `auth google
enable/disable` (or by hand in YAML) and a pure ACL change takes effect
on the next `get_credentials` with no restart (RFC G §4.4); the
**per-agent account selector** (`agents.<name>.google_workspace.account`)
is YAML and is *required* — see `docs/configuration.md` § "Per-account
ACL + per-agent selection" and "Granting an agent access" above.

## Troubleshooting

### "Drive disconnected — reconnect klanker?"

The refresh token has been revoked or rotated. Re-run:

```bash
switchroom auth google account add you@gmail.com --replace  # re-consent
# OR if the broker still has the slot but the token is dead:
switchroom auth google account remove you@gmail.com
switchroom auth google account add you@gmail.com
```

Causes: the user changed their Google password, or revoked switchroom
in the Google Account dashboard. Note the **7-day refresh-token
lifetime applies only to Testing-mode OAuth clients** — move the client
to Production in the GCP console (the recommended posture) and that
clock goes away; it is not a cause there.

### Agent says "Not logged in" right after `switchroom update`

The boot-fanout fix in #1280 + the mirror-time enrichment in #1285
address the known cases. If you hit it on a current build:

```bash
switchroom auth google list                      # confirm the account is registered
switchroom auth google enable <account> <agent>  # re-attach if the agent fell out of the ACL
switchroom agent restart <agent>
```


### Two agents stomping on each other's Drive

Each agent has its own kernel grants — they don't share. If two agents
both wrote to the same doc within the approval-card window, the
agent-side audit log (`switchroom debug audit <agent>`) shows what
happened, and Drive's own revision history shows the merged result.
Switchroom doesn't currently broker between agents writing to the
same doc — they race like any other Drive collaborators.

### "MULTIPLE_MATCHES" error from a suggested edit

The agent's text-snippet anchor matched 2+ lines in the doc. The
error response carries the first 3 surrounding-context excerpts; the
agent picks one by `nth_match` index. If the agent burns 3+ tool calls
on the same doc with bad anchors, the wrapper returns the doc's full
structural tree so the agent can re-plan from ground truth.

## See also

- `reference/rfcs/google-workspace-generalization.md` — RFC G (per-account
  ACL, auth-broker provider, examples/personal-google-workspace-mcp/).
- `reference/rfcs/doc-connection-completion.md` — RFC E (Drive collab loop,
  Phase 1 anchors / diff-preview / folder picker / recovery).
- `reference/rfcs/gdrive-mcp.md` — RFC D (original Drive MCP integration,
  shipped v0.6.0; supersedes the env-vars-only auth model).
- `docs/configuration.md` — the cascade, all knobs.
- `examples/personal-google-workspace-mcp/` — host-side single-user
  HTTP MCP for the operator's own pair-design loop (different shape
  from the agent-side wrapper above).
