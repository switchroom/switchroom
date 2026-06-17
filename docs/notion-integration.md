# Notion integration

Switchroom's Notion integration lets one or more agents read and write
Notion pages and databases under a single operator-owned **internal
integration**, with per-agent allowlists at the database level.

This is the operator-facing setup guide. See
[`reference/rfcs/notion-integration.md`](../reference/rfcs/notion-integration.md) for
the design rationale.

## What you get

- One Notion integration shared across agents (no per-agent OAuth).
- Per-agent database allowlists (`clerk` reads everything; `carrie`
  only sees the essays DB).
- Mandatory privacy filter on search results (an agent never sees
  snippets from databases outside its allowlist).
- A PreToolUse hook that rejects write attempts against
  out-of-allowlist databases with a clear, operator-actionable
  message.
- A doctor section showing per-agent ACL + heartbeat status.

## What you don't get (v1)

- **Public OAuth.** Single-operator internal integration only.
- **`create_database` from agents.** Operators create DBs via
  Notion's UI; switchroom can read + write existing DBs only.
- **Standalone-page access.** Pages without a database parent are
  hard-denied. Move them into a database to give agent access.
- **Search for filtered agents.** If an agent has a non-empty
  `notion_workspace.databases:` allowlist (e.g. `carrie:
  notion_workspace: { databases: [essays] }`), the `search` tool is
  **blocked** for that agent. The privacy-preserving post-filter is
  shipped as code (`src/notion/search-filter.ts`) but not yet wired
  into the launcher's stdio bridge, so allowing search would leak
  snippets from other DBs the integration was shared with.
  Admin-shaped agents (no `databases:` filter) can still search.
  Tracked at [switchroom/switchroom#1913](https://github.com/switchroom/switchroom/issues/1913) — the wire-up lifts this restriction.
- **Operator approval cards on writes.** v1 ships the allowlist
  primitive; a follow-up adds the m365/drive-style approval card on
  top. Tracked at [switchroom/switchroom#1914](https://github.com/switchroom/switchroom/issues/1914).
- **Coordinated rate-limit bucket.** The broker primitive shipped
  but isn't wired into the hook yet — relies on Notion's own 429
  retry behaviour. Tracked at [switchroom/switchroom#1915](https://github.com/switchroom/switchroom/issues/1915).

## Bootstrap order (read this — order matters)

1. **Create the integration in Notion.**
   - Notion → Settings → Connections → **Develop or manage
     integrations** → **New integration**.
   - Name: `switchroom` (or whatever — visible only to you).
   - Type: **Internal**. Associated workspace: your primary
     workspace.
   - Capabilities (recommended starting set):
     - Read content
     - Update content
     - Insert content
     - Read comments / Insert comments
     - Read user information (no email)
   - Copy the **Internal Integration Secret** (starts with
     `secret_…` or `ntn_…`).

2. **Put the secret in switchroom's vault.**
   ```bash
   switchroom vault set notion/integration-token \
     --allow clerk,carrie     # comma-separated list of agents that may read it
   ```
   The `--allow` ACL is the broker-side authorization — agents not
   listed here can't fetch the token, regardless of YAML config.

3. **Share databases with the integration in Notion's UI.**
   For each database or page you want any switchroom agent to
   touch:
   - Open it in Notion.
   - Top-right ⋯ → **Connections** → add `switchroom`.
   - This is Notion's *upstream* ACL. The integration literally
     cannot see pages that weren't shared with it.

4. **Discover the database UUIDs (paste-ready).**
   ```bash
   switchroom notion list-dbs
   ```
   This prints a ready-to-paste YAML block:
   ```yaml
   # Paste under `notion_workspace:` in switchroom.yaml:
   databases:
     essays: "a1b2c3d4-e5f6-7890-1234-567890abcdef"
     tasks:  "b2c3d4e5-f6a7-8901-2345-67890abcdef0"
   ```
   Edit the friendly names to taste — agents reference databases by
   these names, never by UUID.

5. **Wire it into `switchroom.yaml`.**
   ```yaml
   notion_workspace:
     vault_key: notion/integration-token   # default; usually omitted
     databases:
       essays: "a1b2c3d4-e5f6-7890-1234-567890abcdef"
       tasks:  "b2c3d4e5-f6a7-8901-2345-67890abcdef0"
     # OPTIONAL: rate_limit_rps: 3        # default 3 (Notion's limit)

   agents:
     clerk:
       notion_workspace: {}              # full access (within upstream-shared set)
     carrie:
       notion_workspace:
         databases: [essays]             # restrict to essays DB only
   ```

   - `notion_workspace: {}` (empty object) = **opt in, no
     restrictions**. Agent can access every DB the upstream
     integration was shared with.
   - `notion_workspace.databases: [name, name, ...]` = **opt in,
     restricted**. Agent can only access the listed DBs (names
     must resolve in `notion_workspace.databases` at the top
     level). Empty list `[]` is REJECTED at config-load time.
   - No `notion_workspace:` block at all = **agent has no Notion
     access**.

6. **Apply and verify.**
   ```bash
   switchroom apply
   switchroom doctor          # Should show "Notion (RFC ...)" section all OK
   switchroom notion test clerk   # Smoke test from operator perspective
   ```

## Common operator tasks

### Adding a database to an existing agent

1. Share the DB with the `switchroom` integration in Notion's UI.
2. `switchroom notion list-dbs` to print the updated YAML block;
   copy the new line into `notion_workspace.databases:`.
3. Add the friendly name to the agent's
   `notion_workspace.databases:` list.
4. `switchroom apply` — no agent restart needed (config cascade
   re-renders settings.json).

### Rotating the integration token

1. Notion → Settings → Integrations → `switchroom` → **Refresh secret**.
2. `switchroom vault set notion/integration-token` — paste the new
   value. (Re-state `--allow` to preserve the current allowlist —
   `vault set` overwrites the scope.)
3. `switchroom agent restart <name> --graceful-restart` for each
   notion-enabled agent. The launcher picks up the new token on
   next-fetch.

### Revoking one agent's access

```bash
# Re-run `vault set` with the agent omitted from --allow.
# Example: previously --allow clerk,carrie — now revoking carrie:
switchroom vault set notion/integration-token --allow clerk
```

`vault set` overwrites the entire `--allow` scope, so re-state the
list with the agent removed. The broker stops serving the token to
that agent immediately. Existing running tool calls finish; the next
launcher restart fails closed.

### Revoking everyone

Notion → Settings → Integrations → `switchroom` → **Delete
integration**. All `notion_workspace`-enabled agents start failing
on the next tool call.

## Doctor section

```
Notion (RFC notion-integration)
✓ notion:top-level-block-present
✓ notion:integration-token-present
✓ notion:db-references-resolvable:carrie  — 1 db(s) all resolved
✓ notion:db-references-resolvable:clerk   — no per-agent databases filter set
✓ notion:vault-acl-aligned:clerk
✓ notion:vault-acl-aligned:carrie
✓ notion:launcher-heartbeat:clerk  — heartbeat 12s old
✓ notion:launcher-heartbeat:carrie — heartbeat 8s old
```

If you see:
- **`notion:vault-acl-aligned:<agent>` FAIL** → re-run
  `switchroom vault set notion/integration-token --allow <full-list>`
  including the missing agent name.
- **`notion:db-references-resolvable:<agent>` FAIL** → typo in
  `agents.<name>.notion_workspace.databases:`. The probe's fix
  field names the unresolvable database.
- **`notion:launcher-heartbeat:<agent>` WARN** → launcher hasn't
  written its heartbeat in 60s+. Restart the agent.

## Common errors agents will surface

When an agent tries a tool call that the hook rejects, you'll see a
message like one of these in the Telegram conversation:

> `Notion tool `update_page` targets database `b2c3d4e5-…` which is
> not in carrie's allowlist (notion_workspace.databases). If this is
> intentional, add the database friendly name to
> agents.carrie.notion_workspace.databases in switchroom.yaml.`

> `Notion tool `create_database` is disabled in switchroom v1.
> Create databases via Notion's UI instead; switchroom can read +
> write existing DBs.`

> `Notion tool `update_page` targets a standalone page (no database
> parent). switchroom v1 only allows access to pages inside an
> allowlisted database.`

All three are intended behaviours, not bugs. Adjust the agent's
`notion_workspace.databases:` if the operator wants to grant access.

## Migration from the `personal-notion` skill (if you had one)

If you had a per-agent `personal-notion` skill that bundled its own
Notion authentication (typically with a hardcoded token or a
per-agent vault key), the bundled `skills/notion` shipped with this
release supersedes it.

To migrate:
1. Set up `notion_workspace:` as above.
2. Remove the agent's personal-notion skill:
   `skill_remove_personal notion` via the agent's MCP, or delete the
   directory in `~/.switchroom-config/agents/<name>/personal-skills/notion/`.
3. The bundled skill is auto-discovered. No further action needed.

## Why per-DB, not per-page

Per-page allowlists would multiply the config surface by 10–100×.
Per-DB gives the right scoping for "clerk handles everything;
carrie only touches the essays DB" which is the actual JTBD. If a
page-level need emerges, a `pages: [...]` allowlist key is a clean
v2 extension.
