/**
 * Cron-unit content-hash naming — RETIRED, kept for cleanup only.
 *
 * Originally introduced by #1163 (Phase D) to stabilise the filenames
 * of per-agent `telegram/cron-<sha12>.sh` scripts so an edit
 * deterministically renamed the on-disk file. Phase 4 cron-fold-in
 * (#890-#893) retired the `.sh`-generation path entirely — cron now
 * fires through the in-container `agent-scheduler` sibling via
 * `inject_inbound` IPC into the live session.
 *
 * This file survives only to provide the regexes (`CRON_SCRIPT_
 * BASENAME_RE` / `LEGACY_CRON_SCRIPT_BASENAME_RE`) the cleanup pass
 * in `scaffold.ts` uses to identify and delete stale on-disk
 * artifacts from prior installs. The hash helpers
 * (`cronUnitHash`/`cronUnitName`/`cronScriptFilename`) are still
 * exported because the test-suite uses them to compute expected
 * stale-file paths before asserting deletion.
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
