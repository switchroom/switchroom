/**
 * Disk-headroom doctor probe.
 *
 * ## Why this exists
 *
 * On 2026-08-15 the reference fleet's root filesystem reached 85% full — 41
 * stale git checkouts under agent homes plus tens of gigabytes of package
 * caches — and it was found only because a human went looking. `switchroom
 * doctor` was no help: it names "disk full" in half a dozen *error strings*
 * (doctor.ts:1999, :2367, :2417 …) as an explanation for some other failure,
 * and never measures free space anywhere. A monitor that can only describe
 * the condition after something else breaks is not a monitor.
 *
 * ## What it measures, and against which filesystem
 *
 * The filesystem holding the **agents directory** (`switchroom.agents_dir`,
 * resolved by `resolveAgentsDir`), because that is where agent homes — and
 * therefore the checkouts and caches that actually fill a fleet host — live.
 * Deliberately NOT `/`: an operator who moved `~/.switchroom` onto a second
 * device would otherwise be told about a filesystem nothing writes to.
 *
 * When the scratch feature (#4723) is engaged, its bulk volume gets its own
 * row — the caches were relocated there precisely so they could grow, and a
 * full bulk device breaks every `npm install` in the fleet. The row is
 * omitted entirely when the volume is absent, which is the same silent
 * degradation `scratchVolumeAvailable` gives the compose generator.
 *
 * ## Why percentages are computed the way `df` computes them
 *
 * `df`'s capacity column is `used / (used + available)`, NOT `used / total` —
 * the difference is the root-reserved blocks (5% on a default ext4), and on a
 * 100 GB filesystem that is a 5-point discrepancy in exactly the range these
 * thresholds fire in. Reporting a number an operator cannot reproduce with
 * `df -h` would make the check untrustworthy the first time someone checked.
 *
 * ## The reap-sweep row
 *
 * #4724 shipped `switchroom worktree reap-report --append <file>` as a
 * cron-friendly, structurally delete-incapable evidence pass, and
 * `docs/operators/worktree-gc.md` documents a crontab line for it. Nothing
 * verifies that the crontab line was ever added — the same "a doc that has to
 * be obeyed is not a mechanism" trap `src/hindsight-watch/install-cron.ts`
 * was written to close.
 *
 * This probe closes it by OUTCOME rather than by mechanism: it reads the
 * newest record in the evidence log and reports how long ago the sweep ran.
 * An operator crontab, an `/etc/cron.d` fragment and a systemd timer all
 * satisfy it identically, and none of them can satisfy it by existing while
 * silently failing every tick.
 *
 * Read-only throughout. This module imports no reclaim primitive, spawns
 * nothing, and writes nothing.
 */

import { closeSync, fstatSync, openSync, readSync, statfsSync, statSync } from "node:fs";
import { dirname } from "node:path";

import { resolveAgentsDir } from "../config/loader.js";
import { resolveScratchConfig, scratchVolumeAvailable } from "../agents/scratch.js";
import type { SwitchroomConfig } from "../config/schema.js";
import type { CheckStatus } from "./doctor-status.js";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail?: string;
  fix?: string;
}

/** The subset of `node:fs` `StatsFs` this module needs. */
export interface StatfsLike {
  /** Block size in bytes. */
  bsize: number;
  /** Total data blocks. */
  blocks: number;
  /** Free blocks available to an unprivileged user. */
  bavail: number;
  /** Free blocks, including the root-reserved pool. */
  bfree: number;
}

export interface FsUsage {
  totalBytes: number;
  freeBytes: number;
  /** Used percentage, 0..100, computed the way `df` computes capacity. */
  usedPct: number;
}

export interface DiskThresholds {
  warnPct: number;
  failPct: number;
}

export const DEFAULT_DISK_THRESHOLDS: DiskThresholds = { warnPct: 80, failPct: 90 };

/**
 * Blocks → bytes, plus the `df` capacity percentage.
 *
 * `usedPct` uses `used / (used + bavail)`; see the module docblock for why
 * that and not `used / blocks`. A filesystem reporting zero total blocks
 * (some pseudo-filesystems do) reports 0% rather than dividing by zero.
 */
export function usageFromStatfs(s: StatfsLike): FsUsage {
  const bsize = s.bsize > 0 ? s.bsize : 0;
  const totalBytes = Math.max(0, s.blocks) * bsize;
  const freeBytes = Math.max(0, s.bavail) * bsize;
  const usedBlocks = Math.max(0, s.blocks - s.bfree);
  const denom = usedBlocks + Math.max(0, s.bavail);
  const usedPct = denom > 0 ? (usedBlocks / denom) * 100 : 0;
  return { totalBytes, freeBytes, usedPct };
}

/** Human-readable bytes, base-1024, matching `df -h`'s unit letters. */
export function fmtBytes(n: number): string {
  const units = ["B", "K", "M", "G", "T", "P"];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  return u === 0 ? `${Math.round(v)}B` : `${v.toFixed(1)}${units[u]}`;
}

/**
 * Nearest existing ancestor of `path`, or null when even the root is gone.
 *
 * `statfsSync` throws ENOENT on a path that does not exist, and the agents
 * directory legitimately does not exist yet on a host that has never run
 * `switchroom apply`. Walking up answers the question the operator actually
 * asked — "how much room is there where this will be created" — instead of
 * failing the check over a missing directory.
 */
export function nearestExistingPath(
  path: string,
  exists: (p: string) => boolean = (p) => {
    try {
      statSync(p);
      return true;
    } catch {
      return false;
    }
  },
): string | null {
  let cur = path;
  // Bounded: dirname() is a fixpoint at "/" (and at a drive root), so the
  // loop terminates on the first repeat rather than trusting path depth.
  for (;;) {
    if (exists(cur)) return cur;
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/**
 * Pure: one filesystem's usage → a row.
 *
 * `usage === null` means the filesystem could not be measured (path gone,
 * `statfs` unsupported, permission denied). That is a `skip`, never a
 * failure — doctor must not go red on a machine where the path does not
 * exist.
 */
export function diskRow(
  name: string,
  path: string,
  usage: FsUsage | null,
  thresholds: DiskThresholds = DEFAULT_DISK_THRESHOLDS,
  unmeasuredReason?: string,
): CheckResult {
  if (usage === null) {
    return {
      name,
      status: "skip",
      detail: `${path} — ${unmeasuredReason ?? "could not measure free space"}`,
    };
  }
  // The DISPLAYED percentage is also the one compared against the thresholds.
  // Comparing the raw float while printing a rounded one produces the worst
  // kind of monitoring line — "90% used" beside a warn verdict on a host whose
  // fail_pct is 90 — and an operator who cannot reconcile the number with the
  // verdict stops trusting the check.
  const pct = Math.round(usage.usedPct);
  // Every row carries the numbers, not just the verdict: an operator should be
  // able to act on a doctor line without then running `df`.
  const detail =
    `${path} — ${fmtBytes(usage.freeBytes)} free of ${fmtBytes(usage.totalBytes)} ` +
    `(${pct}% used)`;
  if (pct >= thresholds.failPct) {
    return {
      name,
      status: "fail",
      detail: `${detail} — at/over the ${thresholds.failPct}% fail threshold`,
      fix:
        `Reclaim space now. Evidence first: \`switchroom worktree reap-report\` ` +
        `(report-only, deletes nothing), then \`switchroom worktree gc --yes\` and ` +
        `\`switchroom worktree gc --purge-trash --older-than 14 --yes\`. Package ` +
        `caches: see \`scratch:\` in docs/configuration.md to move them onto a bulk ` +
        `device. Raise the bar with \`disk.fail_pct\` only once the space is real.`,
    };
  }
  if (pct >= thresholds.warnPct) {
    return {
      name,
      status: "warn",
      detail: `${detail} — at/over the ${thresholds.warnPct}% warn threshold`,
      fix:
        `Headroom is shrinking. Run \`switchroom worktree reap-report\` (report-only) ` +
        `to see what stale checkouts would be reclaimable, and check whether the ` +
        `\`scratch:\` volume feature is engaged for package caches. Tune with ` +
        `\`disk.warn_pct\` / \`disk.fail_pct\` in switchroom.yaml.`,
    };
  }
  return { name, status: "ok", detail };
}

/** The reap-report evidence log, as this probe sees it. */
export type ReapLogRead =
  | { kind: "absent" }
  | { kind: "unreadable"; msg: string }
  | { kind: "empty" }
  /** Newest record's `generatedAt`, in epoch ms. */
  | { kind: "ok"; generatedAtMs: number };

const REAP_CRON_HINT =
  "Schedule the report-only sweep (it deletes nothing and has no --yes): " +
  "`40 3 * * *  switchroom worktree reap-report " +
  "--append /var/log/switchroom/reap-report.jsonl` — see " +
  "docs/operators/worktree-gc.md. Set `disk.reap_report.enabled: false` to " +
  "opt out of this check.";

/**
 * Pure: an evidence-log read → a row.
 *
 * The check is deliberately about the log's CONTENT, not about any installer
 * having been run: a cron entry that exists but errors out every night would
 * pass a "is it installed" check and fail this one.
 */
export function reapSweepRow(
  logPath: string,
  read: ReapLogRead,
  maxAgeHours: number,
  nowMs: number,
): CheckResult {
  const name = "worktree reap sweep (evidence log)";
  if (read.kind === "unreadable") {
    return { name, status: "skip", detail: `${logPath} — ${read.msg}` };
  }
  if (read.kind === "absent" || read.kind === "empty") {
    return {
      name,
      status: "warn",
      detail:
        `${logPath} — ${read.kind === "absent" ? "no evidence log" : "log is empty"}; ` +
        `the report-only worktree sweep has never run here`,
      fix: REAP_CRON_HINT,
    };
  }
  const ageMs = nowMs - read.generatedAtMs;
  const ageHours = ageMs / 3_600_000;
  const ageLabel =
    ageHours < 1
      ? `${Math.max(0, Math.round(ageMs / 60_000))}m ago`
      : ageHours < 48
        ? `${ageHours.toFixed(1)}h ago`
        : `${(ageHours / 24).toFixed(1)}d ago`;
  if (ageHours > maxAgeHours) {
    return {
      name,
      status: "warn",
      detail:
        `${logPath} — last ran ${ageLabel}, older than the ${maxAgeHours}h ` +
        `freshness window; the sweep has stopped running`,
      fix: REAP_CRON_HINT,
    };
  }
  return { name, status: "ok", detail: `${logPath} — last ran ${ageLabel}` };
}

/**
 * How many trailing bytes of the evidence log to read.
 *
 * A single reap-report record is a few KB, but the log is append-only and
 * unrotated by default — after a year of daily runs it is megabytes, and a
 * doctor check must not slurp an unbounded operator-configured path into
 * memory to read one timestamp. 256 KiB comfortably contains the newest
 * record; a record larger than that reads as `unreadable` (a skip), never as
 * a spurious warn.
 */
export const REAP_LOG_TAIL_BYTES = 256 * 1024;

/**
 * Default reader: tail the JSONL and parse the newest record's `generatedAt`.
 *
 * Reads only the last {@link REAP_LOG_TAIL_BYTES}, discarding the first
 * (possibly truncated) line of that window.
 */
export function readReapLog(logPath: string): ReapLogRead {
  let text: string;
  let truncated = false;
  let fd: number | undefined;
  try {
    fd = openSync(logPath, "r");
    const size = fstatSync(fd).size;
    const start = size > REAP_LOG_TAIL_BYTES ? size - REAP_LOG_TAIL_BYTES : 0;
    truncated = start > 0;
    const len = size - start;
    const buf = Buffer.alloc(len);
    if (len > 0) readSync(fd, buf, 0, len, start);
    text = buf.toString("utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "absent" };
    return { kind: "unreadable", msg: `unreadable: ${(err as Error).message}` };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
  const rawLines = text.split("\n");
  // The first line of a mid-file window is very likely a partial record.
  if (truncated) rawLines.shift();
  const lines = rawLines.filter((l) => l.trim().length > 0);
  const last = lines[lines.length - 1];
  if (last === undefined) return { kind: "empty" };
  try {
    const rec = JSON.parse(last) as { generatedAt?: unknown };
    const ms =
      typeof rec.generatedAt === "string" ? Date.parse(rec.generatedAt) : Number.NaN;
    if (!Number.isFinite(ms)) {
      return { kind: "unreadable", msg: "newest record has no parseable `generatedAt`" };
    }
    return { kind: "ok", generatedAtMs: ms };
  } catch {
    return { kind: "unreadable", msg: "newest line is not valid JSON" };
  }
}

export interface DiskProbeDeps {
  /** Filesystem stat seam. Returns null when the filesystem cannot be measured. */
  statfs?: (path: string) => StatfsLike | null;
  /** Existence probe used when walking up to a measurable ancestor. */
  exists?: (path: string) => boolean;
  /** Evidence-log reader. Defaults to {@link readReapLog}. */
  readReapLog?: (path: string) => ReapLogRead;
  /**
   * Is the bulk scratch volume mounted? Defaults to the real filesystem probe
   * (`scratchVolumeAvailable`); injected so a test is not silently different
   * on a host that happens to have /mnt/bulkdata.
   */
  scratchAvailable?: (volume: string) => boolean;
  /** Clock seam. */
  nowMs?: number;
}

function defaultStatfs(path: string): StatfsLike | null {
  try {
    const s = statfsSync(path);
    return {
      bsize: Number(s.bsize),
      blocks: Number(s.blocks),
      bavail: Number(s.bavail),
      bfree: Number(s.bfree),
    };
  } catch {
    return null;
  }
}

/**
 * Measure one path's filesystem, walking up to the nearest existing ancestor.
 *
 * Returns the measured usage plus the path it was actually measured at, so
 * the row can name a directory the operator can `df` themselves.
 */
export function measurePath(
  path: string,
  deps: DiskProbeDeps,
): { at: string; usage: FsUsage } | { at: string; usage: null; reason: string } {
  const statfs = deps.statfs ?? defaultStatfs;
  const at = deps.exists ? nearestExistingPath(path, deps.exists) : nearestExistingPath(path);
  if (at === null) {
    return { at: path, usage: null, reason: "path does not exist" };
  }
  const s = statfs(at);
  if (s === null) {
    return { at, usage: null, reason: "statfs unavailable on this platform/path" };
  }
  return { at, usage: usageFromStatfs(s) };
}

/**
 * All disk rows: the agents filesystem, the scratch volume when engaged, and
 * the reap-sweep evidence row.
 */
export function runDiskChecks(
  config: SwitchroomConfig,
  deps: DiskProbeDeps = {},
): CheckResult[] {
  const nowMs = deps.nowMs ?? Date.now();
  const diskCfg = config.disk;
  const thresholds: DiskThresholds = {
    warnPct: diskCfg?.warn_pct ?? DEFAULT_DISK_THRESHOLDS.warnPct,
    failPct: diskCfg?.fail_pct ?? DEFAULT_DISK_THRESHOLDS.failPct,
  };

  const results: CheckResult[] = [];

  // ── agent homes ──────────────────────────────────────────────────────────
  let agentsDir: string;
  try {
    agentsDir = resolveAgentsDir(config);
  } catch {
    agentsDir = "~/.switchroom/agents";
  }
  const agentsMeasure = measurePath(agentsDir, deps);
  // Name the measured path AND the path asked about when they differ, so a
  // row for a not-yet-created agents dir cannot be misread as a measurement
  // of the agents dir itself.
  const agentsLabel =
    agentsMeasure.at === agentsDir
      ? agentsDir
      : `${agentsMeasure.at} (holding ${agentsDir}, not yet created)`;
  results.push(
    diskRow(
      "free space: agent homes",
      agentsLabel,
      agentsMeasure.usage,
      thresholds,
      "reason" in agentsMeasure ? agentsMeasure.reason : undefined,
    ),
  );

  // ── scratch volume (#4723) ───────────────────────────────────────────────
  // Silent when the feature is not engaged: no row at all, exactly as the
  // compose generator emits no mount. A dev machine sees nothing new.
  const scratch = resolveScratchConfig(config);
  const scratchProbe = deps.scratchAvailable ?? scratchVolumeAvailable;
  if (scratch.enabled && scratchProbe(scratch.volume)) {
    const m = measurePath(scratch.volume, deps);
    if (m.usage !== null) {
      results.push(diskRow("free space: scratch volume", m.at, m.usage, thresholds));
    }
  }

  // ── report-only worktree sweep ───────────────────────────────────────────
  const reapCfg = diskCfg?.reap_report;
  if (reapCfg?.enabled !== false) {
    const logPath = reapCfg?.log ?? "/var/log/switchroom/reap-report.jsonl";
    const maxAge = reapCfg?.max_age_hours ?? 48;
    const read = (deps.readReapLog ?? readReapLog)(logPath);
    results.push(reapSweepRow(logPath, read, maxAge, nowMs));
  }

  return results;
}
