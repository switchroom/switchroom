import chalk from "chalk";
import { existsSync } from "node:fs";
import { resolvePath } from "../config/loader.js";
import type { SwitchroomConfig } from "../config/schema.js";
import {
  probeDockerAvailability,
  isHindsightRunning,
  isHindsightContainerExists,
  getRunningHindsightPorts,
  startHindsight,
  hindsightConsumerMirrorDir,
  stopHindsight,
  ensureHindsightConsumer,
  resolveHindsightCpAccessKey,
  resolveHindsightLlmSecrets,
  diffDroppedHindsightLlmVaultKeys,
  hindsightLlmDroppedKeyWarning,
  resolveHindsightLiteLlm,
  hindsightLiteLlmDroppedKeyWarning,
  type HindsightLiteLlmResolution,
  HINDSIGHT_CONSUMER_NAME,
  HINDSIGHT_CP_NO_ACCESS_KEY_WARNING,
  HINDSIGHT_DEFAULT_API_PORT,
  HINDSIGHT_DEFAULT_UI_PORT,
  pickHindsightPorts,
  preflightHindsightPorts,
  type DockerProbe,
} from "../setup/hindsight.js";
import {
  resolveRecallPoolConfig,
  resolveHindsightLaunchPorts,
  startHindsightRecallPool,
  stopHindsightRecallPool,
  isHindsightRecallPoolRunning,
  publicPortIsUnserved,
  planStaleRecallPoolConvergence,
  convergeStaleRecallPool,
  splitContainerPerfEnv,
  splitDbPoolEnvConflicts,
  splitDbPoolEnvConflictWarning,
  waitForHindsightHealthy,
  launchRecallPoolHealthGated,
  HINDSIGHT_RECALL_POOL_CONTAINER,
  type HindsightHealthRole,
  type RecallPoolConfig,
} from "../setup/hindsight-recall-pool.js";
import type { getViaBrokerStructured } from "../vault/broker/client.js";
import { askYesNo, spinner } from "../setup/prompt.js";
import { STEP_ACTIVE, STEP_DONE, stepHeader } from "./setup-step-ui.js";

// NOTE ON VAULT-FREENESS
// ----------------------
// This module is deliberately kept free of any STATIC import that transitively
// reaches `bun:sqlite` (the vault graph: ../vault/vault.js, ./vault-broker.js,
// ../vault/broker/client.js as a VALUE, ./setup-posture-rewrite.js). vitest
// cannot load `bun:sqlite`, so a single static edge into that graph would make
// setup-recall-pool-provision.test.ts unloadable under vitest — the very
// reason this function was extracted out of setup.ts. The one legacy vault
// touchpoint (getStringSecret, for the deprecated `hindsight-api-key` courtesy
// note) is reached through a dynamic `await import("../vault/vault.js")` inside
// its try block, so the static import graph stays vault-free while runtime
// behaviour is unchanged. `../vault/broker/client.js` is imported `type`-only
// (erased at compile time) for the getViaBrokerStructured seam.

/** Re-checks of `docker ps` after `startHindsight` before calling it dead. */
const HINDSIGHT_READY_RETRIES = 5;
/** Gap between those re-checks. */
const HINDSIGHT_READY_INTERVAL_MS = 1_000;

/**
 * Thin delegator to {@link resolveHindsightLiteLlm} — the SAME resolution the
 * `memory setup --recreate` launch path uses, so first-run setup and a
 * recreate cannot disagree about whether hindsight is metered. It used to be a
 * verbatim second copy of that function, silent `undefined` and all.
 */
async function resolveLiteLLMForHindsight(
  config: SwitchroomConfig,
  deps: { getViaBrokerStructured?: typeof getViaBrokerStructured } = {},
): Promise<HindsightLiteLlmResolution> {
  return resolveHindsightLiteLlm(config, deps);
}

/** Injectable seams for the memory-backend step (tests: no docker needed). */
export interface MemoryBackendDeps {
  /** Docker probe passed to `isDockerAvailable` / container checks. */
  dockerProbe?: DockerProbe;
  /** Poll sleep while waiting for the container to report running. */
  sleep?: (ms: number) => Promise<void>;
  /** How many times to re-check `docker ps` after `startHindsight`. */
  readyRetries?: number;
  /**
   * The `docker run` seam. Injected so tests can exercise the
   * "start returned but the container is not there" path (review H2)
   * without docker.
   */
  startContainer?: typeof startHindsight;
  /**
   * The authority-container stop seam, paired with {@link startContainer}. Only
   * exercised by the pool-failure fallback (which stops the parked authority
   * before relaunching a sole container on the public port), so a test can drive
   * the degrade path without issuing real `docker stop`/`rm`. Production leaves
   * it undefined ⇒ the real {@link stopHindsight}.
   */
  stopContainer?: typeof stopHindsight;
  /**
   * Broker seam for `resolveHindsightLlmSecrets`. Injected so tests can assert
   * the WIRING outcome — that a `vault:` LLM api_key is resolved BEFORE it
   * reaches {@link startContainer}, the exact gap that caused the 2026-08-06
   * outage. Production leaves it undefined ⇒ the real auto-unlocked broker.
   */
  getViaBrokerStructured?: typeof import("../vault/broker/client.js").getViaBrokerStructured;
  /**
   * The recall-pool `docker run` seam (split provisioning). Injected so a test
   * can drive the enabled path — fresh split build AND authority-up-pool-dead
   * repair — without docker. Production leaves it undefined ⇒ the real
   * {@link startHindsightRecallPool}.
   */
  startRecallPool?: typeof startHindsightRecallPool;
  /**
   * Health-probe seam gating the split launch ordering (authority healthy
   * before the pool starts; pool healthy before the step reports success).
   * Injected so a test resolves it synchronously. Production ⇒
   * {@link waitForHindsightHealthy}.
   */
  waitForHealthy?: typeof waitForHindsightHealthy;
  /**
   * Probe for whether the recall-pool sibling is already running (exact-name).
   * Injected so a test can drive the repair branch. Production ⇒
   * {@link isHindsightRecallPoolRunning}.
   */
  recallPoolRunningProbe?: typeof isHindsightRecallPoolRunning;
  /**
   * Seam to clear a stale recall-pool sibling before (re)launch. Injected so a
   * test never issues real `docker rm` against the host daemon. Production ⇒
   * {@link stopHindsightRecallPool}.
   */
  stopRecallPool?: typeof stopHindsightRecallPool;
  /**
   * Host-port allocation seam. Injected so a test can drive the fresh-build
   * path deterministically instead of binding real OS ports (which on a host
   * already running Hindsight would spuriously report 18888/18889 occupied).
   * Production ⇒ {@link pickHindsightPorts}.
   */
  pickPorts?: typeof pickHindsightPorts;
  /**
   * Reads the ports the RUNNING authority container is actually bound to, for
   * the unserved-public-port guard on the already-running path. Injected so a
   * test can drive the half-built topology without docker. Production ⇒
   * {@link getRunningHindsightPorts}.
   */
  runningPortsProbe?: typeof getRunningHindsightPorts;
  /**
   * Host-port preflight seam, paired with {@link pickPorts}. Returns a conflict
   * descriptor (or null when free). Injected so the split's authority-port
   * preflight never probes a real socket in tests. Production ⇒
   * {@link preflightHindsightPorts}.
   */
  preflightPorts?: typeof preflightHindsightPorts;
}

/**
 * What step 6 actually left behind, so step 13 can hold it to account.
 *
 * `hindsightExpected` is true ONLY when this run believes a working
 * `switchroom-hindsight` container exists. Step 13 turns that into a hard
 * requirement (review H2): without it, every path where step 6 gave up
 * silently produced a wizard that ended with "Setup complete! Your agents
 * are running." over a dead memory backend.
 */
export interface MemoryBackendOutcome {
  hindsightExpected: boolean;
  /** True when the operator took the `none` opt-out (config or env). */
  optedOut: boolean;
}

/** True when memory is switched off by env or config — the H1 opt-out. */
export function isMemoryBackendDisabled(config: SwitchroomConfig): boolean {
  const memoryBackend = config.memory?.backend ?? "hindsight";
  return process.env.SWITCHROOM_MEMORY_BACKEND === "none" || memoryBackend === "none";
}

export async function stepMemoryBackend(
  config: SwitchroomConfig,
  nonInteractive: boolean,
  switchroomConfigPath: string,
  deps: MemoryBackendDeps = {},
): Promise<MemoryBackendOutcome> {
  stepHeader(6, "Memory backend", STEP_ACTIVE);

  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pickPorts = deps.pickPorts ?? pickHindsightPorts;
  const preflightPorts = deps.preflightPorts ?? preflightHindsightPorts;

  // Check if memory backend is configured and is hindsight
  if (isMemoryBackendDisabled(config)) {
    console.log(chalk.gray("  Memory backend disabled (set to 'none')."));
    console.log(chalk.green(`  ${STEP_DONE} Skipped`));
    return { hindsightExpected: false, optedOut: true };
  }

  // In non-interactive mode, default to hindsight unless env says otherwise
  let setupHindsight = true;
  if (!nonInteractive) {
    console.log(
      chalk.gray(
        "  Hindsight will use Anthropic OAuth via the auth-broker. The fleet's",
      ),
    );
    console.log(
      chalk.gray(
        "  active account (auth.active) is shared — no OpenAI API key is needed.",
      ),
    );
    setupHindsight = await askYesNo(
      "  Set up Hindsight memory? (recommended)",
      true,
    );
  }

  if (!setupHindsight) {
    console.log(chalk.gray("  Skipping Hindsight setup."));
    console.log(chalk.green(`  ${STEP_DONE} Skipped`));
    return { hindsightExpected: false, optedOut: false };
  }

  // Surface a one-liner if the legacy OpenAI key still exists in vault or env.
  // Pre-#1245 setups stored it under `hindsight-api-key`; pre-broker setups
  // also accepted HINDSIGHT_API_LLM_API_KEY. Neither is consulted any more.
  if (process.env.HINDSIGHT_API_LLM_API_KEY) {
    console.log(
      chalk.gray(
        "  Note: HINDSIGHT_API_LLM_API_KEY is set in your env but is no longer used. " +
          "You can remove it.",
      ),
    );
  }
  try {
    const vaultPath = resolvePath(config.vault?.path ?? "~/.switchroom/vault.enc");
    const passphrase = process.env.SWITCHROOM_VAULT_PASSPHRASE;
    if (passphrase && existsSync(vaultPath)) {
      // Dynamic import keeps this module's STATIC graph free of the vault →
      // `bun:sqlite` edge (so its vitest test can load). Runtime behaviour is
      // unchanged: the legacy `hindsight-api-key` courtesy note still fires.
      const { getStringSecret } = await import("../vault/vault.js");
      const existing = getStringSecret(passphrase, vaultPath, "hindsight-api-key");
      if (existing) {
        console.log(
          chalk.gray(
            "  Note: legacy 'hindsight-api-key' is in your vault but is no longer used. " +
              "You can remove it with `switchroom vault rm hindsight-api-key`.",
          ),
        );
      }
    }
  } catch { /* vault unreachable; skip the courtesy note */ }

  // Register the hindsight consumer in switchroom.yaml so the auth-broker
  // binds a per-consumer UDS for it on next `switchroom apply`. Registered
  // UNPINNED (no `account:`): the consumer follows the fleet `auth.active`
  // with the same failover agents get. Operators who want quota isolation
  // can add an explicit `account:` pin afterwards.
  {
    try {
      const result = await ensureHindsightConsumer(switchroomConfigPath);
      if (result.added) {
        console.log(
          chalk.green(
            `  ${STEP_DONE} Registered auth.consumers[${HINDSIGHT_CONSUMER_NAME}] (follows the fleet active account)`,
          ),
        );
      } else {
        console.log(
          chalk.gray(
            `  auth.consumers[${HINDSIGHT_CONSUMER_NAME}] already present.`,
          ),
        );
      }
    } catch (err) {
      console.log(
        chalk.yellow(
          `  Warning: could not write auth.consumers entry: ${(err as Error).message}`,
        ),
      );
    }
  }

  // Check Docker availability.
  //
  // Pre-H7 this printed a GREEN `OK Manual setup pending` and returned — so
  // a host with no Docker (where nothing in the fleet can run) still saw a
  // successful step and a "Setup complete!" at the end. Hindsight is the
  // default memory backend and it is a container; if Docker is absent the
  // step did not succeed, so say so and fail. (Compatible with the
  // hindsight-default-on direction in
  // docs/proposed/hindsight-litellm-integration-audit-2026-07-26.md item 5:
  // "a hard, named failure with a resume instruction". The opt-out below is
  // the documented escape hatch for a Docker-less machine.)
  // Review L8: `docker --version` only proves the CLI is on PATH. The far
  // more common macOS case is "installed but Docker Desktop isn't running",
  // where "Install Docker" is the wrong instruction. Name which one it is.
  const dockerState = probeDockerAvailability(deps.dockerProbe);
  if (dockerState !== "ok") {
    const noCli = dockerState === "no-cli";
    const headline = noCli
      ? "Docker is not installed (no `docker` command on PATH)."
      : "Docker is installed but its daemon is not responding.";
    const remedy = noCli
      ? "Install Docker (https://docs.docker.com/get-docker/), then re-run `switchroom setup`"
      : "Start Docker (on macOS: open Docker Desktop; on Linux: `sudo systemctl start docker`), " +
        "then re-run `switchroom setup`";
    console.log(chalk.red(`  x ${headline}`));
    console.log(
      chalk.gray(
        "  Hindsight memory runs as a Docker container (and so does every agent).",
      ),
    );
    console.log(
      chalk.gray(`  ${remedy} — or re-run with SWITCHROOM_MEMORY_BACKEND=none to skip memory setup.`),
    );
    throw new Error(
      `Memory backend setup failed: ${headline} ${remedy}, or set ` +
        "SWITCHROOM_MEMORY_BACKEND=none to skip it.",
    );
  }

  // Resolve the recall/background split config up front. It changes the launch
  // topology (a second container on the public port, the authority moved to
  // public+1), so first-run `switchroom setup` must honour it too — a knob
  // respected on `switchroom memory setup` but ignored here would be the same
  // silent divergence this PR exists to close. Degrade to single-container on a
  // malformed block rather than aborting the whole wizard (mirrors memory.ts).
  let recallPoolCfg: RecallPoolConfig | null;
  try {
    recallPoolCfg = resolveRecallPoolConfig(config.hindsight?.recall_pool);
  } catch (err) {
    console.log(
      chalk.yellow(
        `  ! Ignoring hindsight.recall_pool (${(err as Error).message}); ` +
          "starting the single-container topology.",
      ),
    );
    recallPoolCfg = null;
  }

  // A `hindsight.env` line for one of the split-managed DB-pool caps cannot
  // reach either container while the split is on (the split computes both, and
  // the connection budget is only provable if it does). Say so — silently
  // dropping an operator's declared value is the defect.
  if (recallPoolCfg) {
    for (const conflict of splitDbPoolEnvConflicts(config.hindsight?.env, recallPoolCfg)) {
      console.log(chalk.yellow(`  ! ${splitDbPoolEnvConflictWarning(conflict)}`));
    }
  }

  const startPool = deps.startRecallPool ?? startHindsightRecallPool;
  const waitHealthy = deps.waitForHealthy ?? waitForHindsightHealthy;
  /**
   * Role-aware health gate: the authority's first boot pays pg0 initdb + the
   * migration chain, so it gets a much longer deadline than the pool.
   */
  const waitHealthyFor = (port: number, role: HindsightHealthRole) =>
    waitHealthy(port, { role, workers: recallPoolCfg?.workers });
  const poolIsRunning = deps.recallPoolRunningProbe ?? isHindsightRecallPoolRunning;
  const stopPool = deps.stopRecallPool ?? stopHindsightRecallPool;

  const parseUrlPort = (u?: string): number | undefined => {
    try {
      const p = Number(new URL(u ?? "").port);
      return Number.isInteger(p) && p > 0 ? p : undefined;
    } catch {
      return undefined;
    }
  };

  // Secret resolution shared by the fresh launch and the pool-repair path, so
  // the pool container bakes the SAME resolved `vault:` refs the authority does
  // (the 2026-08-06 literal-`vault:` outage class), with the same drop warnings.
  const resolveLaunchSecrets = async () => {
    const { litellm: litellmCfg, droppedRef: litellmDroppedRef } =
      await resolveLiteLLMForHindsight(
        config,
        deps.getViaBrokerStructured ? { getViaBrokerStructured: deps.getViaBrokerStructured } : {},
      );
    if (litellmDroppedRef) {
      console.log(chalk.yellow(`  ! ${hindsightLiteLlmDroppedKeyWarning(litellmDroppedRef)}`));
    }
    const cpAccessKey = await resolveHindsightCpAccessKey(config);
    if (!cpAccessKey) {
      console.log(chalk.yellow(`  ! ${HINDSIGHT_CP_NO_ACCESS_KEY_WARNING}`));
    }
    const resolvedLlm = await resolveHindsightLlmSecrets(
      config.hindsight?.llm,
      deps.getViaBrokerStructured ? { getViaBrokerStructured: deps.getViaBrokerStructured } : {},
    );
    for (const drop of await diffDroppedHindsightLlmVaultKeys(config.hindsight?.llm, resolvedLlm)) {
      console.log(chalk.yellow(`  ! ${hindsightLlmDroppedKeyWarning(drop)}`));
    }
    return { litellmCfg, cpAccessKey, resolvedLlm };
  };

  // The split's launch ordering, health-gated like the memory.ts launcher, with
  // the SAME pool-failure fallback (shared orchestrator so the two paths cannot
  // diverge): the authority's pg0 must answer /health before the pool starts
  // (else the pool crash-loops on connection-refused). If the pool never becomes
  // healthy the authority is parked on public+1 with NOTHING on the public port
  // (memory.config.url refuses) — so we DEGRADE to a single container on the
  // public port rather than leave the fleet's memory endpoint unbound. Returns
  // the end topology so the caller prints the right message. Throws a named
  // `Memory backend setup failed:` error (step 13 catches it) only when even the
  // single-container fallback cannot come up.
  const launchRecallPool = async (
    cfg: RecallPoolConfig,
    publicApiPort: number,
    authorityApiPort: number,
    fallbackUiPort: number,
    secrets: Awaited<ReturnType<typeof resolveLaunchSecrets>>,
  ): Promise<"split" | "degraded"> => {
    const startContainer = deps.startContainer ?? startHindsight;
    const result = await launchRecallPoolHealthGated({
      publicApiPort,
      authorityApiPort,
      workers: cfg.workers,
      waitForHealthy: waitHealthyFor,
      stopPool,
      startPool: () =>
        startPool({
          cfg,
          poolPort: publicApiPort,
          litellm: secrets.litellmCfg,
          llm: secrets.resolvedLlm,
          // The authority caps its own DB pools when the split is on; the pool
          // container inherits the same env base plus its own overrides. The
          // managed caps win over `hindsight.env` (warned about above) so the
          // connection budget the launch asserted is the one that ships.
          perf: {
            env: splitContainerPerfEnv(config.hindsight?.env),
            memLimit: config.hindsight?.mem_limit,
          },
          cpAccessKey: secrets.cpAccessKey,
          // The pool serves REFLECT (OAuth-credentialed LLM calls), so it must
          // share the authority's creds mode (#2578): mirror volume when the
          // consumer has one, private tmpfs otherwise. Omitted, the pool would
          // silently run pull-only and serve reflect on credentials up to ~30
          // minutes stale after a broker account failover.
          mirrorDir: hindsightConsumerMirrorDir(config),
        }),
      degradeToSingleContainer: () => {
        // Stop the pool + the parked authority and relaunch a SOLE container on
        // the PUBLIC port with the single-container env (no background pool
        // caps), so memory.config.url is served again.
        stopPool();
        (deps.stopContainer ?? stopHindsight)();
        startContainer(
          { apiPort: publicApiPort, uiPort: fallbackUiPort },
          secrets.litellmCfg,
          undefined,
          secrets.resolvedLlm,
          hindsightConsumerMirrorDir(config),
          undefined,
          { env: config.hindsight?.env, memLimit: config.hindsight?.mem_limit },
          secrets.cpAccessKey,
        );
      },
      log: (m) => console.log(chalk.gray(m)),
    });
    switch (result.outcome) {
      case "split":
        return "split";
      case "degraded-single-container":
        console.log(
          chalk.yellow(
            `  ! Recall pool failed (${result.reason}); DEGRADED to a single container on the ` +
              `public port ${publicApiPort}. memory.config.url IS served, but the recall split is ` +
              `OFF — inspect \`docker logs ${HINDSIGHT_RECALL_POOL_CONTAINER}\` and re-run ` +
              "`switchroom setup` once fixed, or set hindsight.recall_pool.enabled: false.",
          ),
        );
        return "degraded";
      case "authority-unhealthy":
        throw new Error(
          `Memory backend setup failed: the authority container did not become healthy on ` +
            `${authorityApiPort}. Check \`docker logs switchroom-hindsight --tail 50\`, then ` +
            "re-run `switchroom setup`, or set hindsight.recall_pool.enabled: false to skip the split.",
        );
      case "degrade-failed":
        throw new Error(
          `Memory backend setup failed: the recall pool did not become healthy on ${publicApiPort} ` +
            `AND the single-container fallback also failed to bind the public port. Inspect ` +
            `\`docker logs switchroom-hindsight --tail 50\` and \`docker logs ` +
            `${HINDSIGHT_RECALL_POOL_CONTAINER}\`, then re-run \`switchroom setup\`, or set ` +
            "hindsight.recall_pool.enabled: false to skip the split.",
        );
    }
  };

  // Check if already running
  if (isHindsightRunning(deps.dockerProbe)) {
    // Authority is up. When the split is enabled but the pool sibling is dead
    // (an apply that outlived its pool, a crash, a prior single-container run),
    // restore JUST the pool so the public port is served — don't leave the
    // topology half-built and silently return success.
    if (recallPoolCfg && !poolIsRunning(deps.dockerProbe)) {
      console.log(
        chalk.gray(
          "  Authority container is up but the recall pool is not — restoring the pool...",
        ),
      );
      const secrets = await resolveLaunchSecrets();
      // The running authority sits at public+1; the public port comes from
      // config (an operator pin, or the port memory.ts persisted). basePorts
      // gives public+1 = the port the authority is already serving on.
      const { publicApiPort, basePorts } = resolveHindsightLaunchPorts({
        recallEnabled: true,
        configUrlPort: parseUrlPort(config.memory?.config?.url),
        reuseApiPort: undefined,
        uiPort: 0,
        defaultApiPort: HINDSIGHT_DEFAULT_API_PORT,
      });
      // fallbackUiPort: the authority is already running with its own UI port;
      // this is only used if the pool restore fails and we relaunch a sole
      // container. The default UI port is a safe fallback for that rare path.
      const topo = await launchRecallPool(
        recallPoolCfg,
        publicApiPort,
        basePorts.apiPort,
        HINDSIGHT_DEFAULT_UI_PORT,
        secrets,
      );
      if (topo === "split") {
        console.log(
          chalk.green(
            `  ${STEP_DONE} Recall pool restored on ${publicApiPort} (authority on ${basePorts.apiPort})`,
          ),
        );
      }
      return { hindsightExpected: true, optedOut: false };
    }
    // MIRROR IMAGE of the branch above: the split is DECLARED OFF but a pool
    // container is still running. `publicPortIsUnserved` deliberately says
    // "fine" here (the pool IS serving the public port), which used to mean the
    // step printed "already running" and left an orphan container standing
    // against declared config — durable across reboots via `--restart always`.
    // Converge instead.
    const staleRunningPorts = (deps.runningPortsProbe ?? getRunningHindsightPorts)();
    const stalePlan = planStaleRecallPoolConvergence({
      recallEnabled: recallPoolCfg !== null,
      poolRunning: poolIsRunning(deps.dockerProbe),
      authorityApiPort: staleRunningPorts?.apiPort,
      configUrlPort: parseUrlPort(config.memory?.config?.url),
    });
    if (stalePlan.action !== "none") {
      // Only the relaunch action launches a container, so only it needs
      // secrets — `stop-pool` must not spend broker round-trips to remove an
      // orphan.
      const staleSecrets =
        stalePlan.action === "relaunch-single-on-public"
          ? await resolveLaunchSecrets()
          : undefined;
      const startContainer = deps.startContainer ?? startHindsight;
      const staleResult = await convergeStaleRecallPool({
        plan: stalePlan,
        stopPool,
        relaunchSingleOnPublic: (publicApiPort) => {
          // ONE step: drop the pool that holds the public port and the parked
          // authority, then bring a sole container up ON the public port. The
          // health gate inside convergeStaleRecallPool is what makes this safe
          // to report on.
          stopPool();
          (deps.stopContainer ?? stopHindsight)();
          startContainer(
            {
              apiPort: publicApiPort,
              uiPort: staleRunningPorts?.uiPort ?? HINDSIGHT_DEFAULT_UI_PORT,
            },
            staleSecrets!.litellmCfg,
            undefined,
            staleSecrets!.resolvedLlm,
            hindsightConsumerMirrorDir(config),
            undefined,
            // Single-container env: NO split DB-pool caps, so `hindsight.env`
            // is authoritative again, exactly as the declared topology says.
            { env: config.hindsight?.env, memLimit: config.hindsight?.mem_limit },
            staleSecrets!.cpAccessKey,
          );
        },
        waitForHealthy: waitHealthyFor,
        log: (m) => console.log(chalk.gray(m)),
      });
      if (staleResult.outcome === "relaunch-failed") {
        const msg =
          `hindsight.recall_pool is disabled, but the single container relaunched on the ` +
          `public port ${staleResult.publicApiPort} did not become healthy — nothing is ` +
          `serving fleet memory.`;
        console.log(chalk.red(`  x ${msg}`));
        throw new Error(
          `Memory backend setup failed: ${msg} Inspect \`docker logs switchroom-hindsight ` +
            `--tail 50\`, then re-run \`switchroom setup\`.`,
        );
      }
      if (staleResult.outcome === "pool-stopped") {
        console.log(
          chalk.green(
            `  ${STEP_DONE} Removed the orphan recall pool (hindsight.recall_pool is disabled)`,
          ),
        );
      } else if (staleResult.outcome === "relaunched-single") {
        console.log(
          chalk.green(
            `  ${STEP_DONE} Converged to the declared single-container topology on ` +
              `${staleResult.publicApiPort}`,
          ),
        );
      }
      return { hindsightExpected: true, optedOut: false };
    }
    // "The authority container is running" is NOT the same as "memory works".
    // If it is parked on a port that is not the one `memory.config.url`
    // declares, and no pool is bound there, NOTHING serves the fleet's memory
    // endpoint — the half-built topology a split→single toggle (or a removed
    // pool) leaves behind, durable across reboots via `--restart always`.
    // Reporting "already running" over that is exactly the silent-success-over-
    // an-outage class review H2 closed for the other paths in this step.
    const runningPorts = staleRunningPorts;
    if (
      publicPortIsUnserved({
        configUrlPort: parseUrlPort(config.memory?.config?.url),
        authorityApiPort: runningPorts?.apiPort,
        poolRunning: poolIsRunning(deps.dockerProbe),
      })
    ) {
      const publicPort = parseUrlPort(config.memory?.config?.url);
      const msg =
        `switchroom-hindsight is running on port ${runningPorts?.apiPort}, but ` +
        `memory.config.url points at ${publicPort} and nothing is serving it — ` +
        `fleet memory is DOWN.`;
      console.log(chalk.red(`  x ${msg}`));
      throw new Error(
        `Memory backend setup failed: ${msg} Run \`switchroom memory setup --recreate\` ` +
          `to rebind it to ${publicPort}, or set hindsight.recall_pool.enabled: true to ` +
          `restore the recall pool on the public port.`,
      );
    }
    console.log(chalk.green(`  ${STEP_DONE} Hindsight container already running (switchroom-hindsight)`));
    return { hindsightExpected: true, optedOut: false };
  }

  // Check if container exists but is stopped
  if (isHindsightContainerExists(deps.dockerProbe)) {
    console.log(chalk.gray("  Found stopped switchroom-hindsight container, removing..."));
    stopHindsight();
  }
  // Also clear a stale recall-pool sibling before a fresh (re)build.
  stopPool();

  // Pick + preflight host ports through the SAME guard `switchroom memory`
  // uses, so a fresh install never hands an occupied host port to
  // `docker run` (the 2026-07 crash-loop: hindsight died on `[Errno 98]
  // address already in use` while fleet memory was silently down). Upstream
  // default 18888/19999 first, fall back to a free pair if occupied.
  //
  // Review H2: each `return` below used to leave the step "successful" with
  // no memory backend running — and step 13 had nothing to catch it, so the
  // wizard still printed "Setup complete! Your agents are running." They are
  // throws now, in the same shape as the Docker-absent failure above:
  // a named error with a resume instruction.
  let ports: { apiPort: number; uiPort: number };
  try {
    ports = await pickPorts();
  } catch (err) {
    console.log(chalk.red(`  ${(err as Error).message}`));
    throw new Error(
      `Memory backend setup failed: could not allocate Hindsight ports: ${
        (err as Error).message
      }. Free a port and re-run \`switchroom setup\`, or set ` +
        "SWITCHROOM_MEMORY_BACKEND=none to skip it.",
    );
  }
  if (ports.apiPort !== HINDSIGHT_DEFAULT_API_PORT) {
    console.log(
      chalk.yellow(
        `  Port ${HINDSIGHT_DEFAULT_API_PORT} is already in use; ` +
          `using ${ports.apiPort}/${ports.uiPort} instead.`,
      ),
    );
  }

  // Preflight: NEVER hand an occupied host port to `docker run`. If the
  // chosen port is occupied, re-pick from scratch; if still occupied, abort
  // loudly rather than crash-looping.
  let conflict = await preflightPorts(ports);
  if (conflict) {
    const heldBy = conflict.holder ? ` (held by ${conflict.holder})` : "";
    console.log(
      chalk.yellow(
        `  Chosen Hindsight port ${conflict.port} is occupied${heldBy}; ` +
          `selecting a free port instead of crash-looping.`,
      ),
    );
    try {
      ports = await pickPorts();
    } catch (err) {
      console.log(chalk.red(`  ${(err as Error).message}`));
      throw new Error(
        `Memory backend setup failed: could not allocate Hindsight ports after ` +
          `reassignment: ${(err as Error).message}. Free a port and re-run ` +
          "`switchroom setup`, or set SWITCHROOM_MEMORY_BACKEND=none to skip it.",
      );
    }
    conflict = await preflightPorts(ports);
    if (conflict) {
      const stillHeldBy = conflict.holder ? ` (held by ${conflict.holder})` : "";
      const msg =
        `Refusing to start Hindsight: port ${conflict.port} is still ` +
        `occupied${stillHeldBy} after reassignment.`;
      console.log(chalk.red(`  ${msg}`));
      throw new Error(
        `Memory backend setup failed: ${msg} Free it and re-run ` +
          "`switchroom setup`, or set SWITCHROOM_MEMORY_BACKEND=none to skip it.",
      );
    }
    console.log(
      chalk.green(`  Reassigned Hindsight to port ${ports.apiPort}/${ports.uiPort}.`),
    );
  }

  // Anchor the public port (memory.config.url) on config — an operator pin —
  // else the free port picked above. When the split is on the authority moves
  // to public+1 and the pool takes the public port; when off, basePorts IS the
  // public port, so the single-container path is unchanged.
  const { publicApiPort, basePorts } = resolveHindsightLaunchPorts({
    recallEnabled: recallPoolCfg != null,
    configUrlPort: parseUrlPort(config.memory?.config?.url),
    reuseApiPort: ports.apiPort,
    uiPort: ports.uiPort,
    defaultApiPort: HINDSIGHT_DEFAULT_API_PORT,
  });
  // The authority's public+1 port is not covered by the single-container
  // preflight above; verify it too. Refuse rather than reassign — relocating it
  // would desync the pool's public port from what agents hit.
  if (recallPoolCfg) {
    const bgConflict = await preflightPorts({
      apiPort: basePorts.apiPort,
      uiPort: basePorts.apiPort,
    });
    if (bgConflict) {
      const heldBy = bgConflict.holder ? ` (held by ${bgConflict.holder})` : "";
      const msg =
        `Refusing to start the hindsight recall split: authority port ` +
        `${bgConflict.port} is occupied${heldBy}.`;
      console.log(chalk.red(`  ${msg}`));
      throw new Error(
        `Memory backend setup failed: ${msg} Free it and re-run \`switchroom setup\`, ` +
          "or set hindsight.recall_pool.enabled: false to skip the split.",
      );
    }
  }

  // Start the (authority, when split; sole, when not) container in broker-fed
  // mode (no API key). Secrets are resolved by the shared helper so the pool —
  // launched below — bakes the identical resolved `vault:` refs.
  const spin = spinner("Starting Hindsight Docker container...");
  let launchSecrets: Awaited<ReturnType<typeof resolveLaunchSecrets>>;
  try {
    launchSecrets = await resolveLaunchSecrets();
    // When the split is on the authority caps its own DB pools to free
    // connection headroom for the pool's N workers (the keys ride the
    // HINDSIGHT_PERF_ENV_KEYS allowlist). Those two caps are MANAGED: they win
    // over `hindsight.env`, because the connection budget asserted at resolve
    // time is only a proof if the containers launch with the asserted numbers.
    // A superseded `hindsight.env` value was warned about above.
    const authorityEnv = recallPoolCfg
      ? splitContainerPerfEnv(config.hindsight?.env)
      : config.hindsight?.env;
    const startContainer = deps.startContainer ?? startHindsight;
    startContainer(
      basePorts,
      launchSecrets.litellmCfg,
      undefined,
      launchSecrets.resolvedLlm,
      hindsightConsumerMirrorDir(config),
      // gpu: omitted ⇒ hindsightGpuEnabled() reads the persisted verdict.
      undefined,
      // The container's memory cap (`hindsight.mem_limit`, absent ⇒
      // HINDSIGHT_DEFAULT_MEM_LIMIT) plus the `hindsight.env` overrides the
      // cap is checked against — the shared_buffers-vs-cap warning is only
      // honest when it can see the operator's shared_buffers override, and a
      // knob honoured on `memory setup` but ignored on first-run `switchroom
      // setup` would be the same silent divergence again.
      { env: authorityEnv, memLimit: config.hindsight?.mem_limit },
      // Resolved `hindsight.cp_access_key` — absent ⇒ loginless dashboard,
      // pinned to loopback by hindsightCpAuthEnvPairs.
      launchSecrets.cpAccessKey,
    );
    if (launchSecrets.litellmCfg) {
      console.log(chalk.gray("  LiteLLM routing enabled (--network host, ANTHROPIC_BASE_URL set)."));
    }
  } catch (err) {
    spin.stop(chalk.red(`Failed to start Hindsight: ${(err as Error).message}`));
    console.log(
      chalk.gray(
        "  Make sure `switchroom apply` has run so the auth-broker " +
          `consumer socket volume (auth-broker-${HINDSIGHT_CONSUMER_NAME}-sock) exists.`,
      ),
    );
    throw new Error(
      `Memory backend setup failed: ${(err as Error).message}. Fix the cause and ` +
        "re-run `switchroom setup`, or set SWITCHROOM_MEMORY_BACKEND=none to skip it.",
    );
  }

  // `docker run -d` returning is not evidence the container survived. Re-check
  // a few times before deciding (a container that dies during startup drops
  // out of `docker ps` within a second or two). Deliberately OUTSIDE the try
  // above so this verdict is not re-wrapped as a start error.
  let running = isHindsightRunning(deps.dockerProbe);
  const retries = deps.readyRetries ?? HINDSIGHT_READY_RETRIES;
  for (let i = 0; !running && i < retries; i++) {
    await sleep(HINDSIGHT_READY_INTERVAL_MS);
    running = isHindsightRunning(deps.dockerProbe);
  }

  if (!running) {
    // H2: this was a yellow "Container started but may still be
    // initializing" that the wizard then reported as overall success.
    spin.stop(chalk.red("Hindsight container did not stay running after start"));
    throw new Error(
      "Memory backend setup failed: switchroom-hindsight did not stay running " +
        "after start. Check `docker logs switchroom-hindsight --tail 50`, then " +
        "re-run `switchroom setup`, or set SWITCHROOM_MEMORY_BACKEND=none to skip it.",
    );
  }

  spin.stop(chalk.green(`${STEP_DONE} Hindsight container started (switchroom-hindsight)`));

  // Split: the container just started is the AUTHORITY (on public+1); now
  // health-gate it and bring up the recall pool on the public port. A failure
  // here throws a named `Memory backend setup failed:` error (step 13 catches
  // it), so the wizard never reports success over a half-built split.
  if (recallPoolCfg) {
    const topo = await launchRecallPool(
      recallPoolCfg,
      publicApiPort,
      basePorts.apiPort,
      basePorts.uiPort,
      launchSecrets,
    );
    if (topo === "split") {
      console.log(
        chalk.green(
          `  ${STEP_DONE} Hindsight recall split started: authority (pg0 + background) on ` +
            `${basePorts.apiPort}, ${recallPoolCfg.workers}-worker recall pool on ${publicApiPort}`,
        ),
      );
    }
    // A `degraded` topology already logged its own warning inside launchRecallPool;
    // the container serving the public port is now a single container, and the
    // API/UI lines printed below still describe the live public port.
  }

  console.log(chalk.gray(`  API: http://localhost:${publicApiPort}/mcp`));
  console.log(chalk.gray(`  UI:  http://localhost:${basePorts.uiPort}`));

  return { hindsightExpected: true, optedOut: false };
}
