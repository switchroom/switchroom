import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  symlinkSync,
  copyFileSync,
  readdirSync,
  rmSync,
  statSync,
  lstatSync,
  readlinkSync,
} from "node:fs";
import { execSync } from "node:child_process";
import { join, resolve } from "node:path";
import chalk from "chalk";
import type { AgentConfig, QuotaConfig, SwitchroomConfig, TelegramConfig } from "../config/schema.js";

// Repo root for referencing bin/ scripts in hooks
const REPO_ROOT = resolve(import.meta.dirname, "../..");
import { DEFAULT_PROFILE } from "../config/schema.js";
import {
  resolveAgentConfig,
  translateHooksToClaudeShape,
  usesSwitchroomTelegramPlugin,
  deepMergeJson,
} from "../config/merge.js";
import {
  getProfilePath,
  getBaseProfilePath,
  renderTemplate,
  copyProfileSkills,
} from "./profiles.js";
import { getHindsightSettingsEntry, getSwitchroomMcpSettingsEntry } from "../memory/scaffold-integration.js";
import type { McpServerConfig } from "../memory/hindsight.js";
import { loadTopicState } from "../telegram/state.js";
import { resolveDualPath } from "../config/paths.js";
import { resolvePath } from "../config/loader.js";
import { isVaultReference, parseVaultReference } from "../vault/resolver.js";
import { openVault, VaultError } from "../vault/vault.js";
import {
  findExistingClaudeJson,
  copyOnboardingState,
  copyExistingCredentials,
  preTrustWorkspace,
  createMinimalClaudeConfig,
  loadUserConfig,
} from "../setup/onboarding.js";

export interface ScaffoldResult {
  agentDir: string;
  created: string[];
  skipped: string[];
}

/**
 * Resolve a bot token value. If it's a vault reference, try to resolve it
 * via SWITCHROOM_VAULT_PASSPHRASE or fall back to TELEGRAM_BOT_TOKEN env var.
 * Returns the resolved token or undefined if unresolvable.
 */
function resolveBotToken(rawToken: string): string | undefined {
  if (!isVaultReference(rawToken)) {
    return rawToken;
  }

  // Try vault resolution via passphrase. Static imports here (rather than
  // lazy require) so import-time errors surface loudly instead of falling
  // back silently to env vars and masking a real config problem.
  const passphrase = process.env.SWITCHROOM_VAULT_PASSPHRASE;
  if (passphrase) {
    try {
      const vaultPath = resolvePath(process.env.SWITCHROOM_VAULT_PATH ?? "~/.switchroom/vault.enc");
      const secrets = openVault(passphrase, vaultPath);
      const key = parseVaultReference(rawToken);
      const entry = secrets[key];
      if (entry && entry.kind === "string") {
        return entry.value;
      }
    } catch (err) {
      // Known "vault missing / wrong passphrase" outcomes are expected when
      // callers haven't set one up — fall through to env-var fallback. Any
      // other error is a real problem and should bubble up so the user sees
      // it instead of silently using a stale token from the environment.
      if (!(err instanceof VaultError)) throw err;
    }
  }

  // Fall back to TELEGRAM_BOT_TOKEN env var
  if (process.env.TELEGRAM_BOT_TOKEN) {
    return process.env.TELEGRAM_BOT_TOKEN;
  }

  return undefined;
}

/**
 * Set up plugin symlinks and config files in the agent's CLAUDE_CONFIG_DIR.
 *
 * Symlinks the official Telegram plugin marketplace from the user's global
 * ~/.claude/plugins/ and copies plugin config files if they exist.
 */
export function setupPlugins(agentDir: string): void {
  const home = process.env.HOME ?? "/root";
  const globalPluginsDir = join(home, ".claude", "plugins");
  const agentPluginsDir = join(agentDir, ".claude", "plugins");
  const agentMarketplacesDir = join(agentPluginsDir, "marketplaces");

  // Create plugin directories
  mkdirSync(agentMarketplacesDir, { recursive: true });

  // Symlink the official marketplace
  const globalMarketplace = join(globalPluginsDir, "marketplaces", "claude-plugins-official");
  const agentMarketplace = join(agentMarketplacesDir, "claude-plugins-official");

  if (existsSync(globalMarketplace) && !existsSync(agentMarketplace)) {
    try {
      symlinkSync(globalMarketplace, agentMarketplace);
    } catch { /* symlink may fail if target doesn't exist */ }
  }

  // Copy plugin config files if they exist
  const configFiles = ["installed_plugins.json", "known_marketplaces.json", "blocklist.json"];
  for (const file of configFiles) {
    const globalFile = join(globalPluginsDir, file);
    const agentFile = join(agentPluginsDir, file);
    if (existsSync(globalFile) && !existsSync(agentFile)) {
      try {
        copyFileSync(globalFile, agentFile);
      } catch { /* ignore copy failures */ }
    }
  }
}

/**
 * Pre-approved MCP tool names for the switchroom enhanced Telegram plugin.
 * When channels.telegram.plugin is "switchroom" we pre-approve these so the agent
 * never has to prompt for MCP tool permissions.
 */
const SWITCHROOM_TELEGRAM_MCP_TOOLS = [
  "mcp__switchroom-telegram",
  "mcp__switchroom-telegram__reply",
  "mcp__switchroom-telegram__stream_reply",
  "mcp__switchroom-telegram__react",
  "mcp__switchroom-telegram__edit_message",
  "mcp__switchroom-telegram__send_typing",
  "mcp__switchroom-telegram__pin_message",
  "mcp__switchroom-telegram__forward_message",
  "mcp__switchroom-telegram__download_attachment",
];

/**
 * Pre-approved MCP tool names for the Hindsight memory server.
 * When the memory backend is hindsight we pre-approve the wildcard so
 * the agent can recall and store memories without prompting.
 */
const HINDSIGHT_MCP_TOOLS = [
  "mcp__hindsight",
  "mcp__hindsight__*",
];

/**
 * Pre-approved MCP tool names for the switchroom management MCP server.
 * Lets agents call switchroom_agent_*, switchroom_auth_status, switchroom_memory_search
 * etc. without prompting.
 */
const SWITCHROOM_MCP_TOOLS = [
  "mcp__switchroom",
  "mcp__switchroom__*",
];

/**
 * Read-only built-in tools that are safe to pre-approve for every agent,
 * regardless of dangerous_mode. Discovering files, searching content, and
 * reading back data don't mutate host state, so gating them just adds
 * latency for no safety benefit.
 *
 * Risky tools (Bash, Edit, Write, WebFetch, WebSearch, NotebookEdit, and
 * anything that reaches the network or writes to disk) are deliberately
 * NOT in this list — they go through the standard permission prompt,
 * which in switchroom becomes the Telegram inline-button approval flow
 * via the plugin's permission_request notification handler.
 *
 * Used when the agent's tools.allow is empty AND dangerous_mode is
 * off/unset — otherwise explicit user config wins.
 */
const DEFAULT_READ_ONLY_PREAPPROVED_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "LS",
  "Task",
  "TodoWrite",
  "ExitPlanMode",
];

/**
 * Built-in Claude Code tools. When `tools.allow: [all]` is set in
 * switchroom.yaml, every one of these is pre-approved so the agent never
 * blocks on a permission prompt at runtime.
 *
 * Claude Code does NOT accept a literal "all" or "*" in permissions.allow,
 * which is why we have to enumerate. defaultMode: acceptEdits is also set
 * as a backstop, but it only auto-accepts file edits — Bash/Read/Write/
 * WebFetch all still prompt unless explicitly listed.
 */
/** Stable de-duplication preserving first-seen order. */
function dedupe<T>(items: T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/**
 * POSIX-safe single-quote wrapping for embedding a user-supplied string
 * in a generated shell script. Every embedded single-quote is replaced
 * with the `'"'"'` sequence, which closes the current single-quoted
 * literal, emits a double-quoted single quote, and reopens a new
 * single-quoted literal. Works with arbitrary bytes including
 * newlines, backticks, and dollar signs — the shell never interprets
 * the content.
 */
function shellSingleQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\"'\"'") + "'";
}

/**
 * Compose a template-generated file with an optional user sidecar.
 * Result = <rendered template>\n\n---\n\n<sidecar contents> if sidecar exists,
 * else just <rendered template>.
 */
function composeWithSidecar(renderedBase: string, sidecarPath: string): string {
  if (!existsSync(sidecarPath)) return renderedBase;
  const sidecar = readFileSync(sidecarPath, "utf-8").trimEnd();
  if (sidecar.length === 0) return renderedBase;
  return `${renderedBase.trimEnd()}\n\n---\n\n${sidecar}\n`;
}

/**
 * Build a pre-rendered Telegram HTML summary of an agent's effective
 * config. Written to `<agentDir>/telegram/session-greeting.sh` and
 * sent via curl on every SessionStart hook — zero model tokens.
 *
 * The script sources the bot token from `.env` at runtime (not baked
 * in) so secrets never land in a script file.
 */
function buildSessionGreetingScript(
  name: string,
  agentConfig: AgentConfig,
  telegramConfig: TelegramConfig,
  topicId: number | undefined,
  userId: string | undefined,
  quotaConfig: QuotaConfig | undefined,
): string {
  // Send to DM users AND the forum group (if topic is configured).
  // The DM is the primary channel for personal agents; the forum
  // topic is for multi-agent setups where each agent has its own topic.
  const dmChatIds = userId ? [userId] : [];
  const forumChatId = telegramConfig.forum_chat_id;

  const model = agentConfig.model
    ? agentConfig.model
    : "inherited from CLI";
  const profile = agentConfig.extends
    ? agentConfig.extends
    : "default";
  const tools = agentConfig.tools?.allow?.includes("all")
    ? "all"
    : (agentConfig.tools?.allow?.slice(0, 5).join(", ") ?? "none (default)")
      + ((agentConfig.tools?.allow?.length ?? 0) > 5
        ? ` +${(agentConfig.tools?.allow?.length ?? 0) - 5} more`
        : "");
  const deny = agentConfig.tools?.deny?.length
    ? agentConfig.tools.deny.join(", ")
    : null;
  const memory = agentConfig.memory?.collection ?? `${name} (default)`;
  const hooks = agentConfig.hooks
    ? Object.keys(agentConfig.hooks).join(", ")
    : null;
  // Cap visible skill names at 6 to stop the row from wrapping 4+ lines on
  // Telegram mobile. The agent's own self-knowledge is the authoritative
  // source for what skills it has; this is a status glance, not an
  // inventory.
  const skills = agentConfig.skills?.length
    ? (() => {
        const list = agentConfig.skills;
        const max = 6;
        if (list.length <= max) return list.join(", ");
        return `${list.slice(0, max).join(", ")}, …+${list.length - max} more`;
      })()
    : null;
  const session = [];
  if (agentConfig.session?.max_idle) session.push(`idle ${agentConfig.session.max_idle}`);
  if (agentConfig.session?.max_turns) session.push(`${agentConfig.session.max_turns} turns`);
  const sessionStr = session.length ? session.join(", ") : "unlimited (default)";
  const plugin = agentConfig.channels?.telegram?.plugin ?? "switchroom (default)";

  // Telegram HTML — keep it compact for mobile. Omit rows that are
  // null (unset with no interesting default to show).
  // __SWITCHROOM_MODEL__, __SWITCHROOM_AUTH__, and __SWITCHROOM_QUOTA__
  // are resolved at runtime by the shell script so the greeting always
  // reflects current state.
  const text = [
    `<b>🎛️ Switchroom · ${escapeHtml(name)} online</b>`,
    ``,
    `<b>Model</b>  __SWITCHROOM_MODEL__`,
    `<b>Auth</b>  __SWITCHROOM_AUTH__`,
    `<b>Quota</b>  __SWITCHROOM_QUOTA__`,
    `<b>Profile</b>  ${escapeHtml(profile)}`,
    `<b>Tools</b>  ${escapeHtml(tools)}`,
    deny ? `<b>Deny</b>  ${escapeHtml(deny)}` : null,
    `<b>Memory</b>  ${escapeHtml(memory)}`,
    hooks ? `<b>Hooks</b>  ${escapeHtml(hooks)}` : null,
    skills ? `<b>Skills</b>  ${escapeHtml(skills)}` : null,
    `<b>Session</b>  ${escapeHtml(sessionStr)}`,
    `<b>Channel</b>  ${escapeHtml(plugin)}`,
  ].filter(Boolean).join("\n");

  // Budget values baked into the script so the shell doesn't have to
  // re-read switchroom.yaml. Empty string = unset (raw usage shown).
  const weeklyBudget = quotaConfig?.weekly_budget_usd?.toString() ?? "";
  const monthlyBudget = quotaConfig?.monthly_budget_usd?.toString() ?? "";

  // Build curl calls for each destination. TEXT is a shell variable resolved
  // at runtime (after placeholder substitution), so we use $TEXT not a quoted literal.
  const curlTemplate = (destChatId: string, threadId?: number) => {
    const threadLine = threadId != null
      ? `\n  -d message_thread_id="${threadId}" \\`
      : "";
    return `curl -s "https://api.telegram.org/bot\${TELEGRAM_BOT_TOKEN}/sendMessage" \\
  -d chat_id="${destChatId}" \\${threadLine}
  -d parse_mode="HTML" \\
  -d disable_web_page_preview=true \\
  --data-urlencode text="$TEXT" > /dev/null 2>&1 || true`;
  };

  const curlCalls: string[] = [];
  // DM to each allowed user
  for (const uid of dmChatIds) {
    curlCalls.push(curlTemplate(uid));
  }
  // Forum group (with topic thread if configured)
  if (topicId != null) {
    curlCalls.push(curlTemplate(forumChatId, topicId));
  }

  return `#!/bin/bash
# Auto-generated by switchroom scaffold/reconcile. Sends config summary to
# Telegram on SessionStart. Zero model tokens — pure curl.
# Regenerated on every reconcile so config changes are reflected.

# Skip greeting for eval runs and one-shot claude -p calls.
[ "$SWITCHROOM_EVAL_MODE" = "1" ] && exit 0

# Source bot token at runtime (never baked into scripts).
source "$TELEGRAM_STATE_DIR/.env" 2>/dev/null
[ -z "$TELEGRAM_BOT_TOKEN" ] && exit 0

# Capture hook stdin once — used for dedupe (session_id) and model resolution.
HOOK_INPUT=""
if [ ! -t 0 ]; then HOOK_INPUT="$(cat 2>/dev/null || true)"; fi

# Skip greeting for session recycling: agents without --continue exit after
# each turn and systemd restarts them. Dedupe by comparing the gateway's
# current process start time against the last time we fired the greeting:
# if our marker is older than the running gateway, the gateway has
# restarted since we last greeted — send a fresh greeting.
#
# Why not socket inode? systemctl restart reuses the Unix socket file, so
# its inode is stable across restarts. An inode-based dedupe silently
# suppresses the greeting whenever we deploy via systemctl restart.
# Ken hit this repeatedly during the OpenClawification deploys.
#
# EXCEPTION: if a restart marker exists (written by /restart, /reconcile
# --restart, or /update), the user explicitly asked for a restart — fire
# the greeting regardless.
GATEWAY_SOCK="$TELEGRAM_STATE_DIR/gateway.sock"
RESTART_MARKER_FILE="$(dirname "$TELEGRAM_STATE_DIR")/restart-pending.json"
NOW=$(date +%s)
RESTART_REQUESTED=0
[ -f "$RESTART_MARKER_FILE" ] && RESTART_REQUESTED=1

# Resolve gateway process start time (epoch seconds) by finding the PID
# listening on the Unix socket and reading /proc/<pid>. Returns 0 if we
# can't find it, which disables the optimisation and always fires.
_gateway_start_time() {
  if [ ! -S "$GATEWAY_SOCK" ]; then echo 0; return; fi
  local pid
  # ss -xlnp is the cheap path (no /proc walk); falls through to lsof if ss absent.
  # Uses sed (POSIX-portable) to extract the pid; avoids gawk's
  # match(regex, arr) three-arg form which fails on plain awk with
  # "syntax error at or near ," on minimal images (alpine, busybox).
  pid=$(ss -xlnp 2>/dev/null | grep -F "$GATEWAY_SOCK" | sed -n 's|.*pid=\\([0-9]\\{1,\\}\\).*|\\1|p' | head -1)
  if [ -z "$pid" ] && command -v lsof >/dev/null 2>&1; then
    pid=$(lsof -t "$GATEWAY_SOCK" 2>/dev/null | head -1)
  fi
  if [ -z "$pid" ] || [ ! -d "/proc/$pid" ]; then echo 0; return; fi
  stat -c %Y "/proc/$pid" 2>/dev/null || echo 0
}

if [ -S "$GATEWAY_SOCK" ]; then
  GATEWAY_STARTED_AT=$(_gateway_start_time)
  GREETED_MARKER_FILE="$TELEGRAM_STATE_DIR/greeted-gateway-start"
  GREETED_AT=0
  [ -f "$GREETED_MARKER_FILE" ] && GREETED_AT=$(cat "$GREETED_MARKER_FILE" 2>/dev/null || echo 0)
  # Treat non-numeric reads as 0 so a corrupt marker re-fires rather than silently suppressing forever.
  case "$GREETED_AT" in ''|*[!0-9]*) GREETED_AT=0 ;; esac
  case "$GATEWAY_STARTED_AT" in ''|*[!0-9]*) GATEWAY_STARTED_AT=0 ;; esac
  # Skip only if: no explicit restart request AND we have a usable gateway
  # start time AND we've already greeted *for this gateway process lifetime*.
  if [ "$RESTART_REQUESTED" = "0" ] \
     && [ "$GATEWAY_STARTED_AT" -gt 0 ] \
     && [ "$GREETED_AT" -ge "$GATEWAY_STARTED_AT" ]; then
    exit 0
  fi
  printf '%s' "$NOW" > "$GREETED_MARKER_FILE" 2>/dev/null || true
fi

# Idempotency guard: Claude Code fires SessionStart multiple times on some
# restart paths. Use a 60s time-window marker instead of per-session-id dedup.
# The 30s window that shipped originally was occasionally short enough that
# the second fire slipped through when the greeting itself took >20s (large
# transcript archives, cold npx cache). 60s gives enough margin for the
# full greeting latency plus a buffer. If two legitimate restarts happen
# within 60s we just skip the second greeting — a small UX cost for
# deterministic no-dupe behaviour.
# Atomic via mkdir so concurrent invocations race cleanly.
GREETING_MARKER="$TELEGRAM_STATE_DIR/greeting-lock"
if [ -d "$GREETING_MARKER" ]; then
  LAST=$(stat -c %Y "$GREETING_MARKER" 2>/dev/null || echo 0)
  if [ $((NOW - LAST)) -lt 60 ]; then
    exit 0
  fi
  rmdir "$GREETING_MARKER" 2>/dev/null || true
fi
mkdir "$GREETING_MARKER" 2>/dev/null || exit 0

# Resolve the active model from SessionStart hook stdin.
# Fallback chain: hook .model → current transcript → newest transcript
# across this project's JSONLs → user default from ~/.claude.json → cache.
MODEL=""
CWD=""
if command -v jq >/dev/null 2>&1 && [ -n "$HOOK_INPUT" ]; then
  MODEL="$(printf '%s' "$HOOK_INPUT" | jq -r '.model // empty' 2>/dev/null)"
  CWD="$(printf '%s' "$HOOK_INPUT" | jq -r '.cwd // empty' 2>/dev/null)"
  if [ -z "$MODEL" ]; then
    TRANSCRIPT="$(printf '%s' "$HOOK_INPUT" | jq -r '.transcript_path // empty' 2>/dev/null)"
    if [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ]; then
      MODEL="$(grep -o '"model":"[^"]*"' "$TRANSCRIPT" | tail -1 | cut -d'"' -f4)"
    fi
  fi
fi
[ -z "$CWD" ] && CWD="$PWD"
if [ -z "$MODEL" ]; then
  CONFIG_DIR="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
  ENCODED="$(printf '%s' "$CWD" | sed 's|/|-|g')"
  PROJECT_DIR="$CONFIG_DIR/projects/$ENCODED"
  if [ -d "$PROJECT_DIR" ]; then
    while IFS= read -r f; do
      [ -z "$f" ] && continue
      CANDIDATE="$(grep -o '"model":"[^"]*"' "$f" | tail -1 | cut -d'"' -f4)"
      if [ -n "$CANDIDATE" ]; then MODEL="$CANDIDATE"; break; fi
    done <<< "$(ls -t "$PROJECT_DIR"/*.jsonl 2>/dev/null)"
  fi
fi
if [ -z "$MODEL" ] && command -v jq >/dev/null 2>&1 && [ -f "$HOME/.claude.json" ]; then
  MODEL="$(jq -r '.model // empty' "$HOME/.claude.json" 2>/dev/null)"
fi
MODEL_CACHE="$TELEGRAM_STATE_DIR/last-model"
if [ -z "$MODEL" ] && [ -f "$MODEL_CACHE" ]; then
  MODEL="$(cat "$MODEL_CACHE" 2>/dev/null)"
fi
[ -z "$MODEL" ] && MODEL="default"
printf '%s' "$MODEL" > "$MODEL_CACHE" 2>/dev/null || true

# Resolve auth status from token files at runtime.
# Prefer .oauth-token (the authoritative token after switchroom auth code)
# but merge in subscriptionType + rateLimitTier from .credentials.json when
# both files exist — the oauth-token flow alone does not carry plan metadata.
AUTH_STATUS=""
CLAUDE_DIR="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
if command -v jq >/dev/null 2>&1; then
  SUB=""
  TIER=""
  if [ -f "$CLAUDE_DIR/.credentials.json" ]; then
    SUB="$(jq -r '.claudeAiOauth.subscriptionType // empty' "$CLAUDE_DIR/.credentials.json" 2>/dev/null)"
    TIER="$(jq -r '.claudeAiOauth.rateLimitTier // empty' "$CLAUDE_DIR/.credentials.json" 2>/dev/null)"
  fi
  if [ -f "$CLAUDE_DIR/.oauth-token" ] && [ -f "$CLAUDE_DIR/.oauth-token.meta.json" ]; then
    EXP_AT="$(jq -r '.expiresAt // empty' "$CLAUDE_DIR/.oauth-token.meta.json" 2>/dev/null)"
    PLAN="\${SUB:-oauth}"
    if [ -n "$EXP_AT" ]; then
      NOW_MS=$(($(date +%s) * 1000))
      REM_MS=$((EXP_AT - NOW_MS))
      if [ "$REM_MS" -gt 0 ]; then
        REM_H=$((REM_MS / 3600000))
        REM_M=$(((REM_MS % 3600000) / 60000))
        AUTH_STATUS="✓ \${PLAN} · expires \${REM_H}h \${REM_M}m"
      else
        AUTH_STATUS="⚠️ \${PLAN} token expired"
      fi
    else
      AUTH_STATUS="✓ \${PLAN}"
    fi
  elif [ -f "$CLAUDE_DIR/.credentials.json" ]; then
    EXP_AT="$(jq -r '.claudeAiOauth.expiresAt // empty' "$CLAUDE_DIR/.credentials.json" 2>/dev/null)"
    if [ -n "$EXP_AT" ]; then
      NOW_MS=$(($(date +%s) * 1000))
      REM_MS=$((EXP_AT - NOW_MS))
      if [ "$REM_MS" -gt 0 ]; then
        REM_H=$((REM_MS / 3600000))
        REM_M=$(((REM_MS % 3600000) / 60000))
        AUTH_STATUS="✓ \${SUB:-credentials} · expires \${REM_H}h \${REM_M}m"
      else
        AUTH_STATUS="⚠️ credentials expired"
      fi
    else
      AUTH_STATUS="✓ \${SUB:-credentials}"
    fi
  elif [ -f "$CLAUDE_DIR/.oauth-token" ]; then
    # Only the token file exists — no metadata sidecar, no .credentials.json.
    # Klanker hit this because its OAuth was set up without the newer flow
    # that writes .oauth-token.meta.json. Show the agent is authed even
    # without expiry/plan details; showing "—" was misleading.
    AUTH_STATUS="✓ authed"
  fi
fi
[ -z "$AUTH_STATUS" ] && AUTH_STATUS="—"

# Resolve Claude quota usage (week + month) via ccusage — parses local
# transcripts, no network call. Anthropic exposes no subscription-quota
# endpoint, so this is usage-tracked-locally, optionally compared
# against budgets baked in from switchroom.yaml.
QUOTA_STATUS=""
WEEKLY_BUDGET="${weeklyBudget}"
MONTHLY_BUDGET="${monthlyBudget}"
if command -v jq >/dev/null 2>&1 && command -v npx >/dev/null 2>&1; then
  WK_COST=""
  MO_COST=""
  # Belt-and-braces: ccusage scans $CLAUDE_CONFIG_DIR/projects by default.
  # SessionStart hooks inherit CLAUDE_CONFIG_DIR from the claude process in
  # theory, but if the env is ever lost (different claude version,
  # container, manual test) we'd silently query ~/.claude instead of the
  # agent's own transcripts. Set it explicitly so the hook is deterministic.
  export CLAUDE_CONFIG_DIR="\${CLAUDE_CONFIG_DIR:-\$(dirname \"\$TELEGRAM_STATE_DIR\")/.claude}"
  # --offline avoids a pricing-data fetch; cached data is accurate enough
  # for a status line. Both commands are bounded by a short timeout so a
  # slow ccusage run can never block the greeting hook past a few seconds.
  WK_JSON="$(timeout 8 npx --yes ccusage@latest weekly --json --offline 2>/dev/null || true)"
  if [ -n "$WK_JSON" ]; then
    WK_COST="$(printf '%s' "$WK_JSON" | jq -r '.weekly[-1].totalCost // empty' 2>/dev/null)"
  fi
  MO_JSON="$(timeout 8 npx --yes ccusage@latest monthly --json --offline 2>/dev/null || true)"
  if [ -n "$MO_JSON" ]; then
    MO_COST="$(printf '%s' "$MO_JSON" | jq -r '.monthly[-1].totalCost // empty' 2>/dev/null)"
  fi
  fmt_usage() {
    local cost="$1" budget="$2" label="$3"
    [ -z "$cost" ] && cost="0"
    if [ -n "$budget" ]; then
      local pct
      pct="$(awk -v c="$cost" -v b="$budget" 'BEGIN { if (b > 0) printf "%.0f", (c / b) * 100; else printf "0" }')"
      printf '%s $%.2f / $%s (%s%%)' "$label" "$cost" "$budget" "$pct"
    else
      printf '%s $%.2f' "$label" "$cost"
    fi
  }
  if [ -n "$WK_COST" ] || [ -n "$MO_COST" ]; then
    WK_PART="$(fmt_usage "$WK_COST" "$WEEKLY_BUDGET" "wk")"
    MO_PART="$(fmt_usage "$MO_COST" "$MONTHLY_BUDGET" "mo")"
    QUOTA_STATUS="$WK_PART · $MO_PART"
  fi
fi
[ -z "$QUOTA_STATUS" ] && QUOTA_STATUS="—"

TEXT=${shellSingleQuote(text)}
TEXT="\${TEXT//__SWITCHROOM_MODEL__/$MODEL}"
TEXT="\${TEXT//__SWITCHROOM_AUTH__/$AUTH_STATUS}"
TEXT="\${TEXT//__SWITCHROOM_QUOTA__/$QUOTA_STATUS}"

${curlCalls.join("\n\n")}
`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Parse a duration string like "2h", "30m", "7200s" into seconds.
 * Returns undefined for undefined input.
 */
function parseDurationToSeconds(d: string | undefined): number | undefined {
  if (!d) return undefined;
  const match = d.match(/^(\d+)([smh])$/);
  if (!match) return undefined;
  const n = parseInt(match[1], 10);
  switch (match[2]) {
    case "s": return n;
    case "m": return n * 60;
    case "h": return n * 3600;
    default: return undefined;
  }
}

/**
 * Build a one-shot cron script for a scheduled task. Runs `claude -p`
 * with the configured model, sends output to Telegram via curl.
 * The script is self-contained — sources nvm, reads bot token from
 * .env at runtime, and uses POSIX quoting for the prompt.
 */
function buildCronScript(
  agentDir: string,
  prompt: string,
  model: string,
  chatId: string,
  userId: string | undefined,
): string {
  const dest = userId ?? chatId;
  return `#!/bin/bash
# Auto-generated by switchroom scaffold/reconcile.
# One-shot scheduled task — runs claude -p, sends output to Telegram.

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
export PATH="$HOME/.bun/bin:$PATH"

cd ${shellSingleQuote(agentDir)}

# Run Claude one-shot (no persistent session, cheap model)
OUTPUT=$(claude -p ${shellSingleQuote(prompt)} \\
  --model ${shellSingleQuote(model)} \\
  --no-session-persistence \\
  2>/dev/null)

[ -z "$OUTPUT" ] && exit 0

# Send to Telegram
source "telegram/.env" 2>/dev/null
[ -z "$TELEGRAM_BOT_TOKEN" ] && exit 0

curl -s "https://api.telegram.org/bot\${TELEGRAM_BOT_TOKEN}/sendMessage" \\
  -d chat_id=${shellSingleQuote(dest)} \\
  -d parse_mode="HTML" \\
  -d disable_web_page_preview=true \\
  --data-urlencode text="$OUTPUT" > /dev/null 2>&1 || true
`;
}

/**
 * Resolve the global switchroom skills pool directory. Honors the optional
 * `switchroom.skills_dir` override in switchroom.yaml and falls back to
 * `~/.switchroom/skills`. Expands a leading `~/` against $HOME.
 */
function resolveSkillsPoolDir(override: string | undefined): string {
  return resolveDualPath(override ?? "~/.switchroom/skills");
}

/**
 * Remove symlinks from the legacy <agentDir>/skills/ directory that point
 * into the global skills pool. Claude Code never discovered them there, so
 * they were dead weight — we clear them on reconcile after migration so a
 * user's agent dir ends up clean. Real files (profile-bundled skills copied
 * before migration) are left in place.
 */
function migrateLegacySkillsDir(agentDir: string, skillsPool: string): void {
  const legacyDir = join(agentDir, "skills");
  let entries: string[];
  try {
    entries = readdirSync(legacyDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const entryPath = join(legacyDir, entry);
    let target: string | null = null;
    try {
      target = readlinkSync(entryPath);
    } catch {
      continue; // not a symlink — leave it
    }
    if (target && target.startsWith(skillsPool)) {
      try {
        rmSync(entryPath, { force: true });
      } catch { /* best effort */ }
    }
  }
}

/**
 * Sync the set of global-skill symlinks in an agent's .claude/skills/
 * directory against the user's declared `skills:` list (already merged with
 * defaults). Idempotent and safe to call on reconcile:
 *
 *   - Missing links for declared skills are created.
 *   - Stale links whose target no longer appears in the list are
 *     removed. Only symlinks are ever removed — real files/directories
 *     from the template's copySkills pass are untouched.
 *   - Missing pool entries (user listed a skill that doesn't exist at
 *     <skills_dir>/<name>) produce a warning but don't throw — this is
 *     a non-fatal configuration lint.
 */
function syncGlobalSkills(
  agentDir: string,
  declared: string[],
  skillsDirOverride: string | undefined,
): void {
  const skillsPool = resolveSkillsPoolDir(skillsDirOverride);
  // Claude Code only discovers skills under $CLAUDE_CONFIG_DIR/.claude/skills/.
  // Symlink there so declared skills actually surface in available-skills.
  const agentSkillsDir = join(agentDir, ".claude", "skills");
  mkdirSync(agentSkillsDir, { recursive: true });

  // Migrate any pre-existing symlinks from the legacy <agentDir>/skills/
  // location (pre-.claude/skills migration) so reconcile cleanly relocates
  // them instead of leaving orphaned links behind.
  migrateLegacySkillsDir(agentDir, skillsPool);

  // Create symlinks for each declared skill. Skip entries that are
  // already correct; replace ones pointing at the wrong target.
  for (const name of declared) {
    if (!name || name.includes("/") || name === "." || name === "..") {
      console.warn(`  WARNING: invalid skill name "${name}" — skipping`);
      continue;
    }
    const src = join(skillsPool, name);
    const dest = join(agentSkillsDir, name);
    if (!existsSync(src)) {
      console.warn(
        `  WARNING: skill "${name}" not found in pool (${skillsPool}) — skipping`,
      );
      continue;
    }
    // If dest exists and is a symlink to the right target, leave it.
    // If dest exists as a real file/dir (e.g. from profile copySkills),
    // also leave it — profile-bundled skills take priority over the
    // pool to avoid silent surprises. Use lstatSync so broken symlinks
    // are detected (statSync would follow them and throw, falsely
    // indicating the path is free).
    let linkStat;
    try {
      linkStat = lstatSync(dest);
    } catch {
      linkStat = null;
    }
    if (linkStat) {
      // Broken symlink into the pool: replace it (the old target is
      // gone, so we can safely recreate). Anything else: leave alone.
      if (linkStat.isSymbolicLink()) {
        let target: string | null = null;
        try {
          target = readlinkSync(dest);
        } catch { /* unreadable; leave alone */ }
        if (target && target.startsWith(skillsPool)) {
          try {
            rmSync(dest, { force: true });
          } catch { /* best effort */ }
        } else {
          continue;
        }
      } else {
        continue;
      }
    }
    try {
      symlinkSync(src, dest);
    } catch (err) {
      console.warn(
        `  WARNING: failed to symlink skill "${name}": ${(err as Error).message}`,
      );
    }
  }

  // Clean up stale symlinks — ones that point into the skills pool but
  // aren't in the current declared set. Real files and symlinks that
  // point elsewhere are left untouched.
  const declaredSet = new Set(declared);
  for (const entry of readdirSync(agentSkillsDir)) {
    if (declaredSet.has(entry)) continue;
    const entryPath = join(agentSkillsDir, entry);
    let linkTarget: string | null = null;
    try {
      linkTarget = readlinkSync(entryPath);
    } catch {
      continue; // not a symlink
    }
    if (linkTarget && linkTarget.startsWith(skillsPool)) {
      rmSync(entryPath, { force: true });
    }
  }
}

/**
 * Symlink every switchroom-* skill from the switchroom project's built-in skills/
 * directory into <agentDir>/.claude/skills/<name>.
 *
 * This runs unconditionally on every scaffold/reconcile so all agents
 * automatically get the management skills (switchroom-cli, switchroom-health,
 * etc.) without needing to list them in switchroom.yaml.
 *
 * Rules:
 *   - Only directories that start with "switchroom-" and contain a SKILL.md
 *     file are linked.
 *   - The destination .claude/skills/ directory is created if absent.
 *   - Existing entries at the destination are left untouched (idempotent).
 */
export function installSwitchroomSkills(agentDir: string): void {
  const builtinSkillsDir = resolve(import.meta.dirname, "../../skills");
  if (!existsSync(builtinSkillsDir)) return;

  const targetDir = join(agentDir, ".claude", "skills");
  mkdirSync(targetDir, { recursive: true });

  let entries: string[];
  try {
    entries = readdirSync(builtinSkillsDir);
  } catch {
    return;
  }

  for (const name of entries) {
    if (!name.startsWith("switchroom-")) continue;
    const src = join(builtinSkillsDir, name);
    // Only link directories that contain SKILL.md
    let srcStat;
    try {
      srcStat = lstatSync(src);
    } catch {
      continue;
    }
    if (!srcStat.isDirectory()) continue;
    if (!existsSync(join(src, "SKILL.md"))) continue;

    const dest = join(targetDir, name);
    // Idempotent: leave correctly-pointing symlinks and real dirs alone.
    // But refresh stale symlinks whose target is a different switchroom-
    // lookalike path (e.g. old clerk/skills/ after the clerk→switchroom
    // rename). Otherwise reconcile can't heal a botched cross-repo state.
    let existing;
    try {
      existing = lstatSync(dest);
    } catch {
      existing = null;
    }
    if (existing) {
      if (existing.isSymbolicLink()) {
        let currentTarget: string | null = null;
        try {
          currentTarget = readlinkSync(dest);
        } catch { /* unreadable */ }
        if (currentTarget === src) continue; // already correct
        try {
          rmSync(dest, { force: true });
        } catch { /* best effort; symlinkSync below will error cleanly */ }
      } else {
        continue; // real file/dir — don't touch
      }
    }
    try {
      symlinkSync(src, dest);
    } catch (err) {
      console.warn(
        `  WARNING: failed to symlink switchroom skill "${name}": ${(err as Error).message}`,
      );
    }
  }
}

/**
 * Translate per-channel YAML fields into env vars the telegram-plugin
 * will read at startup. Today: SWITCHROOM_TG_FORMAT, SWITCHROOM_TG_RATE_LIMIT_MS,
 * SWITCHROOM_TG_STREAM_MODE.
 *
 * Returns an object that can be merged into the user env. User-declared
 * env vars with the same key take precedence (see the call site) since
 * an explicit `env:` entry is a more precise signal than a channel
 * default.
 */
function channelsToEnv(agent: AgentConfig): Record<string, string> {
  const out: Record<string, string> = {};
  const tg = agent.channels?.telegram;
  if (!tg) return out;
  if (tg.format !== undefined) out.SWITCHROOM_TG_FORMAT = tg.format;
  if (tg.rate_limit_ms !== undefined) {
    out.SWITCHROOM_TG_RATE_LIMIT_MS = String(tg.rate_limit_ms);
  }
  if (tg.stream_mode !== undefined) {
    out.SWITCHROOM_TG_STREAM_MODE = tg.stream_mode;
  }
  return out;
}

/**
 * Top-level settings.json keys that switchroom's scaffold/reconcile
 * pipeline owns and rebuilds on every run. When the settings_raw
 * escape hatch injects additional top-level keys (e.g. `effort`,
 * `apiKeyHelper`), they're tracked via the `_switchroomManagedRawKeys`
 * side-car so reconcile can retract them if the user removes them
 * from switchroom.yaml. Keys in this set are never retracted because the
 * scaffold path rebuilds them deterministically from switchroom.yaml.
 */
const SWITCHROOM_OWNED_SETTINGS_KEYS = new Set<string>([
  "permissions",
  "mcpServers",
  "enabledPlugins",
  "autoMemoryEnabled",
  "skipDangerousModePermissionPrompt",
  "hooks",
  "model",
]);

const ALL_BUILTIN_TOOLS = [
  "Bash",
  "BashOutput",
  "KillBash",
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
  "Task",
  "Agent",
  "ExitPlanMode",
];

/**
 * Recursively copy a directory tree, overwriting existing files. Used to
 * deploy vendored plugin files into each agent's .claude/plugins/ dir.
 */
function copyDirRecursive(src: string, dest: string): void {
  if (!existsSync(src)) return;
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    const s = statSync(srcPath);
    if (s.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
      // Preserve executable bit for hook scripts (cleared on copy by default)
      if (s.mode & 0o100) {
        chmodSync(destPath, s.mode);
      }
    }
  }
}

/**
 * Seed the agent's `workspace/` directory from the profile's `workspace/`
 * subdirectory (if any). `.hbs` files are rendered with the handlebars
 * context; everything else is copied verbatim. Existing files are preserved
 * so user edits survive `switchroom reconcile` runs.
 *
 * Profiles should put OpenClaw-style bootstrap files (AGENTS.md, USER.md,
 * IDENTITY.md, TOOLS.md, MEMORY.md, ...) under their `workspace/` dir. At
 * runtime, `loadStableBootstrapFiles` / `loadDynamicBootstrapFiles` in
 * `src/agents/workspace.ts` discover and inject these files into Claude's
 * system prompt (stable) and per-turn context (dynamic).
 */
function seedWorkspaceBootstrapFiles(params: {
  profilePath: string;
  agentDir: string;
  context: Record<string, unknown>;
  created: string[];
  skipped: string[];
}): void {
  const profileWorkspaceDir = join(params.profilePath, "workspace");
  if (!existsSync(profileWorkspaceDir)) {
    return;
  }
  const agentWorkspaceDir = join(params.agentDir, "workspace");
  mkdirSync(agentWorkspaceDir, { recursive: true });

  const walk = (relDir: string): void => {
    const srcDir = join(profileWorkspaceDir, relDir);
    if (!existsSync(srcDir)) return;
    for (const entry of readdirSync(srcDir)) {
      if (entry.startsWith(".") && entry !== ".gitkeep") continue;
      const relPath = relDir ? join(relDir, entry) : entry;
      const srcPath = join(profileWorkspaceDir, relPath);
      const srcStat = statSync(srcPath);
      if (srcStat.isDirectory()) {
        mkdirSync(join(agentWorkspaceDir, relPath), { recursive: true });
        walk(relPath);
        continue;
      }
      if (entry === ".gitkeep") continue; // presence-only marker, ignore
      if (entry.endsWith(".hbs")) {
        const destRel = relPath.replace(/\.hbs$/, "");
        writeIfMissing(
          join(agentWorkspaceDir, destRel),
          () => {
            const rendered = renderTemplate(srcPath, params.context);
            // Phase 2: append SOUL.custom.md sidecar if present
            if (destRel === "SOUL.md") {
              const customSoulPath = join(agentWorkspaceDir, "SOUL.custom.md");
              return composeWithSidecar(rendered, customSoulPath);
            }
            return rendered;
          },
          params.created,
          params.skipped,
        );
      } else {
        const destPath = join(agentWorkspaceDir, relPath);
        if (!existsSync(destPath)) {
          copyFileSync(srcPath, destPath);
          params.created.push(destPath);
        } else {
          params.skipped.push(destPath);
        }
      }
    }
  };
  walk("");
}

/**
 * Initialize the workspace directory as a git repository (if git is available).
 * Creates .gitignore to exclude regenerables (SOUL.md) and ephemeral state (*.log),
 * then makes an initial commit capturing the seeded template content.
 *
 * Degrades gracefully if git is not on PATH. Returns true if init succeeded.
 */
function initWorkspaceGitRepo(
  workspaceDir: string,
  agentName: string,
): boolean {
  // Check git availability
  try {
    execSync("command -v git", { stdio: "ignore" });
  } catch {
    console.log(chalk.dim("  git not available, workspace versioning disabled"));
    return false;
  }

  // Skip if already a git repo
  const gitDir = join(workspaceDir, ".git");
  if (existsSync(gitDir)) {
    return true;
  }

  // Write .gitignore before git init
  const gitignore = `# Regenerated from switchroom.yaml on every reconcile
SOUL.md

# Ephemeral runtime state
*.log

# OS/editor noise
.DS_Store
Thumbs.db
*.swp
*~
`;
  writeFileSync(join(workspaceDir, ".gitignore"), gitignore, "utf-8");

  // Initialize repo
  try {
    execSync("git init --quiet", { cwd: workspaceDir, stdio: "pipe" });
    execSync("git add -A", { cwd: workspaceDir, stdio: "pipe" });

    // Use switchroom's git identity if available from env, else fall back to generic
    const userEmail = process.env.GIT_AUTHOR_EMAIL || "switchroom@localhost";
    const userName = process.env.GIT_AUTHOR_NAME || "Switchroom Agent";

    execSync(
      `git -c user.email="${userEmail}" -c user.name="${userName}" commit -m "chore: seed workspace from switchroom scaffold"`,
      { cwd: workspaceDir, stdio: "pipe" }
    );

    console.log(chalk.green(`  initialized workspace git repo (${agentName})`));
    return true;
  } catch (err) {
    // Non-fatal: workspace still usable without git
    console.log(chalk.dim(`  workspace git init failed: ${err instanceof Error ? err.message : String(err)}`));
    return false;
  }
}

/**
 * Vendored hindsight-memory plugin location inside the switchroom repo.
 * Pinned to the version we ship; updated by `switchroom update`.
 */
function resolveHindsightVendorPath(): string {
  return resolve(import.meta.dirname, "../../vendor/hindsight-memory");
}

/**
 * Result of installing the vendored hindsight-memory plugin into an agent.
 */
export interface HindsightPluginInstall {
  pluginDir: string;
  apiBaseUrl: string;
  bankId: string;
}

/**
 * Install (or refresh) the vendored hindsight-memory plugin for an agent.
 *
 * Copies the plugin tree into <agentDir>/.claude/plugins/hindsight-memory/
 * and returns the metadata needed by the start.sh template to set
 * env vars and the --plugin-dir flag.
 *
 * Returns null when:
 *  - switchroom.yaml memory backend is not hindsight
 *  - the agent has memory.auto_recall: false
 *  - the vendored plugin source isn't present (e.g., bare switchroom install
 *    without the vendor dir)
 *
 * The plugin reads its config from environment variables (HINDSIGHT_*)
 * which start.sh exports — see templates/_base/start.sh.hbs.
 */
export function installHindsightPlugin(
  agentName: string,
  agentDir: string,
  switchroomConfig: SwitchroomConfig | undefined,
): HindsightPluginInstall | null {
  if (!switchroomConfig) return null;
  const memory = switchroomConfig.memory;
  if (memory?.backend !== "hindsight") return null;

  const agentMemory = switchroomConfig.agents[agentName]?.memory;
  if (agentMemory?.auto_recall === false) return null;

  const sourcePath = resolveHindsightVendorPath();
  if (!existsSync(sourcePath)) {
    return null;
  }

  // Copy the vendored plugin into the agent's .claude/plugins dir.
  // Force overwrite on every reconcile so plugin updates from
  // `switchroom update` propagate.
  const destPath = join(agentDir, ".claude", "plugins", "hindsight-memory");
  if (existsSync(destPath)) {
    rmSync(destPath, { recursive: true, force: true });
  }
  copyDirRecursive(sourcePath, destPath);

  // Resolve the agent's bank/collection name and the Hindsight REST URL.
  // The plugin's hooks expect HINDSIGHT_API_URL (the REST base), not the
  // /mcp/ MCP endpoint URL — strip the suffix.
  const bankId = agentMemory?.collection ?? agentName;
  const mcpUrl = (memory.config?.url as string | undefined)
    ?? "http://127.0.0.1:8888/mcp/";
  const apiBaseUrl = mcpUrl.replace(/\/mcp\/?$/, "").replace(/\/$/, "");

  return { pluginDir: destPath, apiBaseUrl, bankId };
}

/**
 * Attempt to locate the switchroom CLI binary. Used to populate SWITCHROOM_CLI_PATH
 * in the .mcp.json env for the switchroom-telegram MCP server. Falls back to
 * the literal string "switchroom" if `which switchroom` is unavailable.
 */
function resolveSwitchroomCliPath(): string {
  try {
    const result = execSync("which switchroom", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    if (result) {
      return result;
    }
  } catch {
    /* switchroom not on PATH */
  }
  return "switchroom";
}

/**
 * Scaffold (or reconcile) the directory structure for a single agent.
 *
 * Idempotent: creates missing files and directories but never overwrites
 * existing ones.
 */
/**
 * Inputs for {@link buildWorkspaceContext}. Shared shape used by both
 * `scaffoldAgent` (full-context builder for start.sh / settings.json /
 * workspace templates) and `reconcileAgent` (workspace re-seed path).
 *
 * Keeping one source of truth means a new handlebars key added to any
 * workspace template automatically resolves identically on both paths —
 * closing the gap where `reconcileAgent` used to rebuild a 7-key subset
 * and silently render `""` for anything else.
 */
interface BuildWorkspaceContextArgs {
  name: string;
  agentDir: string;
  agentConfig: AgentConfig;
  telegramConfig: TelegramConfig;
  switchroomConfig?: SwitchroomConfig;
  switchroomConfigPath?: string;
  topicId?: number;
  tools: { allow?: string[]; deny?: string[] };
  permissionAllow: string[];
  hasAllWildcard: boolean;
  resolvedBotToken?: string;
  rawBotToken?: string;
  hindsightAutoRecallEnabled: boolean;
  hindsightBankId: string;
  hindsightApiBaseUrl: string;
}

/**
 * Build the handlebars render context used for profile templates
 * (start.sh, settings.json) AND workspace bootstrap templates
 * (AGENTS.md, SOUL.md, ...). Both scaffold and reconcile call this so
 * new workspace-template keys stay in lockstep across the two paths.
 */
function buildWorkspaceContext(args: BuildWorkspaceContextArgs): Record<string, unknown> {
  const {
    name,
    agentDir,
    agentConfig,
    telegramConfig,
    switchroomConfigPath,
    topicId,
    tools,
    permissionAllow,
    hasAllWildcard,
    resolvedBotToken,
    rawBotToken,
    hindsightAutoRecallEnabled,
    hindsightBankId,
    hindsightApiBaseUrl,
  } = args;
  return {
    name,
    agentDir,
    topicId,
    topicName: agentConfig.topic_name,
    topicEmoji: agentConfig.topic_emoji,
    soul: agentConfig.soul,
    user: (agentConfig as unknown as { user?: unknown }).user,
    agentConfig,
    tools,
    toolsDeny: tools.deny ?? [],
    permissionAllow,
    defaultModeAcceptEdits: hasAllWildcard,
    memory: agentConfig.memory,
    model: agentConfig.model,
    mcpServers: agentConfig.mcp_servers,
    schedule: agentConfig.schedule,
    botToken: resolvedBotToken ?? rawBotToken,
    forumChatId: telegramConfig.forum_chat_id,
    dangerousMode: agentConfig.dangerous_mode === true,
    skipPermissionPrompt: agentConfig.skip_permission_prompt === true,
    useSwitchroomPlugin: usesSwitchroomTelegramPlugin(agentConfig),
    useHotReloadStable: agentConfig.channels?.telegram?.hotReloadStable === true,
    hindsightEnabled: hindsightAutoRecallEnabled,
    hindsightBankIdQ: shellSingleQuote(hindsightBankId),
    hindsightApiBaseUrlQ: shellSingleQuote(hindsightApiBaseUrl),
    switchroomConfigPathQ: switchroomConfigPath
      ? shellSingleQuote(resolve(switchroomConfigPath))
      : undefined,
    modelQ: agentConfig.model ? shellSingleQuote(agentConfig.model) : undefined,
    userEnvQuoted: (() => {
      const combined = { ...channelsToEnv(agentConfig), ...(agentConfig.env ?? {}) };
      if (Object.keys(combined).length === 0) return undefined;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(combined)) {
        out[k] = shellSingleQuote(v);
      }
      return out;
    })(),
    systemPromptAppendShellQuoted: (() => {
      const useSwitchroomPlugin = usesSwitchroomTelegramPlugin(agentConfig);
      const baseAppend = agentConfig.system_prompt_append ?? '';
      const telegramGuidance = `## Progress updates (human-style check-ins)

You're talking to a human colleague on Telegram. Alongside the emoji status
ladder, send a short \`progress_update\` at inflection points, the moments a
senior colleague would ping the person who asked them to do something:

- **Plan formed:** "Got it. Going to do X first, then Y, then Z."
- **Pivot or blocker:** "First approach didn't work because <reason>. Trying
  <alternative> instead."
- **Chunk finished:** "Done with X. Starting Y now."

Keep them short (one or two sentences). Don't narrate every step, the pinned
progress card shows that for free. Don't send an update on a trivial one-shot
task. Send them when a colleague would genuinely want to know what's happening.

Final answers still go through \`stream_reply\` with done=true as usual,
\`progress_update\` is only for mid-turn check-ins.`;

      if (useSwitchroomPlugin) {
        const combined = baseAppend.length > 0
          ? `${baseAppend}\n\n---\n\n${telegramGuidance}`
          : telegramGuidance;
        return shellSingleQuote(combined);
      }
      return baseAppend.length > 0 ? shellSingleQuote(baseAppend) : undefined;
    })(),
    extraCliArgs: agentConfig.cli_args && agentConfig.cli_args.length > 0
      ? " " + agentConfig.cli_args.map(shellSingleQuote).join(" ")
      : undefined,
    sessionMaxIdleSecs: parseDurationToSeconds(agentConfig.session?.max_idle),
    sessionMaxTurns: agentConfig.session?.max_turns,
    handoffEnabled: agentConfig.session_continuity?.enabled !== false,
    handoffShowLine: agentConfig.session_continuity?.show_handoff_line !== false,
    resumeMode: agentConfig.session_continuity?.resume_mode ?? "auto",
    resumeMaxBytes:
      agentConfig.session_continuity?.resume_max_bytes ?? 2_000_000,
  };
}

export function scaffoldAgent(
  name: string,
  agentConfigRaw: AgentConfig,
  agentsDir: string,
  telegramConfig: TelegramConfig,
  switchroomConfig?: SwitchroomConfig,
  userIdOverride?: string,
  switchroomConfigPath?: string,
): ScaffoldResult {
  // Apply the full cascade: global defaults → inline profile (from
  // `extends:`) → per-agent config. When switchroom.yaml has no `defaults:`
  // or `profiles:` and no `extends:` on the agent, the result is
  // identical to agentConfigRaw so existing behavior is preserved.
  const agentConfig = resolveAgentConfig(
    switchroomConfig?.defaults,
    switchroomConfig?.profiles,
    agentConfigRaw,
  );

  const agentDir = resolve(agentsDir, name);
  const created: string[] = [];
  const skipped: string[] = [];

  const profilePath = getProfilePath(agentConfig.extends ?? DEFAULT_PROFILE);
  const basePath = getBaseProfilePath();

  // Load user config for Telegram user ID
  const userConfig = loadUserConfig();
  const userId = userIdOverride ?? userConfig?.userId;

  // Resolve topic ID: config takes priority, then topics.json state file
  let topicId = agentConfig.topic_id;
  if (topicId === undefined) {
    try {
      const topicState = loadTopicState();
      topicId = topicState.topics?.[name]?.topic_id;
    } catch { /* no state file yet */ }
  }

  // Resolve bot token: per-agent token takes priority, then global telegram token
  const rawBotToken = agentConfig.bot_token ?? telegramConfig.bot_token;
  const resolvedBotToken = resolveBotToken(rawBotToken);

  // Compute the effective permissions.allow list for settings.json.
  //
  // Special handling:
  //   - If the user writes `tools.allow: [all]`, Claude Code rejects the
  //     literal string "all" in the permissions.allow list. The correct
  //     equivalent is to use defaultMode: "acceptEdits" with an empty
  //     allow list.
  //   - If channels.telegram.plugin is "switchroom", pre-approve the switchroom-telegram
  //     MCP tool names so the agent never has to confirm MCP tool
  //     permissions at runtime.
  const tools = agentConfig.tools ?? { allow: [], deny: [] };
  const rawAllow = tools.allow ?? [];
  const hasAllWildcard = rawAllow.includes("all");
  const baseAllow = hasAllWildcard
    ? ALL_BUILTIN_TOOLS
    : rawAllow.filter((t) => t !== "all");
  // If the user didn't specify any allowed tools AND dangerous_mode is off,
  // seed a safe read-only default set so routine tool calls don't spam the
  // approval UI. Risky tools still prompt and hit the Telegram button flow.
  const dangerousMode = agentConfig.dangerous_mode === true;
  const hadExplicitAllow = rawAllow.length > 0;
  const readOnlyDefaults =
    !dangerousMode && !hadExplicitAllow ? DEFAULT_READ_ONLY_PREAPPROVED_TOOLS : [];
  const memoryBackend = switchroomConfig?.memory?.backend;
  const hindsightEnabled = memoryBackend === "hindsight";
  const permissionAllow = dedupe([
    ...baseAllow,
    ...readOnlyDefaults,
    ...(usesSwitchroomTelegramPlugin(agentConfig) ? SWITCHROOM_TELEGRAM_MCP_TOOLS : []),
    ...(hindsightEnabled ? HINDSIGHT_MCP_TOOLS : []),
    ...SWITCHROOM_MCP_TOOLS,
  ]);

  // Compute Hindsight plugin context for the start.sh + settings.json
  // templates. Mirrors installHindsightPlugin's gating logic so the
  // template only emits the env vars and --plugin-dir flag when the
  // plugin will actually be installed.
  const hindsightAutoRecallEnabled = hindsightEnabled
    && agentConfig.memory?.auto_recall !== false;
  const hindsightBankId = agentConfig.memory?.collection ?? name;
  const hindsightApiBaseUrl = (switchroomConfig?.memory?.config?.url as string | undefined)
    ? (switchroomConfig!.memory!.config!.url as string).replace(/\/mcp\/?$/, "").replace(/\/$/, "")
    : "http://127.0.0.1:8888";

  // Build the template rendering context via the shared helper so
  // scaffold and reconcile always produce the same shape for workspace
  // template rendering (see buildWorkspaceContext).
  const context = buildWorkspaceContext({
    name,
    agentDir,
    agentConfig,
    telegramConfig,
    switchroomConfig,
    switchroomConfigPath,
    topicId,
    tools,
    permissionAllow,
    hasAllWildcard,
    resolvedBotToken,
    rawBotToken,
    hindsightAutoRecallEnabled,
    hindsightBankId,
    hindsightApiBaseUrl,
  });

  // --- Create directory structure ---
  const dirs = [
    agentDir,
    join(agentDir, ".claude"),
    join(agentDir, ".claude", "skills"),
    join(agentDir, "memory"),
    join(agentDir, "telegram"),
  ];
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
  }

  // --- Render and write base templates ---
  writeIfMissing(
    join(agentDir, "start.sh"),
    () => renderTemplate(join(basePath, "start.sh.hbs"), context),
    created,
    skipped,
  );
  // Make start.sh executable
  if (existsSync(join(agentDir, "start.sh"))) {
    chmodSync(join(agentDir, "start.sh"), 0o700);
  }

  writeIfMissing(
    join(agentDir, ".claude", "settings.json"),
    () => renderTemplate(join(basePath, "settings.json.hbs"), context),
    created,
    skipped,
    0o600,
  );

  // --- Merge MCP configs into settings.json ---
  if (switchroomConfig) {
    const settingsPath = join(agentDir, ".claude", "settings.json");
    if (existsSync(settingsPath)) {
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      if (!settings.mcpServers) {
        settings.mcpServers = {};
      }

      // Hindsight memory MCP
      const hindsightEntry = getHindsightSettingsEntry(name, switchroomConfig);
      if (hindsightEntry && !settings.mcpServers[hindsightEntry.key]) {
        settings.mcpServers[hindsightEntry.key] = hindsightEntry.value;
      }

      // Switchroom management MCP
      const switchroomMcpEntry = getSwitchroomMcpSettingsEntry();
      if (!settings.mcpServers[switchroomMcpEntry.key]) {
        settings.mcpServers[switchroomMcpEntry.key] = switchroomMcpEntry.value;
      }

      // Hindsight memory plugin install (replaces our old shell hook).
      // The vendored plugin's own hooks.json wires SessionStart /
      // UserPromptSubmit / Stop / SessionEnd via Claude Code's plugin
      // loader once start.sh passes --plugin-dir.
      installHindsightPlugin(name, agentDir, switchroomConfig);

      // Disable Claude Code's built-in auto-memory so the model doesn't
      // get dueling instructions (write to local .md files vs use
      // Hindsight). The settings flag gates the memory system-prompt
      // block at the source.
      const hindsightOn = switchroomConfig.memory?.backend === "hindsight"
        && switchroomConfig.agents[name]?.memory?.auto_recall !== false;
      if (hindsightOn) {
        settings.autoMemoryEnabled = false;
      }

      // --- Phase 2: user-declared hooks and model ---
      //
      // Hooks from switchroom.yaml (merged with defaults) are translated from
      // switchroom's flat shape to Claude Code's nested shape and assigned
      // wholesale to settings.hooks. Switchroom owns the entire settings.hooks
      // object — plugin-installed hooks (hindsight) live in the plugin's
      // own hooks.json and are loaded via --plugin-dir, so they're not
      // affected by this and Claude Code merges them at runtime.
      const userHooks = translateHooksToClaudeShape(agentConfig.hooks);
      // Switchroom-owned SessionStart hook: send the config greeting via curl.
      // This is injected alongside user hooks and always present.
      const greetingHook = {
        type: "command",
        command: `bash "${join(agentDir, "telegram", "session-greeting.sh")}"`,
        // 20s budget: ccusage scans local transcripts (3-8s on agents with
        // hundreds of transcripts) and auth + model resolvers read several
        // files. 5s was too tight; Ken's assistant (328 transcripts) had
        // its hook SIGKILL'd before ccusage finished, so the Quota row
        // silently rendered as "—".
        timeout: 20,
      };
      const switchroomSessionStart = [{ hooks: [greetingHook] }];
      // Switchroom-owned Stop hook: produce the session-handoff briefing so
      // the next session can wake up with a compact summary injected
      // via --append-system-prompt. Gated on session_continuity.enabled
      // (default true). async+timeout so it never blocks shutdown.
      const handoffEnabled = agentConfig.session_continuity?.enabled !== false;
      const handoffConfigArg = switchroomConfigPath
        ? ` --config ${shellSingleQuote(resolve(switchroomConfigPath))}`
        : "";
      const switchroomStop = handoffEnabled
        ? [
            {
              hooks: [
                {
                  type: "command",
                  command: `switchroom${handoffConfigArg} handoff ${name}`,
                  timeout: 35,
                  async: true,
                },
              ],
            },
          ]
        : [];
      // Switchroom-owned UserPromptSubmit hooks: inject workspace content at
      // the start of every turn. When hotReloadStable is true, the stable
      // workspace files (AGENTS.md, SOUL.md, USER.md, IDENTITY.md, TOOLS.md,
      // HEARTBEAT.md) are injected here instead of baked into start.sh's
      // --append-system-prompt. Dynamic files (MEMORY.md, daily notes) are
      // always injected per-turn. Coexists with Hindsight's own
      // UserPromptSubmit hook (loaded via the plugin's hooks.json). 5-6s
      // timeouts so slow renders never block the turn; silent failure (no
      // stderr) so missing workspace files don't spam errors.
      const useHotReloadStable = agentConfig.channels?.telegram?.hotReloadStable === true;
      const switchroomUserPromptSubmit = [
        ...(useHotReloadStable
          ? [
              {
                hooks: [
                  {
                    type: "command",
                    command: `bash "${join(REPO_ROOT, "bin", "workspace-stable-hook.sh")}"`,
                    timeout: 6,
                  },
                ],
              },
            ]
          : []),
        {
          hooks: [
            {
              type: "command",
              command: `bash "${join(REPO_ROOT, "bin", "workspace-dynamic-hook.sh")}"`,
              timeout: 5,
            },
          ],
        },
      ];
      if (userHooks) {
        settings.hooks = {
          ...userHooks,
          SessionStart: [
            ...((userHooks.SessionStart as unknown[]) ?? []),
            ...switchroomSessionStart,
          ],
          UserPromptSubmit: [
            ...((userHooks.UserPromptSubmit as unknown[]) ?? []),
            ...switchroomUserPromptSubmit,
          ],
          ...(switchroomStop.length > 0
            ? {
                Stop: [
                  ...((userHooks.Stop as unknown[]) ?? []),
                  ...switchroomStop,
                ],
              }
            : {}),
        };
      } else {
        settings.hooks = {
          SessionStart: switchroomSessionStart,
          UserPromptSubmit: switchroomUserPromptSubmit,
          ...(switchroomStop.length > 0 ? { Stop: switchroomStop } : {}),
        };
      }
      // Explicit model override: written to settings.model so the user
      // doesn't have to pass --model on every invocation.
      if (agentConfig.model !== undefined) {
        settings.model = agentConfig.model;
      }

      // --- Phase 5: settings_raw escape hatch ---
      //
      // Final step before writing: deep-merge any user-declared raw
      // settings onto the computed object. This lets power users reach
      // Claude Code settings keys switchroom doesn't wrap directly (e.g.
      // `effort`, `apiKeyHelper`, future keys). Happens last so switchroom's
      // typed fields can be overridden — that's the point of the hatch.
      // Also stamp the `_switchroomManagedRawKeys` side-car so reconcile can
      // retract non-switchroom-owned keys if the user removes them later.
      const mergedSettings = agentConfig.settings_raw
        ? (deepMergeJson(settings, agentConfig.settings_raw) as Record<string, unknown>)
        : settings;
      if (agentConfig.settings_raw && Object.keys(agentConfig.settings_raw).length > 0) {
        mergedSettings._switchroomManagedRawKeys = Object.keys(agentConfig.settings_raw);
      }

      writeFileSync(settingsPath, JSON.stringify(mergedSettings, null, 2) + "\n", "utf-8");
    }
  }

  // --- Write project-level .mcp.json for switchroom-telegram development channel ---
  //
  // When channels.telegram.plugin is "switchroom", Claude Code's
  // `--dangerously-load-development-channels server:NAME` flag resolves
  // the MCP server definition from the project-level .mcp.json in the
  // working directory — NOT from settings.json mcpServers. Write it here
  // so the enhanced Telegram plugin can be launched as a dev channel.
  if (usesSwitchroomTelegramPlugin(agentConfig)) {
    const mcpJsonPath = join(agentDir, ".mcp.json");
    if (!existsSync(mcpJsonPath)) {
      const pluginDir = resolve(import.meta.dirname, "../../telegram-plugin");
      const switchroomCliPath = resolveSwitchroomCliPath();
      const resolvedConfigPath = switchroomConfigPath
        ? resolve(switchroomConfigPath)
        : resolve(process.cwd(), "switchroom.yaml");

      const mcpServers: Record<string, McpServerConfig> = {
        "switchroom-telegram": {
          command: "bun",
          args: ["run", "--cwd", pluginDir, "--shell=bun", "--silent", "start"],
          env: {
            TELEGRAM_STATE_DIR: join(agentDir, "telegram"),
            SWITCHROOM_CONFIG: resolvedConfigPath,
            SWITCHROOM_CLI_PATH: switchroomCliPath,
          },
        },
      };

      // Add hindsight memory MCP if configured
      if (hindsightEnabled && switchroomConfig) {
        const hindsightEntry = getHindsightSettingsEntry(name, switchroomConfig);
        if (hindsightEntry) {
          mcpServers[hindsightEntry.key] = hindsightEntry.value;
        }
      }

      const mcpJson = { mcpServers };

      writeFileSync(
        mcpJsonPath,
        JSON.stringify(mcpJson, null, 2) + "\n",
        { encoding: "utf-8", mode: 0o600 },
      );
      created.push(mcpJsonPath);
    }
  }

  // --- Render template-specific files ---
  // Phase 2: SOUL.md moved to workspace/SOUL.md (seedWorkspaceBootstrapFiles)
  const templateFiles: Array<{ src: string; dest: string }> = [
    { src: "CLAUDE.md.hbs", dest: "CLAUDE.md" },
  ];

  for (const { src, dest } of templateFiles) {
    const srcPath = join(profilePath, src);
    if (existsSync(srcPath)) {
      writeIfMissing(
        join(agentDir, dest),
        () => {
          let rendered = renderTemplate(srcPath, context);
          // Phase 5: append claude_md_raw escape hatch on initial
          // scaffold. CLAUDE.md is user-protected afterwards so the
          // hatch is one-shot — users who edit CLAUDE.md after scaffold
          // keep their edits through subsequent reconciles.
          if (dest === "CLAUDE.md" && agentConfig.claude_md_raw) {
            rendered = rendered.trimEnd() + "\n\n" + agentConfig.claude_md_raw + "\n";
          }
          return rendered;
        },
        created,
        skipped,
      );
    }
  }

  // --- Seed workspace bootstrap files from profile (AGENTS.md, USER.md, etc.)
  //
  //     Profiles may ship a `workspace/` subdirectory containing .hbs
  //     templates and plain files. Each .hbs is rendered into the agent's
  //     `workspace/` directory; plain files are copied verbatim. These files
  //     are user-editable afterwards — we only seed on first scaffold (via
  //     writeIfMissing) so user edits survive re-runs.
  seedWorkspaceBootstrapFiles({
    profilePath,
    agentDir,
    context,
    created,
    skipped,
  });

  // --- Initialize workspace as git repo (Phase 4) ---
  const workspaceDir = join(agentDir, "workspace");
  initWorkspaceGitRepo(workspaceDir, name);

  // --- Claude Code config (onboarding state) ---
  // Try to copy from existing Claude installation; fall back to minimal config
  const existingClaudeJson = findExistingClaudeJson();
  if (existingClaudeJson) {
    copyOnboardingState(existingClaudeJson, agentDir);
    copyExistingCredentials(agentDir);
    if (!existsSync(join(agentDir, ".claude", "config.json"))) {
      // copyOnboardingState didn't write (file existed), write default
      writeIfMissing(
        join(agentDir, ".claude", "config.json"),
        () =>
          JSON.stringify(
            { hasCompletedOnboarding: true, numStartups: 1 },
            null,
            2,
          ) + "\n",
        created,
        skipped,
        0o600,
      );
    }
  } else {
    // No existing Claude install — create minimal config
    createMinimalClaudeConfig(agentDir);
  }

  // Pre-trust the agent's workspace directory
  preTrustWorkspace(agentDir);

  // --- Memory index ---
  writeIfMissing(
    join(agentDir, "memory", "MEMORY.md"),
    () => "# Memory Index\n\nThis file is auto-maintained. Do not edit manually.\n",
    created,
    skipped,
  );

  // --- Telegram .env ---
  writeIfMissing(
    join(agentDir, "telegram", ".env"),
    () => {
      if (resolvedBotToken) {
        return `TELEGRAM_BOT_TOKEN=${resolvedBotToken}\n`;
      }
      return `# Set your bot token: TELEGRAM_BOT_TOKEN=your-token-here\n`;
    },
    created,
    skipped,
    0o600,
  );

  // --- Telegram access.json ---
  writeIfMissing(
    join(agentDir, "telegram", "access.json"),
    () => buildAccessJson(agentConfig, telegramConfig, topicId, userId),
    created,
    skipped,
    0o600,
  );

  // --- Sub-agent definitions (.claude/agents/<name>.md) ---
  //
  // Render each sub-agent from the merged `subagents:` config into a
  // Claude Code custom sub-agent markdown file. These are project-scope
  // agents (`.claude/agents/`) so they're specific to this agent's
  // working directory and don't leak into other agents or the user's
  // global `~/.claude/agents/`.
  if (agentConfig.subagents) {
    const agentsDir = join(agentDir, ".claude", "agents");
    mkdirSync(agentsDir, { recursive: true });
    for (const [saName, saDef] of Object.entries(agentConfig.subagents)) {
      const mdPath = join(agentsDir, `${saName}.md`);
      const frontmatter: Record<string, unknown> = {
        name: saName,
        description: saDef.description,
      };
      if (saDef.model) frontmatter.model = saDef.model;
      if (saDef.background != null) frontmatter.background = saDef.background;
      if (saDef.isolation) frontmatter.isolation = saDef.isolation;
      if (saDef.tools) frontmatter.tools = saDef.tools.join(", ");
      if (saDef.disallowedTools) frontmatter.disallowedTools = saDef.disallowedTools.join(", ");
      if (saDef.maxTurns) frontmatter.maxTurns = saDef.maxTurns;
      if (saDef.permissionMode) frontmatter.permissionMode = saDef.permissionMode;
      if (saDef.effort) frontmatter.effort = saDef.effort;
      if (saDef.color) frontmatter.color = saDef.color;
      if (saDef.memory) frontmatter.memory = saDef.memory;
      if (saDef.skills && saDef.skills.length > 0) {
        frontmatter.skills = saDef.skills;
      }
      const fmLines = Object.entries(frontmatter)
        .map(([k, v]) => {
          if (Array.isArray(v)) return `${k}:\n${v.map(i => `  - ${i}`).join("\n")}`;
          return `${k}: ${v}`;
        })
        .join("\n");
      const body = saDef.prompt ?? `You are the ${saName} sub-agent.`;
      const content = `---\n${fmLines}\n---\n\n${body}\n`;
      writeFileSync(mdPath, content, "utf-8");
    }
  }

  // --- Session greeting script ---
  //
  // Pre-rendered shell script that sends the agent's config summary to
  // Telegram on every SessionStart — zero model tokens. Rewritten on
  // every scaffold/reconcile so config changes are reflected.
  const greetingPath = join(agentDir, "telegram", "session-greeting.sh");
  const greetingScript = buildSessionGreetingScript(
    name,
    agentConfig,
    telegramConfig,
    topicId,
    userId,
    switchroomConfig?.quota,
  );
  writeFileSync(greetingPath, greetingScript, { encoding: "utf-8", mode: 0o700 });

  // --- Scheduled task cron scripts ---
  //
  // Each schedule entry gets a self-contained bash script that runs
  // `claude -p` with the configured model and sends output to Telegram.
  // The corresponding systemd timer+service units are installed by
  // `switchroom agent create` / `switchroom systemd install` (in cli/agent.ts),
  // not here — scaffold writes the scripts, CLI wires the timers.
  if (agentConfig.schedule.length > 0) {
    const cronChatId = userId ?? telegramConfig.forum_chat_id;
    for (let i = 0; i < agentConfig.schedule.length; i++) {
      const entry = agentConfig.schedule[i];
      const model = entry.model ?? "claude-sonnet-4-6";
      const script = buildCronScript(agentDir, entry.prompt, model, telegramConfig.forum_chat_id, userId);
      const scriptPath = join(agentDir, "telegram", `cron-${i}.sh`);
      writeFileSync(scriptPath, script, { encoding: "utf-8", mode: 0o700 });
    }
  }

  // --- Copy skill files from profile ---
  // Profile-bundled skills land in .claude/skills/ so Claude Code discovers
  // them alongside user-declared global skills.
  copyProfileSkills(profilePath, join(agentDir, ".claude", "skills"));

  // --- Symlink global skills from switchroom.skills_dir ---
  //
  // Skills named in `agents.x.skills: [name1, name2]` (merged with
  // defaults.skills) are resolved to <skills_dir>/<name> and symlinked
  // into <agentDir>/skills/<name>. This decouples skill authoring from
  // template authoring — add a skill to the pool once, opt-in per agent.
  if (agentConfig.skills && agentConfig.skills.length > 0) {
    syncGlobalSkills(
      agentDir,
      agentConfig.skills,
      switchroomConfig?.switchroom?.skills_dir,
    );
  }

  // --- Install built-in switchroom-* skills into .claude/skills/ ---
  installSwitchroomSkills(agentDir);

  // --- Set up plugin symlinks ---
  setupPlugins(agentDir);

  // --- Phase 2: symlink <agentDir>/SOUL.md → workspace/SOUL.md ---
  // Claude Code auto-discovers SOUL.md at the project root. Keep parity by
  // symlinking so both paths see the same authoritative workspace/SOUL.md.
  const agentSoulPath = join(agentDir, "SOUL.md");
  const workspaceSoulPath = join(agentDir, "workspace", "SOUL.md");
  if (existsSync(workspaceSoulPath)) {
    // Remove old regular file if present (migration)
    if (existsSync(agentSoulPath)) {
      const stat = lstatSync(agentSoulPath);
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(agentSoulPath);
        if (target === "workspace/SOUL.md") {
          // Already correct symlink, skip
          skipped.push(agentSoulPath);
        } else {
          // Wrong symlink, replace
          rmSync(agentSoulPath);
          symlinkSync("workspace/SOUL.md", agentSoulPath);
          created.push(agentSoulPath);
        }
      } else {
        // Regular file, replace with symlink
        rmSync(agentSoulPath);
        symlinkSync("workspace/SOUL.md", agentSoulPath);
        created.push(agentSoulPath);
      }
    } else {
      // No file exists, create symlink
      symlinkSync("workspace/SOUL.md", agentSoulPath);
      created.push(agentSoulPath);
    }
  }

  return { agentDir, created, skipped };
}

/**
 * Result of reconciling an existing agent against the current switchroom.yaml.
 */
export interface ReconcileResult {
  agentDir: string;
  changes: string[];
  changesBySemantics?: {
    hot: string[];
    staleTillRestart: string[];
    restartRequired: string[];
  };
}

/**
 * Categorize a file change by its reload semantics.
 */
type ReloadSemantics =
  | "hot"             // Active next turn, no restart needed (hook re-reads)
  | "stale-till-restart"  // File is part of session-start bake; edits ignored until restart
  | "restart-required";   // File changes MUST restart (MCP/settings/binary/template);
                          // agent won't pick up changes without a restart

function classifyChange(path: string, agentDir: string): ReloadSemantics {
  // Get the path relative to agentDir
  const relPath = path.startsWith(agentDir)
    ? path.slice(agentDir.length).replace(/^\//, "")
    : path;

  // Hot — per-turn hook re-reads
  if (relPath === "workspace/MEMORY.md") return "hot";
  if (relPath.startsWith("workspace/memory/") && relPath.endsWith(".md")) return "hot";
  if (relPath === "workspace/HEARTBEAT.md") return "hot";

  // Stale until restart — baked into --append-system-prompt at session start
  // or auto-loaded by Claude Code at session start
  if (relPath === "workspace/SOUL.md") return "stale-till-restart";
  if (relPath === "workspace/AGENTS.md") return "stale-till-restart";
  if (relPath === "workspace/USER.md") return "stale-till-restart";
  if (relPath === "workspace/IDENTITY.md") return "stale-till-restart";
  if (relPath === "workspace/TOOLS.md") return "stale-till-restart";
  if (relPath === "CLAUDE.md") return "stale-till-restart";
  if (relPath === "workspace/CLAUDE.custom.md") return "stale-till-restart";
  if (relPath === "workspace/SOUL.custom.md") return "stale-till-restart";

  // Restart required — claude-code / MCP / subsystem lifecycle
  if (relPath === ".mcp.json") return "restart-required";
  if (relPath === ".claude/settings.json") return "restart-required";
  if (relPath === "start.sh") return "restart-required";

  // Unknown → treat as stale-till-restart (safe default)
  return "stale-till-restart";
}

/**
 * Re-apply switchroom.yaml-derived state to an existing agent without touching
 * user-edited files (CLAUDE.md, SOUL.md, telegram/.env, etc.).
 *
 * Specifically rewrites:
 *   - start.sh (purely template-driven, safe to overwrite)
 *   - .mcp.json (when channels.telegram.plugin is "switchroom")
 *   - .claude/settings.json mcpServers
 *   - .claude/settings.json permissions.allow / .deny / defaultMode
 *   - .claude/plugins/hindsight-memory/ (vendored plugin tree)
 *
 * Does NOT touch CLAUDE.md, SOUL.md, telegram/.env, or any user content.
 *
 * This is the operation a non-developer needs after editing switchroom.yaml —
 * e.g., adding a new MCP server, enabling memory, changing the tool
 * allowlist. It is the lifecycle gap between `switchroom agent create` (which
 * scaffolds once) and a full re-scaffold (which would clobber CLAUDE.md).
 *
 * Throws if the agent directory does not exist.
 */
export interface ReconcileOptions {
  /**
   * If true, skip regenerating CLAUDE.md. Use this to freeze CLAUDE.md
   * as-is, ignoring template updates. Default false (regeneration is default).
   */
  preserveClaudeMd?: boolean;
}

export function reconcileAgent(
  name: string,
  agentConfigRaw: AgentConfig,
  agentsDir: string,
  telegramConfig: TelegramConfig,
  switchroomConfig: SwitchroomConfig,
  switchroomConfigPath?: string,
  options: ReconcileOptions = {},
): ReconcileResult {
  // Apply the full defaults → profile → agent cascade (same semantics
  // as scaffoldAgent). Every downstream read uses the resolved config.
  const agentConfig = resolveAgentConfig(
    switchroomConfig.defaults,
    switchroomConfig.profiles,
    agentConfigRaw,
  );

  const agentDir = resolve(agentsDir, name);
  const changes: string[] = [];

  if (!existsSync(agentDir)) {
    throw new Error(
      `Agent directory does not exist: ${agentDir}. Run \`switchroom agent create ${name}\` first.`,
    );
  }

  // --- Phase 4: migrate CLAUDE.custom.md to workspace/ (one-time) ---
  const legacyCustomPath = join(agentDir, "CLAUDE.custom.md");
  const workspaceDir = join(agentDir, "workspace");
  const newCustomPath = join(workspaceDir, "CLAUDE.custom.md");
  if (existsSync(legacyCustomPath) && !existsSync(newCustomPath)) {
    mkdirSync(workspaceDir, { recursive: true });
    const legacyContent = readFileSync(legacyCustomPath, "utf-8");
    writeFileSync(newCustomPath, legacyContent, "utf-8");
    rmSync(legacyCustomPath);
    console.log(chalk.green(`  moved CLAUDE.custom.md → workspace/CLAUDE.custom.md`));
  }

  // Compute the desired permissions.allow list from current config.
  // IMPORTANT: this must stay in lockstep with scaffoldAgent's permissionAllow
  // computation — including the DEFAULT_READ_ONLY_PREAPPROVED_TOOLS injection
  // when tools.allow is empty and dangerous_mode is off. Without this, the
  // first `switchroom reconcile` after scaffold wipes the read-only defaults
  // and every Read/Grep/Glob starts triggering approval cards.
  const tools = agentConfig.tools ?? { allow: [], deny: [] };
  const rawAllow = tools.allow ?? [];
  const hasAllWildcard = rawAllow.includes("all");
  const baseAllow = hasAllWildcard
    ? ALL_BUILTIN_TOOLS
    : rawAllow.filter((t) => t !== "all");
  const reconcileDangerousMode = agentConfig.dangerous_mode === true;
  const reconcileHadExplicitAllow = rawAllow.length > 0;
  const reconcileReadOnlyDefaults =
    !reconcileDangerousMode && !reconcileHadExplicitAllow
      ? DEFAULT_READ_ONLY_PREAPPROVED_TOOLS
      : [];
  const memoryBackend = switchroomConfig.memory?.backend;
  const hindsightEnabled = memoryBackend === "hindsight";
  const desiredAllow = dedupe([
    ...baseAllow,
    ...reconcileReadOnlyDefaults,
    ...(usesSwitchroomTelegramPlugin(agentConfig) ? SWITCHROOM_TELEGRAM_MCP_TOOLS : []),
    ...(hindsightEnabled ? HINDSIGHT_MCP_TOOLS : []),
    ...SWITCHROOM_MCP_TOOLS,
  ]);
  const desiredDeny = tools.deny ?? [];

  // Resolve topic ID for the start.sh template and session greeting
  let topicId = agentConfig.topic_id;
  if (topicId === undefined) {
    try {
      const topicState = loadTopicState();
      topicId = topicState.topics?.[name]?.topic_id;
    } catch { /* no state file yet */ }
  }

  // Resolve telegram + hindsight context for the start.sh template
  const rawBotToken = agentConfig.bot_token ?? telegramConfig.bot_token;
  const resolvedBotToken = resolveBotToken(rawBotToken);
  const hindsightAutoRecallEnabled = hindsightEnabled
    && agentConfig.memory?.auto_recall !== false;
  const hindsightBankId = agentConfig.memory?.collection ?? name;
  const hindsightApiBaseUrl = (switchroomConfig.memory?.config?.url as string | undefined)
    ? (switchroomConfig.memory!.config!.url as string).replace(/\/mcp\/?$/, "").replace(/\/$/, "")
    : "http://127.0.0.1:8888";

  // --- Reconcile start.sh (purely template-driven, safe to overwrite) ---
  // No existsSync guard: start.sh is a pure function of config+template.
  // If it's missing (user nuked it, bad manual edit, partial disk copy),
  // regenerate it. Previously we bailed on missing file which left the
  // agent permanently unable to launch until a full `agent create` rebuild.
  const startShPath = join(agentDir, "start.sh");
  {
    const basePath = getBaseProfilePath();
    const startShContext: Record<string, unknown> = {
      name,
      agentDir,
      botToken: resolvedBotToken ?? rawBotToken,
      forumChatId: telegramConfig.forum_chat_id,
      dangerousMode: agentConfig.dangerous_mode === true,
      useSwitchroomPlugin: usesSwitchroomTelegramPlugin(agentConfig),
      hindsightEnabled: hindsightAutoRecallEnabled,
      hindsightBankIdQ: shellSingleQuote(hindsightBankId),
      hindsightApiBaseUrlQ: shellSingleQuote(hindsightApiBaseUrl),
      modelQ: agentConfig.model ? shellSingleQuote(agentConfig.model) : undefined,
      userEnvQuoted: (() => {
        const combined = { ...channelsToEnv(agentConfig), ...(agentConfig.env ?? {}) };
        if (Object.keys(combined).length === 0) return undefined;
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(combined)) {
          out[k] = shellSingleQuote(v);
        }
        return out;
      })(),
      model: agentConfig.model,
      // Keep in lockstep with buildScaffoldContext's systemPromptAppendShellQuoted:
      // when the agent uses the switchroom telegram plugin, append the
      // human-voice progress_update guidance block so agents know to send
      // natural-language check-ins alongside the emoji reaction ladder.
      systemPromptAppendShellQuoted: (() => {
        const useSwitchroomPlugin = usesSwitchroomTelegramPlugin(agentConfig);
        const baseAppend = agentConfig.system_prompt_append ?? '';
        const telegramGuidance = `## Progress updates (human-style check-ins)

You're talking to a human colleague on Telegram. Alongside the emoji status
ladder, send a short \`progress_update\` at inflection points, the moments a
senior colleague would ping the person who asked them to do something:

- **Plan formed:** "Got it. Going to do X first, then Y, then Z."
- **Pivot or blocker:** "First approach didn't work because <reason>. Trying
  <alternative> instead."
- **Chunk finished:** "Done with X. Starting Y now."

Keep them short (one or two sentences). Don't narrate every step, the pinned
progress card shows that for free. Don't send an update on a trivial one-shot
task. Send them when a colleague would genuinely want to know what's happening.

Final answers still go through \`stream_reply\` with done=true as usual,
\`progress_update\` is only for mid-turn check-ins.`;
        if (useSwitchroomPlugin) {
          const combined = baseAppend.length > 0
            ? `${baseAppend}\n\n---\n\n${telegramGuidance}`
            : telegramGuidance;
          return shellSingleQuote(combined);
        }
        return baseAppend.length > 0 ? shellSingleQuote(baseAppend) : undefined;
      })(),
      extraCliArgs: agentConfig.cli_args && agentConfig.cli_args.length > 0
        ? " " + agentConfig.cli_args.map(shellSingleQuote).join(" ")
        : undefined,
      sessionMaxIdleSecs: parseDurationToSeconds(agentConfig.session?.max_idle),
      sessionMaxTurns: agentConfig.session?.max_turns,
      handoffEnabled: agentConfig.session_continuity?.enabled !== false,
      handoffShowLine: agentConfig.session_continuity?.show_handoff_line !== false,
      resumeMode: agentConfig.session_continuity?.resume_mode ?? "auto",
      resumeMaxBytes:
        agentConfig.session_continuity?.resume_max_bytes ?? 2_000_000,
    };
    const beforeStartSh = existsSync(startShPath)
      ? readFileSync(startShPath, "utf-8")
      : "";
    const afterStartSh = renderTemplate(join(basePath, "start.sh.hbs"), startShContext);
    if (afterStartSh !== beforeStartSh) {
      writeFileSync(startShPath, afterStartSh, "utf-8");
      chmodSync(startShPath, 0o755);
      changes.push(startShPath);
    }
  }

  // --- Phase 3: regenerate CLAUDE.md by default (unless --preserve-claude-md) ---
  // CLAUDE.md is regenerated deterministically from the template. CLAUDE.custom.md
  // sidecar (if present) is appended with a \n\n---\n\n separator.
  if (!options.preserveClaudeMd) {
    const profilePath = getProfilePath(agentConfig.extends ?? DEFAULT_PROFILE);
    const claudeMdSrc = join(profilePath, "CLAUDE.md.hbs");
    const claudeMdDest = join(agentDir, "CLAUDE.md");
    const claudeCustomPath = join(agentDir, "workspace", "CLAUDE.custom.md");

    if (existsSync(claudeMdSrc)) {
      const claudeContext: Record<string, unknown> = {
        name,
        agentDir,
        topicName: agentConfig.topic_name,
        topicEmoji: agentConfig.topic_emoji,
        soul: agentConfig.soul,
        tools: agentConfig.tools ?? { allow: [], deny: [] },
        memory: agentConfig.memory,
        model: agentConfig.model,
        schedule: agentConfig.schedule,
        useSwitchroomPlugin: usesSwitchroomTelegramPlugin(agentConfig),
      };

      // Render template + compose with sidecar
      const rendered = renderTemplate(claudeMdSrc, claudeContext);
      let composed = composeWithSidecar(rendered, claudeCustomPath);

      // Legacy claude_md_raw still appends after sidecar (one-shot escape hatch)
      if (agentConfig.claude_md_raw) {
        composed = composed.trimEnd() + "\n\n" + agentConfig.claude_md_raw + "\n";
      }

      // Migration detection: if on-disk differs and no sidecar exists, warn + abort
      if (existsSync(claudeMdDest)) {
        const onDisk = readFileSync(claudeMdDest, "utf-8");
        if (onDisk !== composed && !existsSync(claudeCustomPath)) {
          console.error(
            chalk.red(
              `CLAUDE.md has hand-edits that will be overwritten by reconcile.\n\n` +
              `Options:\n` +
              `  1. Move your custom content to ${claudeCustomPath} and re-run reconcile.\n` +
              `     The sidecar is appended to the regenerated CLAUDE.md and never overwritten.\n` +
              `  2. Pass --preserve-claude-md to keep your current CLAUDE.md as-is (no template updates).\n` +
              `  3. Accept the regeneration and lose hand-edits.\n\n` +
              `Aborting this reconcile. Re-run with one of the above options.`
            )
          );
          process.exit(1);
        }
      }

      // Write if changed
      const before = existsSync(claudeMdDest) ? readFileSync(claudeMdDest, "utf-8") : "";
      if (composed !== before) {
        writeFileSync(claudeMdDest, composed, "utf-8");
        changes.push(claudeMdDest);
      }
    }
  }

  // --- Reconcile settings.json ---
  const settingsPath = join(agentDir, ".claude", "settings.json");
  if (existsSync(settingsPath)) {
    const before = readFileSync(settingsPath, "utf-8");
    const settings = JSON.parse(before);

    // Permissions: switchroom-managed keys are allow, deny, defaultMode.
    // Preserve any other keys the user may have added under permissions.
    settings.permissions = settings.permissions ?? {};
    settings.permissions.allow = desiredAllow;
    settings.permissions.deny = desiredDeny;
    if (hasAllWildcard) {
      settings.permissions.defaultMode = "acceptEdits";
    } else {
      delete settings.permissions.defaultMode;
    }

    // mcpServers: rebuild from current switchroom.yaml. Preserves user-defined
    // mcp_servers from agentConfig.mcp_servers in addition to the built-ins.
    const mcpServers: Record<string, unknown> = {};

    // Hindsight first (so it's the most visible to a reader)
    const hindsightEntry = getHindsightSettingsEntry(name, switchroomConfig);
    if (hindsightEntry) {
      mcpServers[hindsightEntry.key] = hindsightEntry.value;
    }

    // Switchroom management MCP
    const switchroomMcpEntry = getSwitchroomMcpSettingsEntry(switchroomConfigPath);
    mcpServers[switchroomMcpEntry.key] = switchroomMcpEntry.value;

    // User-defined extras from switchroom.yaml agents.<name>.mcp_servers
    if (agentConfig.mcp_servers) {
      for (const [key, value] of Object.entries(agentConfig.mcp_servers)) {
        mcpServers[key] = value;
      }
    }

    settings.mcpServers = mcpServers;

    // Hindsight memory plugin: vendored from vectorize-io/hindsight,
    // copied into <agentDir>/.claude/plugins/hindsight-memory/. The
    // plugin's own hooks.json registers SessionStart / UserPromptSubmit /
    // Stop / SessionEnd hooks via Claude Code's plugin loader. Always
    // re-copy on reconcile so plugin updates propagate via
    // `switchroom update` → reconcile.
    installHindsightPlugin(name, agentDir, switchroomConfig);

    // Disable Claude Code's built-in auto-memory when Hindsight is on.
    // This stops the dueling-instruction problem (see research notes
    // for cli.js bl8() and the autoMemoryEnabled settings key).
    if (hindsightEnabled) {
      settings.autoMemoryEnabled = false;
    } else if (settings.autoMemoryEnabled === false) {
      // Memory backend was disabled — restore the default
      delete settings.autoMemoryEnabled;
    }

    // --- Phase 5: drop non-switchroom-owned top-level keys from a prior
    // settings_raw run before rewriting. Reconcile tracks which keys
    // were injected last time via a `_switchroomManagedRawKeys` side-car
    // and removes them here so removed switchroom.yaml entries don't leave
    // stale drift behind. Keys that are also switchroom-owned (permissions,
    // mcpServers, hooks, model, etc) are left alone because the
    // scaffold rebuild below re-derives them from switchroom.yaml anyway.
    const META_KEY = "_switchroomManagedRawKeys";
    const priorRawKeys = Array.isArray(settings[META_KEY])
      ? (settings[META_KEY] as string[])
      : [];
    for (const k of priorRawKeys) {
      if (!SWITCHROOM_OWNED_SETTINGS_KEYS.has(k) && k in settings) {
        delete settings[k];
      }
    }
    delete settings[META_KEY];

    // --- Phase 2: reconcile user hooks (replace, don't merge) ---
    //
    // Fully replace settings.hooks from switchroom.yaml each reconcile, so
    // removing a hook event from switchroom.yaml also removes it from
    // settings.json. Plugin-installed hooks (hindsight) live in the
    // plugin's own hooks.json and are loaded via --plugin-dir, so
    // they're not affected by this. Switchroom-owned.
    const userHooks = translateHooksToClaudeShape(agentConfig.hooks);
    // Switchroom-owned SessionStart hook: send config greeting via curl.
    const greetingHook = {
      type: "command",
      command: `bash "${join(agentDir, "telegram", "session-greeting.sh")}"`,
      // 20s budget, see scaffoldAgent greeting hook for rationale.
      timeout: 20,
    };
    const switchroomSessionStart = [{ hooks: [greetingHook] }];
    const handoffEnabledReconcile = agentConfig.session_continuity?.enabled !== false;
    const switchroomStop = handoffEnabledReconcile
      ? [
          {
            hooks: [
              {
                type: "command",
                command: `switchroom handoff ${name}`,
                timeout: 35,
                async: true,
              },
            ],
          },
        ]
      : [];
    // Switchroom-owned UserPromptSubmit hooks (same as scaffoldAgent above)
    const useHotReloadStableReconcile = agentConfig.channels?.telegram?.hotReloadStable === true;
    const switchroomUserPromptSubmit = [
      ...(useHotReloadStableReconcile
        ? [
            {
              hooks: [
                {
                  type: "command",
                  command: `bash "${join(REPO_ROOT, "bin", "workspace-stable-hook.sh")}"`,
                  timeout: 6,
                },
              ],
            },
          ]
        : []),
      {
        hooks: [
          {
            type: "command",
            command: `bash "${join(REPO_ROOT, "bin", "workspace-dynamic-hook.sh")}"`,
            timeout: 5,
          },
        ],
      },
    ];
    if (userHooks) {
      settings.hooks = {
        ...userHooks,
        SessionStart: [
          ...((userHooks.SessionStart as unknown[]) ?? []),
          ...switchroomSessionStart,
        ],
        UserPromptSubmit: [
          ...((userHooks.UserPromptSubmit as unknown[]) ?? []),
          ...switchroomUserPromptSubmit,
        ],
        ...(switchroomStop.length > 0
          ? {
              Stop: [
                ...((userHooks.Stop as unknown[]) ?? []),
                ...switchroomStop,
              ],
            }
          : {}),
      };
    } else {
      settings.hooks = {
        SessionStart: switchroomSessionStart,
        UserPromptSubmit: switchroomUserPromptSubmit,
        ...(switchroomStop.length > 0 ? { Stop: switchroomStop } : {}),
      };
    }

    // --- Reconcile sub-agent definitions (.claude/agents/<name>.md) ---
    //
    // Same generation as scaffold — overwrites on every reconcile so
    // config changes propagate. Sub-agent files are fully switchroom-owned.
    if (agentConfig.subagents) {
      const saDir = join(agentDir, ".claude", "agents");
      mkdirSync(saDir, { recursive: true });
      for (const [saName, saDef] of Object.entries(agentConfig.subagents)) {
        const mdPath = join(saDir, `${saName}.md`);
        const frontmatter: Record<string, unknown> = {
          name: saName,
          description: saDef.description,
        };
        if (saDef.model) frontmatter.model = saDef.model;
        if (saDef.background != null) frontmatter.background = saDef.background;
        if (saDef.isolation) frontmatter.isolation = saDef.isolation;
        if (saDef.tools) frontmatter.tools = saDef.tools.join(", ");
        if (saDef.disallowedTools) frontmatter.disallowedTools = saDef.disallowedTools.join(", ");
        if (saDef.maxTurns) frontmatter.maxTurns = saDef.maxTurns;
        if (saDef.permissionMode) frontmatter.permissionMode = saDef.permissionMode;
        if (saDef.effort) frontmatter.effort = saDef.effort;
        if (saDef.color) frontmatter.color = saDef.color;
        if (saDef.memory) frontmatter.memory = saDef.memory;
        if (saDef.skills && saDef.skills.length > 0) {
          frontmatter.skills = saDef.skills;
        }
        const fmLines = Object.entries(frontmatter)
          .map(([k, v]) => {
            if (Array.isArray(v)) return `${k}:\n${v.map(i => `  - ${i}`).join("\n")}`;
            return `${k}: ${v}`;
          })
          .join("\n");
        const body = saDef.prompt ?? `You are the ${saName} sub-agent.`;
        const content = `---\n${fmLines}\n---\n\n${body}\n`;
        const before = existsSync(mdPath) ? readFileSync(mdPath, "utf-8") : "";
        if (content !== before) {
          writeFileSync(mdPath, content, "utf-8");
          changes.push(mdPath);
        }
      }
    }

    // Regenerate the session-greeting script so config changes are
    // reflected in the greeting message.
    const greetingPath = join(agentDir, "telegram", "session-greeting.sh");
    // Read userId from access.json (written during scaffold)
    let greetingUserId: string | undefined;
    const accessPath = join(agentDir, "telegram", "access.json");
    if (existsSync(accessPath)) {
      try {
        const access = JSON.parse(readFileSync(accessPath, "utf-8"));
        greetingUserId = access.allowFrom?.[0];
      } catch { /* best effort */ }
    }
    const greetingScript = buildSessionGreetingScript(
      name,
      agentConfig,
      telegramConfig,
      topicId,
      greetingUserId,
      switchroomConfig?.quota,
    );
    writeFileSync(greetingPath, greetingScript, { encoding: "utf-8", mode: 0o700 });
    if (agentConfig.model !== undefined) {
      settings.model = agentConfig.model;
    } else if ("model" in settings) {
      delete settings.model;
    }

    // --- Phase 5: settings_raw escape hatch ---
    //
    // Apply fresh after the scaffold-rebuild of switchroom-owned fields.
    // Stamp the new META_KEY so the next reconcile knows which keys
    // to retract if the user removes them from switchroom.yaml.
    const mergedSettings = agentConfig.settings_raw
      ? (deepMergeJson(settings, agentConfig.settings_raw) as Record<string, unknown>)
      : settings;
    if (agentConfig.settings_raw && Object.keys(agentConfig.settings_raw).length > 0) {
      mergedSettings[META_KEY] = Object.keys(agentConfig.settings_raw);
    }

    const after = JSON.stringify(mergedSettings, null, 2) + "\n";
    if (after !== before) {
      writeFileSync(settingsPath, after, { encoding: "utf-8", mode: 0o600 });
      changes.push(settingsPath);
    }
  }

  // --- Reconcile scheduled task cron scripts ---
  if (agentConfig.schedule.length > 0) {
    let cronUserId: string | undefined;
    const cronAccessPath = join(agentDir, "telegram", "access.json");
    if (existsSync(cronAccessPath)) {
      try {
        const cronAccess = JSON.parse(readFileSync(cronAccessPath, "utf-8"));
        cronUserId = cronAccess.allowFrom?.[0];
      } catch { /* best effort */ }
    }
    for (let i = 0; i < agentConfig.schedule.length; i++) {
      const entry = agentConfig.schedule[i];
      const model = entry.model ?? "claude-sonnet-4-6";
      const script = buildCronScript(
        agentDir, entry.prompt, model,
        telegramConfig.forum_chat_id, cronUserId,
      );
      const scriptPath = join(agentDir, "telegram", `cron-${i}.sh`);
      const before = existsSync(scriptPath) ? readFileSync(scriptPath, "utf-8") : "";
      if (script !== before) {
        writeFileSync(scriptPath, script, { encoding: "utf-8", mode: 0o700 });
        changes.push(scriptPath);
      }
    }
  }

  // --- Reconcile global skills pool symlinks ---
  //
  // Mirrors the scaffold syncGlobalSkills call so reconcile picks up
  // added/removed entries in switchroom.yaml.
  if (agentConfig.skills) {
    syncGlobalSkills(agentDir, agentConfig.skills, switchroomConfig.switchroom.skills_dir);
  }

  // --- Install built-in switchroom-* skills into .claude/skills/ ---
  installSwitchroomSkills(agentDir);

  // --- Reconcile .mcp.json (switchroom-telegram plugin agents only) ---
  if (usesSwitchroomTelegramPlugin(agentConfig)) {
    const mcpJsonPath = join(agentDir, ".mcp.json");
    const pluginDir = resolve(import.meta.dirname, "../../telegram-plugin");
    const switchroomCliPath = resolveSwitchroomCliPath();
    const resolvedConfigPath = switchroomConfigPath
      ? resolve(switchroomConfigPath)
      : resolve(process.cwd(), "switchroom.yaml");

    const mcpServers: Record<string, McpServerConfig> = {
      "switchroom-telegram": {
        command: "bun",
        args: ["run", "--cwd", pluginDir, "--shell=bun", "--silent", "start"],
        env: {
          TELEGRAM_STATE_DIR: join(agentDir, "telegram"),
          SWITCHROOM_CONFIG: resolvedConfigPath,
          SWITCHROOM_CLI_PATH: switchroomCliPath,
        },
      },
    };

    if (hindsightEnabled) {
      const hindsightEntry = getHindsightSettingsEntry(name, switchroomConfig);
      if (hindsightEntry) {
        mcpServers[hindsightEntry.key] = hindsightEntry.value;
      }
    }

    const mcpJson = { mcpServers };
    const after = JSON.stringify(mcpJson, null, 2) + "\n";
    const before = existsSync(mcpJsonPath)
      ? readFileSync(mcpJsonPath, "utf-8")
      : "";
    if (after !== before) {
      writeFileSync(mcpJsonPath, after, { encoding: "utf-8", mode: 0o600 });
      changes.push(mcpJsonPath);
    }
  }

  // --- Re-seed workspace bootstrap files from the profile.
  //
  //     writeIfMissing semantics mean user edits survive, but new template
  //     files added to the profile (e.g. a HEARTBEAT.md shipped in a later
  //     switchroom release) will be seeded on reconcile — matching scaffold
  //     behavior. Without this call, agents scaffolded before a template
  //     addition stay out of date until rescaffolded.
  const reconcileProfilePath = getProfilePath(agentConfig.extends ?? DEFAULT_PROFILE);
  // Use the same helper scaffoldAgent uses so workspace templates see
  // an identical context shape on both paths. Without this, any new
  // handlebars key referenced by a workspace template renders on
  // scaffold but as "" on reconcile.
  const workspaceContext = buildWorkspaceContext({
    name,
    agentDir,
    agentConfig,
    telegramConfig,
    switchroomConfig,
    switchroomConfigPath,
    topicId,
    tools,
    permissionAllow: desiredAllow,
    hasAllWildcard,
    resolvedBotToken,
    rawBotToken,
    hindsightAutoRecallEnabled,
    hindsightBankId,
    hindsightApiBaseUrl,
  });
  seedWorkspaceBootstrapFiles({
    profilePath: reconcileProfilePath,
    agentDir,
    context: workspaceContext,
    created: changes,
    skipped: [],
  });

  // --- Phase 4: idempotent workspace git init (for existing agents) ---
  const reconcileWorkspaceDir = join(agentDir, "workspace");
  if (existsSync(reconcileWorkspaceDir)) {
    initWorkspaceGitRepo(reconcileWorkspaceDir, name);
  }

  // --- Phase 2: regenerate workspace/SOUL.md deterministically every reconcile ---
  // Unlike other workspace files (user-protected via writeIfMissing), SOUL.md is
  // the authoritative persona source derived from config. Regenerate on every
  // reconcile so config changes propagate.
  const soulMdSrc = join(reconcileProfilePath, "workspace", "SOUL.md.hbs");
  const soulMdDest = join(agentDir, "workspace", "SOUL.md");
  if (existsSync(soulMdSrc)) {
    const before = existsSync(soulMdDest) ? readFileSync(soulMdDest, "utf-8") : "";
    const rendered = renderTemplate(soulMdSrc, workspaceContext);
    // Append SOUL.custom.md sidecar if present
    const customSoulPath = join(agentDir, "workspace", "SOUL.custom.md");
    const after = composeWithSidecar(rendered, customSoulPath);
    if (after !== before) {
      writeFileSync(soulMdDest, after, "utf-8");
      changes.push(soulMdDest);
    }
  }

  // --- Phase 2: symlink <agentDir>/SOUL.md → workspace/SOUL.md (migration) ---
  const agentSoulPath = join(agentDir, "SOUL.md");
  const workspaceSoulPath = join(agentDir, "workspace", "SOUL.md");
  if (existsSync(workspaceSoulPath)) {
    if (existsSync(agentSoulPath)) {
      const stat = lstatSync(agentSoulPath);
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(agentSoulPath);
        if (target !== "workspace/SOUL.md") {
          rmSync(agentSoulPath);
          symlinkSync("workspace/SOUL.md", agentSoulPath);
          changes.push(agentSoulPath);
        }
      } else {
        // Regular file, replace with symlink
        rmSync(agentSoulPath);
        symlinkSync("workspace/SOUL.md", agentSoulPath);
        changes.push(agentSoulPath);
      }
    } else {
      symlinkSync("workspace/SOUL.md", agentSoulPath);
      changes.push(agentSoulPath);
    }
  }

  // Categorize changes by reload semantics
  const hot: string[] = [];
  const staleTillRestart: string[] = [];
  const restartRequired: string[] = [];

  for (const change of changes) {
    const semantics = classifyChange(change, agentDir);
    if (semantics === "hot") {
      hot.push(change);
    } else if (semantics === "stale-till-restart") {
      staleTillRestart.push(change);
    } else {
      restartRequired.push(change);
    }
  }

  return {
    agentDir,
    changes,
    changesBySemantics: { hot, staleTillRestart, restartRequired },
  };
}

/**
 * Write a file only if it doesn't already exist.
 * Tracks what was created vs skipped for reporting.
 */
function writeIfMissing(
  filePath: string,
  contentFn: () => string,
  created: string[],
  skipped: string[],
  mode?: number,
): void {
  if (existsSync(filePath)) {
    skipped.push(filePath);
    return;
  }
  writeFileSync(filePath, contentFn(), mode !== undefined ? { encoding: "utf-8", mode } : "utf-8");
  created.push(filePath);
}

function buildAccessJson(
  agentConfig: AgentConfig,
  telegramConfig: TelegramConfig,
  resolvedTopicId?: number,
  userId?: string,
): string {
  const allowFrom = userId ? [userId] : [];
  if (allowFrom.length === 0) {
    console.warn(
      "  WARNING: No user ID available for access.json allowFrom. " +
      "DM the bot /start and run `switchroom setup` again to pair your Telegram account."
    );
  }
  const access: Record<string, unknown> = {
    dmPolicy: "allowlist",
    allowFrom,
    groups: {
      [telegramConfig.forum_chat_id]: {
        requireMention: false,
        allowFrom,
      },
    },
  };
  return JSON.stringify(access, null, 2) + "\n";
}
