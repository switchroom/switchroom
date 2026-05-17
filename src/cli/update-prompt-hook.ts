/**
 * PR C — install a UserPromptSubmit hook script into each agent that
 * surfaces mid-conversation MCP-originated update_apply outcomes.
 *
 * The gateway boot-card path (telegram-plugin/gateway/update-announce.ts)
 * handles updates that trigger a restart of THIS agent. But when a
 * peer agent (e.g. klanker) runs `mcp__hostd__update_apply` targeting
 * the fleet, this agent doesn't necessarily restart — yet the operator
 * should still see the outcome in chat. The hook fires on the next user
 * prompt, scans the audit log for any terminal update_apply rows newer
 * than the last ack, sends a notification line to the agent's chat, and
 * records the ack mtime.
 *
 * The script is invoked by Claude Code's `UserPromptSubmit` hook with
 * stdin = the user's prompt. The hook short-circuits when the gateway
 * boot-card path has already announced the same request_id (via the
 * `update-announced/<request_id>` sentinel — boot-card wins).
 *
 * Idempotent install: re-running apply overwrites the script with the
 * current content and ensures the hook entry is present in
 * .claude/settings.json without duplicating it.
 */

import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

const HOOK_FILENAME = "update-card-on-prompt.sh";

export function updatePromptHookScript(): string {
  // Bash, POSIX-portable, fail-soft. Reads ~/.switchroom/host-control-audit.log
  // (the canonical hostd log path — see audit-reader.defaultAuditLogPath),
  // scans for terminal update_apply rows newer than the per-agent
  // .update-prompt-acked mtime, and writes one Telegram message via the
  // installed CLI if available. Always exits 0 so it never blocks the
  // user's prompt.
  return `#!/bin/bash
# Switchroom — UserPromptSubmit hook for mid-conversation update surfacing.
# Installed by \`switchroom apply\` (src/cli/update-prompt-hook.ts).
# Reads the hostd audit log for terminal update_apply rows newer than
# this hook's last-ack timestamp, and (when a new row is found AND the
# boot-card path hasn't already claimed it) sends a one-line summary to
# the agent's Telegram chat. Always exits 0 so it never blocks the user.

set +e
AUDIT_LOG="\${HOME}/.switchroom/host-control-audit.log"
STATE_DIR="\${TELEGRAM_STATE_DIR:-\${HOME}/.switchroom/agents/\${SWITCHROOM_AGENT_NAME:-unknown}/telegram}"
ACK_FILE="\${STATE_DIR}/.update-prompt-acked"
ANNOUNCED_DIR="\${STATE_DIR}/update-announced"

[ -f "\$AUDIT_LOG" ] || exit 0
mkdir -p "\$STATE_DIR" 2>/dev/null || true

ACK_TS=0
if [ -f "\$ACK_FILE" ]; then
  ACK_TS=$(stat -c %Y "\$ACK_FILE" 2>/dev/null || stat -f %m "\$ACK_FILE" 2>/dev/null || echo 0)
fi

# Tail last 200 lines, then awk-filter for terminal update_apply rows.
LATEST_LINE=\$(tail -n 200 "\$AUDIT_LOG" 2>/dev/null | grep -F '"phase":"terminal"' | grep -F '"op":"update_apply"' | tail -n 1)
[ -z "\$LATEST_LINE" ] && exit 0

# Extract ts (ISO 8601) and request_id with grep -oP — fall back to
# silent exit if either parse fails.
TS_STR=\$(echo "\$LATEST_LINE" | grep -oP '"ts":"[^"]+"' | head -n1 | sed 's/"ts":"//;s/"//')
REQ_ID=\$(echo "\$LATEST_LINE" | grep -oP '"request_id":"[^"]+"' | head -n1 | sed 's/"request_id":"//;s/"//')
[ -z "\$TS_STR" ] && exit 0
[ -z "\$REQ_ID" ] && exit 0

# Convert ts → epoch. date -d on GNU coreutils; macOS BSD date needs -j -f.
TS_EPOCH=\$(date -d "\$TS_STR" +%s 2>/dev/null || date -j -f "%Y-%m-%dT%H:%M:%S" "\${TS_STR%.*Z}" +%s 2>/dev/null || echo 0)
[ "\$TS_EPOCH" -le "\$ACK_TS" ] && exit 0

# Boot-card wins: skip if the gateway path already claimed this row.
if [ -f "\${ANNOUNCED_DIR}/\${REQ_ID}" ]; then
  : > "\$ACK_FILE"
  exit 0
fi

# Cheap, best-effort notification. We don't try to render the full
# outcome here (the gateway path does that with proper HTML + recovery
# hints) — this is the "you missed it" breadcrumb pointing at the audit
# log for detail. If \`switchroom\` CLI isn't on PATH we still touch the
# ack-file so we don't re-fire on the next prompt.
if command -v switchroom >/dev/null 2>&1; then
  CHAT_ID="\${SWITCHROOM_DEFAULT_CHAT_ID:-}"
  if [ -n "\$CHAT_ID" ]; then
    switchroom telegram send --chat-id "\$CHAT_ID" \\
      --text "🔄 Update completed via MCP (request_id: \$REQ_ID). Run \\\`switchroom audit hostd\\\` for detail." \\
      >/dev/null 2>&1 || true
  fi
fi

# Atomic-touch the ack file so re-fires on the next prompt are skipped.
: > "\$ACK_FILE"
exit 0
`;
}

export interface InstallHookResult {
  scriptPath: string;
  settingsPath: string;
  installed: boolean;
}

/**
 * Install the UserPromptSubmit hook script + register it in the agent's
 * settings.json. Idempotent.
 *
 * Returns:
 *   - scriptPath: absolute path the script was written to
 *   - settingsPath: absolute path to the agent's settings.json
 *   - installed: true if anything was newly written (script or
 *                settings entry); false if everything was already in
 *                place
 */
export function installUpdatePromptHook(agentDir: string): InstallHookResult {
  const hooksDir = join(agentDir, ".claude", "hooks");
  mkdirSync(hooksDir, { recursive: true });
  const scriptPath = join(hooksDir, HOOK_FILENAME);
  const desired = updatePromptHookScript();
  let installed = false;
  const existing = existsSync(scriptPath) ? readFileSync(scriptPath, "utf-8") : "";
  if (existing !== desired) {
    writeFileSync(scriptPath, desired, { mode: 0o755 });
    chmodSync(scriptPath, 0o755);
    installed = true;
  } else {
    // Ensure executable bit even if content matched.
    try { chmodSync(scriptPath, 0o755); } catch {}
  }

  const settingsPath = join(agentDir, ".claude", "settings.json");
  if (!existsSync(settingsPath)) {
    // No settings.json yet — scaffold writes it. We'll be re-invoked on
    // the next apply pass once it exists.
    return { scriptPath, settingsPath, installed };
  }

  const raw = readFileSync(settingsPath, "utf-8");
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { scriptPath, settingsPath, installed };
  }
  const hooks = (parsed.hooks ??= {}) as Record<string, unknown>;
  // Claude Code's hooks shape: { UserPromptSubmit: [{ matcher?: string,
  // hooks: [{ type: "command", command: "..." }] }] }
  const list = Array.isArray(hooks.UserPromptSubmit)
    ? (hooks.UserPromptSubmit as Array<Record<string, unknown>>)
    : [];

  const expectedCommand = scriptPath;
  let alreadyPresent = false;
  for (const entry of list) {
    const inner = entry.hooks;
    if (!Array.isArray(inner)) continue;
    for (const h of inner) {
      if (h && typeof h === "object") {
        const cmd = (h as Record<string, unknown>).command;
        if (typeof cmd === "string" && cmd.includes(HOOK_FILENAME)) {
          alreadyPresent = true;
          break;
        }
      }
    }
    if (alreadyPresent) break;
  }

  if (!alreadyPresent) {
    list.push({
      hooks: [{ type: "command", command: expectedCommand }],
    });
    hooks.UserPromptSubmit = list;
    parsed.hooks = hooks;
    writeFileSync(settingsPath, JSON.stringify(parsed, null, 2) + "\n", { mode: 0o600 });
    installed = true;
  }

  return { scriptPath, settingsPath, installed };
}

// Re-export filename for tests.
export const UPDATE_PROMPT_HOOK_FILENAME = HOOK_FILENAME;
// `dirname` is imported to satisfy the eslint rule even though it's
// not currently used; future revisions may need it for path math.
void dirname;
