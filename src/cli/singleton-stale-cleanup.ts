/**
 * Stale-container reconciliation for singleton compose projects.
 *
 * Background: each singleton (`switchroom-hostd`, `switchroom-web`) runs in
 * its OWN compose project (e.g. project `switchroom-hostd`, workdir
 * `~/.switchroom/hostd`). When a host previously ran the singleton from a
 * DIFFERENT working directory or project (e.g. an old containerized-path
 * install: project `hostd`, workdir `/wd/hostd`), docker compose treats the
 * two setups as DIFFERENT project instances and tries to CREATE — not
 * RECREATE — the container, because the old container isn't part of the
 * target project. That CREATE then fails with a container-name conflict
 * ("the container name /switchroom-hostd is already in use") because the
 * stale old container still holds the name.
 *
 * Fix: before `docker compose up -d` for a singleton, probe whether a
 * container holding the target `container_name` exists but belongs to a
 * different compose project. If so, force-remove the stale container so the
 * create succeeds. The operation is logged and idempotent.
 *
 * Broke the v0.15.48 rollout for both hostd and web; operator had to
 * manually `docker rm switchroom-hostd switchroom-web` to unblock it.
 */

import { spawnSync } from "node:child_process";

/**
 * Result of probing for a stale container.
 */
export interface StaleContainerProbeResult {
  /** Whether a stale container was found and removed. */
  removed: boolean;
  /** Container name that was (or wasn't) cleaned up. */
  containerName: string;
  /** The old project it belonged to, if stale. */
  oldProject?: string;
  /** Error message if the probe or removal failed. */
  error?: string;
}

/**
 * Run a docker command and return stdout/stderr/ok.
 * Exported for testing via dependency injection.
 */
export type DockerRunner = (args: string[]) => { ok: boolean; stdout: string; stderr: string };

export function makeDockerRunner(): DockerRunner {
  return (args) => {
    const r = spawnSync("docker", args, { encoding: "utf8" });
    return {
      ok: r.status === 0,
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
    };
  };
}

/**
 * Probe for a stale container and remove it if found.
 *
 * A container is considered "stale" if:
 *   - It exists (docker inspect succeeds), AND
 *   - Its `com.docker.compose.project` label differs from `targetProject`.
 *
 * When stale, force-removes it so the subsequent `docker compose up -d`
 * can CREATE the container under the target project without a name conflict.
 *
 * Idempotent: if the container doesn't exist, or belongs to the target
 * project already, this is a no-op.
 *
 * @param containerName  The docker container_name to check (e.g. "switchroom-hostd").
 * @param targetProject  The compose project name we're about to `up` into.
 * @param log            Progress emitter (caller decides where to write).
 * @param docker         Docker runner (injectable for tests).
 */
export function removeStaleContainerIfNeeded(
  containerName: string,
  targetProject: string,
  log: (line: string) => void,
  docker: DockerRunner = makeDockerRunner(),
): StaleContainerProbeResult {
  // Inspect the named container — fails (non-zero) if it doesn't exist.
  const inspect = docker([
    "inspect",
    "--format",
    "{{index .Config.Labels \"com.docker.compose.project\"}}",
    containerName,
  ]);

  if (!inspect.ok) {
    // Container doesn't exist — nothing to do.
    return { removed: false, containerName };
  }

  const existingProject = inspect.stdout.trim();

  if (existingProject === targetProject) {
    // Already owned by our project — compose will RECREATE it correctly.
    return { removed: false, containerName };
  }

  // Stale: container exists under a different project (or no project label at all).
  log(
    `  removing stale container ${containerName} from old project "${existingProject || "(none)"}" before recreate`,
  );

  const rm = docker(["rm", "-f", containerName]);
  if (!rm.ok) {
    const error = `docker rm -f ${containerName} failed: ${rm.stderr.trim()}`;
    log(`  warning: ${error}`);
    return { removed: false, containerName, oldProject: existingProject, error };
  }

  log(`  removed stale container ${containerName} (was project "${existingProject || "(none)"}")`);
  return { removed: true, containerName, oldProject: existingProject };
}
