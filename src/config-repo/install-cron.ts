/**
 * Arming the config-repo auto-backup — the schedule Slice 1 deliberately left out.
 *
 * ## Why this file exists
 *
 * Slice 1 shipped `switchroom config-repo sync` — a native, flock-guarded,
 * secret-scanned commit+push of the operator's private `~/.switchroom-config`
 * repo — but it is a MANUAL verb. On paper the backup story is complete; in
 * practice nothing runs it, so the repo captures a change only when a human
 * remembers to. That is the exact "the mechanism exists but was never armed"
 * trap `hindsight-watch/install-cron.ts` was written to close (its cron shipped
 * disarmed for six weeks). This is the same mechanism for the config repo: a
 * product-installed `/etc/cron.d` fragment that runs the sync on a schedule,
 * and a `switchroom doctor` row that goes red when `config_repo.enabled` is set
 * but the cron is not armed, so an un-armed backup says so out loud.
 *
 * ## Why /etc/cron.d and not a systemd timer
 *
 * The push rides the OPERATOR's `gh` credential helper (`~/.gitconfig` +
 * `gh auth`), so the tick MUST run as `kenthompson`, not root. `/etc/cron.d`
 * carries a user field and matches the hindsight-watch precedent exactly; the
 * live self-heal *timer* runs as root, which is precisely the wrong identity
 * for a git push. Cost of cron over a `Persistent=true` timer: no missed-run
 * catch-up — acceptable at a 30-min cadence, where a missed tick self-heals
 * within the interval.
 *
 * ## The two legs
 *
 *  - **30-min tick** (`config_repo.interval_minutes`, default 30): commit+push
 *    live config, owned workspace state, and mirrored personal skills.
 *  - **daily leg** (`config_repo.include_vault_backup: daily`): once a day, run
 *    `switchroom vault backup` FIRST, then the same sync — the first automated
 *    vault/memory snapshot on this host. `every_tick` folds the backup into the
 *    30-min tick instead; `off` drops it.
 *
 * Both legs share ONE `flock -n` lock, so the daily leg and a still-running
 * 30-min tick can never run git concurrently, and the daily minute (17) is off
 * the 30-min grid (:00/:30) so the backup leg is never pre-empted by a plain
 * tick landing on the same minute.
 */

import { execFileSync } from "node:child_process";
import {
  chownSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

/** Where the cron fragment lands. */
export const CRON_PATH = "/etc/cron.d/switchroom-config-sync";

/** Log the cron appends to (both legs redirect here). */
export const CRON_LOG_PATH = "/var/log/switchroom-config-sync.log";

/** Where the logrotate drop-in lands. */
export const LOGROTATE_PATH = "/etc/logrotate.d/switchroom-config-sync";

/**
 * Lock file — `flock -n` so a slow sync cannot be overlapped by the next tick
 * OR the daily backup leg. Sharing ONE lock across both legs is the whole
 * point: two `git commit`s racing in the repo is the failure single-writer
 * exists to prevent.
 */
export const CRON_LOCK_PATH = "/run/lock/switchroom-config-sync.lock";

/** Default tick cadence in minutes (Ken's approved decision). */
export const DEFAULT_INTERVAL_MINUTES = 30;

/**
 * Schedule for the daily `vault backup && sync` leg. Minute 17 is deliberately
 * OFF the 30-min grid ({:00, :30}), so a plain tick and the backup leg never
 * land on the same minute and contend for the shared lock — the backup leg
 * always gets to run. 03:17 is a low-traffic hour.
 */
export const DAILY_CRON_SCHEDULE = "17 3 * * *";

export type IncludeVaultBackup = "off" | "daily" | "every_tick";

export interface CronRenderOptions {
  /** Unix user the tick runs as (must own the gh credential helper). */
  user: string;
  /** Absolute path to the `switchroom` binary. */
  binary: string;
  /** Tick cadence in minutes (5..59). Default 30. */
  intervalMinutes?: number;
  /** Whether/when to run `vault backup` before the sync. Default "daily". */
  includeVaultBackup?: IncludeVaultBackup;
}

/** `/usr/bin/flock -n <lock>` — shared by both legs. */
function flockPrefix(): string {
  return `/usr/bin/flock -n ${CRON_LOCK_PATH}`;
}

/**
 * Render the cron fragment.
 *
 * Pure, so the exact bytes that land in `/etc/cron.d` are asserted in a unit
 * test rather than discovered in production. The properties the test pins are
 * the classic ways a `/etc/cron.d` fragment exists and silently never runs:
 *
 *  - **`flock -n`** on a SHARED lock, so the two legs (and a slow tick) can
 *    never run git concurrently.
 *  - **A trailing newline.** cron silently ignores a fragment whose last line
 *    has no newline.
 *  - **An explicit `PATH`.** `switchroom` shells out (git, gh, flock); cron's
 *    default `/usr/bin:/bin` omits `/usr/local/bin`.
 *  - **Absolute binary path**, since a relative argv in a cron line fails every
 *    tick with a message only in syslog.
 */
export function renderCron(opts: CronRenderOptions): string {
  const interval = opts.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES;
  const mode = opts.includeVaultBackup ?? "daily";
  const bin = opts.binary;
  const flock = flockPrefix();

  const syncCmd = `${bin} config-repo sync`;
  // `vault backup` must complete before the sync so the fresh snapshot is what
  // gets committed. `&&` (not `;`) so a failed backup does not mask its exit in
  // a sync that then reports success.
  const backupThenSync = `/bin/sh -c '${bin} vault backup && ${bin} config-repo sync'`;

  const tickCmd = mode === "every_tick" ? backupThenSync : syncCmd;
  const tickLine =
    `*/${interval} * * * * ${opts.user} ${flock} ${tickCmd} >> ${CRON_LOG_PATH} 2>&1\n`;

  const dailyLine =
    mode === "daily"
      ? `${DAILY_CRON_SCHEDULE} ${opts.user} ${flock} ${backupThenSync} >> ${CRON_LOG_PATH} 2>&1\n`
      : "";

  const backupNote =
    mode === "off"
      ? "# vault backup: off (config_repo.include_vault_backup: off).\n"
      : mode === "every_tick"
        ? "# vault backup: every tick (config_repo.include_vault_backup: every_tick).\n"
        : `# vault backup: daily at ${DAILY_CRON_SCHEDULE} (config_repo.include_vault_backup: daily).\n`;

  return (
    `# switchroom config-repo auto-backup — scheduled sync of ~/.switchroom-config.\n` +
    `# Managed by \`switchroom config-repo --install-cron\`; edits are overwritten.\n` +
    `# ${interval}-min leg: commit+push live config / workspace / mirrored personal skills.\n` +
    backupNote +
    `SHELL=/bin/sh\n` +
    `PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n` +
    tickLine +
    dailyLine
  );
}

export interface InstallResult {
  /** `installed` on a write, `unchanged` when the file already matched. */
  status: "installed" | "unchanged";
  path: string;
  content: string;
}

/**
 * Write the cron fragment idempotently.
 *
 * Re-running is a no-op when the content already matches, so this is safe from
 * an unconditional reconcile path. tmp+rename to mode 0644 — cron refuses a
 * group- or world-writable fragment, and a half-written file would be parsed by
 * whatever cron scan lands mid-write.
 */
export function installCron(
  opts: CronRenderOptions & { path?: string },
): InstallResult {
  const path = opts.path ?? CRON_PATH;
  const content = renderCron(opts);
  if (existsSync(path)) {
    try {
      if (readFileSync(path, "utf8") === content) {
        return { status: "unchanged", path, content };
      }
    } catch {
      // Unreadable but present — fall through and rewrite it.
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode: 0o644 });
  renameSync(tmp, path);
  return { status: "installed", path, content };
}

export interface UninstallResult {
  /** `removed` when a fragment was deleted, `absent` when there was none. */
  status: "removed" | "absent";
  path: string;
}

/**
 * Remove the cron fragment idempotently. `absent` when nothing was there, so a
 * double-uninstall is a clean no-op. Removing the fragment stops both legs; the
 * log and logrotate drop-in are cleaned up separately by the CLI verb (they are
 * harmless if left, and an operator may want to keep the log).
 */
export function uninstallCron(path: string = CRON_PATH): UninstallResult {
  if (!existsSync(path)) return { status: "absent", path };
  rmSync(path, { force: true });
  return { status: "removed", path };
}

/** Resolve a unix user name to `{uid, gid}` via `id -u` / `id -g`. */
export type IdResolver = (user: string) => { uid: number; gid: number };

const defaultIdResolver: IdResolver = (user) => {
  const uid = Number(execFileSync("id", ["-u", user], { encoding: "utf8" }).trim());
  const gid = Number(execFileSync("id", ["-g", user], { encoding: "utf8" }).trim());
  if (!Number.isInteger(uid) || !Number.isInteger(gid)) {
    throw new Error(`could not resolve uid/gid for user ${JSON.stringify(user)}`);
  }
  return { uid, gid };
};

export interface EnsureLogResult {
  /** `created` on a fresh write, `unchanged` when the file already existed. */
  status: "created" | "unchanged";
  path: string;
}

/**
 * Create the sync log file owned by the cron user — the same #3991 trap the
 * watchdog hit: the rendered line ends `>> /var/log/switchroom-config-sync.log
 * 2>&1`, and on a stock Ubuntu host `/var/log` is `root:syslog 0775`, so the
 * operator cron user cannot CREATE that file — the redirection fails
 * "Permission denied" BEFORE `switchroom` is exec'd and every tick dies
 * silently. Pre-creating the file mode-0644 and chowning it to the cron user
 * lets the `>>` append succeed without write on `/var/log`.
 *
 * Idempotent: an existing file is left untouched (never re-chowned, never
 * truncated). The chown is BEST-EFFORT and root-only — the file EXISTING is the
 * guarantee; ownership only matters when `/var/log` is unwritable by the cron
 * user, and a non-root caller (or a restricted mount) must still get a created
 * file, never a fatal EPERM that aborts the arm.
 */
export function ensureLogFile(
  opts: { user: string; path?: string; resolveIds?: IdResolver },
): EnsureLogResult {
  const path = opts.path ?? CRON_LOG_PATH;
  if (existsSync(path)) return { status: "unchanged", path };
  const { uid, gid } = (opts.resolveIds ?? defaultIdResolver)(opts.user);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "", { mode: 0o644, flag: "a" });
  const isRoot = process.getuid?.() === 0;
  let alreadyOwned = false;
  try {
    const st = statSync(path);
    alreadyOwned = st.uid === uid && st.gid === gid;
  } catch {
    // stat failure is non-fatal; fall through to attempt the chown.
  }
  if (isRoot && !alreadyOwned) {
    try {
      chownSync(path, uid, gid);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EPERM") throw e;
      // EPERM tolerated: the file exists and is mode-0644; the cron can still
      // append. Ownership stays with the creating user.
    }
  }
  return { status: "created", path };
}

/**
 * Render the logrotate drop-in. Pure, so the exact bytes are asserted in a unit
 * test. `copytruncate` because the log has no writer to signal (cron reopens
 * `>>` each tick), and `su <user> <user>` runs the rotation as the cron user
 * that owns the file.
 */
export function renderLogrotate(opts: { logPath: string; user: string }): string {
  return (
    `${opts.logPath} {\n` +
    `  weekly\n` +
    `  rotate 8\n` +
    `  compress\n` +
    `  delaycompress\n` +
    `  missingok\n` +
    `  notifempty\n` +
    `  copytruncate\n` +
    `  su ${opts.user} ${opts.user}\n` +
    `}\n`
  );
}

/**
 * Write the logrotate drop-in idempotently — same tmp+rename, mode-0644,
 * no-op-when-unchanged shape as {@link installCron}.
 */
export function installLogrotate(
  opts: { user: string; logPath?: string; path?: string },
): InstallResult {
  const path = opts.path ?? LOGROTATE_PATH;
  const content = renderLogrotate({ logPath: opts.logPath ?? CRON_LOG_PATH, user: opts.user });
  if (existsSync(path)) {
    try {
      if (readFileSync(path, "utf8") === content) {
        return { status: "unchanged", path, content };
      }
    } catch {
      // Unreadable but present — fall through and rewrite it.
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode: 0o644 });
  renameSync(tmp, path);
  return { status: "installed", path, content };
}

/** Remove the logrotate drop-in idempotently. */
export function uninstallLogrotate(path: string = LOGROTATE_PATH): UninstallResult {
  if (!existsSync(path)) return { status: "absent", path };
  rmSync(path, { force: true });
  return { status: "removed", path };
}

/**
 * Parse the unix user field out of an existing cron fragment.
 *
 * `/etc/cron.d` lines are `MIN HOUR DOM MON DOW USER COMMAND` — the sixth
 * field. We match a managed line (one that invokes `config-repo sync`) rather
 * than any comment/`SHELL=`/`PATH=` line, so a reconcile PRESERVES the
 * operator's chosen `--cron-user` instead of guessing it from the reconciling
 * process's environment (which under `sudo switchroom update` is `root` — the
 * value `--install-cron` refuses).
 *
 * Returns null when no managed schedule line is found.
 */
export function parseCronUser(content: string): string | null {
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (!trimmed.includes("config-repo sync")) continue;
    const fields = trimmed.split(/\s+/);
    if (fields.length >= 7) return fields[5];
  }
  return null;
}

export interface ReconcileResult {
  /**
   * `absent`     — no fragment present; reconcile does nothing (arming stays
   *                the explicit `--install-cron` opt-in, gated on
   *                `config_repo.enabled`).
   * `reconciled` — the fragment existed but drifted (stale binary path,
   *                schedule, flags, PATH) and was rewritten to match.
   * `unchanged`  — the fragment existed and already matched — a true no-op.
   */
  status: "absent" | "reconciled" | "unchanged";
  path: string;
  content?: string;
}

/**
 * Reconcile an ALREADY-ARMED config-sync cron to the current definition.
 *
 * REPAIR, not ARM: only touches a fragment that already exists, so
 * `switchroom update` can keep every armed host's cron current (binary path,
 * schedule, flags, PATH) without silently arming a host that never opted in.
 * The user field is preserved from the existing fragment; the interval and
 * vault-backup mode are re-read from config so a `switchroom.yaml` change is
 * reconciled on the next update.
 *
 * Idempotent: re-running changes nothing once the fragment matches.
 */
export function reconcileCron(opts: {
  binary: string;
  intervalMinutes?: number;
  includeVaultBackup?: IncludeVaultBackup;
  path?: string;
  fallbackUser?: string;
}): ReconcileResult {
  const path = opts.path ?? CRON_PATH;
  if (!existsSync(path)) return { status: "absent", path };
  let user = opts.fallbackUser;
  try {
    user = parseCronUser(readFileSync(path, "utf8")) ?? opts.fallbackUser;
  } catch {
    // Unreadable — fall back to the provided user and let installCron rewrite.
  }
  if (!user) {
    throw new Error(
      `cannot reconcile ${path}: no cron-user parseable from the existing fragment and no fallback user available`,
    );
  }
  const r = installCron({
    user,
    binary: opts.binary,
    intervalMinutes: opts.intervalMinutes,
    includeVaultBackup: opts.includeVaultBackup,
    path,
  });
  return {
    status: r.status === "installed" ? "reconciled" : "unchanged",
    path,
    content: r.content,
  };
}
