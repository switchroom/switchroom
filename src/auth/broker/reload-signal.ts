/**
 * Trigger a hot-reload of the running `switchroom-auth-broker` singleton.
 *
 * The broker already supports a full config hot-reload: its SIGHUP handler
 * (`src/auth/broker/index.ts`) re-reads `switchroom.yaml` from disk and calls
 * `AuthBroker.reload()`, which swaps `this.config` and reconciles listeners —
 * so a SIGHUP makes ACL (`microsoft_accounts.<acct>.enabled_for[]`) and
 * selector (`agents.<name>.microsoft_workspace.account`) edits take effect
 * live. The machinery exists; the historical gap was that NOTHING sent the
 * signal. After a config-mutating verb (`auth microsoft enable/disable`,
 * `account add`, `apply`) the broker kept serving its boot-time config and
 * returned `ACCOUNT_NOT_FOUND` until the operator manually
 * `docker restart`ed it.
 *
 * This helper closes that gap: it sends SIGHUP to the broker container
 * (delivered through tini → the bun process) so the change is live without a
 * restart. It is best-effort and never throws — if Docker is absent or the
 * broker isn't running, it returns a structured reason and the caller falls
 * back to telling the operator to restart the broker.
 */

import { spawnSync } from "node:child_process";

/** The broker's `container_name` in the generated compose file. */
export const AUTH_BROKER_CONTAINER = "switchroom-auth-broker";

export type AuthBrokerReloadResult =
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
 * Send SIGHUP to the auth-broker container so it hot-reloads switchroom.yaml.
 * Best-effort, never throws.
 *
 * - `{ ok: true }` — the signal was delivered (broker reloaded in place).
 * - `{ ok: false, reason: "no-docker" }` — `docker` binary not found.
 * - `{ ok: false, reason: "not-running" }` — no such container / not running.
 * - `{ ok: false, reason: "error" }` — any other docker failure (detail set).
 */
export function reloadAuthBroker(
  opts: { runner?: DockerRunner; container?: string } = {},
): AuthBrokerReloadResult {
  const runner = opts.runner ?? defaultRunner;
  const container = opts.container ?? AUTH_BROKER_CONTAINER;
  const { status, stderr, error } = runner([
    "kill",
    "--signal=HUP",
    container,
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

/**
 * Render a one-line operator hint for a non-ok reload result. Returns null
 * when the reload succeeded (caller prints its own success line).
 */
export function authBrokerReloadHint(
  result: AuthBrokerReloadResult,
): string | null {
  if (result.ok) return null;
  switch (result.reason) {
    case "not-running":
      // No live broker — the next boot reads the new config anyway, so this is
      // informational, not an error.
      return "auth-broker is not running — it will pick up this change on next start.";
    case "no-docker":
      return "Could not reach Docker to hot-reload the auth-broker; restart it so the change takes effect: docker restart switchroom-auth-broker";
    case "error":
      return `Could not hot-reload the auth-broker (${result.detail ?? "unknown error"}); restart it so the change takes effect: docker restart switchroom-auth-broker`;
  }
}
