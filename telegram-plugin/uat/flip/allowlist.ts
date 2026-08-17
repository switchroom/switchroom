/**
 * Allowlist add/remove helper for the Memory v2 M3 directive-flip UAT.
 *
 * The flip UAT needs a throwaway probe user temporarily on an agent's DM
 * allowlist so the (later) Tier-2 mtcute probe can talk to it, then removed
 * again with zero residue — even if the runner crashes mid-flight. This module
 * is that add/remove half, and NOTHING else: it does not run probes, flip
 * agents, or touch bank state.
 *
 * The file it edits is `~/.switchroom/agents/<agent>/telegram/access.json` —
 * the gateway's DM allowlist (`allowFrom: string[]`, see
 * `telegram-plugin/gateway/access-store.ts`). Two invariants make it
 * crash-safe:
 *
 *   1. WHOLE-OBJECT parse → modify → serialize, written atomically (temp file
 *      + `rename`), mode 0600. We never hand-edit a field in place, so a
 *      concurrent gateway reader never sees a half-written file and no sibling
 *      key (`groups`, `pending`, telegram feature flags) is dropped.
 *
 *   2. A sidecar RECEIPT (`access.json.uat-allowlist-receipt.json`) is written
 *      BEFORE `access.json` is mutated on `add`. The receipt records whether
 *      the id was already present (`preexisting`) and a +4h `expiresAt`. Revert
 *      is driven off the receipt, so:
 *        - `remove` reverts iff a receipt exists AND `preexisting` was false
 *          (an id the UAT itself added). If the id was already there before the
 *          UAT touched it, revert leaves it and just clears the receipt.
 *        - `remove --sweep` scans every agent dir and reverts any receipt it
 *          finds — the idempotent crash-recovery path. `--sweep --expired`
 *          restricts that to receipts past their `expiresAt`.
 *
 * Because the receipt is the source of truth for "did WE add this", the tool
 * is safe to run repeatedly: a second `add` for an id already added is a no-op
 * that leaves the original receipt (and its original `addedAt`) intact, and a
 * `remove`/`sweep` with no receipt does nothing.
 */

import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Default allowlist TTL: the probe window before a sweep should reclaim. */
export const DEFAULT_TTL_MS = 4 * 60 * 60 * 1000; // 4h

/** The sidecar receipt written next to access.json. */
export interface AllowlistReceipt {
  agent: string;
  userId: string;
  /** ISO timestamp the receipt was written (the add moment). */
  addedAt: string;
  /** ISO timestamp after which a `--sweep --expired` will reclaim this id. */
  expiresAt: string;
  /** True when `userId` was ALREADY on the allowlist before the UAT ran — in
   *  that case revert must NOT remove it. */
  preexisting: boolean;
}

/** Minimal shape of access.json we touch. All other keys pass through
 *  untouched via the parsed object (we serialize the whole thing). */
interface AccessFile {
  allowFrom?: string[];
  [k: string]: unknown;
}

export interface AllowlistDeps {
  /** Root agents dir. Defaults to `~/.switchroom/agents`. Injected in tests. */
  agentsDir?: string;
  /** Clock seam for deterministic tests. */
  now?: () => number;
  /** TTL override (ms) for the receipt `expiresAt`. */
  ttlMs?: number;
}

export interface AddResult {
  agent: string;
  userId: string;
  /** True when this call actually appended the id. */
  added: boolean;
  /** True when the id was already on the allowlist before this call. */
  preexisting: boolean;
  receiptPath: string;
}

export interface RemoveResult {
  agent: string;
  userId: string | null;
  /** True when the id was removed from the allowlist by this call. */
  reverted: boolean;
  /** Why nothing was reverted, when `reverted` is false. */
  reason?: "no-receipt" | "preexisting" | "not-present";
  receiptCleared: boolean;
}

function resolveAgentsDir(deps: AllowlistDeps): string {
  return deps.agentsDir ?? join(homedir(), ".switchroom", "agents");
}

/** Absolute path to an agent's access.json. */
export function accessFilePath(agentsDir: string, agent: string): string {
  return join(agentsDir, agent, "telegram", "access.json");
}

/** Absolute path to an agent's UAT allowlist receipt. */
export function receiptPath(agentsDir: string, agent: string): string {
  return accessFilePath(agentsDir, agent) + ".uat-allowlist-receipt.json";
}

/** Read + parse access.json, or `{}` when absent. Throws on malformed JSON —
 *  the UAT must NOT silently clobber a file it can't parse. */
function readAccess(path: string): AccessFile {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as AccessFile;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`access.json at ${path} is not a JSON object`);
  }
  return parsed;
}

/** Atomic whole-object write: temp file + rename, mode 0600, dir 0700. */
function atomicWriteJson(path: string, value: unknown): void {
  const dir = join(path, "..");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

function readReceipt(path: string): AllowlistReceipt | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as AllowlistReceipt;
  } catch {
    return null;
  }
}

/**
 * Add `userId` to `<agent>`'s DM allowlist, writing the receipt FIRST.
 *
 * Crash-safety ordering: the receipt lands before access.json is mutated, so a
 * crash between the two leaves a receipt whose `preexisting` correctly records
 * the pre-mutation state — a later sweep reverts exactly what it should.
 *
 * Idempotent: if a receipt already exists for this agent (a prior add), this is
 * a no-op that preserves the original receipt (and its `preexisting`/`addedAt`),
 * so a double-add can't overwrite the truth about whether WE added the id.
 */
export function addToAllowlist(agent: string, userId: string, deps: AllowlistDeps = {}): AddResult {
  const agentsDir = resolveAgentsDir(deps);
  const nowMs = (deps.now ?? Date.now)();
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  const accessPath = accessFilePath(agentsDir, agent);
  const rcptPath = receiptPath(agentsDir, agent);

  const access = readAccess(accessPath);
  const allowFrom = Array.isArray(access.allowFrom) ? access.allowFrom.map(String) : [];
  const preexisting = allowFrom.includes(userId);

  const existingReceipt = readReceipt(rcptPath);
  if (existingReceipt) {
    // A prior add already recorded the truth — do not re-mutate or re-stamp.
    return {
      agent,
      userId,
      added: false,
      preexisting: existingReceipt.preexisting,
      receiptPath: rcptPath,
    };
  }

  // Receipt FIRST, before any mutation — the crash-safety invariant.
  const receipt: AllowlistReceipt = {
    agent,
    userId,
    addedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + ttlMs).toISOString(),
    preexisting,
  };
  atomicWriteJson(rcptPath, receipt);

  if (preexisting) {
    // Already allowlisted — nothing to add, receipt records preexisting:true.
    return { agent, userId, added: false, preexisting: true, receiptPath: rcptPath };
  }

  access.allowFrom = [...allowFrom, userId];
  atomicWriteJson(accessPath, access);
  return { agent, userId, added: true, preexisting: false, receiptPath: rcptPath };
}

/**
 * Revert an agent's allowlist add. Only removes the id when a receipt exists
 * AND `preexisting` was false; always clears the receipt when one exists.
 */
export function removeFromAllowlist(agent: string, deps: AllowlistDeps = {}): RemoveResult {
  const agentsDir = resolveAgentsDir(deps);
  const accessPath = accessFilePath(agentsDir, agent);
  const rcptPath = receiptPath(agentsDir, agent);

  const receipt = readReceipt(rcptPath);
  if (!receipt) {
    return { agent, userId: null, reverted: false, reason: "no-receipt", receiptCleared: false };
  }

  // Clear the receipt regardless of the branch below — it is single-use.
  const clearReceipt = () => {
    rmSync(rcptPath, { force: true });
  };

  if (receipt.preexisting) {
    // The id was there before the UAT — leave the allowlist, drop the receipt.
    clearReceipt();
    return {
      agent,
      userId: receipt.userId,
      reverted: false,
      reason: "preexisting",
      receiptCleared: true,
    };
  }

  const access = readAccess(accessPath);
  const allowFrom = Array.isArray(access.allowFrom) ? access.allowFrom.map(String) : [];
  if (!allowFrom.includes(receipt.userId)) {
    // Already gone (idempotent re-run) — just clear the receipt.
    clearReceipt();
    return {
      agent,
      userId: receipt.userId,
      reverted: false,
      reason: "not-present",
      receiptCleared: true,
    };
  }

  access.allowFrom = allowFrom.filter((id) => id !== receipt.userId);
  atomicWriteJson(accessPath, access);
  clearReceipt();
  return { agent, userId: receipt.userId, reverted: true, receiptCleared: true };
}

export interface SweepOptions extends AllowlistDeps {
  /** When true, only revert receipts whose `expiresAt` is in the past. */
  expiredOnly?: boolean;
}

/**
 * Scan every agent dir under `agentsDir` and revert any UAT allowlist receipt.
 * Idempotent — safe to run on a clean fleet (returns an empty result set). With
 * `expiredOnly`, only receipts past their `expiresAt` are reverted.
 */
export function sweepAllowlist(opts: SweepOptions = {}): RemoveResult[] {
  const agentsDir = resolveAgentsDir(opts);
  const nowMs = (opts.now ?? Date.now)();
  const results: RemoveResult[] = [];
  if (!existsSync(agentsDir)) return results;

  for (const entry of readdirSync(agentsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const agent = entry.name;
    const rcptPath = receiptPath(agentsDir, agent);
    const receipt = readReceipt(rcptPath);
    if (!receipt) continue;
    if (opts.expiredOnly) {
      const expiresMs = Date.parse(receipt.expiresAt);
      if (!Number.isNaN(expiresMs) && expiresMs > nowMs) continue; // not yet expired
    }
    results.push(removeFromAllowlist(agent, opts));
  }
  return results;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage(): string {
  return [
    "usage: allowlist <command> [args]",
    "",
    "  add <agent> <userId>      add userId to <agent>'s DM allowlist (writes receipt first)",
    "  remove <agent>            revert the receipted add for <agent>",
    "  remove --sweep            revert every agent's receipt (idempotent)",
    "  remove --sweep --expired  revert only receipts past their expiresAt",
    "",
    "  --agents-dir <path>       override the agents root (default ~/.switchroom/agents)",
  ].join("\n");
}

/** Parse argv (sans node/script) and dispatch. Returns process exit code.
 *  Exported for direct unit testing of the arg surface. */
export function runAllowlistCli(argv: string[]): number {
  const args = [...argv];
  let agentsDir: string | undefined;
  const dirIdx = args.indexOf("--agents-dir");
  if (dirIdx !== -1) {
    agentsDir = args[dirIdx + 1];
    args.splice(dirIdx, 2);
  }
  const deps: AllowlistDeps = agentsDir ? { agentsDir } : {};

  const cmd = args[0];
  if (cmd === "add") {
    const [, agent, userId] = args;
    if (!agent || !userId) {
      process.stderr.write("add requires <agent> <userId>\n" + usage() + "\n");
      return 1;
    }
    const r = addToAllowlist(agent, userId, deps);
    process.stdout.write(JSON.stringify(r) + "\n");
    return 0;
  }
  if (cmd === "remove") {
    if (args.includes("--sweep")) {
      const expiredOnly = args.includes("--expired");
      const rs = sweepAllowlist({ ...deps, expiredOnly });
      process.stdout.write(JSON.stringify(rs) + "\n");
      return 0;
    }
    const agent = args[1];
    if (!agent) {
      process.stderr.write("remove requires <agent> (or --sweep)\n" + usage() + "\n");
      return 1;
    }
    const r = removeFromAllowlist(agent, deps);
    process.stdout.write(JSON.stringify(r) + "\n");
    return 0;
  }

  process.stderr.write(usage() + "\n");
  return cmd ? 1 : 0;
}

// Direct-exec entry (bun/node run this file). Guarded so imports don't run it.
if (
  typeof process !== "undefined" &&
  process.argv[1] &&
  (process.argv[1].endsWith("allowlist.ts") || process.argv[1].endsWith("allowlist.js"))
) {
  process.exit(runAllowlistCli(process.argv.slice(2)));
}
