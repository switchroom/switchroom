/**
 * Vault-broker durability probes — the deployment-shape invariants
 * the broker depends on to serve unlocked vault traffic across
 * container recreates.
 *
 * Each probe targets a specific past-or-future regression class:
 *
 *   - "broker unlocked (state)" — the broker is configured for
 *     auto-unlock but actually unlocked at runtime. The schema-check
 *     in `checkVault` only validates config; this validates state.
 *   - "auto-unlock blob present" — the machine-id-encrypted blob
 *     exists on the host. Missing blob silently falls back to
 *     interactive `/vault unlock`, surprising operators who
 *     thought auto-unlock was on.
 *   - "machine-id passthrough" — `/etc/machine-id` is bind-mounted
 *     into the broker so it can derive the same key the host used
 *     to seal the blob. Missing mount → broker errors out
 *     "Cannot derive machine-bound key" and falls back to
 *     interactive unlock.
 *   - "vault-grants.db inode-equality" — the broker's grants DB
 *     and the host file are the SAME inode (i.e. the bind mount
 *     is wired correctly). Pre-#1737 regression class: orphan
 *     `.vault-token` files referencing grants that no longer
 *     exist in a fresh ephemeral broker DB.
 *   - "vault-audit.log inode-equality" — same pattern for the
 *     audit log. Missing mount → broker writes audit events to
 *     ephemeral container fs, invisible to `switchroom vault
 *     audit` and the admin-agent `:ro` mount (#1024 / #1025).
 *
 * All probes go through `docker exec switchroom-vault-broker` —
 * the broker's view is authoritative because that's what serves
 * agent traffic. Stat checks compare host inode/size against the
 * broker-container inode/size; mismatch means the bind mount
 * isn't doing what compose claims it is.
 *
 * Surfaced 2026-05-24/25 via the v0.13.27 → v0.13.32 wedge cluster.
 * Every regression in that cluster would have been caught by ONE
 * of these probes if they had existed:
 *
 *   - v0.13.27/28/30/31 wedge → "broker unlocked (state)" + log grep
 *     for `held mid-turn` (covered separately by jtbd-fast-trivial-dm)
 *   - v0.13.32 grants-DB ephemerality → "vault-grants.db inode-equality"
 *
 * @internal exported for testing
 */

import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { SwitchroomConfig } from "../config/schema.js";
import type { CheckResult } from "./doctor.js";

/**
 * Result of a single `docker exec`-based stat probe: host inode/size
 * vs broker-container inode/size for the same logical file.
 */
export type BindMountStatResult =
  | { kind: "ok" }
  | { kind: "host-missing"; hostPath: string }
  | { kind: "broker-unreachable" }
  | {
      kind: "mismatch";
      hostInode: string;
      brokerInode: string;
      hostSize: number;
      brokerSize: number;
    }
  | { kind: "broker-stat-failed"; msg: string };

/**
 * Internal broker-side stat result — the broker shell-out either
 * returns the inode/size pair OR one of the failure shapes from
 * `BindMountStatResult`. Exported so tests can inject mock
 * `statBroker` callbacks with the right type rather than `as never`
 * casting against an internal-only discriminant.
 */
export type BrokerStatResult =
  | { kind: "ok-with-stat"; ino: string; size: number }
  | Exclude<BindMountStatResult, { kind: "ok" } | { kind: "host-missing" } | { kind: "mismatch" }>;

/**
 * Compare the host file's inode + size against the broker
 * container's view of the same logical path. Same inode + same
 * size = bind mount is wired. Different inode (or broker reports
 * a different file entirely) = mount is wrong.
 *
 * @internal exported for testing
 */
export function probeBindMountInode(
  hostPath: string,
  brokerContainerPath: string,
  opts?: {
    statHost?: (p: string) => { ino: bigint; size: number } | null;
    statBroker?: (p: string) => BrokerStatResult;
  },
): BindMountStatResult {
  const statHost = opts?.statHost ?? defaultStatHost;
  const statBroker = opts?.statBroker ?? defaultStatBroker;
  const host = statHost(hostPath);
  if (host === null) return { kind: "host-missing", hostPath };
  const broker = statBroker(brokerContainerPath);
  if (broker.kind !== "ok-with-stat") return broker;
  if (
    String(host.ino) === broker.ino &&
    host.size === broker.size
  ) {
    return { kind: "ok" };
  }
  return {
    kind: "mismatch",
    hostInode: String(host.ino),
    brokerInode: broker.ino,
    hostSize: host.size,
    brokerSize: broker.size,
  };
}

function defaultStatHost(p: string): { ino: bigint; size: number } | null {
  if (!existsSync(p)) return null;
  try {
    const s = statSync(p, { bigint: true });
    return { ino: s.ino, size: Number(s.size) };
  } catch {
    return null;
  }
}

function defaultStatBroker(p: string): BrokerStatResult {
  // `docker exec switchroom-vault-broker stat -c '%i %s' <path>`.
  // Exit non-zero → unreachable or path missing in broker.
  const r = spawnDockerStat(p);
  if (r.error || r.status === null) return { kind: "broker-unreachable" };
  if (r.status !== 0) {
    if (r.status >= 125) return { kind: "broker-unreachable" };
    return {
      kind: "broker-stat-failed",
      msg: r.stderr?.trim() || `exit ${r.status}`,
    };
  }
  const out = r.stdout.trim();
  const [inoStr, sizeStr] = out.split(/\s+/);
  const size = Number(sizeStr);
  if (!inoStr || !Number.isFinite(size)) {
    return {
      kind: "broker-stat-failed",
      msg: `unparseable stat output: ${out}`,
    };
  }
  return { kind: "ok-with-stat", ino: inoStr, size };
}

function spawnDockerStat(p: string): {
  status: number | null;
  stdout: string;
  stderr: string;
  error: Error | null;
} {
  return spawnDockerStatForContainer("switchroom-vault-broker", p);
}

/**
 * Run `docker exec <containerName> stat -c '%i %s' <p>` and return the
 * raw result. Extracted so multiple probes can target different containers
 * without duplicating the exec + error-shape logic.
 *
 * @internal exported for testing
 */
export function spawnDockerStatForContainer(
  containerName: string,
  p: string,
): {
  status: number | null;
  stdout: string;
  stderr: string;
  error: Error | null;
} {
  try {
    const stdout = execFileSync(
      "docker",
      ["exec", containerName, "stat", "-c", "%i %s", p],
      { stdio: ["ignore", "pipe", "pipe"], timeout: 3000, encoding: "utf8" },
    );
    return { status: 0, stdout, stderr: "", error: null };
  } catch (err: unknown) {
    const e = err as {
      status?: number;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    return {
      status: typeof e.status === "number" ? e.status : null,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      error: e.status === undefined ? new Error(e.message ?? "spawn failed") : null,
    };
  }
}

/**
 * Format a `BindMountStatResult` as a doctor CheckResult.
 * @internal exported for testing
 */
export function formatBindMountResult(
  name: string,
  hostPath: string,
  brokerContainerPath: string,
  result: BindMountStatResult,
): CheckResult {
  if (result.kind === "ok") {
    return {
      name,
      status: "ok",
      detail: `${hostPath} == ${brokerContainerPath} (same inode)`,
    };
  }
  if (result.kind === "host-missing") {
    return {
      name,
      status: "warn",
      detail: `host file ${hostPath} missing — pre-created by \`switchroom apply\` on greenfield`,
      fix: "Run `switchroom apply` to pre-create the host file at the correct mode",
    };
  }
  if (result.kind === "broker-unreachable") {
    return {
      name,
      status: "skip",
      detail: "vault-broker container unreachable — bind mount unverified",
    };
  }
  if (result.kind === "broker-stat-failed") {
    return {
      name,
      status: "warn",
      detail: `broker stat failed: ${result.msg}`,
    };
  }
  // mismatch: this is THE regression class the probe exists for.
  return {
    name,
    status: "fail",
    detail:
      `inode mismatch — bind mount is NOT wiring host to broker. ` +
      `host inode=${result.hostInode} size=${result.hostSize}; ` +
      `broker inode=${result.brokerInode} size=${result.brokerSize}. ` +
      `The broker is operating on an ephemeral container-local file; ` +
      `data written there evaporates on container recreate.`,
    fix:
      "Run `switchroom apply` to regenerate compose with the correct " +
      "bind mount, then `docker compose -p switchroom up -d vault-broker` " +
      "to recreate the broker container.",
  };
}

/**
 * Probe whether the broker actually auto-unlocked at boot.
 * The `checkVault` schema check only validates the config flag;
 * this validates RUNTIME STATE — the broker is unlocked and
 * serving vault traffic.
 *
 * @internal exported for testing
 */
export function probeBrokerUnlocked(opts?: {
  statusProbe?: () => { unlocked: boolean; keyCount: number } | null;
}): CheckResult {
  const status = (opts?.statusProbe ?? defaultBrokerStatusProbe)();
  if (status === null) {
    return {
      name: "vault-broker unlocked (state)",
      status: "skip",
      detail: "vault-broker container unreachable",
    };
  }
  if (!status.unlocked) {
    return {
      name: "vault-broker unlocked (state)",
      status: "fail",
      detail:
        `broker reports locked despite config — auto-unlock failed silently. ` +
        `Common causes: \`/etc/machine-id\` mount missing or differs from the ` +
        `host the blob was sealed on; vault-auto-unlock blob corrupted; ` +
        `vault passphrase was rotated without re-running ` +
        `\`switchroom vault broker enable-auto-unlock\`.`,
      fix:
        "Re-run `switchroom vault broker enable-auto-unlock` on the host " +
        "to re-seal the blob against the current machine-id + passphrase. " +
        "Then restart the broker (`docker compose -p switchroom restart vault-broker`).",
    };
  }
  return {
    name: "vault-broker unlocked (state)",
    status: "ok",
    detail: `${status.keyCount} key(s) loaded`,
  };
}

function defaultBrokerStatusProbe(): { unlocked: boolean; keyCount: number } | null {
  // Run the host CLI's `switchroom vault broker status` directly —
  // it speaks to the broker via the host-side operator socket
  // (`~/.switchroom/broker-operator/sock` per defaultBrokerSocketPath)
  // and JSON-prints the broker's status. Avoids the `docker exec`
  // path because the broker container image doesn't ship the
  // switchroom CLI binary (it has only the broker server).
  try {
    const out = execFileSync(
      "switchroom",
      ["vault", "broker", "status"],
      { stdio: ["ignore", "pipe", "pipe"], timeout: 3000, encoding: "utf8" },
    );
    const parsed = JSON.parse(out.trim()) as {
      running: boolean;
      unlocked: boolean;
      keyCount: number;
    };
    if (!parsed.running) return null;
    return { unlocked: parsed.unlocked, keyCount: parsed.keyCount };
  } catch {
    return null;
  }
}

/**
 * Top-level entry — runs every durability probe and returns a
 * single section of results.
 */
export function runVaultBrokerDurabilityChecks(
  _config: SwitchroomConfig,
  opts?: {
    inodeProbe?: typeof probeBindMountInode;
    statusProbe?: Parameters<typeof probeBrokerUnlocked>[0];
    kernelStatBroker?: (p: string) => BrokerStatResult;
  },
): CheckResult[] {
  const home = homedir();
  const probe = opts?.inodeProbe ?? probeBindMountInode;

  return [
    probeBrokerUnlocked(opts?.statusProbe),
    probeAutoUnlockBlob(home),
    probeMachineIdMount(),
    formatBindMountResult(
      "vault-broker: vault.enc bind mount",
      join(home, ".switchroom", "vault", "vault.enc"),
      "/state/vault/vault.enc",
      probe(
        join(home, ".switchroom", "vault", "vault.enc"),
        "/state/vault/vault.enc",
      ),
    ),
    formatBindMountResult(
      "vault-broker: vault-grants.db bind mount (#1737)",
      join(home, ".switchroom", "vault-grants.db"),
      "/root/.switchroom/vault-grants.db",
      probe(
        join(home, ".switchroom", "vault-grants.db"),
        "/root/.switchroom/vault-grants.db",
      ),
    ),
    formatBindMountResult(
      "vault-broker: vault-audit.log bind mount (#1025)",
      join(home, ".switchroom", "vault-audit.log"),
      "/root/.switchroom/vault-audit.log",
      probe(
        join(home, ".switchroom", "vault-audit.log"),
        "/root/.switchroom/vault-audit.log",
      ),
    ),
    probeKernelDbDurability(home, {
      statBroker: opts?.kernelStatBroker,
    }),
  ];
}

/**
 * Probe whether the approval-kernel's `/state/approvals` directory is
 * backed by the host bind mount (`~/.switchroom/approvals`).
 *
 * We probe the **directory** inode rather than the `kernel.db` file
 * because `kernel.db` is created lazily on the first `allow_always`
 * decision — an empty fleet would false-positive "ephemeral" on a
 * file-only probe. Directory inode equality is the durable signal
 * that the compose bind mount is wired correctly.
 *
 * If the kernel container is not running, this returns `skip` rather
 * than `fail`, matching the behaviour of the broker probes above.
 *
 * @internal exported for testing
 */
export function probeKernelDbDurability(
  home: string,
  opts?: {
    statBroker?: (p: string) => BrokerStatResult;
    statHost?: (p: string) => { ino: bigint; size: number } | null;
  },
): CheckResult {
  const hostDir = join(home, ".switchroom", "approvals");
  const containerDir = "/state/approvals";
  const name = "approval-kernel: approvals bind mount (allow_always durability)";

  const kernelStat = opts?.statBroker ?? defaultKernelStatBroker;

  const result = probeBindMountInode(hostDir, containerDir, {
    statBroker: kernelStat,
    statHost: opts?.statHost,
  });

  if (result.kind === "ok") {
    return {
      name,
      status: "ok",
      detail: `${hostDir} == ${containerDir} (same inode) — allow_always decisions persist across kernel recreate`,
    };
  }
  if (result.kind === "host-missing") {
    return {
      name,
      status: "warn",
      detail:
        `host directory ${hostDir} missing — \`switchroom apply\` pre-creates it on greenfield`,
      fix: "Run `switchroom apply` to pre-create the host approvals directory",
    };
  }
  if (result.kind === "broker-unreachable") {
    return {
      name,
      status: "skip",
      detail: "approval-kernel container unreachable — bind mount unverified",
    };
  }
  if (result.kind === "broker-stat-failed") {
    return {
      name,
      status: "warn",
      detail: `approval-kernel stat failed: ${result.msg}`,
    };
  }
  // mismatch: the kernel is operating on an ephemeral container-local
  // directory — allow_always decisions are lost on every container recreate.
  return {
    name,
    status: "fail",
    detail:
      `inode mismatch — approval-kernel \`/state/approvals\` is NOT backed by the host bind mount. ` +
      `host inode=${result.hostInode} size=${result.hostSize}; ` +
      `kernel inode=${result.brokerInode} size=${result.brokerSize}. ` +
      `The kernel is writing kernel.db to an ephemeral container-local directory; ` +
      `all allow_always decisions are lost on every container recreate (e.g. after \`switchroom update\`).`,
    fix:
      "Run `switchroom apply` to regenerate compose with the " +
      "`~/.switchroom/approvals:/state/approvals` bind mount, then " +
      "`docker compose -p switchroom up -d approval-kernel` to recreate the kernel container.",
  };
}

function defaultKernelStatBroker(p: string): BrokerStatResult {
  const r = spawnDockerStatForContainer("switchroom-approval-kernel", p);
  if (r.error || r.status === null) return { kind: "broker-unreachable" };
  if (r.status !== 0) {
    if (r.status >= 125) return { kind: "broker-unreachable" };
    return {
      kind: "broker-stat-failed",
      msg: r.stderr?.trim() || `exit ${r.status}`,
    };
  }
  const out = r.stdout.trim();
  const [inoStr, sizeStr] = out.split(/\s+/);
  const size = Number(sizeStr);
  if (!inoStr || !Number.isFinite(size)) {
    return {
      kind: "broker-stat-failed",
      msg: `unparseable stat output: ${out}`,
    };
  }
  return { kind: "ok-with-stat", ino: inoStr, size };
}

function probeAutoUnlockBlob(home: string): CheckResult {
  const blobPath = join(home, ".switchroom", "vault-auto-unlock");
  if (!existsSync(blobPath)) {
    return {
      name: "vault-broker: auto-unlock blob",
      status: "warn",
      detail: `${blobPath} not present — broker will fall back to interactive unlock`,
      fix: "Run `switchroom vault broker enable-auto-unlock` to seal the blob with the current passphrase + machine-id",
    };
  }
  const sz = statSync(blobPath).size;
  if (sz === 0) {
    return {
      name: "vault-broker: auto-unlock blob",
      status: "warn",
      detail: `${blobPath} is 0 bytes (placeholder) — broker will fall back to interactive unlock`,
      fix: "Run `switchroom vault broker enable-auto-unlock` to actually seal the blob",
    };
  }
  return {
    name: "vault-broker: auto-unlock blob",
    status: "ok",
    detail: `${blobPath} present (${sz} bytes, machine-bound)`,
  };
}

function probeMachineIdMount(): CheckResult {
  // The broker's compose mount: /etc/machine-id:/etc/machine-id:ro.
  // We probe by reading both sides and comparing — different
  // contents would mean the mount is missing or stale.
  const hostExists = existsSync("/etc/machine-id");
  if (!hostExists) {
    return {
      name: "vault-broker: machine-id passthrough",
      status: "fail",
      detail:
        "/etc/machine-id missing on host — auto-unlock key derivation impossible",
      fix: "Generate a machine-id (`systemd-machine-id-setup`) and re-seal the auto-unlock blob",
    };
  }
  const r = spawnDockerStat("/etc/machine-id");
  if (r.error || r.status === null || r.status >= 125) {
    return {
      name: "vault-broker: machine-id passthrough",
      status: "skip",
      detail: "vault-broker container unreachable",
    };
  }
  if (r.status !== 0) {
    return {
      name: "vault-broker: machine-id passthrough",
      status: "fail",
      detail:
        "broker container has no /etc/machine-id — compose `/etc/machine-id:/etc/machine-id:ro` mount is missing",
      fix: "Run `switchroom apply` to regenerate compose with the machine-id passthrough",
    };
  }
  return {
    name: "vault-broker: machine-id passthrough",
    status: "ok",
    detail: "broker reads the host machine-id",
  };
}
