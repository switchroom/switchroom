/**
 * Arming the OpenRouter credit watch.
 *
 * Deliberately the same mechanism as `src/hindsight-watch/install-cron.ts`,
 * for the reason that file spells out: a monitoring step that lives in a doc
 * is not a mechanism, and switchroom already shipped one watchdog that never
 * ran because arming it was four manual steps nobody performed. So this is a
 * verb (`switchroom openrouter-watch --install-cron`) that writes a
 * declarative, idempotent `/etc/cron.d` fragment.
 *
 * CADENCE — why hourly and not every 15 minutes.
 * Credit is a slowly-moving quantity measured in dollars, and the alert it
 * feeds re-notifies at most once per 6 h (`RENOTIFY_MS` in `./watch.ts`).
 * Hourly gives six independent observations inside one re-notify window —
 * ample to catch an escalation promptly — while costing one HTTP GET an hour
 * and zero model tokens. A 15-minute tick would quadruple the request rate
 * against a third-party API to buy latency the alert cadence throws away.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Where the cron fragment lands. */
export const CRON_PATH = "/etc/cron.d/openrouter-watch";

/** Cadence — see the module header for why hourly. */
export const CRON_SCHEDULE = "17 * * * *";

/** Log the cron appends to. */
export const CRON_LOG_PATH = "/var/log/openrouter-watch.log";

/** Lock file — `flock -n` so a slow tick cannot be overlapped by the next. */
export const CRON_LOCK_PATH = "/run/lock/openrouter-watch.lock";

export interface CronRenderOptions {
  /** Unix user the tick runs as. */
  user: string;
  /** Absolute path to the `switchroom` binary. */
  binary: string;
}

/**
 * Render the cron fragment. Pure, so the exact bytes are asserted in a test.
 *
 * Three properties the test pins, each a real cron failure mode:
 *  - **`flock -n`** — two overlapping ticks would race on the state file that
 *    holds the re-notify ledger, which is what stops the operator being paged
 *    every hour about the same shortfall.
 *  - **a trailing newline** — cron silently ignores a fragment whose last
 *    line has none.
 *  - **an explicit `PATH`** — cron's default is `/usr/bin:/bin`, which on most
 *    installs does not contain the `switchroom` binary's own dependencies.
 */
export function renderCron(opts: CronRenderOptions): string {
  return (
    `# switchroom openrouter-watch — model-free OpenRouter credit watchdog.\n` +
    `# Managed by \`switchroom openrouter-watch --install-cron\`; edits are overwritten.\n` +
    `# Exit 0 = clean, 10 = credit signal firing (DM sent), 1 = the check could not complete.\n` +
    `SHELL=/bin/sh\n` +
    `PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n` +
    `${CRON_SCHEDULE} ${opts.user} /usr/bin/flock -n ${CRON_LOCK_PATH} ` +
    `${opts.binary} openrouter-watch >> ${CRON_LOG_PATH} 2>&1\n`
  );
}

export interface InstallResult {
  status: "installed" | "unchanged";
  path: string;
  content: string;
}

/**
 * Write the cron fragment idempotently (tmp+rename, mode 0644 — cron refuses
 * a group- or world-writable fragment, and a half-written file would be
 * parsed by whatever cron scan lands mid-write).
 */
export function installCron(opts: CronRenderOptions & { path?: string }): InstallResult {
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
