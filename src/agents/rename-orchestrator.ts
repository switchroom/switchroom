/**
 * Agent rename orchestrator — `switchroom agent rename <old> <new>`.
 *
 * Orchestrates all steps required to rename an agent slug cleanly:
 *   1. Validate: old exists, new doesn't, both names are valid slugs
 *   2. Stop <old> with drain (systemctl stop)
 *   3. Snapshot agent dir + systemd state for rollback
 *   4. Rename agent dir
 *   5. Rename systemd unit(s)
 *   6. Rename vault key (if matching the per-agent prefix convention)
 *   7. Update switchroom.yaml: agent key, bot_token vault ref, memory.collection
 *   8. Reconcile: rewrites .mcp.json, settings.json, start.sh, CLAUDE.md
 *   9. Hindsight bank: opt-in via --hindsight flag (default: preserve = keep old bank ID)
 *  10. Start <new>
 *  11. On any step failing: rollback to snapshot, restore old state, exit non-zero
 *
 * Hindsight bank rename is NOT done by default (data-migration risk). Use
 * --hindsight=fresh or --hindsight=migrate flags to control (migrate is out
 * of scope for v1 and deferred to a follow-up issue).
 */

import { resolve } from "node:path";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  cpSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolveAgentsDir, loadConfig, resolvePath } from "../config/loader.js";
import type { SwitchroomConfig } from "../config/schema.js";
import {
  openVault,
  saveVault,
} from "../vault/vault.js";
import {
  generateUnit,
  generateGatewayUnit,
  installUnit,
  uninstallUnit,
  unitFilePath,
  resolveGatewayUnitName,
  installScheduleTimers,
  enableScheduleTimers,
  daemonReload,
} from "./systemd.js";
import {
  stopAgent,
  startAgent,
} from "./lifecycle.js";
import { reconcileAgent } from "./scaffold.js";
import { usesSwitchroomTelegramPlugin, resolveAgentConfig } from "../config/merge.js";
import { resolveTimezone } from "../config/timezone.js";
import { isVaultReference, parseVaultReference } from "../vault/resolver.js";
import YAML from "yaml";
import { readFileSync, writeFileSync } from "node:fs";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Regex that agent names must match — mirrors the constraint in create-orchestrator.ts.
 */
const AGENT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,50}$/;

export type HindsightMode = "preserve" | "fresh";

export interface RenameAgentOpts {
  /** Current agent slug. */
  oldName: string;
  /** Desired new agent slug. */
  newName: string;
  /** Path to switchroom.yaml. */
  configPath: string;
  /** How to handle the Hindsight bank. Default: "preserve" (keep old bank ID unchanged). */
  hindsightMode?: HindsightMode;
}

export interface RenameAgentResult {
  /** Absolute path to the renamed agent directory (under the new slug). */
  agentDir: string;
  /** List of vault keys renamed (may be empty when no matching key existed). */
  vaultKeysRenamed: string[];
  /** Changes applied during reconcile. */
  reconcileChanges: string[];
}

/**
 * Injected dependencies — allows tests to mock everything without touching
 * the real filesystem, systemd, or vault.
 */
export interface RenameAgentDeps {
  loadConfig: (configPath: string) => SwitchroomConfig;
  resolveAgentsDir: (config: SwitchroomConfig) => string;
  stopAgent: (name: string) => void;
  startAgent: (name: string) => void;
  installUnit: (name: string, content: string) => void;
  uninstallUnit: (name: string) => void;
  generateUnit: typeof generateUnit;
  generateGatewayUnit: typeof generateGatewayUnit;
  resolveGatewayUnitName: typeof resolveGatewayUnitName;
  installScheduleTimers: typeof installScheduleTimers;
  enableScheduleTimers: typeof enableScheduleTimers;
  daemonReload: () => void;
  reconcileAgent: typeof reconcileAgent;
  usesSwitchroomTelegramPlugin: typeof usesSwitchroomTelegramPlugin;
  resolveAgentConfig: typeof resolveAgentConfig;
  resolveTimezone: typeof resolveTimezone;
  /** Open vault and return secrets dict. */
  openVault?: typeof openVault;
  /** Save vault with updated secrets dict. */
  saveVault?: typeof saveVault;
  /** Read vault path from config or env. */
  resolveVaultPath?: (config: SwitchroomConfig) => string;
  /** Snapshot the agent dir to a temp location. Returns path of snapshot. */
  snapshotDir?: (src: string) => string;
  /** Copy agent dir to new path. */
  copyDir?: (src: string, dst: string) => void;
  /** Remove a directory tree. */
  removeDir?: (path: string) => void;
  /** Check if systemd unit file exists. */
  unitFilePath?: (name: string) => string;
  existsSync?: (path: string) => boolean;
  /** Read a file (injectable for tests). */
  readFileSync?: (path: string, encoding: BufferEncoding) => string;
}

// ─── Default deps (real implementation) ──────────────────────────────────────

function defaultDeps(): RenameAgentDeps {
  return {
    loadConfig,
    resolveAgentsDir,
    stopAgent,
    startAgent,
    installUnit,
    uninstallUnit,
    generateUnit,
    generateGatewayUnit,
    resolveGatewayUnitName,
    installScheduleTimers,
    enableScheduleTimers,
    daemonReload,
    reconcileAgent,
    usesSwitchroomTelegramPlugin,
    resolveAgentConfig,
    resolveTimezone,
    openVault,
    saveVault,
    resolveVaultPath: (config) =>
      resolvePath(config.vault?.path ?? "~/.switchroom/vault.enc"),
    snapshotDir: (src) => {
      const tmp = mkdtempSync(resolve(tmpdir(), "switchroom-rename-snap-"));
      cpSync(src, tmp, { recursive: true });
      return tmp;
    },
    copyDir: (src, dst) => cpSync(src, dst, { recursive: true }),
    removeDir: (p) => rmSync(p, { recursive: true, force: true }),
    unitFilePath,
    existsSync,
    readFileSync: (p, enc) => readFileSync(p, enc),
  };
}

// ─── YAML helpers ─────────────────────────────────────────────────────────────

/**
 * Rename an agent key in switchroom.yaml:
 *   - renames the agents.<old> key to agents.<new>
 *   - rewrites bot_token vault ref from vault:old* → vault:new* (prefix match)
 *   - rewrites memory.collection if it equals oldName (default derived value)
 *
 * Preserves all other fields verbatim.
 */
export function renameAgentInConfig(
  configPath: string,
  oldName: string,
  newName: string,
): void {
  const raw = readFileSync(configPath, "utf-8");
  const doc = YAML.parseDocument(raw);
  const agents = doc.get("agents") as YAML.YAMLMap | null;
  if (!agents || !agents.has(oldName)) {
    throw new Error(`Agent "${oldName}" not found in ${configPath}`);
  }
  if (agents.has(newName)) {
    throw new Error(`Agent "${newName}" already exists in ${configPath}`);
  }

  // Clone the old entry and adjust fields that embed the slug
  const oldEntry = agents.get(oldName) as YAML.YAMLMap;

  // Rewrite bot_token vault reference if it uses the old slug as a prefix
  const rawBotToken = oldEntry.get("bot_token") as string | undefined;
  if (rawBotToken && isVaultReference(rawBotToken)) {
    const key = parseVaultReference(rawBotToken);
    // Only rename if the vault key starts with the old agent name
    // (convention: vault:fin.bot_token or vault:fin-bot-token etc.)
    if (key === oldName || key.startsWith(`${oldName}.`) || key.startsWith(`${oldName}-`)) {
      const newKey = newName + key.slice(oldName.length);
      oldEntry.set("bot_token", `vault:${newKey}`);
    }
  }

  // Rewrite memory.collection if it equals oldName (the default derived value)
  const memoryNode = oldEntry.get("memory") as YAML.YAMLMap | undefined;
  if (memoryNode) {
    const collection = memoryNode.get("collection") as string | undefined;
    if (collection === oldName) {
      memoryNode.set("collection", newName);
    }
  }

  // Remove old key and add under new name (preserves all other fields)
  agents.delete(oldName);
  agents.set(newName, oldEntry);

  writeFileSync(configPath, doc.toString(), "utf-8");
}

/**
 * Find all vault keys that begin with the old agent slug prefix convention:
 *   - exact match: key === oldName
 *   - dot-separated: key.startsWith(`${oldName}.`)
 *   - hyphen-separated: key.startsWith(`${oldName}-`)
 *
 * Returns a map of old key → new key for matching entries.
 */
export function findAgentVaultKeys(
  secrets: Record<string, unknown>,
  oldName: string,
  newName: string,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of Object.keys(secrets)) {
    if (
      key === oldName ||
      key.startsWith(`${oldName}.`) ||
      key.startsWith(`${oldName}-`)
    ) {
      const newKey = newName + key.slice(oldName.length);
      result[key] = newKey;
    }
  }
  return result;
}

// ─── Main orchestrator ────────────────────────────────────────────────────────

export async function renameAgent(
  opts: RenameAgentOpts,
  injectedDeps?: Partial<RenameAgentDeps>,
): Promise<RenameAgentResult> {
  const deps: RenameAgentDeps = { ...defaultDeps(), ...injectedDeps };

  const { oldName, newName, configPath, hindsightMode = "preserve" } = opts;
  const _existsSync = deps.existsSync!;
  const _readFileSync = deps.readFileSync ?? ((p: string, enc: BufferEncoding) => readFileSync(p, enc));

  // ── Step 1: Validate ──────────────────────────────────────────────────────
  if (!AGENT_NAME_RE.test(oldName)) {
    throw new Error(
      `Invalid old agent name: "${oldName}". ` +
        `Names must match ^[a-z0-9][a-z0-9_-]{0,50}$`,
    );
  }
  if (!AGENT_NAME_RE.test(newName)) {
    throw new Error(
      `Invalid new agent name: "${newName}". ` +
        `Names must match ^[a-z0-9][a-z0-9_-]{0,50}$`,
    );
  }
  if (oldName === newName) {
    throw new Error(`Old and new names are the same: "${oldName}"`);
  }

  // Load config before any validation that touches it
  let config = deps.loadConfig(configPath);
  const agentsDir = deps.resolveAgentsDir(config);

  if (!config.agents[oldName]) {
    throw new Error(
      `Agent "${oldName}" is not defined in switchroom.yaml. ` +
        `Existing agents: ${Object.keys(config.agents).join(", ")}`,
    );
  }
  if (config.agents[newName]) {
    throw new Error(
      `Agent "${newName}" is already defined in switchroom.yaml. ` +
        `Choose a different name or remove the existing entry first.`,
    );
  }

  const oldAgentDir = resolve(agentsDir, oldName);
  const newAgentDir = resolve(agentsDir, newName);

  if (!_existsSync(oldAgentDir)) {
    throw new Error(
      `Agent directory not found: ${oldAgentDir}. ` +
        `The agent may not have been scaffolded yet.`,
    );
  }
  if (_existsSync(newAgentDir)) {
    throw new Error(
      `Directory already exists at target path: ${newAgentDir}. ` +
        `Remove it first or choose a different name.`,
    );
  }

  const oldAgentConfig = config.agents[oldName];
  const oldGwName = deps.resolveGatewayUnitName(config, oldName);
  const usesPlugin = deps.usesSwitchroomTelegramPlugin(oldAgentConfig);

  // Rollback state tracking
  let snapshotPath: string | undefined;
  let snapshotSystemdFiles: Array<{ from: string; content: string }> = [];
  let dirRenamed = false;
  let mainUnitInstalled = false;
  let gwUnitInstalled = false;
  let yamlUpdated = false;
  let vaultKeysRenamed: Record<string, string> = {};
  let vaultUpdateApplied = false;

  // ── Step 2: Stop <old> ────────────────────────────────────────────────────
  try {
    deps.stopAgent(oldName);
  } catch {
    // May already be stopped — continue
  }

  // ── Step 3: Snapshot for rollback ─────────────────────────────────────────
  snapshotPath = deps.snapshotDir!(oldAgentDir);

  // Snapshot systemd unit files for rollback
  const unitPath = deps.unitFilePath!(oldName);
  if (_existsSync(unitPath)) {
    snapshotSystemdFiles.push({
      from: unitPath,
      content: _readFileSync(unitPath, "utf-8"),
    });
  }
  if (oldGwName) {
    const gwUnitPath = deps.unitFilePath!(oldGwName);
    if (_existsSync(gwUnitPath)) {
      snapshotSystemdFiles.push({
        from: gwUnitPath,
        content: _readFileSync(gwUnitPath, "utf-8"),
      });
    }
  }

  /**
   * Execute fn. On failure: roll back all applied changes in reverse order,
   * then re-throw the original error.
   */
  async function withRollback<T>(fn: () => T | Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      // Roll back in reverse order
      await rollbackAll(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  async function rollbackAll(reason: string): Promise<void> {
    const rollbackErrors: string[] = [];

    // Rollback vault key renames
    if (vaultUpdateApplied && Object.keys(vaultKeysRenamed).length > 0) {
      try {
        const vaultPath = deps.resolveVaultPath!(config);
        const vaultPass = process.env.SWITCHROOM_VAULT_PASSPHRASE;
        if (vaultPass && deps.openVault && deps.saveVault) {
          const secrets = deps.openVault(vaultPass, vaultPath);
          for (const [oldKey, newKey] of Object.entries(vaultKeysRenamed)) {
            if (newKey in secrets) {
              secrets[oldKey] = secrets[newKey];
              delete secrets[newKey];
            }
          }
          deps.saveVault(vaultPass, vaultPath, secrets);
        }
      } catch (e) {
        rollbackErrors.push(`vault key rollback failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Rollback yaml change
    if (yamlUpdated) {
      try {
        renameAgentInConfig(configPath, newName, oldName);
      } catch (e) {
        rollbackErrors.push(`yaml rollback failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Rollback new systemd units
    if (mainUnitInstalled) {
      try { deps.uninstallUnit(newName); } catch (e) {
        rollbackErrors.push(`uninstall new unit failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (gwUnitInstalled && oldGwName) {
      const newGwName = `${newName}-gateway`;
      try { deps.uninstallUnit(newGwName); } catch (e) {
        rollbackErrors.push(`uninstall new gateway unit failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Restore old systemd unit files
    for (const snap of snapshotSystemdFiles) {
      try { writeFileSync(snap.from, snap.content, { mode: 0o644 }); } catch (e) {
        rollbackErrors.push(`restore unit file ${snap.from} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Restore directory from snapshot
    if (dirRenamed && snapshotPath) {
      try {
        // Remove the renamed dir if it exists
        if (_existsSync(newAgentDir)) {
          deps.removeDir!(newAgentDir);
        }
        // If old dir was moved, it's gone — restore from snapshot
        if (!_existsSync(oldAgentDir) && snapshotPath) {
          deps.copyDir!(snapshotPath, oldAgentDir);
        }
      } catch (e) {
        rollbackErrors.push(`directory restore failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Remove snapshot
    if (snapshotPath) {
      try { deps.removeDir!(snapshotPath); } catch { /* best effort */ }
    }

    // Attempt to restart the old agent
    try {
      deps.startAgent(oldName);
    } catch { /* best effort — old agent may not be restartable */ }

    if (rollbackErrors.length > 0) {
      throw new Error(
        `Rename failed (${reason}) and rollback had errors:\n` +
          rollbackErrors.map((e) => `  - ${e}`).join("\n"),
      );
    }
  }

  // ── Step 4: Rename agent dir (copy + delete) ──────────────────────────────
  await withRollback(async () => {
    deps.copyDir!(oldAgentDir, newAgentDir);
    dirRenamed = true;
    deps.removeDir!(oldAgentDir);
  });

  // ── Step 5: Rename systemd units ──────────────────────────────────────────
  await withRollback(async () => {
    // Uninstall old main unit
    deps.uninstallUnit(oldName);

    // Install new main unit (content will be regenerated by reconcile, but we
    // need a unit file present so systemd knows the service exists)
    const resolvedAgentConfig = deps.resolveAgentConfig(
      config.defaults,
      config.profiles,
      oldAgentConfig,
    );
    const timezone = deps.resolveTimezone(config, resolvedAgentConfig);
    const newGwName = usesPlugin ? `${newName}-gateway` : undefined;
    const newUnitContent = deps.generateUnit(newName, newAgentDir, usesPlugin, newGwName, timezone);
    deps.installUnit(newName, newUnitContent);
    mainUnitInstalled = true;

    // Handle gateway unit rename
    if (usesPlugin && oldGwName) {
      const newGwName2 = `${newName}-gateway`;
      deps.uninstallUnit(oldGwName);
      const stateDir = resolve(newAgentDir, "telegram");
      const adminEnabled =
        (deps.resolveAgentConfig(config.defaults, config.profiles, oldAgentConfig) as { admin?: boolean })
          .admin === true;
      const gwContent = deps.generateGatewayUnit(stateDir, newName, adminEnabled);
      deps.installUnit(newGwName2, gwContent);
      gwUnitInstalled = true;
    }

    deps.daemonReload();
  });

  // ── Step 6: Rename vault key(s) ───────────────────────────────────────────
  // Only when vault passphrase is available (non-interactive environments
  // may skip this step silently — the vault ref in yaml is also rewritten below).
  const vaultPass = process.env.SWITCHROOM_VAULT_PASSPHRASE;
  if (vaultPass && deps.openVault && deps.saveVault) {
    await withRollback(async () => {
      const vaultPath = deps.resolveVaultPath!(config);
      if (_existsSync(vaultPath)) {
        const secrets = deps.openVault!(vaultPass, vaultPath);
        vaultKeysRenamed = findAgentVaultKeys(secrets, oldName, newName);
        if (Object.keys(vaultKeysRenamed).length > 0) {
          for (const [oldKey, newKey] of Object.entries(vaultKeysRenamed)) {
            secrets[newKey] = secrets[oldKey];
            delete secrets[oldKey];
          }
          deps.saveVault!(vaultPass, vaultPath, secrets);
          vaultUpdateApplied = true;
        }
      }
    });
  }

  // ── Step 7: Update switchroom.yaml ────────────────────────────────────────
  await withRollback(async () => {
    renameAgentInConfig(configPath, oldName, newName);
    yamlUpdated = true;
  });

  // ── Step 8: Reconcile (rewrites .mcp.json, settings.json, start.sh, etc.) ─
  // Reload config after yaml update
  config = deps.loadConfig(configPath);
  const newAgentConfig = config.agents[newName];
  if (!newAgentConfig) {
    await rollbackAll("yaml update did not produce new agent entry");
    throw new Error(
      `Internal: renamed agent "${oldName}" → "${newName}" in yaml but reload didn't pick it up.`,
    );
  }

  let reconcileChanges: string[] = [];
  await withRollback(async () => {
    const result = deps.reconcileAgent(
      newName,
      newAgentConfig,
      agentsDir,
      config.telegram,
      config,
      configPath,
    );
    reconcileChanges = result.changes;
  });

  // Reinstall schedule timers under new name
  const schedule = newAgentConfig.schedule ?? [];
  if (schedule.length > 0) {
    await withRollback(async () => {
      // Remove old timers first
      deps.installScheduleTimers(oldName, oldAgentDir, []);
      // Install new timers
      deps.installScheduleTimers(newName, newAgentDir, schedule);
      deps.daemonReload();
      deps.enableScheduleTimers(newName, schedule.length);
    });
  }

  // ── Step 9: Hindsight bank ────────────────────────────────────────────────
  // "preserve" (default) — no-op, old bank ID continues to work via
  // memory.collection in yaml (which is NOT renamed unless it was the
  // derived default equal to oldName, in which case yaml now says newName).
  //
  // "fresh" — clear the bank by resetting the collection field to newName
  // (already done by renameAgentInConfig when collection === oldName).
  //
  // "migrate" — out of scope for v1, deferred to a follow-up issue.
  // The hindsightMode parameter is accepted here so callers can validate it
  // (and we can surface an error for "migrate" rather than silently ignoring).
  if (hindsightMode === "fresh") {
    // fresh: memory.collection already set to newName by renameAgentInConfig.
    // Nothing more to do — the agent will create a new bank on first use.
  } else if (hindsightMode !== "preserve") {
    throw new Error(
      `Unsupported --hindsight mode: "${hindsightMode}". Valid values: preserve, fresh. ` +
        `"migrate" is deferred to a follow-up issue.`,
    );
  }

  // ── Step 10: Clean up snapshot and start <new> ────────────────────────────
  if (snapshotPath) {
    try { deps.removeDir!(snapshotPath); } catch { /* best effort */ }
  }

  deps.startAgent(newName);

  return {
    agentDir: newAgentDir,
    vaultKeysRenamed: Object.keys(vaultKeysRenamed),
    reconcileChanges,
  };
}
