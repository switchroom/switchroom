/**
 * Pure YAML-mutation planners for `auth microsoft enable` / `disable`.
 *
 * The broker requires BOTH halves of the gate to serve a Microsoft
 * credential (see `src/config/agent-workspace-account.ts` and
 * `src/config/microsoft-workspace-acl.ts`):
 *   1. the ACL — `microsoft_accounts.<acct>.enabled_for[]` lists the agent, and
 *   2. the selector — `agents.<agent>.microsoft_workspace.account` is pinned.
 *
 * `enable` historically wrote only (1), so an operator who ran it (and even
 * restarted the agent) still hit `ACCOUNT_NOT_FOUND` because (2) was missing.
 * These planners produce the full both-halves edit so the CLI action and any
 * future caller stay consistent — and so the behavior is unit-testable without
 * the CLI/console/docker plumbing. String-in / string-out; no I/O.
 */

import {
  enableAgentsOnMicrosoftAccount,
  disableAgentsOnMicrosoftAccount,
  getEnabledAgentsForMicrosoftAccount,
} from "./microsoft-accounts-yaml.js";
import {
  setAgentWorkspaceAccount,
  getAgentWorkspaceAccount,
  clearAgentWorkspaceAccount,
} from "../config/agent-workspace-account.js";

export interface MicrosoftEnablePlan {
  /** Edited YAML text (byte-equal to input when nothing changed). */
  text: string;
  /** Agents newly added to enabled_for[] this call. */
  newlyEnabled: string[];
  /** Full enabled_for[] after the edit. */
  enabledAfter: string[];
  /** Agents whose microsoft_workspace.account we pinned (was unset). */
  selectorSet: string[];
  /** Agents already pinned to a DIFFERENT account — left untouched. */
  selectorConflict: { agent: string; current: string }[];
}

/**
 * Plan an enable: append the ACL for every target agent AND pin the per-agent
 * selector for any target with no selector. Never overrides a selector that
 * points at a different account (reported as a conflict instead). `account`
 * must already be normalized (lowercased email).
 */
export function planMicrosoftEnable(
  yamlText: string,
  account: string,
  agents: string[],
): MicrosoftEnablePlan {
  const enabledBefore = getEnabledAgentsForMicrosoftAccount(yamlText, account) ?? [];

  let text = enableAgentsOnMicrosoftAccount(yamlText, account, agents);

  const selectorSet: string[] = [];
  const selectorConflict: { agent: string; current: string }[] = [];
  for (const agent of agents) {
    const current = getAgentWorkspaceAccount(text, "microsoft", agent);
    if (current == null) {
      text = setAgentWorkspaceAccount(text, "microsoft", agent, account);
      selectorSet.push(agent);
    } else if (current.toLowerCase() !== account.toLowerCase()) {
      selectorConflict.push({ agent, current });
    }
  }

  const enabledAfter = getEnabledAgentsForMicrosoftAccount(text, account) ?? [];
  const newlyEnabled = enabledAfter.filter((a) => !enabledBefore.includes(a));
  return { text, newlyEnabled, enabledAfter, selectorSet, selectorConflict };
}

export interface MicrosoftDisablePlan {
  text: string;
  /** Agents removed from enabled_for[] this call. */
  removed: string[];
  /** Full enabled_for[] after the edit. */
  enabledAfter: string[];
  /** Agents whose now-dangling selector (pointing at this account) we cleared. */
  selectorCleared: string[];
}

/**
 * Plan a disable: drop the ACL for the target agents AND clear each removed
 * agent's selector when it still pinned THIS account (a selector pointing at
 * an account no longer in its enabled_for[] is the mismatch `doctor microsoft`
 * flags). `account` must already be normalized.
 */
export function planMicrosoftDisable(
  yamlText: string,
  account: string,
  agents: string[],
): MicrosoftDisablePlan {
  const enabledBefore = getEnabledAgentsForMicrosoftAccount(yamlText, account) ?? [];

  let text = disableAgentsOnMicrosoftAccount(yamlText, account, agents);

  const enabledAfter = getEnabledAgentsForMicrosoftAccount(text, account) ?? [];
  const removed = enabledBefore.filter((a) => !enabledAfter.includes(a));

  const selectorCleared: string[] = [];
  for (const agent of removed) {
    if (
      getAgentWorkspaceAccount(text, "microsoft", agent)?.toLowerCase() ===
      account.toLowerCase()
    ) {
      text = clearAgentWorkspaceAccount(text, "microsoft", agent);
      selectorCleared.push(agent);
    }
  }

  return { text, removed, enabledAfter, selectorCleared };
}
