/**
 * switchroom-auth-broker doctor checks (RFC H).
 *
 * Five operator-facing probes that mirror the visibility coverage the
 * vault-broker has via its inline state — surfaced through `switchroom
 * doctor` so the operator sees broker-side problems before agents start
 * failing to boot:
 *
 *   1. service health   — is `switchroom-auth-broker` healthy in compose?
 *   2. per-agent socket — does every configured agent have a bound
 *      socket inside the broker container?
 *   3. drift signal     — does every entry in sha-index.json match the
 *      on-disk credentials.json for that label? (Same probe the broker
 *      runs at boot — if doctor sees it first, the operator gets
 *      advance warning before the next compose recreate fails the
 *      healthcheck.)
 *   4. threshold viols  — is `threshold-violations.json` all zeros?
 *      Non-zero means claude refreshed under the broker — REFRESH_
 *      THRESHOLD_MS is too tight.
 *   5. active configured — is `auth.active` set in switchroom.yaml AND
 *      does the named account directory exist on disk?
 *
 * All probes accept dependency-injected filesystem / docker access so
 * the tests in `tests/doctor-auth-broker.test.ts` can drive every
 * branch without spinning up real containers.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

import { accountCredentialsPath, accountDir } from "../auth/account-store.js";
import { resolveStatePath } from "../config/paths.js";
import type { SwitchroomConfig } from "../config/schema.js";

export type CheckStatus = "ok" | "warn" | "fail";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail?: string;
  fix?: string;
}

/** Compose service name. The container_name is `switchroom-auth-broker`. */
export const AUTH_BROKER_SERVICE = "switchroom-auth-broker";
export const AUTH_BROKER_CONTAINER = "switchroom-auth-broker";

/** Filesystem + docker injection seam. Tests pass fakes; production uses real syscalls. */
export interface AuthBrokerProbeDeps {
  /** Defaults to `~/.switchroom/state/auth-broker/`. */
  stateDir?: string;
  /** Defaults to `homedir()` — base for `~/.switchroom/accounts/<label>/`. */
  home?: string;
  /**
   * Shell out to `docker inspect <container> -f <fmt>`. Returns the
   * trimmed stdout on success or null on any failure (missing docker,
   * missing container, transient EAGAIN). The default uses spawnSync;
   * tests inject a stub.
   */
  dockerInspect?: (container: string, format: string) => string | null;
  /**
   * Shell out to `docker exec <container> ls <path>`. Returns true if
   * the path exists inside the container, false otherwise. The default
   * uses spawnSync; tests inject a stub.
   */
  dockerExecExists?: (container: string, path: string) => boolean;
}

function defaultDockerInspect(container: string, format: string): string | null {
  try {
    const r = spawnSync(
      "docker",
      ["inspect", "-f", format, container],
      { encoding: "utf-8", timeout: 5_000 },
    );
    if (r.status !== 0) return null;
    return r.stdout.trim();
  } catch {
    return null;
  }
}

function defaultDockerExecExists(container: string, path: string): boolean {
  try {
    const r = spawnSync(
      "docker",
      ["exec", container, "test", "-S", path],
      { encoding: "utf-8", timeout: 5_000 },
    );
    return r.status === 0;
  } catch {
    return false;
  }
}

function resolveStateDir(deps: AuthBrokerProbeDeps): string {
  return deps.stateDir ?? resolveStatePath("state/auth-broker");
}

function sha256Hex(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/* ── Check 1: service health ─────────────────────────────────────────── */

export function checkAuthBrokerServiceHealth(
  deps: AuthBrokerProbeDeps = {},
): CheckResult {
  const inspect = deps.dockerInspect ?? defaultDockerInspect;
  const status = inspect(
    AUTH_BROKER_CONTAINER,
    "{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}",
  );
  if (status === null) {
    return {
      name: "auth-broker: service health",
      status: "fail",
      detail: `container \`${AUTH_BROKER_CONTAINER}\` not found via \`docker inspect\``,
      fix: "Run `switchroom apply` to bring the broker online, then `switchroom doctor` again.",
    };
  }
  const [state, health] = status.split("|");
  if (state !== "running") {
    return {
      name: "auth-broker: service health",
      status: "fail",
      detail: `container state: ${state ?? "<unknown>"}`,
      fix: "Check `docker logs switchroom-auth-broker`. Drift (sha-index mismatch) or a vault-passphrase failure is the usual cause.",
    };
  }
  if (health === "healthy") {
    return {
      name: "auth-broker: service health",
      status: "ok",
      detail: "running, healthcheck passing",
    };
  }
  if (health === "none") {
    return {
      name: "auth-broker: service health",
      status: "warn",
      detail: "running, no healthcheck configured",
      fix: "Compose generator should emit a bind-presence healthcheck. Re-run `switchroom apply` to regenerate compose.",
    };
  }
  return {
    name: "auth-broker: service health",
    status: "fail",
    detail: `running but healthcheck: ${health ?? "<unknown>"}`,
    fix: "Bind-presence probe failed — broker hasn't created any sockets yet. Check `docker logs switchroom-auth-broker` for startup errors.",
  };
}

/* ── Check 2: per-agent socket presence ──────────────────────────────── */

export function checkAuthBrokerPerAgentSockets(
  config: SwitchroomConfig,
  deps: AuthBrokerProbeDeps = {},
): CheckResult {
  const agents = Object.keys(config.agents ?? {}).sort();
  if (agents.length === 0) {
    return {
      name: "auth-broker: per-agent sockets",
      status: "ok",
      detail: "no agents configured",
    };
  }
  const execExists = deps.dockerExecExists ?? defaultDockerExecExists;
  const missing: string[] = [];
  for (const agent of agents) {
    const socketPath = `/run/switchroom/auth-broker/${agent}/sock`;
    if (!execExists(AUTH_BROKER_CONTAINER, socketPath)) {
      missing.push(agent);
    }
  }
  if (missing.length === 0) {
    return {
      name: "auth-broker: per-agent sockets",
      status: "ok",
      detail: `${agents.length} agent socket(s) bound`,
    };
  }
  return {
    name: "auth-broker: per-agent sockets",
    status: "fail",
    detail: `missing socket(s) for: ${missing.join(", ")}`,
    fix: "Re-run `switchroom apply` (regenerates compose + recreates the broker) and confirm with `docker logs switchroom-auth-broker`.",
  };
}

/* ── Check 3: drift signal (sha-index vs on-disk credentials) ────────── */

export interface ShaIndex {
  [label: string]: string;
}

export function checkAuthBrokerDrift(
  deps: AuthBrokerProbeDeps = {},
): CheckResult {
  const stateDir = resolveStateDir(deps);
  const indexPath = join(stateDir, "sha-index.json");
  if (!existsSync(indexPath)) {
    return {
      name: "auth-broker: drift",
      status: "ok",
      detail: "no sha-index yet (broker hasn't seen an add-account)",
    };
  }
  let index: ShaIndex;
  try {
    index = JSON.parse(readFileSync(indexPath, "utf-8")) as ShaIndex;
  } catch (err) {
    return {
      name: "auth-broker: drift",
      status: "fail",
      detail: `sha-index.json unreadable: ${(err as Error).message}`,
      fix: "Inspect `~/.switchroom/state/auth-broker/sha-index.json` for corruption.",
    };
  }
  const home = deps.home ?? homedir();
  const divergent: string[] = [];
  const missingOnDisk: string[] = [];
  for (const [label, expected] of Object.entries(index)) {
    const credsPath = accountCredentialsPath(label, home);
    if (!existsSync(credsPath)) {
      missingOnDisk.push(label);
      continue;
    }
    let got: string;
    try {
      got = sha256Hex(readFileSync(credsPath, "utf-8"));
    } catch (err) {
      divergent.push(`${label} (read failed: ${(err as Error).message})`);
      continue;
    }
    if (got !== expected) {
      divergent.push(label);
    }
  }
  if (divergent.length === 0 && missingOnDisk.length === 0) {
    const n = Object.keys(index).length;
    return {
      name: "auth-broker: drift",
      status: "ok",
      detail: `${n} indexed account(s) match on-disk credentials`,
    };
  }
  const parts: string[] = [];
  if (divergent.length > 0) parts.push(`sha mismatch: ${divergent.join(", ")}`);
  if (missingOnDisk.length > 0) parts.push(`index entry but no credentials.json: ${missingOnDisk.join(", ")}`);
  return {
    name: "auth-broker: drift",
    status: "fail",
    detail: parts.join("; "),
    fix: "An operator edited credentials.json out from under the broker. Recover with `switchroom auth add <label> --replace` for each divergent label, then restart the broker.",
  };
}

/* ── Check 4: threshold-violations ───────────────────────────────────── */

export interface ThresholdViolations {
  [label: string]: number;
}

export function checkAuthBrokerThresholdViolations(
  deps: AuthBrokerProbeDeps = {},
): CheckResult {
  const stateDir = resolveStateDir(deps);
  const path = join(stateDir, "threshold-violations.json");
  if (!existsSync(path)) {
    return {
      name: "auth-broker: threshold violations",
      status: "ok",
      detail: "no violations recorded",
    };
  }
  let violations: ThresholdViolations;
  try {
    violations = JSON.parse(readFileSync(path, "utf-8")) as ThresholdViolations;
  } catch (err) {
    return {
      name: "auth-broker: threshold violations",
      status: "warn",
      detail: `threshold-violations.json unreadable: ${(err as Error).message}`,
      fix: "Inspect `~/.switchroom/state/auth-broker/threshold-violations.json` for corruption.",
    };
  }
  const offenders = Object.entries(violations)
    .filter(([, n]) => typeof n === "number" && n > 0)
    .map(([label, n]) => `${label}=${n}`);
  if (offenders.length === 0) {
    return {
      name: "auth-broker: threshold violations",
      status: "ok",
      detail: `${Object.keys(violations).length} account(s) tracked, zero violations`,
    };
  }
  return {
    name: "auth-broker: threshold violations",
    status: "warn",
    detail: `claude is refreshing under the broker: ${offenders.join(", ")}`,
    fix: "Bump `REFRESH_THRESHOLD_MS` (broker env) so the broker refreshes before claude does, or investigate why per-agent credentials are being refreshed by the runtime.",
  };
}

/* ── Check 5: fleet active account configured ────────────────────────── */

export function checkAuthBrokerActiveAccount(
  config: SwitchroomConfig,
  deps: AuthBrokerProbeDeps = {},
): CheckResult {
  const active = config.auth?.active;
  if (!active || active.length === 0) {
    return {
      name: "auth-broker: fleet active account",
      status: "fail",
      detail: "`auth.active` not set in switchroom.yaml",
      fix: "Run `switchroom auth use <label>` to pin a fleet-wide account, then `switchroom apply`. Without an active account every agent boot fails.",
    };
  }
  const home = deps.home ?? homedir();
  const dir = accountDir(active, home);
  if (!existsSync(dir)) {
    return {
      name: "auth-broker: fleet active account",
      status: "fail",
      detail: `auth.active="${active}" but \`${dir}\` does not exist`,
      fix: `Run \`switchroom auth add ${active}\` to register the account, or correct \`auth.active\` to one of the existing labels under \`~/.switchroom/accounts/\`.`,
    };
  }
  const creds = accountCredentialsPath(active, home);
  if (!existsSync(creds)) {
    return {
      name: "auth-broker: fleet active account",
      status: "fail",
      detail: `auth.active="${active}" directory exists but credentials.json missing`,
      fix: `Run \`switchroom auth add ${active} --replace\` to re-seed credentials.`,
    };
  }
  return {
    name: "auth-broker: fleet active account",
    status: "ok",
    detail: `auth.active="${active}" present at ${dir}`,
  };
}

/* ── Aggregator ──────────────────────────────────────────────────────── */

/**
 * Run all five auth-broker checks and return them in render order:
 * fails first, then warns, then oks. Mirrors the precedent the existing
 * sections set by ordering severity-down within the section so the
 * operator's eye lands on blockers first.
 */
export function runAuthBrokerChecks(
  config: SwitchroomConfig,
  deps: AuthBrokerProbeDeps = {},
): CheckResult[] {
  const results: CheckResult[] = [
    checkAuthBrokerServiceHealth(deps),
    checkAuthBrokerPerAgentSockets(config, deps),
    checkAuthBrokerDrift(deps),
    checkAuthBrokerThresholdViolations(deps),
    checkAuthBrokerActiveAccount(config, deps),
  ];
  const rank: Record<CheckStatus, number> = { fail: 0, warn: 1, ok: 2 };
  return [...results].sort((a, b) => rank[a.status] - rank[b.status]);
}

/** Re-exported for inspection by tests that want to walk the state dir. */
export function authBrokerStateFiles(deps: AuthBrokerProbeDeps = {}): string[] {
  const stateDir = resolveStateDir(deps);
  if (!existsSync(stateDir)) return [];
  try {
    return readdirSync(stateDir).sort();
  } catch {
    return [];
  }
}
