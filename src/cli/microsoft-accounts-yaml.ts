/**
 * YAML editor for `switchroom auth microsoft enable/disable` — RFC #1873.
 *
 * Edits the top-level `microsoft_accounts.<email>.enabled_for: [agents...]`
 * map while preserving comments and formatting elsewhere in the file.
 * Mirrors `google-accounts-yaml.ts` byte-for-byte (s/google/microsoft/) —
 * the shape is identical, the key name differs.
 *
 * Per RFC #1873 §6.1, dormant-on-empty (empty `enabled_for[]` stays as
 * an empty array, not pruned) — matches shipped Google behavior.
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
 * Append agents to `microsoft_accounts.<account>.enabled_for`. Idempotent.
 * Pass-through (verbatim byte-equality preserved) if no agents would be added.
 */
export function enableAgentsOnMicrosoftAccount(
  yamlText: string,
  account: string,
  agentsToEnable: string[],
): string {
  const doc = parseDocument(yamlText);
  ensureMicrosoftAccountEntry(doc, account);
  const existing = doc.getIn(["microsoft_accounts", account, "enabled_for"]);
  const currentAgents = readEnabledFor(existing);
  const additions = agentsToEnable.filter((a) => !currentAgents.includes(a));
  if (additions.length === 0) return yamlText;
  if (isSeq(existing)) {
    const seq = existing as YAMLSeq;
    for (const a of additions) seq.add(a);
  } else {
    doc.setIn(
      ["microsoft_accounts", account, "enabled_for"],
      [...currentAgents, ...additions],
    );
  }
  return String(doc);
}

/**
 * Remove agents from `microsoft_accounts.<account>.enabled_for`. No-op
 * if none of the named agents are present. When `enabled_for` becomes
 * empty, it stays as an empty array (NOT pruned) — empty-but-present
 * is the "dormant account" state per RFC #1873 §6.1, mirroring shipped
 * Google behavior.
 */
export function disableAgentsOnMicrosoftAccount(
  yamlText: string,
  account: string,
  agentsToDisable: string[],
): string {
  const doc = parseDocument(yamlText);
  if (!hasMicrosoftAccountEntry(doc, account)) return yamlText;
  const existing = doc.getIn(["microsoft_accounts", account, "enabled_for"]);
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
 * Read `microsoft_accounts.<account>.enabled_for` without mutating.
 * Returns `null` if the account isn't in the YAML at all
 * (distinguished from `[]` which means dormant).
 */
export function getEnabledAgentsForMicrosoftAccount(
  yamlText: string,
  account: string,
): string[] | null {
  const doc = parseDocument(yamlText);
  if (!hasMicrosoftAccountEntry(doc, account)) return null;
  const existing = doc.getIn(["microsoft_accounts", account, "enabled_for"]);
  return readEnabledFor(existing);
}

/**
 * List every Microsoft account configured in the YAML. Returns entries
 * in YAML-source order so the CLI output matches what the operator
 * sees in the file.
 */
export function listMicrosoftAccounts(
  yamlText: string,
): Array<{ account: string; enabled_for: string[] }> {
  const doc = parseDocument(yamlText);
  const accounts = doc.get("microsoft_accounts");
  if (!isMap(accounts)) return [];
  const out: Array<{ account: string; enabled_for: string[] }> = [];
  for (const item of (accounts as YAMLMap).items) {
    const account = String((item.key as { value?: unknown }).value ?? item.key);
    const enabled = doc.getIn([
      "microsoft_accounts",
      account,
      "enabled_for",
    ]);
    out.push({ account, enabled_for: readEnabledFor(enabled) });
  }
  return out;
}

/**
 * Remove the entire `microsoft_accounts.<account>` entry from the YAML.
 * Used by `auth microsoft account remove`. CLI verb is responsible for
 * checking `enabled_for` is empty first (so we don't strand any
 * agents whose tools depended on the account).
 */
export function removeMicrosoftAccountEntry(
  yamlText: string,
  account: string,
): string {
  const doc = parseDocument(yamlText);
  if (!hasMicrosoftAccountEntry(doc, account)) return yamlText;
  doc.deleteIn(["microsoft_accounts", account]);
  pruneEmptyMap(doc, ["microsoft_accounts"]);
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

function ensureMicrosoftAccountEntry(doc: Document, account: string): void {
  if (!hasMicrosoftAccountEntry(doc, account)) {
    doc.setIn(["microsoft_accounts", account, "enabled_for"], []);
  }
}

function hasMicrosoftAccountEntry(doc: Document, account: string): boolean {
  const accounts = doc.get("microsoft_accounts");
  if (!isMap(accounts)) return false;
  return (accounts as YAMLMap).has(account);
}

function pruneEmptyMap(doc: Document, path: string[]): void {
  const node = doc.getIn(path);
  if (isMap(node) && (node as YAMLMap).items.length === 0) {
    doc.deleteIn(path);
  }
}
