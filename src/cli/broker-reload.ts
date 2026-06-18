/**
 * Trigger a hot-reload of a running switchroom broker singleton
 * (`switchroom-auth-broker` / `switchroom-vault-broker`).
 *
 * Both brokers cache `switchroom.yaml` at boot and read it for every
 * authorization decision (the auth-broker for Microsoft/Google account ACLs,
 * the vault-broker for secret ACLs + agent-admin + approval posture). Both
 * have a SIGHUP handler that re-reads the config from disk and swaps the live
 * `this.config` — so a SIGHUP makes config edits take effect WITHOUT a
 * container restart, and without disturbing in-flight state (e.g. the
 * vault-broker's decrypted vault, which lives in separate fields).
 *
 * The machinery exists on the receive side; the historical gap is that
 * NOTHING sends the signal — after a config-mutating verb (`auth microsoft
 * enable/disable`, `apply`, a vault ACL / admin / posture edit) the broker
 * kept serving its boot-time config until a manual `docker restart`. This
 * helper closes that gap. It is best-effort and never throws — if Docker is
 * absent or the broker isn't running, it returns a structured reason and the
 * caller falls back to telling the operator to restart the broker.
 */

import { spawnSync } from "node:child_process";

/** The brokers' `container_name`s in the generated compose file. */
export const AUTH_BROKER_CONTAINER = "switchroom-auth-broker";
export const VAULT_BROKER_CONTAINER = "switchroom-vault-broker";

export type BrokerReloadResult =
  | { ok: true }
  | { ok: false; reason: "not-running" | "no-docker" | "error"; detail?: string };

/** Injectable for tests — mirrors the relevant slice of `spawnSync`. */
export type DockerRunner = (
  args: string[],
) => { status: number | null; stderr: string; error?: Error };

const defaultRunner: DockerRunner = (args) => {
  const r = spawnSync("docker", args, { encoding: "utf8" });
  return {
    status: r.status,
    stderr: typeof r.stderr === "string" ? r.stderr : "",
    error: r.error as Error | undefined,
  };
};

/**
 * Send SIGHUP to a broker container so it hot-reloads switchroom.yaml.
 * Best-effort, never throws.
 *
 * - `{ ok: true }` — the signal was delivered (broker reloaded in place).
 * - `{ ok: false, reason: "no-docker" }` — `docker` binary not found.
 * - `{ ok: false, reason: "not-running" }` — no such container / not running.
 * - `{ ok: false, reason: "error" }` — any other docker failure (detail set).
 */
export function reloadBroker(
  opts: { container: string; runner?: DockerRunner },
): BrokerReloadResult {
  const runner = opts.runner ?? defaultRunner;
  const { status, stderr, error } = runner([
    "kill",
    "--signal=HUP",
    opts.container,
  ]);

  if (error) {
    // ENOENT → docker binary not installed/on PATH.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, reason: "no-docker" };
    }
    return { ok: false, reason: "error", detail: error.message };
  }
  if (status === 0) return { ok: true };

  // docker exits non-zero when the container is absent or stopped — both mean
  // "no live broker to signal", which the caller surfaces as a restart hint.
  const lower = stderr.toLowerCase();
  if (
    lower.includes("no such container") ||
    lower.includes("is not running") ||
    lower.includes("cannot kill")
  ) {
    return { ok: false, reason: "not-running" };
  }
  return { ok: false, reason: "error", detail: stderr.trim() || `exit ${status}` };
}

/** Hot-reload the auth-broker. See {@link reloadBroker}. */
export function reloadAuthBroker(
  opts: { runner?: DockerRunner; container?: string } = {},
): BrokerReloadResult {
  return reloadBroker({
    container: opts.container ?? AUTH_BROKER_CONTAINER,
    runner: opts.runner,
  });
}

/** Hot-reload the vault-broker. See {@link reloadBroker}. */
export function reloadVaultBroker(
  opts: { runner?: DockerRunner; container?: string } = {},
): BrokerReloadResult {
  return reloadBroker({
    container: opts.container ?? VAULT_BROKER_CONTAINER,
    runner: opts.runner,
  });
}

/**
 * Render a one-line operator hint for a non-ok reload result. Returns null
 * when the reload succeeded (caller prints its own success line). `container`
 * names the broker in the restart hint.
 */
export function brokerReloadHint(
  result: BrokerReloadResult,
  container: string,
): string | null {
  if (result.ok) return null;
  switch (result.reason) {
    case "not-running":
      // No live broker — the next boot reads the new config anyway, so this is
      // informational, not an error.
      return `${container} is not running — it will pick up this change on next start.`;
    case "no-docker":
      return `Could not reach Docker to hot-reload ${container}; restart it so the change takes effect: docker restart ${container}`;
    case "error":
      return `Could not hot-reload ${container} (${result.detail ?? "unknown error"}); restart it so the change takes effect: docker restart ${container}`;
  }
}

/**
 * Back-compat convenience used by `auth microsoft enable/disable`: an
 * auth-broker-specific hint wrapper.
 */
export function authBrokerReloadHint(result: BrokerReloadResult): string | null {
  return brokerReloadHint(result, AUTH_BROKER_CONTAINER);
}
