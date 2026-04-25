/**
 * Registry: atomic read/write of ~/.switchroom/worktrees/<id>.json records.
 *
 * Each file is a single WorktreeRecord. One file per claim.
 * We write to a temp file then rename (atomic on POSIX).
 */

import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  existsSync,
  renameSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import type { WorktreeRecord } from "./types.js";

/** Base directory for all worktree registry records. */
export function registryDir(): string {
  return resolve(
    process.env.SWITCHROOM_WORKTREE_DIR ?? join(homedir(), ".switchroom", "worktrees"),
  );
}

/** Path to the registry record for a given claim id. */
export function recordPath(id: string): string {
  return join(registryDir(), `${id}.json`);
}

/** Ensure the registry directory exists. */
function ensureDir(): void {
  mkdirSync(registryDir(), { recursive: true });
}

/**
 * Write a worktree record atomically.
 * The record is written to a temp file and then renamed so that readers
 * never see a half-written file.
 */
export function writeRecord(record: WorktreeRecord): void {
  ensureDir();
  const target = recordPath(record.id);
  const tmp = `${target}.tmp${process.pid}`;
  writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, target);
}

/**
 * Read a single worktree record. Returns null if missing or unparseable.
 */
export function readRecord(id: string): WorktreeRecord | null {
  const path = recordPath(id);
  try {
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw) as WorktreeRecord;
  } catch {
    return null;
  }
}

/**
 * Remove a worktree record file.
 */
export function deleteRecord(id: string): void {
  const path = recordPath(id);
  try {
    unlinkSync(path);
  } catch {
    /* best-effort */
  }
}

/**
 * Enumerate all records in the registry.
 */
export function listRecords(): WorktreeRecord[] {
  ensureDir();
  const dir = registryDir();
  const records: WorktreeRecord[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue;
    const id = entry.slice(0, -5); // strip ".json"
    const rec = readRecord(id);
    if (rec) records.push(rec);
  }
  return records;
}

/**
 * Update the heartbeat timestamp for a claim.
 * No-op if the record doesn't exist.
 */
export function touchHeartbeat(id: string): void {
  const rec = readRecord(id);
  if (!rec) return;
  writeRecord({ ...rec, heartbeatAt: new Date().toISOString() });
}

/**
 * Count active records for a given repo path.
 */
export function countByRepo(repoPath: string): number {
  return listRecords().filter(r => r.repo === repoPath).length;
}

/** Check if a record file exists */
export function recordExists(id: string): boolean {
  return existsSync(recordPath(id));
}
