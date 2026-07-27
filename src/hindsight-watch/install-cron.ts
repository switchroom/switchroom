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

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
