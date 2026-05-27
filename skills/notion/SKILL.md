---
name: notion
version: 0.1.0
description: |
  Use when the user wants to read, search, write, or update content in
  their Notion workspace. The agent has access via the `notion` MCP
  server (`@notionhq/notion-mcp-server`) configured by the operator
  with a per-database allowlist.

  Triggers on phrasings including: "add this to Notion", "what's on my
  Notion tasks", "find that page about X in Notion", "create a Notion
  page for this", "update the notion entry for X", "search Notion
  for…", "append this to my Notion notes", "show me what's in the
  essays database", "log this in Notion".

  Do NOT use to create new Notion databases — that's disabled in v1
  (operators create DBs via Notion's UI). Do NOT use to scan or
  enumerate the operator's whole workspace ad-hoc — the per-database
  allowlist scopes what the agent can see, and brute-forcing past it
  is a defence-in-depth violation.

  Also do not use this skill to file bugs against a GitHub repo
  (that's `file-bug`) or to search the web (Notion search is workspace-
  scoped only).
---

# Notion

This skill is your interface to the operator's Notion workspace. The
operator has registered an integration in Notion's settings and
shared specific pages/databases with it. Your access is gated at two
layers:

1. **Notion's upstream share-list** — the integration can only see
   pages and databases the operator explicitly shared with it in
   Notion's UI.
2. **switchroom's per-agent allowlist** — within what the upstream
   integration can see, the operator can further restrict YOU to a
   subset via `agents.<your-name>.notion_workspace.databases:`.

Both layers are enforced at the broker / hook level. You don't have
to compute the intersection — if you call a tool against a
disallowed database, you'll get a clean block reason naming the DB.

## Tool surface

The Notion MCP exposes the standard set:

- **Search.** `search` finds pages or databases by title/content
  across what the integration can see. switchroom's PreToolUse hook
  post-filters results to your allowlist — pages outside it are
  dropped before they reach you. The response's metadata field
  indicates how many were filtered.
- **Database queries.** `query_database` runs a filter+sort against
  a database. You need the database's UUID (operator gives these
  via friendly names in `notion_workspace.databases` — ask the
  operator for "what's the UUID for X" if needed).
- **Page reads.** `get_page` and `get_block_children` walk a page's
  structure. Both go through the allowlist gate.
- **Page writes.** `create_page` (with `parent.database_id`),
  `update_page`, `update_block`, `append_block_children`,
  `delete_block`, `create_comment`. The allowlist gate runs first;
  blocked tool calls return a reason you can surface to the operator.
- **Database writes.** `update_database` — schema changes,
  rename, etc. Gated.

## Tools NOT available

- **`create_database`** — disabled in v1 (operators create
  databases via Notion's UI). If the user asks you to "create a new
  database for X", say so and offer to populate an existing one or
  prompt the operator to make the DB first.
- **`delete_database`** — same posture.

## Common workflows

### "What's on my tasks?"

1. Ask the operator (or use `config_get` to check your own
   `notion_workspace.databases`) for the friendly name of the tasks
   DB. The friendly name resolves to a UUID via
   `notion_workspace.databases` in switchroom.yaml.
2. `query_database` with that UUID. Default filter: `not done`.
3. Format results as a brief markdown list. Don't dump the full
   property soup — operators want titles + status, not raw IDs.

### "Add `<thing>` to Notion"

1. Default destination is the database whose friendly name matches
   the user's intent (`tasks`, `notes`, `essays`). Ask if it's
   ambiguous.
2. Use `create_page` with `parent.database_id: <uuid>`. The page's
   properties need to match the target DB's schema — call
   `retrieve_database` first if you're unsure of the property
   names.
3. After creation, confirm to the user with the page title and
   the Notion URL.

### "Find that thing about X"

1. `search` with the query. Take only the top result unless ambiguous.
2. The post-filter has already redacted out-of-allowlist results;
   don't worry about leakage.
3. If 0 results: try a `query_database` against the most likely DB
   with a property filter (matches the value).

### "Update the page about X"

1. `search` or `query_database` to find the page.
2. `update_page` (for properties — status, tags, dates) or
   `append_block_children` (for body content).
3. **Be careful** with `update_block` and `delete_block` — these
   modify the page's body irreversibly. Prefer `append_block_children`
   when the user's intent is "add a note to this page", not
   "replace what's there".

## Limits and behaviours

- **Rate limit**: Notion's public API is ~3 rps per integration.
  Multi-step turns with many writes may slow down (the hook makes
  resolver calls per write). If you see "Notion API failed: 429",
  back off and retry once.
- **No `create_database`**: if the user asks for a new database,
  say "I can write into existing DBs but the operator creates new
  ones in Notion's UI." Then offer the closest existing DB.
- **Standalone pages denied**: pages without a database parent
  (workspace root pages, personal sub-pages) are hard-denied in
  v1. The block reason names this when it fires; pass it through
  to the user.

## When the allowlist denies you

If a tool call returns "DB <uuid> is not in your allowlist", that's
the operator's intended scope — don't try to work around it. Surface
the message to the user honestly: "I'm not configured to access that
database. You can add it to my allowlist with
`agents.<my-name>.notion_workspace.databases` in switchroom.yaml."

## Authoring small notes vs full pages

For one-line "log this thought" intents, prefer `append_block_children`
to an existing daily-notes / inbox page rather than creating a new
page per note. Operators usually have an inbox DB; ask if you're
unsure.
