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
import { resolveTimezone, classifyTimezoneSource } from "../config/timezone.js";
import {
  getProfilePath,
  getBaseProfilePath,
  renderTemplate,
  copyProfileSkills,
} from "./profiles.js";
import { getHindsightSettingsEntry, getSwitchroomMcpSettingsEntry } from "../memory/scaffold-integration.js";
import { applyTelegramProgressGuidance } from "./sub-agent-telegram-prompt.js";
import type { McpServerConfig } from "../memory/hindsight.js";
import { createBank, updateBankMissions, ensureUserProfileMentalModel } from "../memory/hindsight.js";
import { loadTopicState } from "../telegram/state.js";
import { resolveDualPath } from "../config/paths.js";
import {
  VERSION,
  COMMIT_SHA,
  COMMIT_DATE,
  LATEST_PR,
  COMMITS_AHEAD_OF_TAG,
} from "../build-info.js";
import { resolvePath } from "../config/loader.js";
import { isVaultReference, parseVaultReference } from "../vault/resolver.js";
import { openVault, VaultError } from "../vault/vault.js";
import {
  findExistingClaudeJson,
  copyOnboardingState,
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
 * Strip any `telegram@claude-plugins-official` entry from an
 * installed_plugins.json payload. Exported for unit testing.
 *
 * Background: Claude Code auto-installs the official Telegram plugin
 * from the marketplace whenever it's available. For switchroom agents
 * that use the switchroom-telegram fork (the default), having both
 * plugins alive polls the same bot token from two processes, so
 * Telegram returns "Conflict: terminated by other getUpdates" and
 * every inbound message is missed. Scrubbing the copied inventory
 * keeps the fork as the sole Telegram owner for this agent.
 *
 * Users who opted into the official plugin (`channels.telegram.plugin:
 * official`) keep the entry — this only runs when useSwitchroomPlugin
 * is true.
 */
export function stripOfficialTelegramPlugin(payload: string): string {
  let data: unknown;
  try {
    data = JSON.parse(payload);
  } catch {
    return payload; // malformed — don't touch it
  }
  if (!data || typeof data !== "object") return payload;
  const obj = data as Record<string, unknown>;
  const plugins = obj.plugins;
  if (!plugins || typeof plugins !== "object") return payload;
  const pluginsObj = plugins as Record<string, unknown>;
  if (!("telegram@claude-plugins-official" in pluginsObj)) return payload;
  delete pluginsObj["telegram@claude-plugins-official"];
  return JSON.stringify(obj, null, 2) + "\n";
}

/**
 * Set up plugin symlinks and config files in the agent's CLAUDE_CONFIG_DIR.
 *
 * Symlinks the official Telegram plugin marketplace from the user's global
 * ~/.claude/plugins/ and copies plugin config files if they exist. When
 * `useSwitchroomPlugin` is true, the copied installed_plugins.json is
 * scrubbed of the official Telegram plugin so it doesn't race the
 * switchroom fork for the same bot token.
 */
export function setupPlugins(agentDir: string, useSwitchroomPlugin = false): void {
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
    if (file === "installed_plugins.json" && useSwitchroomPlugin) {
      // Always re-scrub on every reconcile — a Claude Code update can re-add
      // the official Telegram entry, which races the switchroom fork for the
      // same bot token. Scrub from the global file if present, otherwise from
      // the already-written agent file.
      const sourceFile = existsSync(globalFile)
        ? globalFile
        : existsSync(agentFile)
          ? agentFile
          : null;
      if (sourceFile) {
        try {
          const scrubbed = stripOfficialTelegramPlugin(readFileSync(sourceFile, "utf8"));
          writeFileSync(agentFile, scrubbed);
        } catch { /* ignore write failures */ }
      }
    } else if (existsSync(globalFile) && !existsSync(agentFile)) {
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

/**
 * Human-readable label for an agent + its Hindsight bank in log output.
 * When they match (default case): just the agent name ("clerk").
 * When they differ (custom memory.collection in yaml, e.g. legacy bank_id):
 * "clerk (bank: assistant)" to avoid confusing the bank ID with the agent name.
 */
function formatAgentBankLabel(agentName: string, bankId: string): string {
  if (agentName === bankId) return agentName;
  return `${agentName} (bank: ${bankId})`;
}

function buildSessionGreetingScript(
  _name: string,
  _agentConfig: AgentConfig,
  _telegramConfig: TelegramConfig,
  _topicId: number | undefined,
  _userId: string | undefined,
  _quotaConfig: QuotaConfig | undefined,
): string {
  // The boot card (posted by the Telegram gateway on every gateway start)
  // is now the single source of restart-status visibility. The
  // SessionStart greeting that this function used to render is
  // disabled — it sent a separate "Switchroom · <agent> online" message
  // on every Claude Code session that duplicated the boot card's
  // information. We keep the function + the file write + the hook
  // registration intact so existing scaffold expectations and the hook
  // budget tests stay green; the script body is now a no-op that just
  // logs the invocation for diagnostics.
  return `#!/bin/bash
# Auto-generated by switchroom scaffold/reconcile.
# SessionStart greeting is disabled — the boot card (gateway) is now the
# single source of restart-status visibility on every restart. This
# script is intentionally a no-op so the hook registration stays intact
# without sending a duplicate Telegram message. See PR that introduced
# this stub for the rationale.

_GLOG="\${TELEGRAM_STATE_DIR:-/tmp}/session-greeting.log"
_log() { printf '[%s pid=%d ppid=%d] %s\\n' "$(date -Iseconds)" "$$" "$PPID" "$*" >> "$_GLOG" 2>/dev/null || true; }
_log "INVOKED (no-op: boot-card replaces session greeting) cwd=$PWD agent=\${SWITCHROOM_AGENT_NAME:-UNSET}"
exit 0
`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Format a relative time like "2m ago" / "3h ago" / "5d ago" from an
 * ISO 8601 timestamp. Returns null if the input is null or unparseable.
 */
function formatRelativeAgo(iso: string | null): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const diffSec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

/**
 * Format the Version row shown in the greeting card. Two shapes:
 *   - on a tag (commits_ahead = 0 or null):   "v0.2.0 · #44 · 2h ago"
 *     (omit "#44 ·" when no PR was parsed)
 *   - ahead of a tag (commits_ahead > 0):     "v0.2.0+3 · db6de9e · 2m ago"
 *     (always show short SHA when ahead, omit PR)
 * The age segment is omitted if no commit date is available (npm consumer).
 */
function formatVersionRow(): string {
  const ago = formatRelativeAgo(COMMIT_DATE);
  const onTag = COMMITS_AHEAD_OF_TAG === 0 || COMMITS_AHEAD_OF_TAG === null;

  if (onTag) {
    const parts: string[] = [`v${VERSION}`];
    if (LATEST_PR != null) parts.push(`#${LATEST_PR}`);
    if (ago) parts.push(ago);
    return parts.join(" · ");
  }

  const parts: string[] = [`v${VERSION}+${COMMITS_AHEAD_OF_TAG}`];
  if (COMMIT_SHA) parts.push(COMMIT_SHA);
  if (ago) parts.push(ago);
  return parts.join(" · ");
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
export function buildCronScript(
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

# Auth: always OAuth, never API key.
# Defensively unset ANTHROPIC_API_KEY so any ambient env or systemd
# Environment= mapping cannot silently shift cron auth from OAuth
# subscription quota to API billing.
unset ANTHROPIC_API_KEY
export CLAUDE_CONFIG_DIR=${shellSingleQuote(agentDir + "/.claude")}

# Inject OAuth token from the agent's own .oauth-token file.
unset CLAUDE_CODE_OAUTH_TOKEN
if [ -f "$CLAUDE_CONFIG_DIR/.oauth-token" ]; then
  export CLAUDE_CODE_OAUTH_TOKEN="$(cat "$CLAUDE_CONFIG_DIR/.oauth-token" | tr -d '[:space:]')"
fi

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
 * Pre-seed migration: if the agent has a legacy `workspace/AGENTS.md`
 * regular file (pre-Phase 5 scaffold) and no `workspace/CLAUDE.md` yet,
 * rename AGENTS.md → CLAUDE.md so any agent-specific edits survive.
 * The subsequent seed pass is `writeIfMissing`, so it will skip CLAUDE.md
 * and preserve the migrated content. A later step replaces AGENTS.md with
 * a symlink into CLAUDE.md.
 *
 * Safe to call multiple times — does nothing if AGENTS.md is already a
 * symlink or if CLAUDE.md already exists.
 */
function migrateLegacyAgentsMdIfPresent(
  agentWorkspaceDir: string,
  created: string[],
): void {
  const agentsMd = join(agentWorkspaceDir, "AGENTS.md");
  const claudeMd = join(agentWorkspaceDir, "CLAUDE.md");
  if (!existsSync(agentsMd)) return;
  const stat = lstatSync(agentsMd);
  if (stat.isSymbolicLink()) return; // already migrated
  if (existsSync(claudeMd)) {
    // CLAUDE.md already present — legacy AGENTS.md will be removed by
    // ensureClaudeMdSymlinks so the symlink can take its place.
    return;
  }
  // Preserve agent-specific customizations by renaming.
  const content = readFileSync(agentsMd, "utf-8");
  writeFileSync(claudeMd, content, "utf-8");
  rmSync(agentsMd);
  created.push(claudeMd);
  console.log(
    chalk.dim(
      `  migrated legacy workspace/AGENTS.md → workspace/CLAUDE.md (content preserved)`,
    ),
  );
}

/**
 * Ensure `workspace/AGENTS.md` and `workspace/AGENT.md` are symlinks
 * pointing at `CLAUDE.md`. Mirrors the pattern used in the switchroom
 * repo's own root where AGENTS.md/AGENT.md are symlinks to CLAUDE.md so
 * every tooling convention resolves to the same file.
 *
 * Migration-safe: removes any pre-existing regular file or wrong-target
 * symlink at those paths before re-linking. Idempotent across reconcile
 * runs.
 *
 * No-op if workspace/CLAUDE.md doesn't exist (edge case — template wasn't
 * rendered, nothing to link to).
 */
function ensureClaudeMdSymlinks(
  agentWorkspaceDir: string,
  changes: string[],
): void {
  const claudeMd = join(agentWorkspaceDir, "CLAUDE.md");
  if (!existsSync(claudeMd)) return;

  for (const name of ["AGENTS.md", "AGENT.md"] as const) {
    const linkPath = join(agentWorkspaceDir, name);
    if (existsSync(linkPath) || lstatExists(linkPath)) {
      const stat = lstatSync(linkPath);
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(linkPath);
        if (target === "CLAUDE.md") continue; // already correct
        rmSync(linkPath);
      } else {
        // Regular file from a previous scaffold — remove so the symlink
        // can take its place. Content has already been migrated into
        // CLAUDE.md by migrateLegacyAgentsMdIfPresent when applicable.
        rmSync(linkPath);
      }
    }
    symlinkSync("CLAUDE.md", linkPath);
    changes.push(linkPath);
  }
}

/**
 * `existsSync` follows symlinks, so a broken symlink reads as "doesn't
 * exist". Use lstat to detect link entries regardless of target health.
 */
function lstatExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
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
  // Skip the copy when the installed plugin.json version matches the vendor
  // version to avoid unnecessary I/O on every `switchroom update`.
  const destPath = join(agentDir, ".claude", "plugins", "hindsight-memory");
  const vendorManifestPath = join(sourcePath, ".claude-plugin", "plugin.json");
  const installedManifestPath = join(destPath, ".claude-plugin", "plugin.json");

  let vendorVersion: string | null = null;
  let installedVersion: string | null = null;
  try {
    const m = JSON.parse(readFileSync(vendorManifestPath, "utf8")) as { version?: string };
    vendorVersion = m.version ?? null;
  } catch { /* unreadable or missing */ }
  if (vendorVersion !== null && existsSync(installedManifestPath)) {
    try {
      const m = JSON.parse(readFileSync(installedManifestPath, "utf8")) as { version?: string };
      installedVersion = m.version ?? null;
    } catch { /* unreadable */ }
  }

  if (vendorVersion === null || vendorVersion !== installedVersion || !existsSync(destPath)) {
    if (existsSync(destPath)) {
      rmSync(destPath, { recursive: true, force: true });
    }
    copyDirRecursive(sourcePath, destPath);
  }

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
\`progress_update\` is only for mid-turn check-ins.

## Think out loud before tool calls

When you're about to call a tool — especially on the second and later
tool calls in a turn — lead the assistant message with one short
sentence naming what you're doing: "Reading the config.", "Running the
migration.", "Searching for X." The progress card pairs that sentence
with the tool as a natural-language step, so the user can tell what's
happening without decoding raw tool names. Without a preamble the card
goes quiet during long tool chains and feels stuck. Keep it to one
line; don't repeat the preamble before every call in a fast sequence,
but do refresh it when you switch to a genuinely different step.`;

      const memoryGuidance = `## Memory — proactive, conversational

You have Hindsight tools: \`mcp__hindsight__sync_retain\`, \`mcp__hindsight__delete_memory\`, \`mcp__hindsight__recall\`, \`mcp__hindsight__reflect\`. Use them without being asked.

### Retain proactively
When the user shares a fact, preference, decision, or plan worth keeping across sessions, call \`sync_retain\` in the same turn. Briefly acknowledge in your reply ("got it, April 2nd anniversary"). Don't narrate the tool call. Skip small talk and transient tool output, the auto-retain hook handles conversation-level signal.

### Correct proactively
When the user corrects you or contradicts a prior memory, call \`delete_memory\` on the wrong entry, then \`sync_retain\` the correction. Acknowledge the correction in one line ("noted, Alice not Bob").

### Forget proactively
When the user asks you to forget something ("forget that", "delete X", "drop what I said about Y"), call \`delete_memory\` for matching entries and confirm what was removed.

### Inspect proactively
When the user asks "what do you know about X / me", "what do you remember about Y", or any memory audit, use \`reflect\` to synthesize an answer across the bank. Return it as honest prose, not a raw dump. If the bank has little on the topic, say so.

Don't wait for a slash command. Don't ask permission. Memory work is table stakes, like a colleague who takes notes and remembers.`;

      if (useSwitchroomPlugin) {
        const parts = [baseAppend, telegramGuidance, memoryGuidance].filter(s => s.length > 0);
        const combined = parts.join('\n\n---\n\n');
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
      const switchroomStopHooks: Array<{ type: string; command: string; timeout: number; async: boolean }> = [];
      if (handoffEnabled) {
        switchroomStopHooks.push({
          type: "command",
          command: `switchroom${handoffConfigArg} handoff ${name}`,
          timeout: 35,
          async: true,
        });
      }
      // User-profile Mental Model refresh hook (when Hindsight is enabled)
      if (hindsightEnabled) {
        switchroomStopHooks.push({
          type: "command",
          command: `bash "${join(REPO_ROOT, "bin", "user-profile-refresh-hook.sh")}"`,
          timeout: 10,
          async: true,
        });
      }
      // Switchroom-owned secret-scrub Stop hook: scans transcript at shutdown
      // and rewrites any currently-active vault values to vault:${slug}.
      // Gated on telegram-plugin being in use (the hook script ships with
      // the plugin and only makes sense when the plugin-backed vault flow
      // is active). Async so it can't block session shutdown.
      const useSwitchroomPluginHook = usesSwitchroomTelegramPlugin(agentConfig);
      if (useSwitchroomPluginHook) {
        switchroomStopHooks.push({
          type: "command",
          command: `node "${join(REPO_ROOT, "telegram-plugin", "hooks", "secret-scrub-stop.mjs")}"`,
          timeout: 15,
          async: true,
        });
      }
      const switchroomStop = switchroomStopHooks.length > 0
        ? [{ hooks: switchroomStopHooks }]
        : [];
      // Switchroom-owned PreToolUse hook: blocks any tool call whose input
      // contains a currently-active vault value verbatim (second-line
      // defense against secrets leaking past the ingest-side detector).
      // Same plugin gating as the Stop hook.
      const switchroomPreToolUse = useSwitchroomPluginHook
        ? [
            {
              hooks: [
                {
                  type: "command",
                  command: `node "${join(REPO_ROOT, "telegram-plugin", "hooks", "secret-guard-pretool.mjs")}"`,
                  timeout: 10,
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
        // Timezone hook — fast (one `date` call), emits a one-line
        // additionalContext string so the LLM sees fresh local time on every
        // turn. Placed last so the time-of-turn line renders near the bottom
        // of the hook-injected preamble. 3s timeout is generous headroom for
        // a call that should finish in <20ms.
        {
          hooks: [
            {
              type: "command",
              command: `bash "${join(REPO_ROOT, "bin", "timezone-hook.sh")}"`,
              timeout: 3,
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
          ...(switchroomPreToolUse.length > 0
            ? {
                PreToolUse: [
                  ...((userHooks.PreToolUse as unknown[]) ?? []),
                  ...switchroomPreToolUse,
                ],
              }
            : {}),
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
          ...(switchroomPreToolUse.length > 0 ? { PreToolUse: switchroomPreToolUse } : {}),
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

  // --- Seed workspace bootstrap files from profile (CLAUDE.md, USER.md, etc.)
  //
  //     Profiles may ship a `workspace/` subdirectory containing .hbs
  //     templates and plain files. Each .hbs is rendered into the agent's
  //     `workspace/` directory; plain files are copied verbatim. These files
  //     are user-editable afterwards — we only seed on first scaffold (via
  //     writeIfMissing) so user edits survive re-runs.
  //
  //     Phase 5: CLAUDE.md is the primary agent-protocol file; AGENTS.md
  //     and AGENT.md are symlinks to it. Run the legacy-AGENTS.md
  //     migration before seeding so any pre-Phase-5 customizations are
  //     preserved into CLAUDE.md before the seed pass runs.
  const phase5WorkspaceDir = join(agentDir, "workspace");
  mkdirSync(phase5WorkspaceDir, { recursive: true });
  migrateLegacyAgentsMdIfPresent(phase5WorkspaceDir, created);
  seedWorkspaceBootstrapFiles({
    profilePath,
    agentDir,
    context,
    created,
    skipped,
  });
  ensureClaudeMdSymlinks(phase5WorkspaceDir, created);

  // --- Initialize workspace as git repo (Phase 4) ---
  const workspaceDir = join(agentDir, "workspace");
  initWorkspaceGitRepo(workspaceDir, name);

  // --- Claude Code config (onboarding state) ---
  // Copy onboarding state (.claude.json) from the host's Claude installation
  // so the agent skips the first-run wizard, but intentionally do NOT copy
  // .credentials.json. Each agent must go through its own fresh OAuth flow
  // (Phase 2 policy: copyExistingCredentials removed from scaffold path).
  // Existing credential blobs can be stale and cause silent 401s.
  // Operators are directed to `switchroom auth login <agent>` or
  // `switchroom agent bootstrap <agent>` for a guided OAuth flow.
  //
  // UPGRADE WARN: if ~/.claude-home/.credentials.json (or ~/.claude/.credentials.json)
  // exists at scaffold time, we deliberately skip copying it. Agents that were
  // previously scaffolded with the old policy and already have their own
  // .credentials.json are unaffected — we never remove existing credential files.
  const existingClaudeJson = findExistingClaudeJson();
  if (existingClaudeJson) {
    copyOnboardingState(existingClaudeJson, agentDir);
    // NOTE: copyExistingCredentials() intentionally NOT called here (Phase 2).
    // Each agent gets its own fresh OAuth. See CHANGELOG.
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
      const rawBody = saDef.prompt ?? `You are the ${saName} sub-agent.`;
      // `telegramEnabled: true` reflects this scaffold path being inside
      // a switchroom-scaffolded agent (which always has a Telegram surface).
      // The actual gate is `defaultChatId` — when there's no userId we skip
      // the addendum cleanly inside `applyTelegramProgressGuidance`.
      const body = applyTelegramProgressGuidance(rawBody, {
        telegramEnabled: true,
        defaultChatId: userId,
      });
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
  if ((agentConfig.schedule?.length ?? 0) > 0) {
    const cronChatId = userId ?? telegramConfig.forum_chat_id;
    for (let i = 0; i < agentConfig.schedule!.length; i++) {
      const entry = agentConfig.schedule![i];
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
  setupPlugins(agentDir, usesSwitchroomTelegramPlugin(agentConfig));

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

  // Create the Hindsight bank idempotently. Without this, the first
  // `retain` call against the newly scaffolded agent blows up with a raw
  // foreign-key constraint violation because the bank doesn't exist yet
  // (see reference/onboarding-gap-analysis.md §1). create_bank is a no-op
  // if the bank already exists. We intentionally await this BEFORE the
  // downstream bank-mission and mental-model ops — those depend on the
  // bank existing and would fail the same way. If Hindsight itself is
  // unreachable we warn to stderr and carry on — agent scaffolding must
  // still succeed so the operator can start Hindsight and re-run
  // `switchroom agent reconcile <name>` to retry.
  if (hindsightEnabled) {
    const apiUrl = `${hindsightApiBaseUrl}/mcp/`;
    const bankOpsChain = createBank(apiUrl, hindsightBankId, { timeoutMs: 5000 })
      .then((result) => {
        if (result.ok) {
          console.log(`  ${chalk.green("✓")} Hindsight bank ready for ${formatAgentBankLabel(name, hindsightBankId)}`);
          return true;
        }
        if (result.reason === "Unreachable") {
          console.warn(
            `  ${chalk.yellow("⚠")} Hindsight unreachable — skipping bank creation for ${formatAgentBankLabel(name, hindsightBankId)}.`,
          );
          console.warn(
            `     Agent is still usable, but start Hindsight and run: switchroom agent reconcile ${name}`,
          );
        } else {
          console.warn(
            `  ${chalk.yellow("⚠")} Failed to create Hindsight bank for ${formatAgentBankLabel(name, hindsightBankId)}: ${result.reason}`,
          );
        }
        return false;
      })
      .catch((err) => {
        console.warn(`  ${chalk.yellow("⚠")} Hindsight bank create error for ${formatAgentBankLabel(name, hindsightBankId)}: ${err}`);
        return false;
      });

    // Update bank missions and ensure user-profile MM — both gated on the
    // bank actually existing.
    bankOpsChain.then((bankReady) => {
      if (!bankReady) return;

      if (agentConfig.memory?.bank_mission || agentConfig.memory?.retain_mission) {
        const missions: { bank_mission?: string; retain_mission?: string } = {};
        if (agentConfig.memory?.bank_mission) {
          missions.bank_mission = agentConfig.memory.bank_mission;
        }
        if (agentConfig.memory?.retain_mission) {
          missions.retain_mission = agentConfig.memory.retain_mission;
        }

        updateBankMissions(apiUrl, hindsightBankId, missions, { timeoutMs: 5000 })
          .then((result) => {
            if (result.ok) {
              console.log(`  ${chalk.green("✓")} Bank missions updated for ${formatAgentBankLabel(name, hindsightBankId)}`);
            } else {
              console.warn(`  ${chalk.yellow("⚠")} Failed to update bank missions for ${formatAgentBankLabel(name, hindsightBankId)}: ${result.reason}`);
            }
          })
          .catch((err) => {
            console.warn(`  ${chalk.yellow("⚠")} Bank mission update error for ${formatAgentBankLabel(name, hindsightBankId)}: ${err}`);
          });
      }

      ensureUserProfileMentalModel(apiUrl, hindsightBankId, { timeoutMs: 5000 })
        .then((result) => {
          if (result.ok) {
            console.log(`  ${chalk.green("✓")} User-profile Mental Model ready for ${formatAgentBankLabel(name, hindsightBankId)}`);
          } else {
            console.warn(`  ${chalk.yellow("⚠")} Failed to create user-profile MM for ${formatAgentBankLabel(name, hindsightBankId)}: ${result.reason}`);
          }
        })
        .catch((err) => {
          console.warn(`  ${chalk.yellow("⚠")} User-profile MM error for ${formatAgentBankLabel(name, hindsightBankId)}: ${err}`);
        });
    });
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

function classifyChange(
  path: string,
  agentDir: string,
  useHotReloadStable: boolean,
): ReloadSemantics {
  // Get the path relative to agentDir
  const relPath = path.startsWith(agentDir)
    ? path.slice(agentDir.length).replace(/^\//, "")
    : path;

  // Hot — per-turn hook re-reads
  if (relPath === "workspace/MEMORY.md") return "hot";
  if (relPath.startsWith("workspace/memory/") && relPath.endsWith(".md")) return "hot";
  if (relPath === "workspace/HEARTBEAT.md") return "hot";

  // Stable workspace files — classification depends on hotReloadStable flag
  // When hotReloadStable is true, these are re-injected on every turn via hook
  // When hotReloadStable is false (default), they're baked into --append-system-prompt at start
  const stableWorkspaceFiles = [
    "workspace/SOUL.md",
    "workspace/CLAUDE.md",
    "workspace/AGENTS.md",
    "workspace/AGENT.md",
    "workspace/USER.md",
    "workspace/IDENTITY.md",
    "workspace/TOOLS.md",
  ];
  if (stableWorkspaceFiles.includes(relPath)) {
    return useHotReloadStable ? "hot" : "stale-till-restart";
  }

  // CLAUDE.md stays stale-till-restart regardless (Claude Code's own file-load convention)
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

  // Timezone sanity check — warn when we fell back to server detection
  // AND the detected zone is UTC. That combination almost always means
  // the host is a container inheriting the platform default, not a real
  // expression of the user's locale, and the per-turn time hint will be
  // useless. Silent when an explicit value is present at any layer.
  {
    const resolvedTz = resolveTimezone(switchroomConfig, agentConfig);
    const source = classifyTimezoneSource(switchroomConfig, agentConfig);
    if (source === "detected" && resolvedTz === "UTC") {
      console.warn(
        `  ${chalk.yellow("⚠")} Timezone auto-detected as UTC from server. This is often a container default.`,
      );
      console.warn(
        `     Set \`timezone: "Region/City"\` in switchroom.yaml to silence this warning.`,
      );
    }
  }

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
      // Mirror scaffoldAgent's start.sh context — without this the
      // {{#unless useHotReloadStable}} block always renders, so flipping
      // hotReloadStable on never removes the _WS_STABLE bake from start.sh.
      useHotReloadStable: agentConfig.channels?.telegram?.hotReloadStable === true,
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
\`progress_update\` is only for mid-turn check-ins.

## Think out loud before tool calls

When you're about to call a tool — especially on the second and later
tool calls in a turn — lead the assistant message with one short
sentence naming what you're doing: "Reading the config.", "Running the
migration.", "Searching for X." The progress card pairs that sentence
with the tool as a natural-language step, so the user can tell what's
happening without decoding raw tool names. Without a preamble the card
goes quiet during long tool chains and feels stuck. Keep it to one
line; don't repeat the preamble before every call in a fast sequence,
but do refresh it when you switch to a genuinely different step.`;
        const memoryGuidance = `## Memory — proactive, conversational

You have Hindsight tools: \`mcp__hindsight__sync_retain\`, \`mcp__hindsight__delete_memory\`, \`mcp__hindsight__recall\`, \`mcp__hindsight__reflect\`. Use them without being asked.

### Retain proactively
When the user shares a fact, preference, decision, or plan worth keeping across sessions, call \`sync_retain\` in the same turn. Briefly acknowledge in your reply ("got it, April 2nd anniversary"). Don't narrate the tool call. Skip small talk and transient tool output, the auto-retain hook handles conversation-level signal.

### Correct proactively
When the user corrects you or contradicts a prior memory, call \`delete_memory\` on the wrong entry, then \`sync_retain\` the correction. Acknowledge the correction in one line ("noted, Alice not Bob").

### Forget proactively
When the user asks you to forget something ("forget that", "delete X", "drop what I said about Y"), call \`delete_memory\` for matching entries and confirm what was removed.

### Inspect proactively
When the user asks "what do you know about X / me", "what do you remember about Y", or any memory audit, use \`reflect\` to synthesize an answer across the bank. Return it as honest prose, not a raw dump. If the bank has little on the topic, say so.

Don't wait for a slash command. Don't ask permission. Memory work is table stakes, like a colleague who takes notes and remembers.`;
        if (useSwitchroomPlugin) {
          const parts = [baseAppend, telegramGuidance, memoryGuidance].filter(s => s.length > 0);
          const combined = parts.join('\n\n---\n\n');
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
    const switchroomStopHooksReconcile: Array<{ type: string; command: string; timeout: number; async: boolean }> = [];
    if (handoffEnabledReconcile) {
      switchroomStopHooksReconcile.push({
        type: "command",
        command: `switchroom handoff ${name}`,
        timeout: 35,
        async: true,
      });
    }
    // User-profile Mental Model refresh hook (when Hindsight is enabled)
    if (hindsightEnabled) {
      switchroomStopHooksReconcile.push({
        type: "command",
        command: `bash "${join(REPO_ROOT, "bin", "user-profile-refresh-hook.sh")}"`,
        timeout: 10,
        async: true,
      });
    }
    // Switchroom-owned secret-scrub Stop hook (mirror of scaffoldAgent
    // above — keep these two blocks in sync). See scaffold.ts secret-detect
    // commit for context.
    const useSwitchroomPluginReconcile = usesSwitchroomTelegramPlugin(agentConfig);
    if (useSwitchroomPluginReconcile) {
      switchroomStopHooksReconcile.push({
        type: "command",
        command: `node "${join(REPO_ROOT, "telegram-plugin", "hooks", "secret-scrub-stop.mjs")}"`,
        timeout: 15,
        async: true,
      });
    }
    const switchroomStop = switchroomStopHooksReconcile.length > 0
      ? [{ hooks: switchroomStopHooksReconcile }]
      : [];
    // Switchroom-owned PreToolUse hook: secret-guard (same as scaffoldAgent).
    const switchroomPreToolUse = useSwitchroomPluginReconcile
      ? [
          {
            hooks: [
              {
                type: "command",
                command: `node "${join(REPO_ROOT, "telegram-plugin", "hooks", "secret-guard-pretool.mjs")}"`,
                timeout: 10,
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
      // Timezone hook — see matching comment in scaffoldAgent for rationale.
      {
        hooks: [
          {
            type: "command",
            command: `bash "${join(REPO_ROOT, "bin", "timezone-hook.sh")}"`,
            timeout: 3,
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
        ...(switchroomPreToolUse.length > 0
          ? {
              PreToolUse: [
                ...((userHooks.PreToolUse as unknown[]) ?? []),
                ...switchroomPreToolUse,
              ],
            }
          : {}),
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
        ...(switchroomPreToolUse.length > 0 ? { PreToolUse: switchroomPreToolUse } : {}),
        ...(switchroomStop.length > 0 ? { Stop: switchroomStop } : {}),
      };
    }

    // Read userId from access.json (written during scaffold) — used by
    // both the sub-agent prompt addendum and the greeting script below.
    let greetingUserId: string | undefined;
    const accessPath = join(agentDir, "telegram", "access.json");
    if (existsSync(accessPath)) {
      try {
        const access = JSON.parse(readFileSync(accessPath, "utf-8"));
        greetingUserId = access.allowFrom?.[0];
      } catch { /* best effort */ }
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
        const rawBody = saDef.prompt ?? `You are the ${saName} sub-agent.`;
        const body = applyTelegramProgressGuidance(rawBody, {
          telegramEnabled: true,
          defaultChatId: greetingUserId,
        });
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
  if ((agentConfig.schedule?.length ?? 0) > 0) {
    let cronUserId: string | undefined;
    const cronAccessPath = join(agentDir, "telegram", "access.json");
    if (existsSync(cronAccessPath)) {
      try {
        const cronAccess = JSON.parse(readFileSync(cronAccessPath, "utf-8"));
        cronUserId = cronAccess.allowFrom?.[0];
      } catch { /* best effort */ }
    }
    for (let i = 0; i < agentConfig.schedule!.length; i++) {
      const entry = agentConfig.schedule![i];
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
  // Phase 5 migration: preserve any agent-specific edits to the legacy
  // workspace/AGENTS.md (pre-rename) by renaming it to CLAUDE.md before
  // the seed pass runs. seedWorkspaceBootstrapFiles is writeIfMissing,
  // so it will then skip CLAUDE.md and preserve the migrated content.
  const reconcileWorkspaceDir = join(agentDir, "workspace");
  mkdirSync(reconcileWorkspaceDir, { recursive: true });
  migrateLegacyAgentsMdIfPresent(reconcileWorkspaceDir, changes);
  seedWorkspaceBootstrapFiles({
    profilePath: reconcileProfilePath,
    agentDir,
    context: workspaceContext,
    created: changes,
    skipped: [],
  });
  ensureClaudeMdSymlinks(reconcileWorkspaceDir, changes);

  // --- Phase 4: idempotent workspace git init (for existing agents) ---
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

  const useHotReloadStableClassify = agentConfig.channels?.telegram?.hotReloadStable === true;
  for (const change of changes) {
    const semantics = classifyChange(change, agentDir, useHotReloadStableClassify);
    if (semantics === "hot") {
      hot.push(change);
    } else if (semantics === "stale-till-restart") {
      staleTillRestart.push(change);
    } else {
      restartRequired.push(change);
    }
  }

  // Ensure bank exists before any mission/MM ops — same rationale as
  // scaffoldAgent. reconcile is also the operator's retry path when
  // Hindsight was down during `agent create`.
  if (hindsightEnabled) {
    const apiUrl = `${hindsightApiBaseUrl}/mcp/`;
    const bankOpsChain = createBank(apiUrl, hindsightBankId, { timeoutMs: 5000 })
      .then((result) => {
        if (result.ok) {
          console.log(`  ${chalk.green("✓")} Hindsight bank ready for ${formatAgentBankLabel(name, hindsightBankId)}`);
          return true;
        }
        if (result.reason === "Unreachable") {
          console.warn(
            `  ${chalk.yellow("⚠")} Hindsight unreachable — skipping bank creation for ${formatAgentBankLabel(name, hindsightBankId)}.`,
          );
          console.warn(
            `     Start Hindsight, then re-run: switchroom agent reconcile ${name}`,
          );
        } else {
          console.warn(
            `  ${chalk.yellow("⚠")} Failed to create Hindsight bank for ${formatAgentBankLabel(name, hindsightBankId)}: ${result.reason}`,
          );
        }
        return false;
      })
      .catch((err) => {
        console.warn(`  ${chalk.yellow("⚠")} Hindsight bank create error for ${formatAgentBankLabel(name, hindsightBankId)}: ${err}`);
        return false;
      });

    bankOpsChain.then((bankReady) => {
      if (!bankReady) return;

      if (agentConfig.memory?.bank_mission || agentConfig.memory?.retain_mission) {
        const missions: { bank_mission?: string; retain_mission?: string } = {};
        if (agentConfig.memory?.bank_mission) {
          missions.bank_mission = agentConfig.memory.bank_mission;
        }
        if (agentConfig.memory?.retain_mission) {
          missions.retain_mission = agentConfig.memory.retain_mission;
        }

        updateBankMissions(apiUrl, hindsightBankId, missions, { timeoutMs: 5000 })
          .then((result) => {
            if (result.ok) {
              console.log(`  ${chalk.green("✓")} Bank missions updated for ${formatAgentBankLabel(name, hindsightBankId)}`);
            } else {
              console.warn(`  ${chalk.yellow("⚠")} Failed to update bank missions for ${formatAgentBankLabel(name, hindsightBankId)}: ${result.reason}`);
            }
          })
          .catch((err) => {
            console.warn(`  ${chalk.yellow("⚠")} Bank mission update error for ${formatAgentBankLabel(name, hindsightBankId)}: ${err}`);
          });
      }

      ensureUserProfileMentalModel(apiUrl, hindsightBankId, { timeoutMs: 5000 })
        .then((result) => {
          if (result.ok) {
            console.log(`  ${chalk.green("✓")} User-profile Mental Model ready for ${formatAgentBankLabel(name, hindsightBankId)}`);
          } else {
            console.warn(`  ${chalk.yellow("⚠")} Failed to create user-profile MM for ${formatAgentBankLabel(name, hindsightBankId)}: ${result.reason}`);
          }
        })
        .catch((err) => {
          console.warn(`  ${chalk.yellow("⚠")} User-profile MM error for ${formatAgentBankLabel(name, hindsightBankId)}: ${err}`);
        });
    });
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
