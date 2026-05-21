/**
 * switchroom-hostd server — listens on per-agent Unix-domain sockets,
 * dispatches a closed set of operator-only switchroom verbs to the
 * host CLI.
 *
 * Phase 1 scope (per RFC C, `docs/rfcs/host-control-daemon.md`):
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
  unlinkSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import {
  decodeRequest,
  encodeResponse,
  deniedResponse,
  errorResponse,
  IDEMPOTENCY_WINDOW_MS,
  MAX_FRAME_BYTES,
  type HostdRequest,
  type HostdResponse,
  type Result,
} from "./protocol.js";
import { chainRow, seedChain, type ChainState } from "../util/audit-hashchain.js";
import { socketPathToIdentity, type SocketIdentity } from "./peercred.js";
import { redact } from "../secret-detect/redact.js";
import { detectInstallType, type InstallType } from "../cli/install-detect.js";
import { validateConfigEdit } from "./config-edit-validator.js";
import type { ApprovalGateway } from "./approval-gateway.js";

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
  /**
   * RFC §3.3 / #1623 — surface that renders the operator approval
   * card and awaits the verdict. Production wiring uses
   * `SocketApprovalGateway` (per-agent gateway IPC socket); tests
   * inject an in-process mock. Optional: when unset, the apply path
   * returns `E_NO_APPROVAL_GATEWAY` rather than skipping the
   * approval step. Operator opts in by setting
   * `hostd.config_edit_enabled: true` AND deploying a hostd build
   * with the gateway wired — both signals required.
   */
  approvalGateway?: ApprovalGateway;
  /**
   * Test seam: override the random hex id generator. Default is
   * `crypto.randomBytes(4).toString('hex')`. Tests pin a deterministic
   * id so assertions on the audit row + finalize payload stay stable.
   */
  generateApprovalId?: () => string;
  /**
   * Test seam: override the `switchroom apply` subprocess invocation
   * used after a successful atomic write. Default shells out to the
   * `switchroomBin` with `apply` argv (mirrors the Phase-2 `apply`
   * verb). Tests inject a function that simulates success/failure
   * without touching docker or the host filesystem beyond the
   * scratch config file.
   */
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

/** Best-effort tmp-file cleanup — swallowed errors. */
function unlinkSyncBestEffort(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* noop */
  }
}

const STATUS_RETENTION_MS = 10 * 60 * 1000; // 10 min
const STATUS_MAX_ENTRIES = 256;

/** Tail length for stdout/stderr in audit + response frames. */
const TAIL_BYTES = 4096;

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
    | { op: "update_apply" | "apply"; request_id: string; started_at: number }
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
        // ── PR 1a (admin-agent-config-edit RFC) ──────────────────
        // Stub dispatcher: flag-gated disabled error or a
        // not-implemented marker. PR 1b adds validation; PR 1c adds
        // the approval card + apply path.
        case "config_propose_edit":
          resp = await this.handleConfigProposeEdit(req, caller, started);
          break;
      }
    } catch (err) {
      resp = errorResponse(
        req.request_id,
        `hostd dispatch failed: ${(err as Error).message}`,
        Date.now() - started,
      );
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
        // Fleet-wide mutations. Require admin: a non-admin agent
        // accidentally regenerating compose / pulling images on the
        // whole fleet is the obvious foot-gun. Operator is always
        // allowed (kind === "operator" already returned null above).
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
      case "config_propose_edit":
        // Admin-only at the wire layer. The verb proposes mutations to
        // the central switchroom.yaml — strictly broader blast radius
        // than per-agent operations. The handler still returns
        // E_CONFIG_EDIT_DISABLED when the operator hasn't opted in,
        // but we refuse non-admin callers before that check so an
        // un-admin'd peer can't even probe the feature flag state.
        return callerAdmin
          ? null
          : `config_propose_edit requires admin: true on caller "${caller.name}"`;
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
          `docs/rfcs/approval-kernel.md §6 (deferred follow-up).`,
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
   * adds a real, quota-costing `claude -p` auth smoke; the default
   * makes NO model call.
   */
  /**
   * `config_propose_edit` — PR 1a stub.
   *
   * The full RFC (`docs/rfcs/admin-agent-config-edit.md`) sequences
   * three PRs: 1a wires schema + dispatcher (this method), 1b adds
   * the validation pipeline (§3.2), 1c adds the approval card + apply
   * path (§3.3, §3.4). Until 1c lands the verb has no live effect on
   * disk — it surfaces a flag-aware error so admin agents can
   * discover the feature and operators can opt in incrementally.
   *
   * Error-code convention (`CONFIG_PROPOSE_EDIT_ERROR_CODES` in
   * protocol.ts): the audit row and the `resp.error` string both
   * carry the code so MCP callers and the audit reader can branch on
   * it without parsing free text. Format: `<CODE>: <human message>`.
   */
  /**
   * `config_propose_edit` — full apply path (#1623 / RFC §3.3-3.4).
   *
   * Sequence:
   *   1. Flag gate (operator opted in via `hostd.config_edit_enabled`).
   *   2. Validation pipeline (PR 1b — `validateConfigEdit`).
   *   3. Approval card via `approvalGateway.requestApproval` (RFC §3.3).
   *      Verdict ∈ {approve, deny, timeout}. Deny / timeout return
   *      `E_DENIED` / `E_APPROVAL_TIMEOUT` and finalize is a no-op.
   *   4. On approve: serialize on `configApplyLock` (single-process
   *      mutex — RFC §3.4 explicitly walks back the belt-and-braces
   *      flock for single-host single-operator land), take a snapshot
   *      of the live config, atomically write the new content
   *      (`<path>.tmp` → rename), invoke `switchroom apply`.
   *   5. If reconcile fails: restore from snapshot atomically, re-run
   *      reconcile (basic rollback), finalize the card to
   *      "reconcile failed; rolled back", return
   *      `E_RECONCILE_FAILED_ROLLED_BACK`.
   *   6. On success: finalize the card to "applied", return result
   *      `completed`.
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
      return errorResponse(
        req.request_id,
        "E_CONFIG_EDIT_DISABLED: config_propose_edit is disabled; " +
          "operator must set hostd.config_edit_enabled=true in " +
          "switchroom.yaml to opt in",
        Date.now() - started,
      );
    }
    const configPath =
      this.opts.configPath ?? req.args.target_path;
    const verdict = validateConfigEdit({
      configPath,
      targetPath: req.args.target_path,
      unifiedDiff: req.args.unified_diff,
    });
    if (!verdict.ok) {
      return errorResponse(
        req.request_id,
        `${verdict.code}: ${verdict.detail}`,
        Date.now() - started,
      );
    }
    // ── Approval card ───────────────────────────────────────────────
    if (!this.opts.approvalGateway) {
      return errorResponse(
        req.request_id,
        "E_NO_APPROVAL_GATEWAY: validation passed but hostd was " +
          "started without an approval-gateway wiring; the operator " +
          "build is missing the telegram-plugin link",
        Date.now() - started,
      );
    }
    const callerName = caller.kind === "agent" ? caller.name : "operator";
    const approvalId = (this.opts.generateApprovalId ?? defaultApprovalId)();
    const approval = await this.opts.approvalGateway.requestApproval({
      requestId: approvalId,
      agentName: callerName,
      reason: req.args.reason,
      unifiedDiff: req.args.unified_diff,
      timeoutMs: CONFIG_APPROVAL_TIMEOUT_MS,
    });
    if (approval.verdict === "deny") {
      return errorResponse(
        req.request_id,
        `E_DENIED: operator denied config_propose_edit (approval_id=${approvalId})`,
        Date.now() - started,
      );
    }
    if (approval.verdict === "timeout") {
      return errorResponse(
        req.request_id,
        `E_APPROVAL_TIMEOUT: operator approval card expired without a tap (approval_id=${approvalId})`,
        Date.now() - started,
      );
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
      } catch (err) {
        await approval.finalize({
          outcome: "reconcile_failed_rolled_back",
          detail: `pre-write snapshot read failed: ${(err as Error).message}`,
        });
        return errorResponse(
          req.request_id,
          `E_RECONCILE_FAILED_ROLLED_BACK: snapshot read failed: ${(err as Error).message}`,
          Date.now() - started,
        );
      }
      // The validator already produced the post-apply text (it runs
      // `git apply` against the live file). We re-derive it here by
      // applying the patch a second time to obtain the post-patch
      // bytes — the validator returns its own copy on success.
      const postApply = verdict.postApplyContent;
      // Atomic write: `<path>.tmp` → rename.
      const tmp = configPath + ".tmp";
      try {
        writeFileSync(tmp, postApply);
        renameSync(tmp, configPath);
      } catch (err) {
        // Pre-write or rename failed — try to clean up tmp; live
        // file is untouched so no rollback needed.
        try { unlinkSyncBestEffort(tmp); } catch { /* noop */ }
        await approval.finalize({
          outcome: "reconcile_failed_rolled_back",
          detail: `atomic write failed: ${(err as Error).message}`,
        });
        return errorResponse(
          req.request_id,
          `E_RECONCILE_FAILED_ROLLED_BACK: write failed: ${(err as Error).message}`,
          Date.now() - started,
        );
      }
      // Reconcile.
      const runner =
        this.opts.runReconcile ??
        (async () => this.runSwitchroom(["apply"]));
      const recRes = await runner({ requestId: approvalId });
      if (recRes.exit_code === 0) {
        await approval.finalize({ outcome: "applied" });
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
      let rollbackDetail = "";
      try {
        writeFileSync(tmp, snapshot);
        renameSync(tmp, configPath);
      } catch (err) {
        rollbackDetail = `snapshot restore failed: ${(err as Error).message}`;
        await approval.finalize({
          outcome: "reconcile_failed_rolled_back",
          detail: rollbackDetail,
        });
        return errorResponse(
          req.request_id,
          `E_RECONCILE_FAILED_ROLLED_BACK: ${rollbackDetail}`,
          Date.now() - started,
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
      return errorResponse(
        req.request_id,
        `E_RECONCILE_FAILED_ROLLED_BACK: reconcile exit ${recRes.exit_code}; ${recoveryNote}`,
        Date.now() - started,
      );
    } finally {
      release();
    }
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
      PROBES.push({
        name: "auth_live",
        cmd: "timeout 25 claude -p ok >/dev/null 2>&1",
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
    op: "update_apply" | "apply",
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
    op: "update_apply" | "apply",
    args: string[],
    entry: StatusEntry,
  ): void {
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

  private handleGetStatus(
    req: Extract<HostdRequest, { op: "get_status" }>,
    _caller: SocketIdentity,
    started: number,
  ): HostdResponse {
    const entry = this.statusByRequestId.get(req.args.target_request_id);
    // checkGate already rejected unknown / cross-agent cases above.
    // If we got here `entry` must exist.
    if (!entry) {
      return errorResponse(
        req.request_id,
        `get_status: internal: entry missing despite gate accept`,
        Date.now() - started,
      );
    }
    return this.statusEntryToResponse(req.request_id, entry);
  }

  private statusEntryToResponse(
    request_id: string,
    entry: StatusEntry,
  ): HostdResponse {
    return {
      v: 1,
      request_id,
      result: entry.result,
      exit_code: entry.exit_code,
      duration_ms: (entry.finished_at ?? Date.now()) - entry.started_at,
      stdout_tail: entry.stdout_tail || undefined,
      stderr_tail: entry.stderr_tail || undefined,
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
    });
  }

  /** Spawn the host switchroom CLI and capture stdout/stderr. */
  private runSwitchroom(
    args: string[],
  ): Promise<{ exit_code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const bin = this.opts.switchroomBin ?? "switchroom";
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
}

function tail(s: string, bytes = TAIL_BYTES): string {
  if (Buffer.byteLength(s, "utf8") <= bytes) return s;
  return s.slice(s.length - bytes);
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
