/**
 * Short-poll wait helper for approval-kernel consumers (RFC C follow-up).
 *
 * Wraps {@link approvalRequest} + {@link approvalLookup} with an exponential
 * backoff polling loop so CLI/wrapper consumers (drive-cli etc.) can express
 * "block until the user decides, or give up" without re-implementing the loop.
 *
 * Cancel semantics
 * ----------------
 * On {@link AbortSignal} cancel mid-wait we DO NOT call `approval_revoke`.
 *
 *   - Revoke targets a recorded *decision_id* (a granted/denied row). While
 *     the request is still pending there is nothing to revoke — only a
 *     `request_id` nonce, which the broker GCs automatically when the request
 *     TTL elapses.
 *   - If a decision lands in the same tick we abort, the pending nonce will
 *     still expire on its own per the request TTL; the next consume attempt
 *     will see `consumed:false`.
 *   - Auto-revoking a freshly-granted permission would also be surprising:
 *     the user's tap stands on its own, and a separate consumer may legitimately
 *     pick it up. Callers that truly want revoke-on-cancel should call
 *     {@link approvalRevoke} themselves on the returned decision.
 *
 * Net: lean on nonce TTL expiry rather than racing the broker. Result surface
 * for cancel is `{ kind: "aborted" }`.
 */

import {
  approvalLookup,
  approvalRequest,
  type ApprovalLookupResult,
} from "./client.js";
import type { BrokerClientOpts } from "../broker/client.js";
import type { ApprovalDecisionMeta } from "../broker/protocol.js";
import {
  isGatedWriteApproved,
  requireOperatorApprovalForWrites,
} from "./gated-write-policy.js";

export interface WaitForApprovalOpts {
  agent_unit: string;
  scope: string;
  action: string;
  approver_set: string[];
  why?: string;
  /** TTL on the request_id nonce. Defaults to broker default. */
  request_ttl_ms?: number;
  /**
   * Total time to wait for a decision. Defaults to the configured operator
   * approval-card lifetime (`channels.telegram.approval_timeout_minutes` →
   * `SWITCHROOM_TG_APPROVAL_TIMEOUT_MS`), falling back to 3_600_000 (60 min).
   */
  timeout_ms?: number;
  /** External cancellation. Resolves to `{ kind: "aborted" }`. */
  signal?: AbortSignal;
  /** First poll interval (ms). Default 2000. */
  initial_poll_ms?: number;
  /** Max poll interval after backoff (ms). Default 30000. */
  max_poll_ms?: number;
  /** Backoff multiplier per poll. Default 1.5. */
  backoff?: number;
  /** Broker IPC opts (socket path override etc.). */
  broker?: BrokerClientOpts;
  /** Test seam: substitute the request impl. */
  _request?: typeof approvalRequest;
  /** Test seam: substitute the lookup impl. */
  _lookup?: typeof approvalLookup;
  /** Test seam: substitute the sleep impl. */
  _sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export type WaitForApprovalResult =
  | {
      kind: "decided";
      state: "granted" | "denied";
      decision: ApprovalDecisionMeta;
      request_id: string;
    }
  | { kind: "rate_limited"; retry_after_ms: number }
  | { kind: "expired"; request_id: string }
  | { kind: "drift_revoked"; request_id: string }
  | { kind: "timeout"; request_id: string }
  | { kind: "aborted"; request_id?: string }
  | {
      kind: "error";
      reason:
        | "broker_unreachable"
        | "missing_decision"
        /**
         * The decision is live and granted, but was recorded with
         * `origin != 'operator'` while
         * `SWITCHROOM_REQUIRE_OPERATOR_APPROVAL_WRITE=1` — i.e. it is not
         * proof an operator tapped, and may be the agent's own
         * self-recorded row (see gated-write-policy.ts). Reported as an
         * error rather than "denied" so the caller doesn't mis-tell the
         * user a human refused them; every caller's `error` branch fails
         * closed. Unreachable while the flag is off (the default).
         */
        | "not_operator_verified";
    };

/** Fallback wait when neither `timeout_ms` nor config is set: 60 min. */
const FALLBACK_TIMEOUT_MS = 60 * 60_000;

/**
 * Resolve the default decision-wait from config (threaded as
 * `SWITCHROOM_TG_APPROVAL_TIMEOUT_MS` — see scaffold.ts `channelsToEnv`), so
 * the vault grant wait tracks the same operator approval-card lifetime as the
 * tool-use card. A blank/garbage/non-positive value falls back to 60 min.
 */
function resolveDefaultTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.SWITCHROOM_TG_APPROVAL_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") return FALLBACK_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return FALLBACK_TIMEOUT_MS;
  return Math.floor(n);
}

const DEFAULT_INITIAL_POLL_MS = 2_000;
const DEFAULT_MAX_POLL_MS = 30_000;
const DEFAULT_BACKOFF = 1.5;

const DENY_MODES = new Set(["deny", "deny_perm"]);

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "AbortError") return true;
  if (typeof DOMException !== "undefined" && err instanceof DOMException) {
    return err.name === "AbortError";
  }
  return false;
}

/**
 * Issue an approval request and poll until decided / expired / timed out.
 *
 * Behaviour:
 *   - Returns `{ kind: "rate_limited" }` immediately if the broker caps fire.
 *   - Otherwise polls at `initial_poll_ms`, multiplying by `backoff` each
 *     iteration up to `max_poll_ms`, until total elapsed exceeds `timeout_ms`.
 *   - Treats transient `null` lookup responses (broker glitch) as continue-poll.
 *   - On `signal.aborted`: returns `{ kind: "aborted" }`. Does NOT revoke any
 *     recorded decision (see file header for rationale).
 */
export async function waitForApproval(
  opts: WaitForApprovalOpts,
): Promise<WaitForApprovalResult> {
  const request = opts._request ?? approvalRequest;
  const lookup = opts._lookup ?? approvalLookup;
  const sleep = opts._sleep ?? defaultSleep;

  const timeoutMs = opts.timeout_ms ?? resolveDefaultTimeoutMs();
  const initialPoll = opts.initial_poll_ms ?? DEFAULT_INITIAL_POLL_MS;
  const maxPoll = opts.max_poll_ms ?? DEFAULT_MAX_POLL_MS;
  const backoff = opts.backoff ?? DEFAULT_BACKOFF;

  if (opts.signal?.aborted) return { kind: "aborted" };

  const reqResult = await request(
    {
      agent_unit: opts.agent_unit,
      scope: opts.scope,
      action: opts.action,
      approver_set: opts.approver_set,
      why: opts.why,
      ttl_ms: opts.request_ttl_ms,
    },
    opts.broker,
  );

  if (reqResult === null) {
    return { kind: "error", reason: "broker_unreachable" };
  }
  if (reqResult.state === "rate_limited") {
    return { kind: "rate_limited", retry_after_ms: reqResult.retry_after_ms };
  }

  const requestId = reqResult.request_id;
  const startedAt = Date.now();
  let pollMs = initialPoll;

  while (true) {
    if (opts.signal?.aborted) return { kind: "aborted", request_id: requestId };

    const elapsed = Date.now() - startedAt;
    const remaining = timeoutMs - elapsed;
    if (remaining <= 0) {
      return { kind: "timeout", request_id: requestId };
    }
    const wait = Math.max(0, Math.min(pollMs, remaining));

    try {
      await sleep(wait, opts.signal);
    } catch (err) {
      if (isAbortError(err)) {
        return { kind: "aborted", request_id: requestId };
      }
      throw err;
    }

    if (opts.signal?.aborted) return { kind: "aborted", request_id: requestId };

    if (Date.now() - startedAt >= timeoutMs) {
      return { kind: "timeout", request_id: requestId };
    }

    const look: ApprovalLookupResult | null = await lookup(
      {
        agent_unit: opts.agent_unit,
        scope: opts.scope,
        action: opts.action,
        current_approver_set: opts.approver_set,
      },
      opts.broker,
    );

    pollMs = Math.min(pollMs * backoff, maxPoll);

    if (look === null) {
      // Broker glitch — keep polling until timeout.
      continue;
    }

    switch (look.state) {
      case "pending":
      case "no_decision":
        continue;
      case "granted": {
        if (!look.decision) {
          return { kind: "error", reason: "missing_decision" };
        }
        // A grant lookup state can still surface a deny mode if the kernel
        // recorded a deny under the same (agent_unit, scope, action). Trust
        // `decision.decision` for the binary outcome.
        const isDeny = DENY_MODES.has(look.decision.decision);
        // Provenance gate (self-approval bypass, #3598): a granted row is
        // only proof of a human tap if the kernel stamped it
        // `origin='operator'`. An agent can mint its own granted row on its
        // own socket (acl.ts:39 blocks cross-agent, not self, forgery), so
        // `state === "granted"` alone cannot authorize. No-op while the
        // flag is off, which is the shipped default.
        if (
          !isDeny &&
          !isGatedWriteApproved(
            { state: "granted", origin: look.decision.origin },
            requireOperatorApprovalForWrites(),
          ).allow
        ) {
          return { kind: "error", reason: "not_operator_verified" };
        }
        return {
          kind: "decided",
          state: isDeny ? "denied" : "granted",
          decision: look.decision,
          request_id: requestId,
        };
      }
      case "denied":
        if (!look.decision) {
          return { kind: "error", reason: "missing_decision" };
        }
        return {
          kind: "decided",
          state: "denied",
          decision: look.decision,
          request_id: requestId,
        };
      case "expired":
        return { kind: "expired", request_id: requestId };
      case "drift_revoked":
        return { kind: "drift_revoked", request_id: requestId };
    }
  }
}
