/**
 * Arming the mental-model refresh sweep — memory-redesign RFC P10.
 *
 * ## Why this file exists
 *
 * Mental models are hindsight's only synthesis layer and nothing refreshes
 * them unattended: phase-2 J5 found all six of `klanker`'s models 41 days old
 * with zero refreshes, and the doctor WARNs (`>7d since refresh`) but cannot
 * FIX. P10 is the fix — a model-free `/etc/cron.d` fragment that runs
 * `switchroom mental-model-refresh` off-peak, selects the models past a
 * staleness interval, and refreshes each via the engine's MCP tool.
 *
 * This mirrors `src/hindsight-watch/install-cron.ts` deliberately: same
 * `/etc/cron.d` + `flock -n` + pre-created-log + logrotate + reconcile shape,
 * because that file already litigated every one of those decisions against
 * real production failures (#3991 log-permission, #3992 log-growth, the
 * six-week "a doc is not a mechanism" arming gap). Reusing the shape means
 * reusing those fixes rather than re-discovering them.
 *
 * ## Why /etc/cron.d and not a switchroom.yaml `schedule:` entry
 *
 * A `schedule:` entry runs through the Tier-0 scheduler, whose only non-model
 * `kind` is `action` — and the action engine is EGRESS-ONLY
 * (`src/scheduler/action-engine.ts`: telegram-message / webhook, fenced against
 * loopback). It cannot POST to the local hindsight `/mcp/` endpoint. A `prompt`
 * entry could, but only by waking a MODEL to do deterministic work — which the
 * dev protocol's "deterministic over model-dependent" rule forbids. So the
 * mechanism has to live outside the scheduler, and `/etc/cron.d` is the
 * fleet's established model-free-cron home (hindsight-watch, openrouter,
 * config-repo each arm one the same way).
 */

import { execFileSync } from "node:child_process";
import { chownSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Where the cron fragment lands. */
export const CRON_PATH = "/etc/cron.d/mental-model-refresh";

/**
 * Cadence. Daily, off-peak (04:27). Two deliberate choices from the RFC's
 * "consolidation load" risk note:
 *
 *  - **Daily, not 15-minutely.** A refresh is real engine work (a reflect +
 *    write per model); the staleness interval is measured in DAYS, so anything
 *    finer just re-scans banks that cannot have gone stale since the last tick.
 *  - **04:27, not 04:00.** Off-peak keeps consolidation load away from waking
 *    hours, and an odd minute avoids the top-of-hour thundering herd every
 *    other cron on the box fires into.
 *
 * A constant, not a flag: changing the cadence has engine-load consequences the
 * RFC calls out, so it is a reviewed edit here rather than an operator knob.
 */
export const CRON_SCHEDULE = "27 4 * * *";

/** Log the cron appends to. */
export const CRON_LOG_PATH = "/var/log/mental-model-refresh.log";

/** Where the logrotate drop-in lands. */
export const LOGROTATE_PATH = "/etc/logrotate.d/mental-model-refresh";

/** Lock file — `flock -n` so a slow sweep cannot be overlapped by the next. */
export const CRON_LOCK_PATH = "/run/lock/mental-model-refresh.lock";

export interface CronRenderOptions {
  /** Unix user the sweep runs as. */
  user: string;
  /** Absolute path to the `switchroom` binary. */
  binary: string;
}

/**
 * Render the cron fragment.
 *
 * Pure, so the exact bytes that land in `/etc/cron.d` are asserted in a unit
 * test rather than discovered in production. The three properties pinned by
 * `install-cron.ts` apply verbatim and are pinned here too:
 *
 *  - **`flock -n`**, so a sweep that outlives its interval is skipped rather
 *    than run concurrently — two sweeps racing would double-refresh models and
 *    double the engine load the RFC warns against.
 *  - **A trailing newline** — cron silently ignores a fragment whose last line
 *    has none.
 *  - **An explicit `PATH`** — cron's default `/usr/bin:/bin` is a known
 *    foot-gun; pin the standard system PATH so the binary and its deps resolve.
 */
export function renderCron(opts: CronRenderOptions): string {
  return (
    `# switchroom mental-model-refresh — model-free stale-model refresh sweep (RFC P10).\n` +
    `# Managed by \`switchroom mental-model-refresh --install-cron\`; edits are overwritten.\n` +
    `# Exit 0 = swept (some refreshes may have failed; see log), 1 = the sweep could not complete.\n` +
    `SHELL=/bin/sh\n` +
    `PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n` +
    `${CRON_SCHEDULE} ${opts.user} /usr/bin/flock -n ${CRON_LOCK_PATH} ` +
    `${opts.binary} mental-model-refresh >> ${CRON_LOG_PATH} 2>&1\n`
  );
}

export interface InstallResult {
  /** `installed` on a write, `unchanged` when the file already matched. */
  status: "installed" | "unchanged";
  path: string;
  content: string;
}

/**
 * Write the cron fragment idempotently — tmp+rename to mode 0644, no-op when
 * the content already matches. Same shape as
 * `src/hindsight-watch/install-cron.ts` {@link installCron}; see that file for
 * why cron refuses a group-/world-writable or half-written fragment.
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
 * Pre-create the log file owned by the cron user — the #3991 fix, applied here
 * for the same reason: the rendered line ends `>> <log> 2>&1`, and on a stock
 * host `/var/log` is not writable by the operator cron user, so the shell
 * cannot CREATE the file and every tick dies at the redirection before
 * `switchroom` is exec'd. Pre-creating it mode-0644 and `chown`ing to the cron
 * user lets the `>>` append succeed. Idempotent and best-effort on the chown,
 * exactly as `install-cron.ts` {@link ensureLogFile} — see that file for the
 * full rationale on the non-root skip and EPERM tolerance.
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
    // stat failure is non-fatal here; fall through to attempt the chown.
  }
  if (isRoot && !alreadyOwned) {
    try {
      chownSync(path, uid, gid);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EPERM") throw e;
      // EPERM tolerated: the file exists mode-0644; the cron can still append.
    }
  }
  return { status: "created", path };
}

/**
 * Render the logrotate drop-in (#3992 shape). `copytruncate` because the log
 * has no long-lived writer to signal (cron reopens `>>` daily); `su <user>
 * <user>` runs rotation as the file's owner. See `install-cron.ts`
 * {@link renderLogrotate}.
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

/** Write the logrotate drop-in idempotently — same shape as {@link installCron}. */
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
 * Parse the unix user field out of an existing cron fragment — the 6th
 * whitespace field of the managed schedule line (the one invoking
 * `mental-model-refresh`), so a reconcile PRESERVES the operator's chosen
 * `--cron-user` instead of guessing it from the reconciling process env (which,
 * under `sudo switchroom update`, is `root` — the value `--install-cron`
 * refuses). Null when no managed line is found. See `install-cron.ts`
 * {@link parseCronUser}.
 */
export function parseCronUser(content: string): string | null {
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (!trimmed.includes("mental-model-refresh")) continue;
    const fields = trimmed.split(/\s+/);
    if (fields.length >= 7) return fields[5];
  }
  return null;
}

export interface ReconcileResult {
  /**
   * `absent`     — no fragment; the host never armed the sweep, reconcile is a
   *                no-op (arming stays explicit opt-in).
   * `reconciled` — a fragment existed but drifted (binary path, schedule,
   *                flags, PATH) and was rewritten.
   * `unchanged`  — a fragment existed and already matched.
   */
  status: "absent" | "reconciled" | "unchanged";
  path: string;
  content?: string;
}

/**
 * Reconcile an ALREADY-ARMED mental-model-refresh cron to the current
 * definition — REPAIR, not ARM. Only touches an existing fragment, so
 * `switchroom update` keeps every armed host's cron current (binary path,
 * schedule, flags, PATH) without arming a host that never opted in. The user
 * field is preserved from the existing fragment ({@link parseCronUser}),
 * falling back to `fallbackUser` only when unparseable. See `install-cron.ts`
 * {@link reconcileCron}.
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
