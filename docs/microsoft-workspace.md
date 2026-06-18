# Microsoft 365 (OneDrive · Mail · Calendar · Office)

Switchroom agents can read your OneDrive files, draft mail, manage your
Outlook calendar, and edit Word/Excel/PowerPoint files on your behalf.
Auth is per-user OAuth — the agent uses your Microsoft account
(personal MSA or M365 work), not a service principal. Nothing leaves
your subscription. (RFC #1873.)

> **Status (2026-05-27).** All five PRs of the RFC #1873 series shipped
> (#1881–#1887). End-to-end UAT is the final validation gate. This guide
> describes the operator path that's wired today.

## TL;DR

```bash
# 0. One-time per install — register your Entra OAuth app.
#    See "Prerequisite — Entra app registration" section below (no
#    interactive wizard yet; `auth microsoft account add` prints the
#    full guidance on first error).

# 1. Connect a Microsoft account to the auth-broker.
#    <account> is the Microsoft EMAIL, not a label.
switchroom auth microsoft account add you@outlook.com

# 2. Allow an agent to use that account. `enable` writes BOTH halves of
#    the gate — the ACL (microsoft_accounts.you@outlook.com.enabled_for[])
#    AND the per-agent selector (agents.clerk.microsoft_workspace.account) —
#    then hot-reloads the running auth-broker so the grant is live at once.
#    (It won't override a selector already pinned to a different account;
#    it warns instead.)
switchroom auth microsoft enable you@outlook.com clerk

# 3. Restart the agent so it regenerates its MCP config and surfaces the
#    Microsoft/OneDrive tools (the broker credential is already live from
#    step 2 — this step is only about the agent's tool list).
switchroom agent restart clerk        # or `switchroom update` for the fleet

# 4. Verify:
switchroom doctor                     # see "Microsoft 365 (RFC #1873)"
```

Step 0 is **required and one-time per switchroom install** — switchroom
deliberately ships no shared OAuth app (the integration is
subscription-honest per user). Steps 1–2 are the per-account /
per-agent surface. Everything else is the agent doing the right thing
with the access you granted + approval cards in Telegram for writes.

## The model in 30 seconds

```
┌─────────────────┐    OAuth refresh token         ┌──────────────┐
│ auth-broker     │ ←──────────────────────────────│ Entra (MS)   │
│ (host process)  │                                 └──────────────┘
│                 │
│  microsoftOauth │ Fresh access token (1h lifetime)
│  per account    │ ↓
└─────────────────┘
        │
        │ get_credentials(provider=microsoft)
        │   (path-as-identity: broker derives account from
        │    agents.<name>.microsoft_workspace.account)
        ↓
┌────────────────────────────────────────────────────┐
│ agent container                                    │
│  ┌───────────────────────────┐                     │
│  │ claude (subscription OAuth) │                   │
│  │      ↓                    │                     │
│  │   .mcp.json → ms-365      │ ← scaffold emits    │
│  │      ↓                    │   when (matrix OK)  │
│  │  m365-mcp-launcher        │ ← refresh loop:     │
│  │      ↓                    │   kill+respawn      │
│  │  softeria stdio MCP       │   softeria every    │
│  │  (BYOT access token)      │   ~55min            │
│  └───────────────────────────┘                     │
└────────────────────────────────────────────────────┘
```

The launcher acquires a fresh access token from the auth-broker, spawns
the upstream softeria MCP server with `MS365_MCP_OAUTH_TOKEN` set, and
refreshes that token (kill + respawn) ~5 min before its 1-hour expiry.
A heartbeat file at `~/.switchroom/agents/<name>/m365-launcher.heartbeat.json`
records each successful refresh — `switchroom doctor` reads it to
verify the launcher is alive and rotating on schedule.

## Prerequisite — Entra app registration

This is a **one-time** operation per switchroom install. Switchroom does
not ship a shared OAuth app: every operator registers their own, so the
integration is subscription-honest end-to-end (no third party in the
trust path). Plan ~10 minutes.

1. **Open the Entra admin center**: <https://entra.microsoft.com> →
   **Identity** → **App registrations** → **New registration**.

2. **Name**: anything (e.g. `switchroom`). Operator-visible only on the
   consent screen — choose something you'll recognise.

3. **Supported account types**: choose
   **"Accounts in any organizational directory (any Microsoft Entra ID
   tenant — multitenant) and personal Microsoft accounts"**. Manifest
   value: `AzureADandPersonalMicrosoftAccount`. This is the one option
   that covers both personal Outlook/Hotmail/Live AND M365 work
   accounts via the `/common` endpoint.

   > **Why not pick a narrower audience?** See RFC §4.1. Once you
   > register, the audience setting is hard to change (Microsoft
   > essentially requires you to register a new app). Pick multitenant
   > + MSA now even if you only use one account today.

4. **Redirect URI**: platform **"Mobile and desktop applications"**,
   value `http://localhost`. Microsoft ignores port for loopback URIs
   so a single `http://localhost` matches every ephemeral port the
   loopback flow uses.

5. Click **Register**. Copy the **Application (client) ID** from the
   Overview page — you'll vault it in step 9.

6. **Authentication → Advanced settings → Allow public client flows:
   Yes**. Enables device-code flow on personal MSA (and is the default
   for desktop apps in modern Entra). Save.

7. **(Optional) Certificates & secrets → New client secret**. Public-
   client flow doesn't need a secret (loopback + PKCE works without),
   but adding one is harmless and lets you flip to confidential-client
   later. If you create one, copy its **Value** immediately (not the
   ID — the Value is only shown once).

8. **(Work tenants only) API permissions → Add a permission → Microsoft
   Graph → Delegated**: add `User.Read`, `Mail.ReadWrite`,
   `Calendars.ReadWrite`, `Files.ReadWrite.All`, `offline_access`. If
   your tenant requires admin consent for any of these, your IT admin
   must grant it before first sign-in. Personal MSA accounts don't
   need this step (consent is per-user at first auth).

9. **Vault the credentials**:

   ```bash
   switchroom vault set microsoft-oauth-client-id
   # paste the Application (client) ID from step 5

   # only if you created a secret in step 7:
   switchroom vault set microsoft-oauth-client-secret
   ```

10. **Add to `~/.switchroom/switchroom.yaml`** (top level):

    ```yaml
    microsoft_workspace:
      microsoft_client_id: "vault:microsoft-oauth-client-id"
      microsoft_client_secret: "vault:microsoft-oauth-client-secret"  # omit if public-client
      authority: https://login.microsoftonline.com/common
      org_mode: false  # default — flip to true for Teams/SharePoint
    ```

That's the prereq. Step 1 of the TL;DR (`account add`) can now run.

> **One real trap worth flagging — don't reuse an existing Entra app.**
> If you already have a personal app registration (a family calendar
> app, side project), the temptation is to add switchroom's scopes to
> that. RFC §4.1 explains why this bites: `signInAudience` is set
> per-app and hard to change after registration; adding broader scopes
> bloats the consent record + couples blast radius; token-version
> drift is real. Register a separate app for switchroom — 5 minutes
> of extra setup, zero coupling.

## Connecting an account

```bash
switchroom auth microsoft account add you@outlook.com
```

Flow (auto-detected from host environment):

- **Desktop with browser** (default when `$DISPLAY` set and a
  browser-opener like `xdg-open` is on PATH): loopback OAuth on
  127.0.0.1 ephemeral port + PKCE. The CLI prints the consent URL,
  opens it in your browser, and catches the redirect.
- **Headless SSH** (no `$DISPLAY`, `$SSH_CONNECTION` set): device-code
  flow. CLI prints `microsoft.com/devicelogin` + a short code; you
  open that URL on any device (phone, laptop, work computer), paste
  the code, complete consent there. Works fine for both personal MSA
  and work accounts despite an older Microsoft doc page that
  incorrectly says device-code doesn't work on `/common`.

Override the auto-detection: `SWITCHROOM_MICROSOFT_OAUTH_TIER=device_code`
or `=desktop_loopback`.

Per RFC §4.3, the scope set requested at consent time:

```
openid profile email offline_access
User.Read
Mail.ReadWrite
Calendars.ReadWrite
Files.ReadWrite.All
```

With `--org-mode` (or `microsoft_workspace.org_mode: true`):

```
+ Sites.ReadWrite.All
```

`Sites.ReadWrite.All` is opt-in because it grants read/write to **every
SharePoint site the user can access** — in a large enterprise that can
be thousands of sites holding HR/finance/legal docs. The defaults test
in `reference/principles.md` says the working default for a personal-
use solo operator is not "agent has write access to my employer's
entire SharePoint." Flip `org_mode: true` per-deployment when you need
SharePoint document libraries.

**Mail.Send is not in v1 scope.** Agents can read mail and draft
messages (`Mail.ReadWrite`), but not actually send. Sending is its own
RFC (audit + revocation semantics differ from drafts).

After consent, the CLI shows:

```
✓ Registered Microsoft account ken@outlook.com with auth-broker.
  Account type: personal (MSA — outlook.com / hotmail.com)

  Next: enable on one or more agents:
    switchroom auth microsoft enable ken@outlook.com <agent> [...]
```

## Granting access to agents

The broker needs **two** things to serve a credential: the ACL
(`microsoft_accounts.<acct>.enabled_for[]` lists the agent) AND the
per-agent selector (`agents.<agent>.microsoft_workspace.account`). It
derives the account from the selector, then checks the ACL — missing
the selector yields `ACCOUNT_NOT_FOUND`; missing the ACL yields
`ACCESS_DENIED`.

`enable` writes **both** in one command and hot-reloads the broker:

```bash
switchroom auth microsoft enable you@outlook.com clerk lawgpt
# • appends clerk, lawgpt to microsoft_accounts.you@outlook.com.enabled_for[]
# • pins agents.{clerk,lawgpt}.microsoft_workspace.account = you@outlook.com
#   (skipped + warned for an agent already pinned to a DIFFERENT account)
# • SIGHUPs switchroom-auth-broker so the grant is live immediately —
#   no `docker restart` needed
```

The resulting YAML:

```yaml
agents:
  clerk:
    microsoft_workspace:
      account: you@outlook.com
  lawgpt:
    microsoft_workspace:
      account: you@outlook.com
```

`switchroom doctor` still catches any hand-edited mismatch up front
(`microsoft:matrix:*`).

`switchroom auth microsoft disable you@outlook.com clerk` removes the
agent from the ACL, clears its now-dangling selector (when it pointed
at this account), and hot-reloads the broker. The account stays in
`microsoft_accounts:` with an empty `enabled_for[]` (dormant — matches
shipped Google behavior per RFC §6.1).

## Listing what's configured

```bash
# Configured accounts × agents matrix (YAML view):
switchroom auth microsoft list

# Broker-side credential inventory (currently stubbed — see RFC §10):
switchroom auth microsoft account list
```

## Working with the agent

### Reading

OneDrive files, Outlook mail, calendar, contacts — all read tools fire
without an approval card. Standing-grant model: the operator already
consented at `account add` time. Read tools are namespaced
`mcp__ms-365__<verb>` (e.g. `mcp__ms-365__list-drive-items`,
`mcp__ms-365__search-mail`).

### Office authoring (Word, Excel, PowerPoint)

Agents edit Office files via a 3-step pattern:

1. **Download** the file from OneDrive via softeria
   (`mcp__ms-365__download-bytes`).
2. **Edit locally** using the bundled `docx` / `xlsx` / `pptx` skill,
   which understands the file format properly (tracked changes,
   formulas, slide ops — not the awkward range-insertion Graph
   exposes).
3. **Upload back** via softeria
   (`mcp__ms-365__upload-file-content` for ≤4MB or
   `mcp__ms-365__create-upload-session` for larger files).

The upload step trips the **approval card** (next section).

### Writes — approval cards

Softeria's write tools are gated by a PreToolUse hook
(`/opt/switchroom/hooks/ms-365-write-pretool.mjs`). When an agent
tries to write, the hook intercepts and posts a card to the operator's
Telegram chat:

```
📄 Microsoft 365 write approval

Agent: clerk
Tool: ms-365__upload-file-content
Item: Q3-Strategy.docx
ID:   01ABCDEFG
Account: ken@outlook.com
Size: 14.5KB → 16.2KB (+1.7KB)
Link: https://onedrive.live.com/...
💬 Adding the meeting notes from yesterday

⚠️ Weak attestation (RFC §8 v1): operator should click through to
verify the actual change before approving. Structural diff coming v1.5.

[✅ Approve]  [🚫 Deny]
```

The card is **weak-attestation v1** — the operator sees the file path,
size delta, deep link, and the agent's 1-line rationale. Click
through to OneDrive to inspect the actual change before approving.
Structural-diff cards (download the prior version + run the skill in
diff mode → render a real change summary) is RFC §8 v1.5.

The kernel state machine handles approval persistence and TTL (5min
default). Approved → the upload proceeds. Denied / timeout → softeria's
upload call is blocked with a clear error.

Gated tools (RFC §8.6):
- OneDrive uploads (`upload-file-content`, `create-upload-session`)
- Calendar mutations (`create-event`, `update-event`, `delete-event`)
- Mail edits (`update-message`, `delete-message` — drafts only,
  no send in v1)

## Configuration cascade

`microsoft_workspace:` is a top-level block; `microsoft_workspace.org_mode`
also cascades per-agent (per-agent override wins). Schema:

| Key | Location | Type | Notes |
|---|---|---|---|
| `microsoft_client_id` | top-level | string | Required when any agent enabled. Vault ref OK. |
| `microsoft_client_secret` | top-level | string | Optional (public-client apps work without). Vault ref OK. |
| `authority` | top-level | URL | Defaults to `https://login.microsoftonline.com/common`. |
| `org_mode` | top-level + per-agent | bool | Per-agent wins. Defaults false. Flip true to add SharePoint scope + softeria's `--org-mode` flag. |
| `account` | per-agent only | email | Required for the agent to receive the `ms-365` MCP entry. Must match a key in top-level `microsoft_accounts:`. |
| `microsoft_accounts.<email>.enabled_for` | top-level map | string[] | ACL. Written by `auth microsoft enable/disable`. |

## Troubleshooting

### `switchroom doctor` shows `microsoft:matrix:*` fail

Per-agent `microsoft_workspace.account` and top-level
`microsoft_accounts.<account>.enabled_for[]` disagree. The doctor
output tells you exactly which side is missing and which CLI verb to
run to fix it. Don't hand-edit the YAML — use the CLI verbs so the
two sides stay aligned.

### `switchroom doctor` shows `microsoft:launcher-heartbeat:<name>` fail

Launcher refresh loop has died (last successful refresh >90min ago).
`switchroom agent restart <name>` brings up a fresh launcher. If the
problem recurs, check the launcher's stderr via
`docker logs switchroom-<name> 2>&1 | grep m365-launcher`.

### Agent says "Microsoft is not configured for me"

Step 2 missing — set `agents.<name>.microsoft_workspace.account` in
`switchroom.yaml` and `switchroom agent restart <name>`.

### "AADSTS70008: refresh token expired"

Microsoft refresh tokens age out under certain conditions (user changed
password, app un-consented, refresh inactive >90 days). The broker
flips the account status to `needs_reconnect`. Re-auth:

```bash
switchroom auth microsoft account add you@outlook.com --replace
```

### Personal-MSA accounts and Graph endpoint differences

Some Microsoft Graph endpoints silently no-op or return different
shapes on personal MSA tokens vs work tokens. The doctor's
`microsoft:personal-msa-graph-smoke` (manual UAT) catches the common
class. Most v1 tools (mail/calendar/OneDrive) work on both. Teams
and SharePoint admin surfaces are work-only (and behind `org_mode`).

### Unverified-app warning

If you haven't completed Microsoft publisher verification (requires an
MPN account — paid), the consent screen shows a yellow "Unverified
app" badge. For personal use this is expected (you registered the
app, you're consenting to yourself). For multi-user deployments,
publisher verification is the v1.5+ path.

## Related

- RFC #1873 — `reference/rfcs/microsoft-workspace.md` (full design)
- Issue #1875 — 5-PR implementation series tracking
- `docs/google-workspace.md` — sibling Google integration (much of the
  shape is parallel; provider-specific divergences documented)
- `reference/draft-and-edit.md` — the JTBD this serves
- `reference/inbox-zero.md` — mail JTBD
- `reference/scheduling.md` — calendar JTBD
