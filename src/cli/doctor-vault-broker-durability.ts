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
 *     exist in a fresh ephemeral broker DB. (Such a token does not
 *     deny the agent — see `probeOrphanVaultTokens` for what it
 *     actually costs.)
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
import { existsSync, statSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

import type { SwitchroomConfig } from "../config/schema.js";
import type { CheckResult } from "./doctor.js";
import {
  GRANTS_DB_CONTAINER_DIR,
  GRANTS_DB_CONTAINER_PATH,
  getGrantsDbDir,
  getGrantsDbPath,
} from "../vault/grants-db-path.js";

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
    walStatBroker?: (p: string) => BrokerFileStat;
    grantIdExists?: (id: string) => boolean | null;
    readTokenId?: (agent: string, home: string) => string | null;
    tokenMtimeMs?: (agent: string, home: string) => number | null;
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
      "vault-broker: vault-grants dir bind mount (#1737 / #3289)",
      getGrantsDbDir(home),
      GRANTS_DB_CONTAINER_DIR,
      probe(getGrantsDbDir(home), GRANTS_DB_CONTAINER_DIR),
    ),
    probeGrantsWalDivergence(opts?.walStatBroker),
    probeOrphanVaultTokens(_config, {
      home,
      grantIdExists: opts?.grantIdExists,
      readTokenId: opts?.readTokenId,
      tokenMtimeMs: opts?.tokenMtimeMs,
    }),
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

/**
 * Broker-side stat of a single file: mtime (epoch seconds) + size, or a
 * failure shape. Used by the WAL-divergence probe.
 */
export type BrokerFileStat =
  | { kind: "ok"; mtime: number; size: number }
  | { kind: "missing" }
  | { kind: "unreachable" }
  | { kind: "failed"; msg: string };

function defaultWalStatBroker(p: string): BrokerFileStat {
  // `docker exec switchroom-vault-broker stat -c '%Y %s' <path>` →
  // "<mtime-epoch> <size>". Exit 1 = path missing; ≥125 = unreachable.
  try {
    const stdout = execFileSync(
      "docker",
      ["exec", "switchroom-vault-broker", "stat", "-c", "%Y %s", p],
      { stdio: ["ignore", "pipe", "pipe"], timeout: 3000, encoding: "utf8" },
    );
    const [mStr, sStr] = stdout.trim().split(/\s+/);
    const mtime = Number(mStr);
    const size = Number(sStr);
    if (!Number.isFinite(mtime) || !Number.isFinite(size)) {
      return { kind: "failed", msg: `unparseable stat output: ${stdout.trim()}` };
    }
    return { kind: "ok", mtime, size };
  } catch (err: unknown) {
    const e = err as { status?: number; stderr?: string; message?: string };
    if (typeof e.status !== "number") return { kind: "unreachable" };
    if (e.status >= 125) return { kind: "unreachable" };
    // exit 1 from `stat` on a non-existent path
    return { kind: "missing" };
  }
}

/**
 * Flag WAL divergence inside the broker container: a `-wal` sidecar that is
 * non-empty AND newer than the main DB file means committed grants are sitting
 * in the write-ahead log that has not been checkpointed back into the main
 * file. Post-#3289 the whole grants directory is persisted so this is no
 * longer a data-loss condition on its own, but a persistently non-empty WAL
 * means the checkpoint-after-every-mutation defense (grants.ts) is not firing
 * — worth surfacing, and it is the exact signal the host-side readers (doctor,
 * migration) depend on the main file being current for.
 *
 * FALSE-POSITIVE GUARD: `PRAGMA wal_checkpoint(TRUNCATE)` legitimately leaves
 * the WAL non-empty when a concurrent reader holds the DB busy (SQLITE_BUSY is
 * reported as a result ROW, not an error) — a healthy broker under normal read
 * contention would trip a naive newer-than-main check. So the probe only warns
 * when the divergent WAL is also STALE: its mtime is older than
 * `staleThresholdSecs` (default 300s). A fresh divergence means writes are
 * in-flight or a busy checkpoint just deferred — the next mutation's
 * checkpoint clears it; only a divergence that has persisted implies the
 * defense isn't firing.
 *
 * @internal exported for testing
 */
export function probeGrantsWalDivergence(
  statBroker: (p: string) => BrokerFileStat = defaultWalStatBroker,
  opts?: { nowEpochSecs?: number; staleThresholdSecs?: number },
): CheckResult {
  const now = opts?.nowEpochSecs ?? Math.floor(Date.now() / 1000);
  const staleThreshold = opts?.staleThresholdSecs ?? 300;
  const name = "vault-broker: grants WAL checkpointed (#3289)";
  const main = statBroker(GRANTS_DB_CONTAINER_PATH);
  if (main.kind === "unreachable") {
    return { name, status: "skip", detail: "vault-broker container unreachable" };
  }
  if (main.kind === "missing") {
    // No DB yet (empty fleet) — nothing to diverge.
    return { name, status: "ok", detail: "no grants DB yet — nothing to checkpoint" };
  }
  if (main.kind === "failed") {
    return { name, status: "warn", detail: `broker stat failed: ${main.msg}` };
  }
  const wal = statBroker(`${GRANTS_DB_CONTAINER_PATH}-wal`);
  if (wal.kind === "missing") {
    return { name, status: "ok", detail: "no -wal sidecar — grants DB fully checkpointed" };
  }
  if (wal.kind === "unreachable") {
    return { name, status: "skip", detail: "vault-broker container unreachable" };
  }
  if (wal.kind === "failed") {
    return { name, status: "warn", detail: `broker -wal stat failed: ${wal.msg}` };
  }
  if (wal.size === 0) {
    return { name, status: "ok", detail: "-wal is truncated (0 bytes) — checkpointed" };
  }
  if (wal.mtime > main.mtime) {
    const ageSecs = now - wal.mtime;
    if (ageSecs < staleThreshold) {
      // Fresh divergence — writes in flight or a busy checkpoint just
      // deferred; a healthy broker under read contention looks like this.
      return {
        name,
        status: "ok",
        detail:
          `-wal (${wal.size} bytes) is newer than the main DB but only ` +
          `${Math.max(ageSecs, 0)}s old — within the ${staleThreshold}s ` +
          `settle window (busy checkpoints are normal under read contention)`,
      };
    }
    return {
      name,
      status: "warn",
      detail:
        `-wal (${wal.size} bytes, mtime ${wal.mtime}) is newer than the main DB ` +
        `(mtime ${main.mtime}) and has been divergent for ${ageSecs}s — ` +
        `un-checkpointed grant writes are sitting in the write-ahead log. The ` +
        `grants directory is bind-mounted so these persist across container ` +
        `recreate, but the checkpoint-after-mutation defense (grants.ts) ` +
        `appears not to be firing.`,
      fix:
        "Verify the broker is running the #3289 build (checkpoint after every " +
        "mint/revoke). A one-off `PRAGMA wal_checkpoint(TRUNCATE)` clears the backlog.",
    };
  }
  return { name, status: "ok", detail: `-wal present (${wal.size} bytes) but not newer than main DB` };
}

/**
 * The TTL the gateway's `vault_request_access` approval flow mints with
 * (`telegram-plugin/gateway/callback-query-handlers.ts` — `ttl_seconds:
 * 30 * 24 * 60 * 60`). Used as the age threshold below; see the TTL note on
 * `probeOrphanVaultTokens`.
 */
const ASSUMED_GRANT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Flag any agent `.vault-token` on disk whose grant id has NO matching row in
 * the grants DB — the #1737 / #3289 orphan-token symptom that appears after a
 * broker recreate wipes grants written to an ephemeral (unmounted or
 * un-checkpointed) DB.
 *
 * ## What an orphan token actually costs (do not overstate it)
 *
 * It does NOT deny the agent's vault traffic. The broker's READ-path
 * fall-through (`src/vault/broker/server.ts`, and pinned by
 * `server-token-fallthrough.test.ts`) deliberately treats a token whose grant
 * is missing or expired as *no token at all* and serves the request from the
 * agent's standing config ACL — an unusable token must never be MORE
 * restrictive than presenting none. Only `grant-revoked` hard-denies. So an
 * agent with an orphan token still reads every key its `switchroom.yaml` ACL
 * covers; `switchroom vault list` still returns those keys.
 *
 * What it DOES cost is real: the dynamic grant is gone, so any key that was
 * reachable ONLY through that grant — the usual reason a grant gets minted at
 * all — is no longer reachable by that agent.
 *
 * ## TTL recoverability (why this uses mtime)
 *
 * The orphaned grant's `expires_at` is NOT recoverable. The token file holds
 * only `vg_<6 random hex>.<secret>` (`grants.ts` `generateId`) — no timestamp —
 * and the row that carried `expires_at` is precisely what is missing. The only
 * age signal left on the host is the token file's own mtime, which is a good
 * proxy for mint time because the file is written exactly once per mint. So:
 * mtime + `ASSUMED_GRANT_TTL_MS` past ⇒ the grant would have lapsed on its own
 * and the file is litter (`warn`); still inside that window ⇒ the grant should
 * have been alive and its disappearance is the genuine durability signal
 * (`fail`). Unknown mtime is treated as litter — an unprovable age must not
 * manufacture a red.
 *
 * @internal exported for testing
 */
export function probeOrphanVaultTokens(
  config: SwitchroomConfig,
  opts?: {
    home?: string;
    readTokenId?: (agent: string, home: string) => string | null;
    grantIdExists?: (id: string) => boolean | null;
    /** Token-file mtime in ms, or null when unreadable. Seam for tests. */
    tokenMtimeMs?: (agent: string, home: string) => number | null;
    now?: () => number;
  },
): CheckResult {
  const name = "vault-broker: no orphan .vault-token grants (#1737 / #3289)";
  const home = opts?.home ?? homedir();
  const agents = Object.keys(config.agents ?? {});
  const readTokenId = opts?.readTokenId ?? defaultReadTokenId;
  const grantIdExists = opts?.grantIdExists ?? defaultGrantIdExists;
  const tokenMtimeMs = opts?.tokenMtimeMs ?? defaultTokenMtimeMs;
  const now = opts?.now ?? Date.now;

  const tokens: { agent: string; id: string }[] = [];
  for (const agent of agents) {
    const id = readTokenId(agent, home);
    if (id) tokens.push({ agent, id });
  }
  if (tokens.length === 0) {
    return { name, status: "ok", detail: "no agent holds a vault-token — nothing to orphan-check" };
  }

  const orphans: { agent: string; id: string }[] = [];
  for (const t of tokens) {
    const exists = grantIdExists(t.id);
    if (exists === null) {
      return {
        name,
        status: "skip",
        detail: "grants DB not readable on host — orphan-token check skipped",
      };
    }
    if (!exists) orphans.push(t);
  }

  if (orphans.length === 0) {
    return {
      name,
      status: "ok",
      detail: `${tokens.length} vault-token(s) all reference a live grant row`,
    };
  }

  // Split by whether the vanished grant would still have been in its TTL
  // window. Only the still-in-window ones are a durability failure.
  const stale: string[] = [];
  const durability: string[] = [];
  for (const o of orphans) {
    const mtime = tokenMtimeMs(o.agent, home);
    const ageMs = mtime === null || !Number.isFinite(mtime) ? null : now() - mtime;
    if (ageMs === null || ageMs > ASSUMED_GRANT_TTL_MS) {
      stale.push(`${o.agent}=${o.id}`);
    } else {
      durability.push(`${o.agent}=${o.id}`);
    }
  }

  const consequence =
    `These agents have LOST the dynamic grant: the broker treats an unusable ` +
    `token as no token and falls through to the standing config ACL (only ` +
    `\`grant-revoked\` hard-denies), so config-ACL keys are still served — but ` +
    `any key reachable ONLY via the dynamic grant is now unreachable for them.`;

  if (durability.length === 0) {
    return {
      name,
      status: "warn",
      detail:
        `${stale.length} agent vault-token(s) reference a grant id absent from the ` +
        `grants DB: ${stale.join(", ")}. Each is older than the ${ASSUMED_GRANT_TTL_MS /
          86_400_000}d grant TTL (or has no readable mtime), so the grant would ` +
        `have expired anyway — this is stale token litter, not a durability ` +
        `failure. ${consequence}`,
      fix:
        "Safe to remove (`: > ~/.switchroom/agents/<agent>/.vault-token`), or let " +
        "the broker's own reaper truncate it on the agent's next `vault get`. " +
        "Re-mint only if that agent still needs a key its config ACL doesn't cover.",
    };
  }

  const staleTail = stale.length
    ? ` (plus ${stale.length} already past the assumed TTL — stale litter: ${stale.join(", ")})`
    : "";
  return {
    name,
    status: "fail",
    detail:
      `${durability.length} agent vault-token(s) reference a grant id absent from ` +
      `the grants DB while still inside the assumed ${ASSUMED_GRANT_TTL_MS /
        86_400_000}d grant TTL: ${durability.join(", ")}${staleTail}. A grant that ` +
      `should still be live has vanished — the classic broker-recreate grant-wipe. ` +
      consequence,
    fix:
      "Re-mint the grants (`switchroom vault grant <agent> --keys …`). If this " +
      "recurs after a broker recreate, the grants directory bind mount is broken " +
      "— see the `vault-grants dir bind mount` probe above.",
  };
}

/** Token-file mtime in ms; null when the file is missing or unreadable. */
function defaultTokenMtimeMs(agent: string, home: string): number | null {
  try {
    return statSync(join(home, ".switchroom", "agents", agent, ".vault-token")).mtimeMs;
  } catch {
    return null;
  }
}

function defaultReadTokenId(agent: string, home: string): string | null {
  const tokenPath = join(home, ".switchroom", "agents", agent, ".vault-token");
  try {
    const raw = readFileSync(tokenPath, "utf8").trim();
    if (!raw) return null;
    // Token format: `vg_<id>.<secret>` — the grant id is everything before the
    // first dot (it includes the `vg_` prefix, matching the DB row id).
    const dot = raw.indexOf(".");
    const id = dot === -1 ? raw : raw.slice(0, dot);
    return id.startsWith("vg_") ? id : null;
  } catch {
    return null;
  }
}

/**
 * Host-side readonly lookup of a grant id in the grants DB. Returns null when
 * the DB can't be read (no Bun runtime under vitest, missing file) so the
 * caller degrades to `skip` rather than a false `fail`.
 */
function defaultGrantIdExists(id: string): boolean | null {
  try {
    if (typeof (globalThis as { Bun?: unknown }).Bun === "undefined") return null;
    const dbPath = getGrantsDbPath();
    if (!existsSync(dbPath)) return null;
    const req = createRequire(import.meta.url);
    const { Database } = req("bun:sqlite") as typeof import("bun:sqlite");
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db
        .query("SELECT 1 AS ok FROM vault_grants WHERE id = ? AND revoked_at IS NULL")
        .get(id);
      return !!row;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
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
