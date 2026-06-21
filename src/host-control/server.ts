/**
 * switchroom-hostd server — listens on per-agent Unix-domain sockets,
 * dispatches a closed set of operator-only switchroom verbs to the
 * host CLI.
 *
 * Phase 1 scope (per RFC C, `reference/rfcs/host-control-daemon.md`):
 *   - `agent_restart`  (mutating; self → any caller, cross-agent →
 *                      admin)
 *   - `upgrade_status` (read-only; any)
 *   - `get_status`     (lookup of prior async mutations; gate matches
 *                      the original verb)
 *
 * Shipped in Phase 2 (#1208): `update_check`, `update_apply`,
 * `apply`, `agent_start`, `agent_stop`. See RFC C §10 for the full
 * verb table. `update_apply` and `apply` share a new fleet-mutation
 * lock (this file's `fleetMutationInFlight`). `reconcile` was
 * dropped from the original list — no underlying CLI verb exists;
 * `apply` covers the intent.
 *
 * Still deferred: gateway integration (replacing
 * `spawnSwitchroomDetached` callsites in telegram-plugin/gateway/
 * with hostd RPC). Separate PR.
 */

import { createServer, type Server, type Socket } from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, chmod, chown, unlink, appendFile } from "node:fs/promises";
import {
  readdirSync,
  existsSync,
  statSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  openSync,
  ftruncateSync,
  writeSync,
  fsyncSync,
  closeSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import {
  decodeRequest,
  encodeResponse,
  deniedResponse,
  IDEMPOTENCY_WINDOW_MS,
  MAX_FRAME_BYTES,
  type HostdRequest,
  type HostdResponse,
  type Result,
} from "./protocol.js";
import { err } from "./error-builder.js";
import { chainRow, seedChain, type ChainState } from "../util/audit-hashchain.js";
import { socketPathToIdentity, type SocketIdentity } from "./peercred.js";
import { redact } from "../secret-detect/redact.js";
import { detectInstallType, type InstallType } from "../cli/install-detect.js";
import { parseRolloutResultLine } from "../cli/rollout.js";
import { parseUpdateResultLine } from "../cli/update.js";
import { parseAuditLine } from "./audit-reader.js";
import {
  validateConfigEdit,
  assertSelfScopedAllowEdit,
} from "./config-edit-validator.js";
import { classifyBlastRadius } from "./config-blast-radius.js";
import type { ApprovalGateway } from "./approval-gateway.js";
import { loadConfig, resolveAgentsDir } from "../config/loader.js";
import { getAllAgentStatuses } from "../agents/lifecycle.js";
import {
  collectScheduleEntries,
  type SchedulerEntry,
  type DispatchResult,
} from "../scheduler/dispatch.js";
import { readRecentFires } from "../agent-scheduler/replay.js";

/** Subset of switchroom.yaml the daemon reads. */
export interface ServerConfig {
  /** Per-agent admin flag — drives the verb gate. Daemon reads this
   *  once at startup (Phase 1) and reloads on SIGHUP (post-Phase-1
   *  follow-up). */
  agents: Record<string, { admin?: boolean }>;
  /** hostd verb-level knobs (RFC admin-agent-config-edit §3 / §4).
   *  Optional in the wire type so existing call-sites that synthesize
   *  a minimal config (test fixtures, legacy callers) keep compiling;
   *  the dispatcher treats "missing block" as "flag off". */
  hostd?: {
    config_edit_enabled?: boolean;
    config_edit_rate_per_hour?: number;
  };
}

export interface ServerOptions {
  /** Operator HOME — daemon binds sockets under `<homeDir>/.switchroom/hostd/<agent>/sock`. */
  homeDir: string;
  /** Map of agent name → UID for chown. The daemon needs CHOWN/FOWNER
   *  caps (or to run as the operator owning the agent UIDs) to set
   *  ownership; mirrors the broker's pattern at
   *  `src/agents/compose.ts:549-552`. */
  agentUids: Record<string, number>;
  /** Config — admin gating. */
  config: ServerConfig;
  /** Absolute path to the host `switchroom` binary. Default: lookup on
   *  PATH at request time. */
  switchroomBin?: string;
  /** Absolute path to the host `docker` binary. Default: lookup on
   *  PATH at request time. Used by Phase 3 admin observability verbs
   *  (agent_logs / agent_exec) that shell out to docker directly. */
  dockerBin?: string;
  /** Audit-log path. Default: `<homeDir>/.switchroom/host-control-audit.log`. */
  auditLogPath?: string;
  /** Allow non-Linux dev mode (skips chown). */
  allowNonLinux?: boolean;
  /**
   * Root the apply-asset preflight resolves package-relative apply
   * assets against (`<root>/profiles`, `<root>/vendor/hindsight-
   * memory`). Default: two dirs up from this module — for the bundled
   * daemon (`/opt/switchroom/dist/host-control/main.js`) that is
   * `/opt/switchroom`, exactly where Dockerfile.hostd bakes them and
   * the same root the CLI bundle resolves to. Test seam only.
   */
  applyAssetsRoot?: string;
  /**
   * Filesystem root the daemon uses to read host-side artifacts (e.g.
   * the install-type cache at `<bindRoot>/.switchroom/install-type.json`).
   * For the dockerised daemon, set this to the bind-mount path of the
   * operator's HOME inside the container (typically `/host-home`); for
   * the host-direct daemon, leave unset and the daemon falls back to
   * `homeDir`.
   */
  bindRoot?: string;
  /**
   * Test seam: override the image refs the digest resolver is called
   * with. When unset the daemon shells out to `docker compose config`
   * to enumerate refs from the operator's compose file.
   */
  imageRefsForDigests?: () => string[];
  /**
   * Path to the live `switchroom.yaml` the config-edit validator (PR 1b)
   * reads when checking that a proposed unified diff applies cleanly
   * and the post-apply YAML survives schema + secret-leak validation.
   *
   * Defaults to `/state/config/switchroom.yaml` — the canonical path
   * the wire schema (`ConfigProposeEditRequestSchema.args.target_path`)
   * pins. Tests override this to point at a scratch file under `tmp/`
   * so the validation pipeline can be exercised end-to-end without
   * touching real fleet config.
   */
  configPath?: string;
  /** RFC §3.3 / #1623 — operator-approval surface; unset → `E_NO_APPROVAL_GATEWAY`. */
  approvalGateway?: ApprovalGateway;
  /** Test seam: override the random hex id generator. */
  generateApprovalId?: () => string;
  /** Test seam: override the `switchroom apply` subprocess invocation. */
  runReconcile?: (args: {
    requestId: string;
  }) => Promise<{ exit_code: number; stdout: string; stderr: string }>;
}

/**
 * Per-request status snapshot retained for `get_status` lookups.
 * Capped at the most recent N requests per daemon process; entries
 * older than the cap age get evicted lazily.
 */
interface StatusEntry {
  request_id: string;
  caller: SocketIdentity;
  op: string;
  result: Result;
  exit_code: number | null;
  /** ms since epoch */
  started_at: number;
  finished_at: number | null;
  stdout_tail: string;
  stderr_tail: string;
  error?: string;
  // ─── Update-flow enrichment (PR B) ─────────────────────────────────
  // Populated only on `update_apply` rows so the terminal audit row
  // carries enough information for the gateway / `get_status` reader
  // to surface what was rolled out without re-querying docker.
  channel?: string;
  pin?: string;
  /** Map of image-ref → "sha256:<hex>" digest, captured at the moment
   *  `docker compose pull` finished (best effort). */
  resolved_sha?: Record<string, string>;
  install_context?: {
    install_type: InstallType;
    detected_at: string;
  };
  // ─── Rollout-flow structured result (#2487) ────────────────────────
  // Populated only on `rollout` rows. The staggered rollout's outcome is
  // preserved as STRUCTURED fields (not flattened into a stdout tail) so
  // a `get_status` reader / the gateway can show exactly which agents
  // rolled and where it stopped. Parsed from the spawned child's
  // sentinel line (see parseRolloutResultLine in cli/rollout.ts).
  /** Agents confirmed on the target version, in order. */
  rolled?: string[];
  /** Step that stopped the rollout (e.g. "restart-agent", "apply"). */
  failed_step?: string;
  /** Agent that failed the version assert (when failed_step is restart). */
  failed_agent?: string;
  /** Actual version detected on failed_agent (null = unreachable). BONUS #2458 got-field gap. */
  got?: string | null;
  // ─── Update-apply deferral result (#2458) ──────────────────────────
  // Steps that were deferred because the update ran in hostd-context
  // (SWITCHROOM_HOSTD_CONTEXT=1). Populated by parsing the
  // SWITCHROOM_UPDATE_RESULT sentinel from the child's stdout. Absent
  // when no steps were deferred (non-hostd-context run or older driver).
  deferred?: string[];
}

/**
 * Resolve docker image references to their RepoDigests via
 * `docker inspect --format='{{index .RepoDigests 0}}' <ref>`.
 *
 * Pure side-effect-free (only spawns `docker inspect`, no mutations).
 * Fail-soft: any image whose digest can't be read (image not present,
 * `docker` not on PATH, parse failure) is omitted from the returned
 * map rather than throwing. The audit row captures whatever digests
 * we COULD resolve and the caller can decide whether the partial set
 * is useful — typically yes, because even one resolved digest pins
 * the rollout's identity.
 *
 * Exported for unit-test access (mock `child_process.spawnSync`).
 */
export function resolveDigests(imageRefs: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const ref of imageRefs) {
    try {
      const r = spawnSync(
        "docker",
        ["inspect", "--format={{index .RepoDigests 0}}", ref],
        { encoding: "utf-8", timeout: 5000 },
      );
      if (r.status !== 0) continue;
      const trimmed = (r.stdout ?? "").trim();
      // Parse "repo@sha256:<hex>" → keep the "sha256:<hex>" half.
      const at = trimmed.lastIndexOf("@");
      if (at < 0) continue;
      const digest = trimmed.slice(at + 1);
      if (!/^sha256:[0-9a-f]{32,}$/.test(digest)) continue;
      out.set(ref, digest);
    } catch {
      // Spawn failure (docker not installed, EACCES). Skip silently —
      // see the fail-soft contract above.
      continue;
    }
  }
  return out;
}

/**
 * Read the host-side install-type cache written by `switchroom apply`
 * (see `writeInstallTypeCache` in `src/cli/apply.ts`). Reads from
 * `<bindRoot>/.switchroom/install-type.json` — for the daemon running
 * inside docker, `bindRoot` is `/host-home`; for the daemon running on
 * the host directly, it's the operator's home.
 *
 * Lazy detection: if the cache file is missing, run `detectInstallType()`
 * directly and write the result back atomically (`.tmp` + rename, mode
 * 0o644) so subsequent calls hit the cache. Mirrors the apply-side
 * writer so the two paths stay structurally identical.
 *
 * Defensive: a corrupt cache file (malformed JSON, missing fields)
 * collapses to `{install_type: "unknown"}` rather than throwing — the
 * audit row prefers a degraded value to a missing one. No mtime /
 * staleness check; `apply` is the canonical invalidator.
 *
 * Exported for unit-test access.
 */
export function readCachedInstallType(bindRoot: string): {
  install_type: InstallType;
  detected_at: string;
  source_paths?: { bin?: string; repo?: string };
} {
  const cacheDir = join(bindRoot, ".switchroom");
  const cachePath = join(cacheDir, "install-type.json");
  if (existsSync(cachePath)) {
    try {
      const raw = readFileSync(cachePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (
        parsed &&
        typeof parsed.install_type === "string" &&
        typeof parsed.detected_at === "string"
      ) {
        return parsed;
      }
      return { install_type: "unknown", detected_at: new Date().toISOString() };
    } catch {
      return { install_type: "unknown", detected_at: new Date().toISOString() };
    }
  }
  // Lazy detect + write back.
  const ctx = detectInstallType();
  const payload = {
    install_type: ctx.install_type,
    detected_at: new Date().toISOString(),
    source_paths: ctx.source_paths,
  };
  try {
    mkdirSync(cacheDir, { recursive: true });
    const tmp = `${cachePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o644 });
    renameSync(tmp, cachePath);
  } catch {
    // Read-only filesystem (e.g. docker bind-mounted :ro) — return the
    // detected value without caching. Best-effort by contract.
  }
  return payload;
}

/** RFC §3.3 — operator approval card lifespan. */
const CONFIG_APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

/** 8-hex random id for an in-flight config_propose_edit approval. */
function defaultApprovalId(): string {
  return randomBytes(4).toString("hex");
}

/**
 * Map a deny `ApprovalResult` to the appropriate error string for
 * the config_propose_edit response. (#1762)
 *
 *   - `denySource === "dispatch_failure"` → `E_APPROVAL_DISPATCH_FAILED`
 *     (Telegram card never reached the operator — opaque
 *     "operator denied" would be a lie)
 *   - operator tap deny → `E_DENIED` with the reason (when present)
 *     appended for diagnostic value
 *
 * Exported only for unit testing — the production caller is
 * `handleConfigProposeEdit` in this file.
 */
export function formatConfigApprovalDenyError(
  approval: {
    reason?: string;
    denySource?: "operator" | "dispatch_failure";
  },
  approvalId: string,
): string {
  if (approval.denySource === "dispatch_failure") {
    const detail = approval.reason ?? "card dispatch failed";
    return `E_APPROVAL_DISPATCH_FAILED: ${detail} (approval_id=${approvalId})`;
  }
  const suffix = approval.reason ? `: ${approval.reason}` : "";
  return `E_DENIED: operator denied config_propose_edit${suffix} (approval_id=${approvalId})`;
}

/**
 * Write `content` to an existing file **in place**, preserving its inode.
 *
 * The obvious atomic-write strategy — write a sibling `<path>.tmp` then
 * `rename()` it over the target — is structurally broken for
 * switchroom.yaml. That file is itself an individual read-only bind-mount
 * source: it is bind-mounted into every agent container. `rename()` over a
 * path that is an active bind-mount source returns `EBUSY` ("resource busy
 * or locked"), so the swap never lands. (Confirmed via /proc/mounts:
 * `/dev/nvme0n1p2 /state/config/switchroom.yaml ext4 ro,relatime`.)
 *
 * Instead we open the existing file `O_RDWR` (no create, no rename),
 * truncate it, write the new bytes, and `fsync()`. The inode is preserved,
 * so every bind mount stays valid and the kernel never sees a rename over a
 * busy dentry. `O_RDWR` (mode `"r+"`) also preserves the file's existing
 * mode and owner — we never re-create it.
 *
 * Tradeoff — non-atomic: a crash between truncate and the final write could
 * leave a partial file. Callers mitigate by (a) snapshotting the prior
 * content for rollback, (b) `fsync` here, and (c) re-validating immediately
 * after (the reconcile run rejects a malformed config and triggers
 * rollback). A short post-write read-back length check below catches a
 * truncated write before reconcile even starts.
 *
 * @throws the underlying fs error (e.g. `EROFS`/`EACCES` if the mount is
 *   read-only at the hostd vantage, `ENOENT` if the target does not exist).
 */
function writeFileInPlacePreservingInode(
  targetPath: string,
  content: string,
): void {
  const buf = Buffer.from(content, "utf-8");
  // "r+" = O_RDWR, fails if the file is missing, never truncates/creates on
  // open — so mode/owner are untouched and we operate on the live inode.
  const fd = openSync(targetPath, "r+");
  try {
    ftruncateSync(fd, 0);
    let off = 0;
    while (off < buf.length) {
      off += writeSync(fd, buf, off, buf.length - off, off);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  // Immediate re-validate: confirm the bytes actually landed at full
  // length before the caller hands off to reconcile. Cheap insurance
  // against a silently short write leaving a truncated config.
  const readBack = readFileSync(targetPath);
  if (readBack.length !== buf.length) {
    throw new Error(
      `in-place write short: wrote ${buf.length} bytes but read back ${readBack.length}`,
    );
  }
}

const STATUS_RETENTION_MS = 10 * 60 * 1000; // 10 min
const STATUS_MAX_ENTRIES = 256;

/** Tail length for stdout/stderr in audit + response frames. */
const TAIL_BYTES = 4096;

/**
 * #2487 item 7 — minimum age before a `started` fleet-mutation row with no
 * terminal counterpart is treated as ORPHANED on hostd boot. A normal
 * mutation completes (and writes its terminal row) well under this; only a
 * mutation whose process died without finishing (SIGKILL mid-rollout)
 * leaves a `started` row this stale. Conservative (15 min) so an in-flight
 * mutation that legitimately spans a quick hostd restart isn't falsely
 * flagged. Exported so the boot-reconcile test can pin the threshold.
 */
export const ORPHAN_RECONCILE_AGE_MS = 15 * 60 * 1000;

export class HostdServer {
  // One Server per bound socket path. `node:net.Server.listen` can
  // only be called once per instance — to bind N agent sockets we
  // need N servers. Map: bindPath → Server.
  private servers = new Map<string, Server>();
  private statusByRequestId = new Map<string, StatusEntry>();
  /** Serializes audit-log appends. A redacted terminal row can be
   *  ~4 KiB — above Linux PIPE_BUF (4096), so concurrent appendFile
   *  calls (e.g. a terminal write racing a parallel agent_logs
   *  writeAudit) are no longer guaranteed atomic and could interleave
   *  into a corrupt JSONL line. Chaining the writes keeps every row
   *  whole; parseAuditLine still tolerates a torn line defensively. */
  private auditAppendChain: Promise<void> = Promise.resolve();
  /** sec WS10-F2 / #1417: per-row tamper-evidence hash-chain position.
   *  Seeded lazily from the existing log inside the serialized append
   *  section (so the seed read and the first chained write can't race
   *  the request path) and advanced only after a durable append. */
  private auditChainState: ChainState | undefined;
  /** idempotency_key → request_id of the canonical (first) call. */
  private idempotencyKeys = new Map<string, { request_id: string; ts: number }>();
  /**
   * Fleet-wide mutation lock — set while a long-running fleet
   * mutation (`update_apply` or `apply`) is in flight. Phase 2 verb
   * dispatchers consult this to refuse concurrent fleet mutations
   * with `denied`, with the in-flight verb's request_id in the reason
   * so the caller can `get_status` the existing run.
   *
   * Why fleet-wide and not per-verb: `update_apply` regenerates the
   * compose file + recreates containers — if it runs concurrently
   * with `apply` (which ALSO regenerates compose), the second one
   * sees a half-written compose mid-write. A single mutex
   * serializes both verbs even though they're different ops.
   *
   * Per-agent verbs (`agent_start`/`agent_stop`/`agent_restart`)
   * are NOT gated by this lock — `docker compose <op> <service>` is
   * service-scoped, and serializing across agents would prevent the
   * common "fleet boot in parallel" case for no real safety win.
   */
  private fleetMutationInFlight:
    | {
        op: "update_apply" | "apply" | "rollout";
        request_id: string;
        started_at: number;
      }
    | null = null;

  constructor(private opts: ServerOptions) {}

  /** Start listening on every configured agent's socket. */
  async start(): Promise<void> {
    const hostdDir = join(this.opts.homeDir, ".switchroom", "hostd");
    await mkdir(hostdDir, { recursive: true });
    // 0o755 (not 0o700) so the operator's compose generator can
    // existsSync(<hostdDir>/<agentName>) at apply time — the dir
    // listing is needed to emit the per-agent bind mount into the
    // agent service. Confidentiality of incoming connections is
    // enforced by the SOCKET mode (0o660) + chown-to-agent-uid below,
    // not by the dir mode. The dir only ever contains other agent
    // subdirs + sockets, all of which are themselves access-controlled.
    // Pre-fix the daemon bound sockets but compose silently skipped
    // every bind mount because the operator's uid couldn't traverse
    // a root-owned 0700 dir, so no agent could ever reach the daemon.
    await chmod(hostdDir, 0o755).catch(() => undefined);

    const agentNames = Object.keys(this.opts.agentUids).sort();
    if (agentNames.length === 0) {
      // No admin agents declared yet. Phase 1 no-op exit — the
      // compose generator only emits the daemon when there's at
      // least one admin agent, so reaching this branch in production
      // would be a config-generator bug.
      return;
    }

    // Partial-bind safety: if listen() rejects for agent N, the
    // sockets bound for agents 0..N-1 are still live. Without
    // cleanup the daemon would leave half its sockets in service
    // and main.ts would exit with the exception, stranding the
    // bound paths on disk. Wrap each iteration; on first failure,
    // tear down everything we've bound and rethrow.
    try {
      for (const name of agentNames) {
        const dir = join(hostdDir, name);
        const sockPath = join(dir, "sock");
        await mkdir(dir, { recursive: true });
        // Same rationale as the parent dir above: 0o755 so the
        // operator's `existsSync(<dir>)` in compose.ts succeeds;
        // socket-level mode + chown is the security boundary.
        await chmod(dir, 0o755).catch(() => undefined);
        if (existsSync(sockPath)) await unlink(sockPath).catch(() => undefined);

        const server = createServer((socket) =>
          this.onConnection(socket, sockPath),
        );
        server.on("error", (err) => {
          process.stderr.write(`hostd: server error on ${sockPath}: ${err.message}\n`);
        });

        await new Promise<void>((resolve, reject) => {
          server.listen(sockPath, () => resolve());
          server.once("error", reject);
        });
        await chmod(sockPath, 0o660).catch(() => undefined);
        if (process.platform === "linux" && !this.opts.allowNonLinux) {
          await chown(sockPath, this.opts.agentUids[name]!, -1).catch((err) => {
            process.stderr.write(
              `hostd: chown(${sockPath}, uid=${this.opts.agentUids[name]}): ${(err as Error).message}\n`,
            );
          });
        }
        this.servers.set(sockPath, server);
      }

      // Operator socket — host-shell reachable. Without this, hostd is
      // ONLY reachable agent→hostd (per-agent sockets are agent-UID-
      // owned 0660); the host operator's `switchroom doctor` etc. have
      // no transport. Mirrors the vault-broker / auth-broker operator-
      // listener pattern: bind `<hostdDir>/operator/sock`, mode 0600,
      // chowned to the operator UID. peercred maps this path to
      // kind:"operator" and checkGate leaves it ungated (the operator
      // IS root-equivalent on its own host). Inside the try so the
      // partial-bind teardown covers it. No-op when the operator UID
      // env is unset (tests / a legacy compose without it) — same
      // posture as the broker.
      const opUidStr = process.env.SWITCHROOM_HOSTD_OPERATOR_UID;
      if (opUidStr !== undefined) {
        const opUid = Number.parseInt(opUidStr, 10);
        if (!Number.isFinite(opUid) || opUid <= 0) {
          process.stderr.write(
            `hostd: SWITCHROOM_HOSTD_OPERATOR_UID='${opUidStr}' is not a positive integer; skipping operator listener\n`,
          );
        } else {
          const dir = join(hostdDir, "operator");
          const sockPath = join(dir, "sock");
          await mkdir(dir, { recursive: true });
          await chmod(dir, 0o755).catch(() => undefined);
          if (existsSync(sockPath)) await unlink(sockPath).catch(() => undefined);
          const server = createServer((socket) =>
            this.onConnection(socket, sockPath),
          );
          server.on("error", (err) => {
            process.stderr.write(
              `hostd: server error on ${sockPath}: ${err.message}\n`,
            );
          });
          await new Promise<void>((resolve, reject) => {
            server.listen(sockPath, () => resolve());
            server.once("error", reject);
          });
          // 0600 (not 0660 like the per-agent sockets): operator-only.
          await chmod(sockPath, 0o600).catch(() => undefined);
          if (process.platform === "linux" && !this.opts.allowNonLinux) {
            await chown(sockPath, opUid, opUid).catch((err) => {
              process.stderr.write(
                `hostd: chown(${sockPath}, uid=${opUid}): ${(err as Error).message}\n`,
              );
            });
          }
          this.servers.set(sockPath, server);
        }
      }
    } catch (err) {
      await this.stop();
      throw err;
    }

    // #2487 item 7 — orphaned-`started`-row reconcile guard. A fleet
    // mutation (update_apply / apply / rollout) records a synchronous
    // `started` audit row, then a `terminal` row when the spawned child
    // finishes. If hostd is SIGKILLed mid-mutation (e.g. a rollout's
    // hostd-refresh recreated this very container — brick scenario #1),
    // the terminal row never lands: the fleet is left half-rolled and the
    // status shows a perpetual `started`. On the next boot we scan for
    // such orphans and emit a LOUD terminal failure row so the gap is
    // detectable (via /audit hostd / get_status) instead of silently
    // hanging forever. Best-effort: never throws, never blocks boot.
    await this.reconcileOrphanedFleetMutations().catch((e) => {
      process.stderr.write(
        `hostd: orphan-reconcile sweep failed (non-fatal): ${(e as Error).message}\n`,
      );
    });
  }

  /**
   * Scan the audit log for fleet-mutation `started` rows with no matching
   * `terminal` row, older than {@link ORPHAN_RECONCILE_AGE_MS}, and append
   * a loud terminal failure row for each (#2487 item 7). Emits
   * `rollout_orphaned` for rollout ops and `update_failed` for
   * update_apply/apply — the gateway / audit reader can branch on op +
   * this synthetic phase to alert the operator. A row that ALREADY has a
   * terminal counterpart, or that we already reconciled (its synthetic
   * row exists), is skipped — the sweep is idempotent across reboots.
   */
  private async reconcileOrphanedFleetMutations(): Promise<void> {
    const path = this.auditLogPath();
    if (!existsSync(path)) return;
    let raw: string;
    try {
      raw = readFileSync(path, "utf-8");
    } catch {
      return;
    }
    const FLEET_OPS = new Set(["update_apply", "apply", "rollout"]);
    // request_id → started row info; cleared when a terminal/orphan row
    // for the same request_id is seen.
    const startedRows = new Map<
      string,
      { op: string; ts: number; caller_name?: string }
    >();
    for (const line of raw.split("\n")) {
      const e = parseAuditLine(line);
      if (!e) continue;
      // Our synthetic orphan row (op=rollout_orphaned/update_failed,
      // phase=orphan_reconciled) carries the ORIGINAL request_id and
      // resolves the started — checked BEFORE the FLEET_OPS filter since
      // its own op is not a fleet op. This makes the sweep idempotent.
      if (e.phase === "orphan_reconciled") {
        startedRows.delete(e.request_id);
        continue;
      }
      if (!FLEET_OPS.has(e.op)) continue;
      // A terminal row resolves the started.
      if (e.phase === "terminal") {
        startedRows.delete(e.request_id);
        continue;
      }
      // Synchronous request-path `started` row (no phase).
      if (e.result === "started" && e.phase === undefined) {
        const tsMs = Date.parse(e.ts);
        startedRows.set(e.request_id, {
          op: e.op,
          ts: Number.isFinite(tsMs) ? tsMs : Date.now(),
          caller_name: e.caller.kind === "agent" ? e.caller.name : undefined,
        });
      }
    }
    const now = Date.now();
    for (const [request_id, info] of startedRows) {
      if (now - info.ts < ORPHAN_RECONCILE_AGE_MS) continue; // too fresh
      const synthOp = info.op === "rollout" ? "rollout_orphaned" : "update_failed";
      process.stderr.write(
        `hostd: ORPHANED ${info.op} (request_id=${request_id}, ` +
          `started ${Math.floor((now - info.ts) / 60000)}m ago, no terminal ` +
          `row) — emitting ${synthOp}. The fleet may be half-rolled; verify ` +
          `host-side.\n`,
      );
      await this.appendAuditRow({
        ts: new Date().toISOString(),
        op: synthOp,
        phase: "orphan_reconciled",
        // Carry the ORIGINAL request_id so the terminal row resolves the
        // orphan on the next boot's sweep (idempotency).
        request_id,
        original_op: info.op,
        caller: info.caller_name
          ? { kind: "agent", name: info.caller_name }
          : { kind: "operator" },
        result: "error",
        exit_code: null,
        duration_ms: now - info.ts,
        error:
          `${info.op} left a perpetual 'started' status with no terminal row ` +
          `(hostd likely SIGKILLed mid-mutation — brick scenario #1). ` +
          `Reconciled to a failure on hostd boot. The fleet may be ` +
          `half-rolled; verify versions host-side and re-run if needed.`,
      });
    }
  }

  /** Stop the server and clean up sockets. Idempotent. */
  async stop(): Promise<void> {
    const paths = [...this.servers.keys()];
    for (const [, server] of this.servers) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    this.servers.clear();
    for (const s of paths) {
      await unlink(s).catch(() => undefined);
    }
  }

  /** Test/observation hook — paths the server actually bound to. */
  getBoundPaths(): readonly string[] {
    return [...this.servers.keys()];
  }

  /** Test hook — clear retained status entries. */
  resetForTest(): void {
    this.statusByRequestId.clear();
    this.idempotencyKeys.clear();
  }

  private onConnection(socket: Socket, bindPath: string): void {
    // The bind path is closure-captured at server creation in
    // start() — one Server per agent path. This is the trusted
    // identity source: socketPathToIdentity parses the daemon's
    // OWN bind path, which an agent cannot influence.
    const identity = socketPathToIdentity(bindPath);
    if (!identity) {
      // Path doesn't parse — close. Caller can't be identified.
      // (Should be impossible with our own listen paths, but be
      // defensive.)
      socket.end();
      return;
    }

    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      // DoS guard: a malicious caller can stream bytes without ever
      // sending a newline and OOM the daemon if we just keep
      // appending. Cap the buffer at 2x MAX_FRAME_BYTES (same shape
      // as the client's incoming cap at client.ts) — one valid frame
      // plus a half-frame slack before we hard-close. The cap is
      // checked on every chunk, before the newline-search, so the
      // attacker can't slip past by chunk-aligning.
      if (Buffer.byteLength(buf, "utf8") > MAX_FRAME_BYTES * 2) {
        process.stderr.write(
          `hostd: closing connection — request exceeded ${MAX_FRAME_BYTES * 2} bytes without a newline\n`,
        );
        socket.destroy();
        return;
      }
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      this.handleLine(line, identity, socket).catch((err) => {
        process.stderr.write(`hostd: handler error: ${(err as Error).message}\n`);
        socket.end();
      });
    });
    socket.on("error", () => undefined);
  }

  private async handleLine(
    line: string,
    caller: SocketIdentity,
    socket: Socket,
  ): Promise<void> {
    let req: HostdRequest;
    try {
      req = decodeRequest(line);
    } catch (err) {
      // Echo the caller's request_id when we can extract one (helps
      // them correlate the denial to their request); fall back to a
      // literal sentinel when the line wasn't even valid JSON or
      // didn't carry the field.
      let echoId = "malformed-request";
      try {
        const obj = JSON.parse(line) as { request_id?: unknown };
        if (typeof obj.request_id === "string" && obj.request_id.length > 0) {
          echoId = obj.request_id;
        }
      } catch {
        // Non-JSON line — keep the sentinel.
      }
      socket.write(
        encodeResponse(deniedResponse(echoId, `bad request: ${(err as Error).message}`)),
      );
      socket.end();
      return;
    }

    const idempotencyKey = req.idempotency_key ?? req.request_id;
    const now = Date.now();
    this.evictExpiredIdempotency(now);
    const prior = this.idempotencyKeys.get(idempotencyKey);
    if (prior && now - prior.ts < IDEMPOTENCY_WINDOW_MS) {
      // Reuse the prior response if available. Note: only mutating
      // verbs (agent_restart) call recordStatus(), so the lookup
      // only hits a cached status for those. Read-only verbs
      // (upgrade_status, get_status) flow through here and re-run —
      // intentional: idempotency is about *mutation* safety, not
      // bandwidth saving on read-only queries.
      const cached = this.statusByRequestId.get(prior.request_id);
      if (cached) {
        socket.write(encodeResponse(this.statusEntryToResponse(req.request_id, cached)));
        socket.end();
        return;
      }
    }
    this.idempotencyKeys.set(idempotencyKey, { request_id: req.request_id, ts: now });

    const denied = this.checkGate(req, caller);
    if (denied) {
      const resp = deniedResponse(req.request_id, denied);
      await this.writeAudit({ caller, req, resp });
      socket.write(encodeResponse(resp));
      socket.end();
      return;
    }

    const started = Date.now();
    let resp: HostdResponse;
    try {
      switch (req.op) {
        case "agent_restart":
          resp = await this.handleAgentRestart(req, caller, started);
          break;
        case "upgrade_status":
          resp = await this.handleUpgradeStatus(req, started);
          break;
        case "get_status":
          resp = this.handleGetStatus(req, caller, started);
          break;
        // ── Phase 2 verbs ────────────────────────────────────────
        case "update_check":
          resp = await this.handleUpdateCheck(req, started);
          break;
        case "update_apply":
          resp = this.handleUpdateApply(req, caller, started);
          break;
        case "apply":
          resp = this.handleApply(req, caller, started);
          break;
        case "rollout":
          resp = this.handleRollout(req, caller, started);
          break;
        case "agent_start":
          resp = await this.handleAgentStart(req, started);
          break;
        case "agent_stop":
          resp = await this.handleAgentStop(req, started);
          break;
        // ── Phase 3 admin-observability verbs ────────────────────
        case "agent_logs":
          resp = await this.handleAgentLogs(req, started);
          break;
        case "agent_exec":
          resp = await this.handleAgentExec(req, started);
          break;
        // ── Phase 3.1 read-only fleet doctor ─────────────────────
        case "doctor":
          resp = await this.handleDoctor(req, started);
          break;
        // ── Phase 3.2 read-only in-agent liveness battery ────────
        case "agent_smoke":
          resp = await this.handleAgentSmoke(req, started);
          break;
        // ── Dashboard read-ops (dockerless-web fix) ──────────────
        case "agent_status":
          resp = this.handleAgentStatus(req, started);
          break;
        case "agent_schedule":
          resp = this.handleAgentSchedule(req, started);
          break;
        // ── PR 1a (admin-agent-config-edit RFC) ──────────────────
        // Stub dispatcher: flag-gated disabled error or a
        // not-implemented marker. PR 1b adds validation; PR 1c adds
        // the approval card + apply path.
        case "config_propose_edit":
          resp = await this.handleConfigProposeEdit(req, caller, started);
          break;
      }
    } catch (e) {
      // #1761: top-level dispatch failure — no fix.kind applies
      // (genuine server fault). Envelope still carries the code so
      // agents can branch on `error_envelope.code` instead of regex.
      const msg = (e as Error).message;
      resp = err(
        "E_DISPATCH_FAILED",
        "hostd dispatch failed",
      )
        .why(msg)
        .op(req.op)
        .caller(caller.kind === "agent" ? "agent" : "operator")
        .agentName(caller.kind === "agent" ? caller.name : undefined)
        .build(req.request_id, Date.now() - started);
      // Preserve the legacy error string for back-compat with existing
      // string-matching decoders.
      resp = { ...resp, error: `hostd dispatch failed: ${msg}` };
    }
    await this.writeAudit({ caller, req, resp });
    socket.write(encodeResponse(resp));
    socket.end();
  }

  /**
   * Per-verb gate. Returns null when the call is allowed, or a string
   * describing the denial reason. RFC C §5.4 trust model:
   *
   *   - any   — upgrade_status (and self-targeted agent_restart)
   *   - admin — cross-agent agent_restart
   *   - admin + operator-attest — update_apply / apply (Phase 2)
   */
  private checkGate(req: HostdRequest, caller: SocketIdentity): string | null {
    if (caller.kind === "operator") return null;
    const callerAdmin =
      this.opts.config.agents[caller.name]?.admin === true;
    switch (req.op) {
      case "upgrade_status":
        return null;
      case "agent_restart":
        if (req.args.name === caller.name) return null; // self-target
        return callerAdmin
          ? null
          : `agent_restart cross-agent requires admin: true on caller "${caller.name}"`;
      case "get_status": {
        // The lookup is admin-or-self relative to the *original*
        // request. Phase 1 stores caller on the entry; admins or the
        // original caller can read it. Anything else is denied to
        // avoid information leakage across agents.
        const entry = this.statusByRequestId.get(req.args.target_request_id);
        if (!entry) {
          // No leak: return "denied: not found" the same as the
          // unauthorized case so callers can't probe for the
          // existence of request_ids that aren't theirs.
          return `get_status: request_id not found or not visible to caller "${caller.name}"`;
        }
        const ownCall =
          entry.caller.kind === caller.kind &&
          ("name" in entry.caller && "name" in caller
            ? entry.caller.name === caller.name
            : true);
        if (ownCall || callerAdmin) return null;
        return `get_status: request_id not found or not visible to caller "${caller.name}"`;
      }
      // ── Phase 2 verb gates ─────────────────────────────────────
      case "update_check":
        // Read-only fleet introspection (calls `switchroom update
        // --check` — dry-run, prints the plan, no side effects).
        // Same posture as upgrade_status: any caller including
        // non-admin agents may query.
        return null;
      case "update_apply":
      case "apply":
      case "rollout":
        // Fleet-wide mutations. Require admin: a non-admin agent
        // accidentally regenerating compose / pulling images on the
        // whole fleet is the obvious foot-gun. Operator is always
        // allowed (kind === "operator" already returned null above).
        // `rollout` (#2487) is additionally kept OUT of HOSTD_MCP_TOOLS
        // in scaffold.ts, so an agent's call surfaces a Telegram approval
        // card — the human tap is the real boundary; this admin gate is
        // the wire-side floor.
        return callerAdmin
          ? null
          : `${req.op} requires admin: true on caller "${caller.name}"`;
      case "agent_start":
      case "agent_stop":
        // Mirror agent_restart's gate: self-target always allowed;
        // cross-agent requires admin. Mutations are per-service so
        // there's no concurrent-fleet-write hazard.
        if (req.args.name === ("name" in caller ? caller.name : null))
          return null;
        return callerAdmin
          ? null
          : `${req.op} cross-agent requires admin: true on caller "${caller.name}"`;
      case "agent_logs":
      case "agent_exec":
      case "agent_smoke":
        // Phase 3 admin-observability verbs. Self-target is allowed
        // (an agent reading its own logs / inspecting its own
        // container is harmless and useful for self-debugging);
        // cross-agent requires admin. agent_exec additionally enforces
        // a read-only argv allowlist at dispatch time — see
        // isAllowlistedReadOnlyArgv. agent_smoke runs a FIXED
        // read-only probe battery (no caller-supplied argv at all),
        // so it's strictly safer than agent_exec under the same gate.
        if (req.args.name === caller.name) return null;
        return callerAdmin
          ? null
          : `${req.op} cross-agent requires admin: true on caller "${caller.name}"`;
      case "doctor":
        // Read-only, but whole-fleet: running `switchroom doctor`
        // host-side enumerates every agent + singleton's health —
        // broader exposure than update_check's version/plan view, so
        // gate it to admin (no operator-attest / fleet-mutation lock;
        // it changes nothing). The gateway only surfaces the
        // whole-fleet option on admin agents, but the daemon is the
        // enforced boundary. Operator (kind === "operator") already
        // returned null at the top of this method.
        return callerAdmin
          ? null
          : `doctor requires admin: true on caller "${caller.name}"`;
      case "agent_status":
      case "agent_schedule":
        // Read-only dashboard observability. The real consumer is the
        // web, which connects over the OPERATOR socket and returned null
        // at the top of this method (ungated, by design — see the
        // dispatcher comment in main.ts and hostd-config-propose.ts).
        // For an AGENT caller we mirror agent_smoke/agent_logs: a
        // self-scoped query (its own name) is harmless self-debugging;
        // a single OTHER agent's view or the whole-fleet view (name
        // omitted) is broader exposure, so require admin — same posture
        // as doctor's whole-fleet enumeration. These verbs change
        // nothing; no fleet-mutation lock applies.
        if (req.args.name !== undefined && req.args.name === caller.name) {
          return null;
        }
        return callerAdmin
          ? null
          : `${req.op} ${req.args.name === undefined ? "fleet view" : "cross-agent"} requires admin: true on caller "${caller.name}"`;
      case "config_propose_edit":
        // Admin callers may propose ANY edit to the central
        // switchroom.yaml. Non-admin callers are admitted here but
        // confined to a SELF-SCOPED edit: `handleConfigProposeEdit`
        // runs `assertSelfScopedAllowEdit` after validation and rejects
        // anything that touches more than the caller's own
        // `agents.<caller>.tools.allow`. This is the one privileged
        // verb a non-admin agent can reach — it's what makes
        // "🔁 Always allow" persist for the whole fleet (operator-tapped,
        // single-shot, #1977 correlation), not just the 3 admin agents.
        // Binding a socket ≠ granting admin: the self-scope check is the
        // enforced boundary, not this gate.
        return null;
    }
  }

  private async handleAgentRestart(
    req: Extract<HostdRequest, { op: "agent_restart" }>,
    caller: SocketIdentity,
    started: number,
  ): Promise<HostdResponse> {
    const args = ["agent", "restart", req.args.name];
    if (req.args.force) args.push("--force");
    const entry: StatusEntry = {
      request_id: req.request_id,
      caller,
      op: req.op,
      result: "started",
      exit_code: null,
      started_at: started,
      finished_at: null,
      stdout_tail: "",
      stderr_tail: "",
    };
    this.recordStatus(entry);

    // Fire-and-forget: return `started` immediately, drive the child
    // detached. The status entry gets updated on completion so a
    // later `get_status` poll can surface the outcome.
    this.runSwitchroom(args)
      .then((res) => {
        entry.result = res.exit_code === 0 ? "completed" : "error";
        entry.exit_code = res.exit_code;
        entry.finished_at = Date.now();
        entry.stdout_tail = tail(res.stdout);
        entry.stderr_tail = tail(res.stderr);
      })
      .catch((err) => {
        entry.result = "error";
        entry.exit_code = null;
        entry.finished_at = Date.now();
        entry.error = (err as Error).message;
      });

    return {
      v: 1,
      request_id: req.request_id,
      result: "started",
      exit_code: null,
      duration_ms: Date.now() - started,
    };
  }

  private async handleUpgradeStatus(
    req: Extract<HostdRequest, { op: "upgrade_status" }>,
    started: number,
  ): Promise<HostdResponse> {
    const res = await this.runSwitchroom(["update", "--status"]);
    const result: Result = res.exit_code === 0 ? "completed" : "error";
    return {
      v: 1,
      request_id: req.request_id,
      result,
      exit_code: res.exit_code,
      duration_ms: Date.now() - started,
      stdout_tail: tail(res.stdout),
      stderr_tail: tail(res.stderr),
    };
  }

  // ──────────────────────────────────────────────────────────────────
  // Phase 2 verbs (RFC §10)
  // ──────────────────────────────────────────────────────────────────

  /** Read-only: `switchroom update --check` — prints the plan, no
   *  side effects. Same shape as upgrade_status. */
  private async handleUpdateCheck(
    req: Extract<HostdRequest, { op: "update_check" }>,
    started: number,
  ): Promise<HostdResponse> {
    const res = await this.runSwitchroom(["update", "--check"]);
    const result: Result = res.exit_code === 0 ? "completed" : "error";
    return {
      v: 1,
      request_id: req.request_id,
      result,
      exit_code: res.exit_code,
      duration_ms: Date.now() - started,
      stdout_tail: tail(res.stdout),
      stderr_tail: tail(res.stderr),
    };
  }

  /**
   * Read-only: `switchroom doctor` run host-side, where the docker
   * socket is present, so it reports the FULL fleet (containers,
   * singletons, image/CLI ages) instead of the degraded in-container
   * view an agent gets when it shells `switchroom doctor` itself.
   *
   * Unlike update_check this is `completed` whenever the process ran,
   * regardless of exit code: `switchroom doctor` exits 1 when it
   * finds failing checks (a degraded fleet) — that's a *finding*, not
   * a verb-dispatch failure, and the report on stdout is exactly what
   * the operator wants surfaced. exit_code is carried through so the
   * caller can still see "doctor found problems". A genuine spawn
   * failure (CLI missing, OOM) throws and is caught upstream as
   * `error`.
   */
  private async handleDoctor(
    req: Extract<HostdRequest, { op: "doctor" }>,
    started: number,
  ): Promise<HostdResponse> {
    // `--fast`: the whole-fleet doctor reached via this verb (the
    // Telegram /doctor surface, #1518) must stay STRUCTURAL only. The
    // in-agent liveness section makes a hostd round-trip per agent;
    // running it here would risk the gateway's 30s shell-out timeout
    // and re-enter hostd recursively. Operators get in-agent liveness
    // by running `switchroom doctor` directly on the host (no 30s
    // budget), or via the standalone `agent_smoke` verb per agent.
    const res = await this.runSwitchroom(["doctor", "--fast"]);
    return {
      v: 1,
      request_id: req.request_id,
      result: "completed",
      exit_code: res.exit_code,
      duration_ms: Date.now() - started,
      stdout_tail: tail(res.stdout),
      stderr_tail: tail(res.stderr),
    };
  }

  /**
   * Mutating + long-running: `switchroom update` (pull + apply +
   * recreate + doctor). Async fire-and-forget pattern (same as
   * agent_restart). The fleet-mutation lock gates concurrent
   * update_apply / apply calls — if one is in flight we return
   * `denied` with the in-flight request_id so the caller can poll
   * `get_status` instead of racing.
   */
  /**
   * Apply-asset preflight. `apply` / `update_apply` shell out to the
   * bundled `switchroom` CLI, which resolves profiles + the vendored
   * hindsight plugin RELATIVE TO ITSELF (no path arg):
   *   profiles.ts:  resolve(import.meta.dirname,"../../profiles")
   *   scaffold.ts:  resolve(import.meta.dirname,"../../vendor/hindsight-memory")
   * If the hostd image was built without those (the klanker incident),
   * `update_apply` pulls images then dies at apply-config, stranding
   * the fleet on the old image. We refuse BEFORE anything is pulled
   * or changed — same fail-fast principle as the `--rebuild` guard.
   * Future-proofs the per-asset fragility: any new package-relative
   * apply asset added here can't silently strand a fleet again.
   */
  private missingApplyAssets(): string[] {
    const root =
      this.opts.applyAssetsRoot ?? resolve(import.meta.dirname, "../..");
    return [
      join(root, "profiles"),
      join(root, "profiles", "default"),
      join(root, "vendor", "hindsight-memory"),
    ].filter((p) => !existsSync(p));
  }

  /** Operator-facing refusal if apply assets are missing, else null.
   *  Shared by handleUpdateApply + handleApply. */
  private applyAssetPreflight(
    request_id: string,
    started: number,
  ): HostdResponse | null {
    const missing = this.missingApplyAssets();
    if (missing.length === 0) return null;
    return deniedResponse(
      request_id,
      `refused: this switchroom-hostd image is missing apply-time ` +
        `assets [${missing.join(", ")}]. hostd's in-container ` +
        `\`switchroom apply\` cannot scaffold agents without them and ` +
        `would pull images then strand the fleet on the old image ` +
        `(the klanker incident). Nothing was pulled or changed. Fix: ` +
        `rebuild/refresh the hostd image — \`switchroom update\` ` +
        `(refreshes hostd) or \`switchroom hostd install\` on the ` +
        `host; meanwhile run \`switchroom update\` host-side.`,
      Date.now() - started,
    );
  }

  private handleUpdateApply(
    req: Extract<HostdRequest, { op: "update_apply" }>,
    caller: SocketIdentity,
    started: number,
  ): HostdResponse {
    const denied = this.checkFleetMutationLock(req.op, req.request_id, started);
    if (denied) return denied;

    const assetDenied = this.applyAssetPreflight(req.request_id, started);
    if (assetDenied) return assetDenied;

    // Mutual exclusion of channel vs pin. Schema accepts both optional;
    // server-side enforcement here keeps the contract honest at the
    // dispatch boundary (and the structured `denied` is friendlier than
    // a Zod parse error after the fact).
    if (req.args?.channel && req.args?.pin) {
      return deniedResponse(
        req.request_id,
        "update_apply: `channel` and `pin` are mutually exclusive — pass at most one.",
        Date.now() - started,
      );
    }

    const args = ["update"];
    if (req.args?.skip_images) args.push("--skip-images");
    if (req.args?.rebuild) args.push("--rebuild");
    if (req.args?.channel) args.push("--channel", req.args.channel);
    if (req.args?.pin) args.push("--pin", req.args.pin);

    // Capture install-type + (best-effort) digests up-front so the
    // started/terminal rows for this request carry full forensic
    // context even if `docker inspect` becomes unavailable mid-flight.
    const installCtx = readCachedInstallType(
      this.opts.bindRoot ?? this.opts.homeDir,
    );
    const digestRefs = this.imageRefsForDigestCapture();
    const digests = resolveDigests(digestRefs);
    const resolved_sha: Record<string, string> = {};
    for (const [k, v] of digests) resolved_sha[k] = v;

    const entry: StatusEntry = {
      request_id: req.request_id,
      caller,
      op: req.op,
      result: "started",
      exit_code: null,
      started_at: started,
      finished_at: null,
      stdout_tail: "",
      stderr_tail: "",
      ...(req.args?.channel ? { channel: req.args.channel } : {}),
      ...(req.args?.pin ? { pin: req.args.pin } : {}),
      ...(Object.keys(resolved_sha).length > 0 ? { resolved_sha } : {}),
      install_context: {
        install_type: installCtx.install_type,
        detected_at: installCtx.detected_at,
      },
    };
    this.recordStatus(entry);
    this.fleetMutationInFlight = {
      op: "update_apply",
      request_id: req.request_id,
      started_at: started,
    };
    // Inject SWITCHROOM_HOSTD_CONTEXT=1 so the update driver knows it is
    // running inside the hostd container and must defer the refresh-hostd /
    // refresh-web steps rather than attempting to recreate the very container
    // it is running in (#2458). The driver emits a SWITCHROOM_UPDATE_RESULT
    // sentinel line that we parse below to populate entry.deferred.
    this.spawnFleetMutation(req.op, args, entry, { SWITCHROOM_HOSTD_CONTEXT: "1" });
    return {
      v: 1,
      request_id: req.request_id,
      result: "started",
      exit_code: null,
      duration_ms: Date.now() - started,
    };
  }

  /**
   * Mutating: `switchroom apply --non-interactive` (regenerate per-
   * agent scaffolds + compose file; doesn't recreate containers).
   * Faster than update_apply (10-30s typically) but still gated by
   * the same fleet-mutation lock — concurrent apply + update_apply
   * would write to the same compose file mid-render.
   */
  private handleApply(
    req: Extract<HostdRequest, { op: "apply" }>,
    caller: SocketIdentity,
    started: number,
  ): HostdResponse {
    const denied = this.checkFleetMutationLock(req.op, req.request_id, started);
    if (denied) return denied;

    const assetDenied = this.applyAssetPreflight(req.request_id, started);
    if (assetDenied) return assetDenied;

    const args = ["apply", "--non-interactive"];
    const entry: StatusEntry = {
      request_id: req.request_id,
      caller,
      op: req.op,
      result: "started",
      exit_code: null,
      started_at: started,
      finished_at: null,
      stdout_tail: "",
      stderr_tail: "",
    };
    this.recordStatus(entry);
    this.fleetMutationInFlight = {
      op: "apply",
      request_id: req.request_id,
      started_at: started,
    };
    this.spawnFleetMutation(req.op, args, entry);
    return {
      v: 1,
      request_id: req.request_id,
      result: "started",
      exit_code: null,
      duration_ms: Date.now() - started,
    };
  }

  /**
   * Mutating + long-running: `switchroom rollout` — the SAFE staggered
   * canary + per-agent version-assert + stop-on-mismatch fleet deploy
   * (#2487). Modeled on handleUpdateApply (shares the fleet-mutation lock
   * + apply-asset preflight) but with three load-bearing differences:
   *
   *   1. The spawned CLI runs with `SWITCHROOM_HOSTD_CONTEXT=1`, which
   *      flips the rollout to (a) persist the durable pin AFTER the canary
   *      confirms (not before — brick scenario #2), and (b) DROP the
   *      hostd/web self-refresh (it would SIGKILL this very rollout, which
   *      is hostd's own child — brick scenario #1).
   *   2. The outcome (`rolled[]` / `failedStep` / `failedAgent`) is
   *      preserved into STRUCTURED status fields, parsed from the child's
   *      sentinel line — NOT flattened into a stdout tail.
   *   3. `pin` is semver-only (already enforced at the wire schema).
   *
   * Returns `started`; default wire timeout (no long override) — same
   * async fire-and-forget pattern as update_apply.
   */
  private handleRollout(
    req: Extract<HostdRequest, { op: "rollout" }>,
    caller: SocketIdentity,
    started: number,
  ): HostdResponse {
    const denied = this.checkFleetMutationLock(req.op, req.request_id, started);
    if (denied) return denied;

    const assetDenied = this.applyAssetPreflight(req.request_id, started);
    if (assetDenied) return assetDenied;

    const args = ["rollout", "--pin", req.args.pin];
    if (req.args.agents && req.args.agents.length > 0) {
      args.push("--agents", req.args.agents.join(","));
    }
    if (req.args.skip_web) args.push("--skip-web");

    const installCtx = readCachedInstallType(
      this.opts.bindRoot ?? this.opts.homeDir,
    );

    const entry: StatusEntry = {
      request_id: req.request_id,
      caller,
      op: req.op,
      result: "started",
      exit_code: null,
      started_at: started,
      finished_at: null,
      stdout_tail: "",
      stderr_tail: "",
      pin: req.args.pin,
      install_context: {
        install_type: installCtx.install_type,
        detected_at: installCtx.detected_at,
      },
    };
    this.recordStatus(entry);
    this.fleetMutationInFlight = {
      op: "rollout",
      request_id: req.request_id,
      started_at: started,
    };
    this.spawnRollout(args, entry);
    return {
      v: 1,
      request_id: req.request_id,
      result: "started",
      exit_code: null,
      duration_ms: Date.now() - started,
    };
  }

  /** Synchronous: `switchroom agent start <name>` — fast (~1-2s for
   *  `docker compose start <service>`). No fleet-mutation lock —
   *  the underlying compose op is service-scoped. */
  private async handleAgentStart(
    req: Extract<HostdRequest, { op: "agent_start" }>,
    started: number,
  ): Promise<HostdResponse> {
    const res = await this.runSwitchroom(["agent", "start", req.args.name]);
    return {
      v: 1,
      request_id: req.request_id,
      result: res.exit_code === 0 ? "completed" : "error",
      exit_code: res.exit_code,
      duration_ms: Date.now() - started,
      stdout_tail: tail(res.stdout),
      stderr_tail: tail(res.stderr),
    };
  }

  /** Synchronous: `switchroom agent stop <name>`. Same posture as
   *  agent_start. Note: the CLI does NOT accept `--force` today
   *  (verified via `src/cli/agent.ts` registration). If drain-skip
   *  semantics arrive, plumb the flag here in lockstep with the
   *  schema's `args.force` field. */
  private async handleAgentStop(
    req: Extract<HostdRequest, { op: "agent_stop" }>,
    started: number,
  ): Promise<HostdResponse> {
    const args = ["agent", "stop", req.args.name];
    const res = await this.runSwitchroom(args);
    return {
      v: 1,
      request_id: req.request_id,
      result: res.exit_code === 0 ? "completed" : "error",
      exit_code: res.exit_code,
      duration_ms: Date.now() - started,
      stdout_tail: tail(res.stdout),
      stderr_tail: tail(res.stderr),
    };
  }

  /**
   * `docker logs --tail <n> <container>` — synchronous read of a peer
   * container's combined stdout/stderr. The default container name in
   * the switchroom compose project is `switchroom-<agent>`; we shell
   * out via `docker` directly rather than through the CLI because no
   * `switchroom agent logs` verb exists and adding one would just
   * proxy this anyway. The `4 KiB tail` cap on stdout_tail caps the
   * response frame size; for full logs the operator should use
   * `docker logs` directly on the host.
   */
  private async handleAgentLogs(
    req: Extract<HostdRequest, { op: "agent_logs" }>,
    started: number,
  ): Promise<HostdResponse> {
    const tailLines = req.args.tail ?? 100;
    const container = `switchroom-${req.args.name}`;
    const res = await this.runDocker([
      "logs",
      "--tail",
      String(tailLines),
      container,
    ]);
    return {
      v: 1,
      request_id: req.request_id,
      result: res.exit_code === 0 ? "completed" : "error",
      exit_code: res.exit_code,
      duration_ms: Date.now() - started,
      stdout_tail: tail(res.stdout),
      stderr_tail: tail(res.stderr),
    };
  }

  /**
   * `docker exec <container> <argv...>` — synchronous, gated by a
   * read-only inspection allowlist enforced here in the daemon. argv[0]
   * must be one of {@link READONLY_EXEC_ALLOWLIST}; writes / mutations
   * are rejected with a clear pointer to the deferred approval-kernel
   * scope work. This is deliberately a small allowlist: anything you
   * can do here you can also do via `agent_logs` + a careful reading of
   * the agent's state files, so the surface stays observability-only.
   */
  private async handleAgentExec(
    req: Extract<HostdRequest, { op: "agent_exec" }>,
    started: number,
  ): Promise<HostdResponse> {
    const argv0 = req.args.argv[0]!;
    if (!isAllowlistedReadOnlyArgv(argv0)) {
      return deniedResponse(
        req.request_id,
        `agent_exec: "${argv0}" is not on the read-only allowlist. ` +
          `Allowed: ${READONLY_EXEC_ALLOWLIST.join(", ")}. ` +
          `Writes inside peer containers require the host_os.exec ` +
          `approval-kernel scope, which is not yet wired — see ` +
          `reference/rfcs/approval-kernel.md §6 (deferred follow-up).`,
        Date.now() - started,
      );
    }
    // #1401 / #1400 target 3: reject any argv element carrying a C0
    // control byte (NUL/LF/CR + ESC and the rest of U+0000–U+001F),
    // DEL, or exceeding the per-element size cap — audit-log line
    // injection, ANSI-escape spoofing of the operator audit trail,
    // and arg-vector padding, all before the call.
    if (!req.args.argv.every(isSafeExecArgvElement)) {
      return deniedResponse(
        req.request_id,
        `agent_exec: an argv element contains a control character ` +
          `(C0 / DEL) or exceeds ${MAX_EXEC_ARGV_ELEMENT_BYTES} bytes, ` +
          `which is not permitted (#1401 / #1400).`,
        Date.now() - started,
      );
    }
    const container = `switchroom-${req.args.name}`;
    // No `--`. Unlike `docker run`, `docker exec` stops parsing its
    // OWN options at CONTAINER: every token after the container name
    // is the command/args. Verified against real docker —
    // `docker exec C -e X cmd` execs a program literally named "-e"
    // (it is NOT read as --env). So the #1401 concern (argv[0]
    // reinterpreted as a docker flag) cannot occur for `docker exec`;
    // and a literal `--` is actively harmful — docker exec tries to
    // exec a binary named "--" → "executable file not found" / exit
    // 127. The prior `--` silently broke EVERY real agent_exec; it
    // was only ever exercised against a docker STUB in tests, which
    // didn't model real docker's post-CONTAINER argv handling.
    const res = await this.runDocker(["exec", container, ...req.args.argv]);
    return {
      v: 1,
      request_id: req.request_id,
      result: res.exit_code === 0 ? "completed" : "error",
      exit_code: res.exit_code,
      duration_ms: Date.now() - started,
      stdout_tail: tail(res.stdout),
      stderr_tail: tail(res.stderr),
    };
  }

  /**
   * Read-only in-agent liveness battery (Phase 3.2). hostd is the one
   * audited, admin-gated component with the docker socket, so the
   * privileged in-container probing lives HERE, not in an
   * unprivileged caller. Every probe is a FIXED literal command (no
   * caller argv) returning only a boolean/state — NEVER a secret
   * value (the bot-token probe uses `grep -q`, which emits nothing).
   * A down container or a docker failure degrades every probe to
   * `skip`; the verb itself is always `completed` when it ran (a
   * failing probe is a *finding* the caller renders, not a
   * verb-dispatch failure — same posture as the doctor verb). `deep`
   * adds an auth-liveness check that reads the agent's stored OAuth
   * credential and verifies it is present and unexpired; it makes NO
   * model call (the default path makes no model call either).
   */
  /**
   * `config_propose_edit` — full apply path (#1623 / RFC §3.3-3.4).
   *
   * Deliberately OUT of scope per operator decision (single-operator
   * single-host posture, see PR description): rate limiter,
   * crash-recovery journal, Prometheus metrics, TOCTOU re-validation,
   * literal `flock` on the config file (the in-process mutex is
   * sufficient — hostd is the only writer), attachment fallback for
   * very large diffs, 5s safety-delay button swap, privilege-
   * escalation detection.
   */
  private async handleConfigProposeEdit(
    req: Extract<HostdRequest, { op: "config_propose_edit" }>,
    caller: SocketIdentity,
    started: number,
  ): Promise<HostdResponse> {
    const enabled = this.opts.config.hostd?.config_edit_enabled === true;
    if (!enabled) {
      // #1761: policy denial (feature flag off), not a server error.
      // Flip to `denied` so callers branching on `result` see the
      // right classification.
      return err("E_CONFIG_EDIT_DISABLED", "config_propose_edit is disabled")
        .why("operator opt-in per RFC §3.3")
        .fixFlipFlag("hostd.config_edit_enabled", true)
        .docs("https://switchroom.dev/docs/config-edit#opt-in")
        .op("config_propose_edit")
        .caller(caller.kind === "agent" ? "agent" : "operator")
        .agentName(caller.kind === "agent" ? caller.name : undefined)
        .asDenied()
        .build(req.request_id, Date.now() - started);
    }
    const configPath =
      this.opts.configPath ?? req.args.target_path;
    const verdict = validateConfigEdit({
      configPath,
      targetPath: req.args.target_path,
      unifiedDiff: req.args.unified_diff,
    });
    if (!verdict.ok) {
      // #1761: surface a structured envelope so the agent can render a
      // targeted fix hint (the unified_diff is the only author-input).
      return err(verdict.code, verdict.detail)
        .fixBadInput("unified_diff")
        .op("config_propose_edit")
        .caller(caller.kind === "agent" ? "agent" : "operator")
        .agentName(caller.kind === "agent" ? caller.name : undefined)
        .build(req.request_id, Date.now() - started);
    }
    // ── Self-scope gate (non-admin callers) ─────────────────────────
    // checkGate admits non-admin agents to this verb; this is the
    // enforced boundary. A non-admin agent may only widen its OWN
    // `agents.<caller>.tools.allow` — the "🔁 Always allow" persistence
    // path. Operators and admin agents skip the check (full trust).
    if (caller.kind === "agent" && this.opts.config.agents[caller.name]?.admin !== true) {
      let beforeContent: string;
      try {
        beforeContent = readFileSync(configPath, "utf-8");
      } catch {
        beforeContent = "";
      }
      const scope = assertSelfScopedAllowEdit(
        beforeContent,
        verdict.postApplyContent,
        caller.name,
      );
      if (!scope.ok) {
        return err("E_NOT_SELF_SCOPED", scope.detail)
          .why(
            "non-admin agents may only add rules to their own " +
              "agents.<self>.tools.allow via config_propose_edit",
          )
          .fixBadInput("unified_diff")
          .op("config_propose_edit")
          .caller("agent")
          .agentName(caller.name)
          .asDenied()
          .build(req.request_id, Date.now() - started);
      }
    }
    // ── Approval card ───────────────────────────────────────────────
    if (!this.opts.approvalGateway) {
      // #1761: missing approval-gateway wiring is an operator/infra
      // configuration gap — the agent cannot self-recover.
      return err(
        "E_NO_APPROVAL_GATEWAY",
        "validation passed but hostd was started without an approval-gateway wiring; the operator build is missing the telegram-plugin link",
      )
        .fixOperatorAction("infra", [
          "ensure hostd was launched with --approval-gateway / telegram-plugin link",
        ])
        .op("config_propose_edit")
        .caller(caller.kind === "agent" ? "agent" : "operator")
        .agentName(caller.kind === "agent" ? caller.name : undefined)
        .build(req.request_id, Date.now() - started);
    }
    const callerName = caller.kind === "agent" ? caller.name : "operator";
    // ── Idempotency: collapse identical in-flight proposals ─────────
    // A re-fired identical proposal (same caller + same diff) must not
    // post a SECOND approval card or apply twice. Key by caller+diff
    // hash and share the in-flight promise so duplicate/concurrent
    // proposals converge on ONE card and EXACTLY ONE apply. This is
    // the invariant that survives the 2026-06-15 klanker debacle's
    // failure class: re-fires (then driven by a 10s wire timeout) had
    // stacked phantom cards and double-wrote a config entry.
    const dedupeKey = `${callerName}:${createHash("sha256")
      .update(req.args.unified_diff)
      .digest("hex")}`;
    const pending = this.inflightConfigProposals.get(dedupeKey);
    if (pending) {
      process.stderr.write(
        `hostd: config_propose_edit — collapsed identical in-flight proposal from ${callerName} (dedupe)\n`,
      );
      return await pending;
    }
    const run = this.runConfigProposeApprovalAndApply(
      req,
      caller,
      callerName,
      configPath,
      verdict.postApplyContent,
      started,
    );
    this.inflightConfigProposals.set(dedupeKey, run);
    try {
      return await run;
    } finally {
      this.inflightConfigProposals.delete(dedupeKey);
    }
  }

  /** In-flight config_propose_edit proposals, keyed by caller+diff hash. */
  private inflightConfigProposals = new Map<string, Promise<HostdResponse>>();

  /**
   * The approval-card + mutex-serialized apply phase of
   * `config_propose_edit`, split out so identical in-flight proposals
   * can be deduped onto a single shared promise (exactly-once apply).
   * Caller (`handleConfigProposeEdit`) has already validated the diff,
   * passed the self-scope gate, and confirmed the approval gateway is
   * wired.
   */
  private async runConfigProposeApprovalAndApply(
    req: Extract<HostdRequest, { op: "config_propose_edit" }>,
    caller: SocketIdentity,
    callerName: string,
    configPath: string,
    postApply: string,
    started: number,
  ): Promise<HostdResponse> {
    const approvalId = (this.opts.generateApprovalId ?? defaultApprovalId)();
    const approval = await this.opts.approvalGateway!.requestApproval({
      requestId: approvalId,
      agentName: callerName,
      reason: req.args.reason,
      unifiedDiff: req.args.unified_diff,
      timeoutMs: CONFIG_APPROVAL_TIMEOUT_MS,
    });
    if (approval.verdict === "deny") {
      // #1762: distinguish operator-tap deny from gateway-side
      // dispatch failure (card never reached the operator). Without
      // this, a Telegram sendMessage 400 surfaces as a misleading
      // "operator denied" — see ref #1758 structured-error work.
      // #1761: tap-deny is a POLICY DENIAL (result: "denied").
      // Dispatch-failure is INFRA (result: "error").
      const legacy = formatConfigApprovalDenyError(approval, approvalId);
      const isDispatchFailure = approval.denySource === "dispatch_failure";
      const code = isDispatchFailure
        ? "E_APPROVAL_DISPATCH_FAILED"
        : "E_DENIED";
      const human = isDispatchFailure
        ? "approval card dispatch failed before the operator could see it"
        : "operator denied config_propose_edit";
      const b = err(code, human)
        .why(legacy)
        .fixOperatorAction(
          isDispatchFailure ? "infra" : "policy_denied",
          isDispatchFailure
            ? ["check telegram-plugin gateway connectivity"]
            : undefined,
        )
        .op("config_propose_edit")
        .caller(caller.kind === "agent" ? "agent" : "operator")
        .agentName(caller.kind === "agent" ? caller.name : undefined);
      if (!isDispatchFailure) b.asDenied();
      const built = b.build(req.request_id, Date.now() - started);
      // Preserve the verbatim legacy `error` string (tests + existing
      // string-matching decoders depend on the exact format from
      // `formatConfigApprovalDenyError`).
      return { ...built, error: legacy };
    }
    if (approval.verdict === "timeout") {
      // #1761: timeout is a policy-path denial (operator never acted),
      // not a server failure.
      const legacy = `E_APPROVAL_TIMEOUT: operator approval card expired without a tap (approval_id=${approvalId})`;
      const built = err(
        "E_APPROVAL_TIMEOUT",
        "operator approval card expired without a tap",
      )
        .why(`approval_id=${approvalId}`)
        .fixOperatorAction("policy_denied")
        .op("config_propose_edit")
        .caller(caller.kind === "agent" ? "agent" : "operator")
        .agentName(caller.kind === "agent" ? caller.name : undefined)
        .asDenied()
        .build(req.request_id, Date.now() - started);
      return { ...built, error: legacy };
    }
    // ── Apply path (mutex-serialized) ───────────────────────────────
    // Serialize concurrent config-edit applies through a single
    // in-process promise chain. Hostd is the only writer of
    // switchroom.yaml; no cross-process flock is needed.
    const release = await this.acquireConfigApplyLock();
    try {
      // Snapshot the live config so we can rollback if reconcile
      // fails. Read synchronously — the lock is held, no one else
      // is touching the file.
      let snapshot: string;
      try {
        snapshot = readFileSync(configPath, "utf-8");
      } catch (e) {
        await approval.finalize({
          outcome: "reconcile_failed_rolled_back",
          detail: `pre-write snapshot read failed: ${(e as Error).message}`,
        });
        // #1761: real infrastructure failure during rollback path.
        return this.reconcileFailedRolledBack(
          `snapshot read failed: ${(e as Error).message}`,
          req,
          caller,
          started,
        );
      }
      // In-place write preserving the inode (bind-mount safe). The old
      // `<path>.tmp` → rename() swap returned EBUSY here because
      // switchroom.yaml is itself a read-only bind-mount source mounted
      // into every agent container — see writeFileInPlacePreservingInode.
      try {
        writeFileInPlacePreservingInode(configPath, postApply);
      } catch (e) {
        // Write failed before any bytes were flushed, OR mid-write. We
        // hold the snapshot, so restore it in place to be safe rather
        // than assume the live file is untouched.
        try {
          writeFileInPlacePreservingInode(configPath, snapshot);
        } catch {
          /* best-effort restore; original error is the one that matters */
        }
        await approval.finalize({
          outcome: "reconcile_failed_rolled_back",
          detail: `in-place write failed: ${(e as Error).message}`,
        });
        return this.reconcileFailedRolledBack(
          `write failed: ${(e as Error).message}`,
          req,
          caller,
          started,
        );
      }
      // Reconcile.
      const runner =
        this.opts.runReconcile ??
        (async () => this.runSwitchroom(["apply"]));
      const recRes = await runner({ requestId: approvalId });
      if (recRes.exit_code === 0) {
        // Tell the operator which agents must restart for this edit to go
        // live (claude loads config at boot — an applied edit is inert until
        // restart). Fails safe to fleet-wide on any ambiguity.
        const blast = classifyBlastRadius(snapshot, postApply);
        await approval.finalize({
          outcome: "applied",
          affectedAgents: blast.agents,
          fleetWide: blast.fleetWide,
        });
        return {
          v: 1,
          request_id: req.request_id,
          result: "completed",
          exit_code: 0,
          duration_ms: Date.now() - started,
          stdout_tail: tail(recRes.stdout),
          stderr_tail: tail(recRes.stderr),
        };
      }
      // ── Reconcile failed → rollback to snapshot, re-run reconcile.
      // Same in-place write (not rename) so the rollback path is also
      // bind-mount safe.
      let rollbackDetail = "";
      try {
        writeFileInPlacePreservingInode(configPath, snapshot);
      } catch (e) {
        rollbackDetail = `snapshot restore failed: ${(e as Error).message}`;
        await approval.finalize({
          outcome: "reconcile_failed_rolled_back",
          detail: rollbackDetail,
        });
        return this.reconcileFailedRolledBack(
          rollbackDetail,
          req,
          caller,
          started,
        );
      }
      const recRes2 = await runner({ requestId: approvalId });
      const recoveryNote =
        recRes2.exit_code === 0
          ? "rolled back successfully"
          : `rolled back but recovery reconcile also failed (exit ${recRes2.exit_code})`;
      await approval.finalize({
        outcome: "reconcile_failed_rolled_back",
        detail: recoveryNote,
      });
      return this.reconcileFailedRolledBack(
        `reconcile exit ${recRes.exit_code}; ${recoveryNote}`,
        req,
        caller,
        started,
      );
    } finally {
      release();
    }
  }

  /**
   * #1761: shared helper for the five sites that bail out of
   * `handleConfigProposeEdit` with `E_RECONCILE_FAILED_ROLLED_BACK`.
   * Carries a structured `operator_action`/`infra` envelope (the
   * agent can't self-recover from a write/reconcile failure) while
   * preserving the verbatim legacy `error` string so audit-reader /
   * existing string-match decoders see no regression.
   */
  private reconcileFailedRolledBack(
    detail: string,
    req: Extract<HostdRequest, { op: "config_propose_edit" }>,
    caller: SocketIdentity,
    started: number,
  ): HostdResponse {
    const legacy = `E_RECONCILE_FAILED_ROLLED_BACK: ${detail}`;
    const built = err(
      "E_RECONCILE_FAILED_ROLLED_BACK",
      "config write or reconcile failed; live file rolled back to snapshot",
    )
      .why(detail)
      .fixOperatorAction("infra", [
        "inspect hostd logs + switchroom apply output to identify the underlying failure",
      ])
      .op("config_propose_edit")
      .caller(caller.kind === "agent" ? "agent" : "operator")
      .agentName(caller.kind === "agent" ? caller.name : undefined)
      .build(req.request_id, Date.now() - started);
    return { ...built, error: legacy };
  }

  /** Serializes concurrent config_propose_edit apply phases. */
  private configApplyLock: Promise<void> = Promise.resolve();
  private async acquireConfigApplyLock(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((r) => { release = r; });
    const prior = this.configApplyLock;
    this.configApplyLock = prior.then(() => next);
    await prior;
    return release;
  }

  private async handleAgentSmoke(
    req: Extract<HostdRequest, { op: "agent_smoke" }>,
    started: number,
  ): Promise<HostdResponse> {
    // req.args.name is AgentNameSchema-validated at decode and passed
    // as its own argv element; docker exec stops parsing its options
    // at CONTAINER so nothing after it is read as a docker flag.
    const container = `switchroom-${req.args.name}`;
    type Probe = { name: string; state: "ok" | "fail" | "skip"; detail: string };
    const respond = (
      containerState: "running" | "absent",
      probes: Probe[],
    ): HostdResponse => ({
      v: 1,
      request_id: req.request_id,
      result: "completed",
      exit_code: probes.some((p) => p.state === "fail") ? 1 : 0,
      duration_ms: Date.now() - started,
      stdout_tail: tail(
        JSON.stringify({
          container: containerState,
          deep: !!req.args.deep,
          probes,
        }),
      ),
    });

    let running = false;
    try {
      const insp = await this.runDocker([
        "inspect",
        "-f",
        "{{.State.Running}}",
        container,
      ]);
      running = insp.exit_code === 0 && insp.stdout.trim() === "true";
    } catch {
      running = false;
    }

    const PROBES: { name: string; cmd: string }[] = [
      {
        name: "auth",
        // The agent's claude state dir is /state/agent/.claude — NOT
        // $HOME/.claude (HOME=/state/agent/home) and CLAUDE_CONFIG_DIR
        // is unset in-container. Verified live: the OAuth credential
        // is /state/agent/.claude/.credentials.json. Probing the
        // $HOME/$CLAUDE_CONFIG_DIR paths gave a false "auth FAIL" for
        // every (healthy, Telegram-serving) agent. Match the other
        // probes, which already key off /state/agent.
        cmd: "test -s /state/agent/.claude/.credentials.json",
      },
      {
        name: "scheduler",
        cmd: "grep -q '_switchroom_supervise.*agent-scheduler' /state/agent/start.sh && pgrep -f agent-scheduler >/dev/null",
      },
      {
        name: "mcp",
        cmd: "python3 -m json.tool /state/agent/.mcp.json >/dev/null 2>&1",
      },
      {
        // grep -q emits NOTHING on stdout — only an exit code, so the
        // token value never leaves the container.
        name: "bot_token",
        cmd: "test -f /state/agent/telegram/.env && grep -qE '^TELEGRAM_BOT_TOKEN=[0-9]+:' /state/agent/telegram/.env",
      },
      { name: "state", cmd: "test -w /state/agent" },
    ];
    if (req.args.deep) {
      // Token-introspect probe: parse .credentials.json in-container and
      // verify the OAuth access token is present (correct format) and
      // non-expired. No model call — no programmatic usage. Replaces the
      // former `claude -p ok` check which was a compliance violation under
      // Anthropic's 2026-06-15 policy (programmatic usage, off subscription).
      // Closes #1798.
      PROBES.push({
        name: "auth_live",
        // python3 is already used by the `mcp` probe above so it is
        // guaranteed available. The script exits 0 only when:
        //   1. .credentials.json exists and is valid JSON
        //   2. claudeAiOauth.accessToken matches sk-ant-oat\d+- prefix
        //   3. claudeAiOauth.expiresAt is absent OR in the future (ms epoch)
        // Single-quoted around the python body so shell passes it verbatim.
        // Nothing is printed — exit code is the only signal; no token value
        // can leak into the hostd response or operator audit log.
        cmd:
          "python3 -c 'import json,sys,time,re;" +
          'c=json.load(open("/state/agent/.claude/.credentials.json"));' +
          'o=c.get("claudeAiOauth",{});' +
          't=o.get("accessToken","");' +
          'sys.exit(0 if re.match(r"sk-ant-oat\\d+-",t)' +
          ' and ("expiresAt" not in o or o["expiresAt"]>time.time()*1000)' +
          " else 1)'",
      });
    }

    if (!running) {
      return respond(
        "absent",
        PROBES.map((p) => ({
          name: p.name,
          state: "skip" as const,
          detail: `container ${container} is not running — use agent_start`,
        })),
      );
    }

    const probes: Probe[] = await Promise.all(
      PROBES.map(async (p): Promise<Probe> => {
        try {
          // No `--`: docker exec stops option-parsing at CONTAINER
          // (see handleAgentExec) — a literal `--` is exec'd as the
          // command → exit 127. p.cmd is a fixed literal anyway.
          const r = await this.runDocker([
            "exec",
            container,
            "sh",
            "-lc",
            p.cmd,
          ]);
          return {
            name: p.name,
            state: r.exit_code === 0 ? "ok" : "fail",
            // NEVER include r.stdout: probes are exit-code only so a
            // secret can't leak into the operator/audit surface.
            detail: r.exit_code === 0 ? "ok" : `exit ${r.exit_code}`,
          };
        } catch (err) {
          // docker binary missing / exec spawn error → not a health
          // signal about the agent. Skip, never fail.
          return {
            name: p.name,
            state: "skip",
            detail: `probe could not run: ${(err as Error).message}`,
          };
        }
      }),
    );
    return respond("running", probes);
  }

  /**
   * Read-only fleet (or single-agent) docker status — uptime + memory +
   * active. The whole point: hostd HAS the docker socket, so
   * `getAllAgentStatuses` (which shells `docker inspect`/`docker stats`)
   * works here, where it throws/returns-null in the dockerless web
   * container. Result is JSON-encoded into `payload` as `{ statuses }`.
   *
   * Always `completed` when the config loads and the status sweep runs
   * (a down/absent container is a *finding* in the per-agent status, not
   * a verb failure — same posture as doctor). A genuine fault (config
   * unreadable, status sweep throws) returns `error` with a message;
   * never crashes the daemon.
   */
  private handleAgentStatus(
    req: Extract<HostdRequest, { op: "agent_status" }>,
    started: number,
  ): HostdResponse {
    try {
      const cfg = loadConfig(this.opts.configPath);
      const all = getAllAgentStatuses(cfg);
      const statuses = req.args.name
        ? req.args.name in all
          ? { [req.args.name]: all[req.args.name]! }
          : {}
        : all;
      return {
        v: 1,
        request_id: req.request_id,
        result: "completed",
        exit_code: 0,
        duration_ms: Date.now() - started,
        payload: JSON.stringify({ statuses }),
      };
    } catch (e) {
      return {
        v: 1,
        request_id: req.request_id,
        result: "error",
        exit_code: null,
        duration_ms: Date.now() - started,
        error: `agent_status failed: ${(e as Error).message}`,
      };
    }
  }

  /**
   * Read-only cron schedule view — the cascade-resolved schedule entries
   * PLUS the most-recent fires per agent. Loads config FRESH (not the
   * daemon's cached startup config): `loadConfig` merges each agent's
   * `~/.switchroom/agents/<name>/schedule.d/*.yaml` overlays, and those
   * files are 0600 owned by the agent's container UID — readable here
   * (hostd runs as root with DAC_OVERRIDE) but EACCES from the
   * operator/web vantage. That overlay-merge is exactly why this lands
   * the agent-authored crons the dashboard otherwise misses.
   *
   * Result is JSON-encoded into `payload` as `{ entries, recentByAgent }`,
   * BOUNDED by {@link boundScheduleView} (prompt ≤160 chars, each fire's
   * outputSummary ≤100 chars, last 8 fires/agent) so the frame stays
   * under the 64 KiB cap even for a large fleet with long prompts.
   */
  private handleAgentSchedule(
    req: Extract<HostdRequest, { op: "agent_schedule" }>,
    started: number,
  ): HostdResponse {
    try {
      const cfg = loadConfig(this.opts.configPath);
      let entries = collectScheduleEntries(cfg);
      if (req.args.name) entries = entries.filter((e) => e.agent === req.args.name);
      const agentsDir = resolveAgentsDir(cfg);
      const recentByAgent: Record<string, DispatchResult[]> = {};
      for (const agent of new Set(entries.map((e) => e.agent))) {
        const rows = readRecentFires(resolve(agentsDir, agent, "scheduler.jsonl"));
        if (rows.length > 0) recentByAgent[agent] = rows;
      }
      const bounded = boundScheduleView(entries, recentByAgent);
      return {
        v: 1,
        request_id: req.request_id,
        result: "completed",
        exit_code: 0,
        duration_ms: Date.now() - started,
        payload: JSON.stringify(bounded),
      };
    } catch (e) {
      return {
        v: 1,
        request_id: req.request_id,
        result: "error",
        exit_code: null,
        duration_ms: Date.now() - started,
        error: `agent_schedule failed: ${(e as Error).message}`,
      };
    }
  }

  /** Spawn the host `docker` CLI and capture stdout/stderr. Symmetric
   *  with {@link runSwitchroom}; broken out for testability + so
   *  failures get a "docker binary missing" surface separate from
   *  switchroom CLI failures. */
  private runDocker(
    args: string[],
  ): Promise<{ exit_code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const bin = this.opts.dockerBin ?? "docker";
      const child = spawn(bin, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => {
        stdout += d.toString("utf8");
      });
      child.stderr.on("data", (d: Buffer) => {
        stderr += d.toString("utf8");
      });
      child.on("error", (err) => reject(err));
      child.on("close", (code) =>
        resolve({ exit_code: code ?? -1, stdout, stderr }),
      );
    });
  }

  /**
   * Acquire the fleet-mutation lock. If something else is already
   * holding it, return a `denied` response naming the in-flight
   * request so the caller can `get_status` it instead of waiting.
   * Idempotency-key dedupe already happened upstream — by the time
   * we reach this check, we know this isn't a retry of the
   * in-flight call.
   */
  /**
   * Enumerate the docker image refs the digest resolver should look up.
   * In production, shells out to `docker compose config --images` so
   * the resolver targets exactly the images the running compose file
   * references. Returns [] on any failure — the resolver itself is
   * fail-soft so missing input degrades to an empty digest map.
   *
   * Tests override via the `imageRefsForDigests` opt.
   */
  private imageRefsForDigestCapture(): string[] {
    if (this.opts.imageRefsForDigests) return this.opts.imageRefsForDigests();
    try {
      const composePath = join(
        this.opts.bindRoot ?? this.opts.homeDir,
        ".switchroom",
        "compose",
        "docker-compose.yml",
      );
      if (!existsSync(composePath)) return [];
      const r = spawnSync(
        "docker",
        [
          "compose",
          "-p",
          "switchroom",
          "-f",
          composePath,
          "config",
          "--images",
        ],
        { encoding: "utf-8", timeout: 5000 },
      );
      if (r.status !== 0) return [];
      return (r.stdout ?? "")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
    } catch {
      return [];
    }
  }

  private checkFleetMutationLock(
    op: "update_apply" | "apply" | "rollout",
    request_id: string,
    started: number,
  ): HostdResponse | null {
    const inFlight = this.fleetMutationInFlight;
    if (!inFlight) return null;
    const ageMs = Date.now() - inFlight.started_at;
    return deniedResponse(
      request_id,
      `${op}: fleet-mutation lock held by ${inFlight.op} ` +
        `(request_id "${inFlight.request_id}", running ${Math.floor(ageMs / 1000)}s). ` +
        `Wait for it to complete (poll get_status with target_request_id="${inFlight.request_id}") ` +
        `before issuing another fleet mutation.`,
      Date.now() - started,
    );
  }

  /** Shared fire-and-forget spawn used by update_apply + apply.
   *  Updates the status entry on completion AND releases the
   *  fleet-mutation lock (success or fail). */
  private spawnFleetMutation(
    op: "update_apply" | "apply" | "rollout",
    args: string[],
    entry: StatusEntry,
    extraEnv?: Record<string, string>,
  ): void {
    this.runSwitchroom(args, extraEnv)
      .then((res) => {
        entry.result = res.exit_code === 0 ? "completed" : "error";
        entry.exit_code = res.exit_code;
        entry.finished_at = Date.now();
        entry.stdout_tail = tail(res.stdout);
        entry.stderr_tail = tail(res.stderr);
        // Parse the deferral sentinel emitted by the update driver when
        // one or more steps were deferred due to hostd-context (#2458).
        // Only relevant for update_apply (apply/rollout don't emit it), but
        // parseUpdateResultLine is a no-op / returns null on absent sentinel.
        if (op === "update_apply") {
          const parsed = parseUpdateResultLine(res.stdout);
          if (parsed && parsed.deferred.length > 0) {
            entry.deferred = parsed.deferred;
          }
        }
      })
      .catch((err) => {
        entry.result = "error";
        entry.exit_code = null;
        entry.finished_at = Date.now();
        entry.error = (err as Error).message;
      })
      .finally(() => {
        // Durable terminal row. Fire-and-forget: the append is async
        // and NOT awaited here, so the lock releases before the row
        // hits disk — acceptable because (a) the synchronous `started`
        // row already records that the mutation was attempted, and
        // (b) appendAuditRow is best-effort by contract. If hostd is
        // SIGKILLed in the sub-millisecond window between this call
        // and the write landing, we lose only the terminal row, not
        // the fact-of-attempt. writeTerminalAudit never throws
        // (appendAuditRow swallows), so it's safe un-awaited here.
        void this.writeTerminalAudit(entry);
        // Release the lock IF we're still the one holding it. A test
        // (or a future code path) that reset the daemon's state
        // mid-call shouldn't have its replacement lock clobbered.
        if (
          this.fleetMutationInFlight &&
          this.fleetMutationInFlight.request_id === entry.request_id
        ) {
          this.fleetMutationInFlight = null;
        }
      });
  }

  /**
   * Fire-and-forget spawn for `rollout` (#2487). Distinct from
   * spawnFleetMutation: it injects the `SWITCHROOM_HOSTD_CONTEXT=1`
   * sentinel into the child env and parses the child's STRUCTURED result
   * sentinel off stdout into the status entry's `rolled[]` / `failed_step`
   * / `failed_agent` fields — instead of relying on a flattened stdout
   * tail. Releases the fleet-mutation lock on completion (success/fail).
   */
  private spawnRollout(args: string[], entry: StatusEntry): void {
    this.runSwitchroom(args, { SWITCHROOM_HOSTD_CONTEXT: "1" })
      .then((res) => {
        entry.exit_code = res.exit_code;
        entry.finished_at = Date.now();
        entry.stdout_tail = tail(res.stdout);
        entry.stderr_tail = tail(res.stderr);
        const parsed = parseRolloutResultLine(res.stdout);
        if (parsed) {
          entry.rolled = parsed.rolled;
          if (parsed.failedStep) entry.failed_step = parsed.failedStep;
          if (parsed.failedAgent) entry.failed_agent = parsed.failedAgent;
          // BONUS (#2458 got-field gap): the sentinel carries `got` (the
          // actual version detected on the failed agent, or null when
          // unreachable). Preserve it so get_status readers can surface the
          // mismatch without scraping stdout.
          if (parsed.got !== undefined) entry.got = parsed.got;
          // Structured `ok` is the authority; exit code corroborates.
          entry.result = parsed.ok ? "completed" : "error";
        } else {
          // No sentinel — the child died before finishing (e.g. SIGKILL).
          // Fall back to the exit code; structured fields stay unset so a
          // reader can tell the outcome wasn't cleanly captured.
          entry.result = res.exit_code === 0 ? "completed" : "error";
        }
      })
      .catch((err) => {
        entry.result = "error";
        entry.exit_code = null;
        entry.finished_at = Date.now();
        entry.error = (err as Error).message;
      })
      .finally(() => {
        void this.writeTerminalAudit(entry);
        if (
          this.fleetMutationInFlight &&
          this.fleetMutationInFlight.request_id === entry.request_id
        ) {
          this.fleetMutationInFlight = null;
        }
      });
  }

  private handleGetStatus(
    req: Extract<HostdRequest, { op: "get_status" }>,
    _caller: SocketIdentity,
    started: number,
  ): HostdResponse {
    const entry = this.statusByRequestId.get(req.args.target_request_id);
    // checkGate already rejected unknown / cross-agent cases above.
    // If we got here `entry` must exist.
    if (!entry) {
      // #1761: internal invariant violation — no fix.kind applies.
      const legacy = `get_status: internal: entry missing despite gate accept`;
      const built = err("E_INTERNAL", "entry missing despite gate accept")
        .op("get_status")
        .build(req.request_id, Date.now() - started);
      return { ...built, error: legacy };
    }
    return this.statusEntryToResponse(req.request_id, entry);
  }

  private statusEntryToResponse(
    request_id: string,
    entry: StatusEntry,
  ): HostdResponse {
    // Rollout (#2487) surfaces its STRUCTURED outcome via `payload` so a
    // get_status reader gets rolled[]/failedStep/failedAgent as data, not
    // a stdout-tail it has to grep. Only emitted on rollout entries that
    // actually captured structured fields.
    const rolloutPayload =
      entry.op === "rollout" &&
      (entry.rolled !== undefined ||
        entry.failed_step !== undefined ||
        entry.failed_agent !== undefined)
        ? JSON.stringify({
            rolled: entry.rolled ?? [],
            ...(entry.failed_step ? { failedStep: entry.failed_step } : {}),
            ...(entry.failed_agent ? { failedAgent: entry.failed_agent } : {}),
            // BONUS (#2458 got-field gap): include `got` when present.
            ...(entry.got !== undefined ? { got: entry.got } : {}),
            ...(entry.pin ? { pin: entry.pin } : {}),
          })
        : undefined;
    // Update-apply (#2458) payload: deferred steps + channel/pin enrichment.
    const updatePayload: Record<string, unknown> | null =
      entry.op === "update_apply" &&
      (entry.deferred !== undefined ||
        entry.channel !== undefined ||
        entry.pin !== undefined)
        ? {
            ...(entry.deferred !== undefined ? { deferred: entry.deferred } : {}),
            ...(entry.pin !== undefined ? { pin: entry.pin } : {}),
            ...(entry.channel !== undefined ? { channel: entry.channel } : {}),
          }
        : null;
    return {
      v: 1,
      request_id,
      result: entry.result,
      exit_code: entry.exit_code,
      duration_ms: (entry.finished_at ?? Date.now()) - entry.started_at,
      stdout_tail: entry.stdout_tail || undefined,
      stderr_tail: entry.stderr_tail || undefined,
      ...(rolloutPayload ? { payload: rolloutPayload } : {}),
      ...(updatePayload ? { payload: JSON.stringify(updatePayload) } : {}),
      error: entry.error,
    };
  }

  private recordStatus(entry: StatusEntry): void {
    this.statusByRequestId.set(entry.request_id, entry);
    // Evict oldest if over cap.
    if (this.statusByRequestId.size > STATUS_MAX_ENTRIES) {
      const oldest = [...this.statusByRequestId.values()].sort(
        (a, b) => a.started_at - b.started_at,
      )[0];
      if (oldest) this.statusByRequestId.delete(oldest.request_id);
    }
    // Lazy expiration sweep — every insert.
    const cutoff = Date.now() - STATUS_RETENTION_MS;
    for (const [id, e] of this.statusByRequestId) {
      if (e.started_at < cutoff) this.statusByRequestId.delete(id);
    }
  }

  private evictExpiredIdempotency(now: number): void {
    for (const [k, v] of this.idempotencyKeys) {
      if (now - v.ts >= IDEMPOTENCY_WINDOW_MS) this.idempotencyKeys.delete(k);
    }
  }

  private auditLogPath(): string {
    return (
      this.opts.auditLogPath ??
      join(this.opts.homeDir, ".switchroom", "host-control-audit.log")
    );
  }

  /** Append one JSONL row. Best-effort: a failed append logs to
   *  stderr but never throws into the request path. Serialized via
   *  `auditAppendChain` so large rows can't interleave. */
  private appendAuditRow(row: Record<string, unknown>): Promise<void> {
    const path = this.auditLogPath();
    this.auditAppendChain = this.auditAppendChain.then(async () => {
      await mkdir(dirname(path), { recursive: true }).catch(() => undefined);
      // Seed + chain INSIDE the serialized section so seq/prev are
      // computed against the latest durably-written row, never a stale
      // enqueue-time snapshot. State advances only after the append
      // resolves — a failed write can't desync the chain from disk.
      if (this.auditChainState === undefined) {
        this.auditChainState = seedChain(path);
      }
      const { line, next } = chainRow(this.auditChainState, row);
      try {
        await appendFile(path, line);
        this.auditChainState = next;
      } catch (err) {
        process.stderr.write(
          `hostd: audit append failed: ${(err as Error).message}\n`,
        );
      }
    });
    return this.auditAppendChain;
  }

  private async writeAudit(args: {
    caller: SocketIdentity;
    req: HostdRequest;
    resp: HostdResponse;
  }): Promise<void> {
    await this.appendAuditRow({
      ts: new Date().toISOString(),
      op: args.req.op,
      caller:
        args.caller.kind === "agent"
          ? { kind: "agent", name: args.caller.name }
          : { kind: "operator" },
      request_id: args.req.request_id,
      result: args.resp.result,
      exit_code: args.resp.exit_code,
      duration_ms: args.resp.duration_ms,
      // NOTE: the generic request-path row deliberately does NOT
      // persist stdout_tail/stderr_tail. `agent_exec` (allowlist
      // includes `cat`) and `agent_logs` flow through here — an admin
      // running `agent_exec cat .../credentials.json` would otherwise
      // write a peer's OAuth token into a file admin agents can read
      // :ro. The audit log is the *detection* surface, not the secret
      // payload (PR #1215 reviewer invariant). Output-tail persistence
      // is scoped to the fleet-mutation terminal path only — see
      // writeTerminalAudit, where update_apply/apply are the only ops
      // and the tails are redacted before they hit disk.
      error: args.resp.error,
    });
  }

  /** Durable terminal-outcome row for an async fleet mutation
   *  (update_apply / apply ONLY — those are the sole ops that call
   *  spawnFleetMutation). Written directly from the spawn completion
   *  handler so the record does NOT depend on a get_status poll
   *  happening to land after the subprocess exits and before the next
   *  hostd recreate. `phase: "terminal"` distinguishes it from the
   *  synchronous `started` row the request path already wrote for the
   *  same request_id.
   *
   *  Secret posture: `switchroom update`/`apply` provision per-agent
   *  `.env` / vault material, so a stack trace dumping a config object
   *  could land secrets in the 4 KiB tail. We run stdout/stderr/error
   *  through the vendored synchronous `redact()` (the same scrubber
   *  the PreToolUse secret hook uses) BEFORE persisting. This is the
   *  load-bearing mitigation — NOT file perms: the audit log is bind-
   *  mounted :ro into admin agents (RFC C #1337) and MUST stay world-
   *  readable for `/audit hostd` to work, exactly like vault-audit.log
   *  (apply.ts pins it 0644 for the same reason). Tightening to 0600
   *  would break the feature; redaction + the writeAudit scoping above
   *  are what keep secrets out of the file. */
  private async writeTerminalAudit(entry: StatusEntry): Promise<void> {
    const stdoutTail = entry.stdout_tail ? redact(entry.stdout_tail) : "";
    const stderrTail = entry.stderr_tail ? redact(entry.stderr_tail) : "";
    const errMsg = entry.error ? redact(entry.error) : "";
    await this.appendAuditRow({
      ts: new Date().toISOString(),
      op: entry.op,
      phase: "terminal",
      caller:
        entry.caller.kind === "agent"
          ? { kind: "agent", name: entry.caller.name }
          : { kind: "operator" },
      request_id: entry.request_id,
      result: entry.result,
      exit_code: entry.exit_code,
      duration_ms: (entry.finished_at ?? Date.now()) - entry.started_at,
      ...(stdoutTail ? { stdout_tail: stdoutTail } : {}),
      ...(stderrTail ? { stderr_tail: stderrTail } : {}),
      ...(errMsg ? { error: errMsg } : {}),
      // Update-flow enrichment fields (only present on update_apply
      // entries; spread-omit keeps them off other ops' rows).
      ...(entry.channel ? { channel: entry.channel } : {}),
      ...(entry.pin ? { pin: entry.pin } : {}),
      ...(entry.resolved_sha ? { resolved_sha: entry.resolved_sha } : {}),
      ...(entry.install_context ? { install_context: entry.install_context } : {}),
      // Rollout structured result (#2487) — only present on rollout rows.
      ...(entry.rolled ? { rolled: entry.rolled } : {}),
      ...(entry.failed_step ? { failed_step: entry.failed_step } : {}),
      ...(entry.failed_agent ? { failed_agent: entry.failed_agent } : {}),
      // BONUS (#2458 got-field gap): version detected on failed agent.
      ...(entry.got !== undefined ? { got: entry.got } : {}),
      // Update-apply deferral result (#2458) — only on update_apply rows.
      ...(entry.deferred ? { deferred: entry.deferred } : {}),
    });
  }

  /** Spawn the host switchroom CLI and capture stdout/stderr. An
   *  optional `extraEnv` is merged onto the inherited env — used by the
   *  rollout path to flip the in-container `SWITCHROOM_HOSTD_CONTEXT`
   *  sentinel (#2487). */
  private runSwitchroom(
    args: string[],
    extraEnv?: Record<string, string>,
  ): Promise<{ exit_code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const bin = this.opts.switchroomBin ?? "switchroom";
      const child = spawn(bin, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...(extraEnv ?? {}) },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => {
        stdout += d.toString("utf8");
      });
      child.stderr.on("data", (d: Buffer) => {
        stderr += d.toString("utf8");
      });
      child.on("error", (err) => reject(err));
      child.on("close", (code) =>
        resolve({ exit_code: code ?? -1, stdout, stderr }),
      );
    });
  }
}

function tail(s: string, bytes = TAIL_BYTES): string {
  if (Buffer.byteLength(s, "utf8") <= bytes) return s;
  return s.slice(s.length - bytes);
}

/** Max chars retained from a schedule entry's `prompt` in the bounded
 *  `agent_schedule` payload — the web only renders a preview. */
export const SCHEDULE_PROMPT_MAX_CHARS = 160;
/** Max chars retained from a fire's `outputSummary` in the bounded payload. */
export const SCHEDULE_OUTPUT_SUMMARY_MAX_CHARS = 100;
/**
 * Max recent fires retained PER CRON (keyed by promptKey) in the bounded
 * payload. The dashboard renders each cron's OWN fire history, so fires are
 * bounded per-cron — a busy cron must not crowd a quiet one out of the
 * agent's window (the old per-agent cap did exactly that). The frame budget
 * below is the absolute backstop for an agent with pathologically many crons.
 */
export const SCHEDULE_MAX_FIRES_PER_CRON = 8;
/**
 * Hard ceiling on the bytes the `agent_schedule` payload contributes to the
 * response FRAME. The payload is JSON-encoded then embedded as a STRING in
 * the response, so its frame cost = `JSON.stringify(JSON.stringify(view))`
 * length (escaping accounted for exactly). We trim until that's under
 * `MAX_FRAME_BYTES` minus envelope headroom — so `encodeResponse` can never
 * throw "frame too large", even for a pathological fleet.
 */
export const SCHEDULE_FRAME_BUDGET_BYTES = MAX_FRAME_BYTES - 2048;

export interface BoundedScheduleView {
  entries: SchedulerEntry[];
  recentByAgent: Record<string, DispatchResult[]>;
  /** True when entries/fires were shed to fit the frame budget. */
  truncated?: boolean;
}

/**
 * Render-only projection of a SchedulerEntry. Keeps only the fields the
 * dashboard renders (+ the small cheap-cron routing scalars) and DROPS the
 * UNBOUNDED `poll` / `action` specs (a Telegram action's `text`, a webhook
 * body/headers/url have no schema max). Truncates the prompt. This is what
 * makes a single entry's encoded size bounded by the prompt cap, not by
 * arbitrary operator-authored spec content.
 */
function slimScheduleEntry(e: SchedulerEntry): SchedulerEntry {
  const slim: SchedulerEntry = {
    agent: e.agent,
    scheduleIndex: e.scheduleIndex,
    cron: e.cron,
    promptKey: e.promptKey,
  };
  // The cron's human title (overlay `# name:` header) — a small string,
  // and the per-cron block header the dashboard renders, so keep it.
  if (e.name !== undefined) slim.name = e.name;
  if (e.prompt !== undefined) {
    slim.prompt =
      e.prompt.length > SCHEDULE_PROMPT_MAX_CHARS
        ? e.prompt.slice(0, SCHEDULE_PROMPT_MAX_CHARS)
        : e.prompt;
  }
  if (e.kind !== undefined) slim.kind = e.kind;
  if (e.model !== undefined) slim.model = e.model;
  if (e.context !== undefined) slim.context = e.context;
  if (e.topic !== undefined) slim.topic = e.topic;
  // poll / action specs intentionally dropped — unbounded + unrendered.
  return slim;
}

/** Exact frame cost of a payload object: its JSON encoded, then re-encoded
 *  as the response's `payload` STRING field (so quote/backslash escaping is
 *  counted precisely — no 2× guesswork). */
function scheduleFrameBytes(view: BoundedScheduleView): number {
  return Buffer.byteLength(JSON.stringify(JSON.stringify(view)), "utf8");
}

/**
 * Pure, frame-bounding shaper for the `agent_schedule` payload (extracted so
 * it can be unit-tested without a daemon). It (a) projects each entry to a
 * render-only slim shape (dropping the unbounded poll/action specs) with a
 * truncated prompt, (b) keeps only the LAST
 * {@link SCHEDULE_MAX_FIRES_PER_CRON} fires PER CRON (by promptKey, newest)
 * with each `outputSummary` truncated, and (c) enforces a HARD frame budget: if the
 * payload would still exceed {@link SCHEDULE_FRAME_BUDGET_BYTES} (a
 * pathological fleet — hundreds of entries), it sheds the least-essential
 * data first (all fires, then entries from the tail) until it fits, setting
 * `truncated`. This guarantees the response frame can never overflow
 * `MAX_FRAME_BYTES`. Returns NEW objects — never mutates the inputs.
 */
export function boundScheduleView(
  entries: SchedulerEntry[],
  recentByAgent: Record<string, DispatchResult[]>,
): BoundedScheduleView {
  const slimEntries = entries.map(slimScheduleEntry);
  const truncSummary = (r: DispatchResult): DispatchResult =>
    typeof r.outputSummary === "string" &&
    r.outputSummary.length > SCHEDULE_OUTPUT_SUMMARY_MAX_CHARS
      ? { ...r, outputSummary: r.outputSummary.slice(0, SCHEDULE_OUTPUT_SUMMARY_MAX_CHARS) }
      : { ...r };
  // The promptKeys of the CURRENT crons, per agent. Fires whose promptKey
  // isn't a current cron are dropped — they're obsolete (a cron's prompt was
  // edited → new key) and the dashboard, which matches fires to a cron by
  // promptKey, would never render them anyway. Critically this also BOUNDS
  // the payload to (current crons × N): a long-lived agent accumulates fires
  // for many obsolete keys (e.g. 21 keys / 2638 fires), and keeping 8 of EACH
  // blew the frame budget → the trim shed ALL fires. Bounding to current crons
  // keeps it small.
  const currentKeysByAgent = new Map<string, Set<string>>();
  for (const e of entries) {
    let s = currentKeysByAgent.get(e.agent);
    if (!s) { s = new Set<string>(); currentKeysByAgent.set(e.agent, s); }
    s.add(e.promptKey);
  }
  const boundedRecent: Record<string, DispatchResult[]> = {};
  for (const [agent, rows] of Object.entries(recentByAgent)) {
    const currentKeys = currentKeysByAgent.get(agent) ?? new Set<string>();
    // Bound fires PER CRON (promptKey), not per agent — the dashboard renders
    // each cron's own fire history, so keep the last N of EACH current cron.
    // Group preserving input (chronological) order, keep the newest N per key.
    const byKey = new Map<string, DispatchResult[]>();
    for (const r of rows) {
      if (!currentKeys.has(r.promptKey)) continue; // drop obsolete-cron fires
      const arr = byKey.get(r.promptKey);
      if (arr) arr.push(r);
      else byKey.set(r.promptKey, [r]);
    }
    const kept: DispatchResult[] = [];
    for (const arr of byKey.values()) {
      for (const r of arr.slice(-SCHEDULE_MAX_FIRES_PER_CRON)) kept.push(truncSummary(r));
    }
    if (kept.length > 0) boundedRecent[agent] = kept;
  }

  let view: BoundedScheduleView = { entries: slimEntries, recentByAgent: boundedRecent };
  if (scheduleFrameBytes(view) <= SCHEDULE_FRAME_BUDGET_BYTES) return view;

  // Over budget. Shed fires first (supplementary), then trim entries from
  // the tail until it fits. Entries are the point; fires are a bonus.
  view = { entries: slimEntries, recentByAgent: {}, truncated: true };
  while (scheduleFrameBytes(view) > SCHEDULE_FRAME_BUDGET_BYTES && view.entries.length > 1) {
    const keep = Math.max(1, Math.floor(view.entries.length * 0.8));
    view = { entries: view.entries.slice(0, keep), recentByAgent: {}, truncated: true };
  }
  return view;
}

/**
 * argv[0] commands the daemon will run via `docker exec` against a
 * peer container without an approval-kernel grant. Curated to a small
 * set of obviously-side-effect-free POSIX inspection tools. Anything
 * that writes, mounts, kills, reboots, or modifies the network stack
 * stays off this list.
 *
 * **Trust model.** Admin-flagged agents can already restart any peer
 * (`agent_restart`), stop any peer (`agent_stop`), and recreate every
 * container in the fleet (`update_apply`). Granting them peer-container
 * READ via this allowlist is consistent with that posture: admin: true
 * is the operator's standing proxy. The CLAUDE.md "Admin surface"
 * block calls this out explicitly: "treat these like a root shell on
 * the host." Operators who want stricter posture should not flag any
 * agent admin: true at all.
 *
 * **What's reachable via `cat` / `env`.** Inside a peer container, an
 * allowlisted `cat /state/agent/telegram/.env` reveals the peer's bot
 * token; `cat /state/agent/.claude/credentials.json` reveals its
 * Claude OAuth refresh token. Both are credential-equivalent to root
 * over that peer. This is the deliberate trade-off — without read
 * access, "the peer is wedged" debugging requires shelling onto the
 * host, defeating the point of the admin surface. Operators who want
 * mutation gating beyond restart/stop should layer the
 * `host_os.exec` approval-kernel scope (deferred follow-up).
 *
 * Rationale for an allowlist over a blocklist: legible, auditable,
 * and forces a deliberate add when a new inspection tool is needed.
 */
export const READONLY_EXEC_ALLOWLIST = [
  "cat",
  "df",
  "du",
  // `env` deliberately omitted. A single `env` call dumps the entire
  // process environment (bot tokens, vault keys, etc.) into the 4 KiB
  // response tail — a no-friction secret-exfil gadget for a prompt-
  // injected admin agent. Equivalent forensic data is reachable via
  // `cat /proc/self/environ` (or `/proc/<pid>/environ` for tini's
  // child), which is one extra step a reviewer can spot in the
  // audit log. (Reviewer note on PR #1215.)
  "free",
  "grep",
  "head",
  "hostname",
  "id",
  "ls",
  "ps",
  "pwd",
  "stat",
  "tail",
  "uname",
  "uptime",
  "wc",
  "whoami",
] as const;

export function isAllowlistedReadOnlyArgv(argv0: string): boolean {
  return (READONLY_EXEC_ALLOWLIST as readonly string[]).includes(argv0);
}

/**
 * Upper bound on a single argv element. A read-only inspection
 * command's longest legitimate element is a path or a grep pattern —
 * 4 KiB is already absurdly generous for either. The cap stops a
 * post-approval admin agent padding the audit row / docker arg vector
 * with a multi-megabyte element.
 */
export const MAX_EXEC_ARGV_ELEMENT_BYTES = 4096;

/**
 * #1401 / #1400 target 3 — completes the WS5 per-element charclass
 * finding. Every argv element must be free of ALL C0 control bytes
 * (U+0000–U+001F) and DEL (U+007F), and must not exceed
 * {@link MAX_EXEC_ARGV_ELEMENT_BYTES}.
 *
 * #1401 already rejected NUL/LF/CR (audit-log line injection +
 * pre-`--` docker-flag confusion). The residual the WS5 audit flagged
 * is the *other* C0 controls — ESC (U+001B), backspace, the SGR /
 * cursor introducers — which have no place in a path, a `-n`-style
 * flag, or a grep pattern, but DO let a prompt-injected admin agent
 * smuggle ANSI escape sequences into the operator-facing
 * `switchroom audit hostd` trail (terminal / log spoofing). argv[0]
 * is separately allowlist-gated by isAllowlistedReadOnlyArgv; the
 * cross-agent credential-read residual is the explicitly-accepted
 * admin-surface trade-off whose sanctioned fix is the deferred
 * `host_os.exec` approval-kernel scope, not this charclass.
 */
export function isSafeExecArgvElement(s: string): boolean {
  if (Buffer.byteLength(s, "utf8") > MAX_EXEC_ARGV_ELEMENT_BYTES) return false;
  return !/[\u0000-\u001f\u007f]/.test(s);
}

/** Probe whether an agent socket exists at the canonical in-container
 *  path. Used by gateway integration (Phase 2) to decide between
 *  daemon-call vs spawn-detached fallback. */
export function hostdSocketPathForAgent(agentName: string): string {
  return `/run/switchroom/hostd/${agentName}/sock`;
}

// Exported for symmetry with src/vault/broker — most callers use the
// class methods, but tests + cli wrappers reach in.
export { readdirSync };
export { randomUUID };
