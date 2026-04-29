import type { Command } from "commander";
import chalk from "chalk";
import { execSync, spawnSync } from "node:child_process";
import { existsSync, realpathSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir, homedir } from "node:os";
import { withConfigError, getConfig } from "./helpers.js";
import { reconcileAgent } from "../agents/scaffold.js";
import { restartAgent, writeRestartReasonMarker } from "../agents/lifecycle.js";
import { installAllUnits } from "../agents/systemd.js";
import { resolveAgentsDir } from "../config/loader.js";
import { getConfigPath } from "./helpers.js";
import { printHealthSummary } from "./version.js";
import {
  defaultStatusInputs,
  waitForAgentReady,
  type StatusInputs,
} from "../agents/status.js";
import type { SwitchroomConfig } from "../config/schema.js";

/**
 * Per-agent settling timeout for the rolling update gate. After each agent
 * is restarted we poll waitForAgentReady up to this long; if the agent has
 * not become ready by then we halt the rolling update.
 */
const RESTART_SETTLE_TIMEOUT_MS = 30_000;

/**
 * Locate the directory where switchroom is installed (the git checkout root).
 *
 * Strategy:
 *   1. Walk up from this source file looking for a package.json with
 *      `"name": "switchroom-ai"` and a `.git` sibling. This handles both `bun
 *      link`-installed and direct-checkout invocations.
 *   2. Fall back to `realpath $(command -v switchroom)` and walk up from there.
 *
 * Returns null if no install dir can be located.
 */
function locateSwitchroomInstallDir(): string | null {
  // Strategy 1: walk up from import.meta.dirname
  let dir = import.meta.dirname;
  for (let i = 0; i < 10 && dir && dir !== "/"; i++) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        if (pkg.name === "switchroom-ai" && existsSync(join(dir, ".git"))) {
          return dir;
        }
      } catch { /* ignore */ }
    }
    dir = dirname(dir);
  }

  // Strategy 2: realpath of the switchroom binary
  try {
    const which = execSync("command -v switchroom", {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    if (which) {
      const real = realpathSync(which);
      let d = dirname(real);
      for (let i = 0; i < 10 && d && d !== "/"; i++) {
        if (existsSync(join(d, "package.json")) && existsSync(join(d, ".git"))) {
          return d;
        }
        d = dirname(d);
      }
    }
  } catch { /* switchroom not on PATH */ }

  return null;
}

/**
 * Run a shell command, streaming output. Returns true on success.
 * Pass an explicit timeoutMs — git/network/install commands MUST cap, or
 * a stalled SSH key prompt or unreachable origin hangs `update` forever.
 */
function runStreamed(cmd: string, cwd: string, timeoutMs: number): boolean {
  try {
    execSync(cmd, { cwd, stdio: "inherit", timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run a shell command and capture stdout. Returns the output or null on error.
 * timeoutMs defaults to 10s — fine for local git metadata reads (rev-parse,
 * status, log). Override for anything that touches the network.
 */
function runCaptured(cmd: string, cwd: string, timeoutMs = 10_000): string | null {
  try {
    return execSync(cmd, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
      timeout: timeoutMs,
    }).toString();
  } catch {
    return null;
  }
}

// ─── Build-info stash helpers (Fix 1) ─────────────────────────────────────

/**
 * The path of the auto-generated file that `scripts/build.mjs` regenerates
 * on every build, leaving a permanently-dirty working tree.
 */
export const BUILD_INFO_FILE = "src/build-info.ts";

/**
 * Parse `git status --porcelain` and return two groups:
 *  - buildInfoOnly: true when the ONLY dirty file is src/build-info.ts
 *  - otherLines:    the lines for everything except src/build-info.ts
 *
 * Exported for unit testing.
 */
export function classifyDirtyTree(porcelain: string): {
  buildInfoOnly: boolean;
  otherLines: string[];
} {
  const lines = porcelain.trim() === "" ? [] : porcelain.trim().split("\n");
  const otherLines = lines.filter(l => !l.endsWith(BUILD_INFO_FILE));
  const buildInfoLines = lines.filter(l => l.endsWith(BUILD_INFO_FILE));
  const buildInfoOnly = buildInfoLines.length > 0 && otherLines.length === 0;
  return { buildInfoOnly, otherLines };
}

/**
 * Stash src/build-info.ts using `git stash push --include-untracked -m <marker>`.
 * Returns the stash entry name (e.g. "stash@{0}") so it can be popped later,
 * or null if stashing failed.
 *
 * Exported for unit testing.
 */
export function stashBuildInfo(installDir: string): string | null {
  const marker = "switchroom-update-auto-stash-build-info";
  const ok = runCaptured(
    `git stash push -m ${JSON.stringify(marker)} -- ${BUILD_INFO_FILE}`,
    installDir,
  );
  if (ok === null) return null;
  // Verify the stash was actually created by looking for our marker
  const list = runCaptured("git stash list --max-count=1", installDir)?.trim() ?? "";
  if (!list.includes(marker)) return null;
  return "stash@{0}";
}

/**
 * Pop the stash entry created by stashBuildInfo. Best-effort — errors are
 * logged but don't abort the update.
 */
export function unstashBuildInfo(installDir: string, stashRef: string): void {
  runCaptured(`git stash pop ${stashRef}`, installDir);
}

// ─── Upstream lag detection (Fix 2) ────────────────────────────────────────

/**
 * Check whether `origin/main` is behind `upstream/main`.
 * Returns the number of commits origin is behind (0 if in sync or no upstream).
 *
 * Exported for unit testing.
 */
export function countOriginBehindUpstream(installDir: string, branch = "main"): number {
  // Check if upstream remote exists
  const remotes = runCaptured("git remote", installDir)?.trim() ?? "";
  if (!remotes.split("\n").includes("upstream")) return 0;

  // Fetch upstream (quiet — errors mean no network, treat as 0)
  runCaptured(`git fetch --quiet upstream ${branch}`, installDir, 30_000);

  // Count commits upstream/branch has that origin/branch doesn't
  const count = runCaptured(
    `git rev-list --count origin/${branch}..upstream/${branch}`,
    installDir,
  )?.trim() ?? "0";
  return parseInt(count, 10) || 0;
}

// ─── Dist staleness detection (Fix 3) ──────────────────────────────────────

/**
 * Return true when `distFile` is older than any `.ts` file under the given
 * source dirs. Also returns true when `distFile` doesn't exist at all.
 *
 * Exported for unit testing.
 */
export function isDistStale(installDir: string, distFile: string, sourceDirs: string[]): boolean {
  const distPath = join(installDir, distFile);
  if (!existsSync(distPath)) return true;

  for (const dir of sourceDirs) {
    const dirPath = join(installDir, dir);
    if (!existsSync(dirPath)) continue;
    const result = runCaptured(
      `find ${JSON.stringify(dirPath)} -name "*.ts" -newer ${JSON.stringify(distPath)}`,
      installDir,
    )?.trim() ?? "";
    if (result !== "") return true;
  }
  return false;
}

// ─── SHA-based restart detection (Fix 4) ───────────────────────────────────

const LAST_DEPLOYED_SHA_FILE = join(homedir(), ".switchroom", "last-deployed-sha.json");

interface DeployedShaState {
  sha: string;
}

/**
 * Read the last-deployed SHA from the state file. Returns null on first run
 * (file doesn't exist) or parse error.
 *
 * Exported for unit testing.
 */
export function readLastDeployedSha(stateFile = LAST_DEPLOYED_SHA_FILE): string | null {
  try {
    const raw = readFileSync(stateFile, "utf-8");
    return (JSON.parse(raw) as DeployedShaState).sha ?? null;
  } catch {
    return null;
  }
}

/**
 * Write the current deployed SHA to the state file, creating parent dirs.
 *
 * Exported for unit testing.
 */
export function writeLastDeployedSha(sha: string, stateFile = LAST_DEPLOYED_SHA_FILE): void {
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify({ sha } satisfies DeployedShaState), "utf-8");
}

/**
 * Extract COMMIT_SHA from a freshly-written src/build-info.ts without
 * importing it (avoids module-cache issues in long-running processes).
 *
 * Exported for unit testing.
 */
export function extractBuiltSha(installDir: string): string | null {
  try {
    const content = readFileSync(join(installDir, BUILD_INFO_FILE), "utf-8");
    const m = content.match(/COMMIT_SHA:\s*string\s*\|\s*null\s*=\s*("([^"]+)"|null)/);
    if (!m) return null;
    return m[2] ?? null; // m[2] is the capture inside the quotes; undefined when null literal
  } catch {
    return null;
  }
}

/**
 * State persisted to a temp JSON file before self-reexec.
 * The freshly-built binary reads this in --phase=post-build.
 */
interface UpdateResumeState {
  installDir: string;
  agentNames: string[];
  branch: string;
  sourceChanged: boolean;
  before: string;
  noRestart: boolean;
  /** Fix 4: SHA embedded in the newly-built src/build-info.ts, if known. */
  newSha?: string;
  /**
   * When true, the settle-gate and in-flight checks are skipped.
   * Mirrors the restart --force semantics.
   */
  force?: boolean;
}

/**
 * Bump the global @anthropic-ai/claude-code package via bun.
 * A half-installed Claude CLI is a worse state than aborting the update —
 * fail loud rather than continue with an inconsistent fleet.
 */
function bumpClaudeCli(installDir: string): void {
  console.log(chalk.gray("\n  Bumping @anthropic-ai/claude-code to latest..."));
  try {
    execSync("bun add -g @anthropic-ai/claude-code@latest", {
      cwd: installDir,
      stdio: "inherit",
      timeout: 180_000,
    });
  } catch (err) {
    console.error(
      chalk.red(
        `  Failed to bump claude-code (network/permissions?): ${(err as Error).message}`
      )
    );
    console.error(chalk.red("  Aborting update — fix the dep install and re-run."));
    process.exit(1);
  }
}

/**
 * Rebuild the switchroom CLI binary from source (scripts/build.mjs).
 * Returns true on success.
 */
function rebuildCli(installDir: string): boolean {
  console.log(chalk.gray("\n  Rebuilding switchroom CLI binary..."));
  try {
    execSync("node scripts/build.mjs", {
      cwd: installDir,
      stdio: "inherit",
      timeout: 120_000,
    });
    return true;
  } catch (err) {
    console.error(
      chalk.red(`  Build failed: ${(err as Error).message}`)
    );
    return false;
  }
}

/**
 * Self-reexec by spawning the newly-built binary with the post-build resume
 * flag. Uses spawnSync with stdio: 'inherit' so the user sees a continuous
 * console stream. Exits the current process with the child's exit code.
 *
 * This is the Linux equivalent of execv: the old process hands off to the
 * new binary. The caller must not return after calling this.
 */
export function selfReexec(newBinary: string, resumeFile: string): never {
  const child = spawnSync(
    process.execPath,  // node
    [newBinary, "update", `--phase=post-build`, `--resume=${resumeFile}`],
    { stdio: "inherit", env: { ...process.env } }
  );
  process.exit(child.status ?? 1);
}

/**
 * Build the StatusInputs for an agent, mirroring the resolution that
 * `switchroom agent restart` already uses. Kept here so the rolling
 * update gate can poll readiness with the same signal the operator sees.
 */
function buildStatusInputsForAgent(
  name: string,
  config: SwitchroomConfig,
  agentsDir: string,
): StatusInputs {
  const agentDir = resolve(agentsDir, name);
  const agentConfig = config.agents[name];
  let hindsightApiUrl: string | null = null;
  let hindsightBankId = name;
  if (config.memory?.backend === "hindsight") {
    const baseUrl =
      (config.memory.config?.url as string | undefined) ??
      "http://localhost:8888/mcp/";
    hindsightApiUrl = baseUrl.endsWith("/mcp/")
      ? baseUrl
      : baseUrl.replace(/\/$/, "") + "/mcp/";
    hindsightBankId = agentConfig?.memory?.collection ?? name;
  }
  return defaultStatusInputs({
    agentName: name,
    agentDir,
    hindsightApiUrl,
    hindsightBankId,
  });
}

/**
 * Print the rolling-halt message when an agent fails to settle. Lists
 * what's on the new build vs. still on the old build, plus retry +
 * inspect commands. Anchored to the JTBDs `survive-reboots-and-real-life`
 * and `restart-and-know-what-im-running` — honest reporting over silent
 * recovery, never claim ready when ready isn't true.
 */
function printRollingHaltMessage(
  failed: string,
  reason: string,
  restarted: string[],
  remaining: string[],
): void {
  console.error(chalk.red(`\n  ❌ Halting rolling update — agent ${failed} ${reason}.`));
  console.error(chalk.red(`     Settle timeout: ${RESTART_SETTLE_TIMEOUT_MS / 1000}s per agent`));
  console.error(
    chalk.red(
      `     On new build:  ${restarted.length > 0 ? restarted.join(", ") : "(none)"}`
    )
  );
  console.error(chalk.red(`     Still on old:  ${remaining.join(", ")}`));
  console.error(chalk.red(`     Retry:         switchroom update`));
  console.error(chalk.red(`     Inspect:       switchroom logs ${failed}`));
  console.error(chalk.red(`\n  Deployed-SHA marker NOT advanced — operator-of-record state preserved.\n`));
}

/**
 * Run the post-build phase: reconcile-all → rolling restart with settle
 * gate → summary. Async because the settle gate awaits waitForAgentReady.
 *
 * Behavior:
 *   1. Regenerate systemd units. Hard fail on any unit error.
 *   2. Reconcile every agent up front. Hard fail if any reconcile throws —
 *      old binary stays in place, no live restart was attempted.
 *   3. Compute the restart set (everyone if sourceChanged, else just the
 *      agents whose reconcile produced changes).
 *   4. For each agent in the restart set: writeRestartReasonMarker →
 *      restartAgent → waitForAgentReady (timeout RESTART_SETTLE_TIMEOUT_MS).
 *      On any failure (restart command throws, or ready times out), HALT.
 *      Print the rolling-halt message; do NOT advance the deployed-SHA
 *      marker; exit non-zero.
 *   5. Persist deployed SHA only when every restart succeeded.
 *   6. Print summary + health.
 */
async function runPostBuildPhase(opts: {
  program: Command;
  installDir: string;
  agentNames: string[];
  before: string;
  sourceChanged: boolean;
  noRestart: boolean;
  /** Fix 4: new COMMIT_SHA from the just-built binary. Written to state file after restart. */
  newSha?: string;
  /**
   * When true, skip the per-agent settle-gate and in-flight checks so the
   * rolling restart proceeds immediately without waiting for each agent to
   * report ready. Mirrors the `restart --force` semantics.
   *
   * Trade-off: a bad binary will cycle the whole fleet before the operator
   * notices. Use only when you know what you're doing or are recovering from
   * a stuck restart.
   */
  force?: boolean;
}): Promise<void> {
  const { program, installDir, agentNames, before, sourceChanged, noRestart, newSha, force } = opts;
  const config = getConfig(program);
  const agentsDir = resolveAgentsDir(config);
  const configPath = getConfigPath(program);

  if (agentNames.length === 0) {
    console.log(chalk.yellow("\n  No agents defined in switchroom.yaml — nothing to reconcile.\n"));
    return;
  }

  // Regenerate systemd units BEFORE reconcile+restart so restarted agents
  // pick up any env-var changes baked into the unit file. Hard fail —
  // bad units = bad restarts. JTBD: real failures need real messages.
  console.log(chalk.bold("\n  Regenerating systemd units..."));
  try {
    installAllUnits(config);
    console.log(chalk.green(`    ${agentNames.length} unit(s) rewritten`));
  } catch (err) {
    console.error(
      chalk.red(`    Failed to regenerate units: ${(err as Error).message}`)
    );
    console.error(chalk.red("    Aborting update — fix unit generation and re-run."));
    process.exit(1);
  }

  // Reconcile-all-first. Pre-flight every agent before touching any live
  // process; a single bad config aborts before the first restart. JTBD:
  // "Eating a crash to look stable" is the anti-pattern we're avoiding.
  console.log(chalk.bold(`\n  Reconciling ${agentNames.length} agent(s)...`));
  const restartCandidates: string[] = [];
  let reconcileFailures = 0;
  for (const name of agentNames) {
    const agentConfig = config.agents[name];
    try {
      const result = reconcileAgent(
        name,
        agentConfig,
        agentsDir,
        config.telegram,
        config,
        configPath,
      );
      if (result.changes.length === 0) {
        console.log(chalk.gray(`    ${name}: in sync`));
      } else {
        console.log(chalk.green(`    ${name}: updated`));
        for (const f of result.changes) {
          console.log(chalk.gray(`      - ${f}`));
        }
        restartCandidates.push(name);
      }
    } catch (err) {
      console.error(chalk.red(`    ${name}: ${(err as Error).message}`));
      reconcileFailures++;
    }
  }

  if (reconcileFailures > 0) {
    console.error(
      chalk.red(
        `\n  ${reconcileFailures} agent(s) failed to reconcile — aborting before any restart.`
      )
    );
    console.error(chalk.red("  Old binary remains in place. Fix the config and re-run.\n"));
    process.exit(1);
  }

  // Determine restart set.
  const shouldRestart = !noRestart && (sourceChanged || restartCandidates.length > 0);
  const toRestart = sourceChanged ? agentNames : restartCandidates;

  if (!shouldRestart || toRestart.length === 0) {
    if (noRestart) {
      console.log(
        chalk.gray(
          "\n  --no-restart given; agents NOT restarted. Run `switchroom agent restart all` to apply."
        )
      );
    }
    const after = runCaptured("git rev-parse --short HEAD", installDir)?.trim() ?? "unknown";
    console.log(chalk.bold(`\n  Done. ${before} → ${after}\n`));
    const finalConfig = getConfig(program);
    printHealthSummary(finalConfig);
    console.log();
    return;
  }

  // Compute restart reason once (used for the marker each agent gets).
  const afterShort = runCaptured("git rev-parse --short HEAD", installDir)?.trim() ?? null;
  let updateReason: string;
  if (sourceChanged && afterShort) {
    let subject = runCaptured(`git log -1 --pretty=%s ${afterShort}`, installDir)?.trim() ?? "";
    if (subject.length > 60) subject = `${subject.slice(0, 57)}…`;
    updateReason = subject
      ? `update: pulled ${afterShort} ${subject}`
      : `update: pulled ${afterShort}`;
  } else {
    updateReason = "update: reconciled config";
  }

  // Rolling restart with settle gate. One-at-a-time, halt on first failure.
  // When --force is set, skip the settle-gate entirely — the operator opts out
  // of the safety net that catches a bad binary before the whole fleet is cycled.
  if (force) {
    console.log(
      chalk.bold(
        `\n  Rolling restart of ${toRestart.length} agent(s) (--force: settle-gate skipped)...`
      )
    );
  } else {
    console.log(
      chalk.bold(
        `\n  Rolling restart of ${toRestart.length} agent(s) (settle timeout ${RESTART_SETTLE_TIMEOUT_MS / 1000}s each)...`
      )
    );
  }
  const restarted: string[] = [];

  for (let i = 0; i < toRestart.length; i++) {
    const name = toRestart[i]!;
    const remainingAfter = toRestart.slice(i + 1);

    try {
      writeRestartReasonMarker(name, updateReason);
      restartAgent(name);
      if (force) {
        console.log(chalk.gray(`    ${name}: restart issued (no settle wait)`));
      } else {
        console.log(chalk.gray(`    ${name}: restart issued, waiting for settle...`));
      }
    } catch (err) {
      console.error(
        chalk.red(`    ${name}: restart failed: ${(err as Error).message}`)
      );
      printRollingHaltMessage(name, "restart command failed", restarted, [name, ...remainingAfter]);
      process.exit(1);
    }

    if (!force) {
      const inputs = buildStatusInputsForAgent(name, config, agentsDir);
      const result = await waitForAgentReady(inputs, { timeoutMs: RESTART_SETTLE_TIMEOUT_MS });
      const secs = (result.elapsedMs / 1000).toFixed(1);
      if (result.ready) {
        console.log(chalk.green(`    ${name}: settled in ${secs}s`));
        restarted.push(name);
      } else {
        console.error(
          chalk.red(
            `    ${name}: did not settle within ${secs}s — gaps: ${result.notReady.join(", ")}`
          )
        );
        printRollingHaltMessage(
          name,
          `did not settle (${result.notReady.join(", ")})`,
          restarted,
          [name, ...remainingAfter],
        );
        process.exit(1);
      }
    } else {
      restarted.push(name);
    }
  }

  // All agents settled. Persist the deployed-SHA marker.
  if (newSha) {
    try {
      writeLastDeployedSha(newSha);
      console.log(chalk.gray(`\n  Deployed SHA recorded: ${newSha}`));
    } catch (err) {
      console.warn(chalk.yellow(`  Warning: could not write deployed SHA: ${(err as Error).message}`));
    }
  }

  const after = runCaptured("git rev-parse --short HEAD", installDir)?.trim() ?? "unknown";
  console.log(chalk.bold(`\n  Done. ${before} → ${after}\n`));
  const finalConfig = getConfig(program);
  printHealthSummary(finalConfig);
  console.log();
}

export function registerUpdateCommand(program: Command): void {
  program
    .command("update")
    .description(
      "Pull the latest Switchroom source, reinstall deps, reconcile agents to switchroom.yaml, and restart them"
    )
    .option("--check", "Show pending changes without applying them")
    .option(
      "--no-restart",
      "Update sources and reconcile config but skip restarting agents"
    )
    .option(
      "--force",
      "Skip the rolling-restart settle gate. Faster, but if the new\n" +
      "binary fails to start, the whole fleet will be cycled to the\n" +
      "broken build before you notice. Use only when you know what\n" +
      "you're doing or are recovering from a stuck restart.\n" +
      "Exit code is 0 regardless of agent health — health-check externally."
    )
    // Hidden internal flags for the self-reexec resume path
    .option("--phase <phase>", undefined, undefined)
    .option("--resume <file>", undefined, undefined)
    .action(
      withConfigError(async (opts: { check?: boolean; restart?: boolean; force?: boolean; phase?: string; resume?: string }) => {

        // ── Post-build resume path ───────────────────────────────────────────
        // When we self-reexec after rebuilding, the new binary is called with
        // --phase=post-build --resume=<tempfile>. Load state and run reconcile.
        if (opts.phase === "post-build" && opts.resume) {
          let state: UpdateResumeState;
          try {
            state = JSON.parse(readFileSync(opts.resume, "utf-8")) as UpdateResumeState;
          } catch (err) {
            console.error(chalk.red(`  Failed to read resume state: ${(err as Error).message}`));
            process.exit(1);
          }
          // Clean up temp file
          try { unlinkSync(opts.resume); } catch { /* best effort */ }

          console.log(chalk.bold(`\n  [post-build] Resuming update for ${state.installDir}\n`));
          // The resumed process inherits user intent (e.g. --no-restart) from
          // the persisted state. argv on the resume command is hardcoded by
          // selfReexec and does not include the user's original flags, so
          // never read opts.restart here.
          await runPostBuildPhase({
            program,
            installDir: state.installDir,
            agentNames: state.agentNames,
            before: state.before,
            sourceChanged: state.sourceChanged,
            noRestart: state.noRestart ?? false,
            newSha: state.newSha,
            force: state.force ?? false,
          });
          return;
        }

        // Guard: --force and --no-restart are mutually exclusive — force has
        // no effect when the restart phase is skipped entirely.
        if (opts.force && opts.restart === false) {
          console.error(chalk.red("  --force and --no-restart are mutually exclusive."));
          process.exit(1);
        }

        // ── Normal (pre-build) path ─────────────────────────────────────────
        const installDir = locateSwitchroomInstallDir();
        if (!installDir) {
          console.error(
            chalk.red(
              "Could not locate Switchroom's install directory. " +
                "Run `switchroom update` from a switchroom checkout, or reinstall Switchroom."
            )
          );
          process.exit(1);
        }

        // Guard: dirty working tree blocks a pull. A dirty tree means
        // `git pull --ff-only` would either fail or silently clobber
        // uncommitted work.
        //
        // Fix 1: src/build-info.ts is regenerated on every build and leaves
        // a permanently-dirty tree. Auto-stash ONLY that file; fail-loud for
        // any other uncommitted changes so we don't silently swallow operator
        // work.
        //
        // --check is read-only so we skip this guard for it.
        let buildInfoStashRef: string | null = null;
        if (!opts.check) {
          const porcelain = runCaptured("git status --porcelain", installDir)?.trim() ?? "";
          if (porcelain) {
            const { buildInfoOnly, otherLines } = classifyDirtyTree(porcelain);
            if (buildInfoOnly) {
              console.log(chalk.gray(`\n  Auto-stashing ${BUILD_INFO_FILE} (regenerated by build)...`));
              buildInfoStashRef = stashBuildInfo(installDir);
              if (!buildInfoStashRef) {
                console.error(chalk.red(`  Failed to auto-stash ${BUILD_INFO_FILE}. Resolve manually.`));
                process.exit(1);
              }
            } else {
              console.error(
                chalk.red(
                  `\n  Switchroom install directory has uncommitted changes:\n\n` +
                    otherLines
                      .map(l => `    ${l}`)
                      .join("\n") +
                    `\n\n  Resolve before updating:\n` +
                    `    cd ${installDir}\n` +
                    `    git stash         # stash your changes\n` +
                    `    switchroom update # then retry\n` +
                    `    git stash pop     # restore if needed\n`
                )
              );
              process.exit(1);
            }
          }
        }

        console.log(chalk.bold(`\nUpdating Switchroom at ${installDir}\n`));

        // 1. Capture current commit
        const before = runCaptured("git rev-parse --short HEAD", installDir)?.trim() ?? "unknown";
        console.log(chalk.gray(`  Current commit: ${before}`));

        // Fix 2: Check for upstream lag before fetching origin.
        // If origin/main is behind upstream/main (e.g. a fork that wasn't
        // synced before today's PRs merged), warn and exit — don't silently
        // pull stale code from origin.
        const branch = runCaptured("git rev-parse --abbrev-ref HEAD", installDir)?.trim() ?? "main";
        const upstreamLag = countOriginBehindUpstream(installDir, branch);
        if (upstreamLag > 0) {
          if (buildInfoStashRef) unstashBuildInfo(installDir, buildInfoStashRef);
          console.error(
            chalk.yellow(
              `\n  ⚠️  origin/${branch} is ${upstreamLag} commit(s) behind upstream/${branch}.` +
              `\n  Run \`git push origin upstream/${branch}:${branch}\` to sync, then re-run update.\n`
            )
          );
          process.exit(1);
        }

        // 2. Fetch from origin
        console.log(chalk.gray("\n  Fetching from origin..."));
        if (!runStreamed("git fetch --quiet origin", installDir, 30_000)) {
          if (buildInfoStashRef) unstashBuildInfo(installDir, buildInfoStashRef);
          console.error(chalk.red("  git fetch failed"));
          process.exit(1);
        }

        // 3. Check what's pending
        const log = runCaptured(
          `git log --oneline HEAD..origin/${branch}`,
          installDir,
        )?.trim() ?? "";

        if (!log) {
          console.log(chalk.green("\n  Already up to date.\n"));
          if (opts.check) {
            if (buildInfoStashRef) unstashBuildInfo(installDir, buildInfoStashRef);
            return;
          }
          // Still reconcile in case switchroom.yaml changed locally without an update
        } else {
          const lines = log.split("\n");
          console.log(chalk.bold(`\n  ${lines.length} new commit(s) on origin/${branch}:`));
          for (const line of lines) {
            console.log(chalk.gray(`    ${line}`));
          }
        }

        if (opts.check) {
          if (buildInfoStashRef) unstashBuildInfo(installDir, buildInfoStashRef);
          console.log(chalk.gray("\n  --check mode: not applying changes.\n"));
          return;
        }

        const sourceChanged = !!log;

        // 4. Pull
        if (log) {
          console.log(chalk.gray("\n  Pulling..."));
          if (!runStreamed(`git pull --ff-only --quiet origin ${branch}`, installDir, 60_000)) {
            if (buildInfoStashRef) unstashBuildInfo(installDir, buildInfoStashRef);
            console.error(
              chalk.red(
                "  git pull failed (not a fast-forward?). " +
                  "Resolve manually with `cd " + installDir + " && git status`."
              )
            );
            process.exit(1);
          }

          // 5. Reinstall deps if package.json or bun.lock changed
          const changed = runCaptured(
            `git diff --name-only ${before}..HEAD`,
            installDir,
          )?.trim() ?? "";
          if (changed.includes("package.json") || changed.includes("bun.lock")) {
            console.log(chalk.gray("\n  Reinstalling dependencies (package.json changed)..."));
            if (!runStreamed("bun install --quiet", installDir, 120_000)) {
              console.error(chalk.red("  bun install failed — aborting update."));
              console.error(chalk.red("  Fix dependencies and re-run `switchroom update`."));
              process.exit(1);
            }
          }

          // Also rebuild telegram-plugin deps if those changed
          const pluginPkg = join(installDir, "telegram-plugin", "package.json");
          if (existsSync(pluginPkg) && changed.includes("telegram-plugin/package.json")) {
            console.log(chalk.gray("  Reinstalling telegram-plugin dependencies..."));
            if (!runStreamed("bun install --quiet", join(installDir, "telegram-plugin"), 120_000)) {
              console.error(chalk.red("  bun install (telegram-plugin) failed — aborting update."));
              process.exit(1);
            }
          }
        }

        // 5b. Bump Claude CLI after pull, before reconcile.
        //     Wrapped in try/warn — network/permission failures are non-fatal.
        bumpClaudeCli(installDir);

        // Fix 3: Always rebuild when dist is stale relative to source.
        // Previously a build was only triggered when the pull saw diffs in
        // src/|bin/|telegram-plugin/. That missed cases where dist was
        // stale for other reasons (manual fast-forward, partial state,
        // crashed build). Now we check mtime regardless of whether the pull
        // brought in new commits.
        const SOURCE_DIRS = ["src", "bin", "telegram-plugin"];
        const DIST_CLI   = "dist/cli/switchroom.js";
        const DIST_PLUGIN = join("telegram-plugin", "dist", "server.js");

        const distCliStale    = isDistStale(installDir, DIST_CLI, SOURCE_DIRS);
        const distPluginStale = existsSync(join(installDir, DIST_PLUGIN))
          ? isDistStale(installDir, DIST_PLUGIN, SOURCE_DIRS)
          : false;
        const needsRebuild    = distCliStale || distPluginStale;

        // Pop the stash now so build.mjs can regenerate build-info.ts cleanly.
        // (build.mjs will write a fresh one; the stashed version is obsolete.)
        if (buildInfoStashRef) {
          // Drop rather than pop so the stale build-info.ts doesn't conflict
          // with the file build.mjs is about to write.
          runCaptured(`git stash drop ${buildInfoStashRef}`, installDir);
          buildInfoStashRef = null;
        }

        if (needsRebuild) {
          if (distCliStale) {
            console.log(chalk.gray("\n  dist/cli/switchroom.js is stale — rebuilding..."));
          }
          if (distPluginStale) {
            console.log(chalk.gray("\n  telegram-plugin/dist/server.js is stale — rebuilding..."));
          }
          // Always reinstall deps before a rebuild so any lockfile changes are applied.
          console.log(chalk.gray("\n  Running bun install..."));
          if (!runStreamed("bun install --quiet", installDir, 120_000)) {
            console.error(chalk.red("  bun install failed — aborting update before rebuild."));
            console.error(chalk.red("  Fix dependencies and re-run `switchroom update`."));
            process.exit(1);
          }
          const built = rebuildCli(installDir);

          if (built) {
            // Fix 4: After a successful build compare the new COMMIT_SHA
            // against the last-deployed SHA. If they differ, force-restart all
            // agents regardless of what reconcile reports, and persist the new
            // SHA so subsequent runs can tell what's already deployed.
            const newSha = extractBuiltSha(installDir);
            const lastSha = readLastDeployedSha();
            const shaChanged = newSha !== null && newSha !== lastSha;

            // Persist state and self-reexec the freshly-built binary
            const config = getConfig(program);
            const agentNames = Object.keys(config.agents);
            const state: UpdateResumeState = {
              installDir,
              agentNames,
              branch,
              // Mark sourceChanged=true when SHA changed so post-build phase
              // unconditionally restarts all agents.
              sourceChanged: sourceChanged || shaChanged,
              before,
              noRestart: opts.restart === false,
              newSha: newSha ?? undefined,
              force: opts.force ?? false,
            };
            const resumeFile = join(
              tmpdir(),
              `switchroom-update-resume-${process.pid}-${Date.now()}.json`
            );
            writeFileSync(resumeFile, JSON.stringify(state), "utf-8");

            const newBinary = join(installDir, DIST_CLI);
            console.log(chalk.gray(`\n  Handing off to rebuilt binary...`));
            selfReexec(newBinary, resumeFile);
            // selfReexec calls process.exit — unreachable
          }
          // If build failed, fall through and run reconcile with old binary
        }

        // 6. Reconcile (if no self-reexec happened)
        const config = getConfig(program);
        const agentNames = Object.keys(config.agents);
        await runPostBuildPhase({
          program,
          installDir,
          agentNames,
          before,
          sourceChanged,
          noRestart: opts.restart === false,
          force: opts.force ?? false,
        });
      })
    );

}
