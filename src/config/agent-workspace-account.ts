/**
 * YAML editor for the per-agent workspace account selector —
 * `agents.<name>.google_workspace.account` /
 * `agents.<name>.microsoft_workspace.account`.
 *
 * The top-level `{google,microsoft}_accounts.<email>.enabled_for[]` ACL
 * (edited by `{google,microsoft}-accounts-yaml.ts`) says WHICH agents
 * MAY use an account; this per-agent selector says WHICH account an agent
 * DOES use. Both are required for the broker to serve credentials —
 * setting the ACL alone yields `ACCOUNT_NOT_FOUND` because the agent has
 * no selector. The management UI writes both in one config mutation.
 *
 * Comment/format-preserving via the `yaml` Document API, matching the
 * accounts-yaml editors. String-in / string-out.
 */

import { parseDocument, isMap, type YAMLMap } from "yaml";

export type WorkspaceProvider = "google" | "microsoft";

function blockKey(provider: WorkspaceProvider): string {
  return `${provider}_workspace`;
}

/**
 * Set `agents.<agent>.<provider>_workspace.account = <account>`, creating
 * the agent entry / workspace block as needed. Idempotent (byte-equal
 * pass-through when already set to the same value). Returns the edited
 * YAML text.
 *
 * Throws if `agents` exists but isn't a map, or the named agent isn't
 * declared — the UI must only pin a known agent.
 */
export function setAgentWorkspaceAccount(
  yamlText: string,
  provider: WorkspaceProvider,
  agent: string,
  account: string,
): string {
  const doc = parseDocument(yamlText);
  const agentsNode = doc.get("agents");
  if (!isMap(agentsNode)) {
    throw new Error("switchroom.yaml has no `agents:` map");
  }
  if (!(agentsNode as YAMLMap).has(agent)) {
    throw new Error(`agent '${agent}' is not declared in switchroom.yaml`);
  }
  const path = ["agents", agent, blockKey(provider), "account"];
  const current = doc.getIn(path);
  if (current === account) return yamlText;
  doc.setIn(path, account);
  return String(doc);
}

/**
 * Clear the per-agent selector. Removes `…<provider>_workspace.account`;
 * if the workspace block becomes empty as a result, removes the block
 * too (so a cleared agent doesn't leave a dangling `microsoft_workspace:
 * {}` that would still scaffold the MCP server). Idempotent.
 */
export function clearAgentWorkspaceAccount(
  yamlText: string,
  provider: WorkspaceProvider,
  agent: string,
): string {
  const doc = parseDocument(yamlText);
  const agentsNode = doc.get("agents");
  if (!isMap(agentsNode)) return yamlText;
  if (!(agentsNode as YAMLMap).has(agent)) return yamlText;
  const blockPath = ["agents", agent, blockKey(provider)];
  const block = doc.getIn(blockPath);
  if (!isMap(block)) return yamlText;
  const accountPath = [...blockPath, "account"];
  if (doc.getIn(accountPath) === undefined) return yamlText;
  doc.deleteIn(accountPath);
  // Drop an empty workspace block so it doesn't keep scaffolding the MCP.
  const after = doc.getIn(blockPath);
  if (isMap(after) && (after as YAMLMap).items.length === 0) {
    doc.deleteIn(blockPath);
  }
  return String(doc);
}

/**
 * Read the per-agent selector. Returns the pinned account email or null.
 */
export function getAgentWorkspaceAccount(
  yamlText: string,
  provider: WorkspaceProvider,
  agent: string,
): string | null {
  const doc = parseDocument(yamlText);
  const v = doc.getIn(["agents", agent, blockKey(provider), "account"]);
  return typeof v === "string" ? v : null;
}
