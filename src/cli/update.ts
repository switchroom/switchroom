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
 *   --rebuild        run step 2. Source-checkout / maintainer only —
 *                    HARD-REFUSED (exit 2) on a published install,
 *                    which is told to use `npm i -g switchroom@latest
 *                    && switchroom update` instead. Refusal is a
 *                    preflight: nothing runs before it fires.
 *
 * Legacy `--phase=post-build` is still accepted as a no-op so any
 * in-flight v0.6 → v0.7 self-reexec path doesn't crash mid-flight.
 */
import { Option, type Command } from "commander";
import chalk from "chalk";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, chownSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { loadConfig, findConfigFile } from "../config/loader.js";
import { writeRestartReasonMarker } from "../agents/lifecycle.js";
import { composeEnvFileArgs } from "../agents/compose-env.js";
import { setReleasePinInConfig } from "./release-yaml.js";
import { resolveOperatorUid } from "./operator-uid.js";
import { writeConfigFileSync } from "../util/atomic.js";
import { validateBindSources, formatPreflightError } from "./preflight-mounts.js";
import { normalizeHindsightVersionTag } from "../setup/hindsight.js";
import { getBuiltinDefaultSkillEntries } from "../memory/scaffold-integration.js";
import { syncBundledSkills } from "./sync-bundled-skills.js";
import { SWITCHROOM_VERSION } from "./resolve-version.js";
import { observeHostCli } from "./host-cli-stamp.js";
import {
  alreadySelfUpdated,
  detectInstallKind,
  fetchLatestReleaseTag,
  installAssetPayload,
  performSelfUpdate,
  planSelfUpdate,
  releaseAssetName,
  SELF_UPDATE_ENV_SENTINEL,
  type InstallKind,
  type SelfUpdateIO,
} from "./self-update.js";
import {
  SKILLS_ASSET,
  describeShippedAssetSearch,
  resolveShippedAsset,
  type ShippedAssetProbe,
} from "../util/shipped-assets.js";
import { defaultSelfUpdateIO } from "./self-update-io.js";
import { resolveSelfInvocation } from "./self-invoke.js";
import {
  collectComponents,
  detectComponentDrift,
  formatComponentDrift,
  type ExecFn,
} from "./component-versions.js";
import { reconcileCron } from "../hindsight-watch/install-cron.js";
import {
  reconcileCron as reconcileConfigSyncCron,
  DEFAULT_INTERVAL_MINUTES as CONFIG_SYNC_DEFAULT_INTERVAL,
} from "../config-repo/install-cron.js";
import {
  installSelfHealTimer,
  type InstallTimerDeps,
} from "../host-cli-self-heal/install-timer.js";

/**
 * Default durable-pin persister for `update --pin`: comment-preserving,
 * atomic, ownership-restoring write of `release.pin` to switchroom.yaml.
 * Shares setReleasePinInConfig with `switchroom rollout --pin` so the two
 * `--pin` paths can't diverge. Returns a no-op closure on the resolved
 * config (or `configPath` override for tests).
 */
function defaultPersistPin(configPath?: string): (pin: string) => void {
  return (pin: string) => {
    const path = configPath ?? findConfigFile();
    const before = readFileSync(path, "utf8");
    const after = setReleasePinInConfig(before, pin);
    if (after === before) return; // idempotent no-op
    // Config-file write: tries atomic rename(2) first; falls back to
    // in-place rewrite on EBUSY/EXDEV/EINVAL (single-file bind mount
    // inside the hostd container rejects rename over the mount point).
    writeConfigFileSync(path, after, statSync(path).mode & 0o777);
    try {
      if (typeof process.geteuid === "function" && process.geteuid() === 0) {
        const uid = resolveOperatorUid();
        if (uid !== undefined) chownSync(path, uid, uid);
      }
    } catch {
      /* dev hosts may lack CAP_CHOWN — best-effort */
    }
  };
}

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
  /** Test seam — override the running-script path used by the
   *  `--rebuild` source-checkout guard and by the self-invocation
   *  resolver (default: process.argv[1]). */
  scriptPath?: string;
  /** Test seam — override `process.execPath` for the self-invocation
   *  resolver, so the compiled-binary spawn shape (#3963) is assertable
   *  without a real static binary. */
  execPath?: string;
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
  /** Test seam — override `web_service.managed` detection for the
   *  `refresh-web` step instead of reading from switchroom.yaml. */
  webServiceManaged?: boolean;
  /** Test seam — override `memory.backend === "hindsight"` detection for
   *  the `refresh-hindsight` step instead of reading from switchroom.yaml. */
  memoryBackendHindsight?: boolean;
  /** Test seam — override the resolved hindsight image pin tag threaded
   *  into `memory setup --recreate --tag <tag>` instead of resolving it
   *  from `--pin` / the persisted `release.pin`. An empty string forces
   *  the floating `:latest` path (no `--tag`). */
  hindsightPinTag?: string;
  /** One-shot release-channel override (mirrors `apply --channel`). */
  channel?: "dev" | "rc" | "latest";
  /** One-shot release-pin override (mirrors `apply --pin`). Mutually
   *  exclusive with `channel`. */
  pin?: string;
  /** Test seam — replace the durable release.pin persister used when
   *  `--pin` is set (default: comment-preserving atomic write to
   *  switchroom.yaml via setReleasePinInConfig). */
  persistPinFn?: (pin: string) => void;
  /** Config path for the default pin persister (default: resolved
   *  switchroom.yaml). Test seam. */
  configPath?: string;
  /**
   * True when this update run is driven by the hostd `update_apply` RPC
   * (i.e. the process was spawned with `SWITCHROOM_HOSTD_CONTEXT=1`).
   *
   * In this context the update driver CANNOT recreate the hostd container
   * (that would SIGKILL itself mid-run) or the web container (same compose
   * project risk). Both steps are given a `skipReason` so they are deferred
   * and the sentinel line at the end tells the server which steps were
   * deferred. The operator must finish those host-side via
   * `switchroom hostd install` / `webd install`.
   *
   * Default: auto-detected via `isHostdContext()` (checks
   * `process.env.SWITCHROOM_HOSTD_CONTEXT === "1"`). Test seam: supply
   * `true`/`false` explicitly to avoid touching the real process env.
   */
  hostdContext?: boolean;
  /**
   * Opt OUT of the host-CLI self-update step (#3919).
   *
   * DEFAULT IS ON, deliberately. `switchroom update`'s documented
   * contract is "update switchroom on this host"; a version of it that
   * silently leaves the CLI behind is the defect, not the feature. Making
   * whole-host update opt-IN would preserve the current drift for every
   * operator who never learns the flag — which is exactly how the CLI on
   * the reference host reached three releases of skew. So the scope
   * control is an opt-out, and `--check` names the step either way.
   */
  skipSelfUpdate?: boolean;
  /** Test seam — replace the self-update side effects. */
  selfUpdateIO?: SelfUpdateIO;
  /** Test seam — override the resolved latest published release tag
   *  (bypasses the GitHub round-trip). */
  latestReleaseTagFn?: () => Promise<string | null>;
  /** Test seam — override install-kind detection inputs. */
  installProbe?: Parameters<typeof detectInstallKind>[0];
  /** Test seam — override the layout probe `sync-bundled-skills` uses to
   *  find the shipped `skills/` payload. Lets a test simulate the SEA
   *  layout (bunfs bundle dir + no on-disk payload), which is otherwise
   *  unreachable from a vitest run. */
  shippedSkillsProbe?: ShippedAssetProbe;
  /** Test seam — exec used by the component-version inventory. */
  componentExec?: ExecFn;
  /**
   * Mutable sink the self-update step writes to when it replaces the
   * binary. `runUpdate` reads it and re-execs the NEW binary for the
   * remaining steps. A shared holder (rather than a throw / process.exit
   * inside the step) keeps `planUpdate` pure-ish and the re-exec
   * decision in one place.
   */
  selfUpdateSink?: { replacedWith?: string; binaryPath?: string };
  /**
   * Mutable sink for NON-FATAL step warnings. Same shared-holder pattern
   * as `selfUpdateSink`: a step that completed but could not do its whole
   * job pushes an operator-facing line here, and `runUpdate` reprints the
   * lot in the final summary. A degraded step must not look identical to
   * a clean one in the transcript (#4161).
   */
  warningSink?: string[];
  /** Test seam — replace the re-exec of the freshly installed binary. */
  reexecFn?: (binaryPath: string, args: string[]) => { status: number };
  /** Test seam — override the /etc/cron.d/hindsight-watch path the
   *  `reconcile-hindsight-watch-cron` step reconciles (default: the real
   *  `CRON_PATH`). Lets the step be exercised against a temp file. */
  watchCronPath?: string;
  /** Test seam — override the /etc/cron.d/switchroom-config-sync path the
   *  `reconcile-config-repo-cron` step reconciles (default: the real
   *  config-repo `CRON_PATH`). */
  configSyncCronPath?: string;
  /** Test seam — override the self-heal timer install for the
   *  `install-self-heal-timer` step (systemd/privilege/user/path shims).
   *  Default: the real host detection + `/etc/systemd/system` writes. */
  selfHealTimerDeps?: InstallTimerDeps;
}

interface UpdateStep {
  name: string;
  description: string;
  /** When true, step is skipped entirely (e.g. --skip-images). */
  skipReason?: string;
  /**
   * True when this step was deferred because the CLI is running inside the
   * hostd container and cannot recreate itself or its compose siblings.
   * Used as the machine-readable sentinel for the deferred-steps list —
   * prefer this over string-matching `skipReason`.
   */
  isHostdDeferred?: boolean;
  /** Invoked when not in --check mode. Throws on failure. */
  run: () => void | Promise<void>;
}

const DEFAULT_COMPOSE_PATH = join(
  homedir(),
  ".switchroom",
  "compose",
  "docker-compose.yml",
);

/**
 * Install kinds where the shipped asset payloads (`skills/`, `profiles/`,
 * `vendor/`) are part of the artifact itself. If one is missing on these,
 * the artifact is broken — the update must fail rather than tick a step
 * green it could not perform (#4161). `source-checkout` and `unknown` are
 * deliberately absent: a local layout without an adjacent `skills/` is
 * unusual but not a shipping defect, so those degrade to a surfaced
 * warning instead.
 */
const PACKAGED_INSTALL_KINDS: ReadonlySet<InstallKind> = new Set<InstallKind>([
  "static-binary",
  "npm-global",
  "container",
]);

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
 * True iff `scriptPath` runs from inside an actual **switchroom source
 * checkout** — a directory that has BOTH a `.git` (dir *or* file, so
 * git worktrees count) AND a `package.json` whose `name` is
 * `"switchroom"`, at the same level.
 *
 * Why not "any `.git` ancestor" (the old `isGitCheckout`): an
 * npm-global install commonly sits under `~/.nvm/...`, and **nvm
 * itself is a git clone** (`~/.nvm/.git` exists). A dotfiles `$HOME`
 * is often a git repo too. A bare `.git`-ancestor walk therefore
 * reports *every* nvm/npm-global install as a "checkout" so the
 * `--rebuild` guard never fired on the exact host it must protect
 * (this is the v0.12.2 defect). Requiring the switchroom
 * `package.json` at the *same* dir as the `.git` eliminates those
 * false positives: nvm/dotfiles `.git` dirs have no switchroom
 * package.json; an installed package dir has the package.json but no
 * `.git`.
 */
export function runningFromSwitchroomCheckout(scriptPath: string): boolean {
  let dir = dirname(scriptPath);
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, ".git"))) {
      try {
        const pkg = JSON.parse(
          readFileSync(join(dir, "package.json"), "utf-8"),
        ) as { name?: string };
        if (pkg.name === "switchroom") return true;
      } catch {
        /* no / invalid package.json at this .git level — keep walking */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

/**
 * `--rebuild` (git pull + bun install + npm run build) is a
 * **source-checkout / maintainer-only** operation. On a published
 * install (npm-global, /usr/local/bin, any non-checkout) building
 * from source is meaningless AND silently drifts the host off the
 * reviewed, CI-published release — the exact failure mode the
 * published-artifact model exists to prevent.
 *
 * Returns `null` when `--rebuild` is legitimate (running from a real
 * switchroom source checkout), or the operator-facing refusal message
 * otherwise. Exported so the preflight, the in-step defence-in-depth,
 * and unit tests all share one source of truth.
 */
export function rebuildRefusalMessage(scriptPath: string): string | null {
  if (runningFromSwitchroomCheckout(scriptPath)) return null;
  return (
    `--rebuild builds the CLI from a git checkout, but switchroom is ` +
    `running from "${scriptPath}" — not a switchroom source checkout ` +
    `(this is a published / installed copy). Rebuilding from source ` +
    `here would drift this host off the reviewed, CI-published ` +
    `release. Use the published path:\n` +
    `\n` +
    `  npm i -g switchroom@latest && switchroom update\n` +
    `\n` +
    `(\`--rebuild\` is for switchroom maintainers iterating on a source ` +
    `checkout — not for published installs.)`
  );
}

/**
 * True when the running update was spawned BY the hostd `update_apply`
 * RPC handler — hostd injects `SWITCHROOM_HOSTD_CONTEXT=1` into the
 * child's env to signal this. In that context the driver must NOT
 * recreate the hostd container (it would SIGKILL itself) or the web
 * container (same compose-project risk). Both steps are deferred and
 * the caller is expected to finish them host-side.
 *
 * Accepts the env as an optional arg so unit tests can exercise it
 * without mutating the real process env.
 *
 * Exported so the server and tests can import it directly.
 */
export function isHostdContext(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SWITCHROOM_HOSTD_CONTEXT === "1";
}

/**
 * The sentinel prefix emitted as the LAST stdout line by `runUpdate`
 * when one or more steps were deferred due to running in hostd-context
 * (#2458). The server parses this line to extract structured
 * `{ ok, deferred }` without scraping human output.
 *
 * Format: `SWITCHROOM_UPDATE_RESULT:<json>`
 */
export const UPDATE_RESULT_SENTINEL = "SWITCHROOM_UPDATE_RESULT:";

/**
 * Encode a `{ ok, deferred }` result into the sentinel line that
 * `runUpdate` emits and the server parses.
 */
export function encodeUpdateResultLine(payload: {
  ok: boolean;
  deferred: string[];
}): string {
  return `${UPDATE_RESULT_SENTINEL}${JSON.stringify(payload)}`;
}

/**
 * Parse the sentinel line from the captured stdout of a spawned update
 * driver. Returns `null` when the sentinel is absent (non-hostd-context
 * run, older driver) or malformed.
 *
 * Searches from the END of stdout so intermediate "SWITCHROOM_UPDATE_RESULT:"
 * substrings in step output can't shadow the final sentinel.
 */
export function parseUpdateResultLine(stdout: string): {
  ok: boolean;
  deferred: string[];
} | null {
  const idx = stdout.lastIndexOf(UPDATE_RESULT_SENTINEL);
  if (idx === -1) return null;
  const raw = stdout.slice(idx + UPDATE_RESULT_SENTINEL.length).split("\n")[0];
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "ok" in parsed &&
      "deferred" in parsed &&
      typeof (parsed as { ok: unknown }).ok === "boolean" &&
      Array.isArray((parsed as { deferred: unknown }).deferred)
    ) {
      return parsed as { ok: boolean; deferred: string[] };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve the hindsight image tag to pin the `refresh-hindsight` recreate
 * to (#2851), mirroring how `switchroom rollout` threads `--tag <target>`.
 *
 * `memory setup` never reads the durable `release.pin` (unlike compose /
 * `webd|hostd install`, whose tags resolve from it), so without an explicit
 * `--tag` the recreate pulls floating `:latest` and the memory singleton
 * silently drifts a version behind the pinned fleet — the v0.17.5 roll left
 * hindsight on `:latest` this way.
 *
 * Resolution order: an explicit `hindsightPinTag` override (test seam; empty
 * string forces the floating path) → nothing when a floating `--channel`
 * override is in play → this run's `--pin` → the already-persisted
 * `release.pin`. Only a concrete `vX.Y.Z` is returned, because the release
 * workflow publishes the hindsight image per version as `:vX.Y.Z`; a
 * `sha-…` pin (or no pin / unreadable config) yields `undefined` → floating
 * `:latest`, the standalone default. A bare `X.Y.Z` pin is normalized to the
 * canonical `vX.Y.Z` (via {@link normalizeHindsightVersionTag}) so this
 * gates identically to {@link hindsightImageRef}. Resolved lazily at run()
 * time so build-time step inspection stays free of config I/O.
 */
export function resolveHindsightPinTag(opts: UpdateOptions): string | undefined {
  if (typeof opts.hindsightPinTag === "string") {
    return opts.hindsightPinTag || undefined;
  }
  // A floating channel override has no fixed version — leave hindsight
  // floating too.
  if (opts.channel) return undefined;
  let candidate = opts.pin;
  if (!candidate) {
    try {
      candidate = loadConfig().release?.pin ?? undefined;
    } catch {
      // Best-effort: fall back to floating :latest rather than fail the
      // whole update if config can't be loaded.
      candidate = undefined;
    }
  }
  return normalizeHindsightVersionTag(candidate);
}

/**
 * Build the ordered list of update steps. Pure function — no side
 * effects. The action handler iterates this list and either prints
 * (--check) or executes (default).
 */
export function planUpdate(opts: UpdateOptions): UpdateStep[] {
  const composePath = opts.composePath ?? DEFAULT_COMPOSE_PATH;
  const runner = opts.runner ?? defaultRunner;
  const scriptPath = opts.scriptPath ?? process.argv[1] ?? "";
  const warningSink = opts.warningSink ?? [];
  // #3963: every self-invoking step below must NOT pass a compiled
  // binary's bunfs bundle path as argv[1] — the binary is its own
  // entrypoint and commander would parse the path as the subcommand.
  // See ./self-invoke.ts.
  const self = resolveSelfInvocation({
    execPath: opts.execPath ?? process.execPath,
    scriptPath,
  });
  const selfArgv = (...args: string[]): string[] => [...self.prefixArgs, ...args];
  const steps: UpdateStep[] = [];
  // Resolve whether we are running inside the hostd container. When true,
  // refresh-hostd and refresh-web are deferred (cannot recreate the very
  // container that spawned us — SIGKILL mid-run). The sentinel line at the
  // end of runUpdate tells the server which steps were deferred.
  const hostdContext =
    typeof opts.hostdContext === "boolean" ? opts.hostdContext : isHostdContext();

  // ── self-update-cli — FIRST, ahead of everything (#3919) ──────────────
  //
  // Ordering is the whole point of this step. `apply-config` renders every
  // per-agent scaffold from Handlebars templates that ship INSIDE the
  // installed CLI, so a CLI updated AFTER apply renders this run from the
  // OLD templates and the new one sits unused until the next update — the
  // drift, one release later. It also precedes persist-release-pin and the
  // compose regen so the whole rest of the plan runs under the new code.
  //
  // Skipped (never failed) when the install is not a published static
  // binary, when GitHub is unreachable, or when the operator opted out.
  // Skipping is loud: the reason is printed and, in --check, listed.
  steps.push({
    name: "self-update-cli",
    description:
      "Replace the host operator CLI binary AND its shipped-asset payload (profiles/skills/vendor) with the latest published release — both checksum-verified, payload installed first so the pair can never end up new-CLI/old-templates — then re-exec the new binary for the remaining steps",
    skipReason: opts.skipSelfUpdate
      ? "--skip-self-update flag set"
      : alreadySelfUpdated(process.env)
        ? "already re-exec'd from a freshly installed binary in this run"
        : undefined,
    run: async () => {
      const say = opts.stdout ?? ((t: string) => process.stdout.write(t));
      const io = opts.selfUpdateIO ?? defaultSelfUpdateIO();
      const detection = detectInstallKind(
        opts.installProbe ?? {
          bundleDir: import.meta.dirname,
          execPath: process.execPath,
          scriptPath: scriptPath,
          inContainer:
            process.env.SWITCHROOM_HOSTD_CONTEXT === "1" ||
            existsSync("/.dockerenv"),
        },
      );
      // Classify BEFORE any network I/O: a container / checkout / npm
      // install can never be self-updated, so asking GitHub about it is a
      // pointless round-trip (and would make every unit test that walks
      // this step reach the network).
      if (detection.kind !== "static-binary") {
        say(chalk.gray(`  host CLI not self-updated: ${detection.reason}\n`));
        return;
      }
      const latestTag = opts.latestReleaseTagFn
        ? await opts.latestReleaseTagFn()
        : await fetchLatestReleaseTag(io);
      const plan = planSelfUpdate({
        detection,
        currentVersion: SWITCHROOM_VERSION,
        latestTag,
      });
      if (plan.action === "skip") {
        say(chalk.gray(`  host CLI not self-updated: ${plan.reason}\n`));
        return;
      }
      if (plan.action === "current") {
        say(chalk.gray(`  host CLI already on ${plan.version}\n`));
        // CONVERGENCE (#4163). Ordering the payload before the binary is only
        // safe if a half-completed update can still finish: a run whose
        // payload step failed leaves the binary current, so without this the
        // next `switchroom update` would skip out here and the host would sit
        // on a new CLI with a missing or stale payload forever. Re-checking
        // (and repairing) the payload on the no-op path is what makes the
        // pair converge instead of merely being ordered.
        const repaired = await installAssetPayload({
          tag: plan.version,
          binaryPath: detection.binaryPath as string,
          io,
          log: (s) => say(chalk.gray(`  ${s}\n`)),
        });
        say(
          repaired.installed
            ? chalk.green(`  ${repaired.message}\n`)
            : chalk.gray(`  ${repaired.message}\n`),
        );
        return;
      }
      const asset = releaseAssetName(process.platform, process.arch);
      if (!asset) {
        say(
          chalk.gray(
            `  host CLI not self-updated: no published binary for ${process.platform}/${process.arch}\n`,
          ),
        );
        return;
      }
      const result = await performSelfUpdate({
        plan,
        assetName: asset,
        io,
        log: (s) => say(chalk.gray(`  ${s}\n`)),
      });
      if (result.replaced && opts.selfUpdateSink) {
        opts.selfUpdateSink.replacedWith = result.newVersion;
        opts.selfUpdateSink.binaryPath = result.binaryPath;
      }
      say(chalk.green(`  ${result.message}\n`));
    },
  });

  // When --channel / --pin is set, the resolved image tag in compose
  // needs to change BEFORE pull-images runs (so `docker compose pull`
  // grabs the right tag). Inject a pre-pull `apply --compose-only`
  // step that regenerates the compose with the override applied; the
  // main apply-config step below then re-runs apply with the full
  // scaffold sweep + the same override for consistency.
  // `--pin` must be DURABLE, not one-shot: persist release.pin to
  // switchroom.yaml BEFORE regenerating compose, so apply/pull/recreate all
  // read the same persisted pin and the next plain reconcile can't revert
  // the fleet. Shares setReleasePinInConfig with `switchroom rollout --pin`
  // so the two `--pin` paths can't diverge. (--channel stays one-shot; a
  // floating channel has no fixed version to persist.) Skipped under --check
  // (run closures don't fire in check mode).
  if (opts.pin) {
    const pin = opts.pin;
    const persist = opts.persistPinFn ?? defaultPersistPin(opts.configPath);
    steps.push({
      name: "persist-release-pin",
      description: `Persist release.pin=${pin} to switchroom.yaml (durable)`,
      run: () => persist(pin),
    });
  }

  const releaseOverrideArgs: string[] = [];
  if (opts.channel) releaseOverrideArgs.push("--channel", opts.channel);
  if (opts.pin) releaseOverrideArgs.push("--pin", opts.pin);
  if (releaseOverrideArgs.length > 0) {
    steps.push({
      name: "regen-compose-for-release-override",
      description:
        "Regenerate compose with the --channel/--pin override so pull-images grabs the right tag",
      run: () => {
        const r = runner(self.command, selfArgv(
          "apply",
          "--compose-only",
          "--non-interactive",
          ...releaseOverrideArgs,
        ));
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
        "compose", "-p", "switchroom", "-f", composePath,
        ...composeEnvFileArgs(composePath),
        "pull",
      ]);
      if (r.status !== 0) throw new Error("docker compose pull failed");
    },
  });

  // Source-checkout step. Only added when --rebuild is explicit.
  // `runUpdate` preflights `rebuildRefusalMessage` and hard-refuses
  // BEFORE any step runs on a published install (so a fat-fingered
  // `--rebuild` on a consumer host can't half-apply then drift to
  // unreviewed source). The in-step check below is defence-in-depth
  // for callers that drive `planUpdate` directly (e.g. unit tests),
  // sharing the same single-source-of-truth message.
  if (opts.rebuild) {
    steps.push({
      name: "rebuild-source",
      description: "git pull upstream main + bun install + npm run build",
      run: () => {
        const refusal = rebuildRefusalMessage(scriptPath);
        if (refusal) {
          throw new Error(refusal);
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
      const r = runner(self.command, selfArgv(
        "apply",
        "--non-interactive",
        "--no-doctor",
        ...releaseOverrideArgs,
      ));
      if (r.status !== 0) throw new Error("switchroom apply failed");
    },
  });

  // reconcile-hindsight-watch-cron: re-assert the hindsight-watch cron
  // definition on every update so an already-armed host can't drift.
  //
  // The watchdog cron (`/etc/cron.d/hindsight-watch`) pins the binary path,
  // schedule, flags and PATH when it is armed, but nothing re-asserted it
  // afterwards — so a definition change, or a binary that moved out from under
  // the fragment, would persist silently until someone re-ran
  // `--install-cron` by hand. This step folds that reconcile into `update`,
  // right after apply-config where the rest of the host's generated surfaces
  // are refreshed.
  //
  // It is REPAIR, not ARM: `reconcileCron` is a no-op when the fragment is
  // absent (arming stays the explicit `hindsight-watch --install-cron` opt-in,
  // and `switchroom doctor` FAILs while unarmed), and idempotent when present
  // and already correct. The operator's chosen `--cron-user` is preserved.
  //
  // Deferred in hostd-context: `/etc/cron.d` lives on the host, not inside the
  // hostd container, so writing it from there would land in the wrong
  // filesystem. Never fatal — a failed reconcile warns and continues; the
  // update itself succeeded.
  steps.push({
    name: "reconcile-hindsight-watch-cron",
    description:
      "Reconcile /etc/cron.d/hindsight-watch (binary path / schedule / flags) on already-armed hosts — idempotent; no-op when unarmed or already current",
    skipReason: hostdContext
      ? "deferred (hostd-context): /etc/cron.d is on the host, not in the hostd container — finish host-side with `switchroom hindsight-watch --install-cron`"
      : undefined,
    isHostdDeferred: hostdContext,
    run: () => {
      const say = opts.stdout ?? ((t: string) => process.stdout.write(t));
      const binary = process.env.SWITCHROOM_BINARY ?? "/usr/local/bin/switchroom";
      const fallbackUser =
        process.env.SUDO_USER ?? process.env.USER ?? process.env.LOGNAME;
      let res: ReturnType<typeof reconcileCron>;
      try {
        res = reconcileCron({
          binary,
          fallbackUser,
          ...(opts.watchCronPath ? { path: opts.watchCronPath } : {}),
        });
      } catch (e) {
        // Non-fatal: the update succeeded; a cron we couldn't reconcile is a
        // diagnostic, not an update failure. `switchroom doctor` carries the
        // standing signal.
        say(
          chalk.yellow(
            `  hindsight-watch cron not reconciled: ${(e as Error).message}\n`,
          ),
        );
        return;
      }
      if (res.status === "absent") {
        say(
          chalk.gray(
            "  hindsight-watch cron not armed — skipping reconcile " +
              "(arm with `switchroom hindsight-watch --install-cron`; doctor FAILs while unarmed)\n",
          ),
        );
      } else if (res.status === "reconciled") {
        say(chalk.green(`  hindsight-watch cron reconciled at ${res.path}\n`));
      } else {
        say(chalk.gray(`  hindsight-watch cron already current at ${res.path}\n`));
      }
    },
  });

  // reconcile-config-repo-cron: re-assert the config-repo auto-backup cron
  // definition on every update, so an already-armed host can't drift (stale
  // binary path, or a changed `config_repo.interval_minutes` /
  // `include_vault_backup`).
  //
  // REPAIR, not ARM — exactly like reconcile-hindsight-watch-cron above:
  // `reconcileConfigSyncCron` is a no-op when the fragment is absent (arming
  // stays the explicit, enabled-gated `config-repo install-cron` opt-in, and
  // `switchroom doctor` FAILs while an ENABLED feature is un-armed), and
  // idempotent when present and already correct. The operator's chosen
  // `--cron-user` is preserved; the interval + vault-backup mode are re-read
  // from config so a switchroom.yaml change is picked up on the next update.
  //
  // Deferred in hostd-context: /etc/cron.d is on the host, not in the hostd
  // container. Never fatal — a failed reconcile warns and continues.
  steps.push({
    name: "reconcile-config-repo-cron",
    description:
      "Reconcile /etc/cron.d/switchroom-config-sync (binary path / interval / vault-backup mode) on already-armed hosts — idempotent; no-op when unarmed or already current",
    skipReason: hostdContext
      ? "deferred (hostd-context): /etc/cron.d is on the host, not in the hostd container — finish host-side with `switchroom config-repo install-cron`"
      : undefined,
    isHostdDeferred: hostdContext,
    run: () => {
      const say = opts.stdout ?? ((t: string) => process.stdout.write(t));
      const binary = process.env.SWITCHROOM_BINARY ?? "/usr/local/bin/switchroom";
      const fallbackUser =
        process.env.SUDO_USER ?? process.env.USER ?? process.env.LOGNAME;
      // Re-read the current cadence + vault-backup mode from config so a
      // switchroom.yaml change reconciles. Tolerate a missing/malformed block.
      let intervalMinutes = CONFIG_SYNC_DEFAULT_INTERVAL;
      let includeVaultBackup: "off" | "daily" | "every_tick" = "daily";
      try {
        const block = loadConfig(opts.configPath).config_repo;
        if (block) {
          intervalMinutes = block.interval_minutes ?? CONFIG_SYNC_DEFAULT_INTERVAL;
          includeVaultBackup = block.include_vault_backup ?? "daily";
        }
      } catch {
        /* defaults above still reconcile a fragment to a sane definition */
      }
      let res: ReturnType<typeof reconcileConfigSyncCron>;
      try {
        res = reconcileConfigSyncCron({
          binary,
          intervalMinutes,
          includeVaultBackup,
          fallbackUser,
          ...(opts.configSyncCronPath ? { path: opts.configSyncCronPath } : {}),
        });
      } catch (e) {
        say(
          chalk.yellow(
            `  config-repo cron not reconciled: ${(e as Error).message}\n`,
          ),
        );
        return;
      }
      if (res.status === "absent") {
        say(
          chalk.gray(
            "  config-repo cron not armed — skipping reconcile " +
              "(arm with `switchroom config-repo install-cron`; doctor FAILs while enabled+unarmed)\n",
          ),
        );
      } else if (res.status === "reconciled") {
        say(chalk.green(`  config-repo cron reconciled at ${res.path}\n`));
      } else {
        say(chalk.gray(`  config-repo cron already current at ${res.path}\n`));
      }
    },
  });

  // install-self-heal-timer: arm the systemd timer that makes a shipped release
  // converge the HOST binary automatically — the last convergence gap.
  //
  // A release auto-converges every container image, but the host operator binary
  // (`/usr/local/bin/switchroom`) and the hindsight-watch cron converge only when
  // a human runs `switchroom update` on the host, because self-update-cli and the
  // cron reconcile are host-context work that skips inside the hostd/agent
  // container a rollout runs from. This timer re-runs `switchroom update
  // --skip-images` on the host every ~30 min, so a behind host CLI self-heals
  // within one interval with no human in the loop (the v0.19.38 12h drift could
  // not recur). `--skip-images` still runs self-update-cli (only --skip-self-update
  // skips that, see the self-update-cli step above) — it just doesn't pull images
  // on a healthy tick.
  //
  // ARM, not just repair: unlike the cron (opt-in, doctor FAILs while unarmed),
  // this timer IS the mechanism the PR ships, so the host update path installs it
  // whenever it safely can. It writes nothing and never fails when the host is
  // not systemd-booted, the process is unprivileged, or no non-root operator user
  // resolves — it prints the unit contents + the two systemctl commands as the
  // manual fallback instead. Idempotent: a re-run once installed is a no-op.
  //
  // Deferred in hostd-context: /etc/systemd/system lives on the host, not inside
  // the hostd container, so writing it from there would land in the wrong
  // filesystem. Never fatal — a failed install warns and continues.
  steps.push({
    name: "install-self-heal-timer",
    description:
      "Install + enable the switchroom-self-heal systemd timer so a shipped release converges the host binary automatically — graceful no-op without systemd/privilege",
    skipReason: hostdContext
      ? "deferred (hostd-context): /etc/systemd/system is on the host, not in the hostd container — finish host-side by re-running `switchroom update` on the host"
      : undefined,
    isHostdDeferred: hostdContext,
    run: () => {
      const say = opts.stdout ?? ((t: string) => process.stdout.write(t));
      let res: ReturnType<typeof installSelfHealTimer>;
      try {
        res = installSelfHealTimer(opts.selfHealTimerDeps ?? {});
      } catch (e) {
        // Non-fatal: the update succeeded; a timer we couldn't enable is a
        // diagnostic, not an update failure. `switchroom doctor` carries the
        // standing host-CLI-drift signal.
        say(
          chalk.yellow(
            `  self-heal timer not installed: ${(e as Error).message}\n`,
          ),
        );
        return;
      }
      if (res.status === "installed") {
        say(
          chalk.green(
            `  self-heal timer installed + enabled (${res.servicePath}, ${res.timerPath})\n`,
          ),
        );
      } else if (res.status === "unchanged") {
        say(chalk.gray(`  self-heal timer already current + enabled at ${res.timerPath}\n`));
      } else {
        // Graceful skip — print the exact units + the two systemctl commands so
        // the operator can install it by hand on a non-systemd / unprivileged host.
        say(
          chalk.gray(
            `  self-heal timer not installed automatically: ${res.reason}\n`,
          ) +
            chalk.gray("  Install it by hand:\n") +
            chalk.gray(`    # ${res.servicePath}\n`) +
            res.serviceContent!.replace(/^/gm, chalk.gray("    ")) +
            chalk.gray(`    # ${res.timerPath}\n`) +
            res.timerContent!.replace(/^/gm, chalk.gray("    ")) +
            res.manualCommands.map((c) => chalk.gray(`    ${c}\n`)).join(""),
        );
      }
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
        : hostdContext
          ? "deferred (hostd-context): finish host-side via `switchroom hostd install` — update_apply cannot recreate its own hostd container without SIGKILLing itself (#2458)"
          : undefined,
    isHostdDeferred: hostControlEnabled && !opts.skipImages && hostdContext,
    run: () => {
      const r = runner(self.command, selfArgv("hostd", "install"));
      if (r.status !== 0) throw new Error("switchroom hostd install failed");
    },
  });

  // refresh-web: pull the latest web-service image and recreate the
  // container. Same isolation rationale as refresh-hostd — the web
  // service runs in its own compose project (`switchroom-web`), so the
  // agent fleet's pull-images step never touches it and an operator
  // who ran `switchroom update` after a web change would otherwise be
  // left on a stale dashboard/webhook receiver. This step folds the
  // refresh into the update, mirroring refresh-hostd exactly.
  //
  // OPT-IN: skipped unless web_service.managed is true. The default is
  // false because existing installs run the web server as the legacy
  // `switchroom-web.service` systemd unit — pulling up the container
  // unprompted would fight the unit for host loopback 127.0.0.1:8080.
  // Operators flip managed: true only after cutting over (stop+disable
  // the unit, `switchroom webd install`). Also skipped on --skip-images.
  let webServiceManaged: boolean;
  if (typeof opts.webServiceManaged === "boolean") {
    webServiceManaged = opts.webServiceManaged;
  } else {
    try {
      webServiceManaged = loadConfig().web_service?.managed === true;
    } catch {
      // Best-effort: skip rather than fail the whole update if config
      // can't be loaded.
      webServiceManaged = false;
    }
  }
  steps.push({
    name: "refresh-web",
    description:
      "switchroom webd install — pull latest web-service image + recreate the dashboard/webhook container (separate compose project)",
    skipReason: !webServiceManaged
      ? "web_service.managed is not true — web container not in use (legacy systemd unit)"
      : opts.skipImages
        ? "--skip-images flag set"
        : hostdContext
          ? "deferred (hostd-context): finish host-side via `switchroom webd install` — update_apply cannot recreate the web container without SIGKILLing the hostd container it shares a compose project with (#2458)"
          : undefined,
    isHostdDeferred: webServiceManaged && !opts.skipImages && hostdContext,
    run: () => {
      const r = runner(self.command, selfArgv("webd", "install"));
      if (r.status !== 0) throw new Error("switchroom webd install failed");
    },
  });

  // refresh-hindsight: pull the hindsight image and recreate the
  // container. Same isolation gap as refresh-hostd/refresh-web — the
  // hindsight singleton runs as its own standalone `docker run` container
  // (managed by `memory setup`, NOT in the agent fleet's compose project),
  // so `pull-images` never touches it. Before this step existed,
  // `switchroom update` left hindsight on whatever stale image it last
  // started with — even after the durability fixes (#2412 stable
  // worker_id, #2416 backups / healthcheck / self-maintenance) were baked
  // into the image, the running container kept serving the pre-fix bits
  // until an operator separately ran `memory setup --stop` + `memory
  // setup`. This step folds that recreate into the update (reusing the
  // container's current port so memory.config.url never changes under the
  // fleet).
  //
  // Pin the recreate to the fleet's target version (#2851). Unlike
  // refresh-web/refresh-hostd — whose tags resolve from the durable
  // `release.pin` via compose / `webd|hostd install` — `memory setup`
  // never reads `release.pin`, so without an explicit `--tag` it recreates
  // on floating `:latest` and the memory singleton silently drifts a
  // version behind the pinned fleet (v0.17.5 roll left hindsight on
  // `:latest`). Mirror `switchroom rollout`, which threads `--tag
  // <target>`. The target is resolved lazily inside run() (see
  // {@link resolveHindsightPinTag}) so build-time step inspection stays
  // free of config I/O.
  //
  // Skipped when the memory backend isn't hindsight OR --skip-images is set.
  let memoryBackendHindsight: boolean;
  if (typeof opts.memoryBackendHindsight === "boolean") {
    memoryBackendHindsight = opts.memoryBackendHindsight;
  } else {
    try {
      memoryBackendHindsight = loadConfig().memory?.backend === "hindsight";
    } catch {
      // Best-effort: skip rather than fail the whole update if config
      // can't be loaded.
      memoryBackendHindsight = false;
    }
  }
  steps.push({
    name: "refresh-hindsight",
    description:
      "switchroom memory setup --recreate — pull the hindsight image (pinned to the release target when set, else :latest) + recreate the memory singleton (reusing its current port)",
    skipReason: !memoryBackendHindsight
      ? "memory.backend is not hindsight — no hindsight singleton to refresh"
      : opts.skipImages
        ? "--skip-images flag set"
        : undefined,
    run: () => {
      const pinTag = resolveHindsightPinTag(opts);
      const setupArgs = ["memory", "setup", "--recreate"];
      if (pinTag) setupArgs.push("--tag", pinTag);
      const r = runner(self.command, selfArgv(...setupArgs));
      if (r.status !== 0) throw new Error("switchroom memory setup --recreate failed");
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
      // SOURCE: the shipped skills/ payload. Resolved through the SAME
      // probe as profiles/ and vendor/ (src/util/shipped-assets.ts) —
      // the old bare `resolve(import.meta.dirname, "../../skills")`
      // became `/skills` inside a `bun build --compile` binary, where
      // `import.meta.dirname` is the bunfs virtual root, so this step
      // silently no-op'd on every published-binary host while still
      // being ticked green (#4161).
      const resolution = resolveShippedAsset(
        SKILLS_ASSET,
        opts.shippedSkillsProbe ?? {
          bundleDir: import.meta.dirname,
          execPath: process.execPath,
        },
      );
      const dest = join(homedir(), ".switchroom", "skills", "_bundled");
      if (resolution.path === null) {
        // A step that cannot do its job must NOT report success. On a
        // PACKAGED install (published binary / npm / container image)
        // the skills payload is part of the artifact, so its absence is
        // a packaging defect: fail the step and stop the update rather
        // than leave the pool stale and every agent's CLAUDE.md
        // pointing at default skills that never reach it.
        //
        // A source checkout (or an install we cannot classify) is the
        // one case where "no adjacent skills/" can be a legitimate
        // local layout, so that stays a warning — but a warning the
        // final summary reprints, not a lone stderr line buried in a
        // long log.
        const detection = detectInstallKind(
          opts.installProbe ?? {
            bundleDir: import.meta.dirname,
            execPath: process.execPath,
            scriptPath,
            inContainer:
              process.env.SWITCHROOM_HOSTD_CONTEXT === "1" ||
              existsSync("/.dockerenv"),
          },
        );
        const detail =
          `no shipped skills/ payload found for this install ` +
          `(${detection.kind}; ${describeShippedAssetSearch(resolution)})`;
        if (PACKAGED_INSTALL_KINDS.has(detection.kind)) {
          throw new Error(
            `sync-bundled-skills: ${detail}. Every packaged switchroom ` +
              `artifact ships skills/, so this is a packaging defect, not an ` +
              `operator opt-out — the bundled pool at ${dest} cannot be ` +
              `repaired by re-running \`switchroom update\`. Stage the payload ` +
              `at /usr/local/share/switchroom/skills (or point ` +
              `${SKILLS_ASSET.envVar} at a checkout's skills/) and re-run.`,
          );
        }
        const warning =
          `sync-bundled-skills SKIPPED — ${detail}. The bundled pool at ` +
          `${dest} was NOT refreshed; default skills may be missing or stale.`;
        process.stderr.write(`switchroom update: ${warning}\n`);
        warningSink.push(warning);
        return;
      }
      const source = resolution.path;
      try {
        mkdirSync(dirname(dest), { recursive: true });
        // Manifest-owned ADDITIVE sync (footgun B): copies/updates every
        // shipped skill and deletes ONLY names switchroom previously shipped
        // and no longer ships. Hand-added pool skills — and every dir that
        // predates the manifest — are preserved, never `rm -rf`'d.
        const r = syncBundledSkills({
          source,
          dest,
          version: SWITCHROOM_VERSION,
        });
        if (r.manifestCorrupt) {
          process.stderr.write(
            `switchroom update: sync-bundled-skills — pool manifest was unreadable; ` +
              `deleted nothing (fail-closed) and rewrote a clean manifest.\n`,
          );
        }
        if (r.removed.length > 0) {
          process.stderr.write(
            `switchroom update: sync-bundled-skills — removed ${r.removed.length} retired ` +
              `bundled skill(s): ${r.removed.join(", ")}.\n`,
          );
        }
      } catch (err) {
        throw new Error(
          `sync-bundled-skills failed: ${(err as Error).message}`,
        );
      }
    },
  });

  // Loud guard (footgun C/D): every builtin default skill ships in the CLI
  // package `skills/` dir, so after sync-bundled-skills the pool MUST contain
  // all of them. A missing one is never an operator opt-out — it is a broken
  // sync or a packaging regression, and silently skipping it (the historical
  // behaviour) leaves every agent's CLAUDE.md referencing a skill that does
  // not exist. Fail the update step loudly instead. The packaging test
  // (reconcile-default-skills.test.ts) guarantees the source list ⊆ package
  // skills/ at build time; this catches a corrupt/partial runtime sync.
  steps.push({
    name: "verify-bundled-skills",
    description:
      "Assert every builtin default skill is present in ~/.switchroom/skills/_bundled/ after sync.",
    run: () => {
      // Only verify the pool the REAL sync produces. When a test (or an
      // embedder) overrides the sync via `syncBundledSkillsFn`, the runtime
      // pool at ~/.switchroom was never populated by this run — verifying it
      // would assert against unrelated host state. The unit-level guarantee
      // (declared defaults ⊆ shipped skills/) is covered structurally by the
      // packaging test; this step only guards the real cpSync path.
      if (opts.syncBundledSkillsFn) return;
      const dest = join(homedir(), ".switchroom", "skills", "_bundled");
      if (!existsSync(dest)) {
        // sync-bundled-skills legitimately skipped (CLI bundle without an
        // adjacent skills/ payload, e.g. an unusual dev layout). Nothing to
        // verify — don't manufacture a failure the sync itself declined to.
        return;
      }
      const missing = getBuiltinDefaultSkillEntries()
        .map((e) => e.key)
        .filter((key) => !existsSync(join(dest, key)));
      if (missing.length > 0) {
        throw new Error(
          `verify-bundled-skills: builtin default skill(s) missing from the pool after sync: ` +
            `${missing.join(", ")}. These ship in the CLI package and must exist in ${dest}. ` +
            `This is a broken sync or a packaging regression — the pool is not converged.`,
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
      // PRE-FLIGHT: stat every host bind source BEFORE `up`. If any is missing
      // or the wrong type, ABORT — bringing up would let Docker auto-create the
      // sources as empty root-owned dirs and crash the brokers (2026-06-23).
      // This is the fail-loud backstop for switchroom's deploy path (the fleet
      // is only ever brought up via the CLI, never a raw `docker compose up`).
      try {
        const composeText = readFileSync(composePath, "utf8");
        const pf = validateBindSources(composeText);
        if (!pf.ok) throw new Error(formatPreflightError(pf));
      } catch (e) {
        if (e instanceof Error && e.message.startsWith("switchroom:")) throw e;
        // A read/parse failure of the compose itself is also fatal here.
        throw new Error(`pre-flight bind-source check failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      const r = runner("docker", [
        "compose", "-p", "switchroom", "-f", composePath,
        ...composeEnvFileArgs(composePath),
        "up", "-d",
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
      runner(self.command, selfArgv("doctor"));
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

/**
 * Reconstruct this run's flags for the re-exec'd (new) binary, plus the
 * two loop guards. Only flags that are still meaningful after the CLI has
 * already been replaced are forwarded — `--check` and `--status` never
 * reach here (they return before any step runs).
 */
export function buildReexecArgs(opts: UpdateOptions): string[] {
  const args = ["update", "--skip-self-update"];
  if (opts.skipImages) args.push("--skip-images");
  if (opts.channel) args.push("--channel", opts.channel);
  // self-update-cli runs BEFORE persist-release-pin, so this run has not
  // persisted --pin yet. Forward it; the new binary does the persist.
  if (opts.pin) args.push("--pin", opts.pin);
  // --rebuild is deliberately NOT forwarded: it is refused on any
  // published install, and a static binary (the only self-updatable
  // shape) is by definition published.
  return args;
}

function defaultReexec(binaryPath: string, args: string[]): { status: number } {
  const r = spawnSync(binaryPath, args, {
    stdio: "inherit",
    env: { ...process.env, [SELF_UPDATE_ENV_SENTINEL]: "1" },
  });
  return { status: r.status ?? 1 };
}

/**
 * Local, network-free component-version drift summary for `--check`.
 *
 * Never throws: an advisory block must not be able to break the dry-run
 * an operator uses to decide whether to update.
 */
export function renderDriftPreamble(opts: UpdateOptions): string {
  try {
    const exec: ExecFn =
      opts.componentExec ??
      ((cmd, args) => {
        const r = spawnSync(cmd, args, { encoding: "utf-8", timeout: 10_000 });
        return { status: r.status ?? 1, stdout: r.stdout ?? "" };
      });
    let pin: string | undefined;
    try {
      pin = loadConfig().release?.pin ?? undefined;
    } catch {
      pin = undefined;
    }
    const report = detectComponentDrift(
      // #4571 — `observeHostCli()` keeps the `cli (host)` row honest when this
      // runs inside a container (the hostd `update_check` verb): the running
      // CLI is the IMAGE's, not the host's.
      collectComponents(SWITCHROOM_VERSION, exec, observeHostCli()),
      pin,
    );
    const body = formatComponentDrift(report);
    return report.behind.length > 0
      ? `${body}\n\n${report.behind.length} component(s) BEHIND ${report.target} — this update targets them.\n`
      : `${body}\n`;
  } catch (err) {
    return `Component versions: not checkable (${(err as Error).message})\n`;
  }
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

  // Preflight: --rebuild is source-checkout-only. Refuse BEFORE any
  // step (or even the --check plan) on a published install — fail
  // fast with the published-path remediation rather than letting
  // pull-images run and then dying mid-pipeline.
  if (opts.rebuild) {
    const refusal = rebuildRefusalMessage(
      opts.scriptPath ?? process.argv[1] ?? "",
    );
    if (refusal) {
      stderr(chalk.red(refusal + "\n"));
      return 2;
    }
  }

  // Sink the self-update step writes to when it swaps the binary, so the
  // loop below knows it must re-exec the NEW code for the remaining steps.
  const selfUpdateSink: { replacedWith?: string; binaryPath?: string } =
    opts.selfUpdateSink ?? {};
  // Non-fatal degradations a step reports. Reprinted in the summary so a
  // partially-working run never reads like a clean one (#4161).
  const warningSink: string[] = opts.warningSink ?? [];
  const steps = planUpdate({ ...opts, selfUpdateSink, warningSink });
  const renderWarnings = (): void => {
    if (warningSink.length === 0) return;
    stdout(
      chalk.yellow(
        `\n⚠ ${warningSink.length} step(s) completed WITHOUT doing their full job:\n`,
      ),
    );
    for (const w of warningSink) stdout(chalk.yellow(`  • ${w}\n`));
  };

  if (opts.check) {
    stdout(chalk.bold("switchroom update --check (dry-run)\n\n"));
    // Report component drift up front (#3919). Local-only and
    // deterministic — this is the standing answer to "is anything on this
    // host behind?" that nobody had, which is why three components drifted
    // across three releases with only transient warnings to show for it.
    stdout(renderDriftPreamble(opts) + "\n");
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
      await step.run();
      if (step.name === "self-update-cli" && selfUpdateSink.binaryPath) {
        // The binary on $PATH is now the new release, but THIS process is
        // still running the old code — a process cannot start executing a
        // replacement of its own file. Hand the rest of the plan to the new
        // binary and adopt its exit status. `--skip-self-update` plus the
        // env sentinel make a re-exec loop impossible even if the new
        // binary mis-reports its own version.
        //
        // This can never fire in a hostd-driven run: inside a container
        // detectInstallKind() returns `container` and the step skips, so
        // the UPDATE_RESULT sentinel line the server parses is always
        // emitted by this process, never swallowed by a child.
        const reexec = opts.reexecFn ?? defaultReexec;
        stdout(
          chalk.bold(
            `\n▸ re-exec ${selfUpdateSink.binaryPath} (${selfUpdateSink.replacedWith}) for the remaining steps\n`,
          ),
        );
        const r = reexec(
          selfUpdateSink.binaryPath,
          buildReexecArgs(opts),
        );
        return r.status;
      }
    } catch (err) {
      stderr(
        chalk.red(`✗ ${step.name} failed: ${(err as Error).message}\n`),
      );
      renderWarnings();
      // Even on failure, emit the sentinel if any deferred steps exist so
      // the server can record which steps were left pending (#2458).
      const deferredOnFailure = steps
        .filter((s) => s.isHostdDeferred)
        .map((s) => s.name);
      if (deferredOnFailure.length > 0) {
        stdout(encodeUpdateResultLine({ ok: false, deferred: deferredOnFailure }) + "\n");
      }
      return 1;
    }
  }
  renderWarnings();
  stdout(
    warningSink.length > 0
      ? chalk.yellow(`\n✓ update complete (with ${warningSink.length} warning(s))\n`)
      : chalk.green("\n✓ update complete\n"),
  );
  // Emit the structured sentinel when any steps were deferred so the server
  // can populate StatusEntry.deferred without parsing human output (#2458).
  const deferred = steps
    .filter((s) => s.isHostdDeferred)
    .map((s) => s.name);
  if (deferred.length > 0) {
    stdout(encodeUpdateResultLine({ ok: true, deferred }) + "\n");
  }
  return 0;
}

export function registerUpdateCommand(program: Command): void {
  program
    .command("update")
    .description(
      "Update EVERY switchroom component on this host — the operator CLI itself (first), images, scaffolds, the hostd / web / hindsight singletons, and the agent fleet. Wraps the full `self-update && pull && apply && up -d` flow.",
    )
    .option("--check", "Dry-run: print the steps that would execute, exit 0.")
    .option("--skip-images", "Skip the docker image pull (offline mode).")
    .option(
      "--skip-self-update",
      "Do NOT replace the host operator CLI binary. By default `update` updates every switchroom component INCLUDING itself (and does it first, because `apply` renders scaffolds from templates shipped inside the CLI).",
    )
    .option(
      "--rebuild",
      "Source-checkout / maintainer only: git pull + bun install + npm run build before applying. REFUSED on a published install — use `npm i -g switchroom@latest && switchroom update` there.",
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
