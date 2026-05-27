/**
 * `switchroom notion` — RFC docs/rfcs/notion-integration.md PR 4.
 *
 * Operator-facing CLI for Notion integration setup + smoke testing.
 *
 * Verbs:
 *   - `notion list-dbs` — Calls Notion's API as the operator to print
 *     a ready-to-paste YAML block of `friendly-name → uuid` mappings.
 *     This is the §4.1 bootstrap step 4 — populates
 *     `notion_workspace.databases:` without operators copying UUIDs
 *     by hand. Requires the integration token already in the vault.
 *   - `notion test <agent>` — Fires a `GET /v1/users/me` via the
 *     broker as the named agent. Smoke-test for setup verification:
 *     does the agent have ACL access to the token, can the launcher
 *     reach Notion, does the integration auth check out?
 *
 * Both verbs reuse the broker for vault access — they go through
 * `getViaBrokerStructured` which respects the per-agent ACL. The
 * operator running as root has implicit ACL access, so list-dbs
 * works without per-agent setup.
 */

import type { Command } from "commander";

import { loadConfig } from "../config/loader.js";
import { createNotionApiClient } from "../notion/api-client.js";
import { getViaBrokerStructured } from "../vault/broker/client.js";

export function registerNotionCommand(program: Command): void {
  const cmd = program
    .command("notion")
    .description(
      "Notion integration operator helpers (list-dbs, test). See docs/rfcs/notion-integration.md.",
    );

  cmd
    .command("list-dbs")
    .description(
      "List the databases the Notion integration can access. Output is a ready-to-paste YAML block for `notion_workspace.databases`.",
    )
    .option(
      "--vault-key <key>",
      "Override the vault key holding the integration token.",
      "notion/integration-token",
    )
    .action(async (opts: { vaultKey: string }) => {
      const code = await runListDbs(opts);
      process.exit(code);
    });

  cmd
    .command("test <agent>")
    .description(
      "Smoke-test Notion access for an agent. Calls /v1/users/me via the broker and prints the integration's bot user.",
    )
    .option(
      "--vault-key <key>",
      "Override the vault key holding the integration token.",
      "notion/integration-token",
    )
    .action(async (agent: string, opts: { vaultKey: string }) => {
      const code = await runTest(agent, opts);
      process.exit(code);
    });
}

// ────────────────────────────────────────────────────────────────────────
// list-dbs
// ────────────────────────────────────────────────────────────────────────

async function runListDbs(opts: { vaultKey: string }): Promise<number> {
  let token: string;
  try {
    token = await fetchToken(opts.vaultKey);
  } catch (err) {
    process.stderr.write(
      `switchroom notion list-dbs: ${(err as Error).message}\n`,
    );
    return 1;
  }

  const client = createNotionApiClient({ token });
  // Notion's /v1/search with object filter is the easiest enumeration —
  // returns databases the integration was shared with.
  let dbs: { id: string; title: string }[];
  try {
    dbs = await searchAllDatabases(token);
  } catch (err) {
    process.stderr.write(
      `switchroom notion list-dbs: failed to enumerate databases: ${
        (err as Error).message
      }\n`,
    );
    return 1;
  }

  if (dbs.length === 0) {
    process.stderr.write(
      "switchroom notion list-dbs: the integration has no databases shared with it.\n" +
        "Open Notion → page/database you want switchroom to access → top-right ⋯ → Connections → add `switchroom`, then re-run.\n",
    );
    return 1;
  }

  process.stdout.write("# Paste under `notion_workspace:` in switchroom.yaml:\n");
  process.stdout.write("databases:\n");
  const seen = new Set<string>();
  for (const db of dbs) {
    const slug = toFriendlyName(db.title || db.id, seen);
    seen.add(slug);
    process.stdout.write(`  ${slug}: "${db.id}"\n`);
  }
  if (process.stdout.isTTY) {
    process.stderr.write(
      `\nFound ${dbs.length} database(s). Edit the friendly names to taste — agents reference them by name in \`agents.<name>.notion_workspace.databases\`.\n`,
    );
  }
  return 0;
}

/**
 * Convert a Notion DB title to a friendly slug matching the schema's
 * `^[a-z0-9][a-z0-9_-]{0,62}$` regex. De-dups via the seen set.
 */
function toFriendlyName(title: string, seen: Set<string>): string {
  let base = title
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  if (!base || !/^[a-z0-9]/.test(base)) base = `db-${base.replace(/^[^a-z0-9]+/, "")}`;
  if (!base) base = "db";
  let candidate = base;
  let i = 2;
  while (seen.has(candidate)) {
    candidate = `${base}-${i}`;
    i += 1;
  }
  return candidate;
}

async function searchAllDatabases(
  token: string,
): Promise<{ id: string; title: string }[]> {
  // Use the search endpoint with filter: { value: "database", property: "object" }
  // Cursor through results — most operators have few enough DBs that
  // one page is sufficient.
  const out: { id: string; title: string }[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 10; i += 1) {
    const body: Record<string, unknown> = {
      filter: { value: "database", property: "object" },
      page_size: 100,
    };
    if (cursor) body.start_cursor = cursor;
    const res: { results: NotionDbHit[]; next_cursor: string | null } =
      await postSearch(token, body);
    for (const hit of res.results) {
      const title = extractDbTitle(hit) || hit.id;
      out.push({ id: hit.id, title });
    }
    if (!res.next_cursor) break;
    cursor = res.next_cursor;
  }
  return out;
}

interface NotionDbHit {
  object: "database";
  id: string;
  title?: { plain_text?: string }[];
}

function extractDbTitle(hit: NotionDbHit): string | null {
  if (!hit.title || !Array.isArray(hit.title)) return null;
  return hit.title.map((t) => t.plain_text ?? "").join("").trim() || null;
}

async function postSearch(
  token: string,
  body: Record<string, unknown>,
): Promise<{ results: NotionDbHit[]; next_cursor: string | null }> {
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), 10000);
  try {
    const res = await fetch("https://api.notion.com/v1/search", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!res.ok) {
      throw new Error(`Notion /v1/search ${res.status}: ${await res.text()}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

// ────────────────────────────────────────────────────────────────────────
// test
// ────────────────────────────────────────────────────────────────────────

async function runTest(
  agent: string,
  opts: { vaultKey: string },
): Promise<number> {
  // Load config to verify the agent exists + has notion_workspace.
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
  } catch (err) {
    process.stderr.write(
      `switchroom notion test: failed to load switchroom.yaml: ${
        (err as Error).message
      }\n`,
    );
    return 1;
  }
  const agentCfg = config.agents?.[agent];
  if (!agentCfg) {
    process.stderr.write(
      `switchroom notion test: agent '${agent}' not found in switchroom.yaml.\n`,
    );
    return 1;
  }
  if (!agentCfg.notion_workspace) {
    process.stderr.write(
      `switchroom notion test: agent '${agent}' has no notion_workspace block. Set \`agents.${agent}.notion_workspace: {}\` (or with databases:) in switchroom.yaml.\n`,
    );
    return 1;
  }

  let token: string;
  try {
    token = await fetchToken(opts.vaultKey);
  } catch (err) {
    process.stderr.write(
      `switchroom notion test: ${(err as Error).message}\n`,
    );
    return 1;
  }

  // Fire GET /v1/users/me — the integration's bot user.
  try {
    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), 10000);
    let res: Response;
    try {
      res = await fetch("https://api.notion.com/v1/users/me", {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Notion-Version": "2022-06-28",
        },
        signal: ac.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!res.ok) {
      process.stderr.write(
        `switchroom notion test: Notion API returned ${res.status} — token may be revoked. Detail: ${await res.text()}\n`,
      );
      return 1;
    }
    const data = (await res.json()) as {
      type?: string;
      name?: string;
      bot?: { workspace_name?: string };
    };
    process.stdout.write(
      `OK — agent='${agent}', integration bot='${data.name ?? "?"}', workspace='${data.bot?.workspace_name ?? "?"}'\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(
      `switchroom notion test: ${(err as Error).message}\n`,
    );
    return 1;
  }
}

async function fetchToken(vaultKey: string): Promise<string> {
  const result = await getViaBrokerStructured(vaultKey);
  if (result.kind === "unreachable") {
    throw new Error(`vault-broker unreachable: ${result.msg}`);
  }
  if (result.kind === "not_found") {
    throw new Error(
      `vault key '${vaultKey}' is missing. Run \`switchroom vault set ${vaultKey}\` first.`,
    );
  }
  if (result.kind === "denied") {
    throw new Error(`vault-broker denied access to '${vaultKey}': ${result.msg}`);
  }
  if (result.entry.kind !== "string") {
    throw new Error(`vault key '${vaultKey}' is not a string entry`);
  }
  return result.entry.value;
}
