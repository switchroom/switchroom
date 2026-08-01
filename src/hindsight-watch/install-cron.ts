/**
 * Arming the watchdog — the step that never happened.
 *
 * ## Why this file exists
 *
 * `switchroom hindsight-watch` shipped in #3617 with a complete signal set, a
 * tested state machine, and a CHANGELOG line reading **"This does not install
 * a cron"**, pointing at four manual steps in `docs/hindsight-watch.md`.
 * Nobody ran them. Verified on this host: no `/etc/cron.d/hindsight-watch`,
 * no `~/.switchroom/hindsight-watch/state.json`, no log file. The watchdog
 * has never executed.
 *
 * So the fleet spent six weeks with a monitoring gap that was, on paper,
 * already closed. A doc that has to be obeyed is not a mechanism; this is the
 * mechanism. `switchroom doctor` additionally FAILs while the watchdog is
 * unarmed (`doctor-hindsight-watch.ts`), so a fleet that skips this step says
 * so out loud instead of looking healthy.
 *
 * ## Why /etc/cron.d and not the operator's crontab
 *
 * `/etc/cron.d` is declarative, idempotent, greppable, and survives a user
 * switch. `crontab -e` requires reading and rewriting a file we do not own,
 * and gives no natural home for the `flock` and the user field.
 */

import { execFileSync } from "node:child_process";
import { chownSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Where the cron fragment lands. */
export const CRON_PATH = "/etc/cron.d/hindsight-watch";

/**
 * Cadence. 15 minutes matches the window arithmetic every threshold in
 * `thresholds.ts` was derived against (`RING_MAX` 8 samples ≈ 2 h,
 * `MAX_SAMPLE_AGE_MS` 3 h). Changing it silently re-scales every rate signal,
 * so it is a constant here rather than a flag.
 */
export const CRON_SCHEDULE = "*/15 * * * *";

/** Log the cron appends to. */
export const CRON_LOG_PATH = "/var/log/hindsight-watch.log";

/** Where the logrotate drop-in lands (#3992). */
export const LOGROTATE_PATH = "/etc/logrotate.d/hindsight-watch";

/** Lock file — `flock -n` so a slow tick cannot be overlapped by the next. */
export const CRON_LOCK_PATH = "/run/lock/hindsight-watch.lock";

export interface CronRenderOptions {
  /** Unix user the tick runs as. */
  user: string;
  /** Absolute path to the `switchroom` binary. */
  binary: string;
}

/**
 * Render the cron fragment.
 *
 * Pure, so the exact bytes that land in `/etc/cron.d` are asserted in a unit
 * test rather than discovered in production. Three properties the test pins:
 *
 *  - **`flock -n`**, so a tick that outlives its interval is skipped rather
 *    than run concurrently — two ticks racing on the state file would corrupt
 *    the hysteresis counters that decide whether a human is woken.
 *  - **A trailing newline.** cron silently ignores a fragment whose last line
 *    has no newline; this is the classic "the file is right there and nothing
 *    runs" failure.
 *  - **An explicit `PATH`.** cron's default PATH is `/usr/bin:/bin`, which
 *    does not contain `docker` on most installs — and the watchdog shells out
 *    to `docker inspect` and `docker exec`. Without this the container and
 *    consolidation probes fail every tick.
 */
export function renderCron(opts: CronRenderOptions): string {
  return (
    `# switchroom hindsight-watch — model-free memory watchdog.\n` +
    `# Managed by \`switchroom hindsight-watch --install-cron\`; edits are overwritten.\n` +
    `# Exit 0 = clean, 10 = a signal is firing (DM sent), 1 = the check could not complete.\n` +
    `SHELL=/bin/sh\n` +
    `PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n` +
    `${CRON_SCHEDULE} ${opts.user} /usr/bin/flock -n ${CRON_LOCK_PATH} ` +
    `${opts.binary} hindsight-watch >> ${CRON_LOG_PATH} 2>&1\n`
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
 * Re-running is a no-op when the content already matches, so this is safe to
 * call from an unconditional provisioning path. The write is tmp+rename to
 * mode 0644 — cron refuses a group- or world-writable fragment, and a
 * half-written file would be parsed by whatever cron scan lands mid-write.
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
 * Create the watchdog log file owned by the cron user — the step whose absence
 * made `--install-cron` produce a cron that died at the redirection on every
 * tick (#3991).
 *
 * ## Why this exists
 *
 * The rendered cron line ends `>> /var/log/hindsight-watch.log 2>&1`. On a
 * stock Ubuntu host `/var/log` is `root:syslog 0775`, and the operator cron
 * user is not in `syslog`, so the shell cannot CREATE that file — the
 * redirection fails with "Permission denied" BEFORE `switchroom` is ever
 * exec'd. Every tick dies, nothing is written anywhere, and `switchroom
 * doctor` then FAILs forever with "cron exists but the watchdog has never
 * completed a tick": the exact silent-monitoring failure the install-cron
 * mechanism exists to prevent.
 *
 * Pre-creating the file `root`-owns-the-dir-but-user-owns-the-file (mode 0644,
 * `chown`ed to the cron user) means the user can APPEND to an existing file it
 * owns without needing write on `/var/log`. Idempotent: an existing file is
 * left untouched (never re-chowned, never truncated — that would throw away
 * accumulated ticks and could clobber an operator's deliberate ownership).
 */
export function ensureLogFile(
  opts: { user: string; path?: string; resolveIds?: IdResolver },
): EnsureLogResult {
  const path = opts.path ?? CRON_LOG_PATH;
  if (existsSync(path)) return { status: "unchanged", path };
  const { uid, gid } = (opts.resolveIds ?? defaultIdResolver)(opts.user);
  mkdirSync(dirname(path), { recursive: true });
  // Create empty, then chown to the cron user so its `>>` append succeeds
  // without write access to the parent dir. A tmp+rename would defeat the
  // "skip if exists" guard's race-freeness for no gain — this file is created
  // once and appended to thereafter, never rewritten.
  writeFileSync(path, "", { mode: 0o644, flag: "a" });
  // Ownership is BEST-EFFORT — the goal that closes #3991 is that the file
  // EXISTS so the cron's `>>` redirection can append; the chown only makes the
  // append work when `/var/log` itself is not writable by the cron user. Only
  // root can chown to another uid, and install-cron is normally invoked under
  // `sudo … --cron-user <operator>`, so:
  //   • skip the chown entirely when we are NOT root (a non-root caller would
  //     get EPERM), or when the file is already owned by the target ids; and
  //   • even on the root path, tolerate an EPERM (unusual mounts, restricted
  //     containers) rather than aborting the arm — mirroring installLogrotate's
  //     WARN-not-fatal stance. The file is already created; ownership is a
  //     nice-to-have, not the guarantee this function exists to make.
  const isRoot = process.getuid?.() === 0;
  let alreadyOwned = false;
  try {
    const st = statSync(path);
    alreadyOwned = st.uid === uid && st.gid === gid;
  } catch {
    // stat failure is non-fatal here; fall through to attempt the chown.
  }
  if (isRoot && !alreadyOwned) {
    try {
      chownSync(path, uid, gid);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EPERM") throw e;
      // EPERM tolerated: the log file exists and is mode-0644; the cron can
      // still create/append to it. Ownership stays with the creating user.
    }
  }
  return { status: "created", path };
}

/**
 * Render the logrotate drop-in for the watchdog log (#3992).
 *
 * Pure, so the exact bytes are asserted in a unit test. `copytruncate` is
 * deliberate: the log has no writer to signal (cron reopens `>>` every 15
 * minutes), so rotate-in-place-and-truncate is the only scheme that does not
 * strand the inode. `su <user> <user>` runs the rotation as the cron user that
 * owns the file, since the drop-in itself is root-installed under a dir the
 * user cannot write.
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
 * no-op-when-unchanged shape as {@link installCron}, so `--install-cron` can
 * call it unconditionally. Without it the 15-minute cron appends ~135 KB/day
 * to `/var/log/hindsight-watch.log` unbounded (#3992).
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

/**
 * Parse the unix user field out of an existing cron fragment.
 *
 * `/etc/cron.d` lines are `MIN HOUR DOM MON DOW USER COMMAND` — the sixth
 * whitespace-delimited field. We match the managed line (the one that invokes
 * `hindsight-watch`) rather than any comment/`SHELL=`/`PATH=` line, and return
 * that user so a reconcile PRESERVES the operator's chosen `--cron-user`
 * instead of guessing it from the reconciling process's environment (which,
 * under `sudo switchroom update`, would be `root` — the exact value
 * `--install-cron` refuses).
 *
 * Returns null when no managed schedule line is found (empty/foreign/malformed
 * fragment), so the caller can fall back or decline to touch it.
 */
export function parseCronUser(content: string): string | null {
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (!trimmed.includes("hindsight-watch")) continue;
    // MIN HOUR DOM MON DOW USER … — the user is the 6th field.
    const fields = trimmed.split(/\s+/);
    if (fields.length >= 7) return fields[5];
  }
  return null;
}

export interface ReconcileResult {
  /**
   * `absent`     — the fragment is not present; the host never armed the
   *                watchdog, so reconcile does nothing (arming stays the
   *                explicit opt-in, and `switchroom doctor` FAILs while
   *                unarmed).
   * `reconciled` — the fragment existed but drifted (stale binary path,
   *                schedule, flags, or PATH) and was rewritten to match.
   * `unchanged`  — the fragment existed and already matched — a true no-op.
   */
  status: "absent" | "reconciled" | "unchanged";
  path: string;
  content?: string;
}

/**
 * Reconcile an ALREADY-ARMED hindsight-watch cron to the current definition.
 *
 * ## Why this is separate from {@link installCron}
 *
 * `installCron` ARMS — it writes the fragment whether or not one exists. That
 * is the opt-in `--install-cron` verb's job. `reconcileCron` REPAIRS — it only
 * touches a fragment that already exists, so `switchroom update` can keep every
 * armed host's cron definition current (the binary path, schedule, flags and
 * PATH) without silently arming a host that deliberately never opted in.
 *
 * This closes the drift that let a stale cron survive an update: the fragment's
 * `binary` path is pinned when written, but nothing re-asserted it, so a
 * definition change (or a moved binary) would persist until someone re-ran
 * `--install-cron` by hand.
 *
 * Idempotent: re-running changes nothing once the fragment matches. The user
 * field is preserved from the existing fragment (see {@link parseCronUser}),
 * falling back to `fallbackUser` only when the existing line is unparseable.
 */
export function reconcileCron(opts: {
  binary: string;
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
    // No user to render with and none parseable: refuse to write a fragment
    // with an empty/invalid user field rather than break the cron.
    throw new Error(
      `cannot reconcile ${path}: no cron-user parseable from the existing fragment and no fallback user available`,
    );
  }
  const r = installCron({ user, binary: opts.binary, path });
  return {
    status: r.status === "installed" ? "reconciled" : "unchanged",
    path,
    content: r.content,
  };
}
