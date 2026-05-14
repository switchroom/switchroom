# RFC G: Google Workspace as a first-class agent capability

Status: Draft v3
Author: Ken (with Claude pair-design)
Date: 2026-05-14

**v3 changes** (aligning with RFC H — `auth-broker.md` / PR #1254):

RFC H (the canonical Anthropic-auth refactor) replaced the per-agent
slot-pool model that v2 mirrored. Google Workspace now aligns with
RFC H rather than the deleted `auth account ...` shape:

- **CLI shape collapses to `enable | disable | list`** (Phase 3a's
  shipped surface). Drop `share`, drop `connect <agent>` wizard alias
  — RFC H deleted the equivalent Anthropic verbs (no `auth share`,
  no `auth login`). Account *creation* moves to `auth google account
  add <email>`, which becomes a thin client over the auth-broker
  (Phase 3b). See §4.5.
- **Drop the "dormant ACL" semantic** (`enabled_for: []` left in
  YAML) per RFC H §10 decision: loud removal beats polite mirror.
  `auth google disable` now prunes the entry; full teardown via
  `auth google account remove`. See §4.5 + §4.4.
- **OAuth refresh moves into the auth-broker** as a provider plugin
  (Phase 3b). **Honest framing:** RFC H ships a single-provider
  broker (Anthropic only). `auth.consumers[]` per RFC H §4.8 is
  for *non-agent peers needing an Anthropic-account socket*
  (hindsight is the in-tree consumer), NOT for non-Anthropic OAuth
  providers. Phase 3b.1 introduces a provider abstraction RFC H
  deliberately deferred — this is a real architectural addition,
  not a config-flag wiring exercise. The motivation stands:
  rebuilding a parallel refresher in `src/drive/` would duplicate
  flock leases, sha-index drift detection, and audit log machinery
  the broker already implements. The vault-broker stays as the
  durable token-storage layer; auth-broker grows a provider
  abstraction so it becomes the single OAuth refresher for both
  Anthropic AND Google. See §4.4 + §7 Phase 3b.
- **MCP wrapper credential-read pivots to `auth-broker.get-credentials
  { provider: "google" }`** over UDS, mirroring the same path-as-
  identity pattern Anthropic uses post-RFC-H. Replaces direct
  vault-broker reads. See §7 Phase 3b.
- **Apply-time legacy-slot detection becomes a hard refusal** with
  a `migrate-google-slots.ts` one-shot rewrite, mirroring RFC H
  §6's `migrate-schema.ts` pattern. See §7 Phase 3b.

**Earlier change history**:

v2 (addressing PR #1240 review): CLI moved from invented `workspace` verb (collided with existing top-level verb) to `auth google ...`; Phase 2 migration changed to clean cutover; §5 acknowledged multi-account-per-agent as #1 follow-up.

v1: initial draft.

Prerequisites:
- **RFC B — Approval kernel** — landed v0.6.0 (#762).
- **RFC D — Google Drive MCP integration** — landed v0.6.0 (#763, #766, #767, #768). This RFC generalizes RFC D from "Drive only" to "the whole upstream Workspace surface."
- **RFC E — Drive collab loop** — primitives merged (#1227, #1249, #1250, #1251, #1252). Orthogonal: RFC E covers the *interaction* shape (folder picker, suggesting writes, anchors); this RFC covers *which surfaces* are available and *how operators enable them*.
- **RFC H — `switchroom-auth-broker`** — PR #1254. Phase 3b of this RFC plugs Google into the broker as a provider; Phase 1 / 2 / 3a / 4 / 5 are independent of RFC H and have already merged.

This spec generalizes RFC D's Drive-only integration into the full
Google Workspace surface and routes OAuth tokens through the
**auth-broker** (RFC H) with **per-Google-account vault slots
gated by per-agent ACL**. The vault-broker remains the durable
storage layer; auth-broker owns the refresh loop.

## 0. Goal

A switchroom operator opts an agent into Google Workspace **once per
Google account**, picks the tool surface (tier + optional
include/exclude), and any other agent in the fleet can be enabled on
the same account without re-consenting. Each agent's access remains
gated by the approval kernel under its own identity.

## 1. Outcome

End-to-end flow from the operator's terminal:

```
$ switchroom auth google account add pixsoul@gmail.com
🔐 Adding Google account pixsoul@gmail.com
   On any device with a browser, visit:
       https://www.google.com/device
   And enter this code: WDJB-MJHT
   ...
   ✅ Account pixsoul@gmail.com added to vault.
   Enable on agents: switchroom auth google enable pixsoul@gmail.com <agents...>

$ switchroom auth google enable pixsoul@gmail.com klanker gymbro
   ✅ klanker, gymbro now have access via pixsoul@gmail.com.
   No re-consent needed — both agents share the account's refresh token.

$ switchroom auth google list
ACCOUNT                AGENTS                TIER    LAST USED
pixsoul@gmail.com      klanker, gymbro       core    2 min ago
work@bigcorp.com       coderev               extended  yesterday

$ switchroom auth google share pixsoul@gmail.com --from-agent klanker --to-agent executive
   ✅ executive now has access via pixsoul@gmail.com (copied from klanker).
```

(The shape mirrors `switchroom auth account add | enable | share | list | account remove` for Anthropic accounts. Google is the second vendor under `auth`; future vendors — Notion, Slack — follow the same `auth <vendor> ...` pattern.)

End-to-end flow from a Telegram thread (uses RFC E §4.3 deep links + RFC D headless OAuth):

```
User → klanker:  "Pull the Q3 doc from /Work and add a hiring section."
klanker:         🔐 needs Drive access via pixsoul@gmail.com
                 [ ✅ Allow this folder ]  [ 🚫 Deny ]
User:            [taps Allow]
klanker:         ...proceeds via approval kernel + RFC E suggesting writes
```

What's different from today (RFC D shipped state):

- Two agents on one Google account = **one OAuth dance**, not two.
- Calendar, Sheets, Slides become available as agent-callable tools
  alongside Drive + Docs.
- Operator picks the tier (`core` / `extended` / `complete`) per agent
  rather than getting a hardcoded Drive surface.
- Agent identity stays separate at the approval layer — `klanker`
  reading `/Q3 Strategy` is a different approval row than `gymbro`
  reading the same doc, even though they share the OAuth token.

## 2. Vision alignment

Maps to three of the four outcomes in `reference/vision.md`:

- **Multi-agent fleet (#2)** — Each specialist gets the surface its
  role calls for: `coderev` gets Drive + Sheets, `coach` gets Drive +
  Calendar, `executive` gets the lot. The fleet feels like specialists,
  not one cookie-cutter agent with all-or-nothing Workspace.
- **Subscription-honest (#3)** — Per-user OAuth, refresh tokens in
  vault, no service accounts. Same posture as RFC D §4. The user pays
  Google once, switchroom routes it to consumers.
- **Always-on (#4)** — Refresh tokens survive reboots. Per-account
  storage means a single broker keeps one token fresh, not N.

Visibility (#1) is served by the existing approval kernel (RFC B) +
RFC E's diff-preview surface — no new work for that outcome here.

## 3. JTBD alignment

- **`share-auth-across-the-fleet.md`** — *literally* the same JTBD,
  applied to Google instead of Anthropic. *"Log into Google once per
  account, not once per agent."* The "Signs it's working" checklist in
  that JTBD doc translates one-for-one: enabling a second agent
  requires no OAuth flow; `workspace list` answers "which agents use
  which account" on one screen; sub-agents inherit; tokens survive
  idle gaps; removal is one explicit action; no orphans.
- **`extend-without-forking.md`** — Adding Workspace to an agent is a
  config edit + a CLI verb. New tools added by upstream (`extended` /
  `complete` tiers) are a config-knob change, not a code patch.
- **`talk-to-agents-from-anywhere.md`** — Headless OAuth tier from RFC
  D §3.2 already covers SSH installs. `switchroom auth google account
  add` composes that with the new flow; `auth google connect <agent>`
  does the wizard combo for first-run.
- **`know-what-my-agent-is-doing.md`** — Each agent's tool calls
  remain separately approval-gated and audited (`approval_audit.action`
  records `read | suggest | write`); shared OAuth doesn't blur the
  visibility of *which agent did what*.

## 4. Scope — seven pieces

### 4.1 `google_workspace:` config block (with `drive:` alias)

The shipped `drive:` block (RFC D #768) gets generalized:

```yaml
# switchroom.yaml
google_workspace:
  # default for every agent unless overridden
  tier: core              # core | extended | complete
  default_account: pixsoul@gmail.com

agents:
  klanker:
    google_workspace:
      account: pixsoul@gmail.com
      tier: core           # 16 tools: Drive + Docs + Sheets + Calendar
  gymbro:
    google_workspace:
      account: pixsoul@gmail.com
      tier: core
      exclude: [calendar]   # 13 tools — gymbro doesn't need Calendar
  executive:
    google_workspace:
      account: work@bigcorp.com
      tier: extended         # 40 tools — adds Slides, Forms, Tasks, Chat
```

Back-compat: existing `drive:` blocks parse identically to
`google_workspace: { tier: core, exclude: [calendar, sheets] }`. The
loader emits a one-line deprecation note in `switchroom apply`.

Cascade: standard per-key merge. `default_account` cascades; `tier`,
`include`, `exclude` cascade. Documented in `docs/configuration.md`.

### 4.2 Tier knob — `core` / `extended` / `complete`

Maps directly to the upstream MCP's `--tool-tier` flag.

- `core` (default, ~16 tools): Drive + Docs + Sheets + Calendar.
  Validated in our own pair-design setup; this is the default for any
  agent newly connected.
- `extended` (~40 tools): adds Slides, Forms, Tasks, Chat.
- `complete` (~60+ tools): adds Gmail (which has its own approval-
  shape considerations — see §5 out of scope).

Tier is per-agent, not per-account. Two agents on the same account
can have different tiers — each runs its own MCP wrapper subprocess
inside its own container, configured with its tier. The OAuth token
is shared; the **MCP server process is not** (preserving RFC D's
per-agent subprocess model and its security properties).

### 4.3 `tools:` include/exclude override

For when the tier is mostly right but one tool is unwanted (e.g.
*"I want core minus Calendar"*) or wanted (*"I want core plus
Slides without going up to extended"*).

```yaml
agents:
  klanker:
    google_workspace:
      tier: core
      exclude: [calendar]      # remove from tier
      include: [slides_create] # add specific tool from a higher tier
```

Exclude wins over include on conflict. Switchroom validates at
`apply` time that included tools exist in the upstream MCP's
manifest; unknown tool names fail fast with the suggestion list.

### 4.4 Per-account vault slot + per-agent ACL via auth-broker (the load-bearing piece)

**Two brokers, one OAuth refresh implementation, per RFC H §4.4 + §4.7:**

- **vault-broker** (existing) — durable storage. Refresh tokens land
  at `vault:google:<account>:refresh_token`. The vault file is the
  single source of truth at rest.
- **auth-broker** (RFC H) — sole OAuth refresher and credentials
  writer. As shipped by RFC H, supports Anthropic only.
  Phase 3b.1 of *this* RFC adds the provider abstraction the
  broker needs to host Google as a second provider — RFC H
  deliberately scoped the broker to Anthropic-only ("speaks OAuth
  and only OAuth" per RFC H §3); the multi-provider extension
  is RFC G's contribution, not RFC H's. Once 3b.1 lands the
  broker reads refresh tokens from vault-broker for both providers,
  runs per-provider refresh ticks, exposes short-lived access
  tokens to consumers via UDS.

**Vault slot key shape** (Phase 2, already merged):

```
# Per-Google-account, NOT per-agent:
google:<account_email>:refresh_token
google:<account_email>:refresh_token:status        # invalid-grant signaling
google:<account_email>:scopes                      # cached scope set
```

**Per-agent ACL** (Phase 2, already merged) — top-level config block
gates which agents can read which account's token:

```yaml
google_accounts:
  pixsoul@gmail.com:
    enabled_for: [klanker, gymbro]
  work@bigcorp.com:
    enabled_for: [executive]
```

The vault-broker's `checkAclByAgent()` routes `google:<acct>:*` keys
through `google_accounts.<acct>.enabled_for[]` instead of the
per-cron `schedule.secrets[]` allowlist. Fail-closed on unknown
account, empty `enabled_for`, or agent-not-in-list. This is the
load-bearing security boundary — without the ACL, any agent could
read any Google account's token from vault.

**Drift handling — loud removal, not polite mirror** (v3 change per
RFC H §10): when an agent is removed from `enabled_for`, the YAML
entry's `enabled_for` shrinks; if it becomes empty, the entry is
**pruned entirely** by `auth google disable`. There is no "dormant
account" intermediate state. Operator wanting a fully-clean teardown
runs `auth google account remove <account>`, which calls broker
`remove-account` (deletes vault slot + revokes Google OAuth +
removes refresh lease). Standing approval-kernel grants under the
removed agent's identity get a `not_authorized` from the broker on
next use, with the same operator-actionable message pointing at
`auth google enable` to restore.

**MCP wrapper credential read — via auth-broker, not vault-broker**
(v3 change, Phase 3b): the per-agent MCP subprocess inside an
agent container reads its OAuth credentials via the auth-broker's
`get-credentials` UDS verb, mirroring how Anthropic creds are
retrieved post-RFC-H. Wrapper startup:

1. Read `google_workspace.account` from agent config.
2. Connect to per-agent auth-broker socket
   (`/run/switchroom/auth-broker/<agent>/sock`).
3. Call `getCredentials({ provider: "google" })`.
4. Auth-broker validates path-as-identity (agent name from socket
   path) against `google_accounts.<acct>.enabled_for[]` for the
   account named in the agent's config.
5. Returns short-lived access token + expiry. Wrapper hands
   to the upstream MCP, no token persistence inside the wrapper.

Refresh ticks happen entirely inside auth-broker per RFC H §4.7's
flock-protected lease primitive — wrapper never re-fetches refresh
tokens from vault, never owns the refresh loop. Identical pattern
to Anthropic; no Google-specific refresh code in `src/drive/`.

### 4.5 CLI surface — `switchroom auth google ...`

**Naming:** the new verbs live under `auth google ...`, sibling to
`auth ...` (the post-RFC-H Anthropic surface). Google is the second
auth vendor; future vendors (Notion, Slack) follow the same `auth
<vendor> ...` pattern. `switchroom workspace` already exists as a
top-level verb (manages AGENTS.md/MEMORY.md scaffold files) — using
it for Google would silently break operators.

**Important divergence from Anthropic post-RFC-H** — Google and
Anthropic have *different* problems, so the verb shapes are allowed
to differ:

- Anthropic auth = **quota routing** ("which account is the
  fleet-wide active one to spend against; per-agent overrides for
  edge cases"). RFC H §4.6 surface: `auth use`, `auth agent
  override`, `auth rotate`. Single primary, override exceptions.
- Google auth = **per-account access ACL** ("which agents can read
  this account's Drive token"). RFC G surface: `auth google
  enable / disable`. Multi-account, multi-agent matrix.

The JTBD `share-auth-across-the-fleet.md` originally specified the
slot-pool / `enable`-style shape; RFC H changed Anthropic to fit
its quota-routing problem better. Google keeps the enable/disable
shape because the *problem* hasn't changed.

**Verb shape — Phase 3a shipped surface:**

```
# Agent-to-account ACL (Phase 3a — already merged)
switchroom auth google enable <account> <agents...>    # plural agents
switchroom auth google disable <account> <agents...>   # plural — prunes when last agent removed
switchroom auth google list                            # accounts × agents matrix (--json for scripting)
```

**Verb shape — Phase 3b adds (post-#1254):**

```
# Account lifecycle (thin clients over auth-broker per Phase 3b)
switchroom auth google account add <account>           # OAuth flow, lands token in vault, registers
                                                        # refresh lease with auth-broker. No --enable-on
                                                        # flag — operator runs `enable` next, same
                                                        # account-creation-is-separate pattern as
                                                        # RFC H `auth add`.
switchroom auth google account remove <account>        # OAuth revoke + delete vault slot + remove
                                                        # broker refresh lease + prune google_accounts
                                                        # entry. Refused while any agent is enabled.
switchroom auth google account list                    # bare accounts (no agent matrix)
```

**Verbs explicitly NOT shipped (v3 cut):**

- `auth google share` — RFC H deleted `auth share`; Google follows.
  Use `enable <account> <agents...>` directly.
- `auth google connect <agent>` — RFC H deleted `auth login <agent>`;
  Google follows. Setup wizard (§4.6) uses the explicit `account
  add` + `enable` two-step instead.

**`account add` flow** uses RFC D's three-tier OAuth auto-select
(device-code → OOB-paste → desktop-loopback). On a host with no
`$DISPLAY`, the device-code flow is used by default; explicit
`--headless` forces it. The OAuth flow itself moves into
`src/auth/broker/google-provider.ts` (Phase 3b — see §7) — the CLI
verb is a thin client.

**`account remove` refuses** while any agent is still enabled on
that account, per the JTBD's "no orphaned tokens left behind"
check.

**`enable` / `disable` are plural** — `enable pixsoul@gmail.com
klanker gymbro coderev` is one call writing one ACL update + one
audit row, not three.

**`disable` prunes when `enabled_for` empties** (v3 change per RFC
H §10): no "dormant ACL" intermediate state. If the operator wants
the account to stay configured but have no agents, they can leave
`enabled_for: []` in YAML by hand — the CLI doesn't write that
shape.

### 4.6 Setup wizard inline prompt

`switchroom setup`, after the first agent is created and bot is
working, adds:

```
─────────────────────────────────
Optional: Connect Google Workspace
─────────────────────────────────
Your agent (klanker) can read and (with approval) write to your
Google Drive, Docs, Sheets, and Calendar. Tools appear as
approval-gated requests in Telegram.

Connect now? [Y/n] _
```

Default Y. Phase 4 (already merged) prints the next-step command
and continues — does NOT run OAuth inline (would break the linear
wizard, same reason RFC H §4.6 doesn't auto-add an account).

**Phase 4 (today)** surfaces the legacy command for back-compat:
`switchroom drive connect klanker` (the v0.6.0 verb, still works).

**Phase 3b (post-RFC-H landing)** swaps the surfaced command to the
two-step form:

```
switchroom auth google account add <your-email>
switchroom auth google enable <your-email> klanker
```

Mirrors RFC H §4.6's `auth add default --from-oauth` + `auth use
default` two-step. Account-creation and agent-enablement are
deliberately separate verbs; the wizard surfaces both lines but
runs neither inline.

Survives the docs test (no docs reading needed) and the defaults
test (no config-by-default for users who aren't using Workspace —
opt-in but advertised).

### 4.7 `examples/personal-google-workspace-mcp/` for operator-host use

The docker-compose pattern we built for our own Claude Code session
becomes a documented example shipped in the repo:

```
examples/
  personal-google-workspace-mcp/
    README.md          # the GCP Console + .mcp.json setup walkthrough
    compose.yaml       # the working compose with volumes + healthcheck
    .env.example       # OAuth client ID + signing-key placeholder
```

**Distinct from the agent-side feature** above — the README opens
with: *"This is for **operators** who want their **own** Claude Code
on the host to have Workspace tools (alongside or instead of giving
agents access). It does not affect switchroom agents — they get
Workspace via `switchroom auth google account add` + `enable` (RFC G §4.5)."*

Today `examples/` contains only top-level YAMLs (`minimal.yaml`,
`switchroom.yaml`); RFC G establishes the `examples/<artifact>/`
subdirectory pattern. Future operator-host integrations (Notion,
Slack, etc.) follow the same shape under `examples/personal-*-mcp/`.

## 5. Out of scope

- **Multi-Google-account-per-agent** — each agent connects to one
  account at a time. If an agent needs both `pixsoul@gmail.com` and
  `work@bigcorp.com`, that's a future spec. Ad-hoc workaround:
  spin up a second agent on the second account. **This is
  acknowledged as the most likely follow-up RFC** — operators who
  run a personal+work life from one assistant agent will hit it
  fast. The fix probably looks like a list-valued `accounts:` config
  block + a runtime account-picker on tool invocation. Out of scope
  here only because the per-account ACL primitive in §4.4 is
  prerequisite plumbing for it.
- **Service-account auth** — same reason as RFC D §12: collapses
  approval semantics.
- **Gmail as a first-class collaboration surface** — Gmail's
  approval shape is per-thread, not per-doc; even at `complete`
  tier the Gmail tools are exposed but with a coarse "read all
  email" or "send all email" approval, which is wrong. A proper
  Gmail RFC handles per-thread / per-label / per-sender approvals
  separately.
- **Cross-tenant / Workspace admin features** — switchroom is
  single-operator (vision.md). Workspace admin tooling for
  managing multiple users in one Google Workspace tenant is out
  of scope and likely always will be.
- **Notion / Slack** — RFC F covers second-surface. This spec
  generalizes *within* Google Workspace, not *across* doc surfaces.
- **Selective scope downgrade after consent** — once OAuth scopes
  are granted, switchroom doesn't try to re-prompt the user to
  reduce them. Operator runs `account remove` + `account add` to
  re-do.
- **Per-tier billing / quota tracking** — Google Workspace is
  flat-rate per account, not per-tool; nothing to track.

## 6. Principle checks

Per `reference/principles.md`:

### 6.1 Docs test — *"Can someone use this without opening `docs/`?"*

- ✅ `switchroom auth google account add pixsoul@gmail.com` prints
  the OAuth URL inline + says "tap to consent." No prerequisite
  reading. Wizard alias `auth google connect klanker` works the
  same way for the first-run path.
- ✅ Setup wizard prompt explains *what* and *why* in two
  sentences ("read and (with approval) write to your Drive, Docs,
  Sheets, Calendar — tools appear as approval-gated requests").
- ✅ `workspace list` is self-documenting — accounts × agents
  matrix tells the user the state.
- ✅ Drift error (agent removed from ACL) tells the user the next
  command.

### 6.2 Defaults test — *"Does it work on a fresh `switchroom setup`?"*

- ✅ Tier defaults to `core` — the validated 16-tool surface.
- ✅ Setup wizard offers Workspace by default (Y), so a fresh
  install gets it without config-file editing.
- ✅ Per-account storage is the default once enabled — no operator
  has to opt into "share auth across the fleet"; that's just how it
  works.
- ✅ Per-agent approval default is per-action (RFC B / RFC E
  posture preserved).

### 6.3 Consistency test — *"Does this feel like one product?"*

- ✅ `switchroom auth google account add|remove|list` + `auth
  google enable|disable|list` is a per-vendor namespace under
  `auth`; sibling to RFC H's `auth add|use|rotate|rm` for
  Anthropic. Different verb shapes are honest because the
  problems differ (Anthropic = quota routing, Google = per-
  account access ACL — see §4.5 divergence note).
- ✅ `vault:google:<acct>:*` matches the `vault:<surface>:*` slot
  pattern.
- ✅ Auth-broker is the single OAuth refresher per host (RFC H §4.7)
  — Google plugs in via the provider abstraction (Phase 3b), not
  a parallel refresher.
- ✅ `apv:` callback shape unchanged; new tools added to existing
  approval kernel.
- ✅ `/approvals list|revoke|add|stats` surface unchanged — adding
  Calendar/Sheets/Slides scopes adds rows, not commands.
- ✅ Cascade rules for `google_workspace:` block follow standard
  per-key merge (`src/config/merge.ts`), documented same way as
  every other config field.
- ✅ Setup wizard prompt is in the same style as the bot-token and
  first-agent prompts — opinionated default, easy decline.
- ✅ "Loud removal beats polite mirror" applied to ACL pruning per
  RFC H §10's decision against dormant intermediate states.

## 7. Migration / rollout

**Status:** Phases 1, 2, 3a, 4, 5 have **already merged** to main
(PRs #1244, #1246, #1247, #1248, #1245). The implementation work
remaining is **Phase 3b**, which depends on RFC H (PR #1254) being
merged first.

### Already shipped

1. **Phase 1 — Config block + tier knob (no breaking changes)** —
   merged #1244. `google_workspace:` block + `drive:` alias + tier
   enum. Backwards-compatible.
2. **Phase 2 — Per-account vault slot + per-agent ACL primitive** —
   merged #1246. New helpers in `src/drive/vault-slots.ts`, ACL
   routing in `src/vault/broker/acl.ts`, top-level `google_accounts:`
   schema. **Currently inert** — no code consumes it yet (Phase 3b
   wires the wrapper read).
3. **Phase 3a — `auth google enable | disable | list` CLI verbs** —
   merged #1247. Operators can populate `google_accounts.enabled_for[]`.
4. **Phase 4 — Setup wizard Step 11** — merged #1248. Prompt only;
   surfaces the connect command.
5. **Phase 5 — `examples/personal-google-workspace-mcp/`** —
   merged #1245. Operator-host docker-compose pattern, fully usable.

### Phase 3b — auth-broker integration (post-RFC-H, post-#1254)

Five sub-phases, each shippable as its own PR. Total ~3.5h agent
time. **Prerequisite: RFC H (PR #1254) merged to main.**

#### 3b.1 — Provider abstraction in auth-broker (~90-120 min)

This is real architectural work, not a config-flag wiring exercise.
Scope:

- New `src/auth/broker/provider.ts` defining the provider interface:
  token endpoint, refresh-request shape, scope set, scope-to-grant
  mapping, error mapping (provider-specific OAuth error codes →
  broker's `invalid_grant` / `network` / `quota_exceeded`).
- Provider plugin loading at broker startup (mirrors how the
  vault-broker loads ACL config) — providers ship as files under
  `src/auth/broker/<vendor>-provider.ts`.
- Per-provider refresh tick — RFC H's existing flock-protected
  lease primitive needs to key on `(provider, account)`, not just
  `account`, since two accounts named the same string under
  different providers must be independent.
- Per-provider scope-set storage — Anthropic's scopes are
  one-fixed-set; Google's are tier-driven and expand on re-OAuth.
  Storage shape needs to handle both.
- `provider:` field on every relevant verb (`add-account`,
  `remove-account`, `get-credentials`, `list-state`,
  `mark-exhausted`). Defaults to `"anthropic"` (back-compat with
  RFC H Phase 1). Accepts `"google"`.
- Test surface: every existing broker test that exercises the
  verbs needs a Google variant; new tests for provider isolation
  (account `"x@y.z"` in Anthropic provider does NOT collide with
  account `"x@y.z"` in Google provider).

**Load-bearing for everything that follows.** Without this, 3b.2
through 3b.5 cannot be cleanly built.

#### 3b.2 — Google provider implementation (~90 min)

Extract OAuth flow from `src/cli/drive.ts:runConnect` (lines
259-620 in v0.6.0, ~360 LOC) into
`src/auth/broker/google-provider.ts`. Implements the provider
interface from 3b.1:

- Device-code, OOB-paste, desktop-loopback tier-selection
  (preserves RFC D §3 semantics).
- Refresh-token exchange against Google OAuth endpoint.
- Scope-set-validation against Workspace tier per RFC G Phase 1.
- Google-specific error mapping (Google returns `invalid_grant`
  for scope-revocation AND for password-change AND for
  app-revocation; broker error contract needs to surface these
  distinctly so 3b.4 can drive the right user message).
- Test surface: replay-style tests against captured Google OAuth
  responses for each error class.

#### 3b.3 — `auth google account add | remove` CLI (~30 min)

Thin clients in `src/cli/auth-google.ts` (extending the Phase 3a
file). `add` calls `auth-broker.add-account { provider: "google",
account: <email>, oauth-result: <tokens> }`; `remove` calls
`auth-broker.remove-account { provider: "google", account: <email> }`
which revokes Google OAuth, deletes the vault slot, removes the
broker refresh lease, and prunes `google_accounts.<email>` from
YAML.

#### 3b.4 — MCP wrapper credential-read pivot (~30 min)

`src/drive/wrapper.ts` calls `auth-broker.get-credentials {
provider: "google" }` over the per-agent UDS instead of reading
`vault:google:<email>:refresh_token` directly via vault-broker.
Identity is path-as-identity (agent name from socket path); broker
validates `agent ∈ google_accounts.<acct>.enabled_for[]`.

After 3b.4 lands, the agent containers ARE actually using
per-account shared tokens with per-agent ACL — the load-bearing
RFC G goal.

#### 3b.5 — Apply-time legacy-slot migration (~60 min)

`switchroom apply` detects legacy `gdrive:<agent>:refresh_token`
slots in vault and **hard-refuses** to proceed, printing the
operator-actionable next step. New `src/auth/migrate-google-slots.ts`
(mirroring RFC H §6's `src/auth/migrate-schema.ts`) provides a
one-shot rewrite the operator runs explicitly: reads each legacy
per-agent slot, prompts "which Google account does this token
belong to?" (operators of v0.6.0 had per-agent tokens that may or
may not represent the same Google account), writes the per-account
slot + populates `google_accounts.<account>.enabled_for[]`, deletes
the legacy slot.

Mirrors RFC H §6 ("rewrite once, refuse second run") rather than
the v2 "warn and continue" design — RFC H showed loud-fail is the
honest default for installed-base migrations.

#### 3b.6 — Setup wizard pivot to two-step `account add` + `enable` (~10 min)

The shipped Phase 4 (`src/cli/setup.ts:1112-1200`) explicitly
anticipates `auth google connect <agent>` as a future surfaced
command — but v3 §4.5 deletes that verb. Phase 3b.6 rewrites the
`connectCmd` constant + the surrounding comment block in
`stepGoogleWorkspace` to surface the two-step shape per §4.6:

```
switchroom auth google account add <your-email>
switchroom auth google enable <your-email> <agent>
```

Small, isolated, can ship alongside 3b.3 if convenient.

### Phase 3b sequencing

3b.1 → 3b.2 → 3b.3 → 3b.4 → 3b.5 (with 3b.6 piggybacking on 3b.3).
Each PR independently reviewable; each builds on the prior. No
interleave shortcuts because the broker provider abstraction
(3b.1) is genuinely prerequisite to everything else.

## 8. Effort estimate

Per CLAUDE.md, in **agent minutes**.

### Already shipped

| Phase | Item | Actual | PR |
|---|---|---|---|
| 1 | Config block + tier knob + 75 tests | ~45 min | #1244 |
| 2 | ACL primitive + per-account vault helpers + 41 tests | ~60 min | #1246 |
| 3a | `auth google enable / disable / list` + 22 YAML mutator tests | ~60 min | #1247 |
| 4 | Setup wizard Step 11 | ~30 min | #1248 |
| 5 | Examples dir + README | ~30 min | #1245 |

**~3.75h agent time spent.** Estimates held within ±15%.

### Remaining (Phase 3b, post-RFC-H)

| Sub-phase | Item | Estimate |
|---|---|---|
| 3b.1 | Provider abstraction in auth-broker (interface + plugin loading + per-(provider,account) refresh leases + verb extension + isolation tests) | ~90-120 min |
| 3b.2 | Google provider implementation (extract OAuth from drive.ts:runConnect, ~360 LOC + Google-specific error mapping + replay tests) | ~90 min |
| 3b.3 | `auth google account add / remove` CLI (thin clients over broker) | ~30 min |
| 3b.4 | MCP wrapper credential-read pivot (vault-broker → auth-broker UDS) | ~30 min |
| 3b.5 | Apply-time legacy-slot migration tool + hard-refusal (interactive prompts for account-attribution per legacy slot) | ~60 min |
| 3b.6 | Setup wizard pivot to two-step `account add` + `enable` (rewrite connectCmd in setup.ts) | ~10 min |
| — | Doc updates (`docs/google-workspace.md` new file, RFC cross-refs) | ~30 min |

**~5.75-6.5h agent time** for Phase 3b. Total RFC G end-to-end:
~9.5-10.25h. (v3-initial estimate of ~4.25h was too aggressive
per reviewer — provider abstraction is real architectural work,
not a config-flag wiring exercise.)

## 9. Risks and open questions

- **Re-consent silently expands scope across all enabled agents.**
  If `klanker` is enabled at `tier: core` (Drive+Docs+Sheets+Cal)
  and the operator later runs `account remove` + `account add` to
  re-consent for `gymbro` at `tier: extended` (adds Slides), the
  shared refresh token now grants Slides scope to **klanker too**
  — even though klanker's operator never approved that. The kernel
  still gates writes per-agent (Slides write requires a fresh
  approval card), but reads of newly-scoped surfaces are not
  gated. Mitigation: re-consent triggered by tier-bump posts a
  "scope expanded" notice via Telegram to **every enabled agent's
  approver**, naming the new scope and the agent that triggered
  it. Operator can `disable` proactively if the expansion is
  unwanted.

- **Approval kernel drift on agent removal.** `disable <account>
  <agents...>` orphans the agents' standing approvals — they get
  `not_authorized` from the broker on next use. Mitigation: the
  approval-kernel surfaces a single chat nudge identifying the
  removed-agent + grant + the `auth google enable` command to
  restore. No "dormant grants pile up" risk because v3 prunes the
  YAML entry rather than mirror the dormant state.

- **Legacy-slot migration (Phase 3b.5) on the v0.6.0 → post-RFC-H
  transition.** A v0.6.0 operator who hand-ran `switchroom drive
  connect` for multiple agents on the same Google account ends up
  with N copies of the same refresh token in N per-agent slots.
  The migration tool needs to ask the operator "which Google
  account does each per-agent slot belong to?" — there's no
  programmatic way to know (the slot key is per-agent, not
  per-account). Mitigation: migration tool prompts interactively
  AND surfaces the legacy slot's cached scope set + last-refresh
  timestamp in the prompt — these are the only on-disk hints
  for identifying which Google account is which. Falls back to
  "skip and re-OAuth" if operator can't remember.

- **Inheritance of RFC H known-blocker class.** PR #1254 (RFC H)
  was reviewed with three blockers, including: *"`auth use` does
  not persist `auth.active` to YAML — the broker mutates
  in-memory only, so on any restart it re-reads YAML and the
  swap reverts."* Phase 3b.3 (`auth google account add / remove`)
  writes `google_accounts:` to YAML and expects the broker to
  pick up the new account. If RFC H ships with the YAML-persist
  bug unfixed, Phase 3b.3 inherits the same SIGHUP/reload
  assumption. Mitigation: **Phase 3b.3 blocks on the
  CLI-writes-YAML-first contract being enforced in #1254**.
  Confirm before starting 3b.3 that `auth use` (and any
  comparable verb) writes YAML before notifying the broker, then
  mirror the same pattern in `auth google account add / remove`.

- **Tier change after connect.** Going from `core` to `extended`
  doesn't expand granted OAuth scopes — Google's consent already
  completed. The new tier's tools that need broader scopes will
  fail at runtime. Mitigation: `apply` checks each agent's tier
  against the cached `google:<acct>:scopes` slot; warns operator
  inline if the upgrade requires re-consent: *"klanker's tier
  bumped to extended — needs Slides scope. Run `auth google
  account remove pixsoul@gmail.com` + `account add` to re-consent,
  or exclude Slides tools."*

- **Setup wizard prompt fatigue.** If we add too many "optional
  but recommended" prompts during setup, the user starts skipping
  by reflex. Workspace prompt sits after bot-token + first-agent
  + (potentially) Hindsight memory; that's already three Y/n
  prompts. Mitigation: order matters — Workspace prompt comes
  *last* in the optional-features sequence, after the user has
  seen the agent respond once. Fewer dropouts at the end.

- **Per-account ACL config drift across operators.** If an
  operator manually edits `~/.switchroom/google_accounts.yaml`
  (or wherever ACL lives) outside the CLI, the broker's view and
  the CLI's view of "who's enabled" can diverge. Mitigation: ACL
  state is a derived view, not source-of-truth — `auth google
  list` reads the broker, `enable/disable` writes through the
  broker.
  No manual edit path documented; the file (if any) is internal.

## 10. Tracking

### Shipped

- [x] Phase 1 — Config block + tier knob + `drive:` alias — #1244
- [x] Phase 2 — Per-account vault slot + per-agent ACL primitive — #1246
- [x] Phase 3a — `auth google enable / disable / list` CLI — #1247
- [x] Phase 4 — Setup wizard Step 11 — #1248
- [x] Phase 5 — `examples/personal-google-workspace-mcp/` — #1245

### Pending Phase 3b (post-RFC-H / #1254 merge)

- [ ] Phase 3b.1 — Provider abstraction in auth-broker
- [ ] Phase 3b.2 — Google provider implementation
- [ ] Phase 3b.3 — `auth google account add / remove` CLI (blocks
      on RFC H's CLI-writes-YAML-first contract — see §9)
- [ ] Phase 3b.4 — MCP wrapper credential-read pivot to auth-broker UDS
- [ ] Phase 3b.5 — Apply-time legacy-slot migration tool + hard-refusal
- [ ] Phase 3b.6 — Setup wizard pivot in `setup.ts:stepGoogleWorkspace`
- [ ] Cross-cutting — `docs/google-workspace.md` user guide

### Pairs with

- **RFC E (Drive collab loop)** — primitives merged: anchors (#1250),
  diff-preview (#1252), deep-links (#1251), recovery detector (#1249).
  Followups land the gateway/kernel wiring for those primitives.
- **RFC H (`switchroom-auth-broker`)** — PR #1254. Phase 3b of
  this RFC is a downstream consumer of RFC H's broker.
- **RFC F** (deferred, not yet opened) — second doc surface
  (Notion candidate). RFC G's per-account ACL pattern becomes
  the template when Notion lands a `notion:<workspace>:*` slot.
