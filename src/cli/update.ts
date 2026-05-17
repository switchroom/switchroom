/**
 * `switchroom update` — bundle the host-update flow into one verb (#918).
 *
 * Pre-#918 the operator was told to invoke five commands across two
 * privilege levels:
 *
 *     git pull
 *     bun install
 *     npm run build
 *     sudo HOME=$HOME PATH=... bun /path/to/dist/cli/switchroom.js apply --non-interactive
 *     docker compose -p switchroom -f ~/.switchroom/compose/docker-compose.yml up -d
 *
 * Each had failure modes — the sudo invocation alone (#920) had three
 * — and operators who didn't memorize the incantation got things half
 * deployed. `update` runs them in order, with idempotent skip-if-fresh
 * checks where possible and clean failure surfacing on each step.
 *
 * Steps (in order):
 *   1. Pull docker images (broker, kernel, agent) from GHCR.
 *   2. (--rebuild only) git pull upstream main + bun install + npm run build.
 *   3. switchroom apply (self-elevates via #920 if needed).
 *   4. docker compose up -d --remove-orphans (recreates containers
 *      whose image digest or compose entry changed).
 *   5. switchroom doctor — surface any FAIL diagnostics post-bounce.
 *
 * Flags:
 *   --check          dry-run; print the steps that would run, exit 0.
 *   --skip-images    skip step 1 (offline mode).
 *   --rebuild        run step 2 (source-checkout users; auto-skipped
 *                    when not in a git repo).
 *
 * Legacy `--phase=post-build` is still accepted as a no-op so any
 * in-flight v0.6 → v0.7 self-reexec path doesn't crash mid-flight.
 */
import { Option, type Command } from "commander";
import chalk from "chalk";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { loadConfig } from "../config/loader.js";
import { writeRestartReasonMarker } from "../agents/lifecycle.js";

interface UpdateOptions {
  check?: boolean;
  skipImages?: boolean;
  rebuild?: boolean;
  /** Read-only mode: report current version + image/container state without
   *  invoking any update steps. Wired by Telegram /upgrade-status (#927). */
  status?: boolean;
  /** JSON output (currently only honored under --status). */
  json?: boolean;
  /** Hidden / legacy flags — kept so v0.6-era invocations don't crash. */
  phase?: string;
  force?: boolean;
  /** Compose-file override for tests. */
  composePath?: string;
  /** stdout/stderr writers for tests. */
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  /** Test seam — replace step.run with a fake. */
  runner?: (cmd: string, args: string[]) => { status: number };
  /** Test seam — replace docker inspect / package.json reads. */
  statusProbe?: (composePath: string) => StatusReport;
  /** Test seam — supply the agent name list for the stamp-restart-marker
   *  step instead of reading from switchroom.yaml. */
  agentNamesFn?: () => readonly string[];
  /** Test seam — replace the bundled-skills sync (default: real cpSync to
   *  `~/.switchroom/skills/_bundled/`). Tests override to a no-op so
   *  the step doesn't write into the developer's HOME. */
  syncBundledSkillsFn?: () => void;
  /** Test seam — replace the marker writer used by stamp-restart-marker. */
  writeMarkerFn?: (agent: string, reason: string) => void;
  /** Test seam — override `host_control.enabled` detection for the
   *  `refresh-hostd` step instead of reading from switchroom.yaml. */
  hostControlEnabled?: boolean;
  /** One-shot release-channel override (mirrors `apply --channel`). */
  channel?: "dev" | "rc" | "latest";
  /** One-shot release-pin override (mirrors `apply --pin`). Mutually
   *  exclusive with `channel`. */
  pin?: string;
}

interface UpdateStep {
  name: string;
  description: string;
  /** When true, step is skipped entirely (e.g. --skip-images). */
  skipReason?: string;
  /** Invoked when not in --check mode. Throws on failure. */
  run: () => void;
}

const DEFAULT_COMPOSE_PATH = join(
  homedir(),
  ".switchroom",
  "compose",
  "docker-compose.yml",
);

/**
 * Detect whether the running CLI lives inside a git checkout (so
 * `--rebuild` is meaningful) or is an installed binary (where a git
 * pull would be nonsensical).
 */
export function isGitCheckout(scriptPath: string): boolean {
  let dir = dirname(scriptPath);
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, ".git"))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
  return false;
}

/**
 * Build the ordered list of update steps. Pure function — no side
 * effects. The action handler iterates this list and either prints
 * (--check) or executes (default).
 */
export function planUpdate(opts: UpdateOptions): UpdateStep[] {
  const composePath = opts.composePath ?? DEFAULT_COMPOSE_PATH;
  const runner = opts.runner ?? defaultRunner;
  const scriptPath = process.argv[1] ?? "";
  const steps: UpdateStep[] = [];

  // When --channel / --pin is set, the resolved image tag in compose
  // needs to change BEFORE pull-images runs (so `docker compose pull`
  // grabs the right tag). Inject a pre-pull `apply --compose-only`
  // step that regenerates the compose with the override applied; the
  // main apply-config step below then re-runs apply with the full
  // scaffold sweep + the same override for consistency.
  const releaseOverrideArgs: string[] = [];
  if (opts.channel) releaseOverrideArgs.push("--channel", opts.channel);
  if (opts.pin) releaseOverrideArgs.push("--pin", opts.pin);
  if (releaseOverrideArgs.length > 0) {
    steps.push({
      name: "regen-compose-for-release-override",
      description:
        "Regenerate compose with the --channel/--pin override so pull-images grabs the right tag",
      run: () => {
        const r = runner(process.execPath, [
          scriptPath,
          "apply",
          "--compose-only",
          "--non-interactive",
          ...releaseOverrideArgs,
        ]);
        if (r.status !== 0) {
          throw new Error("regen-compose-for-release-override failed");
        }
      },
    });
  }

  steps.push({
    name: "pull-images",
    description: "Pull broker / kernel / agent images from GHCR",
    skipReason: opts.skipImages
      ? "--skip-images flag set"
      : !existsSync(composePath)
        ? `compose file not found at ${composePath} (run \`switchroom apply --compose-only\` first)`
        : undefined,
    run: () => {
      const r = runner("docker", [
        "compose", "-p", "switchroom", "-f", composePath, "pull",
      ]);
      if (r.status !== 0) throw new Error("docker compose pull failed");
    },
  });

  // Source-checkout step. Only added when --rebuild is explicit. If
  // the user passed --rebuild but the CLI isn't running from a git
  // checkout, the runUpdate dispatcher will fail loudly — the explicit
  // flag is treated as a hard intent, not a hint we can quietly drop
  // (#923 reviewer feedback).
  if (opts.rebuild) {
    steps.push({
      name: "rebuild-source",
      description: "git pull upstream main + bun install + npm run build",
      run: () => {
        if (!isGitCheckout(scriptPath)) {
          throw new Error(
            `--rebuild requires a git checkout, but the CLI is running ` +
            `from ${scriptPath} which has no .git ancestor (looks like ` +
            `an installed binary). Drop --rebuild or invoke from a ` +
            `source checkout.`,
          );
        }
        // CWD matters: git/bun/npm run from process.cwd(). Operator
        // is expected to invoke `update --rebuild` from inside the
        // checkout. We don't chdir on their behalf because they may
        // have multiple worktrees and we shouldn't guess which.
        const pull = runner("git", ["pull", "--ff-only", "upstream", "main"]);
        if (pull.status !== 0) throw new Error("git pull failed");
        const install = runner("bun", ["install"]);
        if (install.status !== 0) throw new Error("bun install failed");
        const build = runner("npm", ["run", "build"]);
        if (build.status !== 0) throw new Error("npm run build failed");
      },
    });
  }

  steps.push({
    name: "apply-config",
    description: "switchroom apply — refresh per-agent scaffolds + compose",
    run: () => {
      // Re-exec ourselves to invoke the apply subcommand. apply will
      // self-elevate via #920 if needed. --no-doctor: apply-side
      // post-scaffold doctor sweep (#929) is suppressed because
      // update has its own doctor step at position 5; running it
      // twice would produce identical output ~3s apart and read as
      // a broken pipeline.
      const r = runner(process.execPath, [
        scriptPath,
        "apply",
        "--non-interactive",
        "--no-doctor",
        ...releaseOverrideArgs,
      ]);
      if (r.status !== 0) throw new Error("switchroom apply failed");
    },
  });

  // refresh-hostd: pull the latest hostd image and recreate the daemon
  // container. RFC C §5.1 keeps the daemon in its own compose project
  // (`switchroom-hostd`, separate from the agent fleet's `switchroom`
  // project) so the fleet's `up -d --remove-orphans` cycles can't
  // accidentally recreate the daemon mid-RPC. The downside is that the
  // daemon doesn't get pulled by the fleet's pull-images step — so
  // before this step existed, operators who ran `switchroom update`
  // after a hostd protocol bump would end up with a stale daemon
  // serving an old verb set. Phase 2 (#1208) shipped new verbs but the
  // daemon container kept refusing them with
  // `invalid_union_discriminator` until the operator separately ran
  // `switchroom hostd install`. This step folds that into the update.
  //
  // Skipped when host_control.enabled is false (no daemon to refresh)
  // OR --skip-images is set (operator opted out of pulls in general).
  // Mirrors how pull-images skips on --skip-images.
  let hostControlEnabled: boolean;
  if (typeof opts.hostControlEnabled === "boolean") {
    hostControlEnabled = opts.hostControlEnabled;
  } else {
    try {
      hostControlEnabled = loadConfig().host_control?.enabled === true;
    } catch {
      // Best-effort: if config can't be loaded, skip refresh-hostd
      // rather than fail the whole update. Operators who care about
      // hostd will hit the config error somewhere else in the pipeline.
      hostControlEnabled = false;
    }
  }
  steps.push({
    name: "refresh-hostd",
    description:
      "switchroom hostd install — pull latest hostd image + recreate the daemon container (separate compose project, see RFC C §5.1)",
    skipReason: !hostControlEnabled
      ? "host_control.enabled is not true — daemon not in use"
      : opts.skipImages
        ? "--skip-images flag set"
        : undefined,
    run: () => {
      const r = runner(process.execPath, [scriptPath, "hostd", "install"]);
      if (r.status !== 0) throw new Error("switchroom hostd install failed");
    },
  });

  // Stamp a clean-shutdown marker for every agent BEFORE the compose
  // recreate. Without this, the gateway boots after the recreate, finds
  // no marker, falls through `determineRestartReason()` to the
  // gateway-session.json branch, and reads `'crash'` — every operator
  // update is then rendered as `boot card reason=crash` + an
  // `agent-crashed` operator-events broadcast, even though the restart
  // was planned. Mirrors what `switchroom restart` already does at
  // src/cli/restart.ts:93 and what the in-gateway `/restart` / `/new` /
  // `/reset` verbs do via stampUserRestartReason. Reason text uses an
  // `operator:` prefix so the boot card can silence the notification
  // for this class of restart (boot-card.ts handles the disable_
  // notification path).
  //
  // Clobber semantics (#1141 review item C): the docker-exec path
  // writes unconditionally — it does NOT honour the 30s preserve-
  // existing window that `writeRestartReasonMarker` enforces from the
  // host. Intentional: `switchroom update` is the more recent and more
  // aggressive operator intent, and the recreate is going to subsume
  // any in-flight `/restart` anyway. The boot-card silence then
  // correctly attributes the planned redeploy to the operator. The
  // host-side fallback below DOES use preserveExisting: true so
  // systemd-runtime hosts retain the original /restart-race guard.
  // Sync the shipped skills/ payload to the host-stable pool dir at
  // `~/.switchroom/skills/_bundled/`. The runtime resolvers (reconcile-
  // default-skills, scaffold.installSwitchroomSkills, cli/deps) all
  // read from there, so this step is what makes default-skill symlinks
  // resolve correctly across dev, packaged, and docker installs
  // (RCA: #1164). Prune-and-replace: delete existing `_bundled/`, then
  // recursive copy.
  steps.push({
    name: "sync-bundled-skills",
    description:
      "Sync shipped skills/ to ~/.switchroom/skills/_bundled/ (host-stable pool dir).",
    run: () => {
      if (opts.syncBundledSkillsFn) {
        opts.syncBundledSkillsFn();
        return;
      }
      // SOURCE: the skills/ directory shipped alongside the running
      // CLI bundle. `import.meta.dirname` is dist/cli/ at runtime; the
      // skills/ payload lives two levels up beside dist/ (see package
      // .json "files" — skills/ is shipped). This is the only place
      // the legacy `resolve(import.meta.dirname, "../../skills")`
      // expression is still correct, because here it really IS the
      // source for the copy.
      const source = resolve(import.meta.dirname, "../../skills");
      const dest = join(homedir(), ".switchroom", "skills", "_bundled");
      if (!existsSync(source)) {
        process.stderr.write(
          `switchroom update: sync-bundled-skills — CLI bundle has no adjacent skills/ at ${source}; skipping.\n`,
        );
        return;
      }
      try {
        if (existsSync(dest)) {
          rmSync(dest, { recursive: true, force: true });
        }
        mkdirSync(dirname(dest), { recursive: true });
        cpSync(source, dest, { recursive: true, dereference: false });
      } catch (err) {
        throw new Error(
          `sync-bundled-skills failed: ${(err as Error).message}`,
        );
      }
    },
  });

  steps.push({
    name: "stamp-restart-marker",
    description:
      'Write a clean-shutdown marker for every agent (reason="operator: switchroom update") so the post-recreate boot card renders as graceful rather than crash',
    run: () => {
      const reason = "operator: switchroom update";
      // The default writer prefers `docker exec` for running containers
      // (correct path under Docker runtime — the bind-mounted state dir
      // is UID-owned by the agent, not the host operator, so a direct
      // host-side write fails with EACCES and `writeRestartReasonMarker`'s
      // best-effort catch silently swallows it). Falls back to the host-
      // side writer when the container isn't running or the runtime is
      // systemd (then the gateway runs under the host operator's UID
      // and the host write succeeds). Tests override via writeMarkerFn.
      const writeMarker = opts.writeMarkerFn ?? ((agent, r) =>
        writeMarkerInPreferredLocation(agent, r, runner));
      let agents: readonly string[];
      try {
        agents = opts.agentNamesFn ? opts.agentNamesFn() : Object.keys(loadConfig().agents);
      } catch (err) {
        // Best-effort: if config can't be loaded we don't want to fail
        // the whole update. The recreate will still proceed and the
        // boot card will fall back to `crash` — same behaviour as
        // before this step existed.
        process.stderr.write(
          `switchroom update: stamp-restart-marker — could not load agent list (${(err as Error).message}); skipping\n`,
        );
        return;
      }
      for (const agent of agents) {
        try {
          writeMarker(agent, reason);
        } catch (err) {
          process.stderr.write(
            `switchroom update: stamp-restart-marker — ${agent}: ${(err as Error).message}\n`,
          );
        }
      }
    },
  });

  steps.push({
    name: "recreate-containers",
    description:
      "docker compose up -d --remove-orphans (recreates services with new images / compose)",
    // No skipReason: apply-config (the prior step) regenerates compose
    // and per-agent scaffolds even with --skip-images. If the operator
    // added/removed/renamed an agent and we skipped recreate, the
    // running fleet would be out of sync with on-disk compose. Up-d
    // is cheap and idempotent — if nothing changed it's a no-op
    // (#923 reviewer feedback).
    run: () => {
      const r = runner("docker", [
        "compose", "-p", "switchroom", "-f", composePath, "up", "-d",
        "--remove-orphans",
      ]);
      if (r.status !== 0) throw new Error("docker compose up failed");
    },
  });

  steps.push({
    name: "doctor",
    description: "switchroom doctor — surface post-bounce diagnostics",
    run: () => {
      // Doctor returns non-zero on findings; don't propagate that as
      // an update failure (the update succeeded; the diagnostics are
      // informational). Just print and continue.
      runner(process.execPath, [scriptPath, "doctor"]);
    },
  });

  return steps;
}

function defaultRunner(cmd: string, args: string[]): { status: number } {
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  return { status: r.status ?? 1 };
}

/**
 * Write the clean-shutdown marker for `agent` with `reason`. Tries
 * `docker exec switchroom-<agent> ...` first, falling back to the
 * host-side writer when the container isn't running OR docker isn't
 * available (systemd-runtime hosts).
 *
 * Why two paths?
 *
 *   - Under the Docker runtime the per-agent state dir is bind-mounted
 *     into the container and chowned to the agent's UID. The host
 *     operator running `switchroom update` is a different UID with no
 *     write permission, so a direct `writeFileSync` from the host fails
 *     with EACCES. `writeRestartReasonMarker` already wraps that in a
 *     best-effort catch — meaning the host CLI looked like it succeeded
 *     while no marker was actually written, and every operator-initiated
 *     update therefore booted as `reason=crash` even with the PR #1139
 *     stamp-step in the plan. The docker-exec path runs *inside* the
 *     container as the agent UID and writes through to the same
 *     bind-mounted file, which the post-recreate gateway reads on boot.
 *
 *   - Under the systemd runtime the gateway runs under the host
 *     operator's UID — there's no bind-mount, the host writer is the
 *     correct path, and docker isn't necessarily installed at all. So
 *     we fall back transparently.
 *
 * Returns silently on success. Throws on failure; the caller's
 * try/catch logs and continues so a single agent's failure doesn't
 * block the update for the rest of the fleet.
 */
function writeMarkerInPreferredLocation(
  agent: string,
  reason: string,
  runner: (cmd: string, args: string[]) => { status: number },
): void {
  const ts = Date.now();
  const markerJson = JSON.stringify({ ts, signal: "SIGTERM", reason });
  // `sh -c` lets us redirect inside the container without needing tee
  // or a here-doc. The path is `/state/agent/telegram/clean-shutdown.
  // json` — the in-container view of the same file the host writer
  // would target (`~/.switchroom/agents/<name>/telegram/...`) via the
  // compose bind-mount.
  //
  // Quoting: we wrap the JSON payload in single quotes for the shell.
  // JSON's grammar escapes `"`, `\`, and control chars, but `'`
  // (U+0027) passes through literally. Today's marker fields are all
  // hardcoded primitives (numeric `ts`, the literal "SIGTERM" signal,
  // the literal "operator: switchroom update" reason) so there's no
  // apostrophe risk in this PR. Even so, we POSIX-escape the payload
  // (`'` → `'\''`) defensively — if a future caller routes user-
  // derived text through the reason field, the escape keeps the shell
  // wrapping safe instead of silently breaking the redirect. (#1141
  // review.)
  const shellSafeJson = markerJson.replace(/'/g, "'\\''");
  const cmd = `printf '%s' '${shellSafeJson}' > /state/agent/telegram/clean-shutdown.json`;
  const dockerExec = runner("docker", [
    "exec",
    `switchroom-${agent}`,
    "sh",
    "-c",
    cmd,
  ]);
  if (dockerExec.status === 0) return;
  // Docker exec failed — the container isn't running, the runtime is
  // systemd, docker is unavailable, OR the container is running but
  // its rootfs lacks `sh` / `/state/agent/telegram/` doesn't exist yet
  // (brand-new agent pre-first-boot). Logged so operators have a
  // breadcrumb when the boot card still reads `crash` after an update.
  // Fall through to the host-side writer which works correctly under
  // systemd (and harmlessly no-ops under Docker via the EACCES catch
  // in writeRestartReasonMarker — same behaviour as pre-#1139). (#1141
  // review item B/E.)
  process.stderr.write(
    `switchroom update: stamp-restart-marker — ${agent}: docker exec failed ` +
    `(status=${dockerExec.status}); falling back to host writer\n`,
  );
  writeRestartReasonMarker(agent, reason, { preserveExisting: true });
}

// ─── --status mode (#927) ────────────────────────────────────────────────
//
// Read-only snapshot of "where this host stands" for the operator who
// wants to know whether they should run `update`. Wired by Telegram
// /upgrade-status — the bot command is one line: shell `switchroom
// update --status` and post the output.
//
// Intentional v1 limitation: does NOT query upstream (GitHub API) for
// commits-ahead/behind. Adding that needs gh auth, network, and
// per-host opt-in. Instead, the operator can `/update` (dry-run) which
// shows what `docker compose pull` would change. Filed as a follow-up.

export interface ServiceState {
  name: string;
  image: string | null;          // e.g. "ghcr.io/switchroom/switchroom-agent:latest"
  imageDigestShort: string | null; // first 12 of the image's content hash
  imagePulledAt: string | null;  // ISO ts, when the image's local pull happened
  containerCreatedAt: string | null; // ISO ts, when the running container was started
  status: string;                // "running" | "exited" | "<unknown>"
}

export interface StatusReport {
  cliVersion: string;
  cliBuiltAt: string | null;     // ISO ts (mtime of the running script)
  services: ServiceState[];
  /** Soft warnings — e.g. compose missing, docker unreachable. Render-only. */
  warnings: string[];
}

/**
 * Map a compose service name to the container_name the generator
 * emits. Compose conventions in `src/agents/compose.ts`:
 *
 *   - `agent-<name>`             → `switchroom-<name>`
 *   - `vault-broker`             → `switchroom-vault-broker`
 *   - `approval-kernel`          → `switchroom-approval-kernel`
 *   - `switchroom-auth-broker`   → `switchroom-auth-broker` (already prefixed)
 *
 * The auth-broker service name is already prefixed in the compose
 * generator (RFC H §4.1), so we don't double-prefix it. Any future
 * service that decides to live under the `switchroom-` namespace at
 * service-name level (rather than via prefix at container_name level)
 * is picked up the same way.
 *
 * @internal exported for testing
 */
export function serviceToContainerName(svc: string): string {
  if (svc.startsWith("agent-")) return `switchroom-${svc.slice("agent-".length)}`;
  if (svc.startsWith("switchroom-")) return svc;
  return `switchroom-${svc}`;
}

/**
 * Probe the host for current update state. No side effects. Heavy on
 * docker shellouts but each is bounded by spawnSync's default timeout.
 */
function defaultStatusProbe(composePath: string): StatusReport {
  const warnings: string[] = [];

  // CLI version + build time. Walk up from process.argv[1] looking
  // for package.json (covers both bun-run-dev and installed paths).
  let cliVersion = "unknown";
  let cliBuiltAt: string | null = null;
  try {
    // Resolve symlinks first — `~/.bun/bin/switchroom` is typically a
    // symlink to `dist/cli/switchroom.js` inside the workspace
    // checkout. Walking up from the symlink's argv[1] would land in
    // `~/.bun/bin/` which has no package.json ancestor (#938 reviewer).
    const rawScriptPath = process.argv[1] ?? "";
    let scriptPath = rawScriptPath;
    try {
      if (rawScriptPath) scriptPath = realpathSync(rawScriptPath);
    } catch { /* nothing to do — fall back to raw argv[1] */ }

    if (scriptPath) {
      // Use mtime of the resolved script as the "built at" time —
      // portable across BSD/macOS/Linux unlike the prior `stat -c %Y`
      // shellout (#938 reviewer).
      try {
        cliBuiltAt = new Date(statSync(scriptPath).mtimeMs).toISOString();
      } catch { /* nothing to do */ }

      // Walk up from the script's directory looking for package.json.
      // 8 levels is generous — the deepest realistic path is
      // workspace/dist/cli/switchroom.js → 3 levels.
      let dir = dirname(scriptPath);
      for (let i = 0; i < 8; i++) {
        const pkgPath = join(dir, "package.json");
        if (existsSync(pkgPath)) {
          try {
            // Direct ESM read — was previously `require("node:fs")`
            // which is undefined under true ESM and threw silently
            // (#938 reviewer blocker). readFileSync now in the
            // top-of-file import.
            const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string };
            if (typeof pkg.version === "string") cliVersion = pkg.version;
          } catch (err) {
            warnings.push(
              `read ${pkgPath} failed: ${(err as Error).message}`,
            );
          }
          break;
        }
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
  } catch (err) {
    warnings.push(`CLI version probe failed: ${(err as Error).message}`);
  }
  if (cliVersion === "unknown") {
    // Inner probes have their own try/catch; surface a single
    // diagnostic when they all bottom out so 'CLI: unknown' is never
    // silent (#938 reviewer concern C3).
    warnings.push(
      "could not resolve CLI version (no package.json found above the resolved script path)",
    );
  }

  // Docker probe — list services from compose, then docker inspect each.
  const services: ServiceState[] = [];
  if (!existsSync(composePath)) {
    warnings.push(`compose file not found at ${composePath}; service status unknown`);
    return { cliVersion, cliBuiltAt, services, warnings };
  }
  let serviceList: string[] = [];
  try {
    const r = spawnSync(
      "docker",
      ["compose", "-p", "switchroom", "-f", composePath, "config", "--services"],
      { encoding: "utf-8", timeout: 10_000 },
    );
    if (r.status !== 0) {
      warnings.push(`docker compose config --services failed: ${r.stderr?.trim() ?? r.error?.message ?? "unknown"}`);
      return { cliVersion, cliBuiltAt, services, warnings };
    }
    serviceList = r.stdout.split("\n").map((s) => s.trim()).filter(Boolean).sort();
  } catch (err) {
    warnings.push(`docker not reachable: ${(err as Error).message}`);
    return { cliVersion, cliBuiltAt, services, warnings };
  }

  for (const svc of serviceList) {
    const containerName = serviceToContainerName(svc);
    let image: string | null = null;
    let containerCreatedAt: string | null = null;
    let status = "<unknown>";
    try {
      const r = spawnSync(
        "docker",
        ["inspect", "-f", "{{.Config.Image}}|{{.Created}}|{{.State.Status}}", containerName],
        { encoding: "utf-8", timeout: 5_000 },
      );
      if (r.status === 0) {
        const [img, created, st] = r.stdout.trim().split("|");
        image = img ?? null;
        containerCreatedAt = created ?? null;
        status = st ?? "<unknown>";
      } else {
        status = "absent";
      }
    } catch { status = "<probe failed>"; }

    let imageDigestShort: string | null = null;
    let imagePulledAt: string | null = null;
    if (image) {
      try {
        const r = spawnSync(
          "docker",
          ["image", "inspect", "-f", "{{.Id}}|{{.Created}}|{{.Metadata.LastTagTime}}", image],
          { encoding: "utf-8", timeout: 5_000 },
        );
        if (r.status === 0) {
          const [id, created, lastTag] = r.stdout.trim().split("|");
          imageDigestShort = id?.replace(/^sha256:/, "").slice(0, 12) ?? null;
          // LastTagTime is when this tag was last bumped locally
          // (i.e. when `docker pull` last brought a newer image
          // under this tag). Falls back to image Created if absent.
          imagePulledAt = lastTag && lastTag !== "0001-01-01T00:00:00Z" ? lastTag
            : (created ?? null);
        }
      } catch { /* nothing to do */ }
    }

    services.push({
      name: svc,
      image,
      imageDigestShort,
      imagePulledAt,
      containerCreatedAt,
      status,
    });
  }

  return { cliVersion, cliBuiltAt, services, warnings };
}

function formatRelative(iso: string | null, now: number = Date.now()): string {
  if (!iso) return "<unknown>";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "<unparseable>";
  const ageSec = Math.max(0, Math.floor((now - t) / 1000));
  if (ageSec < 60) return `${ageSec}s ago`;
  if (ageSec < 3600) return `${Math.floor(ageSec / 60)}m ago`;
  if (ageSec < 86400) return `${Math.floor(ageSec / 3600)}h ago`;
  return `${Math.floor(ageSec / 86400)}d ago`;
}

function formatStatusReport(rep: StatusReport): string {
  const lines: string[] = [];
  lines.push(`Switchroom on this host`);
  lines.push("");
  lines.push(`CLI: ${rep.cliVersion}` + (rep.cliBuiltAt
    ? ` (built ${formatRelative(rep.cliBuiltAt)})`
    : ""));
  lines.push("");
  if (rep.services.length === 0) {
    lines.push("Services: <none reachable>");
  } else {
    lines.push("Services:");
    const maxNameLen = Math.max(...rep.services.map((s) => s.name.length));
    for (const s of rep.services) {
      const namePad = s.name.padEnd(maxNameLen);
      const containerAge = formatRelative(s.containerCreatedAt);
      const imageAge = formatRelative(s.imagePulledAt);
      const digest = s.imageDigestShort ? `[${s.imageDigestShort}]` : "[?]";
      lines.push(
        `  ${namePad}  ${s.status.padEnd(8)}  ${digest}  pulled ${imageAge}  container ${containerAge}`,
      );
    }
  }
  if (rep.warnings.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    for (const w of rep.warnings) lines.push(`  ⚠ ${w}`);
  }
  lines.push("");
  lines.push(`Run \`switchroom update --check\` to see what an update would do, or \`/update\` from Telegram.`);
  return lines.join("\n");
}

async function runUpdate(opts: UpdateOptions): Promise<number> {
  const stdout = opts.stdout ?? ((s) => process.stdout.write(s));
  const stderr = opts.stderr ?? ((s) => process.stderr.write(s));

  // --status: read-only snapshot, no plan execution. Wired by Telegram
  // /upgrade-status (#927). JSON output for machine readers; human
  // output otherwise.
  if (opts.status) {
    const composePath = opts.composePath ?? DEFAULT_COMPOSE_PATH;
    const probe = opts.statusProbe ?? defaultStatusProbe;
    const report = probe(composePath);
    if (opts.json) {
      stdout(JSON.stringify(report, null, 2) + "\n");
    } else {
      stdout(formatStatusReport(report) + "\n");
    }
    return 0;
  }
  if (opts.json) {
    // --json without --status is unsupported (the apply / pull / up
    // pipeline streams human output; piping JSON through a multi-step
    // shellout is not coherent). Fail loud rather than silently
    // ignoring (#938 reviewer nit).
    stderr(chalk.red(
      "--json is only honored under --status. Drop --json or add --status.\n",
    ));
    return 2;
  }

  const steps = planUpdate(opts);

  if (opts.check) {
    stdout(chalk.bold("switchroom update --check (dry-run)\n\n"));
    for (const step of steps) {
      const status = step.skipReason
        ? chalk.gray(`[skip] ${step.skipReason}`)
        : chalk.green("[run]");
      stdout(`  ${status} ${step.name} — ${step.description}\n`);
    }
    stdout("\nDry-run only; nothing was changed. Re-run without --check to apply.\n");
    return 0;
  }

  for (const step of steps) {
    if (step.skipReason) {
      stdout(chalk.gray(`▸ ${step.name}: skipped (${step.skipReason})\n`));
      continue;
    }
    stdout(chalk.bold(`▸ ${step.name}\n`));
    try {
      step.run();
    } catch (err) {
      stderr(
        chalk.red(`✗ ${step.name} failed: ${(err as Error).message}\n`),
      );
      return 1;
    }
  }
  stdout(chalk.green("\n✓ update complete\n"));
  return 0;
}

export function registerUpdateCommand(program: Command): void {
  program
    .command("update")
    .description(
      "Update switchroom on this host: pull images, refresh scaffolds, recreate containers. Wraps the full `pull && apply && up -d` flow.",
    )
    .option("--check", "Dry-run: print the steps that would execute, exit 0.")
    .option("--skip-images", "Skip the docker image pull (offline mode).")
    .option(
      "--rebuild",
      "Source-checkout users: also git pull + bun install + npm run build before applying. Auto-skipped when the CLI is an installed binary.",
    )
    .option(
      "--status",
      "Read-only snapshot: report local CLI version, image digest + pull time, container creation time per service. Does NOT invoke any update steps. Wired by Telegram /upgrade-status (#927).",
    )
    .option(
      "--json",
      "Output as JSON (currently only honored under --status; other modes ignore).",
    )
    .addOption(
      new Option(
        "--channel <c>",
        "Override the resolved release block for this update run: follow the named channel (dev|rc|latest). Mutually exclusive with --pin.",
      ).choices(["dev", "rc", "latest"]).conflicts("pin"),
    )
    .addOption(
      new Option(
        "--pin <p>",
        "Override the resolved release block for this update run: pin to a specific build (sha-<7-40 hex> or v<semver>). Mutually exclusive with --channel.",
      ).conflicts("channel"),
    )
    // Legacy v0.6 flags — accepted as no-ops so a stale operator
    // muscle-memory invocation doesn't crash. The --phase=post-build
    // path was the in-flight v0.6→v0.7 self-reexec; that's dead now,
    // exit 0 with a hint instead of trying to do anything.
    .option("--force", "[legacy v0.6 no-op]")
    .option("--no-restart", "[legacy v0.6 no-op]")
    .option("--resume <file>", "[legacy v0.6 no-op]")
    .option("--phase <phase>", "[legacy v0.6 no-op]")
    .action(async (opts: UpdateOptions) => {
      // Defensive pin-regex validation (commander's choices() handles
      // --channel; --pin is a free-form string at the parser layer).
      if (opts.pin && !/^(sha-[0-9a-f]{7,40}|v\d+\.\d+\.\d+)$/.test(opts.pin)) {
        console.error(
          chalk.red(
            `--pin "${opts.pin}" is invalid. Expected sha-<7-40 hex> or v<semver>.`,
          ),
        );
        process.exit(2);
      }
      if (opts.phase === "post-build") {
        console.warn(
          chalk.yellow(
            "switchroom update --phase=post-build: legacy v0.6 self-reexec path. " +
            "v0.7+ handles this end-to-end via `update` proper; nothing to do.",
          ),
        );
        process.exit(0);
      }
      const code = await runUpdate(opts);
      process.exit(code);
    });
}

export {
  runUpdate,
  defaultRunner,
  defaultStatusProbe,
  formatStatusReport,
  formatRelative,
  DEFAULT_COMPOSE_PATH,
};
