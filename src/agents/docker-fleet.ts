/**
 * Docker-runtime helpers for `switchroom agent add` (Phase 3a/3b).
 *
 * Extracted from `src/cli/agent.ts` so:
 *   1. The "regenerate compose, write to disk, `docker compose up -d
 *      --no-deps agent-<name>`" sequence is reusable from tests
 *      (closes #810 — the race test was bypassing this codepath with
 *      a bespoke `docker compose up`).
 *   2. The runtime root (defaulting to `${HOME}/.switchroom`) is now
 *      overridable via the `SWITCHROOM_HOME` env var or an explicit
 *      argument, so test invocations don't mutate the operator's real
 *      `~/.switchroom/`.
 *
 * This is a code-move, not a behaviour change. The existing CLI call
 * site continues to use the same default-`HOME`-derived path; the
 * helper just makes the path injectable.
 */

import { resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { generateCompose } from "./compose.js";
import { findConfigFile } from "../config/loader.js";
import type { SwitchroomConfig } from "../config/schema.js";

export interface BringUpAgentServiceOpts {
  /**
   * Switchroom config used to render the compose YAML. Caller is
   * responsible for ensuring the agent already has a config entry.
   */
  config: SwitchroomConfig;
  /** Agent slug (must match a `services.agent-<slug>` entry in the rendered compose). */
  agentName: string;
  /**
   * Optional override for the switchroom home dir. Resolution order:
   *   1. explicit value (tests pass a tmpdir here)
   *   2. SWITCHROOM_HOME env var
   *   3. `${HOME}/.switchroom`
   *
   * Compose YAML is written to `<switchroomHome>/compose/docker-compose.yml`.
   */
  switchroomHome?: string;
  /**
   * Absolute path to the active switchroom.yaml. Threaded into
   * {@link generateCompose} as `switchroomConfigPath` so the singleton
   * services (vault-broker, approval-kernel, switchroom-auth-broker)
   * get the `SWITCHROOM_CONFIG` env var + read-only bind mount they
   * need to boot. Without this, every `switchroom agent add` overwrites
   * `~/.switchroom/compose/docker-compose.yml` with a file where those
   * singletons restart-loop on `ConfigError: No switchroom.yaml found`
   * the next time compose recreates them. Defaults to
   * {@link findConfigFile}.
   */
  switchroomConfigPath?: string;
  /** Override compose generator (tests inject a pre-built YAML). */
  generateComposeContent?: () => string;
  /** Override docker binary path (tests). */
  dockerBin?: string;
  /** Inherit/inherit-pipe stdio. Defaults to `inherit`. */
  stdio?: "inherit" | "pipe" | "ignore";
}

export interface BringUpAgentServiceResult {
  composePath: string;
  composeProject?: string;
}

/**
 * Resolve the switchroom home directory using the documented precedence
 * (explicit > env > HOME-derived). Exported for tests + doctor.
 */
export function resolveSwitchroomHome(explicit?: string): string {
  if (explicit && explicit.length > 0) return explicit;
  const envHome = process.env.SWITCHROOM_HOME;
  if (envHome && envHome.length > 0) return envHome;
  return resolve(process.env.HOME ?? "", ".switchroom");
}

/**
 * Regenerate compose, persist it, and bring just the named agent's
 * service online via `docker compose up -d --no-deps agent-<name>`.
 *
 * Mirrors the docker-runtime branch of `switchroom agent add`. Throws
 * on docker failure — caller decides on rollback.
 */
export function bringUpAgentService(
  opts: BringUpAgentServiceOpts,
): BringUpAgentServiceResult {
  const home = resolveSwitchroomHome(opts.switchroomHome);
  const composeDir = resolve(home, "compose");
  mkdirSync(composeDir, { recursive: true, mode: 0o755 });

  // Resolve the active switchroom.yaml path before generating compose.
  // Without `switchroomConfigPath`, generateCompose emits a compose file
  // where vault-broker / approval-kernel / switchroom-auth-broker have
  // no SWITCHROOM_CONFIG env or config bind mount, and they restart-loop
  // on `ConfigError: No switchroom.yaml found` the next time compose
  // recreates them. Bail loud rather than persisting a broken compose.
  let switchroomConfigPath = opts.switchroomConfigPath;
  if (!switchroomConfigPath && !opts.generateComposeContent) {
    try {
      switchroomConfigPath = findConfigFile();
    } catch (err) {
      throw new Error(
        `bringUpAgentService: could not locate switchroom.yaml to thread ` +
          `into generateCompose (set SWITCHROOM_CONFIG or pass ` +
          `switchroomConfigPath). Refusing to write a compose file whose ` +
          `singletons would restart-loop on ConfigError. Underlying: ` +
          `${(err as Error).message}`,
      );
    }
  }

  const compose =
    opts.generateComposeContent?.() ??
    // PR-A1 made compose interpolation use absolute HOME paths instead of
    // ${HOME}; that fix requires threading homeDir through to
    // generateCompose. Without it, sudo'd `agent add` would re-write
    // compose.yml with /root/-rooted paths.
    generateCompose({
      config: opts.config,
      homeDir: homedir(),
      switchroomConfigPath,
    });
  const composePath = resolve(composeDir, "docker-compose.yml");
  // 0o600 matches `switchroom apply` — compose can contain references to
  // sockets/state under the operator's home and shouldn't be world-readable.
  writeFileSync(composePath, compose, { mode: 0o600 });

  const dockerBin = opts.dockerBin ?? "docker";
  const stdio = opts.stdio ?? "inherit";

  // Recreate the singletons FIRST so their per-agent volume lists pick
  // up the new agent's socket dir before the agent itself comes online
  // and tries to talk to them. Without this step the broker enumerates
  // its bind-mounted /run/switchroom/broker/<agent> directories once
  // at startup; an agent added later mounts the volume from its side
  // but the broker never binds the matching socket, so every vault
  // operation from the new agent fails with `VAULT-BROKER-DENIED:
  // broker not running` (#1017). `--no-deps` keeps us from recursively
  // bouncing other agents (only the broker + kernel are touched).
  for (const svc of ["vault-broker", "approval-kernel"] as const) {
    execFileSync(
      dockerBin,
      [
        "compose",
        "-f",
        composePath,
        "up",
        "-d",
        "--no-deps",
        "--force-recreate",
        svc,
      ],
      { stdio },
    );
  }

  execFileSync(
    dockerBin,
    [
      "compose",
      "-f",
      composePath,
      "up",
      "-d",
      "--no-deps",
      `agent-${opts.agentName}`,
    ],
    { stdio },
  );

  return { composePath };
}
