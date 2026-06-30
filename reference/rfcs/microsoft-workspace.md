---
artifact: Microsoft 365 integration (OneDrive + Office files + Mail + Calendar)
serves: act-in-my-tools-with-an-identity
advances-outcome: always-available
status: Draft
---

# RFC: Microsoft 365 integration (OneDrive + Office files + Mail + Calendar)

**Status:** Draft
**Owner:** Ken Thompson
**Date:** 2026-05-27
**Related:** [gdrive-mcp.md](./gdrive-mcp.md), [google-workspace-generalization.md](./google-workspace-generalization.md), [doc-connection-completion.md](./doc-connection-completion.md), [auth-broker.md](./auth-broker.md)

## 1. Summary

Add a Microsoft 365 provider to switchroom that mirrors the existing
Google Workspace integration in shape, surfacing OneDrive (read/write),
Mail, Calendar, and Office-file (`.docx`/`.xlsx`/`.pptx`) authoring to
agents.

- **Upstream MCP**: `softeria/ms-365-mcp-server` (TypeScript, MIT,
  actively maintained; ~200 Graph tools). BYOT (bring-your-own-token)
  mode: launcher pre-acquires a fresh access token and feeds it via
  `MS365_MCP_OAUTH_TOKEN` env var.
- **Office authoring**: handled by the already-bundled Anthropic
  skills at `skills/docx`, `skills/xlsx`, `skills/pptx`. No in-house
  Word/PPT MCP shim needed. The skills know the file formats
  properly; softeria just shuttles bytes via OneDrive.
- **OAuth shape**: Entra "personal accounts + any work/school
  directory" multi-tenant app at the `/common` endpoint. One operator
  registration covers both personal MSA (outlook.com / hotmail.com)
  and M365 work accounts.
- **Token storage**: auth-broker owns
  `~/.switchroom/state/auth-broker/microsoft/<account>/credentials.json`,
  mirroring the Google layout. MSAL-Node manages the cache; broker
  persists the serialized blob.
- **Per-agent grant**: same two-key model as Google —
  `enabled_for[]` ACL (operator-set via `auth microsoft enable`) plus
  `agents.<name>.microsoft_workspace.account` YAML pin.
- **Writes**: approval-kernel cards mirror RFC E's pattern
  (wrapper-attested deep link + change preview), wrapping softeria's
  write tools via the same PreToolUse-hook approach.

## 2. Motivation — which JTBDs this serves

Across the 13 JTBDs in `reference/`, this lands on:

- **`reference/draft-and-edit.md`** — an exec assistant agent needs
  to read and edit Word docs / Excel sheets / PowerPoint decks that
  live in the operator's primary cloud surface. For half the world
  that's OneDrive, not Drive.
- **`reference/inbox-zero.md`** — Outlook/Exchange parity with Gmail.
- **`reference/scheduling.md`** — Outlook Calendar parity with
  Google Calendar.
- **`reference/specialist-team.md`** — different agents (a `finn`
  doing financial models in Excel vs a `clerk` drafting docs in
  Word) need to specialize on different Office surfaces.

The four switchroom vision outcomes:

| Outcome | How this RFC serves it |
|---|---|
| Standing team that knows you | M365 is the operator's other cloud — without it, the team is half-deaf to half their work surface |
| Hold the leash | Per-agent ACL + per-write approval cards (mirrors Google's posture) |
| Subscription-honest | No new Anthropic API calls; Microsoft auth is the operator's own credential, vaulted; agents still run unmodified `claude` on Pro/Max |
| Always available | Refresh tokens persist across restarts; no operator re-auth on every reboot |

## 3. MCP server choice

After evaluating three candidates (full research at
[Notable gotchas](#11-research-appendix)):

Evaluation criteria, in priority order: (1) auth model compatible
with switchroom's broker (refresh held by us, MCP gets short-lived
access tokens); (2) maintenance velocity (active commits, recent
releases); (3) tool coverage across mail/calendar/OneDrive/Office;
(4) license compatible with bundling.

| Server | Tools | Auth model | Verdict |
|---|---|---|---|
| `softeria/ms-365-mcp-server` | 200+ (mail/cal/OneDrive/Excel/Tasks/Planner; Teams+SharePoint behind `--org-mode`) | Device-code default; **BYOT** via `MS365_MCP_OAUTH_TOKEN` env | ✓ Primary |
| `Aanerud/MCP-Microsoft-Office` | 117 incl. Word/PPT authoring | OAuth PKCE + ROPC, own AES storage | ✗ Wrong shape for broker model |
| `elyxlz/microsoft-mcp` | Mail/Cal/OneDrive only | Device-code, file cache | ✗ Low maintenance, missing surfaces |

**Use softeria as the primary MCP**, pinned to a specific commit SHA
via `MS365_MCP_PINNED_REF` constant (same discipline as
`GOOGLE_WORKSPACE_MCP_PINNED_SHA`). BYOT means switchroom owns the
refresh loop and softeria stays stateless.

**Word/PowerPoint authoring uses the bundled official skills** (already
in `skills/docx`, `skills/xlsx`, `skills/pptx`). The agent flow:

1. Agent calls softeria's `download-bytes` to fetch a `.docx` from
   OneDrive to its workspace
2. Agent invokes the `docx` skill (or `xlsx`/`pptx`) to author the edit
   (proper file-format manipulation, tracked changes, etc.)
3. Agent calls softeria's `upload-file-content` (or
   `create-upload-session` for files >4 MB) to put the result back to
   OneDrive
4. The upload trips the **approval-kernel write card** (§8) before it
   lands

Why this beats building an in-house Word/PPT Graph MCP: Graph's
in-place edit surface for Word/PPT is poor (range insertions only,
no good "modify this paragraph" or "add this slide" primitives). The
official skills already do proper format-aware editing. We get better
fidelity by treating Office files as binary blobs on OneDrive and
letting the skill handle the actual editing.

**`--org-mode` flag** is off by default (personal MSA + standard
work-account surfaces only). Operator opts in per-deployment to
unlock Teams/SharePoint/admin tools. Cascade via
`microsoft_workspace.org_mode: true|false` in `switchroom.yaml`.

## 4. OAuth flow

### 4.1 App registration (operator one-time)

**Register a new Entra app for switchroom. Don't reuse an existing
one.** If the operator already has a Microsoft-integrated app
(personal calendar app, side project, anything), there are two
load-bearing reasons to register a new one rather than expand the
existing one:

1. **`signInAudience` is hard to change.** Existing apps are
   typically `AzureADMyOrg` (single-tenant) or
   `AzureADMultipleOrgs`. Switchroom needs
   `AzureADandPersonalMicrosoftAccount` to cover personal MSA +
   work in one app. The audience-flip is documented as
   re-registration-required on some surfaces, and once flipped you
   inherit MSA-specific limitations (no wildcard redirect URIs,
   reduced configuration freedom).
2. **Token version + audience drift.** `accessTokenAcceptedVersion`
   and the `aud` claim can mismatch between what an existing app's
   resources expect and what switchroom's broker expects. Adding
   resources to a long-lived app drags compatibility debt that's
   easy to avoid with a fresh app.

Weaker reasons people cite (and that won't actually bite):
incremental consent works, scope expansion is supported, redirect
URIs can be multi-platform on one app. So if the existing app
*already* has `AzureADandPersonalMicrosoftAccount` audience +
public-client flows enabled, sharing isn't catastrophic, just
cluttered. New app is still the cleaner default.

Operator runs `switchroom auth microsoft connect`, a wizard that:

1. Walks the operator through registering a new app in the **Entra
   admin center** (entra.microsoft.com → App registrations → New
   registration).
2. Required settings:
   - **Supported account types**: "Accounts in any organizational
     directory (any Microsoft Entra ID tenant, multitenant) **and**
     personal Microsoft accounts (e.g. Skype, Xbox)", manifest value
     `AzureADandPersonalMicrosoftAccount`.
   - **Redirect URI**: platform "Mobile and desktop applications" →
     `http://localhost`. (Microsoft ignores port for loopback URIs.)
   - **Platform configuration → Allow public client flows**: Yes.
3. Captures `application_id` + creates a client secret in
   "Certificates & secrets" → "New client secret" (or asks operator to
   skip secret for pure-PKCE, see §4.2).
4. Stores `microsoft-oauth-client-id` and (optional)
   `microsoft-oauth-client-secret` in vault.
5. Writes `microsoft_workspace:` block to `switchroom.yaml`:

```yaml
microsoft_workspace:
  microsoft_client_id: vault:microsoft-oauth-client-id
  microsoft_client_secret: vault:microsoft-oauth-client-secret  # optional
  authority: https://login.microsoftonline.com/common
  org_mode: false  # default; flip to true for Teams/SharePoint
```

### 4.2 Per-account auth (per Microsoft account)

Operator runs `switchroom auth microsoft account add [--label
personal|work|<name>]`. Two flows depending on host capability,
same tiering as Google's RFC D §3.2:

**Tier 1 — desktop loopback** (default when `$DISPLAY` is set or
`--loopback` forced):

1. Spawns a local HTTP server on an ephemeral port bound to `127.0.0.1`.
2. Constructs auth URL via MSAL-Node `getAuthCodeUrl({ scopes, state,
   codeChallenge })`: auth code + PKCE.
3. Opens browser to that URL.
4. Catches callback at `/auth/callback?code=...&state=...`, validates
   state, hands code to MSAL `acquireTokenByCode()`.

**Tier 2 — device-code flow** (default on headless SSH hosts, or
`--device-code` forced):

1. Calls MSAL-Node `acquireTokenByDeviceCode({ scopes, deviceCodeCallback })`.
2. Wizard prints: "Open https://microsoft.com/devicelogin and enter
   code: ABCD-1234 (expires in 15min)". Operator opens that URL on any
   device (phone, laptop, work computer) and pastes the code.
3. Wizard polls Microsoft's `/token` endpoint until the user completes
   auth on the other device, then receives the tokens.

Switchroom is regularly installed on headless VPSs (see
`reference_install_validation_loop`); device-code is the right
default for those hosts.

**Stale-doc trap worth pre-empting**: Microsoft's older device-code
page (`learn.microsoft.com/en-us/entra/identity-platform/scenario-desktop-acquire-token-device-code-flow`)
contains the line *"AADSTS90133: Device Code flow is not supported
under /common or /consumers endpoint"*. This is **outdated**: MSAL.NET
4.5+ release notes and the MSAL .NET device-code wiki confirm device-
code works on `/common` + `/consumers` for personal MSA, and every
community MS-MCP server I surveyed uses this path successfully. The
RFC's Tier 2 plan stands; the stale doc page just looks alarming.

Both flows converge after token acquisition:

5. Decodes `idTokenClaims.tid`:
   - `tid === "9188040d-6c67-4c5b-b112-36a304b66dad"` → **personal MSA**
   - else → **work/school** (records the tenant GUID for audit).
   Note: device-code flow does not return id_token unless `openid
   profile email` are in the scope set (they are, per §4.3); guard
   against missing id_token defensively by falling back to a
   `/me` Graph call to read `userPrincipalName`.
6. Resolves account email from `idTokenClaims.preferred_username` (or
   `email` fallback).
7. Persists MSAL's serialized token cache to
   `~/.switchroom/state/auth-broker/microsoft/<account>/cache.json`
   (mode 0600), plus a switchroom-shape `credentials.json` with:
   ```jsonc
   {
     "microsoftOauth": {
       "homeAccountId": "<oid>.<tid>",
       "tenantId": "<tid>",
       "accountType": "personal" | "work",
       "username": "...",          // preferred_username
       "scopes": ["..."],
       "issuedAt": 1234567890,
       "expiresAt": 1234567890,
       "clientId": "..."
     }
   }
   ```
   Refresh tokens live inside MSAL's serialized cache blob, never in
   the switchroom-shape JSON.
8. Broker confirms by minting an access token immediately and calling
   `GET /me` to display "Connected as <name> (<email>) — <personal|work>".

### 4.3 Scope set v1

Two scope sets, chosen at consent time based on account type and
`org_mode`. **Not "tiering"** (which would be per-agent and create
upgrade friction): this is per-account-at-consent, set once.

**Default v1 (personal MSA + work without `org_mode`):**

```
openid profile email offline_access
User.Read
Mail.ReadWrite
Calendars.ReadWrite
Files.ReadWrite.All
```

**With `microsoft_workspace.org_mode: true` (work account, opt-in
SharePoint surface):**

```
openid profile email offline_access
User.Read
Mail.ReadWrite
Calendars.ReadWrite
Files.ReadWrite.All
Sites.ReadWrite.All
```

Rationale for the split:

- `Sites.ReadWrite.All` grants read/write to **every SharePoint site
  the user can access**: in a large enterprise that's potentially
  thousands of sites holding HR/finance/legal docs. The defaults
  test (`reference/principles.md` §2) says the working default for
  a personal-use solo founder is not "agent has write access to my
  employer's entire SharePoint." Opt-in via `org_mode`.
- `Files.ReadWrite.All` is bounded to the user's OneDrive (personal
  or business), a narrow blast radius for the personal case, the right
  default. **Scope-narrowing option worth considering in PR 2 spike**:
  `Files.ReadWrite` (no `.All`) is also MSA-supported and covers
  "the signed-in user's files," which on a personal account IS the
  user's OneDrive. Dropping the `.All` suffix could lower blast
  radius further with no functional loss for personal-MSA. Verify
  via UAT that softeria's tools don't require the `.All` variant.
- `offline_access` — **mandatory** for long-lived refresh tokens.
  Without it, Microsoft issues access-token-only.
- `Mail.ReadWrite` (not `Mail.Send`) — agents draft mail; sending
  routes through approval-kernel for v1. `Mail.Send` defers to its
  own RFC (audit + revocation shape).

`org_mode` flips two things together: the SharePoint scope above
AND softeria's `--org-mode` flag (Teams/SharePoint tools). Single
knob, single mental model.

### 4.4 Personal MSA caveats (worth surfacing to operator)

- Admin-consent flows do not exist for personal MSA. Some Graph
  scopes that work for AAD are silently restricted (none we use,
  but worth doctor-probing).
- Unverified-app warning: until switchroom is publisher-verified
  (requires MPN account, $-cost), MSA users see a "Permissions
  requested, App info" page with an "unverified" badge. The wizard
  doc explicitly tells the operator: this is expected, accept it,
  this is your own app.

## 5. Refresh-token storage, rotation, revocation

### 5.1 Storage

Broker owns `~/.switchroom/state/auth-broker/microsoft/<account>/`:

- `cache.json` — MSAL-Node serialized `tokenCache.serialize()` blob.
  Contains AccessToken / RefreshToken / IdToken / Account /
  AppMetadata buckets. Refresh tokens are inside this blob.
- `credentials.json` — switchroom's flat metadata (per §4.2) for fast
  introspection without deserializing MSAL.

Mode 0600 on both files. Atomic writes (write-temp-then-rename).
Owner is the auth-broker UID.

**Only the broker holds the MSAL `PublicClientApplication` instance.**
Agents never instantiate MSAL directly. They IPC to the broker for
access tokens (mirrors Google's per-call `get_credentials` pattern).
This is load-bearing for cache integrity: two MSAL instances writing
the same `cache.json` would race on refresh-token rotation under
concurrent agent activity, and atomic-write only protects against
torn writes, not last-writer-wins clobber of a newer RT.

**No machine-encryption v1** (matches current Google posture, RFC G
§4.4 deferred broker-side vault encryption). Cache is filesystem-
permissioned. Defer to RFC G's eventual broker-encryption proposal
covering both providers uniformly.

### 5.2 Rotation

Microsoft refresh tokens **rotate every refresh** (every successful
`acquireTokenSilent` returns a new RT, invalidates the old). MSAL-Node
handles this transparently inside its cache. The broker's
`afterCacheAccess` callback writes the updated cache to disk after
each rotation.

**Critical invariant**: writes to `cache.json` MUST be atomic
(temp+rename). A torn cache write loses the new RT and we can't
recover without operator re-auth.

### 5.3 Refresh distribution to softeria (BYOT)

softeria has no in-server refresh. `MS365_MCP_OAUTH_TOKEN` is read
once at process spawn and softeria forwards it on every Graph call
until it 401s. Claude Code does **not** auto-respawn MCP servers on
tool errors; MCP children persist for the agent session lifetime
(hours, sometimes days). A 60-min token against a session that long
is total outage every hour. The original draft of this RFC tried to
defer the refresher to v2. That's wrong, the math is deterministic
and the v1 UX would be unusable.

**v1 ships a sidecar refresher.** The launcher (`m365-mcp-launcher`)
spawns two processes per agent:

1. **softeria child** with `MS365_MCP_OAUTH_TOKEN=<initial-at>` in env.
2. **Refresher sidecar** (Node, ~50 LoC) that:
   - Sleeps until `expiresAt - 5min` (≥55min lead time matches the
     RFC H broker refresh threshold)
   - Calls auth-broker `get_credentials({provider: "microsoft"})` to
     mint a fresh AT
   - Writes the new AT to a tmpfile + atomically renames it to a
     well-known path (e.g. `/tmp/m365-token-<agent>.json`)
   - Sends softeria child SIGHUP (which softeria docs as a
     refresh-trigger; verify in PR 1 spike; if not honored,
     restart-child semantics instead)
   - Loops

Why not just rely on broker-mediated per-call freshness like Google
does? Because softeria's BYOT contract is env-var-once-at-spawn,
not env-var-per-call. We can't change that without forking.

**Fork-or-contribute option (preferred but not v1)**: add
`--refresh-token-mode --single-user` to softeria upstream, matching
`taylorwilsdon/google_workspace_mcp`'s contract. Then refresh happens
in-process. Submit upstream PR after v1 ships; if accepted, retire
the sidecar in v1.5. Carry a fork only if upstream resists.

**Prior art for the refresh-token-in pattern**:
`jordanburke/microsoft-todo-mcp-server` implements it for the To-Do
scope set via `MS_TODO_ACCESS_TOKEN` + `MS_TODO_REFRESH_TOKEN` env
vars; the rotate-and-persist loop at `src/token-manager.ts:100-162`
is a clean reference for the upstream contribution. (Not drop-in
usable as-is because scope is hardcoded to To-Do and the client
shape requires a secret, but the auth-code path against
`/{tenant}/oauth2/v2.0/token` is the pattern softeria's contribution
should follow.) Validates that "refresh-token-in single-user" is
implementable; we're not inventing it, we're generalizing it.

**Sidecar lifecycle**: if softeria child dies, sidecar reaps and the
whole launcher exits → Claude Code respawns on next tool call. If
sidecar dies, softeria keeps running until its current token
expires, then 401s indefinitely → doctor probe catches it. Tests
must cover both crash directions.

### 5.4 Revocation

`switchroom auth microsoft account remove <account>`:

1. Calls Microsoft revocation endpoint
   (`https://login.microsoftonline.com/common/oauth2/v2.0/logout`)
   with the cached RT to invalidate the token on Microsoft's side.
2. Deletes `~/.switchroom/state/auth-broker/microsoft/<account>/`.
3. Prunes `microsoft_accounts.<account>` from `switchroom.yaml`.
4. Updates `microsoft_accounts.*.enabled_for[]` to remove orphan
   references.

`invalid_grant` from a stale RT (e.g. user revoked from Microsoft
account portal) surfaces the same way as Google's:
`microsoft:<account>:status` sidecar flips to `needs_reconnect`,
doctor probe surfaces it, agent gets a clear error when trying to
call any MS tool.

## 6. Per-agent grant surface

**Identical two-key model to Google.** No tiering v1 (product rationale
in §6.4).

### 6.1 ACL (operator-controlled)

```yaml
microsoft_accounts:
  bob@example.com:
    enabled_for: [clerk, finn, gymbro]
  ken@work.com:
    enabled_for: [clerk, lawgpt]
```

Verbs:
- `auth microsoft enable <account> <agent>...` — adds to ACL
- `auth microsoft disable <account> <agent>...` — removes; empty
  `enabled_for[]` leaves the account entry as **dormant** (matches
  current shipped Google behavior at `src/cli/auth-google.ts:405`).
  RFC G v3 proposed prune-on-empty but hasn't shipped. Microsoft
  follows shipped Google for *one mind built this* consistency
  (`reference/principles.md` §3). If Google ships the prune later,
  Microsoft follows in the same series.
- `auth microsoft list` — accounts × agents matrix

### 6.2 Per-agent account selector (YAML)

```yaml
agents:
  clerk:
    microsoft_workspace:
      account: bob@example.com
  lawgpt:
    microsoft_workspace:
      account: ken@work.com
```

Both keys are required. Mismatch (ACL says yes, no `account:` selected)
is silent until first MS tool call, where broker returns
`ACCOUNT_NOT_FOUND`. **`doctor` probe catches it at config time**: it
adds the `microsoft:agent-ACL-and-selector-aligned` check.

### 6.3 Cascade

`microsoft_workspace:` is a per-key merge block in the cascade (same
shape as `google_workspace:`):

| Key | Source of truth | Cascade mode |
|---|---|---|
| `microsoft_client_id` | top-level config | global only |
| `microsoft_client_secret` | top-level config | global only |
| `authority` | top-level config | global only (`common` recommended) |
| `org_mode` | top-level or per-agent | per-key override |
| `account` | per-agent only | per-agent (required if enabled) |
| `tools.include` / `tools.exclude` | per-agent | per-key merge |

### 6.4 Why no tiering v1 — product rationale

Google has `core / extended / complete` tiers. We chose **not to
mirror** because:

- Tiers exist because **scopes are fixed at consent**: upgrading
  means re-running the loopback flow. For personal use this friction
  is real but rare.
- Mapping to the four vision outcomes:
  - **Standing team that knows you**: right granularity is "is MS
    enabled for this agent at all", not "which slice", handled by
    `enabled_for[]`
  - **Hold the leash**: in personal use the leash you want is the
    per-write approval card (§8), not the scope set. There's no
    adversary inside your own team.
  - **Always available**: tiers actively harm. "Sorry, this agent
    doesn't have OneDrive write, please re-consent" mid-task is
    exactly the friction Outcome 4 forbids.
- The **defaults test** in `reference/principles.md`: a working
  default with zero config is preferable. Tier-knob without a real
  JTBD demanding it = premature complexity.

If a future use case (shared family deployment, enterprise pilot)
demands granularity, reintroduce tiers with the JTBD behind the
choice.

## 7. Authoring flow — skills + OneDrive

The dominant use case is "agent edits a Word doc / Excel sheet /
PowerPoint deck on OneDrive". Flow:

```
[Telegram DM: "update the Q3 strategy doc with the points from
yesterday's meeting"]
   ↓
[clerk searches OneDrive: mcp__ms365__search-files →
 finds "Q3-Strategy.docx" in /Documents/Strategy]
   ↓
[clerk downloads: mcp__ms365__download-bytes →
 writes /state/agent/workspace/Q3-Strategy.docx]
   ↓
[clerk invokes docx skill: "edit Q3-Strategy.docx, append section
 'Meeting notes 2026-05-27' with these bullets..."]
   ↓
[skill manipulates DOCX XML, writes back to /state/agent/workspace/Q3-Strategy.docx]
   ↓
[clerk uploads: mcp__ms365__upload-file-content ...
 → INTERCEPTED by PreToolUse hook
 → approval card posted:
   "📄 clerk wants to overwrite Q3-Strategy.docx
    📍 +1 section, +12 lines · -0 lines
    🔗 onedrive.live.com/...
    💬 'Adding the meeting notes from yesterday'
    [Approve] [Deny] [Open in OneDrive]"]
   ↓
[operator taps Approve → hook releases → upload completes]
   ↓
[clerk reports back: "Updated Q3-Strategy.docx with the meeting notes."]
```

**No new authoring code is needed in switchroom.** The skills already
ship in the skills pool, the agent invokes them via Claude Code's
native skill-invocation flow, and OneDrive is just a delivery mechanism.

## 8. Approval-kernel write cards

Mirror RFC E's PreToolUse-hook pattern (Path A Cut 2):

- Hook lives in scaffold at `.claude/hooks/microsoft-write-approval.mjs`
  (similar to the existing Google write-approval hook).
- Triggers on softeria's write tool names:
  - `upload-file-content`, `create-upload-session` (OneDrive writes)
  - `send-mail` (deferred; `Mail.Send` not in v1 scope)
  - `create-event`, `update-event`, `delete-event` (calendar writes)
  - `update-message`, `delete-message` (mail edits)
- Card metadata:
  - **Wrapper-attested (v1, weak)**: file path / item ID, byte
    delta (current vs proposed), deep link (constructed from Graph
    item `webUrl`), target account, MIME type, file size before/after
  - **Wrapper-attested (v1.5, structural diff)**: for `.docx` /
    `.xlsx` / `.pptx` uploads, the hook downloads the current
    OneDrive version, invokes the matching skill in diff-mode against
    the proposed upload, attaches a structural change summary
    (sections added/removed, sheets touched + cell-range count,
    slides added/removed/modified). The skills already know how to
    parse these formats; teaching them a `--diff` flag is small.
  - **Agent-supplied**: 1-line rationale (advisory, shown but
    distinct visual treatment per RFC E)
- Action buttons: `Approve` / `Deny` / `Open in OneDrive`
- Kernel returns `{decision: "block"}` to hook on Deny → softeria
  call short-circuits → agent sees clean error

**Honest scoping**: v1 ships the weak metadata (byte delta + size +
link + agent rationale). The operator must trust the agent's
rationale + click through to OneDrive to see the actual diff. v1.5
ships structural diff via skills `--diff` mode and brings attestation
to parity with Google's RFC E. Don't market v1 as full parity. It
isn't. UAT measures whether the weak-metadata UX is good enough in
practice for personal-use; if it isn't, v1.5 follows immediately.

**Reads are standing grants** (no per-call approval), same as Google.
The grant is implicit in `enabled_for[]`.

## 9. Doctor probes

Add to `switchroom doctor`:

- `microsoft:oauth-client-configured` — `microsoft_workspace` block
  present + vault refs resolvable
- `microsoft:account-credentials-readable` (per account) — broker can
  load cache.json + credentials.json
- `microsoft:refresh-token-valid` (per account) — broker can
  `acquireTokenSilent` without `invalid_grant`
- `microsoft:agent-ACL-and-selector-aligned` (per agent) — every
  agent with `microsoft_workspace.account` set has matching
  `enabled_for[]` entry
- `microsoft:scopes-cover-v1-set` (per account) — granted scopes
  include all v1 required scopes (catches post-scope-bump migration
  drift and accounts that were consented under an older scope set)
- `microsoft:personal-msa-graph-smoke` (per personal-MSA account) —
  broker can call `/me/drive/root/children` against an MSA token
  (some Graph endpoints silently no-op on consumer tokens; this
  smoke catches the class)
- `microsoft:sidecar-refresher-alive` (per agent with MS enabled) —
  refresher PID present + last-refresh timestamp within `expiresAt
  - 5min` window. If sidecar dies silently, this catches it before
  the next 401 storm reaches the operator.

## 10. Implementation plan

**5 PRs total**, sized to keep each reviewable. The original 3-PR
draft was 30-50% under realistic size. Google's `drive-mcp-launcher.ts`
is 919 LOC alone, `auth-google.ts` is 1,282 LOC. Sizing here is
calibrated against shipped equivalents.

### PR 1 — Provider + broker registration (~500 LOC)

- `src/auth/broker/microsoft-provider.ts` — `MicrosoftProvider`
  implementing `Provider` interface (refresh, extractExpiresAt,
  validateCredentialShape, name)
- `src/auth/broker/microsoft-storage.ts` — filesystem helpers
  (normalize, validate, paths, read/write/remove/list)
- `src/auth/broker/microsoft-msal-cache-plugin.ts` — ICachePlugin
  proxying MSAL cache to `cache.json` (atomic writes)
- Broker registers provider on boot
- `@azure/msal-node` added to `package.json`
- Tests: provider refresh against mocked `/token`; cache plugin
  round-trip; invalid_grant handling; atomic-write torn-write
  recovery

### PR 2 — CLI verbs + setup wizard + loopback/device-code handlers (~1,000 LOC)

- `src/cli/auth-microsoft.ts` — `connect / account add / account
  remove / account list / enable / disable / list` verbs
- Entra-portal walkthrough wizard for `connect`
- Loopback HTTP server with ephemeral-port + PKCE + state CSRF guard
- Device-code flow as headless tier (§4.2 Tier 2)
- Browser-launch detection + headless-fallback selection
- Account-type detection from `tid` claim
- Tests: CLI smoke; loopback handler; device-code mock flow;
  account-type detection; ACL CRUD

### PR 3 — Launcher + sidecar refresher + scaffold integration (~900 LOC)

- `src/cli/m365-mcp-launcher.ts` — resolve account → broker call →
  spawn softeria + sidecar refresher
- `src/cli/m365-token-refresher.ts` — sidecar process (§5.3),
  sleep-until-expiry / refresh / write-tmpfile / signal pattern
- `src/agents/scaffold.ts` — `.mcp.json` entry for `ms-365` MCP
  pointing at `m365-mcp-launcher`; per-agent `.mcp.json` env wiring
- `MS365_MCP_PINNED_REF` constant — softeria commit SHA pin
- Cascade integration: `microsoft_workspace:` block in
  `src/config/merge.ts`
- Tests: launcher seed-and-spawn; refresher sleep/wake cycle;
  child-crash and sidecar-crash handling; SIGHUP delivery

### PR 4 — Approval kernel hook + weak-metadata write cards (~500 LOC)

- `profiles/_shared/hooks/microsoft-write-approval.mjs.hbs` — hook
  template intercepting softeria write tools
- Hook → kernel IPC verb (extends existing approval card builders)
- Weak metadata only v1 (byte delta + size + link + rationale;
  §8 explicitly scopes this)
- Tests: hook intercept; card metadata extraction; deny → block
  short-circuit

### PR 5 — Doctor probes + user docs + UAT (~400 LOC)

- Doctor probes (§9), including the personal-MSA Graph smoke
- `docs/microsoft-workspace.md` — user-facing operator doc
  (mirrors `docs/google-workspace.md`)
- Entra app-registration walkthrough doc with screenshots
- UAT scenarios at `telegram-plugin/uat/scenarios/`:
  - `jtbd-onedrive-read-personal.test.ts`
  - `jtbd-onedrive-read-work.test.ts`
  - `jtbd-docx-edit-via-skill.test.ts`
  - `jtbd-onedrive-write-approval.test.ts`
  - `jtbd-token-refresh-survives-50min.test.ts`

### Follow-up (separate RFC or v1.5)

- Structural-diff write cards (skills `--diff` mode) — §8 v1.5
- `Mail.Send` scope + send-approval card — separate RFC
- Multi-account-per-agent — separate RFC
- softeria upstream `--refresh-token-mode` contribution

## 11. Effort estimate

Calibrated against Google's shipped equivalents (per RFC G §8 and
shipped LOC counts):

- **PR 1** — ~60 agent minutes (MSAL cache plugin is novel; rest
  mirrors `google-provider.ts` + `google-storage.ts`)
- **PR 2** — ~90 agent minutes (CLI surface + two loopback/device-code
  handlers; auth-google.ts is 1,282 LOC for reference)
- **PR 3** — ~70 agent minutes (sidecar refresher is the novel piece;
  launcher mirrors drive-mcp-launcher.ts at ~919 LOC)
- **PR 4** — ~40 agent minutes (hook is a clone of the Google hook
  with new tool-name filter)
- **PR 5** — ~40 agent minutes (probes + docs + 5 UAT scenarios)
- **Reviewer rounds** — assume ~30 min each PR

Total: **~300 agent minutes** end-to-end (~5 hours). Roughly double
the original 140-min estimate, sized honestly so review and UAT
have room.

## 12. Out of scope (v1)

- **Tiering** (core/extended/complete) — defer until a real JTBD
  demands it (§6.4)
- **`Mail.Send` scope** — drafts only v1; sending mail needs its own
  RFC for audit + revocation shape
- **Teams + admin/management surfaces** — `org_mode` gates SharePoint
  + Teams tools, but no automated probe/approval UX for admin verbs v1
- **Publisher verification** — accept "unverified app" warning v1;
  pursue MPN verification if/when switchroom goes commercial
- **Multi-account-per-agent** (one agent talking to ken@personal +
  ken@work simultaneously) — defer; same one-account-per-agent
  constraint as Google v1. **Note for the v1.5 multi-account
  spike**: softeria has an unresolved
  [issue #209](https://github.com/softeria/ms-365-mcp-server/issues/209)
  about admin-consent flow overwriting user tokens that suggests
  rough edges in its multi-account model. Read the issue before
  designing switchroom's multi-account-per-agent contract; may
  drive the upstream fork-or-contribute decision in §5.3.
- **softeria upstream `--refresh-token-mode` contribution** — v1
  ships our own sidecar refresher (§5.3); upstream contribution is
  v1.5 cleanup
- **Tenant-restricted enterprise tenants** — orgs that forbid
  multi-tenant app consent need their own single-tenant Entra app
  registration; doc this, defer auto-detection
- **Structural-diff approval cards** — v1 ships weak-metadata cards
  (§8); structural diff via skills `--diff` mode is v1.5
- **Operator-host MS-MCP** (`examples/personal-microsoft-workspace-mcp/`
  pattern mirroring RFC G §4.7) — defer until the agent-fleet
  integration ships and proves stable. The operator's own Claude Code
  session connecting to MS is a parallel feature, not a blocker, and
  shouldn't share PR scope with the fleet path.

## 13. Open questions / risks

1. **Publisher-verification warning UX** — when the operator first
   does `account add`, they hit Microsoft's "unverified app" page.
   Risk: operator misreads it as "switchroom is unsafe" and aborts.
   Mitigation: wizard prints a clear "this is YOUR app, you
   registered it, the warning is expected for personal apps" message
   before opening the browser.

2. **softeria upstream churn** — 228 releases in ~12 months. Pin to a
   specific SHA via `MS365_MCP_PINNED_REF`. Bump via dedicated PR
   with UAT (matches Google MCP pin discipline).

3. **MSAL cache corruption** — torn write of `cache.json` loses the
   refresh token and forces operator re-auth. Mitigation: atomic
   write + on-startup integrity check + `doctor` probe for
   parse-ability.

4. **MS Graph rate limits** — Microsoft Graph throttles aggressively
   (10000 req / 10min / app, but per-tenant much lower). softeria
   doesn't surface backoff hints clearly. Risk: aggressive agent
   doing bulk OneDrive listing trips a throttle. Mitigation: doctor
   probe + UAT measures sustained read rate; defer rate-limit hooks
   to v2 if it surfaces.

5. **Sidecar refresher reliability** — the §5.3 sidecar is the
   load-bearing piece that keeps softeria fed. Crash modes matter:
   if sidecar dies, softeria runs until token expires then 401s
   indefinitely. Mitigation: doctor probe checks both processes
   alive + sidecar's last-refresh timestamp; UAT scenario
   `jtbd-token-refresh-survives-50min` explicitly exercises the
   refresh boundary.

6. **`--org-mode` opt-in default** — should default `org_mode: true`
   for first-class M365 work-account support? Recommendation: keep
   `false` default (personal-use bias + narrower SharePoint blast
   radius per §4.3), document the flip for work-only deployments.

7. **Skills + workspace path collision** — the docx/xlsx/pptx skills
   write to the agent's CWD by default. Need to confirm the agent's
   workspace is writable + has enough space for typical Office files
   (up to 4MB inline, larger via chunked upload). Verify in UAT.

8. **Weak attestation v1** (§8) — operator must trust the agent's
   1-line rationale for the first iteration of write cards. If the
   agent fabricates an innocuous-sounding rationale for a destructive
   edit, the operator has no wrapper-attested counter-signal until
   v1.5 ships structural diff. UAT measures whether this is felt as
   a real gap or acceptable for personal-use.

## 14. Research appendix

Material consulted during this RFC:

- `softeria/ms-365-mcp-server` README + `src/endpoints.json`
- MSAL-Node docs: `caching.md`, `msal-node-migration`,
  `scenario-desktop-acquire-token-interactive`
- MS Learn: `reply-url`, `id-tokens`, `publisher-verification-overview`
- Family-calendar app (calendar-app/): Microsoft auth precedent
  (raw-fetch, common-tenant, encrypted token storage in Postgres)
- Existing switchroom RFCs: gdrive-mcp.md, google-workspace-
  generalization.md, doc-connection-completion.md, auth-broker.md
- Existing switchroom code: `src/auth/broker/google-provider.ts`,
  `src/auth/broker/google-storage.ts`, `src/cli/auth-google.ts`,
  `src/cli/drive-mcp-launcher.ts`

Detailed findings in conversation thread; lifted into this RFC's
relevant sections.
