/**
 * Session JSONL retention (issue #2792 item A).
 *
 * Claude Code stores one JSONL transcript per session under
 * `$CLAUDE_CONFIG_DIR/projects/<sanitized-cwd>/`. Nothing ever prunes
 * them, so a long-lived always-on agent's `.claude/projects` grows
 * monotonically — a slow-burn contributor to the fleet-wide disk-full
 * failure mode. This module bounds that growth by age and count.
 *
 * Safety contract — retention must never strip a transcript that is
 * still needed for correctness:
 *   - The handoff-briefing consumer (see handoff-summarizer.ts) reads the
 *     *newest* JSONL to build `.handoff.md`. We NEVER delete the file the
 *     caller marks as `keepPath`, and we always keep at least the newest
 *     `minKeep` sessions regardless of age.
 *   - Deletion is best-effort and never throws: a Stop hook that fails to
 *     prune must not block agent shutdown. Errors are reported to the
 *     caller's `onWarn` sink (stderr in production).
 *
 * Both thresholds are configurable via the config cascade under
 * `session_continuity` (shallow per-key merge, agent wins) —
 * `session_retention_max_count` and `session_retention_max_age_days`.
 */

import {
  existsSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";

/** Default: keep the newest 20 session transcripts. */
export const DEFAULT_SESSION_RETENTION_MAX_COUNT = 20;
/** Default: delete session transcripts older than 30 days. */
export const DEFAULT_SESSION_RETENTION_MAX_AGE_DAYS = 30;
/**
 * Floor on how many newest sessions are always retained regardless of
 * age — guarantees the handoff source (and a little history) survives
 * even a very idle agent whose only transcripts are all "old".
 */
const MIN_KEEP = 2;

export interface SessionRetentionOptions {
  /**
   * Keep at most this many newest session JSONL files. Older ones beyond
   * this count are eligible for deletion. `undefined`/`0` disables the
   * count bound.
   */
  maxCount?: number;
  /**
   * Delete session JSONL files whose mtime is older than this many days.
   * `undefined`/`0` disables the age bound.
   */
  maxAgeDays?: number;
  /**
   * Absolute path to a JSONL that must never be deleted (the file the
   * handoff briefing was just built from). Optional.
   */
  keepPath?: string;
  /** Warning sink. Defaults to stderr. */
  onWarn?: (msg: string) => void;
  /** Injectable clock for tests (ms epoch). Defaults to Date.now. */
  now?: () => number;
}

export interface SessionRetentionResult {
  /** Number of JSONL files deleted. */
  deleted: number;
  /** Number of JSONL files scanned. */
  scanned: number;
}

interface JsonlFile {
  path: string;
  mtime: number;
}

/**
 * Collect every session JSONL under `<claudeConfigDir>/projects`,
 * newest first. Never throws — unreadable dirs/files are skipped.
 */
function collectSessionJsonl(claudeConfigDir: string): JsonlFile[] {
  const projects = join(claudeConfigDir, "projects");
  if (!existsSync(projects)) return [];
  const found: JsonlFile[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
        continue;
      }
      if (!name.endsWith(".jsonl")) continue;
      found.push({ path: full, mtime: st.mtimeMs });
    }
  };
  walk(projects);
  // Newest first.
  found.sort((a, b) => b.mtime - a.mtime);
  return found;
}

/**
 * Prune old session JSONL transcripts for one agent, bounding growth by
 * count and age while never deleting the handoff source or the newest
 * `MIN_KEEP` sessions. Best-effort and non-throwing.
 */
export function pruneSessionJsonl(
  claudeConfigDir: string,
  opts: SessionRetentionOptions = {},
): SessionRetentionResult {
  const onWarn =
    opts.onWarn ?? ((msg: string) => process.stderr.write(`${msg}\n`));
  const now = opts.now ?? Date.now;

  const maxCount =
    opts.maxCount && opts.maxCount > 0 ? opts.maxCount : undefined;
  const maxAgeDays =
    opts.maxAgeDays && opts.maxAgeDays > 0 ? opts.maxAgeDays : undefined;

  // Nothing to do if both bounds are disabled.
  if (maxCount === undefined && maxAgeDays === undefined) {
    return { deleted: 0, scanned: 0 };
  }

  const files = collectSessionJsonl(claudeConfigDir);
  const ageCutoff =
    maxAgeDays !== undefined
      ? now() - maxAgeDays * 24 * 60 * 60 * 1000
      : undefined;

  // Never delete below the MIN_KEEP newest, and honor a larger maxCount.
  const keepNewest = Math.max(MIN_KEEP, maxCount ?? 0);

  let deleted = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    // Index < keepNewest → protected as one of the newest sessions.
    if (i < keepNewest) continue;
    // Never delete the explicit keepPath (the handoff source).
    if (opts.keepPath && f.path === opts.keepPath) continue;

    // A file survives the count bound only if it is ALSO young enough
    // under the age bound. If the age bound is disabled, everything past
    // keepNewest is over-count and eligible. If the count bound is
    // disabled, only age decides.
    let eligible = false;
    if (maxCount !== undefined && i >= keepNewest) {
      // Over the count limit. Still, if an age bound exists and the file
      // is young, keep it — age is the more conservative signal.
      if (ageCutoff === undefined || f.mtime < ageCutoff) {
        eligible = true;
      }
    } else if (ageCutoff !== undefined && f.mtime < ageCutoff) {
      eligible = true;
    }

    if (!eligible) continue;

    try {
      unlinkSync(f.path);
      deleted++;
    } catch (err) {
      onWarn(
        `session-retention: could not delete ${f.path}: ${
          (err as Error).message
        }`,
      );
    }
  }

  return { deleted, scanned: files.length };
}
