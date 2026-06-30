/**
 * `switchroom hostd` — install / status / uninstall the host-control
 * daemon (RFC C Phase 1.5).
 *
 * The daemon is the host-side broker for admin agents' privileged
 * operations (agent_restart, upgrade_status, get_status today; the six
 * deferred verbs in Phase 2). Phase 1 (#1175) shipped the library and
 * protocol; Phase 1.5 (this verb) packages the daemon as its own
 * docker container, running in a SEPARATE compose project
 * (`switchroom-hostd`) so the agent fleet's `compose up -d
 * --remove-orphans` cycle cannot recreate the daemon mid-call.
 *
 * Subcommands:
 *   install    — write ~/.switchroom/hostd/docker-compose.yml + start
 *   status     — show daemon state + bound sockets
 *   uninstall  — stop the daemon container (leaves the sibling
 *                compose file on disk for re-install)
 *
 * Idempotent: `install` re-writes the compose template every time
 * (operator hand-edits get backed up to `docker-compose.yml.bak-<ts>`)
 * and re-runs `compose up -d`. Safe to call repeatedly.
 */

import type { Command } from "commander";
import chalk from "chalk";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { getConfig, withConfigError } from "./helpers.js";
import { resolveOperatorUid } from "./operator-uid.js";
import { resolveImageTag, resolveRelease, type ReleaseBlockShape } from "../config/release-resolve.js";
import { checkDowngrade } from "./deploy-version-guard.js";
import { removeStaleContainerIfNeeded } from "./singleton-stale-cleanup.js";
import {
  defaultAuditLogPath,
  formatForCli,
  readAndFilter,
} from "../host-control/audit-reader.js";
import { detectServerTimezone } from "../config/timezone.js";

/**
 * Resolve the hostd image tag for an install.
 *
 * Precedence (highest first), mirroring how the agent-fleet generator
 * resolves its tag (`write-compose.ts` → `resolveImageTag(resolveRelease(...))`):
 *   1. explicit `--tag <X>` (operator override)
 *   2. `release.pin` / `release.channel` from switchroom.yaml
 *   3. `latest` (resolveImageTag's back-compat default)
 *
 * Before this, `hostd install` hardcoded `latest` and ignored
 * `release.pin` — so after a release the singleton lagged the fleet
 * (the agents/brokers honor the pin, hostd didn't), and a plain
 * `hostd install` right after a tag push could land the PRIOR image
 * because `:latest` promotion lags the version-tag build. Honoring the
 * pin makes hostd version-coherent with the rest of the fleet by
 * default. See memory `feedback_singletons_dont_recreate_on_pin_bump`.
 */
export function resolveHostdImageTag(
  explicitTag: string | undefined,
  release: ReleaseBlockShape | undefined,
): string {
  if (explicitTag) return explicitTag;
  return resolveImageTag(resolveRelease({ root: release }));
}

/**
 * Capture the host timezone at `hostd install` time and return it as a
 * `SWITCHROOM_HOST_TZ` value to bake into the hostd container env.
 *
 * This runs on the HOST (where `/etc/timezone` and `/etc/localtime`
 * reflect the real operator locale), NOT inside a container. The captured
 * value flows into the hostd compose template's `environment:` block so
 * that when hostd later shells out `switchroom apply` (in-container),
 * `detectServerTimezone()` reads `SWITCHROOM_HOST_TZ` first and gets the
 * correct zone rather than the container's `Etc/UTC` default.
 *
 * Mirrors the `SWITCHROOM_HOST_HOME` pattern: a host-side fact that would
 * be wrong if read from inside the container is captured once at install
 * time and baked in.
 *
 * Returns undefined when the host has no discernible timezone (e.g. a
 * minimal CI image with no tzdata) — the caller omits the env var and
 * detectServerTimezone falls through to the UTC hard-fallback warning,
 * prompting the operator to set `timezone:` in their yaml.
 *
 * Exposed for tests; production callers pass no arguments (real probes).
 */
export function captureHostTimezone(
  opts: {
    readEtcTimezone?: () => string | undefined;
    readLocaltimeLink?: () => string | undefined;
    /** Override process.env so the function never accidentally picks up a
     *  pre-existing SWITCHROOM_HOST_TZ from the caller's environment. */
    env?: NodeJS.ProcessEnv;
  } = {},
): string | undefined {
  // detectServerTimezone is the canonical probe; pass an empty env so a
  // pre-existing SWITCHROOM_HOST_TZ in the caller's env doesn't short-circuit
  // the real host probes (we WANT to re-read the host files here).
  return detectServerTimezone({
    readEtcTimezone: opts.readEtcTimezone,
    readLocaltimeLink: opts.readLocaltimeLink,
    env: opts.env ?? {},
  });
}

/**
 * Compose project name for the daemon. MUST be distinct from
 * `switchroom` (the agent-fleet project) so a `compose -p switchroom
 * up -d --remove-orphans` cycle cannot recreate this container
 * mid-RPC. See RFC C §5.1.
 */
const HOSTD_COMPOSE_PROJECT = "switchroom-hostd";

/**
 * Render the sibling compose file. Pure-string template — the only
 * variable is the host home directory (for the bind mounts that map
 * `~/.switchroom` and `/var/run/docker.sock` into the daemon).
 */
export function renderHostdComposeFile(opts: {
  hostHome: string;
  imageTag: string;
  /** Host operator UID — hostd chowns its operator socket to this so
   *  the host-shell (`switchroom doctor`, …) can connect. Omitted →
   *  the operator listener simply isn't bound (same posture as the
   *  vault-broker). */
  operatorUid?: number;
  /**
   * Host IANA timezone (e.g. "Australia/Melbourne"), captured at install
   * time by `captureHostTimezone()`. Baked into the container as
   * `SWITCHROOM_HOST_TZ` so that `switchroom apply` running INSIDE the
   * hostd container (which has Etc/UTC as its own /etc/localtime) can
   * detect the correct host zone via `detectServerTimezone()`.
   *
   * Omitted when the host has no discernible timezone — detectServerTimezone
   * will fall through to the UTC fallback warning, prompting the operator.
   */
  hostTz?: string;
}): string {
  const { hostHome, imageTag, operatorUid, hostTz } = opts;
  const operatorUidEnv =
    operatorUid !== undefined
      ? `\n      # Hostd chowns ~/.switchroom/hostd/operator/sock to this so the\n      # host operator's \\\`switchroom doctor\\\` (et al.) can connect; the\n      # rest of hostd is only reachable agent→hostd. Mirrors\n      # SWITCHROOM_BROKER_OPERATOR_UID.\n      SWITCHROOM_HOSTD_OPERATOR_UID: "${operatorUid}"`
      : "";
  const hostTzEnv =
    hostTz !== undefined && hostTz.length > 0
      ? `\n      # Host timezone captured at \`switchroom hostd install\` time.\n      # When hostd shells out \`switchroom apply\` (inside this container,\n      # whose /etc/localtime → Etc/UTC), detectServerTimezone() reads this\n      # first and gets the real host zone. Same principle as SWITCHROOM_HOST_HOME.\n      SWITCHROOM_HOST_TZ: "${hostTz}"`
      : "";
  return `# AUTO-GENERATED by \`switchroom hostd install\` — do not hand-edit.
# Edits land at \`switchroom hostd install\` time; backed up to
# docker-compose.yml.bak-<ts> on overwrite.
#
# Separate compose project (\`switchroom-hostd\`) from the agent fleet
# (\`switchroom\`) so \`compose up -d --remove-orphans\` against the fleet
# cannot recreate this daemon mid-RPC. See RFC C §5.1.

services:
  hostd:
    image: ghcr.io/switchroom/switchroom-hostd:${imageTag}
    container_name: switchroom-hostd
    restart: always
    user: "0:0"
    # tini handles SIGTERM forwarding; node's main.ts shutdown handler
    # closes UDS listeners and exits cleanly. 15s grace matches the
    # in-process \`TimeoutStopSec\` and is enough for in-flight async
    # \`agent_restart\` shellouts to finish or be force-killed.
    stop_grace_period: 15s
    cap_drop:
      - ALL
    cap_add:
      # CHOWN: agent-uid ownership on the per-agent socket files.
      # DAC_OVERRIDE: required so the daemon (uid 0 inside-container)
      # can mkdir into bind-mounted operator-owned host dirs.
      # FOWNER: chmod the socket files even when their owner mismatches
      # the EUID temporarily mid-bind.
      - CHOWN
      - DAC_OVERRIDE
      - FOWNER
    security_opt:
      - no-new-privileges:true
    volumes:
      # Bind-mounts the entire ~/.switchroom dir so the daemon can:
      #   - create ~/.switchroom/hostd/<agent>/sock per agent
      #   - append to ~/.switchroom/host-control-audit.log
      - ${hostHome}/.switchroom:/host-home/.switchroom:rw
      # ~/.switchroom/switchroom.yaml is a symlink on many operator
      # setups (typically into a separate config repo so it's git-
      # tracked). The previous bind mount preserves the symlink AS a
      # symlink inside the container with a target path that doesn't
      # resolve there. Mounting the file directly forces docker to
      # follow the symlink at mount time and bind the underlying file
      # to the container path. Mirrors how the agent containers expose
      # the config (also at /state/config/switchroom.yaml) — but RW here,
      # not ro: hostd is the SANCTIONED config writer (config_propose_edit
      # applies an operator-approved diff in place via O_RDWR). With :ro the
      # write fails EROFS and every config_propose_edit rolls back
      # (E_RECONCILE_FAILED_ROLLED_BACK) — agents could never amend the yaml.
      # Agents themselves still mount it ro; only hostd, the tap-gated writer,
      # gets rw. The in-place writer preserves the file's owner/mode.
      - ${hostHome}/.switchroom/switchroom.yaml:/state/config/switchroom.yaml:rw
      # docker.sock is the whole reason hostd exists — agents shouldn't
      # have it, but hostd (auditing every shell-out via run-hook.sh's
      # pattern) is the controlled chokepoint.
      - /var/run/docker.sock:/var/run/docker.sock:rw
      # /etc/machine-id passthrough — the vault auto-unlock blob
      # (~/.switchroom/vault-auto-unlock) is encrypted with a key derived
      # from the host machine-id. Without this mount, readAutoUnlockFile
      # inside switchroom apply (called by rollout) cannot derive the
      # decryption key, resolveOperatorVaultPassphrase returns null, LiteLLM
      # provisioning fails for all agents, and rollout stops at apply.
      # Same mount the vault-broker compose carries (compose.ts:1364).
      - /etc/machine-id:/etc/machine-id:ro
    environment:
      # Hostd resolves homedir() to set the per-agent socket dir; pin
      # it inside the container to /host-home (which bind-mounts to the
      # operator's home), so the socket paths the agent fleet sees
      # (~/.switchroom/hostd/<agent>/sock) match the paths hostd binds.
      HOME: /host-home
      # The REAL host home path. HOME above is pinned to /host-home (the
      # in-container mount point) for the socket-path convention, but that
      # is NOT a host filesystem path. When hostd shells out \`switchroom
      # apply\` / \`agent restart\`, the compose generator must emit HOST
      # paths as bind-mount SOURCES — homedir() inside here returns
      # /host-home, which docker would auto-create as empty dirs on the
      # host (start.sh missing → every agent exec-fails 127; broker EISDIR
      # — the 2026-06-11/12 fleet outages). SWITCHROOM_HOST_HOME is the
      # generator's authoritative host home (write-compose.ts prefers it
      # over homedir(); compose.ts bakes it into each agent). Without it,
      # an in-container apply poisons every bind source with /host-home AND
      # re-bakes /host-home into the fleet, self-perpetuating.
      SWITCHROOM_HOST_HOME: ${hostHome}
      # Hostd's CLI shellouts (\`switchroom <verb>\`) need to pick up the
      # same config the agent fleet's compose generator did. Point at
      # the resolved /state/config bind so the agent fleet's config-path
      # convention is also what hostd reads.
      SWITCHROOM_CONFIG: /state/config/switchroom.yaml${operatorUidEnv}${hostTzEnv}
      # PATH must include /usr/local/bin (for the switchroom shim)
      # and docker plugin paths (apt installs to /usr/libexec/docker/cli-plugins).
      PATH: /usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
    networks:
      - default

networks:
  default:
    name: switchroom-hostd-net

# Healthcheck deferred to Phase 2 follow-up — needs a hostd verb that
# returns OK without spawning the switchroom CLI (or a separate
# /healthz endpoint). For now, \`switchroom hostd status\` is the
# operator surface; the daemon's stderr lands in \`docker logs switchroom-hostd\`.
`;
}

/**
 * Resolve the REAL host home for the hostd compose bind sources.
 *
 * Mirrors `write-compose.ts` (the agent-fleet generator, fixed in #2279):
 * prefer `SWITCHROOM_HOST_HOME` over `homedir()`. `hostd install` regenerates
 * its OWN compose; when the regen runs INSIDE the hostd container (the
 * `/update apply` → refresh-hostd path), `homedir()` returns `/host-home` —
 * the in-container mount point of the operator home that hostd pins `HOME` to,
 * NOT a host filesystem path. Emitting it as a bind SOURCE makes Docker
 * auto-create empty `/host-home/...` dirs on the host, so the config mount is
 * empty → hostd crash-loops on `ConfigError`, and the poison value re-bakes
 * into the new compose's `SWITCHROOM_HOST_HOME`, self-perpetuating.
 *
 * #2279 fixed this for the agent fleet but left `hostd install` on bare
 * `homedir()`. This closes that gap. The backstop refuses to ever emit a
 * `/host-home` source — fail loud with the recovery path instead of writing a
 * compose that crash-loops the daemon.
 */
export function resolveHostdHostHome(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const fromEnv = env.SWITCHROOM_HOST_HOME?.trim();
  const resolved = fromEnv && fromEnv.length > 0 ? fromEnv : home;
  if (resolved === "/host-home" || resolved.startsWith("/host-home/")) {
    throw new Error(
      `switchroom hostd install: refusing to generate — the host home resolved to ` +
        `"${resolved}", the in-container mount point of the operator home (never a valid ` +
        `host bind source). Emitting it would make Docker create empty /host-home dirs on ` +
        `the host and crash-loop hostd on a missing config mount.\n\n` +
        `Recovery: run \`switchroom hostd install\` from the HOST shell (not inside the ` +
        `hostd container), or set SWITCHROOM_HOST_HOME to the real host home first.`,
    );
  }
  return resolved;
}

function hostdDir(): string {
  return join(homedir(), ".switchroom", "hostd");
}

function hostdComposePath(): string {
  return join(hostdDir(), "docker-compose.yml");
}

function backupExistingCompose(): string | null {
  const p = hostdComposePath();
  if (!existsSync(p)) return null;
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const bak = `${p}.bak-${ts}`;
  copyFileSync(p, bak);
  return bak;
}

function runDocker(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync("docker", args, { encoding: "utf8" });
  return {
    ok: r.status === 0,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

interface InstallOptions {
  tag?: string;
  dryRun?: boolean;
  allowDowngrade?: boolean;
}

async function doInstall(opts: InstallOptions, program: Command): Promise<void> {
  const cfg = getConfig(program);
  if (cfg.host_control?.enabled !== true) {
    console.error(
      chalk.yellow(
        "host_control.enabled is not true in switchroom.yaml. The daemon will exit on startup until it is.\n" +
          "Add to switchroom.yaml:\n\n" +
          "    host_control:\n" +
          "      enabled: true\n\n" +
          "Continuing anyway — the install completes (image-pinned compose file written), but \`docker compose up\` will fail-fast.",
      ),
    );
  }

  const allAgents = Object.keys(cfg.agents ?? {});
  if (allAgents.length === 0) {
    console.error(
      chalk.yellow(
        "No agents in switchroom.yaml. The daemon binds one socket per agent — with none, it will exit on startup.\n" +
          "Add at least one agent before installing hostd.",
      ),
    );
  }

  const dir = hostdDir();
  const composePath = hostdComposePath();
  mkdirSync(dir, { recursive: true });

  // Default to the release pin from switchroom.yaml (version-coherent with
  // the agent fleet); `--tag` overrides; `latest` if neither is set.
  const imageTag = resolveHostdImageTag(opts.tag, cfg.release);

  // Downgrade guard: refuse to revert a newer running hostd build (the
  // concurrent-rollout revert hazard). A no-op skip, not an error.
  const guard = checkDowngrade({
    container: "switchroom-hostd",
    targetTag: imageTag,
    allowDowngrade: opts.allowDowngrade,
  });
  if (guard.skip) {
    console.log(chalk.yellow(`  ⏭  ${opts.dryRun ? "[dry-run] " : ""}${guard.message}`));
    return;
  }

  // Capture the host timezone NOW (running on the host, where
  // /etc/timezone / /etc/localtime are correct) and bake it into the
  // hostd container env as SWITCHROOM_HOST_TZ. When hostd later runs
  // `switchroom apply` in-container (whose /etc/localtime → Etc/UTC),
  // detectServerTimezone() reads SWITCHROOM_HOST_TZ first and gets the
  // correct zone. Mirrors SWITCHROOM_HOST_HOME. Returns undefined on a
  // host with no tzdata — the compose env block simply omits the var.
  const hostTz = captureHostTimezone();
  if (!hostTz) {
    console.warn(
      chalk.yellow(
        "  ⚠ Could not detect host timezone — /etc/timezone and /etc/localtime are absent or unrecognised.\n" +
          '    Add `timezone: "Region/City"` to switchroom.yaml to set the zone explicitly.',
      ),
    );
  }

  const yaml = renderHostdComposeFile({
    hostHome: resolveHostdHostHome(),
    imageTag,
    // SUDO_UID-aware (install often runs under sudo); undefined on
    // non-POSIX → operator listener simply not bound.
    operatorUid: resolveOperatorUid(),
    hostTz,
  });

  if (opts.dryRun) {
    console.log(chalk.dim(`# Would write: ${composePath}`));
    console.log(yaml);
    console.log(chalk.dim(`# Would run: docker compose -p ${HOSTD_COMPOSE_PROJECT} -f ${composePath} up -d`));
    return;
  }

  const bak = backupExistingCompose();
  if (bak) console.log(chalk.dim(`  Backed up existing compose to ${bak}`));

  writeFileSync(composePath, yaml, "utf8");
  console.log(chalk.green(`  ✓ Wrote ${composePath}`));
  const adminAgents = Object.entries(cfg.agents ?? {})
    .filter(([, a]) => a?.admin === true)
    .map(([name]) => name);
  console.log(
    chalk.dim(
      `    agents served (one socket each): ${allAgents.length === 0 ? "(none)" : allAgents.join(", ")}`,
    ),
  );
  console.log(
    chalk.dim(
      `    admin agents (full config-edit verbs): ${adminAgents.length === 0 ? "(none)" : adminAgents.join(", ")}`,
    ),
  );

  // Pull, then up. We pull explicitly so a pull failure (network
  // glitch, GHCR throttle) surfaces before the up step rather than
  // mid-restart-cycle. `docker compose pull` is idempotent and
  // skips images already at the requested digest.
  console.log(chalk.dim(`    Pulling ghcr.io/switchroom/switchroom-hostd:${imageTag}…`));
  const pull = runDocker(["compose", "-p", HOSTD_COMPOSE_PROJECT, "-f", composePath, "pull"]);
  if (!pull.ok) {
    console.error(chalk.red(`  pull failed:\n${pull.stderr}`));
    console.error(
      chalk.yellow(
        `  Hint: \`ghcr.io/switchroom/switchroom-hostd:${imageTag}\` may not be published yet.\n` +
          `  Check the docker-images workflow run and verify the tag at:\n` +
          `      https://github.com/switchroom/switchroom/pkgs/container/switchroom-hostd`,
      ),
    );
    process.exit(1);
  }

  // Stale-container reconciliation: if a container named switchroom-hostd
  // exists under a DIFFERENT compose project (e.g. old containerized-path
  // install), `compose up` would try to CREATE (not RECREATE) it and fail
  // with a name conflict. Remove the stale container first so the create
  // succeeds. Idempotent and logged. See singleton-stale-cleanup.ts.
  removeStaleContainerIfNeeded("switchroom-hostd", HOSTD_COMPOSE_PROJECT, (line) =>
    console.log(chalk.dim(line)),
  );

  console.log(chalk.dim(`    Bringing up daemon…`));
  const up = runDocker(["compose", "-p", HOSTD_COMPOSE_PROJECT, "-f", composePath, "up", "-d"]);
  if (!up.ok) {
    console.error(chalk.red(`  up failed:\n${up.stderr}`));
    process.exit(1);
  }
  console.log(chalk.green(`  ✓ Daemon running (project: ${HOSTD_COMPOSE_PROJECT})`));
  console.log(chalk.dim(`    Logs: docker logs switchroom-hostd --tail 50`));
  console.log(chalk.dim(`    Verify: switchroom hostd status`));
}

function doStatus(): void {
  // Three signals: image presence, container state, bound sockets.
  const dir = hostdDir();
  const composeYml = hostdComposePath();

  console.log(chalk.bold("switchroom-hostd"));
  console.log("");

  // 1. compose template installed?
  if (!existsSync(composeYml)) {
    console.log(chalk.yellow("  compose:    not installed"));
    console.log(chalk.dim("              run \`switchroom hostd install\` to set up."));
    return;
  }
  console.log(chalk.green(`  compose:    ${composeYml}`));

  // 2. container running?
  const ps = runDocker([
    "compose",
    "-p",
    HOSTD_COMPOSE_PROJECT,
    "-f",
    composeYml,
    "ps",
    "--format",
    "{{.Name}} {{.Status}} {{.Image}}",
  ]);
  if (!ps.ok || !ps.stdout.trim()) {
    console.log(chalk.yellow("  container:  not running"));
  } else {
    console.log(chalk.green(`  container:  ${ps.stdout.trim()}`));
  }

  // 3. bound sockets — these come from the daemon writing to the
  // bind-mounted host dir. Listing dir contents is a host-side probe
  // that does NOT round-trip the daemon, so it works even if the
  // daemon is wedged.
  if (existsSync(dir)) {
    const entries: string[] = [];
    try {
      for (const name of readdirSync(dir)) {
        if (name === "docker-compose.yml" || name.startsWith("docker-compose.yml.")) continue;
        const sockPath = join(dir, name, "sock");
        if (existsSync(sockPath)) {
          const st = statSync(sockPath);
          // 0o140000 is the file-type bits for a socket. Filter so
          // operator junk (regular files / dirs) in the hostd dir
          // doesn't pollute the report.
          if ((st.mode & 0o170000) === 0o140000) {
            entries.push(`${name} → ${sockPath}`);
          }
        }
      }
    } catch {
      // best-effort — dir read failures fall through to "(none)"
    }
    if (entries.length === 0) {
      console.log(chalk.yellow("  sockets:    (none bound)"));
    } else {
      console.log(chalk.green("  sockets:"));
      for (const e of entries) console.log(`              ${e}`);
    }
  }
}

function doUninstall(): void {
  const composeYml = hostdComposePath();
  if (!existsSync(composeYml)) {
    console.log(chalk.yellow("  No hostd install detected (no compose file at this path)."));
    return;
  }
  console.log(chalk.dim(`  Stopping ${HOSTD_COMPOSE_PROJECT}…`));
  const down = runDocker(["compose", "-p", HOSTD_COMPOSE_PROJECT, "-f", composeYml, "down"]);
  if (!down.ok) {
    console.error(chalk.red(`  down failed:\n${down.stderr}`));
    process.exit(1);
  }
  console.log(chalk.green("  ✓ Daemon stopped"));
  console.log(chalk.dim(`    Compose file left in place at ${composeYml}`));
  console.log(chalk.dim(`    To re-enable: switchroom hostd install`));
}

export function registerHostdCommand(program: Command): void {
  const hostd = program
    .command("hostd")
    .description(
      "Manage switchroom-hostd, the host-control daemon for admin agents (RFC C)",
    );

  hostd
    .command("install")
    .description("Install or refresh the hostd container (writes ~/.switchroom/hostd/docker-compose.yml + docker compose up -d)")
    .option(
      "--tag <tag>",
      "Image tag override (default: resolved from release.pin in switchroom.yaml, else latest)",
    )
    .option("--dry-run", "Print the compose file and the docker commands without writing or running anything")
    .option(
      "--allow-downgrade",
      "Deploy even if the running container is on a newer version (overrides the anti-revert guard)",
    )
    // withConfigError is a higher-order wrapper (helpers.ts:9) — it
    // accepts a handler and RETURNS a function that catches ConfigError
    // and exits cleanly. The returned function is what gets registered
    // as the action handler. The initial commit of this verb mistakenly
    // did `await withConfigError(async () => {...})` inside doInstall —
    // that awaits the returned wrapper (which is itself a function,
    // not a Promise), so the body NEVER ran and `switchroom hostd
    // install` produced zero output / exit 0. Fix: apply
    // withConfigError at the .action() boundary like every other verb.
    .action(
      withConfigError(async (opts: InstallOptions) => {
        await doInstall(opts, program);
      }),
    );

  hostd
    .command("status")
    .description("Show daemon state and bound sockets")
    .action(() => doStatus());

  hostd
    .command("uninstall")
    .description("Stop the hostd container. Leaves the compose file in place for re-install.")
    .action(() => doUninstall());

  // `switchroom hostd audit` — tail/filter the audit log of privileged-
  // verb calls. Read-only (does not call hostd itself); the audit log is
  // append-only JSONL at ~/.switchroom/host-control-audit.log.
  hostd
    .command("audit")
    .description("Tail and filter the hostd audit log (privileged-verb call history)")
    .option("--tail <n>", "Number of matching entries to show (default: 50)", "50")
    .option("--agent <name>", "Filter to a specific caller agent")
    .option("--op <verb>", "Filter to a specific hostd verb (e.g. update_apply, agent_restart)")
    .option("--error", "Show only failed (error/denied) entries")
    .option("--verbose", "Show the captured stderr / error tail under each failed row")
    .option("--path <file>", "Override audit log path (for debugging)")
    .action((opts: {
      tail?: string;
      agent?: string;
      op?: string;
      error?: boolean;
      verbose?: boolean;
      path?: string;
    }) => {
      const logPath = opts.path ?? defaultAuditLogPath();
      if (!existsSync(logPath)) {
        console.error(
          chalk.yellow(`Audit log not found at ${logPath}.`) +
            chalk.gray(
              "\nThe log is created when hostd handles its first privileged-verb request.",
            ),
        );
        return;
      }
      const raw = readFileSync(logPath, "utf-8");
      const limit = Math.max(1, parseInt(opts.tail ?? "50", 10) || 50);
      const filters = {
        agent: opts.agent,
        op: opts.op,
        errorOnly: !!opts.error,
      };
      const entries = readAndFilter(raw, filters, limit);
      if (entries.length === 0) {
        const parts: string[] = [];
        if (opts.agent) parts.push(`agent=${opts.agent}`);
        if (opts.op) parts.push(`op=${opts.op}`);
        if (opts.error) parts.push("errors-only");
        const desc = parts.length > 0 ? ` matching ${parts.join(", ")}` : "";
        console.log(chalk.dim(`No hostd audit entries${desc}.`));
        return;
      }
      const header =
        "ts".padEnd(20) +
        " " +
        "caller".padEnd(15) +
        " " +
        "op".padEnd(16) +
        " " +
        "result".padEnd(10) +
        " " +
        "exit".padStart(3) +
        " " +
        "dur".padStart(8);
      console.log(chalk.dim(header));
      console.log(chalk.dim("─".repeat(header.length)));
      for (const line of formatForCli(entries, { verbose: !!opts.verbose })) {
        if (line.startsWith("    ")) {
          console.log(chalk.dim(line));
        } else if (line.includes(" error ") || line.includes(" denied ")) {
          console.log(chalk.red(line));
        } else if (line.includes(" started ")) {
          console.log(chalk.yellow(line));
        } else {
          console.log(line);
        }
      }
      console.log();
      console.log(
        chalk.dim(
          `${entries.length} entr${entries.length === 1 ? "y" : "ies"} shown` +
            (entries.length === limit ? ` (--tail ${limit})` : "") +
            `  ·  log: ${logPath}`,
        ),
      );
    });
}
