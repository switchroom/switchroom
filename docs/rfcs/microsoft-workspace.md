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
  Word/PPT MCP shim needed — the skills know the file formats
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
   — proper file-format manipulation, tracked changes, etc.
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

Operator runs `switchroom auth microsoft connect` — a wizard that:

1. Walks the operator through registering a new app in the **Entra
   admin center** (entra.microsoft.com → App registrations → New
   registration).
2. Required settings:
   - **Supported account types**: "Accounts in any organizational
     directory (any Microsoft Entra ID tenant — multitenant) **and**
     personal Microsoft accounts (e.g. Skype, Xbox)" — manifest value
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
personal|work|<name>]`. Flow:

1. Spawns a local HTTP server on an ephemeral port bound to `127.0.0.1`.
2. Constructs auth URL via MSAL-Node `getAuthCodeUrl({ scopes, state,
   codeChallenge })` — auth code + PKCE.
3. Opens browser (or prints URL for headless / SSH hosts — same
   fallback shape as Google's loopback).
4. Catches callback at `/auth/callback?code=...&state=...`, validates
   state, hands code to MSAL `acquireTokenByCode()`.
5. Decodes `idTokenClaims.tid`:
   - `tid === "9188040d-6c67-4c5b-b112-36a304b66dad"` → **personal MSA**
   - else → **work/school** (records the tenant GUID for audit)
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

Single fixed set (no tiering — see §6 product rationale):

```
openid profile email offline_access
User.Read
Mail.ReadWrite
Calendars.ReadWrite
Files.ReadWrite.All
Sites.ReadWrite.All
```

- `offline_access` — **mandatory** for long-lived refresh tokens.
  Without it, Microsoft issues access-token-only.
- `Files.ReadWrite.All` + `Sites.ReadWrite.All` — covers OneDrive
  personal + OneDrive for Business + SharePoint document libraries
  (where M365 work files often live).
- `Mail.ReadWrite` (not `Mail.Send`) — agents draft mail; sending
  routes through approval-kernel for v1.
- No `Mail.Send` v1 — sending mail is the kind of action that
  warrants an explicit second-RFC discussion of audit + revocation
  shape.

### 4.4 Personal MSA caveats (worth surfacing to operator)

- Admin-consent flows do not exist for personal MSA. Some Graph
  scopes that work for AAD are silently restricted (none we use,
  but worth doctor-probing).
- Unverified-app warning: until switchroom is publisher-verified
  (requires MPN account, $-cost), MSA users see a "Permissions
  requested — App info" page with an "unverified" badge. The wizard
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

**No machine-encryption v1** (matches current Google posture — RFC G
§4.4 deferred broker-side vault encryption). Cache is filesystem-
permissioned. Defer to RFC G's eventual broker-encryption proposal
covering both providers uniformly.

### 5.2 Rotation

Microsoft refresh tokens **rotate every refresh** (every successful
`acquireTokenSilent` returns a new RT, invalidates the old). MSAL-Node
handles this transparently inside its cache — the broker's
`afterCacheAccess` callback writes the updated cache to disk after
each rotation.

**Critical invariant**: writes to `cache.json` MUST be atomic
(temp+rename). A torn cache write loses the new RT and we can't
recover without operator re-auth.

### 5.3 Refresh distribution to softeria (BYOT)

softeria has no in-server refresh. Two design points:

**At launcher spawn** (every MCP spawn):
1. Launcher calls auth-broker `get_credentials({provider:
   "microsoft"})` → broker calls MSAL `acquireTokenSilent` → returns
   fresh AT with ≥55-min validity → launcher writes
   `MS365_MCP_OAUTH_TOKEN=<at>` into spawned env.

**Mid-session expiry** (sessions longer than ~50 min):
- v1: accept that softeria 401s and rely on Claude Code's
  MCP-respawn behavior to pick up a fresh token. UAT will measure
  how disruptive this is in practice.
- v2 (defer if v1 noisy): launcher spawns a sidecar refresher that
  rotates the env / signals softeria via SIGHUP. Or contribute
  `--single-user --refresh-token-mode` upstream to softeria (mirrors
  google_workspace_mcp's contract).

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
  ken@outlook.com:
    enabled_for: [clerk, finn, gymbro]
  ken@work.com:
    enabled_for: [clerk, lawgpt]
```

Verbs:
- `auth microsoft enable <account> <agent>...` — adds to ACL
- `auth microsoft disable <account> <agent>...` — removes; empty
  `enabled_for[]` prunes the account entry entirely (loud-removal
  per RFC H retrospective)
- `auth microsoft list` — accounts × agents matrix

### 6.2 Per-agent account selector (YAML)

```yaml
agents:
  clerk:
    microsoft_workspace:
      account: ken@outlook.com
  lawgpt:
    microsoft_workspace:
      account: ken@work.com
```

Both keys are required. Mismatch (ACL says yes, no `account:` selected)
is silent until first MS tool call, where broker returns
`ACCOUNT_NOT_FOUND`. **`doctor` probe catches it at config time** —
adds `microsoft:agent-ACL-and-selector-aligned` check.

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

- Tiers exist because **scopes are fixed at consent** — upgrading
  means re-running the loopback flow. For personal use this friction
  is real but rare.
- Mapping to the four vision outcomes:
  - **Standing team that knows you**: right granularity is "is MS
    enabled for this agent at all", not "which slice" — handled by
    `enabled_for[]`
  - **Hold the leash**: in personal use the leash you want is the
    per-write approval card (§8), not the scope set. There's no
    adversary inside your own team.
  - **Always available**: tiers actively harm — "sorry, this agent
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
 writes /workspace/Q3-Strategy.docx]
   ↓
[clerk invokes docx skill: "edit Q3-Strategy.docx, append section
 'Meeting notes 2026-05-27' with these bullets..."]
   ↓
[skill manipulates DOCX XML, writes back to /workspace/Q3-Strategy.docx]
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

**No new authoring code is needed in switchroom** — the skills already
ship in the skills pool, the agent invokes them via Claude Code's
native skill-invocation flow, OneDrive is just a delivery mechanism.

## 8. Approval-kernel write cards

Mirror RFC E's PreToolUse-hook pattern (Path A Cut 2):

- Hook lives in scaffold at `.claude/hooks/microsoft-write-approval.mjs`
  (similar to the existing Google write-approval hook).
- Triggers on softeria's write tool names:
  - `upload-file-content`, `create-upload-session` (OneDrive writes)
  - `send-mail` (deferred — `Mail.Send` not in v1 scope)
  - `create-event`, `update-event`, `delete-event` (calendar writes)
  - `update-message`, `delete-message` (mail edits)
- Card metadata:
  - **Wrapper-attested**: file path / item ID, byte delta or change
    count, deep link (constructed from Graph item `webUrl`),
    target account
  - **Agent-supplied**: 1-line rationale (advisory, shown but
    distinct visual treatment per RFC E)
- Action buttons: `Approve` / `Deny` / `Open in OneDrive`
- Kernel returns `{decision: "block"}` to hook on Deny → softeria
  call short-circuits → agent sees clean error

**Reads are standing grants** (no per-call approval) — same as Google.
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
- `microsoft:scopes-match-tier` (per account) — granted scopes
  include all v1 required scopes (covers post-scope-bump migration)

## 10. Implementation plan

**3 PRs total**, sized to keep each reviewable:

### PR 1 — Auth scaffolding (~600 LOC)

- `src/auth/broker/microsoft-provider.ts` — `MicrosoftProvider`
  implementing `Provider` interface (refresh, extractExpiresAt,
  validateCredentialShape, name)
- `src/auth/broker/microsoft-storage.ts` — filesystem helpers
  (normalize, validate, paths, read/write/remove/list)
- `src/auth/broker/microsoft-msal-cache-plugin.ts` — ICachePlugin
  that proxies MSAL cache to `cache.json`
- Broker registers provider on boot
- Add `@azure/msal-node` to `package.json`
- Tests: provider refresh against mocked Microsoft `/token` endpoint;
  cache plugin round-trip; invalid_grant handling

### PR 2 — CLI verbs + setup wizard + launcher (~800 LOC)

- `src/cli/auth-microsoft.ts` — `connect / account add / account
  remove / account list / enable / disable / list` verbs
- `src/cli/m365-mcp-launcher.ts` — mirrors `drive-mcp-launcher.ts`:
  resolve account → broker call → spawn softeria with
  `MS365_MCP_OAUTH_TOKEN`
- `src/agents/scaffold.ts` — `.mcp.json` entry for `ms-365` MCP
  pointing at `m365-mcp-launcher`
- `MS365_MCP_PINNED_REF` constant — softeria commit SHA pin
- Loopback HTTP server with ephemeral-port + PKCE + state CSRF guard
- Browser-launch + headless-fallback (paste URL, paste code)
- Tests: CLI smoke; launcher seed-and-spawn; loopback handler;
  account-type detection from `tid`

### PR 3 — Approval kernel hook + doctor + docs (~500 LOC)

- `profiles/_shared/hooks/microsoft-write-approval.mjs.hbs` — hook
  template
- Hook → kernel IPC verb (extends existing approval card builders)
- Doctor probes (§9)
- `docs/microsoft-workspace.md` — user-facing operator doc
  (mirrors `docs/google-workspace.md`)
- Entra app-registration walkthrough doc with screenshots
- UAT scenarios at `telegram-plugin/uat/scenarios/`:
  - `jtbd-onedrive-read-personal.test.ts`
  - `jtbd-onedrive-read-work.test.ts`
  - `jtbd-docx-edit-via-skill.test.ts`
  - `jtbd-onedrive-write-approval.test.ts`

## 11. Effort

- **PR 1** — ~40 agent minutes (auth lib integration is the heaviest
  piece; MSAL-Node has good docs)
- **PR 2** — ~50 agent minutes (loopback handler is the only novel
  piece; rest is mirroring auth-google.ts)
- **PR 3** — ~30 agent minutes (hook is straight clone of Google
  hook with new tool-name filter)
- **+ UAT + docs** — ~20 agent minutes

Total: **~140 agent minutes** end-to-end, plus reviewer rounds.

## 12. Out of scope (v1)

- **Tiering** (core/extended/complete) — defer until a real JTBD
  demands it
- **`Mail.Send` scope** — drafts only v1; sending mail needs its own
  RFC for audit + revocation shape
- **Teams + SharePoint admin surfaces** (`--org-mode`) — operator
  can flip the flag manually, but no automated probe/approval UX v1
- **Publisher verification** — accept "unverified app" warning v1;
  pursue MPN verification if/when switchroom goes commercial
- **Multi-account-per-agent** (one agent talking to ken@personal +
  ken@work simultaneously) — defer; same one-account-per-agent
  constraint as Google v1
- **Forking softeria for refresh-mode** — if 401-storm noise is
  measurable in UAT, ship as PR 4 or contribute upstream
- **Tenant-restricted enterprise tenants** — orgs that forbid
  multi-tenant app consent need their own single-tenant Entra app
  registration; doc this, defer auto-detection

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

4. **`tid` ambiguity in Storm-0558-era tokens** — extremely rare
   edge case where personal-MSA `tid` shows up on a work token.
   Mitigation: log `iss` alongside `tid`; surface conflict in
   `account list` if detected.

5. **MS Graph rate limits** — Microsoft Graph throttles aggressively
   (10000 req / 10min / app, but per-tenant much lower). softeria
   doesn't surface backoff hints clearly. Risk: aggressive agent
   doing bulk OneDrive listing trips a throttle. Mitigation: doctor
   probe + UAT measures sustained read rate; defer rate-limit hooks
   to v2 if it surfaces.

6. **`--org-mode` opt-in default** — should default `org_mode: true`
   for first-class M365 work-account support? Recommendation: keep
   `false` default (personal-use bias), document the flip for
   work-only deployments.

7. **Skills + workspace path collision** — the docx/xlsx/pptx skills
   write to the agent's CWD by default. Need to confirm the agent's
   workspace is writable + has enough space for typical Office files.
   Verify in UAT.

## 14. Research appendix

Material consulted during this RFC:

- `softeria/ms-365-mcp-server` README + `src/endpoints.json`
- MSAL-Node docs: `caching.md`, `msal-node-migration`,
  `scenario-desktop-acquire-token-interactive`
- MS Learn: `reply-url`, `id-tokens`, `publisher-verification-overview`
- Family-calendar app (calendar-app/) — Microsoft auth precedent
  (raw-fetch, common-tenant, encrypted token storage in Postgres)
- Existing switchroom RFCs: gdrive-mcp.md, google-workspace-
  generalization.md, doc-connection-completion.md, auth-broker.md
- Existing switchroom code: `src/auth/broker/google-provider.ts`,
  `src/auth/broker/google-storage.ts`, `src/cli/auth-google.ts`,
  `src/cli/drive-mcp-launcher.ts`

Detailed findings in conversation thread; lifted into this RFC's
relevant sections.
