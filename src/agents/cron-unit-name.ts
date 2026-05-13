/**
 * Cron-unit content-hash naming (switchroom #1163, Phase D).
 *
 * Pre-Phase-D, each schedule entry materialised as
 * `telegram/cron-<index>.sh` — filename derived purely from declaration
 * order. Two failure modes:
 *
 *   1. Renames/reorders in `switchroom.yaml` shuffle the index → the
 *      file at `cron-0.sh` is now a different task. The Phase F
 *      hot-cron reloader sees that as content drift on a still-named
 *      file and can't tell "task replaced" from "prompt edited".
 *
 *   2. Index-based names give no source-of-origin signal. Phase B
 *      stamps overlay-loaded entries with the `OVERLAY_SOURCE`
 *      symbol, but downstream consumers (reconciler, audit) couldn't
 *      tell main-config from overlay once the script hit disk.
 *
 * Phase D switches to a content hash:
 * `cron-<sha256(cron + prompt)[:12]>.sh`. Scripts live under
 * `<agentDir>/telegram/`, already namespaced by filesystem, so the
 * agent name is intentionally NOT part of the hash input — two agents
 * with identical (cron, prompt) tuples produce the same basename in
 * their own dirs without collision.
 *
 * The hash is:
 *
 *   - deterministic — same inputs always produce the same filename;
 *   - collision-resistant — 48 bits across at most a few dozen entries
 *     per agent is overkill for the use case;
 *   - rename-safe — editing a prompt or cron expression deterministically
 *     renames the on-disk file, so F's reconciler sees "old file gone,
 *     new file appeared" instead of "file X drifted".
 *
 * Migration: `switchroom migrate cron-unit-names` performs a hard-cut
 * rename of any legacy `cron-<digits>.sh` files an agent dir still
 * carries. Idempotent — re-runs are no-ops once the rename has landed.
 * No systemd units are involved: switchroom cron runs as in-container
 * node-cron, so the migration is `.sh`-only.
 */
import { createHash } from "node:crypto";

/**
 * 12-hex-char content hash for a schedule entry. Length chosen to fit
 * comfortably in a unit-name segment while keeping collision odds
 * negligible at typical fleet sizes (<100 entries per agent).
 */
export function cronUnitHash(cron: string, prompt: string): string {
  return createHash("sha256")
    .update(cron)
    .update("\0")
    .update(prompt)
    .digest("hex")
    .slice(0, 12);
}

/**
 * Stable unit-name stem for a schedule entry. Returned without
 * extension so callers can append `.sh` (script) or `.source` (the
 * overlay attribution sidecar).
 */
export function cronUnitName(cron: string, prompt: string): string {
  return `cron-${cronUnitHash(cron, prompt)}`;
}

/**
 * Filename used on disk under `<agentDir>/telegram/`.
 */
export function cronScriptFilename(cron: string, prompt: string): string {
  return `${cronUnitName(cron, prompt)}.sh`;
}

/**
 * Regex matching cron-script basenames under the new scheme. Used by
 * the reconcile cleanup pass and by `classifyChangeKind`.
 */
export const CRON_SCRIPT_BASENAME_RE = /^cron-[0-9a-f]{12}\.sh$/;

/**
 * Regex matching the legacy index-based scheme. Used by the migration
 * command to find files that still need renaming.
 */
export const LEGACY_CRON_SCRIPT_BASENAME_RE = /^cron-(\d+)\.sh$/;

/**
 * Either-scheme matcher — used by `classifyChangeKind` during the
 * brief period in which an unmigrated host still has legacy filenames
 * on disk. After `switchroom migrate cron-unit-names` runs, only the
 * new scheme remains; the legacy clause is kept as a belt-and-braces
 * defence rather than a supported coexistence mode.
 */
export const CRON_SCRIPT_BASENAME_ANY_RE = /^cron-(?:\d+|[0-9a-f]{12})\.sh$/;
