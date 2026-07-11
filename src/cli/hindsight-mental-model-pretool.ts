/**
 * PreToolUse hook — #2974: redirect direct hindsight mental-model writes.
 *
 * The four hindsight mental-model WRITE tools
 * (`create_mental_model` / `update_mental_model` / `delete_mental_model` /
 * `refresh_mental_model`) are deliberately un-preapproved (#2911
 * least-privilege — see HINDSIGHT_MENTAL_MODEL_WRITE_TOOLS in
 * src/agents/scaffold.ts). A direct call therefore falls through to a TUI
 * permission prompt that wedges the turn (and, until the watchdog card-race
 * fix lands, gets auto-denied). The sanctioned path is
 * `mcp__switchroom-telegram__mental_model_propose`, which posts an approval
 * card and persists on approval.
 *
 * This hook makes that redirect MECHANICAL: it DENIES exactly those four
 * write tools with a deterministic, instructive message so the agent
 * self-corrects in the same turn — no prompt renders, no watchdog fires.
 * Every other tool (all hindsight READ tools — get_mental_model,
 * list_mental_models, recall, retain, reflect, … — and every non-hindsight
 * tool) passes through untouched.
 *
 * Claude Code PreToolUse protocol (v1), mirrors skill-validate-pretool:
 *   Input:  JSON on stdin — { session_id, tool_name, tool_input, ... }
 *   Output: exit 0 + empty stdout                       → allow.
 *           exit 0 + {"decision":"block","reason":...}  → block (deny).
 *
 * Fail-OPEN on any stdin parse error / unknown shape: a redirect hook must
 * never be the reason a legitimate tool call fails. The only non-allow
 * outcome is the explicit block on the four write tools.
 */

import { readFileSync } from "node:fs";

/** The four gated hindsight mental-model write tools. Kept in lockstep with
 *  HINDSIGHT_MENTAL_MODEL_WRITE_TOOLS in src/agents/scaffold.ts. */
const MENTAL_MODEL_WRITE_TOOLS = new Set([
  "mcp__hindsight__create_mental_model",
  "mcp__hindsight__update_mental_model",
  "mcp__hindsight__delete_mental_model",
  "mcp__hindsight__refresh_mental_model",
]);

const DENY_MESSAGE =
  "Mental-model writes are operator-approved. Use " +
  "`mcp__switchroom-telegram__mental_model_propose` instead — it posts an " +
  "approval card and persists on approval.";

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function allow(): never {
  process.exit(0);
}

function block(reason: string): never {
  process.stdout.write(JSON.stringify({ decision: "block", reason }));
  process.exit(0);
}

function main(): void {
  const raw = readStdin().trim();
  if (!raw) allow();

  let event: { tool_name?: unknown };
  try {
    event = JSON.parse(raw);
  } catch {
    allow(); // Claude protocol error — not ours to police.
  }

  const toolName = typeof event.tool_name === "string" ? event.tool_name : "";
  if (MENTAL_MODEL_WRITE_TOOLS.has(toolName)) block(DENY_MESSAGE);

  allow();
}

main();
