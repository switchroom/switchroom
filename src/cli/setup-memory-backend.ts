import chalk from "chalk";
import { existsSync } from "node:fs";
import { resolvePath } from "../config/loader.js";
import type { SwitchroomConfig } from "../config/schema.js";
import {
  probeDockerAvailability,
  isHindsightRunning,
  isHindsightContainerExists,
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
  backgroundContainerPoolEnv,
  waitForHindsightHealthy,
  HINDSIGHT_RECALL_POOL_CONTAINER,
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

  const startPool = deps.startRecallPool ?? startHindsightRecallPool;
  const waitHealthy = deps.waitForHealthy ?? waitForHindsightHealthy;
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

  // The split's launch ordering, health-gated like the memory.ts launcher:
  // the authority's pg0 must answer /health before the pool starts (else the
  // pool crash-loops on connection-refused), and the pool must be healthy on
  // the public port before the step reports success. Throws a named
  // `Memory backend setup failed:` error so step 13 catches a half-built split.
  const launchRecallPool = async (
    cfg: RecallPoolConfig,
    publicApiPort: number,
    authorityApiPort: number,
    secrets: Awaited<ReturnType<typeof resolveLaunchSecrets>>,
  ): Promise<void> => {
    console.log(
      chalk.gray(
        `  Waiting for the authority container to become healthy on ${authorityApiPort} (pg0 startup)...`,
      ),
    );
    if (!(await waitHealthy(authorityApiPort))) {
      throw new Error(
        `Memory backend setup failed: the authority container did not become healthy on ` +
          `${authorityApiPort}. Check \`docker logs switchroom-hindsight --tail 50\`, then ` +
          "re-run `switchroom setup`, or set hindsight.recall_pool.enabled: false to skip the split.",
      );
    }
    // Clear any stale sibling so `docker run --name` cannot hit a name conflict.
    stopPool();
    console.log(chalk.gray(`  Starting recall pool (${cfg.workers} workers) on ${publicApiPort}...`));
    startPool({
      cfg,
      poolPort: publicApiPort,
      litellm: secrets.litellmCfg,
      llm: secrets.resolvedLlm,
      // The authority caps its own DB pools when the split is on; the pool
      // container inherits the same env base plus its own overrides.
      perf: {
        env: { ...backgroundContainerPoolEnv(), ...(config.hindsight?.env ?? {}) },
        memLimit: config.hindsight?.mem_limit,
      },
      cpAccessKey: secrets.cpAccessKey,
    });
    if (!(await waitHealthy(publicApiPort))) {
      throw new Error(
        `Memory backend setup failed: the recall pool did not become healthy on ${publicApiPort}. ` +
          `Inspect \`docker logs ${HINDSIGHT_RECALL_POOL_CONTAINER}\`, or set ` +
          "hindsight.recall_pool.enabled: false and re-run `switchroom setup`.",
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
      await launchRecallPool(recallPoolCfg, publicApiPort, basePorts.apiPort, secrets);
      console.log(
        chalk.green(
          `  ${STEP_DONE} Recall pool restored on ${publicApiPort} (authority on ${basePorts.apiPort})`,
        ),
      );
      return { hindsightExpected: true, optedOut: false };
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
    // HINDSIGHT_PERF_ENV_KEYS allowlist); an explicit `hindsight.env` still wins.
    const authorityEnv = recallPoolCfg
      ? { ...backgroundContainerPoolEnv(), ...(config.hindsight?.env ?? {}) }
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
    await launchRecallPool(recallPoolCfg, publicApiPort, basePorts.apiPort, launchSecrets);
    console.log(
      chalk.green(
        `  ${STEP_DONE} Hindsight recall split started: authority (pg0 + background) on ` +
          `${basePorts.apiPort}, ${recallPoolCfg.workers}-worker recall pool on ${publicApiPort}`,
      ),
    );
  }

  console.log(chalk.gray(`  API: http://localhost:${publicApiPort}/mcp`));
  console.log(chalk.gray(`  UI:  http://localhost:${basePorts.uiPort}`));

  return { hindsightExpected: true, optedOut: false };
}
