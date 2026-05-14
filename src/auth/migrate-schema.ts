/**
 * In-place YAML upgrade from the pre-RFC-H per-agent auth schema to the
 * RFC H fleet-wide model (see docs/rfcs/auth-broker.md §6).
 *
 * Algorithm:
 *   1. Detect legacy shape — any agent has `auth.accounts: […]` or
 *      `auth_label: "…"`.
 *   2. Build a histogram of `agent.auth.accounts[0]` (the primary) across
 *      every agent.
 *   3. Uniform fleet (one distinct primary) → lift to
 *      `auth.active = <primary>`, set `auth.fallback_order` to the
 *      first-seen union of every agent's `auth.accounts[*]`. No agents
 *      get `override:`.
 *   4. Divergent fleet (multiple primaries) → LOUD warning, lift the
 *      most-common primary to `auth.active`, synthesise
 *      `agent.auth.override: <primary>` for every agent whose primary
 *      differs from the chosen fleet active. Per-agent fallback ordering
 *      AND tail accounts are LOST (the new schema can't express either).
 *   5. Strip every agent's `auth_label:` and `auth.accounts:` fields.
 *   6. Append a trailing comment marking the upgrade.
 *   7. Write the result atomically; back the pre-upgrade YAML up to
 *      `<configPath>.pre-auth-broker`.
 *
 * Idempotent on re-run: detection short-circuits when neither legacy
 * field is present anywhere.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import {
  parseDocument,
  isMap,
  isSeq,
  isScalar,
  type Document,
  type YAMLMap,
} from "yaml";

import { atomicWriteFileSync } from "../util/atomic.js";

/** What the migrator reports about a single run, for tests + logging. */
export interface MigrationReport {
  /** Whether anything in the YAML needed migrating. */
  migrated: boolean;
  /** Fleet-wide active account chosen (only set when migrated). */
  active?: string;
  /** First-seen union of every agent's auth.accounts (only set when migrated). */
  fallbackOrder?: string[];
  /** Agents that ended up with `auth.override:` synthesised. */
  overriddenAgents: string[];
  /** True iff the fleet was divergent (multiple distinct primaries). */
  divergent: boolean;
  /** Path to the pre-upgrade backup, when written. */
  backupPath?: string;
  /** Warnings collected during the run (printed to stderr by the caller). */
  warnings: string[];
}

export interface MigrateOptions {
  /** Override Date.now()-as-string-formatter for deterministic tests. */
  now?: () => string;
  /** Stderr sink for warnings (defaults to process.stderr.write). */
  warn?: (msg: string) => void;
}

/**
 * Run the migration against an in-memory YAML string. Pure function:
 * returns the rewritten YAML and a report. Does not write to disk.
 *
 * Used directly by tests and by `migrateAuthSchemaFile` (which adds the
 * file IO + backup step).
 */
export function migrateAuthSchema(
  yamlText: string,
  opts: MigrateOptions = {},
): { yaml: string; report: MigrationReport } {
  const now = opts.now ?? (() => new Date().toISOString().slice(0, 10));
  const warn = opts.warn ?? ((m: string) => process.stderr.write(m));

  const doc = parseDocument(yamlText);
  const root = doc.contents;
  if (!isMap(root)) {
    return { yaml: yamlText, report: emptyReport() };
  }

  const agentsNode = root.get("agents", true);
  if (!isMap(agentsNode)) {
    return { yaml: yamlText, report: emptyReport() };
  }

  // Walk agents, collect legacy state. Names ordered by first appearance
  // in the YAML so the union below is stable.
  interface AgentLegacy {
    name: string;
    accounts: string[];
    authLabel?: string;
    node: YAMLMap;
  }
  const legacy: AgentLegacy[] = [];
  let needsMigration = false;
  for (const item of agentsNode.items) {
    if (!isScalar(item.key) && typeof item.key !== "string") continue;
    const name = isScalar(item.key) ? String(item.key.value) : String(item.key);
    const agentNode = item.value;
    if (!isMap(agentNode)) continue;

    let accounts: string[] = [];
    let authLabel: string | undefined;

    const authNode = agentNode.get("auth", true);
    if (isMap(authNode)) {
      const accountsNode = authNode.get("accounts", true);
      if (isSeq(accountsNode)) {
        accounts = accountsNode.items
          .map((n) => (isScalar(n) ? String(n.value) : null))
          .filter((s): s is string => typeof s === "string" && s.length > 0);
        if (accounts.length > 0) needsMigration = true;
      }
    }

    const authLabelNode = agentNode.get("auth_label", true);
    if (isScalar(authLabelNode) && typeof authLabelNode.value === "string") {
      authLabel = authLabelNode.value;
      needsMigration = true;
    }

    legacy.push({ name, accounts, authLabel, node: agentNode });
  }

  if (!needsMigration) {
    return { yaml: yamlText, report: emptyReport() };
  }

  // Build the histogram of primaries.
  const primaryCounts = new Map<string, number>();
  const firstSeenOrder: string[] = [];
  for (const a of legacy) {
    if (a.accounts.length === 0) continue;
    const primary = a.accounts[0];
    primaryCounts.set(primary, (primaryCounts.get(primary) ?? 0) + 1);
    if (!firstSeenOrder.includes(primary)) firstSeenOrder.push(primary);
  }

  // First-seen union across every agent's auth.accounts[*].
  const unionOrder: string[] = [];
  for (const a of legacy) {
    for (const label of a.accounts) {
      if (!unionOrder.includes(label)) unionOrder.push(label);
    }
  }

  if (primaryCounts.size === 0) {
    // Only legacy auth_label fields present; nothing to lift into fleet
    // active. Just strip the dead fields.
    stripLegacyFields(legacy);
    appendMigrationComment(doc, now());
    return {
      yaml: serializeDoc(doc),
      report: {
        migrated: true,
        overriddenAgents: [],
        divergent: false,
        warnings: [],
      },
    };
  }

  // Pick the most-common primary. Tiebreak: first-seen order in the
  // YAML (matches RFC §6 wording).
  let active: string = firstSeenOrder[0];
  let bestCount = primaryCounts.get(active) ?? 0;
  for (const candidate of firstSeenOrder) {
    const c = primaryCounts.get(candidate) ?? 0;
    if (c > bestCount) {
      active = candidate;
      bestCount = c;
    }
  }

  const divergent = primaryCounts.size > 1;
  const overriddenAgents: string[] = [];
  const warnings: string[] = [];

  if (divergent) {
    const w =
      `\n  WARN: divergent per-agent auth.accounts[0] detected across ${legacy.length} agents.\n` +
      `        Lifting "${active}" to fleet-active. The new schema\n` +
      `        loses TWO things from the old per-agent lists:\n` +
      `          1. Per-agent fallback ORDERING (each agent had its own\n` +
      `             priority list — the new schema only supports one\n` +
      `             global fallback_order; first-seen-union order is\n` +
      `             used).\n` +
      `          2. Per-agent fallback TAIL (each agent's accounts[1:]\n` +
      `             list is dropped except for the override target —\n` +
      `             agents with override:X no longer have a documented\n` +
      `             fallback to whatever they used to list after X).\n` +
      `        Agents whose primary differed from the fleet-active have\n` +
      `        been pinned via 'auth.override:'.\n`;
    warn(w + "\n");
    warnings.push(w);
  }

  // Build top-level auth: block (preserve existing one if present).
  doc.setIn(["auth", "active"], active);
  // Only emit fallback_order when there's more than one account in the
  // union — a single-account fleet doesn't need cycling and the empty/
  // single-entry sequence is noise.
  if (unionOrder.length > 1) {
    doc.setIn(["auth", "fallback_order"], unionOrder);
  }

  // Synthesize per-agent override for divergent primaries.
  for (const a of legacy) {
    if (a.accounts.length === 0) continue;
    const primary = a.accounts[0];
    if (primary === active) continue;
    doc.setIn(["agents", a.name, "auth", "override"], primary);
    overriddenAgents.push(a.name);
  }

  // Strip the dead per-agent fields.
  stripLegacyFields(legacy);

  appendMigrationComment(doc, now());

  return {
    yaml: serializeDoc(doc),
    report: {
      migrated: true,
      active,
      fallbackOrder: unionOrder,
      overriddenAgents,
      divergent,
      warnings,
    },
  };
}

/**
 * File-IO wrapper: reads, migrates, writes — and backs the original up.
 *
 * The backup path is `<configPath>.pre-auth-broker`; a second migration
 * pass after the backup already exists does NOT overwrite it (we keep
 * the original pre-upgrade snapshot, not the most-recent intermediate).
 *
 * Idempotent: when no legacy fields are present, returns `migrated:
 * false` without writing anything.
 */
export function migrateAuthSchemaFile(
  configPath: string,
  opts: MigrateOptions = {},
): MigrationReport {
  if (!existsSync(configPath)) {
    throw new Error(`migrate-schema: config file not found: ${configPath}`);
  }
  const before = readFileSync(configPath, "utf-8");
  const { yaml: after, report } = migrateAuthSchema(before, opts);
  if (!report.migrated) {
    return report;
  }
  const backupPath = `${configPath}.pre-auth-broker`;
  if (!existsSync(backupPath)) {
    // Preserve the original file mode (config files are typically 0644).
    let mode = 0o644;
    try {
      mode = statSync(configPath).mode & 0o777;
    } catch { /* default */ }
    atomicWriteFileSync(backupPath, before, mode);
  }
  // Same mode for the rewritten file.
  let mode = 0o644;
  try {
    mode = statSync(configPath).mode & 0o777;
  } catch { /* default */ }
  atomicWriteFileSync(configPath, after, mode);
  return { ...report, backupPath };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function emptyReport(): MigrationReport {
  return {
    migrated: false,
    overriddenAgents: [],
    divergent: false,
    warnings: [],
  };
}

function stripLegacyFields(
  legacy: ReadonlyArray<{
    accounts: string[];
    authLabel?: string;
    node: YAMLMap;
  }>,
): void {
  for (const a of legacy) {
    if (a.authLabel !== undefined) {
      a.node.delete("auth_label");
    }
    const authNode = a.node.get("auth", true);
    if (isMap(authNode)) {
      authNode.delete("accounts");
      // If the auth: block is now empty, drop it entirely so the
      // post-migration YAML doesn't carry a stale empty block.
      if (authNode.items.length === 0) {
        a.node.delete("auth");
      }
    }
  }
}

function appendMigrationComment(doc: Document, dateStr: string): void {
  // YAML library renders this as a trailing comment on the document.
  const existing = doc.commentBefore ?? "";
  const marker = ` upgraded by auth-broker migration on ${dateStr}`;
  // Avoid duplicate markers on a re-run (idempotent).
  if (existing.includes("upgraded by auth-broker migration on")) return;
  // Use `comment` (trailing) so a re-emit puts it at the end of the file.
  const before = doc.comment ?? "";
  doc.comment = before.length > 0 ? `${before}\n${marker}` : marker;
}

function serializeDoc(doc: Document): string {
  // `yaml` serialises with no trailing newline by default; ensure one
  // so the output looks like every other YAML file in the repo.
  const out = String(doc);
  return out.endsWith("\n") ? out : out + "\n";
}

/** Probe-only helper: does this YAML need migration? Used by tests + apply. */
export function isLegacyAuthSchema(yamlText: string): boolean {
  const doc = parseDocument(yamlText);
  const root = doc.contents;
  if (!isMap(root)) return false;
  const agentsNode = root.get("agents", true);
  if (!isMap(agentsNode)) return false;
  for (const item of agentsNode.items) {
    const agentNode = item.value;
    if (!isMap(agentNode)) continue;
    if (agentNode.has("auth_label")) return true;
    const authNode = agentNode.get("auth", true);
    if (isMap(authNode) && authNode.has("accounts")) return true;
  }
  return false;
}

