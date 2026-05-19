/**
 * Approval-kernel IPC client (RFC B §10).
 *
 * Thin wrapper around `rpcRaw` so callers (gateway, CLI commands, agent
 * sub-modules) can talk to the broker's approval ops without hand-encoding
 * JSON. Each helper returns a typed result or `null` when the broker is
 * unreachable — same convention as `BrokerClient`.
 *
 * Discriminant note: the lookup wire response uses `state` (not `status`) to
 * avoid colliding with `BrokerStatus` on the broker response union. The
 * helpers below normalize that field name out for callers.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { rpcRaw, type BrokerClientOpts } from "../broker/client.js";
import type {
  ApprovalDecisionMeta,
  ApprovalDecisionMode,
} from "../broker/protocol.js";

/**
 * Phase 2b — approval-kernel socket resolver.
 *
 * The approval kernel runs as its own container under docker (Phase 1c
 * shipped `kernel-server.ts`). Each agent container has a per-agent kernel
 * socket bind-mounted at `/run/switchroom/kernel/<agent>/sock`, and the
 * compose generator injects this path as `SWITCHROOM_KERNEL_SOCKET` into
 * every agent's environment block (see src/agents/compose.ts).
 *
 * Resolution order — first match wins:
 *   1. Explicit `opts.socket` — caller-supplied override, e.g. integration
 *      tests pointing at a host-bind-mounted kernel socket.
 *   2. `SWITCHROOM_KERNEL_SOCKET` env — set by the docker compose generator
 *      inside agent containers (Phase 2b runtime). Identifies the kernel
 *      container as the target, distinct from the broker.
 *   3. `opts.kernelSocket` — programmatic override matching docker's env
 *      shape; useful for in-process callers that aren't going through env.
 *   4. `null` — host-mode fallback. Caller does NOT receive a kernel-
 *      specific socket; subsequent `rpcRaw` falls through to the legacy
 *      broker socket resolver, preserving today's host-native behaviour
 *      where broker and kernel-ish ops share a socket.
 *
 * IMPORTANT: this resolver returns null in host mode (case 4). Callers
 * should pass-through opts unchanged to `rpcRaw` so the broker resolver
 * picks up. This preserves "host-mode behaviour unchanged" — no callers
 * outside docker need to set anything.
 */
export interface ApprovalKernelClientOpts extends BrokerClientOpts {
  /**
   * Override path for the approval kernel socket. Mirrors the env shape
   * (`SWITCHROOM_KERNEL_SOCKET`) for callers who want to set it in code
   * rather than via the environment.
   */
  kernelSocket?: string;
}

/**
 * Host-side operator socket path — the host end of the compose bind
 * `~/.switchroom/state/kernel-operator → /run/switchroom/kernel/operator`.
 * The kernel restricts this socket to the read-only `approval_list`
 * op, so it is safe for host observers (the web dashboard) but cannot
 * be used for grant/consume/revoke.
 *
 * Deliberately NOT folded into `resolveKernelSocketPath` (which stays a
 * pure env/opts function): host-fs probing inside the shared resolver
 * would make every caller's behaviour depend on whether the operator
 * socket happens to exist on the box. Instead the one host caller (the
 * dashboard's approvals view) probes this explicitly and passes it as
 * `opts.kernelSocket` when present.
 */
export function kernelOperatorSocketPath(home: string = homedir()): string {
  return join(home, ".switchroom", "state", "kernel-operator", "sock");
}

/**
 * Resolve the host operator socket iff it exists, else null. The
 * read-only host caller uses this to decide whether to pass
 * `opts.kernelSocket`; absent ⇒ caller degrades (kernel unreachable
 * from host) rather than silently changing the resolver contract.
 */
export function resolveKernelOperatorSocket(
  home: string = homedir(),
): string | null {
  const p = kernelOperatorSocketPath(home);
  return existsSync(p) ? p : null;
}

export function resolveKernelSocketPath(
  opts?: ApprovalKernelClientOpts,
): string | null {
  if (opts?.socket) return opts.socket;
  const env = process.env.SWITCHROOM_KERNEL_SOCKET;
  if (env && env.length > 0) return env;
  if (opts?.kernelSocket) return opts.kernelSocket;
  return null;
}

/**
 * Build the rpcRaw opts for an approval call. When a kernel-specific
 * socket is in scope (docker mode), we set `opts.socket` to it so rpcRaw
 * connects to the kernel container; otherwise we forward opts unchanged
 * so the broker resolver applies (host mode, unchanged behaviour).
 */
function withKernelOpts(
  opts?: ApprovalKernelClientOpts,
): BrokerClientOpts | undefined {
  const sock = resolveKernelSocketPath(opts);
  if (sock === null) return opts;
  return { ...(opts ?? {}), socket: sock };
}

export interface ApprovalRequestArgs {
  agent_unit: string;
  scope: string;
  action: string;
  approver_set: string[];
  why?: string;
  ttl_ms?: number;
}

export type ApprovalRequestResult =
  | { state: "pending"; request_id: string; expires_at: number }
  | { state: "rate_limited"; retry_after_ms: number };

export type ApprovalLookupState =
  | "granted"
  | "denied"
  | "pending"
  | "expired"
  | "drift_revoked"
  | "no_decision";

export interface ApprovalLookupResult {
  state: ApprovalLookupState;
  decision: ApprovalDecisionMeta | null;
}

export interface ApprovalConsumeResult {
  consumed: boolean;
  agent_unit?: string;
  scope?: string;
  action?: string;
  why?: string | null;
}

/** Result of the atomic consume+record op (PR-6). Superset of
 *  ApprovalConsumeResult — `decision_id` is present only on the
 *  consumed-and-recorded path; `consumed:false` ⇒ no decision written. */
export interface ApprovalConsumeRecordResult {
  consumed: boolean;
  decision_id?: string;
  agent_unit?: string;
  scope?: string;
  action?: string;
  why?: string | null;
}

export async function approvalRequest(
  args: ApprovalRequestArgs,
  opts?: ApprovalKernelClientOpts,
): Promise<ApprovalRequestResult | null> {
  const r = await rpcRaw(
    {
      v: 1,
      op: "approval_request",
      agent_unit: args.agent_unit,
      scope: args.scope,
      action: args.action,
      approver_set: args.approver_set,
      why: args.why,
      ttl_ms: args.ttl_ms,
    },
    withKernelOpts(opts),
  );
  if (r.kind !== "response" || !r.resp.ok) return null;
  if (!("kind" in r.resp) || r.resp.kind !== "approval_request") return null;
  if (r.resp.state === "rate_limited") {
    return { state: "rate_limited", retry_after_ms: r.resp.retry_after_ms };
  }
  return {
    state: "pending",
    request_id: r.resp.request_id,
    expires_at: r.resp.expires_at,
  };
}

export async function approvalLookup(
  args: {
    agent_unit: string;
    scope: string;
    action: string;
    current_approver_set: string[];
  },
  opts?: ApprovalKernelClientOpts,
): Promise<ApprovalLookupResult | null> {
  const r = await rpcRaw(
    {
      v: 1,
      op: "approval_lookup",
      agent_unit: args.agent_unit,
      scope: args.scope,
      action: args.action,
      current_approver_set: args.current_approver_set,
    },
    withKernelOpts(opts),
  );
  if (r.kind !== "response" || !r.resp.ok) return null;
  if (!("state" in r.resp) || typeof r.resp.state !== "string") return null;
  // Approval lookup is the only response with `state: <string>`. The new
  // approval_request response also has `state` but it's still distinguishable
  // by the values; we narrow on the lookup states here.
  const lookupStates = new Set([
    "granted", "denied", "pending", "expired", "drift_revoked", "no_decision",
  ]);
  if (!lookupStates.has(r.resp.state)) return null;
  const lookup = r.resp as {
    state: ApprovalLookupState;
    decision?: ApprovalDecisionMeta | null;
  };
  return {
    state: lookup.state,
    decision: lookup.decision ?? null,
  };
}

export async function approvalConsume(
  request_id: string,
  opts?: ApprovalKernelClientOpts,
): Promise<ApprovalConsumeResult | null> {
  const r = await rpcRaw({ v: 1, op: "approval_consume", request_id }, withKernelOpts(opts));
  if (r.kind !== "response" || !r.resp.ok) return null;
  if (!("consumed" in r.resp)) return null;
  return {
    consumed: r.resp.consumed,
    agent_unit: r.resp.agent_unit,
    scope: r.resp.scope,
    action: r.resp.action,
    why: r.resp.why ?? null,
  };
}

export async function approvalRevoke(
  decision_id: string,
  actor: string,
  reason?: string,
  opts?: ApprovalKernelClientOpts,
): Promise<boolean | null> {
  const r = await rpcRaw(
    { v: 1, op: "approval_revoke", decision_id, actor, reason },
    withKernelOpts(opts),
  );
  if (r.kind !== "response" || !r.resp.ok) return null;
  if (!("revoked" in r.resp)) return null;
  return r.resp.revoked;
}

export async function approvalRecord(
  args: {
    request_id: string;
    decision: ApprovalDecisionMode;
    approver_set: string[];
    granted_by_user_id: number;
    ttl_ms?: number | null;
  },
  opts?: ApprovalKernelClientOpts,
): Promise<string | null> {
  const r = await rpcRaw(
    {
      v: 1,
      op: "approval_record",
      request_id: args.request_id,
      decision: args.decision,
      approver_set: args.approver_set,
      granted_by_user_id: args.granted_by_user_id,
      ttl_ms: args.ttl_ms ?? null,
    },
    withKernelOpts(opts),
  );
  if (r.kind !== "response" || !r.resp.ok) return null;
  if (!("decision_id" in r.resp)) return null;
  // `decision_id` is required on OkApprovalRecord but optional on the
  // structurally-similar OkApprovalConsumeRecord (the response union is
  // a plain z.union, not discriminated), so the narrowed type is
  // string|undefined — coalesce to satisfy the string|null contract.
  return r.resp.decision_id ?? null;
}

/**
 * Atomic consume+record (PR-6). One round-trip; the kernel burns the
 * single-use nonce AND writes the decision in one SQLite transaction.
 * Returns `null` on kernel-unreachable / `!ok` / malformed (caller
 * treats as "kernel unreachable"); `{consumed:false}` ⇒ nonce already
 * burned/expired/unknown ("this prompt expired", no decision);
 * `{consumed:true, decision_id, scope, …}` ⇒ recorded. Mirrors the
 * approvalConsume/approvalRecord wrappers; both of those are kept for
 * their other callers (deferred-secret + /vault-grant dual-dispatch,
 * /folders). On a mixed-version rollout an old kernel rejects the
 * unknown op → `null` → the gateway shows "kernel unreachable" and the
 * shipped permission-TTL auto-deny backstops; switchroom update
 * recreates containers together so the window is seconds.
 */
export async function approvalConsumeRecord(
  args: {
    request_id: string;
    decision: ApprovalDecisionMode;
    approver_set: string[];
    granted_by_user_id: number;
    ttl_ms?: number | null;
  },
  opts?: ApprovalKernelClientOpts,
): Promise<ApprovalConsumeRecordResult | null> {
  const r = await rpcRaw(
    {
      v: 1,
      op: "approval_consume_record",
      request_id: args.request_id,
      decision: args.decision,
      approver_set: args.approver_set,
      granted_by_user_id: args.granted_by_user_id,
      ttl_ms: args.ttl_ms ?? null,
    },
    withKernelOpts(opts),
  );
  if (r.kind !== "response" || !r.resp.ok) return null;
  if (!("consumed" in r.resp)) return null;
  // The response union is a plain z.union and OkApprovalConsumeResponse
  // is structurally a prefix of OkApprovalConsumeRecordResponse, so the
  // `"consumed" in` narrowing keeps both and TS can't see `decision_id`.
  // The kernel only ever returns the consume_record shape for this op
  // and the payload is already zod-validated at the wire boundary —
  // read the fields through a narrow structural view (same trust level
  // as the sibling approvalConsume wrapper).
  const resp = r.resp as {
    consumed: boolean;
    decision_id?: string;
    agent_unit?: string;
    scope?: string;
    action?: string;
    why?: string | null;
  };
  return {
    consumed: resp.consumed,
    decision_id: resp.decision_id,
    agent_unit: resp.agent_unit,
    scope: resp.scope,
    action: resp.action,
    why: resp.why ?? null,
  };
}

export async function approvalList(
  agent_unit?: string,
  opts?: ApprovalKernelClientOpts,
): Promise<ApprovalDecisionMeta[] | null> {
  const r = await rpcRaw({ v: 1, op: "approval_list", agent_unit }, withKernelOpts(opts));
  if (r.kind !== "response" || !r.resp.ok) return null;
  if (!("decisions" in r.resp)) return null;
  return r.resp.decisions as ApprovalDecisionMeta[];
}
