/**
 * YAML editor for `switchroom telegram enable/disable` (#597).
 *
 * Pure module: takes a YAML string in, returns a YAML string out.
 * Uses the `yaml` package's Document API so comments and formatting
 * outside the edited path are preserved.
 *
 * The shape we edit: `agents.<name>.channels.telegram.<feature>` —
 * the cascade-canonical location after #596. Intermediate keys are
 * created on demand.
 */

import { parseDocument, type Document, isMap, isSeq, type YAMLMap, type YAMLSeq } from "yaml";

export type TelegramFeature = "voice_in" | "telegraph" | "webhook_sources" | "linear_agent";

/**
 * Set the `linear_agent` block under
 * `agents.<agent>.channels.telegram.linear_agent` (#2298).
 *
 * Writes `{ enabled: true, token: "vault:linear/<agent>/token" }` (plus an
 * optional `workspace_id`). The token is a vault reference, never an inline
 * literal — the secret itself is stored in the vault by the CLI's vaultPut.
 * Idempotent on re-run (setIn overwrites the block).
 *
 * Also forces `channels.telegram.webhook_via_gateway: true`. A Linear agent
 * is useless without it: inbound `AgentSessionEvent`s (the mention/delegation
 * wakes) are handled gateway-side (`recordWebhookEvent`), and the web receiver
 * only forwards to the gateway when `webhook_via_gateway === true`
 * (`src/web/server.ts`). Setting the `linear_agent` block without it produces
 * a configured-but-deaf agent — the gap that silently broke carrie's first
 * standup until it was patched in by hand (#2298).
 */
export function setLinearAgent(
  yamlText: string,
  agentName: string,
  opts: { token: string; workspaceId?: string },
): string {
  const doc = parseDocument(yamlText);
  ensureAgent(doc, agentName);
  const block: Record<string, unknown> = { enabled: true, token: opts.token };
  if (opts.workspaceId) block.workspace_id = opts.workspaceId;
  doc.setIn(["agents", agentName, "channels", "telegram", "linear_agent"], block);
  doc.setIn(["agents", agentName, "channels", "telegram", "webhook_via_gateway"], true);
  return String(doc);
}

/**
 * Set `default_team_id` on an agent's existing `linear_agent` block (#2312).
 *
 * Only needed for multi-team Linear workspaces — single-team workspaces
 * auto-resolve. Requires the `linear_agent` block to already exist (run
 * `linear-agent setup` first); throws otherwise so we never silently create
 * a half-configured block. Pass `teamId: null` to clear it.
 */
export function setLinearDefaultTeam(
  yamlText: string,
  agentName: string,
  teamId: string | null,
): string {
  const doc = parseDocument(yamlText);
  ensureAgent(doc, agentName);
  if (!doc.hasIn(["agents", agentName, "channels", "telegram", "linear_agent"])) {
    throw new Error(
      `agent '${agentName}' has no linear_agent block. Run 'switchroom linear-agent setup --agent ${agentName} --token <token>' first.`,
    );
  }
  const path = ["agents", agentName, "channels", "telegram", "linear_agent", "default_team_id"];
  if (teamId === null) {
    if (doc.hasIn(path)) doc.deleteIn(path);
  } else {
    doc.setIn(path, teamId);
  }
  return String(doc);
}

/**
 * Set a feature payload under `agents.<agentName>.channels.telegram.<feature>`.
 * Creates intermediate maps if absent. Returns the new YAML string.
 *
 * Throws if the agent doesn't exist in the YAML — operators should
 * see "agent X not declared in switchroom.yaml" rather than have us
 * silently create an entry that wouldn't otherwise scaffold.
 */
export function setTelegramFeature(
  yamlText: string,
  agentName: string,
  feature: TelegramFeature,
  value: unknown,
): string {
  const doc = parseDocument(yamlText);
  ensureAgent(doc, agentName);
  doc.setIn(["agents", agentName, "channels", "telegram", feature], value);
  return String(doc);
}

/**
 * Remove a feature under `agents.<agentName>.channels.telegram.<feature>`.
 * No-op if the path doesn't exist. Trims now-empty parent maps so the
 * YAML doesn't accumulate `telegram: {}` debris over time.
 */
export function removeTelegramFeature(
  yamlText: string,
  agentName: string,
  feature: TelegramFeature,
): string {
  const doc = parseDocument(yamlText);
  if (!hasAgent(doc, agentName)) return yamlText;
  // doc.deleteIn throws if any intermediate path is missing, so check
  // first. No-op when the feature isn't currently set.
  if (!doc.hasIn(["agents", agentName, "channels", "telegram", feature])) {
    return yamlText;
  }
  doc.deleteIn(["agents", agentName, "channels", "telegram", feature]);

  // Prune empty parents — leaving `telegram: {}` after disable looks
  // weird and the cascade treats absent and empty the same.
  pruneEmptyMap(doc, ["agents", agentName, "channels", "telegram"]);
  pruneEmptyMap(doc, ["agents", agentName, "channels"]);
  return String(doc);
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

/**
 * Add a webhook source (string) to `agents.<agent>.channels.telegram.webhook_sources`.
 *
 * webhook_sources is an array, not a single value — each element names a
 * source whose secret lives in vault at `vault:webhook/<agent>/<source>`.
 * The runtime joins on this array to know which inbound webhook payloads
 * to accept; appending is the common case ("add github webhook to klanker"
 * shouldn't blow away an existing 'generic' source).
 *
 * Idempotent: appending an already-present source returns the YAML
 * unchanged (so a re-run after an interrupted enable doesn't produce
 * duplicate entries).
 */
export function addWebhookSource(
  yamlText: string,
  agentName: string,
  source: string,
): string {
  const doc = parseDocument(yamlText);
  ensureAgent(doc, agentName);
  const existing = doc.getIn(["agents", agentName, "channels", "telegram", "webhook_sources"]);
  if (isSeq(existing)) {
    const seq = existing as YAMLSeq;
    for (const item of seq.items) {
      // YAML seq items are Scalar nodes; .value is the string.
      const v = (item as { value?: unknown }).value ?? item;
      if (v === source) return yamlText; // idempotent
    }
    seq.add(source);
  } else {
    doc.setIn(
      ["agents", agentName, "channels", "telegram", "webhook_sources"],
      [source],
    );
  }
  return String(doc);
}

/**
 * Add a key to an agent's standing `secrets[]` list (the operator-set
 * vault grant the broker mints the agent's read/rotate ACL from).
 * Idempotent. Used by `linear-agent setup` to grant the agent ACL over
 * its `linear/<agent>/oauth` refresh bundle so it can rotate the token
 * in-container via the broker `put` op.
 */
export function addAgentSecret(yamlText: string, agentName: string, key: string): string {
  const doc = parseDocument(yamlText);
  ensureAgent(doc, agentName);
  const existing = doc.getIn(["agents", agentName, "secrets"]);
  if (isSeq(existing)) {
    const seq = existing as YAMLSeq;
    for (const item of seq.items) {
      const v = (item as { value?: unknown }).value ?? item;
      if (v === key) return yamlText; // idempotent
    }
    seq.add(key);
  } else {
    doc.setIn(["agents", agentName, "secrets"], [key]);
  }
  return String(doc);
}

/**
 * Remove a webhook source from the array. No-op when the source isn't
 * present. When the array becomes empty, the parent webhook_sources
 * entry is dropped (and empty parent maps pruned) so the YAML doesn't
 * accumulate `webhook_sources: []` debris.
 */
export function removeWebhookSource(
  yamlText: string,
  agentName: string,
  source: string,
): string {
  const doc = parseDocument(yamlText);
  if (!hasAgent(doc, agentName)) return yamlText;
  const existing = doc.getIn(["agents", agentName, "channels", "telegram", "webhook_sources"]);
  if (!isSeq(existing)) return yamlText;
  const seq = existing as YAMLSeq;
  const beforeLen = seq.items.length;
  // Iterate from the end so splice indices remain stable. yaml's
  // YAMLSeq doesn't expose indexOf for primitive values cleanly, so
  // walk the array.
  for (let i = seq.items.length - 1; i >= 0; i--) {
    const item = seq.items[i];
    const v = (item as { value?: unknown })?.value ?? item;
    if (v === source) seq.delete(i);
  }
  if (seq.items.length === beforeLen) return yamlText; // no change
  if (seq.items.length === 0) {
    doc.deleteIn(["agents", agentName, "channels", "telegram", "webhook_sources"]);
    pruneEmptyMap(doc, ["agents", agentName, "channels", "telegram"]);
    pruneEmptyMap(doc, ["agents", agentName, "channels"]);
  }
  return String(doc);
}
