import {
  existsSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  readFileSync,
  chmodSync,
  symlinkSync,
  copyFileSync,
  readdirSync,
  rmSync,
  statSync,
  lstatSync,
  readlinkSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { execSync, execFileSync } from "node:child_process";
import { basename, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import chalk from "chalk";
import type { AgentConfig, QuotaConfig, SwitchroomConfig, TelegramConfig } from "../config/schema.js";
import { cronScriptFilename, CRON_SCRIPT_BASENAME_RE, LEGACY_CRON_SCRIPT_BASENAME_RE } from "./cron-unit-name.js";
import { OVERLAY_SOURCE } from "../config/overlay-loader.js";

// Repo root for referencing bin/ scripts in hooks
const REPO_ROOT = resolve(import.meta.dirname, "../..");

/**
 * Primer the agent reads on every session boot so it knows it's running
 * in a switchroom container with `read_only: true` rootfs and a fixed
 * set of writable mounts. When the agent later hits an EROFS or
 * "Read-only file system" error, this primer is what lets it produce a
 * clear "I tried X, that's read-only because of <reason>; operator
 * action needed" reply instead of either silently retrying or echoing
 * the raw kernel error to the user.
 *
 * Kept in lockstep across the two `systemPromptAppendShellQuoted`
 * call sites in this file — extracting to a top-level constant
 * prevents drift the way the prior duplication of telegramGuidance +
 * memoryGuidance did not.
 *
 * Why this string lives here and not in profiles/_base/*.hbs:
 *   - The .hbs files are written to disk per-agent and operator-
 *     editable; the sandbox primer is non-negotiable runtime context
 *     and shouldn't get accidentally diverged per agent.
 *   - Append-system-prompt is cache-friendly: same content every
 *     session boot means the model's KV cache hits warm.
 */
const SANDBOX_GUIDANCE = `## Sandbox: you're running in a switchroom container

Your container has \`read_only: true\` rootfs. Most paths are read-only.

### Writable
- \`/tmp\` — 256 MB tmpfs, ephemeral (gone on restart).
- \`$HOME\` (\`/state/agent/home\`) — persistent across restarts. \`npm\`,
  \`pip\`, \`git config --global\`, shell history, ssh keys all already
  configured to write here (\`NPM_CONFIG_PREFIX\`, \`PIP_USER=1\`, etc).
- \`/state/agent/**\` — your persistent agent dir.
- \`/var/log/switchroom\` — your log dir.

### Read-only (and why)
- \`/\`, \`/opt\`, \`/usr\`, \`/etc\`, \`/bin\`, \`/lib\` — rootfs hardening.
- \`~/.switchroom/skills/**\` — shared skill files; operator-owned.
- \`~/.switchroom/credentials/**\` — secrets; immutable from your view.
- \`/state/config/switchroom.yaml\` — fleet config; operator-owned.

### When you hit "read-only file system" / EROFS

This is **the sandbox working as intended**, not a bug. Don't retry the
same write. Don't apologise vaguely. Instead:

1. Recognise the signal: \`EROFS\`, "Read-only file system", "permission
   denied" on a path under \`/opt\`, \`/usr\`, \`/etc\`, or
   \`~/.switchroom/{skills,credentials}\`.
2. Tell the user in plain language what you tried and why the sandbox
   blocked it.
3. Suggest the right path: a writable alternative if your goal is
   reachable that way, or explicit operator action otherwise.

Example response shapes:

- "I tried to edit \`~/.switchroom/skills/foo/script.sh\` — that's
  mounted read-only from my view. **Operator action**: edit it on the
  host, then \`switchroom apply\` to re-scaffold."
- "I wanted to \`apt install <pkg>\`. My container's rootfs is read-only
  and I'm not root. **Operator action**: add the package to
  \`docker/Dockerfile.agent\` and rebuild the agent image."
- "I tried to clone into \`/workspace\` — that path doesn't exist in my
  sandbox. Cloning into \`$HOME/workspace\` instead."`;

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
  renderProfileClaudeTemplate,
  renderVaultProtocolFragment,
  renderAgentSelfServiceFragment,
} from "./profiles.js";
import {
  getHindsightSettingsEntry,
  getBuiltinDefaultMcpEntries,
  getGdriveMcpSettingsEntry,
  shouldEmitGdriveMcp,
} from "../memory/scaffold-integration.js";
import { reconcileAgentDefaultSkills } from "./reconcile-default-skills.js";
import { applyTelegramProgressGuidance, applyCronTelegramGuidance } from "./sub-agent-telegram-prompt.js";
import type { McpServerConfig } from "../memory/hindsight.js";
import { createBank, updateBankMissions, ensureUserProfileMentalModel, DEFAULT_RETAIN_MISSION, isHindsightEnabled } from "../memory/hindsight.js";
import { loadTopicState } from "../telegram/state.js";
import { resolveDualPath } from "../config/paths.js";
import { resolvePath } from "../config/loader.js";
import { isVaultReference, parseVaultReference } from "../vault/resolver.js";
import { openVault, VaultError } from "../vault/vault.js";
import {
  findExistingClaudeJson,
  copyOnboardingState,
  preTrustWorkspace,
  ensureMcpServersTrusted,
  createMinimalClaudeConfig,
  loadUserConfig,
} from "../setup/onboarding.js";
import { ensureBareClone, bareClonePath } from "../repos/bare-clone.js";
import {
  ensureAgentWorktree,
  removeAgentWorktree,
  listAgentWorktrees,
  agentWorktreePath,
  type WorktreeState,
} from "../repos/agent-worktree.js";

export interface ScaffoldResult {
  agentDir: string;
  created: string[];
  skipped: string[];
}

/**
 * Align ownership of an agent's per-agent state directories with the
 * deterministic container UID assigned by compose.ts.
 *
 * Why this is required: in Docker mode the agent container runs as
 * `user: <uid>` (a hash-derived value in 10001–10999). The container
 * bind-mounts the host's `~/.switchroom/agents/<name>` etc. into
 * `/state/agent`. If those host directories are still owned by the
 * operator (uid 1000), the container UID (10001+) cannot write to
 * them and the agent silently fails to write logs / state / Claude
 * settings on first boot. The fix is to chown the dirs once at
 * scaffold time so the bind-mount lands writable.
 *
 * Implementation note: the chown target is well outside the operator's
 * uid space, so `chownSync` typically needs CAP_CHOWN — i.e. sudo.
 * We try the unprivileged chown first (works if the agent already
 * exists from a prior run); on EPERM we shell out to `sudo chown -R`
 * which prompts the operator's password. Set `confirm` to false to
 * skip the inline prompt (apply --non-interactive path).
 *
 * Returns the list of paths chown'd. Throws only when sudo itself
 * exits non-zero — that's an operator-actionable failure (wrong
 * password, no sudoers entry).
 */
export interface AlignAgentUidOptions {
  /** Suppress the y/n prompt; assume yes. Used by `--non-interactive`. */
  confirm?: boolean;
  /** Stdout writer for status lines; defaults to console.log. */
  writeOut?: (s: string) => void;
  /** Skip the chown entirely (dry-run / tests). */
  dryRun?: boolean;
}

export function alignAgentUid(
  name: string,
  agentDir: string,
  uid: number,
  opts: AlignAgentUidOptions = {},
): { chowned: boolean; paths: string[] } {
  const writeOut = opts.writeOut ?? ((s: string) => process.stdout.write(s));

  // The agent state dir is the primary target. We also align the per-agent
  // log dir (~/.switchroom/logs/<name>) — Dockerfile.agent creates
  // /var/log/switchroom as root:root 0755, the compose volume mount
  // inherits that ownership, and start.sh's docker-mode supervisor forks
  // gateway and autoaccept-poll sidecars whose `>> /var/log/switchroom/*.log`
  // redirects fail silently as the in-container agent UID. Without the
  // log dir chowned to the agent UID, the sidecars exit immediately at
  // boot and the agent comes up without autoaccept or the gateway daemon.
  // See #880.
  const logsDir = join(homedir(), ".switchroom", "logs", name);
  const paths: string[] = [];
  if (existsSync(agentDir)) paths.push(agentDir);
  if (existsSync(logsDir)) paths.push(logsDir);
  if (paths.length === 0) return { chowned: false, paths: [] };

  // No fast-path: a previous `apply` may have aligned the top-level dirs
  // while leaving stale uid 1000 entries deep in the subtree (e.g. the
  // operator dropped files in via sudo, or a v0.6 → v0.7 migration
  // chowned the root but skipped a child). `chown -R` is idempotent and
  // cheap, so we always run it. Pre-`chown` we record the prior owner of
  // each top-level path to ~/.switchroom/.uid-alignment.log so rollback
  // can restore precise ownership without guessing.
  const priors: Array<{ path: string; uid: number; gid: number } | { path: string; uid: undefined; gid: undefined }> = [];
  for (const p of paths) {
    try {
      const st = statSync(p);
      priors.push({ path: p, uid: st.uid, gid: st.gid });
    } catch {
      priors.push({ path: p, uid: undefined, gid: undefined });
    }
  }

  if (opts.dryRun) return { chowned: false, paths };

  try {
    const logPath = join(homedir(), ".switchroom", ".uid-alignment.log");
    mkdirSync(join(homedir(), ".switchroom"), { recursive: true });
    const ts = new Date().toISOString();
    for (const prior of priors) {
      if (prior.uid !== undefined && prior.gid !== undefined && (prior.uid !== uid || prior.gid !== uid)) {
        appendFileSync(
          logPath,
          `${ts} ${prior.path} ${prior.uid}:${prior.gid} -> ${uid}:${uid}\n`,
        );
      }
    }
  } catch { /* best-effort audit; never block alignment */ }

  if (opts.confirm !== false && process.stdin.isTTY) {
    // Interactive prompt: explain why we're shelling sudo. We use
    // execFileSync below with stdio inherited so the password prompt
    // appears on the operator's terminal.
    writeOut(
      chalk.gray(
        `  · aligning ${name} state + log dir ownership to uid ${uid} (sudo chown)\n`,
      ),
    );
  }

  // Try unprivileged chown first; sudo only if EPERM.
  try {
    // Recursive chown via shell — node's fs.chownSync isn't recursive
    // and rolling our own walk just to fall back to sudo is wasted code.
    execFileSync("chown", ["-R", `${uid}:${uid}`, ...paths], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    return { chowned: true, paths };
  } catch {
    // chown failed — most commonly EPERM because the operator's uid
    // doesn't have CAP_CHOWN. Fall through to sudo. We don't try to
    // discriminate on errno here because execFileSync's error shape
    // is messy across node versions; the sudo path is the
    // operator-actionable fix regardless.
  }

  try {
    execFileSync("sudo", ["chown", "-R", `${uid}:${uid}`, ...paths], {
      stdio: "inherit",
    });
    return { chowned: true, paths };
  } catch {
    throw new Error(
      `alignAgentUid: sudo chown failed for ${paths.join(", ")} (target uid ${uid}). Run manually: sudo chown -R ${uid}:${uid} ${paths.join(" ")}`,
    );
  }
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
    if (existsSync(globalFile) && !existsSync(agentFile)) {
      try {
        if (useSwitchroomPlugin && file === "installed_plugins.json") {
          const scrubbed = stripOfficialTelegramPlugin(readFileSync(globalFile, "utf8"));
          writeFileSync(agentFile, scrubbed);
        } else {
          copyFileSync(globalFile, agentFile);
        }
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
  "mcp__switchroom-telegram__delete_message",
  "mcp__switchroom-telegram__forward_message",
  "mcp__switchroom-telegram__download_attachment",
  "mcp__switchroom-telegram__get_recent_messages",
  "mcp__switchroom-telegram__progress_update",
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
 * Pre-approved MCP tool names for the `agent-config` server (every
 * agent has this server wired via .mcp.json). Without these in the
 * allow list, every first-time call to skill_list / cron_list /
 * config_get / audit_tail / peers_list / schedule_add / schedule_remove
 * / skill_install / skill_remove blocks on a Claude Code permission
 * prompt that the operator has to approve via Telegram. The first
 * inbound that needs one of these tools wedges the agent — the very
 * regression that surfaced in the UAT for PR #1215 (skill_list
 * permission popup screenshot). Wildcard covers future additions to
 * the same server without another scaffold bump.
 */
const AGENT_CONFIG_MCP_TOOLS = [
  "mcp__agent-config",
  "mcp__agent-config__*",
];

/**
 * Pre-approved hostd MCP tool names. ONLY the pure read-only verb
 * (`update_check` — a `switchroom update --check` dry-run, no side
 * effects) is pre-approved; pre-approving it just avoids a first-use
 * permission wedge on a harmless query.
 *
 * The mutating / host-control verbs the hostd MCP server also exposes
 * — `update_apply`, `agent_exec`, `agent_restart`, `agent_start`,
 * `agent_stop`, `agent_logs` — are deliberately ABSENT from this list
 * and the old blanket `mcp__hostd` / `mcp__hostd__*` wildcard is gone.
 * A prompt-injected admin agent invoking one of them now hits the
 * Telegram approval card (human-in-the-loop) instead of executing
 * silently. That is the fix for apex-chain link 1 of #1400: the
 * daemon-side checkGate still authorizes, but it is no longer the
 * ONLY thing between an injected agent and a host-root-equivalent
 * `update_apply`/`agent_exec`. Operator-initiated `/restart`,
 * `/update apply`, etc. are unaffected — those dispatch through the
 * gateway's direct hostd UDS path, not the agent's MCP tool surface.
 *
 * See docs/rfcs/host-control-daemon.md §5.4 and the
 * project_hostd_admin_privilege_human_approval design call: autonomous
 * only for self + read-only; mutating / host verbs gated by approval.
 * Existing fleet agents that already baked in the wildcard are
 * converged by the LEGACY_HOSTD_BLANKET_TOKENS retraction on reconcile.
 */
const HOSTD_MCP_TOOLS = [
  "mcp__hostd__update_check",
];

/**
 * Legacy `mcp__switchroom__*` permission tokens that pre-#235 agents have
 * baked into their `settings.permissions.allow`. The switchroom-mcp server
 * is deprecated (#235) — its 4 tools were dormant (zero callers) and the
 * functionality is covered natively by Hindsight's MCP (`mcp__hindsight__*`)
 * + Claude Code's built-in `Read`/`Grep`/`Edit`. Reconcile actively strips
 * these so existing agents don't keep stale entries forever.
 */
const LEGACY_SWITCHROOM_MCP_TOKENS = ["mcp__switchroom", "mcp__switchroom__*"];

/**
 * The pre-#1400 blanket hostd grant. Earlier scaffolds pre-approved
 * `mcp__hostd` + `mcp__hostd__*` unconditionally, so a prompt-injected
 * admin agent could invoke the mutating host-control verbs
 * (`update_apply` / `agent_exec` / `agent_restart` / …) with NO
 * Telegram approval prompt — apex-chain link 1 of #1400. Reconcile
 * actively strips these tokens so existing fleet agents converge on
 * the narrowed read-only-only HOSTD_MCP_TOOLS set and the mutating
 * verbs fall through to the human approval card. Mirrors the
 * LEGACY_SWITCHROOM_MCP_TOKENS retraction pattern.
 */
const LEGACY_HOSTD_BLANKET_TOKENS = ["mcp__hostd", "mcp__hostd__*"];

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
  // Skill itself just loads instruction context — the side-effecting
  // tools the skill body invokes (Bash, Write, etc) retain their own
  // approval gates. Pre-approving Skill lets routine "/loop", "/init",
  // and the bundled-skill invocations land without a prompt, which
  // matters for the skill-coverage UAT runner (every probe would
  // otherwise stall on an approval).
  "Skill",
];

/**
 * Switchroom-shipped default model + thinking effort for main agents.
 *
 * Sonnet 4.6 + effort=low is the right starting point for the
 * conversational main-agent role:
 *   - Time-to-first-token is ~3–5s vs Opus's 15–30s on chat replies.
 *     Forensics on a real klanker turn (2026-04-30 11:59:30Z) showed
 *     19s of Opus extended-thinking dominating a 25s turn — most of
 *     that thinking is wasted on chat-mode answers.
 *   - Sonnet 4.6 input cost is ~5x lower; effort=low cuts hidden
 *     thinking tokens to near-zero.
 *   - Accuracy on chat / lookup / structured replies is ~95% of Opus.
 *     The accuracy gap opens up on hard reasoning, code, research
 *     synthesis — exactly the workloads CLAUDE.md tells the main agent
 *     to delegate to sub-agents (worker / researcher / reviewer).
 *
 * Operators override per-agent or in `defaults.model` / `defaults.thinking_effort`
 * in switchroom.yaml when an agent's role demands more reasoning at the
 * main-session level (rare).
 *
 * Sub-agents are NOT affected by these constants — sub-agent models are
 * resolved separately from `SubagentSchema.model` (default falls back to
 * "claude-sonnet-4-6" when a sub-agent doesn't specify, see line ~1778
 * in this file). Sub-agents that want Opus reasoning should set
 * `model: opus` explicitly.
 */
export const SWITCHROOM_DEFAULT_MAIN_MODEL = "claude-sonnet-4-6";
export const SWITCHROOM_DEFAULT_THINKING_EFFORT = "low";

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
 * Human-readable label for an agent + its Hindsight bank in log output.
 * When they match (default case): just the agent name ("clerk").
 * When they differ (custom memory.collection in yaml, e.g. legacy bank_id):
 * "clerk (bank: assistant)" to avoid confusing the bank ID with the agent name.
 */
function formatAgentBankLabel(agentName: string, bankId: string): string {
  if (agentName === bankId) return agentName;
  return `${agentName} (bank: ${bankId})`;
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
 * with the configured model and wraps the prompt via applyCronTelegramGuidance
 * so the model delivers its message via the MCP reply tool rather than stdout.
 * The script is self-contained — sources nvm and sets CLAUDE_CONFIG_DIR.
 *
 * Cron tasks deliver their Telegram message via the MCP `reply` tool
 * (applied by `applyCronTelegramGuidance`) and emit `HEARTBEAT_OK` to a
 * discarded stdout. This unifies cron and live-session rendering through
 * the same plugin path.
 */
export function buildCronScript(
  agentDir: string,
  prompt: string,
  model: string,
  chatId: string,
  userId: string | undefined,
  secrets: string[] = [],
  brokerSocket?: string,
  jobSlug?: string,
): string {
  // jobSlug is the stable identifier used for issue auto-resolve. Defaults
  // to a dash if not supplied — tests covering the legacy 7-arg signature
  // still pass, but production scaffold/reconcile call sites always pass
  // `cron-<index>` so the trailer can target unresolved issues whose source
  // is `cron:<jobSlug>`. See applyCronTelegramGuidance for the matching
  // instruction on the prompt side.
  const slug = jobSlug ?? "unknown";
  const wrappedPrompt = applyCronTelegramGuidance(prompt, { chatId, jobSlug: slug });
  const secretsComment = secrets.length > 0
    ? `# Allowed vault keys for this cron (broker ACL): ${secrets.join(", ")}\n`
    : "";
  // Export the broker socket path so `switchroom vault get` calls within
  // the cron script connect to the running broker without a config read.
  // The export is always emitted when a brokerSocket is provided, even if
  // secrets is empty — a future cron task may add secrets without a scaffold
  // regeneration, and having the env var set is harmless when unused.
  const brokerSocketExport = brokerSocket
    ? `export SWITCHROOM_VAULT_BROKER_SOCK=${shellSingleQuote(brokerSocket)}\n`
    : "";
  return `#!/bin/bash
# Auto-generated by switchroom scaffold/reconcile.
# One-shot scheduled task — runs claude -p, delivers output via MCP reply tool.
${secretsComment}${brokerSocketExport}
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
# SWITCHROOM_AGENT_NAME mirrors the gateway's container/unit environment.
# Required so in-prompt \`switchroom issues
# record\` calls without an explicit --agent flag attribute correctly,
# and so the vault broker client can resolve a default agent.
export SWITCHROOM_AGENT_NAME=${shellSingleQuote(basename(agentDir))}

# CLAUDE_CODE_OAUTH_TOKEN injection was removed with RFC H (auth-broker).
# Claude reads .credentials.json directly; the auth-broker writes it
# atomically and refreshes ahead of claude's own window.
unset CLAUDE_CODE_OAUTH_TOKEN

# MCP-only delivery path (issue #269, closes #251): the prompt instructs
# the model to call mcp__switchroom-telegram__reply directly, then print
# HEARTBEAT_OK as its sole stdout line. Stdout is discarded here so the
# trailing model summary doesn't arrive as a second Telegram message.
# Stderr remains open so systemd captures auth/network/bad-prompt errors
# via journalctl — silently swallowing those would make a broken cron job
# invisible to operators.
#
# We deliberately do NOT use \`exec\` here — the success-trailer below must
# run after \`claude -p\` returns. Same reasoning as PR #565: when a cron
# completes cleanly, any unresolved issues filed against this job's source
# get auto-closed. Failure (non-zero exit) leaves issues open for the
# Telegram surface to render, exactly as before.
export TELEGRAM_STATE_DIR=${shellSingleQuote(join(agentDir, "telegram"))}
claude -p ${shellSingleQuote(wrappedPrompt)} \\
  --model ${shellSingleQuote(model)} \\
  --no-session-persistence \\
  > /dev/null
rc=$?
if [ $rc -eq 0 ]; then
  # Best-effort auto-resolve. Failure here (e.g. switchroom not on PATH in a
  # weird environment) must NOT mask the cron's own success — hence the
  # trailing \`|| true\`. PR #565 added bulk-close-by-source; we use the same
  # source string the agent's own \`issues record\` calls should use.
  switchroom issues resolve --source "cron:${slug}" --quiet \\
    --state-dir "$TELEGRAM_STATE_DIR" >/dev/null 2>&1 || true
fi
exit $rc
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
  // point elsewhere are left untouched. Bundled-default symlinks
  // (targets under `~/.switchroom/skills/_bundled/`) are owned by the
  // reconcile-default-skills path; skip them here so we don't prune
  // them as orphans (RCA: #1164).
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
    if (linkTarget && linkTarget.includes("/.switchroom/skills/_bundled/")) {
      continue; // owned by reconcile-default-skills
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
 * **Role gate (#235 follow-up).** Only `role: "foreman"` agents get
 * the bundled operator skills. Default-role assistants are fleet
 * agents doing user-facing tasks; loading switchroom-manage / install
 * / health into their tool list adds cognitive overhead per turn for
 * no benefit (they never call these skills). For non-foreman roles
 * this function actively REMOVES any pre-existing operator skill
 * symlinks (idempotent retraction) so a role flip foreman → assistant
 * cleans up correctly on the next reconcile.
 *
 * Rules:
 *   - Only directories that start with "switchroom-" and contain a SKILL.md
 *     file are linked (when installing).
 *   - The destination .claude/skills/ directory is created if absent.
 *   - Existing entries at the destination are left untouched on install
 *     (idempotent symlink refresh; pre-existing real dirs/files preserved).
 *   - On retraction, only switchroom-installed symlinks are removed —
 *     never real dirs/files (operator may have placed those manually).
 */
export function installSwitchroomSkills(
  agentDir: string,
  opts: { role?: "assistant" | "foreman" } = {},
): void {
  const builtinSkillsDir = resolve(homedir(), ".switchroom/skills/_bundled");
  if (!existsSync(builtinSkillsDir)) {
    process.stderr.write(
      `switchroom: bundled skills pool dir not found at ${builtinSkillsDir} — run \`switchroom update\` to install it.\n`,
    );
    return;
  }

  const targetDir = join(agentDir, ".claude", "skills");
  mkdirSync(targetDir, { recursive: true });

  // Discover the universe of switchroom-* skills upfront so the same
  // list drives both install and retract paths.
  let entries: string[];
  try {
    entries = readdirSync(builtinSkillsDir);
  } catch {
    return;
  }
  // Universal-default switchroom-* skills (cli/status/health) flow through
  // the new bundled-defaults path (`reconcileAgentDefaultSkills`) for ALL
  // roles, with per-key opt-out. Exclude them here so the foreman-gate
  // logic only owns the operator-only trio (install/manage/architecture).
  const universalDefaultSkills = new Set([
    "switchroom-cli",
    "switchroom-status",
    "switchroom-health",
  ]);
  const switchroomSkillNames = entries.filter((name) => {
    if (!name.startsWith("switchroom-")) return false;
    if (universalDefaultSkills.has(name)) return false;
    const src = join(builtinSkillsDir, name);
    try {
      const st = lstatSync(src);
      return st.isDirectory() && existsSync(join(src, "SKILL.md"));
    } catch {
      return false;
    }
  });

  // Role gate: only foreman agents get the operator skills auto-installed.
  // For other roles, retract any pre-existing symlinks (idempotent).
  if (opts.role !== "foreman") {
    for (const name of switchroomSkillNames) {
      const dest = join(targetDir, name);
      let existing;
      try {
        existing = lstatSync(dest);
      } catch {
        continue; // nothing to retract
      }
      // Only remove symlinks we plausibly installed. Don't touch real
      // dirs or files the operator placed there manually.
      if (!existing.isSymbolicLink()) continue;
      let currentTarget: string | null = null;
      try {
        currentTarget = readlinkSync(dest);
      } catch { /* unreadable — assume foreign, leave alone */ }
      if (currentTarget !== join(builtinSkillsDir, name)) continue;
      try {
        rmSync(dest, { force: true });
      } catch { /* best effort */ }
    }
    return;
  }

  // Foreman path: install (or refresh stale) symlinks for each skill.
  for (const name of switchroomSkillNames) {
    const src = join(builtinSkillsDir, name);
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
 * SWITCHROOM_TG_STREAM_MODE, and the progress-card threshold knobs.
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
  // Progress-card driver thresholds — only effective when stream_mode=checklist.
  if (tg.orphan_promotion_ms !== undefined) {
    out.SWITCHROOM_TG_ORPHAN_PROMOTION_MS = String(tg.orphan_promotion_ms);
  }
  if (tg.cold_sub_agent_threshold_ms !== undefined) {
    out.SWITCHROOM_TG_COLD_SUB_AGENT_THRESHOLD_MS = String(tg.cold_sub_agent_threshold_ms);
  }
  if (tg.deferred_completion_timeout_ms !== undefined) {
    out.SWITCHROOM_TG_DEFERRED_COMPLETION_TIMEOUT_MS = String(tg.deferred_completion_timeout_ms);
  }
  if (tg.sub_agent_tick_interval_ms !== undefined) {
    out.SWITCHROOM_TG_SUB_AGENT_TICK_INTERVAL_MS = String(tg.sub_agent_tick_interval_ms);
  }
  if (tg.edit_budget_threshold !== undefined) {
    out.SWITCHROOM_TG_EDIT_BUDGET_THRESHOLD = String(tg.edit_budget_threshold);
  }
  return out;
}

/**
 * Build env vars exposing per-agent worktree paths to the agent's
 * runtime. Slug `switchroom-web` → `SWITCHROOM_REPO_SWITCHROOM_WEB`.
 * Path is computed deterministically from the agent dir and slug
 * (`<agentDir>/work/<slug>/`); the worktree itself is provisioned
 * separately during reconcile (see src/repos/agent-worktree.ts).
 */
function buildRepoEnvVars(
  _agentName: string,
  agentDir: string,
  agent: AgentConfig,
): Record<string, string> {
  const repos = agent.repos;
  if (!repos) return {};
  const out: Record<string, string> = {};
  for (const slug of Object.keys(repos)) {
    const envName = `SWITCHROOM_REPO_${slug.toUpperCase().replace(/-/g, "_")}`;
    out[envName] = agentWorktreePath(agentDir, slug);
  }
  return out;
}

/**
 * Export HUMANIZER_VOICE_FILE when the agent has a humanizer_voice_file
 * configured. The bundled humanizer skill (and its calibrate companion)
 * read this env var to locate the user's voice template. When unset, the
 * humanizer falls back to its generic "human writing" rules.
 *
 * Relative paths are resolved against the agent's directory so per-agent
 * templates can live alongside agent state.
 */
function buildHumanizerEnvVars(
  agentDir: string,
  agent: AgentConfig,
): Record<string, string> {
  const voiceFile = agent.humanizer_voice_file;
  if (!voiceFile) return {};
  const expanded = voiceFile.startsWith("~/")
    ? voiceFile.replace(/^~/, process.env.HOME ?? "~")
    : voiceFile;
  const resolved = expanded.startsWith("/")
    ? expanded
    : resolve(agentDir, expanded);
  return { HUMANIZER_VOICE_FILE: resolved };
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
  "autoMemoryEnabled",
  "hooks",
  "model",
]);

/**
 * Strip opt-out entries from a user-declared mcp_servers map before writing
 * to settings.json. An entry with value `false` means "don't include this
 * server" — used to suppress a built-in default (e.g. playwright) on a
 * per-agent basis without removing it from `defaults.mcp_servers`.
 */
function filterMcpServers(
  servers: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(servers)) {
    if (value === false) continue; // opt-out: skip this server
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

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
  rewrittenWithBackup: string[];
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
        const destPath = join(agentWorkspaceDir, destRel);
        const renderFn = (): string => {
          const rendered = renderTemplate(srcPath, params.context);
          // Phase 2: append SOUL.custom.md sidecar if present
          if (destRel === "SOUL.md") {
            const customSoulPath = join(agentWorkspaceDir, "SOUL.custom.md");
            return composeWithSidecar(rendered, customSoulPath);
          }
          return rendered;
        };
        if (destRel === "SOUL.md") {
          // SOUL.md is the canonical voice / persona source for the agent
          // (its "Never" AI-tells list, Personality, Communication, Values
          // sections — see profiles/default/workspace/SOUL.md.hbs).
          // Template changes here MUST propagate to existing agents,
          // for the same reason CLAUDE.md uses fingerprint-aware
          // re-render since #1122: without it, agents scaffolded under
          // an older template never see voice-rule updates and the
          // fleet drifts. SOUL.custom.md sidecar (operator-owned)
          // remains writeIfMissing and is composed in by renderFn so
          // operator additions survive the re-render. Operator
          // hand-edits to SOUL.md itself are backed up at
          // `SOUL.md.before-rerender.<ts>`.
          rerenderWithFingerprint(
            destPath,
            renderFn,
            params.created,
            params.skipped,
            params.rewrittenWithBackup,
          );
        } else {
          // Other workspace bootstrap files (IDENTITY, TOOLS, MEMORY,
          // HEARTBEAT, USER) are user-owned scratchpads — seed once,
          // never overwrite. The agent itself edits them at runtime.
          writeIfMissing(
            destPath,
            renderFn,
            params.created,
            params.skipped,
          );
        }
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

    // Use switchroom's git identity if available from env, else fall back to generic.
    // execFileSync (argv array) — never interpolate env vars into a shell string.
    // GIT_AUTHOR_NAME='";rm -rf $HOME;#' as an env var would have been a real
    // injection vector through the previous execSync template literal.
    const userEmail = process.env.GIT_AUTHOR_EMAIL || "switchroom@localhost";
    const userName = process.env.GIT_AUTHOR_NAME || "Switchroom Agent";

    execFileSync(
      "git",
      [
        "-c", `user.email=${userEmail}`,
        "-c", `user.name=${userName}`,
        "commit",
        "-m", "chore: seed workspace from switchroom scaffold",
      ],
      { cwd: workspaceDir, stdio: "pipe" },
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
  // Same SWITCHROOM_MEMORY_BACKEND=none precedence as every other
  // hindsight gate — this runs unconditionally on scaffold AND
  // reconcile/restart, so a config-only check would re-copy the
  // hindsight plugin tree (re-activating its memory hooks) on a
  // `none` install (install-validation 2026-05-17, R2 review round 3).
  if (!isHindsightEnabled(switchroomConfig)) return null;
  // isHindsightEnabled true ⇒ memory.backend === "hindsight" ⇒ memory
  // is defined. Explicit narrowing for the type-checker (the old
  // `memory?.backend !== "hindsight"` gate used to provide it).
  if (!memory) return null;

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
  hindsightRecallMaxMemories: number | undefined;
  hindsightRecallCacheTtlSecs: number | undefined;
  hindsightRecallMinOverlap: number | undefined;
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
    hindsightRecallMaxMemories,
    hindsightRecallCacheTtlSecs,
    hindsightRecallMinOverlap,
  } = args;
  return {
    name,
    agentDir,
    repoRoot: REPO_ROOT,
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
    mcpServers: agentConfig.mcp_servers
      ? filterMcpServers(agentConfig.mcp_servers)
      : agentConfig.mcp_servers,
    schedule: agentConfig.schedule,
    botToken: resolvedBotToken ?? rawBotToken,
    forumChatId: telegramConfig.forum_chat_id,
    dangerousMode: agentConfig.dangerous_mode === true,
    useSwitchroomPlugin: usesSwitchroomTelegramPlugin(agentConfig),
    useHotReloadStable: agentConfig.channels?.telegram?.hotReloadStable === true,
    // PR C: surface channels.telegram.enabled into start.sh as a literal
    // "true"/"false" string. Default true preserves prior behavior.
    telegramEnabledFlag:
      agentConfig.channels?.telegram?.enabled === false ? "false" : "true",
    // sec WS8-F1 / #1416: unconditional read-only image-baked
    // security-hooks plugin dir. Always set — it is the unstrippable
    // tool-safety authority, not an opt-in feature.
    securityPluginDir: DOCKER_SECURITY_PLUGIN_PATH,
    hindsightEnabled: hindsightAutoRecallEnabled,
    hindsightBankIdQ: shellSingleQuote(hindsightBankId),
    hindsightApiBaseUrlQ: shellSingleQuote(hindsightApiBaseUrl),
    hindsightRecallMaxMemories,
    hindsightRecallCacheTtlSecs,
    hindsightRecallMinOverlap,
    switchroomConfigPathQ: switchroomConfigPath
      ? shellSingleQuote(resolve(switchroomConfigPath))
      : undefined,
    // Host home — baked into start.sh.hbs's $HOME/.switchroom symlink
    // (#910). When unset (e.g. tests with no HOME) the template's
    // {{#if hostHomeQ}} guard renders the symlink block as a no-op.
    hostHomeQ: process.env.HOME ? shellSingleQuote(process.env.HOME) : undefined,
    modelQ: shellSingleQuote(agentConfig.model ?? SWITCHROOM_DEFAULT_MAIN_MODEL),
    thinkingEffort: agentConfig.thinking_effort ?? SWITCHROOM_DEFAULT_THINKING_EFFORT,
    permissionMode: agentConfig.permission_mode,
    fallbackModelQ: agentConfig.fallback_model
      ? shellSingleQuote(agentConfig.fallback_model)
      : undefined,
    userEnvQuoted: (() => {
      const combined = {
        ...channelsToEnv(agentConfig),
        ...(agentConfig.env ?? {}),
        ...buildRepoEnvVars(name, agentDir, agentConfig),
        ...buildHumanizerEnvVars(agentDir, agentConfig),
      };
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
        const parts = [baseAppend, telegramGuidance, memoryGuidance, SANDBOX_GUIDANCE].filter(s => s.length > 0);
        const combined = parts.join('\n\n---\n\n');
        return shellSingleQuote(combined);
      }
      return baseAppend.length > 0 ? shellSingleQuote(baseAppend) : undefined;
    })(),
    extraCliArgs: (() => {
      const parts: string[] = []
      if (agentConfig.cli_args && agentConfig.cli_args.length > 0) {
        parts.push(...agentConfig.cli_args.map(shellSingleQuote))
      }
      // #199: native Claude Code flag pass-through. add_dirs becomes
      // repeated --add-dir <path>; allowed_tools / disallowed_tools become
      // a single space-separated --allowedTools "..." / --disallowedTools "..."
      // arg. Coexistence semantics with the coarse `tools.allow`: granular-
      // only-when-present (Claude Code's own OR semantics), so existing
      // operators on `tools.allow` are unaffected.
      if (agentConfig.add_dirs && agentConfig.add_dirs.length > 0) {
        for (const dir of agentConfig.add_dirs) {
          parts.push("--add-dir", shellSingleQuote(dir))
        }
      }
      if (agentConfig.allowed_tools && agentConfig.allowed_tools.length > 0) {
        parts.push("--allowedTools", shellSingleQuote(agentConfig.allowed_tools.join(" ")))
      }
      if (agentConfig.disallowed_tools && agentConfig.disallowed_tools.length > 0) {
        parts.push("--disallowedTools", shellSingleQuote(agentConfig.disallowed_tools.join(" ")))
      }
      return parts.length > 0 ? " " + parts.join(" ") : undefined
    })(),
    sessionMaxIdleSecs: parseDurationToSeconds(agentConfig.session?.max_idle),
    sessionMaxTurns: agentConfig.session?.max_turns,
    handoffEnabled: agentConfig.session_continuity?.enabled !== false,
    handoffShowLine: agentConfig.session_continuity?.show_handoff_line !== false,
    resumeMode: agentConfig.session_continuity?.resume_mode ?? "handoff",
    resumeMaxBytes:
      agentConfig.session_continuity?.resume_max_bytes ?? 2_000_000,
    // True only when the generated start.sh can actually set CONTINUE_FLAG="--continue"
    // at runtime (i.e. resume_mode is 'auto' or 'continue'). In handoff/none mode the
    // case branches for auto/continue are omitted entirely so the literal string
    // CONTINUE_FLAG="--continue" never appears in the rendered script (closes #377).
    resumeModeHasContinuePath: (() => {
      const mode = agentConfig.session_continuity?.resume_mode ?? "handoff";
      return mode === "auto" || mode === "continue";
    })(),
  };
}

/**
 * Path the v0.7 docker agent image bakes telegram-plugin into.
 * Mirrors the `COPY telegram-plugin/...` block in `docker/Dockerfile.agent`.
 * Used by `.mcp.json` generation in docker mode so the MCP server resolves
 * inside the container regardless of where switchroom was installed on
 * the host (npm-global, dev checkout, ad-hoc tarball).
 */
export const DOCKER_TELEGRAM_PLUGIN_PATH = "/opt/switchroom/telegram-plugin";

/**
 * In-image path where Dockerfile.agent COPYs `telegram-plugin/hooks/*.mjs`.
 * Claude Code spawns hooks as child processes from the path written into
 * `settings.json.hooks` at scaffold time; pre-Bug-3 the scaffold emitted
 * the operator's host repo path here, which doesn't exist inside the
 * container — hooks silently never ran (RFC Phase 3 §Bug 3 in
 * reference/sub-agent-visibility-rfc.md).
 */
export const DOCKER_HOOKS_PATH = `${DOCKER_TELEGRAM_PLUGIN_PATH}/hooks`;

/**
 * In-image path for hooks bundled from src/ TypeScript at build time
 * (rather than copied from telegram-plugin/hooks/*.mjs source).
 * Today: only the RFC E §4.2 Cut 2 drive-write hook lives here. The
 * bundle is emitted by `scripts/build.mjs` to `dist/cli/*.mjs` and
 * baked into the agent image at `/opt/switchroom/hooks/` (see
 * docker/Dockerfile.agent).
 */
export const DOCKER_BUNDLED_HOOKS_PATH = "/opt/switchroom/hooks";

/**
 * In-image path where Dockerfile.agent COPYs the `bin/*-hook.sh` family
 * (run-hook.sh, timezone-hook.sh, workspace-stable-hook.sh,
 * workspace-dynamic-hook.sh, user-profile-refresh-hook.sh). Same
 * rationale as DOCKER_HOOKS_PATH — these are invoked from the
 * scaffolded settings.json hooks block.
 */
export const DOCKER_BIN_PATH = "/opt/switchroom/bin";

/**
 * In-image path of the minimal security-hooks plugin (sec WS8-F1 /
 * #1416). Dockerfile.agent assembles `.claude-plugin/plugin.json` +
 * `hooks/hooks.json` + the two load-bearing PreToolUse safety hooks
 * (secret-guard-pretool, drive-write-pretool) here. start.sh passes
 * this as `--plugin-dir` on every claude exec variant, unconditionally
 * — it is THE security boundary, not optional like hindsight. Because
 * Claude Code unions plugin-dir hooks with settings.json hooks and a
 * plugin-dir-loaded hook cannot be suppressed by an agent rewriting
 * its own settings.json, this read-only image copy is the unstrippable
 * authority; the settings.json copy (still emitted) is a harmless
 * zero-regression fallback. Never point this at the agent-writable
 * scaffold dir.
 */
export const DOCKER_SECURITY_PLUGIN_PATH = "/opt/switchroom/security-plugin";

/**
 * In-container path where compose bind-mounts the operator's
 * `switchroom.yaml`. Mirror of the volume mount line emitted in
 * compose generation (`${host}:/state/config/switchroom.yaml:ro`).
 * Used anywhere scaffold writes a path that will be read inside an
 * agent container — `.mcp.json` SWITCHROOM_CONFIG env, and the
 * `--config` flag baked into the handoff hook (#1079).
 */
export const DOCKER_CONFIG_PATH = "/state/config/switchroom.yaml";

/**
 * In-container path to the switchroom CLI. `Dockerfile.agent` symlinks
 * `dist/cli/switchroom.js` onto PATH here. Used for MCP entries whose
 * `command` is a switchroom-internal verb (agent-config, hostd, and the
 * gdrive `drive-mcp-launcher`) — the host's repo/npm-global path is
 * irrelevant inside the container.
 */
export const DOCKER_SWITCHROOM_CLI_PATH = "/usr/local/bin/switchroom";

/**
 * In-container path to the auth-broker UDS. The gdrive launcher resolves
 * Google credentials through the auth-broker; Claude Code spawns MCP
 * servers with a sanitized env (NOT the container env), so this MUST be
 * threaded explicitly onto the gdrive `.mcp.json` entry or the launcher
 * talks to the wrong (default) socket and dies.
 * MUST mirror src/agents/compose.ts emitAgentService env (compose.ts:1312).
 */
export const DOCKER_AUTH_BROKER_SOCKET = "/run/switchroom/auth-broker/sock";

/**
 * In-container path to the vault-broker UDS. Needed when the configured
 * `google_client_secret` is a `vault:` reference the launcher must
 * resolve through the vault broker.
 * MUST mirror src/agents/compose.ts emitAgentService env (compose.ts:1304).
 */
export const DOCKER_VAULT_BROKER_SOCKET = "/run/switchroom/broker/sock";

/**
 * In-container HOME for the agent. The launcher (and uvx beneath it)
 * writes to ~/.cache, ~/.config, ~/.local; without HOME pointed at the
 * writable bind mount it defaults to "/" on the read-only root fs.
 * MUST mirror src/agents/compose.ts emitAgentService env (compose.ts:1248).
 */
export const DOCKER_AGENT_HOME = "/state/agent/home";

/**
 * Decide whether the per-agent `gdrive` MCP entry should be written into
 * `mcpServers`, and if so produce it.
 *
 * Net-new conditional logic (unlike `getBuiltinDefaultMcpEntries()`,
 * which is unconditional). Shared by BOTH the `scaffoldAgent` and
 * `reconcileAgent` mcpServers-assembly paths so an agent can never get a
 * `gdrive` entry it can't satisfy at the broker.
 *
 * Gate (all must hold):
 *   1. NOT a hard opt-out — `mcp_servers: { gdrive: false }`.
 *   2. `shouldEmitGdriveMcp(name, account, google_accounts)` — i.e. the
 *      agent has `google_workspace.account` set AND that account lists
 *      this agent in its `google_accounts.<account>.enabled_for[]`. This
 *      is the SAME predicate the auth-broker uses to select+authorize a
 *      Google account, so scaffold and broker can never disagree.
 *
 * The `--tier` passed to the launcher is per-agent override → top-level
 * default (mirrors approvers/tier override semantics elsewhere). The
 * launcher re-reads tier from config and is authoritative; threading it
 * here just makes the resolved choice visible in settings.json.
 *
 * Returns `null` when the entry must not be emitted.
 */
export function resolveGdriveMcpEntry(
  agentName: string,
  agentConfig: AgentConfig,
  switchroomConfig: SwitchroomConfig | undefined,
): { key: string; value: McpServerConfig } | null {
  if ((agentConfig.mcp_servers ?? {})["gdrive"] === false) return null;
  const account = agentConfig.google_workspace?.account;
  const googleAccounts = switchroomConfig?.google_accounts;
  if (!shouldEmitGdriveMcp(agentName, account, googleAccounts)) return null;
  const tier =
    agentConfig.google_workspace?.tier ??
    switchroomConfig?.google_workspace?.tier;
  const entry = getGdriveMcpSettingsEntry(
    DOCKER_SWITCHROOM_CLI_PATH,
    tier ? { tier } : {},
  );
  // Claude Code spawns MCP servers with a SANITIZED env (not the
  // parent/container env), so the drive-mcp-launcher gets none of the
  // compose-emitted SWITCHROOM_* / HOME vars unless we thread them onto
  // the entry explicitly. Without this block the launcher dies at spawn
  // ("No switchroom.yaml found", or it connects to the wrong broker
  // socket). Every value here MUST mirror the canonical value emitted by
  // src/agents/compose.ts emitAgentService env (line cited per key) so
  // the in-MCP-spawn env can never disagree with the container env.
  entry.value.env = {
    SWITCHROOM_CONFIG: DOCKER_CONFIG_PATH, // compose.ts SWITCHROOM_CONFIG / volume mount (scaffold.ts:1755)
    SWITCHROOM_AGENT_NAME: agentName, // compose.ts:1275 (a.name)
    SWITCHROOM_CONTAINER: "1", // compose.ts:1276
    SWITCHROOM_AUTH_BROKER_SOCKET: DOCKER_AUTH_BROKER_SOCKET, // compose.ts:1312
    SWITCHROOM_VAULT_BROKER_SOCK: DOCKER_VAULT_BROKER_SOCKET, // compose.ts:1304
    HOME: DOCKER_AGENT_HOME, // compose.ts:1248
  };
  return entry;
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
  /**
   * Files we re-rendered AND backed up an operator-edited version
   * of. Surfaced via stderr at the end of scaffoldAgent so operators
   * notice; per-agent items are also included in `created` for the
   * normal "N files created" count.
   */
  const rewrittenWithBackup: string[] = [];

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
  // Single source of truth — honors SWITCHROOM_MEMORY_BACKEND=none
  // (install-validation 2026-05-17, R2 / prior #25).
  const hindsightEnabled = isHindsightEnabled(switchroomConfig);
  const permissionAllow = dedupe([
    ...baseAllow,
    ...readOnlyDefaults,
    ...(usesSwitchroomTelegramPlugin(agentConfig) ? SWITCHROOM_TELEGRAM_MCP_TOOLS : []),
    ...(hindsightEnabled ? HINDSIGHT_MCP_TOOLS : []),
    // agent-config + hostd are always wired into .mcp.json so the
    // prompt fragment can claim "you have these tools available" —
    // but Claude Code blocks the first call on a permission prompt
    // unless the tool is on the allow list. Pre-approve unconditionally
    // (daemon-side gates remain the real security boundary).
    ...AGENT_CONFIG_MCP_TOOLS,
    ...HOSTD_MCP_TOOLS,
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
  // Cascading recall cap. Per-agent value already merged from defaults
  // by config/merge.ts (memory is shallow-merged), so reading
  // agentConfig.memory.recall.max_memories here picks up the resolved
  // value. `undefined` means "let the plugin's settings.json default
  // apply" — start.sh.hbs gates the env var on this being defined.
  const hindsightRecallMaxMemories = agentConfig.memory?.recall?.max_memories;
  // Per-session recall cache TTL (#424 phase 4.1). Same cascade
  // semantics as max_memories. `undefined` here means "use the
  // switchroom-managed default of 600s baked into start.sh.hbs."
  // Set to 0 in switchroom.yaml to disable caching for an agent.
  const hindsightRecallCacheTtlSecs = agentConfig.memory?.recall?.cache_ttl_secs;
  // Lexical-overlap relevance gate (#475). Same cascade. `undefined`
  // means "use the plugin's settings.json default of 0.0" (i.e. gate
  // disabled, current behaviour). Set 0.10–0.20 to start filtering.
  const hindsightRecallMinOverlap = agentConfig.memory?.recall?.min_overlap;

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
    hindsightRecallMaxMemories,
    hindsightRecallCacheTtlSecs,
    hindsightRecallMinOverlap,
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
  // start.sh is purely template-driven (no user-merged sections), so it
  // must be regenerated whenever the template changes. writeIfMissing
  // would skip an existing file regardless of whether the template has
  // since gained new content (e.g. v0.7.5 added the docker-mode tmux
  // preamble — agents whose start.sh predated that release booted
  // without the preamble after `apply --only=<name>` because the file
  // already existed). See #879.
  writeIfChanged(
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

      // Pre-allow the every-agent MCP servers in settings.permissions.allow
      // so existing agents pick up the wildcards on `switchroom apply`
      // (writeIfMissing above skips settings.json for existing agents,
      // so a fresh permissionAllow would otherwise only land on first
      // scaffold). Without this merge a first call to skill_list /
      // cron_list / config_get / audit_tail / peers_list wedges the
      // agent on a Claude Code permission prompt the operator has to
      // approve via Telegram one-tool-at-a-time. See the UAT for
      // PR #1215 (skill_list screenshot).
      settings.permissions = settings.permissions ?? {};
      // #1400 link 1: actively retract the pre-#1400 blanket hostd
      // grant before re-seeding the narrowed read-only-only set, so
      // an existing agent that baked in `mcp__hostd__*` stops having
      // the mutating verbs pre-approved.
      const allow: string[] = (Array.isArray(settings.permissions.allow)
        ? settings.permissions.allow
        : []
      ).filter((p: string) => !LEGACY_HOSTD_BLANKET_TOKENS.includes(p));
      for (const t of [...AGENT_CONFIG_MCP_TOOLS, ...HOSTD_MCP_TOOLS]) {
        if (!allow.includes(t)) allow.push(t);
      }
      settings.permissions.allow = allow;

      // #235: actively retract the legacy switchroom-mcp entry on reconcile
      // so existing agents stop spawning the dormant child process. The 4
      // tools it exposed had zero callers and are subsumed by Hindsight's
      // MCP + Claude Code's built-in Read/Grep.
      if (settings.mcpServers && "switchroom" in settings.mcpServers) {
        delete settings.mcpServers["switchroom"];
      }

      // Built-in default MCPs (e.g. playwright). Single source of truth lives
      // in scaffold-integration.ts so scaffold + `switchroom update` reconcile
      // stay in sync. Agents can suppress any default with
      // `mcp_servers: { <key>: false }` in switchroom.yaml; defaults are added
      // here AFTER the template renders user-declared mcp_servers, and the
      // opt-out check reads the user's mcp_servers map directly to honour
      // `false` even though filterMcpServers strips that sentinel before the
      // template sees it.
      for (const entry of getBuiltinDefaultMcpEntries()) {
        const agentOptOut = (agentConfig.mcp_servers ?? {})[entry.optOutKey] === false;
        if (!agentOptOut && !settings.mcpServers[entry.key]) {
          settings.mcpServers[entry.key] = entry.value;
        }
      }

      // Per-agent conditional `gdrive` MCP. Net-new gated logic (the
      // built-in defaults above are unconditional). Emitted ONLY when the
      // agent is broker-authorized for a Google account — the gate
      // mirrors the auth-broker's account selection + ACL exactly so the
      // launcher never spawns an MCP the broker would refuse. Honours the
      // `mcp_servers: { gdrive: false }` hard opt-out. A user-declared
      // `gdrive` entry (already in settings.mcpServers) wins, same as the
      // built-in defaults above.
      {
        const gdrive = resolveGdriveMcpEntry(name, agentConfig, switchroomConfig);
        if (gdrive && !settings.mcpServers[gdrive.key]) {
          settings.mcpServers[gdrive.key] = gdrive.value;
        }
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
      const hindsightOn = isHindsightEnabled(switchroomConfig)
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
      // Per #142, the SessionStart greeting hook + session-greeting.sh
      // curl script are deleted. The boot card (telegram-plugin/gateway/
      // boot-card.ts) now handles "agent is back" UX with a quiet, settle-
      // gated single-line ack; the full config audit content moves to a
      // future `/status` command (#142 PR 3).
      //
      // buildSettingsHooksBlock() is the single source of truth for the full
      // hooks block (user yaml + switchroom-owned). Reconcile calls the same
      // function so both paths are guaranteed byte-identical.
      settings.hooks = buildSettingsHooksBlock({
        agentName: name,
        agentConfig,
        hindsightEnabled,
        useSwitchroomPlugin: usesSwitchroomTelegramPlugin(agentConfig),
        configPath: switchroomConfigPath,
      });
      // Model: explicit override from yaml wins; otherwise apply the
      // switchroom default (sonnet 4.6, see SWITCHROOM_DEFAULT_MAIN_MODEL
      // for rationale). Always written to settings.model so the user
      // doesn't have to pass --model on every invocation, and so the
      // doctor / debug surfaces show the resolved choice.
      settings.model = agentConfig.model ?? SWITCHROOM_DEFAULT_MAIN_MODEL;

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
  //
  // Captured here, applied to the trust allowlist a SECOND time after
  // `.claude.json` is created (~`preTrustWorkspace` below). The in-block
  // ensureMcpServersTrusted call is a silent no-op on a brand-new agent
  // (`.claude.json` doesn't exist that early) — without the post-create
  // pass a net-new agent's gdrive/agent-config/hostd servers are never
  // trusted and Claude silently ignores them.
  let mcpServerKeysToTrust: string[] | null = null;
  if (usesSwitchroomTelegramPlugin(agentConfig)) {
    const mcpJsonPath = join(agentDir, ".mcp.json");
    // The agent image (Dockerfile.agent) COPYs the plugin to a stable
    // in-image path and bakes a `switchroom` symlink at /usr/local/bin.
    // Reference those — the host's repo checkout / npm-global install
    // path is irrelevant inside the container and would resolve to a
    // non-existent path. Compose bind-mounts switchroom.yaml at
    // /state/config/switchroom.yaml.
    const pluginDir = DOCKER_TELEGRAM_PLUGIN_PATH;
    const switchroomCliPath = "/usr/local/bin/switchroom";
    const resolvedConfigPath = DOCKER_CONFIG_PATH;

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
      // Read-only agent-config broker. Exposes 4 tools (config_get,
      // cron_list, skill_list, audit_tail) that re-exec the switchroom
      // CLI. Identity is pinned by SWITCHROOM_AGENT_NAME — the CLI
      // refuses cross-agent reads.
      "agent-config": {
        command: switchroomCliPath,
        args: ["mcp", "agent-config"],
        env: {
          SWITCHROOM_AGENT_NAME: name,
          SWITCHROOM_CONFIG: resolvedConfigPath,
        },
      },
    };

    // hostd MCP — admin-only (#1175 RFC C / PR δ). Compose only
    // bind-mounts the hostd socket for admin agents, so non-admin
    // entries here would just surface ENOENT at first call.
    if (agentConfig.admin === true) {
      mcpServers["hostd"] = {
        command: switchroomCliPath,
        args: ["mcp", "hostd"],
        env: {
          SWITCHROOM_AGENT_NAME: name,
          SWITCHROOM_CONFIG: resolvedConfigPath,
        },
      };
    }

    // Add hindsight memory MCP if configured
    if (hindsightEnabled && switchroomConfig) {
      const hindsightEntry = getHindsightSettingsEntry(name, switchroomConfig);
      if (hindsightEntry) {
        mcpServers[hindsightEntry.key] = hindsightEntry.value;
      }
    }

    // Per-agent conditional `gdrive` MCP. THIS .mcp.json (not
    // settings.json.mcpServers) is the surface Claude Code actually
    // loads for switchroom-telegram-plugin agents — see the block
    // comment at the top of this branch. Same shared broker-ACL gate.
    if (switchroomConfig) {
      const gdrive = resolveGdriveMcpEntry(name, agentConfig, switchroomConfig);
      if (gdrive) {
        mcpServers[gdrive.key] = gdrive.value;
      }
    }

    // .mcp.json is purely template-driven. writeIfChanged so a stale
    // file from a pre-v0.7.6 release (different plugin path resolution)
    // is rewritten on the next `switchroom apply`.
    writeIfChanged(
      mcpJsonPath,
      () => JSON.stringify({ mcpServers }, null, 2) + "\n",
      created,
      skipped,
      0o600,
    );
    // Claude Code only loads project `.mcp.json` servers that are on the
    // per-project trust allowlist. preTrustWorkspace sets
    // hasTrustDialogAccepted but never enabledMcpjsonServers, so any
    // server scaffolded after original onboarding (gdrive, plus
    // agent-config/hostd for non-original agents) is silently ignored.
    // Union every server we just wrote into the allowlist. NOTE: on a
    // brand-new agent `.claude.json` does not exist yet at this point —
    // this call silently no-ops and the post-`preTrustWorkspace` pass
    // below is what actually lands the trust. Kept here too because it
    // is idempotent and covers the re-scaffold path where the file
    // already exists.
    mcpServerKeysToTrust = Object.keys(mcpServers);
    ensureMcpServersTrusted(agentDir, mcpServerKeysToTrust);
  }

  // --- Render template-specific files ---
  // Phase 2: SOUL.md moved to workspace/SOUL.md (seedWorkspaceBootstrapFiles)
  const templateFiles: Array<{ src: string; dest: string }> = [
    { src: "CLAUDE.md.hbs", dest: "CLAUDE.md" },
  ];

  for (const { src, dest } of templateFiles) {
    const srcPath = join(profilePath, src);
    if (existsSync(srcPath)) {
      // CLAUDE.md uses a fingerprint-aware re-render so profile-template
      // changes (e.g. `_shared/telegram-style.md.hbs`) propagate to
      // existing agents on `switchroom apply`. Old behaviour
      // (writeIfMissing) froze the file forever after first scaffold —
      // the root cause of the #1122 conversational-pacing rollout
      // silently bypassing every running agent's prompt. Operator
      // hand-edits are preserved as a backup at
      // `<filename>.before-rerender.<unix-ms>` so they can be
      // re-merged manually.
      rerenderWithFingerprint(
        join(agentDir, dest),
        () => {
          let rendered = renderTemplate(srcPath, context);
          if (dest === "CLAUDE.md") {
            const vaultProtocol = renderVaultProtocolFragment(context);
            if (vaultProtocol) {
              rendered = rendered.trimEnd() + "\n\n" + vaultProtocol + "\n";
            }
            // Agent-self-service fragment (#1163) — names the agent-config
            // MCP tools (config_get / cron_list / skill_list / schedule_add
            // / schedule_remove / audit_tail) + the safety rails. Same
            // unconditional-append pattern as vault-protocol — every agent
            // gets the prompt grounding because every agent gets the tools
            // wired via .mcp.json. Without this fragment, the model has
            // the tools available in tools/list but no awareness of when
            // to reach for them, so natural-language asks like "remind me
            // to call mom at 5pm" fall back to free-styling a yaml paste-
            // block instead of calling schedule_add directly.
            const selfService = renderAgentSelfServiceFragment(context);
            if (selfService) {
              rendered = rendered.trimEnd() + "\n\n" + selfService + "\n";
            }
          }
          if (dest === "CLAUDE.md" && agentConfig.claude_md_raw) {
            rendered = rendered.trimEnd() + "\n\n" + agentConfig.claude_md_raw + "\n";
          }
          return rendered;
        },
        created,
        skipped,
        rewrittenWithBackup,
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
    rewrittenWithBackup,
  });
  ensureClaudeMdSymlinks(phase5WorkspaceDir, created);

  // --- Persistent agent HOME (Layer 1) ---
  // The container has read-only root + a numeric UID with no
  // /etc/passwd entry, so HOME defaults to "/" — every tool that
  // writes to ~/.config / ~/.cache / ~/.local fails outright.
  // compose.ts sets HOME=/state/agent/home; this section creates that
  // directory inside the existing /state/agent bind mount and seeds
  // a minimal .bashrc / .profile so attached interactive shells get
  // the same PATH/NPM env as start.sh sets for non-interactive
  // children.
  //
  // All seeds are writeIfMissing — agents (and operators) can
  // customize freely without losing changes on `switchroom apply`.
  const persistentHomeDir = join(agentDir, "home");
  mkdirSync(persistentHomeDir, { recursive: true });
  for (const sub of [".local/bin", ".npm-global", "bin"]) {
    mkdirSync(join(persistentHomeDir, sub), { recursive: true });
  }
  const homeEnvBlock = [
    "# switchroom Layer 1: per-agent persistent HOME.",
    "# These exports mirror profiles/_base/start.sh.hbs so attached",
    "# interactive shells see the same PATH and npm-global prefix as",
    "# the agent's non-interactive child processes.",
    'export PATH="$HOME/.local/bin:$HOME/bin:$HOME/.npm-global/bin:$PATH"',
    'export NPM_CONFIG_PREFIX="$HOME/.npm-global"',
    "",
  ].join("\n");
  writeIfMissing(
    join(persistentHomeDir, ".profile"),
    () => homeEnvBlock,
    created,
    skipped,
  );
  writeIfMissing(
    join(persistentHomeDir, ".bashrc"),
    () =>
      [
        "# switchroom Layer 1: agent .bashrc.",
        "# Defers to .profile for the env so login + non-login shells",
        "# stay in lockstep. Edit freely — `switchroom apply` will not",
        "# overwrite this file once it exists.",
        '[ -f "$HOME/.profile" ] && . "$HOME/.profile"',
        "",
      ].join("\n"),
    created,
    skipped,
  );

  // --- Initialize workspace as git repo (Phase 4) ---
  const workspaceDir = join(agentDir, "workspace");
  initWorkspaceGitRepo(workspaceDir, name);

  // --- Claude Code config (onboarding state) ---
  // Copy onboarding state (.claude.json) from the host's Claude installation
  // so the agent skips the first-run wizard, but intentionally do NOT copy
  // .credentials.json — agent credentials are owned by the RFC-H auth-broker,
  // not by scaffold-time file copies. The broker atomically writes
  // `<agentDir>/.claude/.credentials.json` at boot, on setActive, and on
  // refresh-tick, sourced from the fleet-active account at
  // `~/.switchroom/accounts/<label>/credentials.json`.
  //
  // Operators register one fleet account via `switchroom auth add <label>
  // --via-claude` (drives claude through its native broader-scope OAuth;
  // see src/auth/via-claude.ts) then `switchroom auth use <label>`. Adding
  // the 2nd/3rd/Nth agent to the same account is a YAML edit; no further
  // OAuth round-trips. See `reference/share-auth-across-the-fleet.md`.
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

  // Now that `.claude.json` is guaranteed to exist (copyOnboardingState /
  // createMinimalClaudeConfig + preTrustWorkspace just ran), re-apply the
  // MCP trust allowlist. The in-block call during .mcp.json write is a
  // silent no-op on a net-new agent (`.claude.json` absent that early),
  // so without this pass a fresh agent's gdrive/agent-config/hostd
  // servers are never added to enabledMcpjsonServers and Claude Code
  // silently ignores them — the integration would only "work" because
  // reconcileAgent re-trusts on the next restart. ensureMcpServersTrusted
  // is idempotent; running it twice is safe.
  if (mcpServerKeysToTrust) {
    ensureMcpServersTrusted(agentDir, mcpServerKeysToTrust);
  }

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
      // Post-cascade invariant: description is what Claude Code uses
      // to decide when to delegate to a subagent. The schema allows
      // partial overrides (so profile-level overlays don't have to
      // restate it — see SubagentSchema in src/config/schema.ts), but
      // the FINAL merged subagent must have one. Fail loudly with
      // actionable guidance instead of writing `description: undefined`
      // to the markdown (which Claude Code rejects silently).
      if (!saDef.description) {
        throw new Error(
          `subagent "${saName}" has no description after cascade — add one ` +
            `to your defaults, the profile this agent extends, or the agent's ` +
            `own subagents.${saName} block.`,
        );
      }
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

  // --- Scheduled task cron scripts ---
  //
  // Each schedule entry gets a self-contained bash script that runs
  // `claude -p` with the configured model and sends output to Telegram.
  // The corresponding systemd timer+service units are installed by
  // `switchroom agent create` / `switchroom systemd install` (in cli/agent.ts),
  // not here — scaffold writes the scripts, CLI wires the timers.
  if ((agentConfig.schedule?.length ?? 0) > 0) {
    const cronChatId = userId ?? telegramConfig.forum_chat_id;
    const brokerSocket = switchroomConfig?.vault?.broker?.socket
      ? resolveDualPath(switchroomConfig.vault.broker.socket)
      : resolveDualPath("~/.switchroom/vault-broker.sock");
    for (let i = 0; i < agentConfig.schedule!.length; i++) {
      const entry = agentConfig.schedule![i];
      const model = entry.model ?? "claude-sonnet-4-6";
      const filename = cronScriptFilename(entry.cron, entry.prompt);
      const stem = filename.replace(/\.sh$/, "");
      const script = buildCronScript(agentDir, entry.prompt, model, cronChatId, userId, entry.secrets ?? [], brokerSocket, stem);
      const scriptPath = join(agentDir, "telegram", filename);
      writeFileSync(scriptPath, script, { encoding: "utf-8", mode: 0o700 });
      // Phase B/D: write the .source sidecar attributing each cron script
      // to its origin (main switchroom.yaml vs an overlay fragment under
      // schedule.d/). Downstream tools (audit, operator approval) read
      // the sidecar to decide whether an entry can be edited in place or
      // requires touching an overlay file. The OVERLAY_SOURCE symbol is
      // stamped by overlay-loader.ts on appended entries.
      const source = (entry as Record<symbol, unknown>)[OVERLAY_SOURCE] ? "overlay" : "main";
      writeFileSync(join(agentDir, "telegram", `${stem}.source`), `${source}\n`, { encoding: "utf-8", mode: 0o600 });
    }
  }

  // --- Copy skill files from profile ---
  // Profile-bundled skills land in .claude/skills/ so Claude Code discovers
  // them alongside user-declared global skills.
  copyProfileSkills(profilePath, join(agentDir, ".claude", "skills"));

  // --- Materialize profile CLAUDE.md from .hbs template ---
  // Render profiles/<name>/CLAUDE.md from its .hbs source so the profile's
  // rendered output is up-to-date at scaffold time. This is idempotent —
  // no-op when the .hbs doesn't exist. Chunks 3+4 wire the @import and
  // reconcile migration respectively.
  renderProfileClaudeTemplate(agentConfig.extends ?? DEFAULT_PROFILE);

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
  // Role-gated (#235 follow-up): only foreman agents get the operator
  // skills auto-symlinked. Default `assistant` role retracts any stale
  // ones that may exist from before this gate landed.
  installSwitchroomSkills(agentDir, { role: agentConfig.role });

  // --- Install bundled default skills (anthropic + switchroom-core) ---
  // Universal — every agent gets these regardless of role, with per-key
  // opt-out via `defaults.bundled_skills` or per-agent `bundled_skills`.
  reconcileAgentDefaultSkills(
    agentDir,
    (agentConfig.bundled_skills ?? {}) as Record<string, unknown>,
  );

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
    //
    // Mission selection: explicit user yaml wins. When the operator hasn't
    // set a `retain_mission`, scaffold (NOT reconcile) seeds the upstream-
    // recommended default — this lifts retained memory quality on fresh
    // agents without touching agents that already have a customized
    // mission. `reconcileAgent` deliberately does not push the default,
    // so existing agents' Hindsight-side missions stay untouched.
    bankOpsChain.then((bankReady) => {
      if (!bankReady) return;

      const userBankMission = agentConfig.memory?.bank_mission;
      const userRetainMission = agentConfig.memory?.retain_mission;
      const seededRetainMission = userRetainMission ?? DEFAULT_RETAIN_MISSION;

      const missions: { bank_mission?: string; retain_mission?: string } = {
        retain_mission: seededRetainMission,
      };
      if (userBankMission) {
        missions.bank_mission = userBankMission;
      }

      updateBankMissions(apiUrl, hindsightBankId, missions, { timeoutMs: 5000 })
        .then((result) => {
          if (result.ok) {
            const note = userRetainMission ? "(custom retain_mission)" : "(default retain_mission)";
            console.log(`  ${chalk.green("✓")} Bank missions updated for ${formatAgentBankLabel(name, hindsightBankId)} ${chalk.dim(note)}`);
          } else {
            console.warn(`  ${chalk.yellow("⚠")} Failed to update bank missions for ${formatAgentBankLabel(name, hindsightBankId)}: ${result.reason}`);
          }
        })
        .catch((err) => {
          console.warn(`  ${chalk.yellow("⚠")} Bank mission update error for ${formatAgentBankLabel(name, hindsightBankId)}: ${err}`);
        });

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

  // Loud warning when CLAUDE.md (or any future fingerprint-tracked
  // file) was operator-edited and we backed it up. Surfaced via
  // stderr so it lands in `switchroom apply` output; not added to
  // ScaffoldResult to keep the public type stable.
  for (const f of rewrittenWithBackup) {
    process.stderr.write(
      `scaffold: re-rendered ${f} from template change; backed up your `
      + `edited version to ${f}.before-rerender.* — review and re-merge `
      + `manually if needed.\n`,
    );
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

  // Soul files — persona identity (name, vibe, creature) is baked into
  // --append-system-prompt at session start. When hotReloadStable is true the
  // per-turn hook re-injects SOUL.md so changes go live next turn (hot).
  // When hotReloadStable is false (default), the file is frozen at launch and
  // any edit is invisible until the agent restarts — so we promote it to
  // restart-required so the reconciler auto-restarts immediately.
  if (relPath === "workspace/SOUL.md" || relPath === "workspace/SOUL.custom.md") {
    return useHotReloadStable ? "hot" : "restart-required";
  }

  // Stable workspace files — classification depends on hotReloadStable flag
  // When hotReloadStable is true, these are re-injected on every turn via hook
  // When hotReloadStable is false (default), they're baked into --append-system-prompt at start
  const stableWorkspaceFiles = [
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

/**
 * Parameters for buildSettingsHooksBlock — extracted so the function can be
 * called from both reconcileAgent and the drift-check path without
 * duplicating the logic.
 */
export interface HooksBlockParams {
  /** Agent name (used for `switchroom handoff <name>`) */
  agentName: string;
  /** Merged yaml hooks (defaults → profile → agent, already resolved) */
  agentConfig: AgentConfig;
  /** Whether the Hindsight memory backend is active for this agent */
  hindsightEnabled: boolean;
  /** Whether this agent uses the switchroom telegram plugin */
  useSwitchroomPlugin: boolean;
  /**
   * Whether to bake `--config` into the handoff hook command so the
   * `switchroom handoff` invocation can locate switchroom.yaml even
   * when its env/cwd doesn't point at it. The path written is always
   * `DOCKER_CONFIG_PATH` (the in-container bind-mount location) — the
   * host's resolved path would not exist inside the agent container
   * (#1079). Pass the host config path as truthy signal; the value
   * itself is not used.
   */
  configPath?: string;
}

/**
 * Compute the full settings.json `hooks` block for a given agent config.
 *
 * Combines:
 *   1. User-declared hooks from switchroom.yaml (via translateHooksToClaudeShape)
 *   2. Switchroom-owned hooks (handoff, user-profile-refresh, secret-scrub,
 *      secret-guard, subagent-tracker, workspace injection, timezone)
 *
 * This is the single source of truth for what reconcileAgent writes to
 * settings.json. Exported so the drift-check path can call it without
 * performing a full reconcile.
 *
 * The output is a plain JSON-serialisable object suitable for
 * `settings.hooks = buildSettingsHooksBlock(...)`.
 */
export function buildSettingsHooksBlock(p: HooksBlockParams): Record<string, unknown> {
  const { agentName, agentConfig, hindsightEnabled, useSwitchroomPlugin, configPath } = p;

  const userHooks = translateHooksToClaudeShape(agentConfig.hooks);

  // Wrapping helper. Every switchroom-owned hook is invoked through
  // bin/run-hook.sh so a non-zero exit or a stderr-only failure ends up
  // in the issue sink (#425) and on the Telegram issues card (#428).
  // The wrapper preserves the original exit code, so claude code's
  // hook contract (decision: block, etc.) is unchanged.
  //
  // Path is the docker-baked location. The scaffold runs on the host but
  // settings.json is consumed inside the agent container — referencing
  // the host repo checkout would silently fail (RFC §Bug 3). Mirrors
  // the `.mcp.json` plugin path which already uses DOCKER_TELEGRAM_PLUGIN_PATH
  // for the same reason.
  const wrapper = `bash "${join(DOCKER_BIN_PATH, "run-hook.sh")}"`;
  const wrap = (source: string, command: string): string =>
    `${wrapper} ${shellSingleQuote(source)} ${command}`;

  // --- Switchroom-owned Stop hooks ---
  const handoffEnabled = agentConfig.session_continuity?.enabled !== false;
  // The hook runs *inside* the agent container; bake the in-container
  // bind-mount path, not the host path the scaffolder happens to know
  // about. Pre-#1079 this used `resolve(configPath)` which produced a
  // host path that doesn't exist in the container, so every Stop fired
  // an issue with "Config file not found".
  const handoffConfigArg = configPath
    ? ` --config ${shellSingleQuote(DOCKER_CONFIG_PATH)}`
    : "";
  const stopHooks: Array<Record<string, unknown>> = [];
  if (handoffEnabled) {
    stopHooks.push({
      type: "command",
      command: wrap(
        "hook:handoff",
        `switchroom${handoffConfigArg} handoff ${agentName}`,
      ),
      timeout: 35,
      async: true,
    });
  }
  if (hindsightEnabled) {
    stopHooks.push({
      type: "command",
      command: wrap(
        "hook:user-profile-refresh",
        `bash "${join(DOCKER_BIN_PATH, "user-profile-refresh-hook.sh")}"`,
      ),
      timeout: 10,
      async: true,
    });
  }
  if (useSwitchroomPlugin) {
    stopHooks.push({
      type: "command",
      command: wrap(
        "hook:secret-scrub-stop",
        `node "${join(DOCKER_HOOKS_PATH, "secret-scrub-stop.mjs")}"`,
      ),
      timeout: 15,
      async: true,
    });
    stopHooks.push({
      type: "command",
      command: wrap(
        "hook:silent-end-interrupt-stop",
        `node "${join(DOCKER_HOOKS_PATH, "silent-end-interrupt-stop.mjs")}"`,
      ),
      timeout: 5,
      async: false,
    });
    // Reaper for the PreToolUse tool-label sidecar files (#783).
    // Runs on every Stop; idempotent age + count rotation.
    stopHooks.push({
      type: "command",
      command: wrap(
        "hook:tool-label-stop",
        `node "${join(DOCKER_HOOKS_PATH, "tool-label-stop.mjs")}"`,
      ),
      timeout: 5,
      async: true,
    });
  }
  const switchroomStop = stopHooks.length > 0 ? [{ hooks: stopHooks }] : [];

  // --- Switchroom-owned PreToolUse hooks ---
  const switchroomPreToolUse = useSwitchroomPlugin
    ? [
        {
          hooks: [
            {
              type: "command",
              command: wrap(
                "hook:secret-guard-pretool",
                `node "${join(DOCKER_HOOKS_PATH, "secret-guard-pretool.mjs")}"`,
              ),
              timeout: 10,
            },
          ],
        },
        {
          // Claude Code's hook matcher is a regex. Cover both the legacy
          // 'Agent' and newer 'Task' tool names — same dispatch
          // semantics, only the name varies by Claude Code version. The
          // tracker hooks themselves also gate on both.
          matcher: "^(Agent|Task)$",
          hooks: [
            {
              type: "command",
              command: wrap(
                "hook:subagent-tracker-pretool",
                `node "${join(DOCKER_HOOKS_PATH, "subagent-tracker-pretool.mjs")}"`,
              ),
              timeout: 10,
            },
          ],
        },
        {
          // RFC E §4.2 Cut 2 — gates upstream Drive write tools behind
          // a Telegram diff-preview approval card. Scoped matcher so
          // the hook only runs for `mcp__google-workspace__*` tools,
          // avoiding the cost of stdin parse + broker call on every
          // tool fire. Timeout = approval TTL + slack.
          //
          // Path is DOCKER_BUNDLED_HOOKS_PATH (not DOCKER_HOOKS_PATH)
          // because this hook is bundled via scripts/build.mjs from
          // src/cli/drive-write-pretool.ts — it imports src/drive/*
          // helpers that aren't otherwise available inside the agent
          // image. Built output lives at /opt/switchroom/hooks/.
          matcher: "^mcp__google-workspace__",
          hooks: [
            {
              type: "command",
              command: wrap(
                "hook:drive-write-pretool",
                `node "${join(DOCKER_BUNDLED_HOOKS_PATH, "drive-write-pretool.mjs")}"`,
              ),
              // Claude Code timeout is in seconds. 5min approval TTL
              // + 30s slack so a near-timeout grant still lands cleanly.
              timeout: 5 * 60 + 30,
            },
          ],
        },
        {
          // Catch-all PreToolUse: deterministic tool-call labels (#783).
          // Hook always exits 0; never emits stdout JSON; writes one line
          // to $TELEGRAM_STATE_DIR/tool-labels-${session_id}.jsonl.
          hooks: [
            {
              type: "command",
              command: wrap(
                "hook:tool-label-pretool",
                `node "${join(DOCKER_HOOKS_PATH, "tool-label-pretool.mjs")}"`,
              ),
              timeout: 5,
            },
          ],
        },
      ]
    : [];

  // --- Switchroom-owned PostToolUse hooks ---
  const switchroomPostToolUse = useSwitchroomPlugin
    ? [
        {
          // Claude Code's hook matcher is a regex. Cover both the legacy
          // 'Agent' and newer 'Task' tool names — same dispatch
          // semantics, only the name varies by Claude Code version. The
          // tracker hooks themselves also gate on both.
          matcher: "^(Agent|Task)$",
          hooks: [
            {
              type: "command",
              command: wrap(
                "hook:subagent-tracker-posttool",
                `node "${join(DOCKER_HOOKS_PATH, "subagent-tracker-posttool.mjs")}"`,
              ),
              timeout: 10,
            },
          ],
        },
        {
          // Layer 2 of the sandbox UX work — detects EROFS / read-only
          // / sandbox-related errors in tool_response and injects a
          // one-line hint via additionalContext so the agent responds
          // usefully on Telegram instead of silently retrying or
          // echoing the raw kernel error. Pairs with the SANDBOX
          // primer in --append-system-prompt. Hook is fail-silent: a
          // broken hint never blocks the tool flow.
          //
          // #1303: matcher narrowed from ".*" to write-capable tools +
          // MCP tools only. Read/Grep/Glob/WebFetch/etc. cannot hit a
          // kernel sandbox boundary by definition, and the old
          // matcher caused false positives every time a Read/Grep
          // payload merely MENTIONED EROFS / read-only-fs strings
          // (file content, code comments, the hook source itself).
          // The hook script also gates on these tools internally as
          // defence in depth.
          matcher: "^(Edit|MultiEdit|Write|NotebookEdit|Bash|mcp__.*)$",
          hooks: [
            {
              type: "command",
              command: wrap(
                "hook:sandbox-hint-posttool",
                `node "${join(DOCKER_HOOKS_PATH, "sandbox-hint-posttool.mjs")}"`,
              ),
              timeout: 3,
            },
          ],
        },
        {
          // Detect a wedged persistent-bash session. Claude Code's Bash
          // tool uses a persistent shell for state continuity (so `cd`
          // persists). When that shell's IO state desyncs after a
          // long/interrupted command, every subsequent Bash call returns
          // exit-1 with empty stdout/stderr — even `true`. This hook
          // counts consecutive empty Bash results and writes a sentinel
          // + logs to stderr after THRESHOLD in a row, plus injects a
          // one-line nudge via additionalContext so the agent tries
          // KillBash or asks for `switchroom agent restart` rather than
          // retrying the wedged shell in a loop. Bash-only matcher
          // because the wedge is shell-specific; counter resets on any
          // other tool firing.
          //
          // Plugin-gated even though the wedge is a Claude-Code-runtime
          // defect (not a telegram-plugin feature) because the hook
          // depends on $TELEGRAM_STATE_DIR for counter / sentinel files
          // and on the gateway surface to act on the sentinel. Operators
          // running with `channels.telegram.plugin: official` won't get
          // the hook, but they also don't have the gateway surface that
          // would act on it. The hook's fail-silent / no-op-without-
          // state-dir contract makes it safe to enable unconditionally
          // in a future iteration if a non-plugin surface is added.
          matcher: "^Bash$",
          hooks: [
            {
              type: "command",
              command: wrap(
                "hook:wedge-detect-posttool",
                `node "${join(DOCKER_HOOKS_PATH, "wedge-detect-posttool.mjs")}"`,
              ),
              timeout: 3,
            },
          ],
        },
      ]
    : [];

  // --- Switchroom-owned UserPromptSubmit hooks ---
  const useHotReloadStable = agentConfig.channels?.telegram?.hotReloadStable === true;
  const switchroomUserPromptSubmit: Array<Record<string, unknown>> = [
    ...(useHotReloadStable
      ? [
          {
            hooks: [
              {
                type: "command",
                command: wrap(
                  "hook:workspace-stable",
                  `bash "${join(DOCKER_BIN_PATH, "workspace-stable-hook.sh")}"`,
                ),
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
          command: wrap(
            "hook:workspace-dynamic",
            `bash "${join(DOCKER_BIN_PATH, "workspace-dynamic-hook.sh")}"`,
          ),
          timeout: 5,
        },
      ],
    },
    {
      hooks: [
        {
          type: "command",
          command: wrap(
            "hook:timezone",
            `bash "${join(DOCKER_BIN_PATH, "timezone-hook.sh")}"`,
          ),
          timeout: 3,
        },
      ],
    },
  ];

  // Combine user hooks + switchroom-owned hooks
  if (userHooks) {
    return {
      ...userHooks,
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
      ...(switchroomPostToolUse.length > 0
        ? {
            PostToolUse: [
              ...((userHooks.PostToolUse as unknown[]) ?? []),
              ...switchroomPostToolUse,
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
  }

  return {
    UserPromptSubmit: switchroomUserPromptSubmit,
    ...(switchroomPreToolUse.length > 0 ? { PreToolUse: switchroomPreToolUse } : {}),
    ...(switchroomPostToolUse.length > 0 ? { PostToolUse: switchroomPostToolUse } : {}),
    ...(switchroomStop.length > 0 ? { Stop: switchroomStop } : {}),
  };
}

/**
 * Compare an expected hooks block (from buildSettingsHooksBlock) against the
 * actual block read from settings.json.  Returns whether they differ and a
 * short human-readable summary of the difference.
 *
 * Comparison is done via canonical JSON strings (sorted keys) so key-order
 * differences don't produce false positives.
 */
export function detectHooksDrift(
  expected: Record<string, unknown>,
  actual: Record<string, unknown>,
): { drifted: boolean; summary: string } {
  // Canonical serialisation: sort keys at every level so ordering never
  // produces a false positive.
  function canon(v: unknown): string {
    return JSON.stringify(v, (_, val) => {
      if (val && typeof val === "object" && !Array.isArray(val)) {
        return Object.fromEntries(
          Object.entries(val as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
        );
      }
      return val;
    });
  }

  const expectedStr = canon(expected);
  const actualStr = canon(actual);

  if (expectedStr === actualStr) {
    return { drifted: false, summary: "in sync" };
  }

  // Summarise which top-level categories differ
  const allKeys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  const driftedKeys: string[] = [];
  for (const k of allKeys) {
    if (canon(expected[k]) !== canon(actual[k])) {
      driftedKeys.push(k);
    }
  }

  const summary = `DRIFTED (categories: ${driftedKeys.join(", ")})`;
  return { drifted: true, summary };
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

  // --- Migration warning: resume_mode default changed from 'auto' to 'handoff' (#362) ---
  // When an agent has no explicit resume_mode in its YAML config (the most
  // common case for existing installs), it was previously using 'auto' silently.
  // The new default is 'handoff'. We warn once so users know their agent will
  // behave differently, and suppress subsequent warns with a marker file.
  {
    const explicitResumeMode = agentConfig.session_continuity?.resume_mode;
    const markerPath = join(agentDir, ".resume-mode-migration-warned");
    if (!explicitResumeMode && !existsSync(markerPath)) {
      console.warn(
        `  ${chalk.yellow("⚠")} [${name}] resume_mode default changed from 'auto' to 'handoff' (switchroom #362).`,
      );
      console.warn(
        `     Your agent will now start a fresh Claude session on every restart, using a`,
      );
      console.warn(
        `     context briefing instead of --continue. This prevents stale MCP servers`,
      );
      console.warn(
        `     from carrying over and compounds well with the Phase 1 restart changes.`,
      );
      console.warn(
        `     To restore the old behaviour, add to switchroom.yaml:`,
      );
      console.warn(
        `       session_continuity:`,
      );
      console.warn(
        `         resume_mode: auto`,
      );
      console.warn(
        `     (This warning fires once per agent directory and is then suppressed.)`,
      );
      try {
        writeFileSync(markerPath, `resume_mode default changed to handoff at reconcile\n`, "utf-8");
      } catch {
        /* best-effort — if we can't write the marker, we'll warn again next time */
      }
    }
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
  // Single source of truth — must honor SWITCHROOM_MEMORY_BACKEND=none
  // here too: `switchroom agent restart` always reconciles first, so a
  // config-only check would re-wire Hindsight on every restart of a
  // `none` install (install-validation 2026-05-17, R2 review round 2).
  const hindsightEnabled = isHindsightEnabled(switchroomConfig);
  // #235: drop legacy mcp__switchroom__* tokens from any pre-existing
  // allowlist on every reconcile so existing agents converge on the
  // same shape new ones get. #1400 link 1: same treatment for the
  // pre-#1400 blanket hostd grant so a `mcp__hostd__*` left in an
  // agent's switchroom.yaml tools.allow can't silently re-pre-approve
  // the mutating host-control verbs past the human approval card.
  if (Array.isArray(tools.allow)) {
    tools.allow = tools.allow.filter(
      p =>
        !LEGACY_SWITCHROOM_MCP_TOKENS.includes(p) &&
        !LEGACY_HOSTD_BLANKET_TOKENS.includes(p),
    );
  }
  const desiredAllow = dedupe([
    ...baseAllow,
    ...reconcileReadOnlyDefaults,
    ...(usesSwitchroomTelegramPlugin(agentConfig) ? SWITCHROOM_TELEGRAM_MCP_TOOLS : []),
    ...(hindsightEnabled ? HINDSIGHT_MCP_TOOLS : []),
    // See scaffoldAgent for the rationale — pre-approve every-agent
    // MCP servers so first-use doesn't wedge on a permission prompt.
    ...AGENT_CONFIG_MCP_TOOLS,
    ...HOSTD_MCP_TOOLS,
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
  const hindsightRecallMaxMemories = agentConfig.memory?.recall?.max_memories;
  const hindsightRecallCacheTtlSecs = agentConfig.memory?.recall?.cache_ttl_secs;
  const hindsightRecallMinOverlap = agentConfig.memory?.recall?.min_overlap;

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
      repoRoot: REPO_ROOT,
      botToken: resolvedBotToken ?? rawBotToken,
      forumChatId: telegramConfig.forum_chat_id,
      dangerousMode: agentConfig.dangerous_mode === true,
      useSwitchroomPlugin: usesSwitchroomTelegramPlugin(agentConfig),
      // Mirror scaffoldAgent's start.sh context — without this the
      // {{#unless useHotReloadStable}} block always renders, so flipping
      // hotReloadStable on never removes the _WS_STABLE bake from start.sh.
      useHotReloadStable: agentConfig.channels?.telegram?.hotReloadStable === true,
      // PR C: see buildWorkspaceContext for rationale — mirror here so
      // reconcile (apply on existing agents) re-renders start.sh with
      // the current enabled flag.
      telegramEnabledFlag:
        agentConfig.channels?.telegram?.enabled === false ? "false" : "true",
      // sec WS8-F1 / #1416: reconcile re-asserts the security-plugin
      // --plugin-dir on every `switchroom apply` so the boundary
      // self-heals if an older start.sh (without it) is on disk.
      securityPluginDir: DOCKER_SECURITY_PLUGIN_PATH,
      hindsightEnabled: hindsightAutoRecallEnabled,
      hindsightBankIdQ: shellSingleQuote(hindsightBankId),
      hindsightApiBaseUrlQ: shellSingleQuote(hindsightApiBaseUrl),
      hindsightRecallMaxMemories,
      hindsightRecallCacheTtlSecs,
      hindsightRecallMinOverlap,
      // Mirror buildWorkspaceContext (#910): host home for the
      // $HOME/.switchroom symlink in start.sh's docker preamble.
      hostHomeQ: process.env.HOME ? shellSingleQuote(process.env.HOME) : undefined,
      modelQ: shellSingleQuote(agentConfig.model ?? SWITCHROOM_DEFAULT_MAIN_MODEL),
      thinkingEffort: agentConfig.thinking_effort ?? SWITCHROOM_DEFAULT_THINKING_EFFORT,
      permissionMode: agentConfig.permission_mode,
      fallbackModelQ: agentConfig.fallback_model
        ? shellSingleQuote(agentConfig.fallback_model)
        : undefined,
      userEnvQuoted: (() => {
        const combined = {
          ...channelsToEnv(agentConfig),
          ...(agentConfig.env ?? {}),
          ...buildRepoEnvVars(name, agentDir, agentConfig),
        };
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
          const parts = [baseAppend, telegramGuidance, memoryGuidance, SANDBOX_GUIDANCE].filter(s => s.length > 0);
          const combined = parts.join('\n\n---\n\n');
          return shellSingleQuote(combined);
        }
        return baseAppend.length > 0 ? shellSingleQuote(baseAppend) : undefined;
      })(),
      extraCliArgs: (() => {
        const parts: string[] = []
        if (agentConfig.cli_args && agentConfig.cli_args.length > 0) {
          parts.push(...agentConfig.cli_args.map(shellSingleQuote))
        }
        // #199: native Claude Code flag pass-through (mirror of the
        // initial-scaffold path above; reconcile must keep parity).
        if (agentConfig.add_dirs && agentConfig.add_dirs.length > 0) {
          for (const dir of agentConfig.add_dirs) {
            parts.push("--add-dir", shellSingleQuote(dir))
          }
        }
        if (agentConfig.allowed_tools && agentConfig.allowed_tools.length > 0) {
          parts.push("--allowedTools", shellSingleQuote(agentConfig.allowed_tools.join(" ")))
        }
        if (agentConfig.disallowed_tools && agentConfig.disallowed_tools.length > 0) {
          parts.push("--disallowedTools", shellSingleQuote(agentConfig.disallowed_tools.join(" ")))
        }
        return parts.length > 0 ? " " + parts.join(" ") : undefined
      })(),
      sessionMaxIdleSecs: parseDurationToSeconds(agentConfig.session?.max_idle),
      sessionMaxTurns: agentConfig.session?.max_turns,
      handoffEnabled: agentConfig.session_continuity?.enabled !== false,
      handoffShowLine: agentConfig.session_continuity?.show_handoff_line !== false,
      resumeMode: agentConfig.session_continuity?.resume_mode ?? "handoff",
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
        // Used by the "Admin surface" section of CLAUDE.md.hbs so an
        // admin: true agent gets the fleet-ops paragraph and a regular
        // agent gets the "I'm not admin — ask <peer>" refusal pattern.
        admin: agentConfig.admin === true,
      };

      // Render template, then append the switchroom-managed
      // fragments (every agent gets them; reconcile re-applies on
      // every run so updates propagate without touching per-profile
      // templates). The ORDER must mirror the first-scaffold path
      // (line 2080+ above: vault protocol, then agent-self-service)
      // or the diff-abort below will trip on every reconcile — the
      // root cause of the 30+ scaffold test failures landing before
      // PR #1163 was that this path missed the self-service fragment
      // the other path applied. Both fragments are no-ops if their
      // source file is absent.
      let rendered = renderTemplate(claudeMdSrc, claudeContext);
      const vaultProtocol = renderVaultProtocolFragment(claudeContext);
      if (vaultProtocol) {
        rendered = rendered.trimEnd() + "\n\n" + vaultProtocol + "\n";
      }
      const selfService = renderAgentSelfServiceFragment(claudeContext);
      if (selfService) {
        rendered = rendered.trimEnd() + "\n\n" + selfService + "\n";
      }
      let composed = composeWithSidecar(rendered, claudeCustomPath);

      // Legacy claude_md_raw still appends after sidecar (one-shot escape hatch)
      if (agentConfig.claude_md_raw) {
        composed = composed.trimEnd() + "\n\n" + agentConfig.claude_md_raw + "\n";
      }

      // CLAUDE.md is template-owned: every reconcile regenerates it from
      // CLAUDE.md.hbs + workspace/CLAUDE.custom.md sidecar. Drift between
      // on-disk and freshly-rendered bytes is almost always template
      // churn upstream, not operator hand-edits (operators put custom
      // content in the sidecar). The previous abort treated those cases
      // identically and forced --preserve-claude-md on every release.
      // Preserve mode still exists for operators who genuinely want to
      // freeze a CLAUDE.md (`reconcile --preserve-claude-md`).
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
    // Entries with value `false` in mcp_servers are opt-outs — they suppress
    // a built-in default (e.g. playwright) for this agent and are not written
    // to settings.json.
    const mcpServers: Record<string, unknown> = {};

    // Hindsight first (so it's the most visible to a reader)
    const hindsightEntry = getHindsightSettingsEntry(name, switchroomConfig);
    if (hindsightEntry) {
      mcpServers[hindsightEntry.key] = hindsightEntry.value;
    }

    // #235: switchroom-mcp is deprecated — its 4 tools (switchroom_memory_*,
    // workspace_memory_*) had zero callers; Hindsight's MCP +
    // Claude Code's built-in Read/Grep cover the same ground. New agents
    // skip the entry entirely; reconcile retracts it from existing ones.

    // Built-in default MCPs (e.g. playwright). Single source of truth lives
    // in scaffold-integration.ts; `switchroom update` reconciles the same
    // list onto pre-existing agents. Agents opt out via
    // `mcp_servers: { <key>: false }` in switchroom.yaml.
    for (const entry of getBuiltinDefaultMcpEntries()) {
      const optOut = (agentConfig.mcp_servers ?? {})[entry.optOutKey] === false;
      if (!optOut) {
        mcpServers[entry.key] = entry.value;
      }
    }

    // Per-agent conditional `gdrive` MCP — same shared gate as the
    // scaffoldAgent path (resolveGdriveMcpEntry honours the
    // `mcp_servers: { gdrive: false }` opt-out and the broker-ACL
    // predicate). Placed before the user-defined extras below so an
    // explicit user `gdrive` entry still overrides. `switchroom update`
    // → reconcile re-evaluates this every run, so toggling
    // google_workspace.account / google_accounts.enabled_for[] in
    // switchroom.yaml adds or retracts the entry on the next reconcile.
    {
      const gdrive = resolveGdriveMcpEntry(name, agentConfig, switchroomConfig);
      if (gdrive) {
        mcpServers[gdrive.key] = gdrive.value;
      } else {
        // Retraction: if the agent lost authorization (account removed
        // from enabled_for[], or opt-out flipped), drop any stale entry
        // so reconcile is the source of truth — mirrors how the #235
        // switchroom-mcp retraction works.
        delete mcpServers["gdrive"];
      }
    }

    // User-defined extras from switchroom.yaml agents.<name>.mcp_servers.
    // Skip `false` values — those are opt-outs for built-in defaults above.
    if (agentConfig.mcp_servers) {
      for (const [key, value] of Object.entries(agentConfig.mcp_servers)) {
        if (value === false) continue; // opt-out sentinel — already handled above
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

    // --- One-shot migration: retract dead settings keys that prior switchroom
    // versions emitted from the hbs template. They were never tracked in
    // _switchroomManagedRawKeys (template-emitted, not settings_raw-injected),
    // so the loop above doesn't catch them on existing agents. Delete them
    // explicitly. Safe to remove this block after a few releases.
    // See settings.json.hbs header for why these keys are no-ops at project scope.
    delete settings.enabledPlugins;
    delete settings.skipDangerousModePermissionPrompt;

    // --- Phase 2: reconcile user hooks (replace, don't merge) ---
    //
    // Fully replace settings.hooks from switchroom.yaml each reconcile, so
    // removing a hook event from switchroom.yaml also removes it from
    // settings.json. Plugin-installed hooks (hindsight) live in the
    // plugin's own hooks.json and are loaded via --plugin-dir, so
    // they're not affected by this. Switchroom-owned.
    //
    // buildSettingsHooksBlock() is the single source of truth for the full
    // hooks block (user yaml + switchroom-owned). It is also called by the
    // drift-check path (reconcile --check) without performing a write.
    // SessionStart greeting hook deleted in #142 — see scaffoldAgent
    // for the rationale.
    settings.hooks = buildSettingsHooksBlock({
      agentName: name,
      agentConfig,
      hindsightEnabled,
      useSwitchroomPlugin: usesSwitchroomTelegramPlugin(agentConfig),
      configPath: switchroomConfigPath,
    });

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
        // Post-cascade invariant — see same check in scaffoldAgent above.
        if (!saDef.description) {
          throw new Error(
            `subagent "${saName}" has no description after cascade — add one ` +
              `to your defaults, the profile this agent extends, or the agent's ` +
              `own subagents.${saName} block.`,
          );
        }
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

    // Model resolution mirrors scaffoldAgent's path so reconcile + create
    // produce the same settings.model byte-for-byte. Apply the switchroom
    // default (Sonnet 4.6) when the operator hasn't set an explicit
    // override in switchroom.yaml.
    settings.model = agentConfig.model ?? SWITCHROOM_DEFAULT_MAIN_MODEL;

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
    const reconBrokerSocket = switchroomConfig?.vault?.broker?.socket
      ? resolveDualPath(switchroomConfig.vault.broker.socket)
      : resolveDualPath("~/.switchroom/vault-broker.sock");
    const reconCronChatId = cronUserId ?? telegramConfig.forum_chat_id;
    const canonicalFilenames = new Set<string>();
    for (let i = 0; i < agentConfig.schedule!.length; i++) {
      const entry = agentConfig.schedule![i];
      const model = entry.model ?? "claude-sonnet-4-6";
      const filename = cronScriptFilename(entry.cron, entry.prompt);
      canonicalFilenames.add(filename);
      const script = buildCronScript(
        agentDir, entry.prompt, model,
        reconCronChatId, cronUserId, entry.secrets ?? [], reconBrokerSocket,
        filename.replace(/\.sh$/, ""),
      );
      const scriptPath = join(agentDir, "telegram", filename);
      const before = existsSync(scriptPath) ? readFileSync(scriptPath, "utf-8") : "";
      if (script !== before) {
        writeFileSync(scriptPath, script, { encoding: "utf-8", mode: 0o700 });
        changes.push(scriptPath);
      }
      // Phase D: .source sidecar attribution (main vs overlay).
      const source = (entry as Record<symbol, unknown>)[OVERLAY_SOURCE] ? "overlay" : "main";
      const stem = filename.replace(/\.sh$/, "");
      const sidecarPath = join(agentDir, "telegram", `${stem}.source`);
      const sidecarBody = `${source}\n`;
      const sidecarBefore = existsSync(sidecarPath) ? readFileSync(sidecarPath, "utf-8") : "";
      if (sidecarBody !== sidecarBefore) {
        writeFileSync(sidecarPath, sidecarBody, { encoding: "utf-8", mode: 0o600 });
        changes.push(sidecarPath);
      }
    }
    // Cleanup: remove stale cron scripts not in the canonical set,
    // including any legacy `cron-<digits>.sh` files left over from the
    // pre-Phase-D index-based scheme. Idempotent: re-running with the
    // same config produces no further deletions.
    const telegramDir = join(agentDir, "telegram");
    if (existsSync(telegramDir)) {
      const files = readdirSync(telegramDir);
      for (const file of files) {
        const isCron = CRON_SCRIPT_BASENAME_RE.test(file) || LEGACY_CRON_SCRIPT_BASENAME_RE.test(file);
        if (isCron && !canonicalFilenames.has(file)) {
          const staleScript = join(telegramDir, file);
          unlinkSync(staleScript);
          changes.push(staleScript);
          const sourceSidecar = staleScript.replace(/\.sh$/, ".source");
          if (existsSync(sourceSidecar)) {
            unlinkSync(sourceSidecar);
            changes.push(sourceSidecar);
          }
        }
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
  // Role-gated (#235 follow-up). Reconcile honors role flips both
  // ways: assistant → foreman installs the symlinks; foreman →
  // assistant retracts them.
  installSwitchroomSkills(agentDir, { role: agentConfig.role });

  // --- Reconcile bundled default skills (anthropic + switchroom-core) ---
  // Mirrors scaffoldAgent — additive, idempotent, honours opt-outs.
  reconcileAgentDefaultSkills(
    agentDir,
    (agentConfig.bundled_skills ?? {}) as Record<string, unknown>,
  );

  // --- Reconcile .mcp.json (switchroom-telegram plugin agents only) ---
  if (usesSwitchroomTelegramPlugin(agentConfig)) {
    const mcpJsonPath = join(agentDir, ".mcp.json");
    // Mirror scaffoldAgent: in-image plugin + CLI + bind-mounted config.
    const pluginDir = DOCKER_TELEGRAM_PLUGIN_PATH;
    const switchroomCliPath = "/usr/local/bin/switchroom";
    const resolvedConfigPath = DOCKER_CONFIG_PATH;

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
      // Read-only agent-config broker. Exposes 4 tools (config_get,
      // cron_list, skill_list, audit_tail) that re-exec the switchroom
      // CLI. Identity is pinned by SWITCHROOM_AGENT_NAME — the CLI
      // refuses cross-agent reads.
      "agent-config": {
        command: switchroomCliPath,
        args: ["mcp", "agent-config"],
        env: {
          SWITCHROOM_AGENT_NAME: name,
          SWITCHROOM_CONFIG: resolvedConfigPath,
        },
      },
    };

    // hostd MCP — admin-only fleet-management tools (agent_restart,
    // agent_start, agent_stop, update_check, update_apply). Wired only
    // for admin-flagged agents because compose only bind-mounts the
    // per-agent hostd socket for those (#1175 RFC C §5.2). Without
    // the socket, the tools fail at first call with a clean ENOENT
    // error message — but cleaner UX to just not surface them.
    if (agentConfig.admin === true) {
      mcpServers["hostd"] = {
        command: switchroomCliPath,
        args: ["mcp", "hostd"],
        env: {
          SWITCHROOM_AGENT_NAME: name,
          SWITCHROOM_CONFIG: resolvedConfigPath,
        },
      };
    }

    if (hindsightEnabled) {
      const hindsightEntry = getHindsightSettingsEntry(name, switchroomConfig);
      if (hindsightEntry) {
        mcpServers[hindsightEntry.key] = hindsightEntry.value;
      }
    }

    // Per-agent conditional `gdrive` MCP. THIS .mcp.json (not
    // settings.json.mcpServers) is the surface Claude Code actually
    // loads for switchroom-telegram-plugin agents. mcpServers is rebuilt
    // fresh from the hardcoded set each reconcile, so a retracted gdrive
    // simply isn't re-added (no explicit delete needed). Same shared
    // broker-ACL gate as scaffoldAgent / settings paths.
    {
      const gdrive = resolveGdriveMcpEntry(name, agentConfig, switchroomConfig);
      if (gdrive) {
        mcpServers[gdrive.key] = gdrive.value;
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
    // Mirror scaffoldAgent: keep every scaffolded server on Claude
    // Code's per-project trust allowlist (idempotent — runs every
    // reconcile so a newly-added gdrive/hostd is trusted on the next
    // `switchroom apply`, not just at original onboarding).
    ensureMcpServersTrusted(agentDir, Object.keys(mcpServers));
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
    hindsightRecallMaxMemories,
    hindsightRecallCacheTtlSecs,
    hindsightRecallMinOverlap,
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
    rewrittenWithBackup: changes,
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

// Content-aware write for purely template-driven files (see #879).
// Reads existing content, renders fresh, writes only when different.
// Existing-and-changed counts as "created" for the caller's running
// total — `apply`'s "N files created" line then truthfully reflects
// that the file was rewritten, instead of silently reporting
// "up to date" when the template has drifted.
function writeIfChanged(
  filePath: string,
  contentFn: () => string,
  created: string[],
  skipped: string[],
  mode?: number,
): void {
  const next = contentFn();
  const prev = existsSync(filePath) ? readFileSync(filePath, "utf-8") : null;
  if (prev === next) {
    skipped.push(filePath);
    return;
  }
  writeFileSync(filePath, next, mode !== undefined ? { encoding: "utf-8", mode } : "utf-8");
  created.push(filePath);
}

/**
 * Smart-rerender for files we GENERATE from a template but that the
 * operator MIGHT hand-edit between scaffolds. The previous
 * `writeIfMissing` behaviour froze the file forever after first write
 * — which meant a profile-template change (e.g. a new
 * `_shared/telegram-style.md.hbs` prompt) never reached existing
 * agents via `switchroom apply`. That was the root cause of the
 * #1122 conversational-pacing rollout silently bypassing every
 * agent's CLAUDE.md (discovered 2026-05-12 UAT overnight run).
 *
 * Contract:
 *  - First write: fresh content, drop a fingerprint sidecar
 *    (`<filename>.fingerprint`) holding the SHA-256 of what we wrote.
 *  - Subsequent apply:
 *     - Render fresh. If `hash(rendered) === hash(file_on_disk)`,
 *       no-op — file already reflects current template.
 *     - Else, read the fingerprint sidecar.
 *        - If sidecar matches `hash(file_on_disk)`: the operator has
 *          NOT touched the file since we last wrote it — template
 *          drifted, safe to overwrite + update fingerprint.
 *        - If sidecar doesn't match (or is missing): operator
 *          hand-edited the file. Back up the existing file to
 *          `<filename>.before-rerender.<unix-ms>` and overwrite
 *          + update fingerprint. The backup is loud enough for the
 *          operator to notice and re-merge their edits manually.
 *
 * Caveat: hashing is SHA-256 (`node:crypto`); cost is microseconds
 * per call. Fingerprint sidecar gets ~64 bytes per file. Trivial.
 */
function rerenderWithFingerprint(
  filePath: string,
  contentFn: () => string,
  created: string[],
  skipped: string[],
  rewrittenWithBackup: string[],
  mode?: number,
): void {
  const next = contentFn();
  const nextHash = createHash("sha256").update(next, "utf-8").digest("hex");
  const fingerprintPath = filePath + ".fingerprint";
  const writeMode = mode !== undefined ? { encoding: "utf-8" as const, mode } : "utf-8" as const;

  if (!existsSync(filePath)) {
    writeFileSync(filePath, next, writeMode);
    writeFileSync(fingerprintPath, nextHash, "utf-8");
    created.push(filePath);
    return;
  }

  const prev = readFileSync(filePath, "utf-8");
  if (prev === next) {
    // File is already exactly what we'd render — refresh the fingerprint
    // (cheap, covers the case where someone deleted the fingerprint or
    // we're migrating an existing file into the fingerprint regime).
    try {
      writeFileSync(fingerprintPath, nextHash, "utf-8");
    } catch {
      // best-effort
    }
    skipped.push(filePath);
    return;
  }

  // Source has drifted. Decide whether to clobber.
  const prevHash = createHash("sha256").update(prev, "utf-8").digest("hex");
  const recordedFingerprint = existsSync(fingerprintPath)
    ? readFileSync(fingerprintPath, "utf-8").trim()
    : null;

  if (recordedFingerprint === prevHash) {
    // Operator hasn't touched the file since we last wrote it —
    // template drifted, clobber cleanly.
    writeFileSync(filePath, next, writeMode);
    writeFileSync(fingerprintPath, nextHash, "utf-8");
    created.push(filePath);
    return;
  }

  // Either no fingerprint (legacy state — file pre-dates this regime)
  // or fingerprint mismatch (operator edited). Back up + overwrite.
  const backupPath = `${filePath}.before-rerender.${Date.now()}`;
  try {
    writeFileSync(backupPath, prev, "utf-8");
  } catch (err) {
    // If we can't back up, BAIL — refuse to clobber unrecoverable
    // operator edits. Push to `skipped` so apply's summary lists
    // the file as untouched and the operator can investigate.
    process.stderr.write(
      `scaffold: refusing to overwrite ${filePath} — backup write failed ` +
      `(${(err as Error).message}). Operator edits preserved.\n`,
    );
    skipped.push(filePath);
    return;
  }
  writeFileSync(filePath, next, writeMode);
  writeFileSync(fingerprintPath, nextHash, "utf-8");
  rewrittenWithBackup.push(filePath);
  // Also count this as "created" for apply's running total so the
  // post-apply summary reflects that the file was rewritten rather
  // than silently absent from both columns.
  created.push(filePath);
}

function buildAccessJson(
  agentConfig: AgentConfig,
  telegramConfig: TelegramConfig,
  resolvedTopicId?: number,
  userId?: string,
): string {
  // Issue #1001: defensive String() coercion so a numeric userId from a
  // legacy `~/.switchroom/user.json` (saveUserConfig is typed `string`
  // but TS can't enforce at runtime) doesn't land an unquoted JSON
  // number in allowFrom (which the gateway then rejects as "non-string
  // entries — treating as empty").
  const allowFrom = userId ? [String(userId)] : [];
  if (allowFrom.length === 0) {
    console.warn(
      "  WARNING: No user ID available for access.json allowFrom. " +
      "DM the bot /start and run `switchroom setup` again to pair your Telegram account."
    );
  }
  const access: Record<string, unknown> = {
    dmPolicy: "allowlist",
    allowFrom,
  };
  // DM-only bots opt out of inheriting the global forum_chat_id into
  // the access list. Without this, the boot probe sweeps a chat the
  // bot isn't a member of and emits a noisy "boot-probe-failed: 400
  // chat not found" every restart (plus a misleading user-facing
  // notification). See the schema doc on `dm_only` for the design
  // rationale.
  //
  // Issue #1002: also skip when the resolved forum chat id is the
  // empty string or the v0.7 sentinel "0" — those are the values
  // `switchroom agent add --topology dm` emits when no real forum
  // chat is in scope, and the bug surfaced as a spurious 404 on every
  // fresh DM-topology agent.
  const forumChatId = telegramConfig.forum_chat_id;
  const hasRealForumChat = forumChatId !== "" && forumChatId !== "0";
  if (!agentConfig.dm_only && hasRealForumChat) {
    access.groups = {
      [forumChatId]: {
        requireMention: false,
        allowFrom,
      },
    };
  }

  // #596: project resolved telegram-channel features (stickers, voice_in,
  // telegraph) into access.json so the gateway picks them up at runtime
  // without re-reading switchroom.yaml. The cascade in mergeAgentConfig
  // already folds the deprecated root-level fields into channels.telegram.*,
  // so reading from the new canonical location covers both old and new
  // switchroom.yaml shapes.
  const tg = agentConfig.channels?.telegram;
  if (tg?.stickers && Object.keys(tg.stickers).length > 0) {
    access.stickers = tg.stickers;
  }
  if (tg?.voice_in) {
    access.voice_in = tg.voice_in;
  }
  if (tg?.telegraph) {
    access.telegraph = tg.telegraph;
  }

  return JSON.stringify(access, null, 2) + "\n";
}
