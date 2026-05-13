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
import { spawn } from "node:child_process";
import { mkdir, chmod, chown, unlink, appendFile } from "node:fs/promises";
import { readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
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
import { socketPathToIdentity, type SocketIdentity } from "./peercred.js";

/** Subset of switchroom.yaml the daemon reads. */
export interface ServerConfig {
  /** Per-agent admin flag — drives the verb gate. Daemon reads this
   *  once at startup (Phase 1) and reloads on SIGHUP (post-Phase-1
   *  follow-up). */
  agents: Record<string, { admin?: boolean }>;
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
        // Phase 3 admin-observability verbs. Self-target is allowed
        // (an agent reading its own logs / inspecting its own
        // container is harmless and useful for self-debugging);
        // cross-agent requires admin. agent_exec additionally enforces
        // a read-only argv allowlist at dispatch time — see
        // isAllowlistedReadOnlyArgv.
        if (req.args.name === caller.name) return null;
        return callerAdmin
          ? null
          : `${req.op} cross-agent requires admin: true on caller "${caller.name}"`;
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
   * Mutating + long-running: `switchroom update` (pull + apply +
   * recreate + doctor). Async fire-and-forget pattern (same as
   * agent_restart). The fleet-mutation lock gates concurrent
   * update_apply / apply calls — if one is in flight we return
   * `denied` with the in-flight request_id so the caller can poll
   * `get_status` instead of racing.
   */
  private handleUpdateApply(
    req: Extract<HostdRequest, { op: "update_apply" }>,
    caller: SocketIdentity,
    started: number,
  ): HostdResponse {
    const denied = this.checkFleetMutationLock(req.op, req.request_id, started);
    if (denied) return denied;

    const args = ["update"];
    if (req.args?.skip_images) args.push("--skip-images");
    if (req.args?.rebuild) args.push("--rebuild");

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
    const container = `switchroom-${req.args.name}`;
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

  private async writeAudit(args: {
    caller: SocketIdentity;
    req: HostdRequest;
    resp: HostdResponse;
  }): Promise<void> {
    const path =
      this.opts.auditLogPath ??
      join(this.opts.homeDir, ".switchroom", "host-control-audit.log");
    await mkdir(dirname(path), { recursive: true }).catch(() => undefined);
    const row = {
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
      error: args.resp.error,
    };
    await appendFile(path, JSON.stringify(row) + "\n").catch((err) => {
      process.stderr.write(`hostd: audit append failed: ${(err as Error).message}\n`);
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

/** Probe whether an agent socket exists at the canonical in-container
 *  path. Used by gateway integration (Phase 2) to decide between
 *  daemon-call vs spawn-detached fallback. */
export function hostdSocketPathForAgent(agentName: string): string {
  return `/run/switchroom/hostd/${agentName}/sock`;
}

/** True iff the daemon's per-agent socket is bound (Linux UDS check). */
export function isHostdReachable(agentName: string): boolean {
  const path = hostdSocketPathForAgent(agentName);
  if (!existsSync(path)) return false;
  try {
    const s = statSync(path);
    return s.isSocket();
  } catch {
    return false;
  }
}

// Exported for symmetry with src/vault/broker — most callers use the
// class methods, but tests + cli wrappers reach in.
export { readdirSync };
export { randomUUID };
