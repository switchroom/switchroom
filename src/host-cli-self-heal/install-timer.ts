/**
 * Arming the host-CLI self-heal — the step that closes the last convergence gap.
 *
 * ## Why this file exists
 *
 * A shipped release auto-converges every *container* image, but the host
 * operator binary (`/usr/local/bin/switchroom`) and the `hindsight-watch` cron
 * only converge when a human runs `switchroom update` on the host — because
 * `self-update-cli` and the cron reconcile step are host-context work that skips
 * inside the hostd/agent container a rollout runs from. So a release can roll to
 * every container while the host binary silently trails the fleet (the v0.19.38
 * incident: `/usr/local/bin/switchroom` stuck on v0.19.33 for 12 hours running
 * retired `hindsight-watch` code).
 *
 * `switchroom doctor` now FAILs on that drift and `switchroom update` reconciles
 * the cron — but "loud" still needs a human to look. This unit makes the host
 * binary **self-heal** without one: a systemd timer re-runs
 * `switchroom update --skip-images` on a cadence, so a behind host CLI is
 * corrected within one interval, entirely on the host, no container involved.
 *
 * `--skip-images` is deliberate and load-bearing: it still runs `self-update-cli`
 * (the atomic host-binary swap — only `--skip-self-update` skips that,
 * update.ts:476) and reconciles the cron, but does not pull GHCR images or touch
 * running containers on a healthy tick, so each run is cheap and offline-safe.
 *
 * ## Why a system timer and not the operator's crontab
 *
 * A `/etc/systemd/system` unit is declarative, idempotent, greppable, survives a
 * user switch, gives `User=`/`OnBootSec`/`Persistent=` first-class homes, and
 * `Persistent=true` fires a missed run on next boot. This mirrors the
 * `/etc/cron.d/hindsight-watch` idioms (tmp+rename, mode 0644, idempotent
 * compare, absolute-binary guard, refuse-root operator resolution) rather than
 * inventing a new install mechanism — see `hindsight-watch/install-cron.ts`.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Where the oneshot service unit lands. */
export const SERVICE_PATH = "/etc/systemd/system/switchroom-self-heal.service";

/** Where the timer unit lands. */
export const TIMER_PATH = "/etc/systemd/system/switchroom-self-heal.timer";

/** The unit name systemd enables/schedules. */
export const TIMER_UNIT = "switchroom-self-heal.timer";

/**
 * The canonical marker that the host is systemd-booted. `sd_booted(3)` is
 * defined as "the `/run/systemd/system/` directory exists"; presence of the
 * `systemctl` binary is not sufficient (it exists on non-systemd containers).
 */
export const SYSTEMD_MARKER = "/run/systemd/system";

const DOC_URL =
  "https://github.com/switchroom/switchroom/blob/main/docs/operators/host-cli-self-heal.md";

export interface UnitRenderOptions {
  /** Absolute path to the `switchroom` binary the tick runs. */
  binary: string;
  /** Unix user the tick runs as — the operator, never root. */
  user: string;
  /**
   * The operator's home dir, if resolvable. When present it is pinned as
   * `Environment=HOME=` (belt-and-braces — systemd already sets `$HOME` from
   * the account database for `User=`, but pinning it makes the unit legible and
   * robust to a passwd without a home field). Omitted when unresolved.
   */
  home?: string;
}

/**
 * Render the oneshot `.service` unit.
 *
 * Pure, so the exact bytes that land in `/etc/systemd/system` are asserted in a
 * unit test rather than discovered in production. Pins:
 *  - **`Type=oneshot`** — a run-to-completion tick, not a daemon.
 *  - **`User=<operator>`** — `switchroom update` reads `$HOME/.switchroom`;
 *    running it as root would read root's empty home and no-op forever.
 *  - **`ExecStart=<binary> update --skip-images`** — self-heals the host binary
 *    (self-update-cli still runs) without pulling images on a healthy tick.
 *  - **`TimeoutStartSec` / `Nice`** — self-heal must never wedge the host.
 */
export function renderService(opts: UnitRenderOptions): string {
  const homeLine = opts.home ? `Environment=HOME=${opts.home}\n` : "";
  return (
    `# switchroom host CLI self-heal — keeps /usr/local/bin/switchroom from silently\n` +
    `# trailing the fleet. Managed by \`switchroom update\`; edits are overwritten.\n` +
    `[Unit]\n` +
    `Description=Switchroom host CLI self-heal (re-run \`switchroom update\` so the host binary can't silently trail the fleet)\n` +
    `Documentation=${DOC_URL}\n` +
    `After=network-online.target docker.service\n` +
    `Wants=network-online.target\n` +
    `\n` +
    `[Service]\n` +
    `Type=oneshot\n` +
    `# Run as the operator whose ~/.switchroom holds the fleet config — NOT root.\n` +
    `User=${opts.user}\n` +
    homeLine +
    `# --skip-images keeps each tick cheap: self-update-cli (the host binary swap)\n` +
    `# still runs; GHCR pulls and container recreation do not.\n` +
    `ExecStart=${opts.binary} update --skip-images\n` +
    `# Self-heal must never wedge the host: bound the run and run at low priority.\n` +
    `TimeoutStartSec=600\n` +
    `Nice=10\n`
  );
}

/**
 * Render the `.timer` unit. Pure. Pins the cadence the doc and the incident
 * arithmetic were derived against: first run 5 min after boot, then every 30
 * min, jittered so a fleet of hosts does not hit the GitHub release API in
 * lockstep, and `Persistent=true` so a missed run (host off) fires on next boot.
 */
export function renderTimer(): string {
  return (
    `# switchroom host CLI self-heal timer. Managed by \`switchroom update\`.\n` +
    `[Unit]\n` +
    `Description=Run the Switchroom host CLI self-heal every 30 minutes\n` +
    `Documentation=${DOC_URL}\n` +
    `\n` +
    `[Timer]\n` +
    `OnBootSec=5min\n` +
    `OnUnitActiveSec=30min\n` +
    `RandomizedDelaySec=2min\n` +
    `Persistent=true\n` +
    `\n` +
    `[Install]\n` +
    `WantedBy=timers.target\n`
  );
}

/** Write `content` to `path` idempotently (tmp+rename, mode 0644). */
function writeUnitIdempotent(path: string, content: string): "written" | "unchanged" {
  if (existsSync(path)) {
    try {
      if (readFileSync(path, "utf8") === content) return "unchanged";
    } catch {
      // Unreadable but present — fall through and rewrite it.
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode: 0o644 });
  renameSync(tmp, path);
  return "written";
}

export interface InstallTimerDeps {
  env?: NodeJS.ProcessEnv;
  /** True when the host is systemd-booted. Default: `/run/systemd/system` exists. */
  systemdBooted?: () => boolean;
  /** Effective uid of the process. Default: `process.geteuid()` (undefined off-Linux). */
  geteuid?: () => number | undefined;
  /**
   * Resolve the operator's home dir for a username, or undefined. Default reads
   * `/etc/passwd`. Only used to pin `Environment=HOME=`.
   */
  homeForUser?: (user: string) => string | undefined;
  /**
   * Run a command (systemctl). Returns its exit status. Default: `spawnSync`.
   * Mirrors update.ts's injectable `runner` so the step is testable.
   */
  runner?: (cmd: string, args: string[]) => { status: number };
  /** Test seams for the unit paths. */
  servicePath?: string;
  timerPath?: string;
}

export type InstallTimerStatus = "installed" | "unchanged" | "skipped";

export interface InstallTimerResult {
  status: InstallTimerStatus;
  /** Present on `skipped` — why, for the operator message. */
  reason?: string;
  /** The resolved values (present when we got far enough to render). */
  servicePath: string;
  timerPath: string;
  serviceContent?: string;
  timerContent?: string;
  /** The two manual `systemctl` commands, always populated for the fallback. */
  manualCommands: string[];
}

/**
 * Best-effort resolve the operator's home from `/etc/passwd` (field 6). Returns
 * undefined on any read/parse failure — the caller then omits the HOME pin and
 * lets systemd fill `$HOME` from the account database.
 */
function homeFromPasswd(user: string): string | undefined {
  try {
    for (const line of readFileSync("/etc/passwd", "utf8").split("\n")) {
      const f = line.split(":");
      if (f[0] === user && f[5]) return f[5];
    }
  } catch {
    /* no passwd / unreadable — omit HOME */
  }
  return undefined;
}

/**
 * Resolve the operator username the SAME way the `hindsight-watch --install-cron`
 * / `--cron-user` logic does (install-cron callsite in hindsight-watch.ts:165):
 * `SUDO_USER` (the real user under `sudo switchroom update`) → `USER` → `LOGNAME`.
 * Root is refused — `switchroom update` as root reads root's empty `~/.switchroom`
 * and the tick would no-op forever, the exact failure this unit exists to close.
 */
export function resolveOperatorUser(env: NodeJS.ProcessEnv): string | null {
  const user = env.SUDO_USER ?? env.USER ?? env.LOGNAME;
  if (!user || user === "root") return null;
  return user;
}

/**
 * Arm the host-CLI self-heal timer.
 *
 * Idempotent and safe to call unconditionally from the host `switchroom update`
 * path: it writes both units, `daemon-reload`s, and `enable --now`s the timer
 * only when the host is **systemd-booted AND the process is privileged (euid 0)
 * AND a non-root operator user resolves**. Otherwise it writes NOTHING, does not
 * fail, and returns `skipped` with the exact unit contents + the two `systemctl`
 * commands so the operator can install it by hand (the non-systemd fallback the
 * doc describes). A re-run once installed is a byte-identical no-op.
 */
export function installSelfHealTimer(deps: InstallTimerDeps = {}): InstallTimerResult {
  const env = deps.env ?? process.env;
  const systemdBooted = deps.systemdBooted ?? (() => existsSync(SYSTEMD_MARKER));
  const geteuid =
    deps.geteuid ??
    (() => (typeof process.geteuid === "function" ? process.geteuid() : undefined));
  const homeForUser = deps.homeForUser ?? homeFromPasswd;
  const servicePath = deps.servicePath ?? SERVICE_PATH;
  const timerPath = deps.timerPath ?? TIMER_PATH;

  const binary = env.SWITCHROOM_BINARY ?? "/usr/local/bin/switchroom";
  const user = resolveOperatorUser(env);
  // Render with a best-effort user for the fallback message even when we skip.
  const renderUser = user ?? "OPERATOR";
  const home = user ? homeForUser(user) : undefined;
  const serviceContent = renderService({ binary, user: renderUser, ...(home ? { home } : {}) });
  const timerContent = renderTimer();
  const manualCommands = [
    "sudo systemctl daemon-reload",
    `sudo systemctl enable --now ${TIMER_UNIT}`,
  ];
  const base = { servicePath, timerPath, serviceContent, timerContent, manualCommands };

  // Guard 1: absolute binary. A relative/dev argv would produce an ExecStart
  // that fails on every fire with a message only in the journal.
  if (!binary.startsWith("/")) {
    return {
      status: "skipped",
      reason: `SWITCHROOM_BINARY must be an absolute path (got ${binary})`,
      ...base,
    };
  }

  // Guard 2: systemd must actually be the init system.
  if (!systemdBooted()) {
    return {
      status: "skipped",
      reason: "host is not systemd-booted (/run/systemd/system absent)",
      ...base,
    };
  }

  // Guard 3: writing /etc/systemd/system + systemctl need root.
  if (geteuid() !== 0) {
    return { status: "skipped", reason: "not privileged (euid != 0)", ...base };
  }

  // Guard 4: a resolvable non-root operator user — the same refusal the cron
  // install makes. Never blindly root.
  if (!user) {
    return {
      status: "skipped",
      reason:
        "no non-root operator user resolvable (SUDO_USER / USER / LOGNAME all unset or root)",
      ...base,
    };
  }

  const svc = writeUnitIdempotent(servicePath, serviceContent);
  const tim = writeUnitIdempotent(timerPath, timerContent);
  const changed = svc === "written" || tim === "written";

  const runner =
    deps.runner ??
    ((cmd: string, args: string[]) => {
      const r = spawnSync(cmd, args, { stdio: "inherit" });
      return { status: r.status ?? 1 };
    });

  // daemon-reload picks up written/changed unit bytes; enable --now is
  // idempotent (systemd no-ops an already-enabled+active timer) so we always
  // run it — it's how a previously-disabled timer gets re-armed on re-run.
  const reload = runner("systemctl", ["daemon-reload"]);
  if (reload.status !== 0) {
    throw new Error(`systemctl daemon-reload failed (exit ${reload.status})`);
  }
  const enable = runner("systemctl", ["enable", "--now", TIMER_UNIT]);
  if (enable.status !== 0) {
    throw new Error(`systemctl enable --now ${TIMER_UNIT} failed (exit ${enable.status})`);
  }

  return { status: changed ? "installed" : "unchanged", ...base };
}
