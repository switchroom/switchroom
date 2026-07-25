/**
 * Gated-write approval policy — the single predicate every gated write
 * hook uses to turn an `approval_lookup` answer into allow / don't-allow.
 *
 * ── Why this exists (the self-approval bypass) ────────────────────────
 *
 * Before this module, `src/cli/drive-write-pretool.ts` and
 * `src/cli/ms-365-write-pretool.ts` allowed the tool call on
 * `state === "granted"` alone. `state` says a decision row EXISTS and is
 * live; it says NOTHING about who wrote it. An agent on its own
 * legitimate per-agent kernel socket can write one itself:
 *
 *   1. `approval_request { agent_unit: <self>, scope, action }` → request_id
 *   2. `approval_consume_record { request_id, decision: "allow_always", … }`
 *
 * Both ops pass `checkApprovalAclByAgent` (`src/vault/approvals/acl.ts:39`),
 * which only enforces `claim === listener` — that blocks CROSS-agent
 * forgery, not SELF-forgery. The next `approval_lookup` then returns
 * `granted` and the hook allows the write. No card was posted; no human
 * tapped.
 *
 * The distinguishing fact is `approval_decisions.origin`
 * (`src/vault/approvals/kernel.ts:544`), stamped server-side from the
 * bound listener (`kernel-server.ts:listenerOrigin`) and now surfaced on
 * the lookup response (`kernel-server.ts` approval_lookup /
 * approval_lookup_by_request). `origin='operator'` is the only value that
 * is proof of a human tap.
 *
 * ── Why the requirement is flag-gated (READ THIS BEFORE FLIPPING IT) ──
 *
 * Nothing in the shipped runtime can currently produce `origin='operator'`.
 * The genuine tap path is the Telegram callback
 * (`telegram-plugin/gateway/approval-callback.ts:134` →
 * `approvalConsumeRecord`), and the gateway runs in the SAME container,
 * as the SAME uid, over the SAME per-agent socket as claude
 * (`src/agents/compose.ts`: one `agent` service, one
 * `kernel-<agent>-sock` volume; `docker/Dockerfile.agent:349` `USER
 * 10001`). The kernel therefore cannot tell the two apart, so every
 * decision it records is honestly `origin='agent'`.
 *
 * To be precise about WHY, because "there is no signal" would be false:
 * a signal exists and is UNUSABLE. The kernel already captures
 * SO_PEERCRED at accept(2) (`kernel-server.ts:handleConnection`), and
 * `getPeerCred` returns `{pid, uid, gid}`
 * (`src/vault/broker/peercred-ffi.ts:42-46`) — the kernel keeps the uid
 * for audit and deliberately discards the pid as forensic-only. Keeping
 * the pid would not help:
 *   - same uid ⇒ claude can read `/proc/<gateway-pid>/environ`, ptrace
 *     the gateway, or exec a process whose exe path matches it, so ANY
 *     pid→identity mapping is forgeable by the exact process it is meant
 *     to distrust; and
 *   - the kernel runs in its own PID namespace, so a peer pid from the
 *     agent container is not even translatable to something it could
 *     inspect.
 * Provenance needs a channel boundary, not a better fingerprint.
 *
 * Consequence: with `SWITCHROOM_REQUIRE_OPERATOR_APPROVAL_WRITE=1`, the
 * self-approval bypass is closed — AND every legitimate Telegram approval
 * for a gated Drive / M365 write is also refused, because it is
 * indistinguishable from the forgery. Default-on would be a silent,
 * total denial of a shipped feature, so the default is OFF and this
 * comment is the honest reason. The flag becomes the correct default the
 * moment the host-side approval verifier (RFC
 * vault-approval-hard-boundary PR ②) starts writing operator-origin rows
 * on a channel claude cannot reach.
 *
 * That follow-up is NOT greenfield: the claude-unreachable channel
 * already exists. `bindOperatorSocket` binds
 * `/run/switchroom/kernel/operator/sock` 0600 to the host operator uid,
 * mounted only into the kernel container (`src/agents/compose.ts:1686`),
 * and it is read-only by an explicitly pinned contract —
 * `OPERATOR_ALLOWED_OPS = {approval_list}` (`kernel-server.ts`), asserted
 * in `kernel-operator-acl.test.ts`. So the RFC's work is (a) grant that
 * socket a write op with a per-op authorization story, and (b) relocate
 * the tap consumer OUT of the agent container so it can reach that
 * socket. `listenerOrigin()` is already the single function that would
 * then start returning 'operator'. Same reasoning applies to the
 * broker's sibling `SWITCHROOM_REQUIRE_OPERATOR_APPROVAL_MINT`
 * (`src/vault/broker/server.ts`), which stays default-off for the
 * identical reason.
 *
 * Everything here is PURE so the security outcome is unit-testable
 * without a kernel, a socket, or a container.
 */

/** Env flag that turns on the operator-verified requirement. */
export const REQUIRE_OPERATOR_WRITE_ENV =
  "SWITCHROOM_REQUIRE_OPERATOR_APPROVAL_WRITE";

/** The `origin` values a kernel may report. `undefined` ⇒ old kernel. */
export type ApprovalOrigin = "agent" | "operator" | undefined;

export interface GatedWriteLookup {
  /** `state` from approval_lookup (`null` ⇒ kernel unreachable/malformed). */
  state: string | null;
  /** `decision.origin` from the same response, if the kernel reported one. */
  origin?: ApprovalOrigin;
}

export type GatedWriteVerdict =
  | { allow: true }
  | { allow: false; reason: string };

/**
 * Is `SWITCHROOM_REQUIRE_OPERATOR_APPROVAL_WRITE` on?
 *
 * Strict `"1"` — matches the broker's mint-gate flag check
 * (`src/vault/broker/server.ts`). Anything else (unset, "0", "true",
 * "yes") is OFF, deliberately: a security flag with fuzzy parsing is a
 * flag nobody can reason about.
 */
export function requireOperatorApprovalForWrites(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[REQUIRE_OPERATOR_WRITE_ENV] === "1";
}

/**
 * Decide whether a gated write may proceed.
 *
 * `allow: true` requires BOTH:
 *   - `state === "granted"` (a live, un-revoked, un-drifted decision), and
 *   - when the operator requirement is on, `origin === "operator"` — an
 *     `'agent'` or MISSING origin fails closed (a pre-origin kernel cannot
 *     prove a tap, so it is treated exactly like a self-recorded row).
 */
export function isGatedWriteApproved(
  lookup: GatedWriteLookup,
  requireOperator: boolean,
): GatedWriteVerdict {
  if (lookup.state !== "granted") {
    return { allow: false, reason: `approval state is '${lookup.state ?? "unknown"}', not 'granted'` };
  }
  if (!requireOperator) return { allow: true };
  if (lookup.origin !== "operator") {
    return {
      allow: false,
      reason:
        `approval was recorded with origin='${lookup.origin ?? "unknown"}', not 'operator' — ` +
        `an agent-origin decision is not proof an operator tapped ` +
        `(${REQUIRE_OPERATOR_WRITE_ENV}=1)`,
    };
  }
  return { allow: true };
}

/**
 * Three-way outcome for a gated-write approval lookup, used at EVERY
 * gate site in both write hooks.
 *
 * Why a shared classifier and not an inline `if` per site: the write
 * hooks check approval in two places each (the pre-card fast path and
 * the post-card poll loop), and a per-site inline check is one careless
 * refactor away from being dropped at exactly one of them — the review
 * of #3598 mutation-tested precisely that and found the poll-loop site
 * deletable with the whole suite green. Routing every site through one
 * exported, unit-tested function makes the enforcement logic itself
 * covered no matter which caller invokes it, and leaves the call sites
 * with nothing to get wrong beyond calling it.
 *
 *   - `allow`  — proceed with the tool call.
 *   - `block`  — refuse NOW, with a reason. This includes the security
 *                case (a live grant that is not operator-verified): once
 *                seen it can never become allowable, so callers must not
 *                keep polling on it.
 *   - `wait`   — no verdict yet (pending / no decision / kernel
 *                unreachable). Caller keeps polling or posts a card.
 *
 * Terminal non-grant states (denied / expired / drift_revoked) are
 * returned as `wait` on purpose: each hook already has its own bespoke
 * handling and messaging for those (ms-365 consults its batch ledger),
 * and this function's job is the provenance decision, not to take that
 * over. Callers check them after this returns non-`allow`.
 */
export type GatedWriteAction =
  | { kind: "allow" }
  | { kind: "block"; reason: string }
  | { kind: "wait" };

export function evaluateGatedWrite(
  lookup: GatedWriteLookup,
  requireOperator: boolean,
): GatedWriteAction {
  const verdict = isGatedWriteApproved(lookup, requireOperator);
  if (verdict.allow) return { kind: "allow" };
  // A live grant that failed the predicate failed it on PROVENANCE — the
  // only other way to fail is a non-granted state. Refuse immediately:
  // polling on it would burn the whole hook deadline (and, in the Drive
  // hook, post an approval card the operator would see and which would
  // then be self-refused) waiting for a verdict that already exists.
  if (lookup.state === "granted") return { kind: "block", reason: verdict.reason };
  return { kind: "wait" };
}
