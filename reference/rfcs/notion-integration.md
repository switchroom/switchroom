---
artifact: Notion integration
serves: act-in-my-tools-with-an-identity
advances-outcome: always-available
status: Draft
---

# RFC: Notion integration

**Status:** Draft
**Owner:** Ken Thompson
**Date:** 2026-05-27
**Related:** [microsoft-workspace.md](./microsoft-workspace.md), [gdrive-mcp.md](./gdrive-mcp.md), [google-workspace-generalization.md](./google-workspace-generalization.md), [auth-broker.md](./auth-broker.md)

## 1. Summary

Add a Notion provider to switchroom that lets one or more agents read
and write Notion pages and databases under a single operator-owned
**internal integration**, with per-agent allowlists at the database
level.

- **Upstream MCP**: `@notionhq/notion-mcp-server` (TypeScript, MIT,
  Notion-maintained). Stdio, integration-token via `NOTION_TOKEN` env.
- **Auth shape**: Notion **internal integration token** — long-lived
  bearer credential, no OAuth refresh loop. Operator creates the
  integration in Notion's settings, copies the token, stores it in the
  vault. Workspace owner picks which pages/DBs the integration can see
  by sharing them with it in Notion's UI.
- **Token storage**: vault key `notion/integration-token`. The
  vault-broker mints short-lived per-agent grants the same way it does
  for any other vault secret. There is **no auth-broker MSAL
  equivalent**: Notion tokens don't rotate.
- **Per-agent grant**: two-key model that *parallels* m365/gdrive but
  isn't identical because Notion has no per-account concept (one
  integration = one workspace). The two keys are: (1) operator-set
  ACL on the vault grant (which agents can fetch the token),
  (2) per-agent `notion_workspace.databases[]` YAML allowlist.
- **Top-level config key**: `notion_workspace:` (mirrors
  `google_workspace:` and `microsoft_workspace:`, consistency over
  novelty; no nested `integrations.*` namespace v1).
- **Friendly names**: operator-level config maps `essays → <uuid>`
  once; per-agent grants reference the friendly name. Agents never
  type or memorize Notion UUIDs.
- **Writes**: approval-kernel cards wrap notion's write tools via a
  PreToolUse hook (`telegram-plugin/gateway/notion-write-approval.ts`),
  mirroring `drive-write-pretool.mjs` and `ms365-write-approval.ts`.
- **Rate limiting**: **launcher-side token bucket at 3 rps v1** —
  diverges from m365/gdrive (which both punt on this). The math
  doesn't work for Notion's tighter limit once write-tool DB
  resolution (§8) and search post-filter (§8.5) are honest about
  their API-call cost. See §7.

This RFC explicitly *diverges* from the original task brief on two
points (§13.1): it drops the per-agent `scopes: [read, write]`
field in favour of consistency with m365's "no scope tiering v1"
call (§6.4), and re-frames the per-agent grant under
`notion_workspace` rather than `integrations.notion`. Rate limiting
is **shipped** in v1 (the brief's third question, but as a *yes*
rather than the deferral the first draft proposed).

## 2. Motivation — which JTBDs this serves

Across the 13 JTBDs in `reference/`, this lands on:

- **`reference/draft-and-edit.md`** — an exec-assistant agent (clerk)
  needs to read and edit prose that lives in the operator's Notion
  workspace alongside Office/Drive docs.
- **`reference/research-and-summarize.md`** — Notion is the operator's
  knowledge base; agents pulling from it for summary / synthesis are
  the dominant Notion use case.
- **`reference/specialist-team.md`** — different agents (`clerk`
  general writing, `carrie` essays-only) need *different* slices of
  the same Notion workspace. The DB allowlist is the load-bearing
  primitive that makes specialization safe.

The four switchroom vision outcomes:

| Outcome | How this RFC serves it |
|---|---|
| Standing team that knows you | Notion is the operator's *third* cloud surface (alongside Google + M365); without it the team is blind to the operator's knowledge base |
| Hold the leash | Per-agent DB allowlist + per-write approval cards; defence-in-depth on top of Notion's own integration-grant model |
| Subscription-honest | No new Anthropic API calls; Notion token is operator-owned, vaulted; agents still run unmodified `claude` on Pro/Max |
| Always available | Integration tokens are long-lived; no refresh-token expiry; no operator re-auth on reboot |

## 3. MCP server choice

| Server | Tools | Transport | Auth model | Verdict |
|---|---|---|---|---|
| `@notionhq/notion-mcp-server` (official) | search, query DB, get/create/update pages, comments, users | stdio | `NOTION_TOKEN` env (integration token) | ✓ Primary |
| `notion.com/mcp` (official hosted HTTP MCP) | same surface | HTTP | OAuth user-auth via authorize redirect | ✗ Wrong shape — per-user OAuth doesn't fit operator-vaulted model |
| `makenotion/notion-mcp-server` (legacy) | older subset | stdio | `NOTION_API_KEY` env | ✗ Superseded by the `@notionhq/` package |
| `notionhq/client` (raw SDK) | full REST | n/a | bearer header | ✗ Not an MCP; would require us to author the tools |

**Use `@notionhq/notion-mcp-server` as the primary MCP**, pinned by
exact npm version via a `NOTION_MCP_PINNED_VERSION` constant in
`src/memory/scaffold-integration.ts` (same discipline as
`MICROSOFT_WORKSPACE_MCP_PINNED_VERSION` and
`GOOGLE_WORKSPACE_MCP_PINNED_SHA`).

The launcher (`src/cli/notion-mcp-launcher.ts`) is responsible for:

1. Fetching `notion/integration-token` from the vault-broker.
2. Setting `NOTION_TOKEN=<token>` in the child's env.
3. Spawning `npx -y @notionhq/notion-mcp-server@<pinned-version>` and
   bridging stdio.
4. Heartbeat file at `/tmp/notion-launcher-<agent>.heartbeat.json` for
   the doctor probe (mirrors m365's pattern, PR #1888).

Unlike m365, the launcher does **not** run a refresh loop. There is
no token expiry. The launcher process is single-purpose: vault fetch
→ env inject → exec MCP.

## 4. Auth flow

### 4.1 Integration registration (operator one-time)

The operator creates an internal integration in Notion's settings:

1. Settings → **Connections** → **Develop or manage integrations** →
   **New integration**.
2. Name: `switchroom` (or whatever the operator wants, visible only
   to the workspace owner).
3. Type: **Internal**. Associated workspace: the operator's primary
   workspace.
4. Capabilities, recommended starting set:
   - Read content
   - Update content
   - Insert content
   - Read comments / Insert comments
   - Read user information (no email)
5. Copy the **Internal Integration Secret** (starts with `secret_...`
   or `ntn_...`).
6. Run on host: `switchroom vault set notion/integration-token`,
   paste, choose which agents may read it via `--allow clerk,carrie`
   (comma-separated list).

After registration, the operator goes back to each Notion page /
database they want any switchroom agent to touch and **shares it with
the `switchroom` integration** (top-right ⋯ → Connections → add
`switchroom`). This is Notion's *upstream* ACL: the integration
literally cannot see pages that weren't shared with it, regardless of
what switchroom config says.

**Bootstrap order, this matters**:

1. Create integration (step 1–4 above).
2. Vault put the token (step 6).
3. Share DBs/pages with the integration in Notion's UI.
4. Run `switchroom notion list-dbs` to print a ready-to-paste
   YAML block of `friendly-name → uuid` mappings (PR 4). This needs
   steps 2 + 3 done first: the CLI fetches the integration's
   visible-DB list from Notion's API.
5. Paste that block into `switchroom.yaml` under `notion_workspace:
   databases:`, edit friendly names as desired.
6. Add `notion_workspace: {}` (or a `databases: [...]` filter) to
   each agent that should get Notion access.
7. `switchroom apply`: config validation cross-checks DB
   references, vault ACL alignment (§6.3), and writes the scaffold.

If the operator skips step 4 they'll be left typing UUIDs by hand.
The CLI verb in PR 4 exists specifically to make this painless.

### 4.2 Switchroom-side ACL (defence in depth)

Notion's upstream share-list is the *outer* boundary: anything not
shared with the integration is unreachable. Switchroom's per-agent
`databases: [essays, tasks]` allowlist is the *inner* boundary,
enforced at PreToolUse-hook time: even though the integration token
could technically reach `private-journal`, the hook rejects the tool
call if the resolved DB UUID isn't in the agent's allowlist.

Both boundaries matter:
- The upstream share-list is **what the operator manages via Notion's
  UI**, natural place for "this DB is brand new, hasn't been wired
  to anything yet".
- The switchroom allowlist is **what the operator manages via
  `switchroom.yaml`**, natural place for "this agent's role is
  narrower than the integration".

### 4.3 No OAuth, no refresh

Notion supports an OAuth-public-integration flow for vendors building
multi-tenant apps. Switchroom is single-operator-per-deployment; the
internal-integration model is materially simpler and the right
default. Public OAuth is out of scope for v1, flagged in §12.

## 5. Token storage, rotation, revocation

### 5.1 Storage

- Vault key: `notion/integration-token` (plural-namespace contract:
  `<provider>/<artifact>`).
- ACL: operator sets `--allow <agents>` (comma-separated) at `vault set` time.
  The broker enforces this on every grant request; agents not in the
  ACL get `E_BROKER_GRANT_DENIED`.
- The launcher fetches via `vault_request_access` → ephemeral token →
  child env var. The token never lands on disk inside the agent
  container.

### 5.2 Rotation

Manual, operator-initiated, infrequent (token doesn't rotate on its
own):

1. Notion Settings → Integrations → `switchroom` → **Refresh secret**.
2. Copy new secret.
3. `switchroom vault set notion/integration-token` (overwrite).
   Re-state `--allow` to preserve the existing allowlist, since `vault set`
   replaces the entire scope.
4. Agents pick up the new token on their next vault grant — for the
   notion launcher specifically that means **launcher restart**.
   `switchroom agent restart <name> --graceful-restart` is sufficient
   (no image change needed).

### 5.3 Revocation

Two paths:

- **Per-agent**: drop the agent from the broker ACL by re-running
  `switchroom vault set notion/integration-token --allow <remaining-list>`
  with the agent omitted (`vault set` overwrites the scope). Next
  launcher fetch fails closed.
- **Full revocation**: Notion Settings → Integrations → `switchroom`
  → **Delete integration**. Every agent's launcher fails the next
  time it tries to fetch tools; the integration is gone upstream.

## 6. Per-agent grant surface

### 6.1 Operator config (`switchroom.yaml` top-level)

```yaml
notion_workspace:
  # vault key holding the integration secret
  vault_key: notion/integration-token        # default; override only for non-standard layouts

  # friendly-name → Notion-DB-UUID map. Source of truth for all
  # agents. Agents NEVER type or memorize UUIDs.
  databases:
    essays:   a1b2c3d4-e5f6-7890-1234-567890abcdef
    tasks:    b2c3d4e5-f6f7-8901-2345-67890abcdef0
    notes:    c3d4e5f6-0708-1234-5678-90abcdef0123

  # OPTIONAL — pin a non-default upstream MCP version.
  # Default is the pinned NOTION_MCP_PINNED_VERSION constant.
  # mcp_version: 0.5.2

  # OPTIONAL — override the global token-bucket rate. Default 3 rps
  # (Notion's documented limit). Lower it if you also use the same
  # integration token from outside switchroom and need to share budget.
  # rate_limit_rps: 3
```

The top-level key is `notion_workspace:`, parallel to
`google_workspace:` and `microsoft_workspace:`. No nested
`integrations.*` namespace, consistency test wins over taxonomic
neatness.

Validation (in `src/config/schema.ts`):
- `databases.<name>`: friendly-name regex `^[a-z0-9][a-z0-9_-]{0,62}$`.
- Value: lenient Notion UUID regex (32 hex with optional dashes).
  Reject anything else at load time.

### 6.2 Per-agent grant (YAML)

```yaml
agents:
  clerk:
    notion_workspace: {}        # empty object = "this agent gets the integration with no DB restriction"

  carrie:
    notion_workspace:
      databases: [essays]       # restrict to this DB only

  # Agent with no notion_workspace key gets no Notion at all
  # — the launcher is not scaffolded, no MCP entry, no token grant.
```

The empty-object form for clerk is deliberately ugly: it forces the
operator to make a positive opt-in decision per agent rather than
defaulting Notion access on. Mirrors gdrive/m365: presence of the
key = opt in; absence = no integration.

#### What counts as "in the allowlist"

The allowlist gates Notion tool calls in three buckets:

1. **Page or block whose parent (or grandparent, recursively) is a
   DB in the allowlist** — allowed. Standard case.
2. **Page or block whose top ancestor is NOT a DB** — i.e.,
   standalone workspace pages or DB-less sub-pages. **Hard deny in
   v1.** Adding a `pages: [...]` allowlist key is the natural v2
   extension; for v1, the operator's options are (a) move the
   page into a DB so it's reachable, or (b) wait for v2. This is
   explicit so the failure mode is obvious instead of silent.
3. **A *new* DB being created (`create_database`)** — there is no
   pre-existing DB to gate against. **Hard deny in v1** —
   `create_database` is removed from the available tool set
   altogether (filtered out of the MCP's reported tool list, so the
   model doesn't see it). Operators create DBs in Notion's UI for
   now. Re-evaluate in v2.

### 6.3 Validation cross-checks

`apply` rejects with a clear error in four cases:

1. Per-agent references a database name that isn't in
   `notion_workspace.databases` (typo).
2. Per-agent has `databases: []` (empty list — operator probably meant
   to remove the field entirely; explicit empty list = "no DBs at
   all" which is the same as not having Notion).
3. Agent has `notion_workspace:` but the vault has no
   `notion/integration-token` key, failing at `apply`, not at runtime.
4. Agent has `notion_workspace:` but is **not in the vault ACL** for
   `notion/integration-token`. Surface the precise remediation:
   `switchroom vault set notion/integration-token --allow <full-list>` re-stating the allowlist including the missing agent. This
   is the highest-leverage check: without it the launcher fails 503
   at runtime instead of at config-edit time.

### 6.4 Why no `scopes: [read, write]` v1 — divergence from brief

The task brief specified `scopes: [read, write]` on the per-agent
grant. This RFC drops that field. Three reasons:

1. **No JTBD demands it today.** Both target agents (clerk, carrie)
   need read+write. A read-only restriction is a hypothetical future
   capability, not a real user need.
2. **m365 made the same call deliberately** (RFC #1873 §6.4): scope
   tiering "adds friction without a clear JTBD" in v1. Notion should
   not introduce a different posture without reason.
3. **The principles consistency test wants this.** Three integrations
   (gdrive, m365, notion) with three different scope models would be
   the operator's least-favourite kind of surprise.

If a read-only-per-agent JTBD emerges (e.g. an analytics-only agent
that should never write back to Notion), add it as a v2 field then.
For now, the integration's *upstream* capability set (Read + Update +
Insert, configured once at integration-registration time) is the
single authority on what writes are even possible.

### 6.5 Cascade

Same shape as `google_workspace` / `microsoft_workspace`: `defaults
→ profiles → agents`. The top-level friendly-name DB map cascades
**deep-merge** (so a profile can add a DB without clobbering the
top-level map). The per-agent `databases: [...]` list is **override**
(an agent's list replaces the parent's, doesn't concatenate) —
otherwise an agent inheriting a profile that grants `[essays]` can
never *narrow* to fewer.

Document this cascade in `docs/configuration.md` alongside the
existing `google_workspace` and `microsoft_workspace` cascade tables.
The two modes (deep-merge for the top-level DB map; override for
per-agent lists) are already supported by `src/config/merge.ts` —
no new cascade mode required.

## 7. Rate limiting

Notion's public REST limit is **3 requests/second per integration
token**. The first draft of this RFC deferred to v2 on
m365/gdrive-parity grounds. The reviewer correctly flagged that
the math doesn't hold once §8's per-tool resolution-cost (§8.2) and
the mandatory search post-filter (§8.5) are honest about their API-
call footprint:

| Operation | API calls per invocation |
|---|---|
| `update_page` | 2 (parent lookup + write) |
| `update_block` / `delete_block` / `append_block_children` | 2–3 (block-parent walk + write) |
| `create_page` (DB-parent) | 1 (write only — parent in args) |
| `create_page` (page-parent) | 2 (page → DB walk + write) |
| `create_comment` (page-parent) | 2 |
| `search` (with post-filter) | 1 + N (one search + per-result parent walk; capped at first 20 results) |

A multi-step turn with three writes and one search burns ~10
requests; two such agents firing concurrently overrun 3 rps within
two seconds. Notion's 429 retry is correctly handled by the upstream
MCP, but a storm degrades agent turn-latency by 5–15 s and emits
noisy operator-facing errors.

**Ship the token bucket in v1**, in the launcher process:

- **Where**: `src/cli/notion-mcp-launcher.ts`, inline. Not a separate
  daemon, no shared store: one operator-bounded integration token
  ⇒ one launcher's bucket suffices *across agents* if the launcher
  is shared. But the launcher is per-agent (stdio bridge), so the
  bucket has to be global to the operator. Implementation: a tiny
  Unix-domain coordination socket the vault-broker already owns —
  the broker acquires/releases tokens on the agent's behalf during
  every Notion API call. The broker is the natural shared-state
  holder (it already mediates per-token grants).
- **Mechanism**: token bucket with 3 tokens, refill 3/sec. The
  hook script (§8) calls `vault_request_throttle notion` before
  each Notion REST call it makes itself (for DB resolution +
  search filter), and the launcher wraps the MCP's HTTP layer with
  the same throttle. If no token available within 1 s, return 429
  to the agent immediately (don't block longer than the upstream
  would have).
- **Cost**: ~80 LOC in the broker + ~30 LOC in the launcher + ~20
  LOC in the hook. Single PR (PR 2). No new daemon.
- **Override**: `notion_workspace.rate_limit_rps: <n>` lets the
  operator lower the global budget if they share the token with a
  non-switchroom consumer.

**v2 trigger** (after v1 ships): if even the global bucket isn't
enough (e.g. operators with 5+ agents all heavily Notion-dependent),
consider per-agent quotas inside the global bucket. Not blocking
v1.

**Doctor probe**: report bucket-saturation events from the last 24 h
so the operator notices when their fleet's Notion usage is rate-
limited.

## 8. Allowlist enforcement + approval cards

Two layers stacked at PreToolUse:

1. **Allowlist gate** (every Notion tool, read and write): resolve
   the call's target DB and reject if it isn't in the agent's
   `databases: [...]`. This is the load-bearing defence-in-depth
   check.
2. **Approval card** (writes only): operator sees a card with page
   title, parent-DB friendly name, deep link, and diff preview;
   accept/reject in Telegram.

Both layers live in
`telegram-plugin/gateway/notion-write-approval.ts`, installed at
PreToolUse via the existing settings.json scaffold. Fail-closed on
broker unreachability (same as drive/m365).

### 8.1 Tool surface and what gets gated

Notion-MCP tools at v0.5.x:

| Tool | Layer 1 (allowlist) | Layer 2 (approval) | Notes |
|---|---|---|---|
| `search` | ✓ post-filter | — | See §8.5 |
| `query-database` | ✓ pre-check `database_id` arg | — | Free — DB id in args |
| `get-page` / `get-block-children` | ✓ pre-check via resolver | — | 1 API call if unknown |
| `create_page` | ✓ via parent | ✓ | If `parent.database_id`: free. If `parent.page_id`: 1 resolver call |
| `update_page` | ✓ via parent | ✓ | Page → DB resolver call (1) |
| `update_block` / `delete_block` / `append_block_children` | ✓ via parent | ✓ | Block → page → DB walk (1–2) |
| `create_comment` (page-parent) | ✓ via parent | ✓ | 1 resolver call |
| `update_database` | ✓ direct | ✓ | DB id in args |
| `create_database` | — | — | **Removed from advertised tool set v1.** Operators create DBs in Notion's UI. (§6.2 rule 3) |

### 8.2 Per-tool DB resolution cost

The allowlist gate needs the call's parent-DB UUID. For tools whose
args contain it directly (DB-parent `create_page`, `query-database`,
`update_database`), the resolver is free. For tools whose args
contain only a `page_id` or `block_id`, the hook makes 1–2 Notion
REST calls to walk up:

```
block_id → GET /v1/blocks/{block_id}        // returns parent
        → if parent.type === "page_id":
            page_id → GET /v1/pages/{page_id}    // returns parent
                   → if parent.type === "database_id": done
                   → if parent.type === "page_id" | "workspace": hard deny (§6.2 rule 2)
        → if parent.type === "block_id": recurse (rare; bounded ≤4)
```

Each API call costs a token from the global rate-limit bucket (§7).
This is *exactly* why §7 exists.

### 8.3 In-launcher page→DB cache

The block/page → DB mapping is **stable for the lifetime of the
container** unless an operator moves pages between DBs in Notion's
UI (rare; the operator can clear the cache by restarting the
launcher).

- Cache shape: `Map<pageId|blockId, { dbId: string, expiresAt: number }>`.
- Bounded: max 5000 entries, LRU eviction. Tunable via
  `NOTION_LAUNCHER_CACHE_SIZE` env (not surfaced in YAML, internal).
- TTL: 10 minutes. After expiry the resolver re-walks. Cheap enough
  given the bucket.
- Cache is per-launcher-process (per-agent) — not shared across
  agents, because clerk and carrie may legitimately see different
  parent DBs for the same page if they have different read perms in
  Notion (rare but possible).
- Hit rate target: >90% after a 5-minute warm-up, which collapses
  steady-state write cost from 2 calls/write to 1 call/write.

### 8.4 Approval card shape

After the allowlist gate passes, write tools go through approval:

- **Card fields**: agent name, tool name, target page title (from
  cache or 1 API call), parent DB friendly name, deep link to the
  page in Notion, and for `update_*` a diff preview (before/after
  property-value comparison) generated by re-fetching the page
  state within the approval window.
- **TTL**: 5 minutes (consistent with drive/m365 cards).
- **Default verdict on timeout**: deny.

### 8.5 `search` post-filter — mandatory, default-on

Notion's `search` endpoint returns titles + snippets of any page the
upstream integration was shared with, regardless of switchroom's
per-agent allowlist. Without a post-filter, carrie's "essays"
search could leak page titles + content snippets from `private-
journal` (which clerk can write to but carrie should never see).

Mitigation, **mandatory in v1**:

- After `search` returns, the hook walks each result's
  `parent.database_id` (or recurses if page-parent) and **drops
  results whose resolved DB isn't in the agent's allowlist**.
- **Cap**: first 20 results post-filter. Walking more would burn
  rate-limit budget for marginal recall improvement.
- Cache (§8.3) absorbs repeat lookups; warm cache makes filter
  near-free.
- The filtered count is surfaced in the tool response as a
  metadata field (`filtered: N`) so the agent knows results were
  redacted and can refine the query.
- No operator opt-out — this is a privacy invariant. If a future
  operator JTBD genuinely needs whole-workspace search, that's a
  separate scope grant on the per-agent config (`search_global:
  true`), and it's an explicit YAML knob, not a quiet default.

### 8.6 Reads are not approval-gated

Reads still go through Layer 1 (allowlist) but skip Layer 2
(approval card). Consistent with gdrive/m365: read-only calls are
below the approval bar. The allowlist still applies, and a read
against a DB outside the allowlist is still rejected.

## 9. Doctor probes

Add to `src/cli/doctor/*` (one file per probe, matching m365's
shape):

1. **`notion:integration-token-present`** — vault has
   `notion/integration-token`; warn if missing AND any agent has
   `notion_workspace:`.
2. **`notion:db-references-resolvable`** — every per-agent `databases:
   [name]` resolves to a UUID in `notion_workspace.databases`. Fail
   if any agent references an unknown friendly name.
3. **`notion:vault-acl-aligned`** — for every agent with
   `notion_workspace:`, verify the agent is in the broker ACL for
   `notion/integration-token`. Fail (not warn) with the precise
   remediation command if any agent is missing. The inverse
   (ACL entry without a YAML config) warns (benign waste).
4. **`notion:launcher-heartbeat`** — per-agent: heartbeat file at
   `/tmp/notion-launcher-<agent>.heartbeat.json` exists and is fresher
   than 60 s.
5. **`notion:rate-bucket-saturation`** — read the last 24 h of
   bucket-saturation events from the broker's audit log; warn if
   >5% of attempted requests were throttled (the v2 trigger
   threshold from §7).
6. **`notion:upstream-reachable`** — *optional, costs an API call*
   — fires `GET /v1/users/me` against `api.notion.com` once per
   doctor run with the operator-vaulted token; surfaces auth or
   network breakage. Guarded behind `--deep` to avoid burning rate-
   limit budget on every routine doctor run.

Doctor must **skip** (not fail) when no agent has `notion_workspace:`
configured, same posture as the existing gdrive/m365 probes.

## 10. Implementation plan

Five-PR series, parallel to m365's #1881–#1888 sequence. Each PR has
its own reviewer pass; only the final PR enables auto-merge.

### PR 1 — Config schema + vault layout (~200 LOC)

- `src/config/schema.ts`: add `NotionWorkspaceConfigSchema` (top-level
  `vault_key`, `databases` map, optional `mcp_version`, optional
  `rate_limit_rps`).
- `src/config/schema.ts`: add `AgentNotionWorkspaceConfigSchema`
  (`databases?: string[]`).
- `src/config/merge.ts`: cascade rule for `notion_workspace` (deep-
  merge top-level DB map, override per-agent list — confirmed
  supported by existing modes).
- `src/config/notion-acl.ts`: predicate
  `agentCanAccessNotionDB(agent, dbName, config)` and
  `resolveDbNameFromUuid(uuid, config)`.
- Tests: `src/config/notion-acl.test.ts` (~20 cases mirroring
  microsoft-workspace-acl), `src/config/notion-merge.test.ts`,
  `src/config/notion-validation.test.ts` (apply-time cross-checks
  inc. ACL-drift case from §6.3 rule 4).

### PR 2 — Launcher + scaffold + rate-bucket (~550 LOC)

- `src/cli/notion-mcp-launcher.ts`: vault-fetch → env-inject → spawn
  bridge. Heartbeat file. Crash-loop on vault failure (exit 1, no
  retry, let docker restart-policy handle it). Wraps HTTP layer
  with rate-bucket client.
- `src/vault/broker/notion-rate-bucket.ts`: token-bucket primitive
  (3 tokens, refill 3/sec, configurable via
  `notion_workspace.rate_limit_rps`). Exposes
  `notion_throttle_acquire` IPC verb on the broker socket.
- `src/agents/scaffold.ts`: `resolveNotionMcpEntry()` emits the
  `.mcp.json` block when `agents.<name>.notion_workspace` is
  present. Env block: `SWITCHROOM_AGENT_NAME`,
  `SWITCHROOM_VAULT_BROKER_SOCK`, `SWITCHROOM_NOTION_VAULT_KEY`.
  **Filters `create_database` out of the advertised tool list**
  (§8.1 / §6.2 rule 3).
- `src/memory/scaffold-integration.ts`:
  `NOTION_MCP_PINNED_VERSION` constant.
- Tests: `src/cli/notion-mcp-launcher.test.ts`,
  `src/vault/broker/notion-rate-bucket.test.ts`,
  `src/agents/scaffold-notion-entry.test.ts` (incl. tool-filter
  assertion).

### PR 3 — Allowlist enforcement + approval hook + post-filter (~700 LOC)

- `telegram-plugin/gateway/notion-write-approval.ts`: PreToolUse hook
  with two layers: allowlist gate (all tools) + approval card
  (writes). Uses the broker's rate-bucket for its own resolver calls.
- `src/notion/db-resolver.ts`: per-tool DB resolution (§8.2). Tool-
  shape dispatch table; recursion-bounded ≤4 hops for block-parent
  walks. Hard-denies pages without DB parents (§6.2 rule 2).
- `src/notion/page-db-cache.ts`: in-process LRU cache (§8.3). Bounded
  5000 entries, 10-minute TTL.
- `telegram-plugin/gateway/notion-search-filter.ts`: mandatory post-
  filter on `search` results (§8.5). Cap 20 results; surfaces
  `filtered: N` metadata.
- `src/agents/scaffold.ts`: install hook in agent settings.json scaffold
  when `notion_workspace` is set.
- Tests: `telegram-plugin/tests/notion-write-approval.test.ts`,
  `src/notion/db-resolver.test.ts` (one case per tool shape),
  `src/notion/page-db-cache.test.ts`,
  `telegram-plugin/tests/notion-search-filter.test.ts` (incl.
  leak-prevention assertion: carrie searching DB she can't see
  → 0 results, not snippets).

### PR 4 — Doctor probes + CLI verbs (~350 LOC)

- `src/cli/doctor/notion-integration-token.ts` and five siblings
  (§9 probes 1–6).
- `src/cli/notion.ts`: top-level CLI surface:
  - `switchroom notion list-dbs` — prints a ready-to-paste YAML
    block of `friendly-name → uuid` (powers the §4.1 bootstrap
    step 4).
  - `switchroom notion test <agent>` — runs a one-off `get /users/me`
    via the broker as the named agent; smoke-test for setup.
- Tests: doctor probes + `notion.ts` CLI tests.

### PR 5 — Docs + bundled skill + UAT (~350 LOC)

- `docs/notion-integration.md`: operator-facing setup guide.
  Integration registration → vault set → share DBs → list-dbs →
  YAML → apply → first run.
- `docs/configuration.md`: cascade documentation parallel to
  existing `google_workspace` / `microsoft_workspace` sections.
- `skills/notion/SKILL.md`: bundled skill that wraps the most
  common agent flows ("look up X by title", "list pages in DB Y",
  "append a bulleted item to page Z"). The skill calls the notion
  MCP tools; the launcher provides them. The personal-notion skill
  currently on clerk is **retired** in favour of this bundled skill
  (§13.2 covers the migration).
- `telegram-plugin/uat/scenarios/jtbd-notion-readwrite-dm.test.ts`:
  end-to-end UAT: operator DMs clerk asking to add an item to a
  DB, approval card appears, accept, DM confirmation lands.
- `telegram-plugin/uat/scenarios/jtbd-notion-allowlist-deny-dm.test.ts`:
  carrie tries to write to a DB outside her allowlist, gets a clean
  `E_NOTION_DB_NOT_ALLOWED` error visible in chat (privacy gate
  observable from the operator side).
- `telegram-plugin/uat/scenarios/jtbd-notion-search-filter-dm.test.ts`:
  carrie searches for a term that appears in clerk's private DB; the
  response shows 0 results from that DB (search filter is doing its
  job).

### Follow-up (separate RFC or v1.5)

- Per-agent read-only scope tier (when first JTBD lands).
- Coordinated rate limiting if 429s become noisy.
- Per-page (not per-DB) allowlist (when a page-level use case lands).
- Public-integration OAuth flow (for multi-operator deployments).
- Notion comment / mention threading into telegram (could be a
  different RFC, same `inbox-zero` JTBD).

## 11. Effort estimate

**Total: ~110 agent minutes wall-clock** for a current-generation
Claude agent doing the work end-to-end (revised up from the first
draft's 50 min after reviewer flagged §8's resolver + cache + post-
filter complexity):

- PR 1 (config + ACL): ~10 min
- PR 2 (launcher + scaffold + rate-bucket): ~20 min (was ~12 — added
  broker rate-bucket primitive)
- PR 3 (allowlist + approval + post-filter): ~35 min (was ~10 —
  per-tool resolver dispatch, cache, mandatory search filter, three
  test files including the leak-prevention assertion)
- PR 4 (doctor + CLI): ~10 min
- PR 5 (docs + bundled skill + UAT): ~15 min (was ~10 — extra UAT
  scenarios for allowlist deny and search filter)

Plus ~20–30 minutes total across the series for reviewer iteration.

This is still materially cheaper than m365's 5-PR series (which
clocked several hours because OAuth/MSAL is heavyweight). The
integration-token model is still the dominant savings, but the
per-DB allowlist + search post-filter are real engineering, not the
free win the first draft suggested.

## 12. Out of scope (v1)

- **Public OAuth integration** (multi-operator). Internal integration
  only.
- **Per-block / per-page allowlist** (only per-DB in v1; standalone
  pages hard-denied per §6.2 rule 2).
- **Per-agent quotas inside the global rate bucket** (per §7 v2
  trigger).
- **Read-only-per-agent scope tier** (per §6.4).
- **`create_database` from agents** — filtered out of the advertised
  tool set v1 (§6.2 rule 3). Operators create DBs in Notion's UI.
- **Notion Calendar / Reminders surface as separate integrations** —
  these are pages in a DB; the existing DB tools reach them.
- **Multi-workspace** — one integration = one workspace. Two
  workspaces would need two integrations and two vault keys; deferred.

## 13. Open questions / risks

### 13.1 Divergences from the original task brief

1. **`scopes: [read, write]` dropped** (§6.4). Brief specified it;
   RFC drops it for consistency with m365 + lack of JTBD. If
   re-asserted by operator, easy to add as a follow-up field.
2. **`databases: [...]` is the ONLY per-agent control v1.** No per-
   page granularity, no scope filter. Standalone pages hard-denied
   (§6.2 rule 2); `create_database` removed from the tool surface
   (§6.2 rule 3, §8.1).
3. **Top-level config key is `notion_workspace:`, not
   `integrations.notion:`** (consistency with `google_workspace:`
   and `microsoft_workspace:`).
4. **Rate limiting shipped v1**, not deferred (§7 — reversed after
   reviewer math).
5. **Search post-filter is mandatory and default-on** (§8.5 —
   privacy invariant; first draft had it opt-in).

### 13.2 Migration of the existing `personal-notion` skill on clerk

The operator currently runs a `personal-notion` skill on clerk
(directory exists at
`~/.switchroom-config/agents/clerk/personal-skills/notion/`, contents
not surveyed due to mount permissions). Once the bundled `skills/notion`
ships in PR 5:

- The bundled skill is **the canonical Notion skill**. All agents
  with `notion_workspace:` configured get it via the existing
  bundled-skill discovery.
- The personal-notion skill is **deprecated, not auto-removed**. Per
  the agent-managed-skills posture (RFC C), the agent owns their
  personal skills tier. Migration is the operator's call.
- The operator-facing migration note in PR 5 documents the
  superseding bundle and shows how to remove the personal copy if
  desired (`skill_remove_personal notion` via clerk's MCP).

### 13.3 Token-string format detection in the vault

Notion's secret format changed: legacy `secret_...`, current
`ntn_...`. The vault doesn't care (opaque string), but the doctor's
`integration-token-present` probe should not regex-validate against a
prefix or it'll false-fail on the next format change. Just check
non-empty.

### 13.4 What happens if the operator revokes the integration in Notion
while agents are running?

The MCP server returns 401 on the next call. The launcher process
keeps running; only the *next* tool call fails. The agent surfaces
the 401 to the operator naturally. No automatic recovery: the operator
re-creates the integration, rotates the vault key, restarts the
launchers. Documented as a v1 limitation.

## 14. Research appendix

### Vault key shape decision

Considered `notion/integration-secret` (matches Notion's own
"Internal Integration Secret" UI label) vs `notion/integration-
token`. Went with `-token` for parallelism with other vault keys
(`google/credentials.json`, `bot/token`, etc.). Operator instruction
in docs will clarify "paste the value shown as 'Internal Integration
Secret' in Notion".

### Why the official MCP and not a custom one

Notion-maintained, MIT-licensed, actively shipped. The tool surface
covers everything switchroom agents need. The integration-token
plumbing is a one-env-var setup vs OAuth's multi-step app
registration. Writing our own would burn agent-minutes for no
deliverable benefit and would couple us to Notion REST changes that
the official MCP already absorbs.

### Why per-DB and not per-page

Notion pages are addressed by UUID; their parent DB is a stable
hierarchical anchor. Per-page allowlists multiply the operator's
config surface by ~10–100×. Per-DB gives the right scoping for
"clerk handles all writing; carrie only touches the essays DB" —
which is the actual JTBD. Per-page can come later if a page-level
need emerges.

### Comparison summary — integration patterns at a glance

| Aspect | gdrive | m365 | notion (this RFC) |
|---|---|---|---|
| Upstream auth | OAuth, refresh in vault | OAuth, refresh in auth-broker | Long-lived integration token in vault |
| Refresh loop | per-agent wrapper | broker-mediated, launcher BYOT | none |
| OAuth app registration | implicit per account | explicit Entra app, one per operator | Notion-side integration, one per operator |
| Per-agent ACL | `enabled_for[]` + `account: email` | `enabled_for[]` + `account: email` | broker ACL (`--allow`) + `notion_workspace.databases[]` |
| Friendly-name mapping | n/a | n/a | YES (DB friendly names → UUIDs) |
| Scope tiering v1 | tiers (`core/extended/complete`) | none (binary `org_mode`) | none |
| Resource allowlist | none in v1 | none in v1 | per-DB (this RFC's main novelty) |
| Rate limiting | none | none | **YES v1** (token bucket in broker, 3 rps default) |
| Search privacy filter | n/a (Drive has no equivalent) | n/a | **YES v1** (mandatory post-filter) |
| Write-gate hook | yes (`drive-write-pretool`) | yes (`ms365-write-approval`) | yes (`notion-write-approval`) |
| Doctor probes | yes (5+) | yes (5+) | yes (6, per §9) |
| Bundled skill | n/a (skills/gdrive doesn't exist) | n/a | YES (`skills/notion`, PR 5) |

Per-DB allowlist + friendly-name mapping + the search post-filter
are the three pieces unique to Notion. Everything else is a thinner-
or-thicker rerun of the m365/gdrive shape.
