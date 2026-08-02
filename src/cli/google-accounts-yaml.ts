/**
 * YAML editor for `switchroom auth google enable/disable`.
 *
 * Edits the **top-level** `google_accounts.<email>.enabled_for: [agents...]`
 * map while preserving comments and formatting elsewhere in the file.
 * Mirrors the pattern in `auth-accounts-yaml.ts` — pure module, string-in /
 * string-out — but with a different shape: Anthropic auth lives under
 * `agents.<name>.auth.accounts: []` (per-agent preference list) while
 * Google Workspace lives under `google_accounts.<email>.enabled_for: []`
 * (per-account allowlist of agents).
 *
 * The shape difference is load-bearing per RFC G §4.4: the per-account
 * ACL is what lets two agents share one Google OAuth refresh token without
 * granting cross-agent access to the slot. The auth-accounts-yaml helpers
 * are not reusable here because the indexing flips (account → agents,
 * not agent → accounts).
 */

import {
  parseDocument,
  type Document,
  isMap,
  isSeq,
  type YAMLMap,
  type YAMLSeq,
} from "yaml";

/**
 * Append agents to `google_accounts.<account>.enabled_for`. Idempotent —
 * agents already present are left in place; the relative order of existing
 * entries is preserved. Creates the intermediate maps + sequence if absent.
 *
 * Pass-through if no agents would be added (returns the original YAML
 * string verbatim, not a re-serialised version, so byte-equality checks
 * for "no change" still work).
 *
 * Note: this helper does NOT validate that the agent slugs exist in the
 * config. The CLI verb is responsible for that check (so it can give a
 * better error than "YAML write failed").
 */
export function enableAgentsOnGoogleAccount(
  yamlText: string,
  account: string,
  agentsToEnable: string[],
): string {
  const doc = parseDocument(yamlText);
  ensureGoogleAccountEntry(doc, account);
  const existing = doc.getIn(["google_accounts", account, "enabled_for"]);
  const currentAgents = readEnabledFor(existing);
  const additions = agentsToEnable.filter((a) => !currentAgents.includes(a));
  if (additions.length === 0) return yamlText;
  if (isSeq(existing)) {
    const seq = existing as YAMLSeq;
    for (const a of additions) seq.add(a);
  } else {
    doc.setIn(
      ["google_accounts", account, "enabled_for"],
      [...currentAgents, ...additions],
    );
  }
  return String(doc);
}

/**
 * Remove agents from `google_accounts.<account>.enabled_for`. No-op if
 * none of the named agents are present. When `enabled_for` becomes empty,
 * it stays as an empty array (NOT pruned) — empty-but-present is the
 * RFC G §4.4 "dormant account" state, and dropping the key would be a
 * silent migration to "account not configured at all" which has different
 * semantics. Operators wanting to fully remove the account use
 * `auth google account remove <account>`.
 */
export function disableAgentsOnGoogleAccount(
  yamlText: string,
  account: string,
  agentsToDisable: string[],
): string {
  const doc = parseDocument(yamlText);
  if (!hasGoogleAccountEntry(doc, account)) return yamlText;
  const existing = doc.getIn(["google_accounts", account, "enabled_for"]);
  if (!isSeq(existing)) return yamlText;
  const seq = existing as YAMLSeq;
  const beforeLen = seq.items.length;
  for (let i = seq.items.length - 1; i >= 0; i--) {
    const item = seq.items[i];
    const v = (item as { value?: unknown })?.value ?? item;
    if (typeof v === "string" && agentsToDisable.includes(v)) {
      seq.delete(i);
    }
  }
  if (seq.items.length === beforeLen) return yamlText;
  return String(doc);
}

/**
 * Read `google_accounts.<account>.enabled_for` without mutating. Returns
 * `null` if the account isn't in the YAML at all (distinguished from `[]`
 * which means dormant per RFC G §4.4). Used by the `list` verb and the
 * remove-refusal logic.
 */
export function getEnabledAgentsForGoogleAccount(
  yamlText: string,
  account: string,
): string[] | null {
  const doc = parseDocument(yamlText);
  if (!hasGoogleAccountEntry(doc, account)) return null;
  const existing = doc.getIn(["google_accounts", account, "enabled_for"]);
  return readEnabledFor(existing);
}

/**
 * List every Google account configured in the YAML, with each account's
 * `enabled_for` agents. Used by `auth google list` (matrix view) and by
 * the apply preflight when warning operators about legacy slots.
 *
 * Returns entries in YAML-source order (not alphabetical) so the CLI
 * output matches what the operator sees in the file.
 */
export function listGoogleAccounts(
  yamlText: string,
): Array<{ account: string; enabled_for: string[] }> {
  const doc = parseDocument(yamlText);
  const accounts = doc.get("google_accounts");
  if (!isMap(accounts)) return [];
  const out: Array<{ account: string; enabled_for: string[] }> = [];
  for (const item of (accounts as YAMLMap).items) {
    const account = String((item.key as { value?: unknown }).value ?? item.key);
    const enabled = doc.getIn([
      "google_accounts",
      account,
      "enabled_for",
    ]);
    out.push({ account, enabled_for: readEnabledFor(enabled) });
  }
  return out;
}

/**
 * Persist the per-account scope selection (v1 read-only scope model)
 * into `google_accounts.<account>.{readonly,services}`. Written by
 * `auth google account add` after a successful mint so `--replace` can
 * re-read the SAME selection instead of silently re-widening to the
 * tier default. Creates the account entry (with an empty `enabled_for`)
 * if absent — mirrors `enableAgentsOnGoogleAccount`'s create-on-demand.
 *
 * `readonly: false` is written explicitly (not pruned): once an account
 * is on the new-style selection, the record must be self-describing —
 * an absent key means "legacy tier-driven", never "false".
 *
 * Pass-through (byte-identical return) when the stored selection
 * already matches.
 */
export function setGoogleAccountSelection(
  yamlText: string,
  account: string,
  selection: { readonly: boolean; services: string[] },
): string {
  const doc = parseDocument(yamlText);
  ensureGoogleAccountEntry(doc, account);
  const currentReadonly = doc.getIn([
    "google_accounts",
    account,
    "readonly",
  ]);
  const currentServices = doc.getIn(["google_accounts", account, "services"]);
  const currentServicesArr = readEnabledFor(currentServices);
  const unchanged =
    currentReadonly === selection.readonly &&
    currentServicesArr.length === selection.services.length &&
    currentServicesArr.every((s, i) => s === selection.services[i]);
  if (unchanged) return yamlText;
  doc.setIn(["google_accounts", account, "readonly"], selection.readonly);
  doc.setIn(["google_accounts", account, "services"], [...selection.services]);
  return String(doc);
}

/**
 * Remove the entire `google_accounts.<account>` entry from the YAML.
 * Used by `auth google account remove`. The CLI verb is responsible for
 * checking that `enabled_for` is empty first (so we don't strand any
 * agents whose tools depended on the account).
 *
 * If the account isn't present, returns the original YAML string
 * verbatim. If removing the last entry leaves `google_accounts: {}`,
 * the empty parent map is also pruned.
 */
export function removeGoogleAccountEntry(
  yamlText: string,
  account: string,
): string {
  const doc = parseDocument(yamlText);
  if (!hasGoogleAccountEntry(doc, account)) return yamlText;
  doc.deleteIn(["google_accounts", account]);
  pruneEmptyMap(doc, ["google_accounts"]);
  return String(doc);
}

// ────────────────────────────────────────────────────────────────────────
// internals
// ────────────────────────────────────────────────────────────────────────

function readEnabledFor(node: unknown): string[] {
  if (!isSeq(node)) return [];
  const seq = node as YAMLSeq;
  return seq.items
    .map((item) => (item as { value?: unknown }).value ?? item)
    .filter((v): v is string => typeof v === "string");
}

function ensureGoogleAccountEntry(doc: Document, account: string): void {
  // Unlike auth-accounts-yaml's ensureAgent (which throws if the agent
  // isn't declared), `auth google enable` may legitimately be the first
  // thing that creates the google_accounts entry — operators run
  // `auth google account add` first (writes vault slot), then `enable`
  // (writes YAML). So this helper just ensures the entry exists,
  // creating it if needed.
  if (!hasGoogleAccountEntry(doc, account)) {
    doc.setIn(["google_accounts", account, "enabled_for"], []);
  }
}

function hasGoogleAccountEntry(doc: Document, account: string): boolean {
  const accounts = doc.get("google_accounts");
  if (!isMap(accounts)) return false;
  return (accounts as YAMLMap).has(account);
}

function pruneEmptyMap(doc: Document, path: string[]): void {
  const node = doc.getIn(path);
  if (isMap(node) && (node as YAMLMap).items.length === 0) {
    doc.deleteIn(path);
  }
}
