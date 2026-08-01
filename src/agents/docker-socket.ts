/**
 * Host docker-socket path resolution (#3648).
 *
 * The compose generator bind-mounts the host docker socket into two
 * privileged services: the `docker-socket-proxy` sidecar (hostd, `:ro`)
 * and any `root: true` agent (`:rw`). Both historically hard-coded
 * `/var/run/docker.sock`. That is correct on a stock Linux daemon, but a
 * host whose active docker context points the endpoint elsewhere (a
 * rootless install under `$XDG_RUNTIME_DIR/docker.sock`, a relocated
 * daemon socket) gets a dangling mount source — docker auto-creates an
 * empty directory there and the proxy / root agent can't reach the API.
 *
 * Resolve the real socket path ONCE at generation time from the active
 * docker context, so the emitted compose binds the path the daemon is
 * actually listening on.
 *
 * CAVEAT (honest): the Docker Desktop / rootless breakage this guards
 * against is suspected, not reproduced — this is mount hygiene. Non-unix
 * endpoints (`tcp://`, `ssh://`, `npipe://`) have no bind-mountable path,
 * so they fall back to the conventional default and the operator keeps
 * whatever behaviour they had before.
 */
import { spawnSync } from "node:child_process";

/** Conventional default docker socket path — the fallback for every
 *  branch where the active context yields no bind-mountable unix path. */
export const DEFAULT_DOCKER_SOCKET_PATH = "/var/run/docker.sock";

/**
 * Query the active docker context for its endpoint host string, e.g.
 * `unix:///var/run/docker.sock`. Returns null when docker is not on PATH,
 * the probe fails, or it produces no usable output. Injectable so the
 * resolver stays unit-testable without a real docker daemon.
 */
function probeActiveContextEndpoint(): string | null {
  try {
    const r = spawnSync(
      "docker",
      ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
      { encoding: "utf8", timeout: 5000 },
    );
    if (r.status === 0 && typeof r.stdout === "string") {
      const host = r.stdout.trim();
      return host.length > 0 ? host : null;
    }
  } catch {
    // docker missing / spawn failure — caller falls back to the default.
  }
  return null;
}

/**
 * Resolve the host-side docker socket path from the active docker context,
 * stripping the `unix://` scheme. Falls back to
 * {@link DEFAULT_DOCKER_SOCKET_PATH} for any non-unix endpoint or when the
 * probe yields nothing.
 *
 * @param probe injectable endpoint probe (defaults to the live
 *   `docker context inspect`); tests pass a stub to exercise each branch.
 */
export function resolveDockerSocketPath(
  probe: () => string | null = probeActiveContextEndpoint,
): string {
  const host = probe();
  if (host) {
    const trimmed = host.trim();
    if (trimmed.startsWith("unix://")) {
      const path = trimmed.slice("unix://".length);
      if (path.length > 0) return path;
    }
    // Non-unix endpoint (tcp://, ssh://, npipe://) — nothing bind-mountable.
  }
  return DEFAULT_DOCKER_SOCKET_PATH;
}
