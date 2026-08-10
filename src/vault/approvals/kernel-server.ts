/**
 * Approval kernel IPC server (Phase 1c).
 *
 * Standalone entrypoint for the `switchroom/kernel` container. Mirrors the
 * broker's per-agent socket-dir identity model:
 *
 *   /run/switchroom/kernel/<agent>/sock          (mode 0660, owned by agent UID)
 *   /run/switchroom/kernel/<agent>/               (mode 0700, owned by agent UID)
 *
 * Identity: the kernel never trusts the wire payload. Each connection is
 * accepted on a server socket bound inside a per-agent directory; the agent
 * identity is the directory name. We resolve it via getsockname() on the
 * accepted socket — the same mechanism the broker uses (see
 * src/vault/broker/server.ts). No HMAC fallback.
 *
 * Wire protocol: NDJSON, framed by `\n`. Reuses BrokerRequest/BrokerResponse
 * encoding from `../broker/protocol.ts` so existing approval-client code
 * (src/vault/approvals/client.ts) talks to the kernel unchanged.
 *
 * Socket race-safety: parent directory is created with {recursive:true,
 * mode:0o700} in a single mkdir(2) under umask 0o077 — no mkdir-then-chmod
 * window. Same discipline as the broker (Phase 0 spike fix).
 *
 * Env contract:
 *   SWITCHROOM_KERNEL_SOCKET    Default base path for the kernel-socket
 *                               parent. Default
 *                               /run/switchroom/kernel/approval-kernel.sock
 *                               — used as a fallback when no agents are
 *                               declared in config (boot-time visibility).
 *   SWITCHROOM_CONFIG           Path to switchroom.yaml; used to enumerate
 *                               per-agent socket dirs to bind. If unset,
 *                               loadConfig() auto-detects.
 *   SWITCHROOM_KERNEL_DB_PATH   Path to kernel.db. Default
 *                               /state/approvals/kernel.db.
 */

import * as net from "node:net";
import { mkdirSync, chmodSync, chownSync, existsSync, unlinkSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve, basename } from "node:path";
import { Database } from "bun:sqlite";

import {
  decodeRequest,
  encodeResponse,
  errorResponse,
  MAX_FRAME_BYTES,
  type BrokerRequest,
} from "../broker/protocol.js";
import {
  requestApproval,
  lookupDecision,
  lookupDecisionByRequestId,
  consumeNonce,
  consumeAndRecord,
  revokeDecision,
  listDecisions,
  recordDecision,
  getNonce,
  getDecision,
  countPendingNonces,
  computeRetryAfterMs,
  MAX_PENDING_PER_AGENT,
  MAX_PENDING_GLOBAL,
} from "./kernel.js";
import { migrateApprovalSchema } from "./schema.js";
import { allocateAgentUid } from "../../agents/compose.js";
import { checkApprovalAclByAgent } from "./acl.js";
import { getPeerCred } from "../broker/peercred-ffi.js";

const DEFAULT_SOCKET_PARENT = "/run/switchroom/kernel";
const DEFAULT_DB_PATH = "/state/approvals/kernel.db";

// ─── DB open ──────────────────────────────────────────────────────────────────

/**
 * Open (or create) the kernel approval DB. Standalone from openGrantsDb()
 * — the kernel container does NOT carry vault grants; it only owns the
 * approval-kernel tables (RFC B §5).
 */
export function openKernelDb(dbPath: string): Database {
  const dir = dirname(dbPath);
  mkdirSync(dir, { recursive: true });
  // allow-rw-db-open: the approval-kernel OWNS grants.db — it is the writer
  const db = new Database(dbPath, { create: true });
  try {
    chmodSync(dbPath, 0o600);
  } catch { /* may already be 0600, or FS ignores modes */ }
  db.run("PRAGMA journal_mode=WAL");
  // Without a busy_timeout, bun:sqlite defaults to 0ms and a contending
  // writer fails IMMEDIATELY with SQLITE_BUSY — an approval write can be
  // silently dropped. Wait-and-retry instead of dropping.
  db.run("PRAGMA busy_timeout=5000");
  db.run("PRAGMA foreign_keys=ON");
  migrateApprovalSchema(db);
  return db;
}

// ─── Per-agent listener ───────────────────────────────────────────────────────

interface AgentListener {
  agent: string;
  socketPath: string;
  server: net.Server;
}

/**
 * Bind one server socket inside /run/switchroom/kernel/<agent>/. Race-safe:
 * mkdirSync with mode option creates the dir at 0700 in a single syscall
 * under the process umask 0o077 (set by main()). chmod is defence-in-depth.
 */
async function bindAgentSocket(
  parentDir: string,
  agent: string,
  db: Database,
): Promise<AgentListener> {
  const dir = resolve(parentDir, agent);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Reset the per-agent dir back to root:root 0700 BEFORE binding (#881).
  // On a fresh container the dir is already root-owned (from the mkdir
  // above) so chown is a no-op. On a restart where a previous instance
  // left the dir chowned to the agent UID 10xxx mode 0700, a fresh
  // kernel container — running root with cap_drop=ALL +
  // cap_add=[CHOWN,FOWNER,DAC_READ_SEARCH] — does NOT hold
  // CAP_DAC_OVERRIDE and cannot write into a 10xxx-owned 0700 dir.
  // CAP_CHOWN is granted, so chown'ing the dir back to root succeeds
  // regardless of its current owner. Pre-fix this manifested as
  // "[kernel] listen error agent=<x>: Failed to listen at ..." for every
  // agent on every container restart, with the unlinkSync below silently
  // failing for the same DAC reason.
  try { chownSync(dir, 0, 0); } catch { /* outside docker / no CAP_CHOWN */ }
  try { chmodSync(dir, 0o700); } catch { /* idempotent */ }
  // Chown the per-agent dir to the agent's UID so non-root agent
  // containers (running as user:<uid>:<uid> per compose) can traverse
  // into it. This mirrors the broker's design: cap_add: [CHOWN, FOWNER]
  // is granted in the compose service so this chown succeeds even
  // under cap_drop=ALL. If chown fails (no CAP_CHOWN, e.g. running
  // outside docker), we leave the dir root-owned — a non-root agent
  // would be denied, but in non-docker dev/test environments the
  // kernel-server typically runs as the same user as its callers.
  const uid = allocateAgentUid(agent);
  // IMPORTANT: chown the dir AFTER listen(), not before. Under
  // cap_drop=ALL + cap_add=[CHOWN,FOWNER], root-in-container does NOT
  // hold CAP_DAC_OVERRIDE; if we chown the dir to the agent UID first,
  // root can no longer write into it (mode 0700 owned by 10116) and
  // bind() fails with EACCES. Order:
  //   1. mkdir with mode 0o700 under umask 0o077 (root-owned).
  //   2. chown dir back to root (recovers from a previous run that left
  //      it chowned to the agent UID — see #881).
  //   3. listen() — creates the socket file as root inside root-owned dir.
  //   4. chown dir + sock to the agent UID (CAP_CHOWN granted).
  //   5. chmod sock to 0o660 (FOWNER not strictly needed here since we
  //      own the file, but the cap_add list includes it for the broker).
  const socketPath = resolve(dir, "sock");
  if (existsSync(socketPath)) {
    try {
      unlinkSync(socketPath);
    } catch (err) {
      // Don't swallow silently (#881). Surface the path + errno so an
      // operator chasing a "Failed to listen" can see *why* the stale
      // socket couldn't be cleaned up. Continue to listen() either way:
      // it will fail with the same root cause but the diagnostic
      // breadcrumb is now in the log.
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[kernel] could not unlink stale socket agent=${agent} sock=${socketPath}: ${msg}\n`,
      );
    }
  }
  return new Promise((resolveP, rejectP) => {
    const server = net.createServer((sock) => handleConnection(sock, agent, db));
    server.on("error", (err) => {
      process.stderr.write(`[kernel] listen error agent=${agent} sock=${socketPath}: ${err.message}\n`);
      rejectP(err);
    });
    server.listen(socketPath, () => {
      try { chmodSync(socketPath, 0o660); } catch { /* ignore */ }
      try { chownSync(socketPath, uid, uid); } catch { /* see above */ }
      // Now safe to lock the dir down to the agent.
      try { chownSync(dir, uid, uid); } catch { /* see above */ }
      resolveP({ agent, socketPath, server });
    });
  });
}

/**
 * Bind the host operator socket at /run/switchroom/kernel/operator/sock.
 *
 * Same bind plumbing as bindAgentSocket (root-owned dir → listen →
 * chown to the operator UID), but:
 *   - the directory name is the reserved KERNEL_OPERATOR_NAME, excluded
 *     from per-agent enumeration so it can never be treated as an agent;
 *   - the socket is mode 0600 (operator-only), tighter than the 0660
 *     per-agent sockets — only the single host operator UID connects;
 *   - connections are flagged `isOperator`, which the deny-by-default
 *     allowlist in handleRequest restricts to approval_list.
 *
 * Bound only when SWITCHROOM_KERNEL_OPERATOR_UID is set (compose emits
 * it alongside the operator bind mount, gated on the same operatorUid
 * config the auth-broker uses). Absent ⇒ no operator listener, behaviour
 * unchanged.
 */
async function bindOperatorSocket(
  parentDir: string,
  operatorUid: number,
  db: Database,
): Promise<AgentListener> {
  const dir = resolve(parentDir, KERNEL_OPERATOR_NAME);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chownSync(dir, 0, 0); } catch { /* outside docker / no CAP_CHOWN */ }
  try { chmodSync(dir, 0o700); } catch { /* idempotent */ }
  const socketPath = resolve(dir, "sock");
  if (existsSync(socketPath)) {
    try {
      unlinkSync(socketPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[kernel] could not unlink stale operator socket sock=${socketPath}: ${msg}\n`,
      );
    }
  }
  return new Promise((resolveP, rejectP) => {
    const server = net.createServer((sock) =>
      handleConnection(sock, KERNEL_OPERATOR_NAME, db, true),
    );
    server.on("error", (err) => {
      process.stderr.write(`[kernel] listen error operator sock=${socketPath}: ${err.message}\n`);
      rejectP(err);
    });
    server.listen(socketPath, () => {
      // 0600: only the operator UID may connect. Tighter than the
      // per-agent 0660 because there is exactly one legitimate peer.
      try { chmodSync(socketPath, 0o600); } catch { /* ignore */ }
      try { chownSync(socketPath, operatorUid, operatorUid); } catch { /* see bindAgentSocket */ }
      try { chownSync(dir, operatorUid, operatorUid); } catch { /* see bindAgentSocket */ }
      resolveP({ agent: KERNEL_OPERATOR_NAME, socketPath, server });
    });
  });
}

// ─── Connection handling ─────────────────────────────────────────────────────

function handleConnection(
  socket: net.Socket,
  agent: string,
  db: Database,
  isOperator = false,
): void {
  // `agent` is the trusted identity — it came from the listener's directory
  // name, established at bind time before the connection existed. No
  // wire-payload field can override this.
  //
  // Phase 2b: capture SO_PEERCRED UID once at accept(2) time. Forensic only
  // — never used to gate ACL. Best-effort: getPeerCred returns null on
  // non-Linux or when the FFI symbol isn't available.
  let peerUid: number | null = null;
  try {
    type SocketWithFd = net.Socket & { _handle?: { fd?: number } };
    const fd = (socket as SocketWithFd)._handle?.fd;
    if (typeof fd === "number" && fd >= 0) {
      const cred = getPeerCred(fd);
      if (cred !== null) peerUid = cred.uid;
    }
  } catch { /* best-effort; ACL doesn't depend on this */ }

  let buffer = "";
  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    if (Buffer.byteLength(buffer, "utf8") > MAX_FRAME_BYTES) {
      // end(resp) not write(resp); destroy() — same race shape as
      // #988's unlock-handler fix: destroy can drop the buffered
      // response before the kernel flushes it to the peer.
      socket.end(encodeResponse(errorResponse("BAD_REQUEST", "Frame exceeds 64 KiB limit")));
      return;
    }
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.length === 0) continue;
      let req: BrokerRequest;
      try {
        req = decodeRequest(line);
      } catch (err) {
        socket.write(encodeResponse(errorResponse("BAD_REQUEST", (err as Error).message)));
        continue;
      }
      try {
        handleRequest(socket, req, agent, db, peerUid, isOperator);
      } catch (err) {
        socket.write(encodeResponse(errorResponse("INTERNAL", (err as Error).message)));
      }
    }
  });
  socket.on("error", () => { /* peer dropped — best-effort */ });
}

/**
 * Connections accepted on the host operator socket
 * (`/run/switchroom/kernel/operator/sock`, bound only when an operator
 * UID is configured). Path-as-identity: this name is reserved and
 * excluded from per-agent enumeration, so a connection is "operator"
 * iff it arrived on the operator listener — never inferred from the
 * wire.
 */
export const KERNEL_OPERATOR_NAME = "operator";

/**
 * Ops the operator socket may invoke. DENY-BY-DEFAULT — this is the
 * inverse of the auth-broker's `operator ⇒ admin ⇒ allow-all` model,
 * and that inversion is the entire security point of this socket.
 *
 * The kernel's mutating ops (`approval_consume` / `approval_revoke` /
 * `approval_record` / `approval_request`) are gated by a listener-identity
 * ACL: the resolved nonce/decision's `agent_unit` must equal the listener's
 * bind-time agent name (#1399 — `checkApprovalAclByAgent`). That ACL keys
 * off the *bound listener*, so it cannot be satisfied on the operator
 * socket at all (no agent identity). An operator connection reaching those
 * ops would still be unauthenticated fleet-wide grant forgery / nonce
 * burning, so the operator socket is independently restricted to the
 * single read-only op the dashboard needs — listing decision metadata.
 * Widening this set without a per-op authorization story is a security
 * regression.
 */
const OPERATOR_ALLOWED_OPS: ReadonlySet<string> = new Set(["approval_list"]);

/**
 * Provenance stamp for a decision recorded on this connection
 * (`approval_decisions.origin`). Derived ONLY from which listener
 * accepted the connection — there is deliberately no wire field for it,
 * because a wire field would be settable by the very process the column
 * exists to distrust.
 *
 * Today this returns `'agent'` for every connection that can actually
 * record a decision: `OPERATOR_ALLOWED_OPS` is read-only, so the
 * operator listener cannot reach `approval_record` /
 * `approval_consume_record` at all. That is the honest state of the
 * world — the per-agent socket is shared by the gateway AND claude
 * (same container, same UID; see `src/agents/compose.ts` — one `agent`
 * service, one `kernel-<agent>-sock` volume), so nothing recorded on it
 * is proof a human tapped.
 *
 * Note precisely what is missing, because "no signal exists" would be
 * false: `handleConnection` already captures SO_PEERCRED at accept(2),
 * and `getPeerCred` returns `{pid, uid, gid}`
 * (`src/vault/broker/peercred-ffi.ts:42-46`) — we keep the uid for audit
 * and drop the pid on purpose. Keeping the pid would NOT yield
 * provenance: under same-uid co-residency claude can read
 * `/proc/<gateway-pid>/environ`, ptrace the gateway, or exec a process
 * matching its exe path, so any pid→identity mapping is forgeable by the
 * process it is meant to distrust — and this server's own PID namespace
 * makes a peer pid from the agent container untranslatable anyway. The
 * missing ingredient is a channel boundary, not a better fingerprint.
 *
 * That boundary partly exists already: `bindOperatorSocket` binds a 0600
 * operator socket mounted only into the kernel container
 * (`src/agents/compose.ts:1686`), kept read-only by `OPERATOR_ALLOWED_OPS`
 * under a pinned contract (`kernel-operator-acl.test.ts`). So `'operator'`
 * becomes producible once the host-side approval verifier lands (RFC
 * vault-approval-hard-boundary PR ②): grant that socket a write op with a
 * per-op authorization story, and move the tap consumer out of the agent
 * container so it can reach it. This function is the single place that
 * decision is made.
 */
export function listenerOrigin(isOperator: boolean): "agent" | "operator" {
  return isOperator ? "operator" : "agent";
}

function handleRequest(
  socket: net.Socket,
  req: BrokerRequest,
  agent: string,
  db: Database,
  peerUid: number | null,
  isOperator = false,
): void {
  // Deny-by-default allowlist for the operator socket. Must be the
  // FIRST check — before any op dispatch — so a mutating op can never
  // execute on an operator connection even if a future refactor
  // reorders the chain below.
  if (isOperator && !OPERATOR_ALLOWED_OPS.has(req.op)) {
    socket.write(
      encodeResponse(
        errorResponse(
          "DENIED",
          `kernel operator socket is read-only: '${req.op}' is not permitted (only ${[...OPERATOR_ALLOWED_OPS].join(", ")})`,
        ),
      ),
    );
    return;
  }

  // Only approval ops are served here. Anything else (vault_get, list_grants,
  // etc.) is the broker's territory and gets a hard error.
  if (req.op === "approval_request") {
    // Phase 2b — explicit ACL gate by listener-bound agent name.
    const acl = checkApprovalAclByAgent(agent, req.agent_unit);
    if (!acl.allow) {
      socket.write(encodeResponse(errorResponse("DENIED", acl.reason)));
      return;
    }
    const counts = countPendingNonces(db);
    const perAgentN = counts.perAgent.get(req.agent_unit) ?? 0;
    if (perAgentN >= MAX_PENDING_PER_AGENT || counts.global >= MAX_PENDING_GLOBAL) {
      const retry_after_ms = computeRetryAfterMs(
        db,
        perAgentN >= MAX_PENDING_PER_AGENT ? req.agent_unit : null,
      );
      socket.write(encodeResponse({ ok: true, kind: "approval_request", state: "rate_limited", retry_after_ms }));
      return;
    }
    const result = requestApproval(db, {
      agent_unit: req.agent_unit,
      scope: req.scope,
      action: req.action,
      approver_set: req.approver_set,
      why: req.why,
      ttl_ms: req.ttl_ms,
      // Phase 2b — additive audit context, no schema migration.
      ...(peerUid !== null ? { peer_uid: peerUid } : {}),
      agent_name: agent,
    });
    socket.write(encodeResponse({
      ok: true,
      kind: "approval_request",
      state: "pending",
      request_id: result.request_id,
      expires_at: result.expires_at,
    }));
    return;
  }
  if (req.op === "approval_lookup") {
    const acl = checkApprovalAclByAgent(agent, req.agent_unit);
    if (!acl.allow) {
      socket.write(encodeResponse(errorResponse("DENIED", acl.reason)));
      return;
    }
    const r = lookupDecision(db, {
      agent_unit: req.agent_unit,
      scope: req.scope,
      action: req.action,
      current_approver_set: req.current_approver_set,
    });
    // INVARIANT (allow_once): a `state: "granted"` response may carry a
    // decision whose `revoked_at` is non-null with `revoke_reason =
    // 'allow_once_consumed'`. That is not a contradiction — it is the defined
    // shape of a one-shot's single grant. The burn happens in the same atomic
    // step that authorizes this very use (kernel.ts, the allow_once branch),
    // so the row is already spent by the time we project it. `state` is the
    // authority for "may I proceed"; `revoked_at` reports the row's post-burn
    // truth and is deliberately NOT rewritten to null, so an operator reading
    // a lookup response sees exactly what approval_list and the audit log
    // show. Consumers MUST NOT re-gate a granted verdict on `revoked_at`.
    // Pinned by kernel-listener-acl.test.ts ("granted allow_once response
    // carries the burn").
    const decision = r.state === "granted" || r.state === "denied"
      ? {
          id: r.decision.id,
          agent_unit: r.decision.agent_unit,
          scope: r.decision.scope,
          action: r.decision.action,
          decision: r.decision.decision,
          granted_at: r.decision.granted_at,
          granted_by_user_id: r.decision.granted_by_user_id,
          ttl_expires_at: r.decision.ttl_expires_at,
          last_used_at: r.decision.last_used_at,
          revoked_at: r.decision.revoked_at,
          revoke_reason: r.decision.revoke_reason,
          // Provenance MUST cross the wire: without it no consumer can
          // tell a real operator tap from a decision the agent recorded
          // for itself on this very socket (self-approval bypass). Read
          // straight off the DB row — never from the request payload.
          origin: r.decision.origin,
        }
      : null;
    socket.write(encodeResponse({ ok: true, state: r.state, decision }));
    return;
  }
  if (req.op === "approval_lookup_by_request") {
    const acl = checkApprovalAclByAgent(agent, req.agent_unit);
    if (!acl.allow) {
      socket.write(encodeResponse(errorResponse("DENIED", acl.reason)));
      return;
    }
    const r = lookupDecisionByRequestId(db, {
      agent_unit: req.agent_unit,
      request_id: req.request_id,
      current_approver_set: req.current_approver_set,
    });
    // Same allow_once invariant as approval_lookup above: `granted` may carry
    // a burned (revoked_at != null, reason 'allow_once_consumed') row.
    const decision = r.state === "granted" || r.state === "denied"
      ? {
          id: r.decision.id,
          agent_unit: r.decision.agent_unit,
          scope: r.decision.scope,
          action: r.decision.action,
          decision: r.decision.decision,
          granted_at: r.decision.granted_at,
          granted_by_user_id: r.decision.granted_by_user_id,
          ttl_expires_at: r.decision.ttl_expires_at,
          last_used_at: r.decision.last_used_at,
          revoked_at: r.decision.revoked_at,
          revoke_reason: r.decision.revoke_reason,
          // See approval_lookup above — provenance is part of the answer.
          origin: r.decision.origin,
        }
      : null;
    socket.write(encodeResponse({ ok: true, state: r.state, decision }));
    return;
  }
  if (req.op === "approval_consume") {
    // Listener-identity ACL (#1399): resolve the nonce's owning agent_unit
    // and refuse if it is not the listener's bound agent. Without this a
    // compromised agent on its own legitimate socket could burn / self-
    // consume any peer's (or its own unrequested) nonce. The generic DENIED
    // message deliberately omits the owning agent name (no cross-agent
    // existence/identity oracle); a null peek falls through to the existing
    // {consumed:false} non-committal path.
    const peek = getNonce(db, req.request_id);
    if (peek !== null) {
      const acl = checkApprovalAclByAgent(agent, peek.agent_unit);
      if (!acl.allow) {
        socket.write(encodeResponse(errorResponse("DENIED", "approval_consume denied: nonce does not belong to the calling agent")));
        return;
      }
    }
    const nonce = consumeNonce(db, req.request_id);
    if (nonce === null) {
      socket.write(encodeResponse({ ok: true, consumed: false }));
      return;
    }
    socket.write(encodeResponse({
      ok: true,
      consumed: true,
      agent_unit: nonce.agent_unit,
      scope: nonce.scope,
      action: nonce.action,
      why: nonce.why,
    }));
    return;
  }
  if (req.op === "approval_revoke") {
    // Listener-identity ACL (#1399): a decision may only be revoked from
    // the socket of the agent it belongs to. A null lookup falls through
    // to revokeDecision, which returns {revoked:false} (unchanged).
    const dec = getDecision(db, req.decision_id);
    if (dec !== null) {
      const acl = checkApprovalAclByAgent(agent, dec.agent_unit);
      if (!acl.allow) {
        socket.write(encodeResponse(errorResponse("DENIED", "approval_revoke denied: decision does not belong to the calling agent")));
        return;
      }
    }
    const revoked = revokeDecision(db, req.decision_id, req.actor, req.reason);
    socket.write(encodeResponse({ ok: true, revoked }));
    return;
  }
  if (req.op === "approval_record") {
    const nonce = getNonce(db, req.request_id);
    if (nonce === null) {
      socket.write(encodeResponse(errorResponse("BAD_REQUEST", "unknown request_id")));
      return;
    }
    if (nonce.consumed_at === null) {
      socket.write(encodeResponse(errorResponse("BAD_REQUEST", "nonce must be consumed before recording — call approval_consume first")));
      return;
    }
    // Listener-identity ACL (#1399): the nonce being recorded must belong
    // to the listener's bound agent. Without this a compromised agent could
    // self-consume + self-record an allow_always decision for a gated tool
    // call no operator ever approved (approval-integrity bypass).
    const recordAcl = checkApprovalAclByAgent(agent, nonce.agent_unit);
    if (!recordAcl.allow) {
      socket.write(encodeResponse(errorResponse("DENIED", "approval_record denied: nonce does not belong to the calling agent")));
      return;
    }
    const decision_id = recordDecision(db, {
      nonce,
      decision: req.decision,
      approver_set: req.approver_set,
      granted_by_user_id: req.granted_by_user_id,
      ttl_ms: req.ttl_ms ?? undefined,
      // Provenance is derived from the BOUND LISTENER, never the wire —
      // see listenerOrigin(). On a per-agent socket this is always
      // 'agent', which is the honest answer: anything in the agent
      // container can reach that socket.
      origin: listenerOrigin(isOperator),
    });
    socket.write(encodeResponse({ ok: true, decision_id }));
    return;
  }
  if (req.op === "approval_consume_record") {
    // Atomic consume+record (PR-6). ACL EXACTLY mirrors approval_consume
    // (not approval_record): this op BURNS the nonce, so a null peek
    // must fall through to the non-committal {consumed:false} rather
    // than approval_record's BAD_REQUEST "unknown request_id" — the
    // latter would be a cross-agent existence oracle on a burning op
    // (regresses kernel-listener-acl). Listener identity is bind-time
    // (`agent`), never from the wire. Operator socket can't reach this:
    // OPERATOR_ALLOWED_OPS is deny-by-default and gates earlier.
    const peek = getNonce(db, req.request_id);
    if (peek !== null) {
      const acl = checkApprovalAclByAgent(agent, peek.agent_unit);
      if (!acl.allow) {
        socket.write(encodeResponse(errorResponse("DENIED", "approval_consume_record denied: nonce does not belong to the calling agent")));
        return;
      }
    }
    const res = consumeAndRecord(db, {
      request_id: req.request_id,
      decision: req.decision,
      approver_set: req.approver_set,
      granted_by_user_id: req.granted_by_user_id,
      ttl_ms: req.ttl_ms ?? undefined,
      // See approval_record above — listener-derived, never wire-derived.
      origin: listenerOrigin(isOperator),
    });
    if (!res.consumed) {
      socket.write(encodeResponse({ ok: true, consumed: false }));
      return;
    }
    socket.write(encodeResponse({
      ok: true,
      consumed: true,
      decision_id: res.decision_id,
      agent_unit: res.nonce.agent_unit,
      scope: res.nonce.scope,
      action: res.nonce.action,
      why: res.nonce.why,
    }));
    return;
  }
  if (req.op === "approval_list") {
    // Listener-identity ACL, same idiom as every sibling op (approval_request
    // :354, approval_lookup :390, approval_lookup_by_request :420,
    // approval_consume :458, approval_revoke :485, approval_record :509,
    // approval_consume_record :535). Without it an agent could enumerate a
    // peer's decisions on its own socket — scopes (which embed Google doc ids
    // and M365 paths), granted_by_user_id (the operator's Telegram user id),
    // grant timestamps and revoke reasons.
    //
    // `agent_unit` is optional on the wire; on an agent socket, omitting it
    // previously meant "every agent". It is now pinned to the listener's
    // bind-time identity, and an explicit cross-agent claim is DENIED.
    //
    // The operator socket is exempt on purpose: approval_list is the ONE op
    // in OPERATOR_ALLOWED_OPS, and the dashboard's whole job is the fleet-wide
    // read. It has no agent identity, so the by-agent ACL could never pass
    // there; its authorization is the 0600 operator-UID socket bind.
    let listFilter: { agent_unit?: string } = { agent_unit: req.agent_unit };
    if (!isOperator) {
      const acl = checkApprovalAclByAgent(agent, req.agent_unit ?? agent);
      if (!acl.allow) {
        socket.write(encodeResponse(errorResponse("DENIED", acl.reason)));
        return;
      }
      listFilter = { agent_unit: agent };
    }
    const decisions = listDecisions(db, listFilter);
    const meta = decisions.map((d) => ({
      id: d.id,
      agent_unit: d.agent_unit,
      scope: d.scope,
      action: d.action,
      decision: d.decision,
      granted_at: d.granted_at,
      granted_by_user_id: d.granted_by_user_id,
      ttl_expires_at: d.ttl_expires_at,
      last_used_at: d.last_used_at,
      revoked_at: d.revoked_at,
      revoke_reason: d.revoke_reason,
    }));
    socket.write(encodeResponse({ ok: true, decisions: meta }));
    return;
  }
  socket.write(encodeResponse(errorResponse("BAD_REQUEST", `kernel-server does not serve op: ${(req as { op: string }).op}`)));
}

// ─── Top-level entrypoint ─────────────────────────────────────────────────────

/** @internal exported for the operator-ACL integration test. */
export interface KernelServerHandle {
  listeners: AgentListener[];
  db: Database;
  stop(): void;
}

/** @internal exported for the operator-ACL integration test. */
export async function bootstrap(opts: {
  socketParent: string;
  agents: string[];
  dbPath: string;
  /** When set, also bind the read-only host operator socket. */
  operatorUid?: number;
}): Promise<KernelServerHandle> {
  process.umask(0o077);
  mkdirSync(opts.socketParent, { recursive: true, mode: 0o755 });
  // The parent stays 0755 — agents need x-bit on the parent to traverse
  // into their own 0700 subdir. Each subdir is locked down 0700.
  try { chmodSync(opts.socketParent, 0o755); } catch { /* idempotent */ }
  const db = openKernelDb(opts.dbPath);
  const listeners: AgentListener[] = [];
  for (const agent of opts.agents) {
    const l = await bindAgentSocket(opts.socketParent, agent, db);
    listeners.push(l);
  }
  if (opts.operatorUid !== undefined) {
    const l = await bindOperatorSocket(opts.socketParent, opts.operatorUid, db);
    listeners.push(l);
    process.stdout.write(
      `approval-kernel: operator socket bound at ${l.socketPath} (read-only: approval_list)\n`,
    );
  }
  return {
    listeners,
    db,
    stop(): void {
      for (const l of listeners) {
        try { l.server.close(); } catch { /* ignore */ }
        try { if (existsSync(l.socketPath)) unlinkSync(l.socketPath); } catch { /* ignore */ }
      }
      try { db.close(); } catch { /* ignore */ }
    },
  };
}

export async function main(): Promise<void> {
  const socketEnv = process.env.SWITCHROOM_KERNEL_SOCKET ?? `${DEFAULT_SOCKET_PARENT}/approval-kernel.sock`;
  // The env var is a socket path by historical convention; we treat its
  // dirname as the parent under which we bind per-agent subdirs.
  const socketParent = dirname(resolve(socketEnv));
  const dbPath = process.env.SWITCHROOM_KERNEL_DB_PATH ?? DEFAULT_DB_PATH;
  const configPath = process.env.SWITCHROOM_CONFIG;
  // Host operator socket — opt-in via SWITCHROOM_KERNEL_OPERATOR_UID
  // (compose emits it next to the operator bind mount, gated on the
  // same operatorUid config the auth-broker uses). A non-integer /
  // unset value leaves the operator listener unbound (behaviour
  // unchanged). Read-only by construction (see OPERATOR_ALLOWED_OPS).
  const operatorUidRaw = process.env.SWITCHROOM_KERNEL_OPERATOR_UID;
  const operatorUid =
    operatorUidRaw && /^\d+$/.test(operatorUidRaw)
      ? Number(operatorUidRaw)
      : undefined;

  let agents: string[] = [];
  // Primary: enumerate per-agent socket dirs that compose mounted in.
  // Each agent's compose declaration mounts its kernel-<name>-sock named
  // volume at /run/switchroom/kernel/<name>; from the kernel container's
  // POV those are subdirectories of the socket parent. This makes the
  // kernel-server zero-config — no SWITCHROOM_CONFIG needed in the
  // compose-generated environment block.
  try {
    if (existsSync(socketParent)) {
      agents = readdirSync(socketParent)
        .filter((name) => {
          // The operator dir is NOT an agent. Excluding it here is
          // defence-in-depth: even if the operator bind mount exists,
          // it must never be bound as a per-agent listener (which
          // would skip the deny-by-default operator allowlist).
          if (name === KERNEL_OPERATOR_NAME) return false;
          try {
            const p = resolve(socketParent, name);
            return statSync(p).isDirectory();
          } catch { return false; }
        })
        .sort();
    }
  } catch (err) {
    process.stderr.write(`approval-kernel: dir scan failed (${(err as Error).message})\n`);
  }
  // Secondary: if no mounted dirs, fall through to config (useful when
  // running outside docker, e.g. unit tests or systemd-on-host).
  if (agents.length === 0) {
    try {
      const { loadConfig } = await import("../../config/loader.js");
      const config = loadConfig(configPath);
      agents = Object.keys(config.agents ?? {}).sort();
    } catch (err) {
      process.stderr.write(`approval-kernel: loadConfig failed (${(err as Error).message}); falling back to single-socket mode\n`);
    }
  }

  if (agents.length === 0) {
    // Fallback single-socket mode: the legacy default path used by tests
    // and by environments where config-driven enumeration isn't ready.
    // Identity in this mode is "the agent name embedded in the socket
    // basename" — i.e. /run/switchroom/kernel/<name>.sock or just the
    // resolved socket path.
    const fallbackName = basename(socketEnv).replace(/\.sock$/, "");
    process.umask(0o077);
    mkdirSync(socketParent, { recursive: true, mode: 0o755 });
    try { chmodSync(socketParent, 0o755); } catch { /* idempotent */ }
    const db = openKernelDb(dbPath);
    const socketPath = resolve(socketEnv);
    if (existsSync(socketPath)) { try { unlinkSync(socketPath); } catch { /* ignore */ } }
    const server = net.createServer((sock) => handleConnection(sock, fallbackName, db));
    await new Promise<void>((resolveP, rejectP) => {
      server.on("error", rejectP);
      server.listen(socketPath, () => {
        try { chmodSync(socketPath, 0o660); } catch { /* ignore */ }
        resolveP();
      });
    });
    process.stdout.write(`approval-kernel: listening on ${socketPath} (fallback mode, no per-agent dirs)\n`);
    registerShutdown(() => {
      try { server.close(); } catch { /* ignore */ }
      try { if (existsSync(socketPath)) unlinkSync(socketPath); } catch { /* ignore */ }
      try { db.close(); } catch { /* ignore */ }
    });
    return;
  }

  const handle = await bootstrap({ socketParent, agents, dbPath, operatorUid });
  for (const l of handle.listeners) {
    process.stdout.write(`approval-kernel: listening agent=${l.agent} sock=${l.socketPath}\n`);
  }
  registerShutdown(() => handle.stop());
}

function registerShutdown(stop: () => void): void {
  let shuttingDown = false;
  const handler = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    try { stop(); } catch { /* best-effort */ }
    process.exit(0);
  };
  process.on("SIGTERM", handler);
  process.on("SIGINT", handler);
}

// Entry guard — only run main() when this file is invoked directly as the
// approval-kernel bundle (dist/vault/approvals/kernel-server.js or src/vault/
// approvals/kernel-server.ts). Without the filename check, when this module
// is bundled INTO another entry point (e.g. dist/cli/switchroom.js), bun's
// bundler rewrites `import.meta.url` to point at the OUTPUT bundle and the
// naive comparison fires for any CLI invocation. See PR #807 / Phase 3a CI fix.
if (
  import.meta.url === `file://${process.argv[1]}` &&
  /(?:^|[/\\])(?:vault[/\\]approvals[/\\])?kernel-server\.(?:js|ts)$/.test(
    process.argv[1] ?? "",
  )
) {
  main().catch((err) => {
    process.stderr.write(`approval-kernel fatal: ${err instanceof Error ? err.stack : err}\n`);
    process.exit(1);
  });
}
