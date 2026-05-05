/**
 * YAML editor for `switchroom auth enable/disable`.
 *
 * Edits `agents.<agentName>.auth.accounts: [labels...]` while preserving
 * comments and formatting elsewhere in the file. Mirrors the pattern in
 * `telegram-yaml.ts` — pure module, string-in / string-out.
 */

import { parseDocument, type Document, isMap, isSeq, type YAMLMap, type YAMLSeq } from "yaml";

/**
 * Append an account label to `agents.<agent>.auth.accounts`. Idempotent —
 * appending an already-present label returns the YAML unchanged. Creates
 * intermediate maps + the array if absent.
 *
 * Throws if the agent is not declared in switchroom.yaml — operators
 * should see "agent X not declared" rather than have us silently create
 * one that wouldn't otherwise scaffold.
 */
export function appendAccountToAgent(
  yamlText: string,
  agentName: string,
  label: string,
): string {
  const doc = parseDocument(yamlText);
  ensureAgent(doc, agentName);
  const existing = doc.getIn(["agents", agentName, "auth", "accounts"]);
  if (isSeq(existing)) {
    const seq = existing as YAMLSeq;
    for (const item of seq.items) {
      const v = (item as { value?: unknown }).value ?? item;
      if (v === label) return yamlText; // idempotent
    }
    seq.add(label);
  } else {
    doc.setIn(["agents", agentName, "auth", "accounts"], [label]);
  }
  return String(doc);
}

/**
 * Remove an account label from `agents.<agent>.auth.accounts`. No-op if
 * the label is not present. When the array becomes empty, the parent
 * `auth.accounts` entry is dropped (and empty parent maps pruned) so the
 * YAML doesn't accumulate `auth: {}` debris.
 *
 * Returns the new YAML string. Caller is responsible for refusing the
 * operation when it would leave the agent with no accounts (the broker
 * needs at least one account per agent to do anything).
 */
export function removeAccountFromAgent(
  yamlText: string,
  agentName: string,
  label: string,
): string {
  const doc = parseDocument(yamlText);
  if (!hasAgent(doc, agentName)) return yamlText;
  const existing = doc.getIn(["agents", agentName, "auth", "accounts"]);
  if (!isSeq(existing)) return yamlText;
  const seq = existing as YAMLSeq;
  const beforeLen = seq.items.length;
  for (let i = seq.items.length - 1; i >= 0; i--) {
    const item = seq.items[i];
    const v = (item as { value?: unknown })?.value ?? item;
    if (v === label) seq.delete(i);
  }
  if (seq.items.length === beforeLen) return yamlText; // no change
  if (seq.items.length === 0) {
    doc.deleteIn(["agents", agentName, "auth", "accounts"]);
    pruneEmptyMap(doc, ["agents", agentName, "auth"]);
  }
  return String(doc);
}

/**
 * Move `label` to position 0 in `agents.<agent>.auth.accounts` so it
 * becomes the agent's primary on the next fanout. Used by
 * `switchroom auth promote`. Pure: returns the new YAML string.
 *
 * Behaviour:
 *   - Label not in the list → throws (caller validates first; reaching
 *     this branch is a bug, not a no-op the operator should silently
 *     accept).
 *   - Label already at position 0 → returns yamlText unchanged
 *     (byte-identical, no parseDocument round-trip).
 *   - Label at any other position → moved to head; relative order of
 *     the other entries preserved.
 *   - Agent not declared → throws (same contract as appendAccountToAgent).
 *
 * Why a pure-string short-circuit on already-primary: parseDocument
 * normalizes whitespace and can drop a leading newline, surprising
 * callers that diff the file to detect "did anything change?". The
 * `enable` polish (#697) hit this exact corner.
 */
export function promoteAccountForAgent(
  yamlText: string,
  agentName: string,
  label: string,
): string {
  const doc = parseDocument(yamlText);
  ensureAgent(doc, agentName);
  const existing = doc.getIn(["agents", agentName, "auth", "accounts"]);
  if (!isSeq(existing)) {
    throw new Error(
      `agent '${agentName}' has no auth.accounts list — enable '${label}' first.`,
    );
  }
  const seq = existing as YAMLSeq;
  const labels = seq.items.map(
    (item) => (item as { value?: unknown }).value ?? item,
  );
  const idx = labels.indexOf(label);
  if (idx === -1) {
    throw new Error(
      `account '${label}' is not enabled on agent '${agentName}' — enable it first.`,
    );
  }
  if (idx === 0) return yamlText; // already primary — no-op
  const moved = seq.items.splice(idx, 1)[0];
  seq.items.unshift(moved);
  return String(doc);
}

/**
 * Read the current `agents.<agent>.auth.accounts` list without mutating.
 * Returns [] if absent or shape-mismatched. Useful for the `list` verb +
 * the rm-refusal logic.
 */
export function getAccountsForAgent(
  yamlText: string,
  agentName: string,
): string[] {
  const doc = parseDocument(yamlText);
  if (!hasAgent(doc, agentName)) return [];
  const existing = doc.getIn(["agents", agentName, "auth", "accounts"]);
  if (!isSeq(existing)) return [];
  const seq = existing as YAMLSeq;
  return seq.items
    .map((item) => (item as { value?: unknown }).value ?? item)
    .filter((v): v is string => typeof v === "string");
}

/**
 * Rewrite every `agents.<agent>.auth.accounts` list in the YAML,
 * swapping every occurrence of `oldLabel` for `newLabel`. Returns
 * the updated YAML string + the list of agents that were touched.
 *
 * Idempotent: agents whose list doesn't contain `oldLabel` are left
 * alone. The order of remaining labels in each list is preserved.
 *
 * Used by `switchroom auth account rename` to keep the per-agent
 * preference lists pointing at the renamed account without touching
 * any other config.
 */
export function renameAccountInAllAgents(
  yamlText: string,
  oldLabel: string,
  newLabel: string,
): { yaml: string; touched: string[] } {
  const doc = parseDocument(yamlText);
  const agents = doc.get("agents");
  if (!isMap(agents)) return { yaml: yamlText, touched: [] };
  const touched: string[] = [];
  for (const item of (agents as YAMLMap).items) {
    const agentName = String((item.key as { value?: unknown }).value ?? item.key);
    const accountsNode = doc.getIn(["agents", agentName, "auth", "accounts"]);
    if (!isSeq(accountsNode)) continue;
    const seq = accountsNode as YAMLSeq;
    let mutated = false;
    for (let i = 0; i < seq.items.length; i++) {
      const v = (seq.items[i] as { value?: unknown }).value ?? seq.items[i];
      if (v === oldLabel) {
        seq.set(i, newLabel);
        mutated = true;
      }
    }
    if (mutated) touched.push(agentName);
  }
  // Return the original yaml string verbatim when no edits happened —
  // serializing through parseDocument can normalize whitespace
  // (e.g. drop a leading newline), which would surprise callers
  // checking for byte-equality to detect "no change".
  if (touched.length === 0) return { yaml: yamlText, touched };
  return { yaml: String(doc), touched };
}

function ensureAgent(doc: Document, agentName: string): void {
  if (!hasAgent(doc, agentName)) {
    throw new Error(
      `agent '${agentName}' is not declared in switchroom.yaml under 'agents:'. Add it first via 'switchroom agent create' or hand-edit the file.`,
    );
  }
}

function hasAgent(doc: Document, agentName: string): boolean {
  const agents = doc.get("agents");
  if (!isMap(agents)) return false;
  return (agents as YAMLMap).has(agentName);
}

function pruneEmptyMap(doc: Document, path: string[]): void {
  const node = doc.getIn(path);
  if (isMap(node) && (node as YAMLMap).items.length === 0) {
    doc.deleteIn(path);
  }
}
