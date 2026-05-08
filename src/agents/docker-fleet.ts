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
import { execFileSync } from "node:child_process";
import { generateCompose } from "./compose.js";
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

  const compose =
    opts.generateComposeContent?.() ??
    generateCompose({ config: opts.config });
  const composePath = resolve(composeDir, "docker-compose.yml");
  writeFileSync(composePath, compose, { mode: 0o644 });

  const dockerBin = opts.dockerBin ?? "docker";
  const stdio = opts.stdio ?? "inherit";
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
