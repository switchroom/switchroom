/**
 * switchroom-hostd wire protocol — newline-delimited JSON (NDJSON).
 *
 * Frame format mirrors the vault broker (`src/vault/broker/protocol.ts`):
 *   - One JSON object per line, terminated by "\n".
 *   - Maximum 64 KiB per frame.
 *   - One request → one response per connection turn.
 *
 * v1 (Phase 1) implements three verbs:
 *   - `agent_restart` — bounce one agent. Self-targeting works for any
 *      caller; cross-agent requires the caller is admin-flagged.
 *   - `upgrade_status` — read-only `switchroom update --status` proxy.
 *   - `get_status`    — look up an in-flight or recently-completed
 *                       mutation by request_id (paired-with the
 *                       async `started`-result pattern).
 *
 * v2 (Phase 2, #1208) extends the verb set with:
 *   - `update_check`  (read-only `switchroom update --check` proxy)
 *   - `update_apply`  (mutating; fleet-mutation-locked)
 *   - `apply`         (mutating; fleet-mutation-locked)
 *   - `agent_start`   (per-service; self OR admin)
 *   - `agent_stop`    (per-service; self OR admin)
 * `reconcile` was dropped from the original deferral list — no
 * underlying `switchroom reconcile` CLI verb exists; `apply` covers
 * the intent.
 *
 * See docs/rfcs/host-control-daemon.md for the full verb table and
 * trust posture.
 */

import { z } from "zod";

// ─── Constants ─────────────────────────────────────────────────────────────

/** Hard limit on the encoded length of a single NDJSON frame. */
export const MAX_FRAME_BYTES = 64 * 1024;

/**
 * Idempotency window for `idempotency_key` deduplication, in
 * milliseconds. Pinned to the gateway's existing restart-marker
 * debounce (`telegram-plugin/gateway/gateway.ts:7836`) so a
 * double-tap that gets debounced at the gateway layer doesn't slip
 * through to the daemon and vice versa. If the gateway constant
 * gets tuned, this one moves with it.
 */
export const IDEMPOTENCY_WINDOW_MS = 15_000;

// ─── Request schemas ──────────────────────────────────────────────────────

const RequestEnvelope = {
  v: z.literal(1),
  /** Client-generated correlation ID. Daemon echoes in responses
   *  and in audit rows. Lets `get_status` look up the right entry. */
  request_id: z.string().min(1).max(128),
  /** Optional dedup key — daemon swallows duplicate requests within
   *  IDEMPOTENCY_WINDOW_MS. Defaults to `request_id` when omitted. */
  idempotency_key: z.string().min(1).max(128).optional(),
};

export const AgentRestartRequestSchema = z.object({
  ...RequestEnvelope,
  op: z.literal("agent_restart"),
  args: z.object({
    name: z
      .string()
      .regex(
        /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/,
        "agent name must be kebab-case ASCII",
      ),
    reason: z.string().max(512).optional(),
    force: z.boolean().optional(),
  }),
});

export const UpgradeStatusRequestSchema = z.object({
  ...RequestEnvelope,
  op: z.literal("upgrade_status"),
  args: z.object({}).optional(),
});

export const GetStatusRequestSchema = z.object({
  ...RequestEnvelope,
  op: z.literal("get_status"),
  args: z.object({
    /** Look up status of a prior `agent_restart` (etc.) by its
     *  original request_id. Distinct from the envelope's
     *  `request_id`, which identifies *this* `get_status` call. */
    target_request_id: z.string().min(1).max(128),
  }),
});

// ─── Phase 2 verbs (#1175 RFC §10) ─────────────────────────────────────────

/** Re-used name validator. Matches the kebab-case ASCII rule the
 *  agent_restart verb established. */
const AgentNameSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, "agent name must be kebab-case ASCII");

export const UpdateCheckRequestSchema = z.object({
  ...RequestEnvelope,
  op: z.literal("update_check"),
  args: z.object({}).optional(),
});

export const UpdateApplyRequestSchema = z.object({
  ...RequestEnvelope,
  op: z.literal("update_apply"),
  args: z
    .object({
      /** Skip the `docker compose pull` step at the start of update.
       *  Mirrors `switchroom update --skip-images`. Useful when the
       *  local images are already at the desired tag and the operator
       *  only wants the scaffold + recreate parts. */
      skip_images: z.boolean().optional(),
      /** Source-checkout users: also run `git pull && npm run build`
       *  before the compose recreate. Mirrors `switchroom update --rebuild`. */
      rebuild: z.boolean().optional(),
      /** One-shot release-channel override. Mirrors `switchroom update
       *  --channel`. Mutually exclusive with `pin` (enforced server-side
       *  in dispatch). */
      channel: z.enum(["dev", "rc", "latest"]).nullable().optional(),
      /** One-shot release-pin override. Mirrors `switchroom update --pin`.
       *  Mutually exclusive with `channel`. */
      pin: z
        .string()
        .regex(/^(sha-[0-9a-f]{7,40}|v\d+\.\d+\.\d+)$/)
        .nullable()
        .optional(),
    })
    .optional(),
});

export const ApplyRequestSchema = z.object({
  ...RequestEnvelope,
  op: z.literal("apply"),
  args: z.object({}).optional(),
});

export const AgentStartRequestSchema = z.object({
  ...RequestEnvelope,
  op: z.literal("agent_start"),
  args: z.object({
    name: AgentNameSchema,
  }),
});

export const AgentStopRequestSchema = z.object({
  ...RequestEnvelope,
  op: z.literal("agent_stop"),
  args: z.object({
    name: AgentNameSchema,
    // Note: `switchroom agent stop` does NOT currently accept a
    // `--force` flag (src/cli/agent.ts has no such option). An earlier
    // draft of this schema exposed it; PR #1208 review (B1) flagged
    // that plumbing `--force` to the spawned CLI would cause commander
    // to reject the unknown option and the verb to exit non-zero. If
    // drain-skip semantics get added to the CLI later, reintroduce the
    // field here in lockstep.
  }),
});

// ─── Phase 3 verbs — admin observability (this PR) ────────────────────────
//
// Adds the two verbs an admin agent needs to actually be useful as a
// peer operator on the fleet: read another agent's logs, and run a
// read-only inspection command inside another agent's container.
// Both are admin-gated (self-target is fine for symmetry with the
// Phase-2 agent_{start,stop,restart} verbs, but the interesting use
// case is cross-agent). Mutations inside the peer container are
// deferred to a follow-up PR that adds the `host_os.exec` scope to the
// approval-kernel (see docs/rfcs/approval-kernel.md §6).

/** `docker logs --tail <n> <agent>` — synchronous, read-only. */
export const AgentLogsRequestSchema = z.object({
  ...RequestEnvelope,
  op: z.literal("agent_logs"),
  args: z.object({
    name: AgentNameSchema,
    /** Number of trailing lines to return (default 100, max 2000). */
    tail: z.number().int().positive().max(2000).optional(),
  }),
});

/** `docker exec <agent> <cmd>` — synchronous; command must be on the
 *  read-only inspection allowlist enforced by the daemon. Writes are
 *  rejected pending the approval-kernel scope work. */
export const AgentExecRequestSchema = z.object({
  ...RequestEnvelope,
  op: z.literal("agent_exec"),
  args: z.object({
    name: AgentNameSchema,
    /** Command + args as a list, e.g. ["ls", "-la", "/state"]. argv[0]
     *  is the program; argv[1..] are its arguments. */
    argv: z.array(z.string().min(1)).min(1).max(32),
  }),
});

export const RequestSchema = z.discriminatedUnion("op", [
  AgentRestartRequestSchema,
  UpgradeStatusRequestSchema,
  GetStatusRequestSchema,
  UpdateCheckRequestSchema,
  UpdateApplyRequestSchema,
  ApplyRequestSchema,
  AgentStartRequestSchema,
  AgentStopRequestSchema,
  AgentLogsRequestSchema,
  AgentExecRequestSchema,
]);

export type AgentRestartRequest = z.infer<typeof AgentRestartRequestSchema>;
export type UpgradeStatusRequest = z.infer<typeof UpgradeStatusRequestSchema>;
export type GetStatusRequest = z.infer<typeof GetStatusRequestSchema>;
export type UpdateCheckRequest = z.infer<typeof UpdateCheckRequestSchema>;
export type UpdateApplyRequest = z.infer<typeof UpdateApplyRequestSchema>;
export type ApplyRequest = z.infer<typeof ApplyRequestSchema>;
export type AgentStartRequest = z.infer<typeof AgentStartRequestSchema>;
export type AgentStopRequest = z.infer<typeof AgentStopRequestSchema>;
export type AgentLogsRequest = z.infer<typeof AgentLogsRequestSchema>;
export type AgentExecRequest = z.infer<typeof AgentExecRequestSchema>;
export type HostdRequest = z.infer<typeof RequestSchema>;

/** All verb names that pass discriminated-union validation. New verbs
 *  added in Phase 2+ must be unioned in here. */
export type HostdVerb = HostdRequest["op"];

// ─── Response schemas ─────────────────────────────────────────────────────

/**
 * Result classification:
 *   - `started`   — verb is mutating; daemon spawned the work and
 *                   returned this frame as an acknowledgement. Caller
 *                   should poll `get_status` for completion.
 *   - `completed` — verb finished synchronously within the response
 *                   window (read-only verbs, or fast mutations).
 *   - `denied`    — auth / verb-allowlist / idempotency-dedupe.
 *                   `exit_code` is null.
 *   - `error`     — daemon failed to dispatch the verb (CLI binary
 *                   missing, OOM, etc.). `exit_code` is null.
 */
export const ResultSchema = z.enum(["started", "completed", "denied", "error"]);
export type Result = z.infer<typeof ResultSchema>;

const ResponseEnvelope = {
  v: z.literal(1),
  request_id: z.string().min(1).max(128),
  result: ResultSchema,
  /** Process exit code when known; null for `started`/`denied`/`error`. */
  exit_code: z.number().int().nullable(),
  duration_ms: z.number().int().nonnegative(),
  /** ISO-8601 timestamp of the audit row this response was written
   *  to. Used for forensic correlation with the audit log. */
  audit_id: z.string().min(1).optional(),
  /** Last 4 KiB of stdout (for completed/error responses). */
  stdout_tail: z.string().optional(),
  /** Last 4 KiB of stderr. */
  stderr_tail: z.string().optional(),
  /** Operator-visible error message for `denied` / `error`. */
  error: z.string().optional(),
};

export const ResponseSchema = z.object(ResponseEnvelope);
export type HostdResponse = z.infer<typeof ResponseSchema>;

// ─── Framing helpers (mirror src/vault/broker/protocol.ts) ────────────────

export function encodeRequest(req: HostdRequest): string {
  const json = JSON.stringify(req);
  if (Buffer.byteLength(json, "utf8") > MAX_FRAME_BYTES) {
    throw new Error(
      `hostd: request frame too large (${Buffer.byteLength(json, "utf8")} bytes; max ${MAX_FRAME_BYTES})`,
    );
  }
  return json + "\n";
}

export function decodeRequest(line: string): HostdRequest {
  if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) {
    throw new RangeError(
      `hostd: request frame too large (${Buffer.byteLength(line, "utf8")} bytes; max ${MAX_FRAME_BYTES})`,
    );
  }
  const obj = JSON.parse(line);
  return RequestSchema.parse(obj);
}

export function encodeResponse(resp: HostdResponse): string {
  const json = JSON.stringify(resp);
  if (Buffer.byteLength(json, "utf8") > MAX_FRAME_BYTES) {
    throw new Error(
      `hostd: response frame too large (${Buffer.byteLength(json, "utf8")} bytes; max ${MAX_FRAME_BYTES})`,
    );
  }
  return json + "\n";
}

export function decodeResponse(line: string): HostdResponse {
  if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) {
    throw new RangeError(
      `hostd: response frame too large (${Buffer.byteLength(line, "utf8")} bytes; max ${MAX_FRAME_BYTES})`,
    );
  }
  const obj = JSON.parse(line);
  return ResponseSchema.parse(obj);
}

export function deniedResponse(
  request_id: string,
  error: string,
  duration_ms = 0,
): HostdResponse {
  return {
    v: 1,
    request_id,
    result: "denied",
    exit_code: null,
    duration_ms,
    error,
  };
}

export function errorResponse(
  request_id: string,
  error: string,
  duration_ms = 0,
): HostdResponse {
  return {
    v: 1,
    request_id,
    result: "error",
    exit_code: null,
    duration_ms,
    error,
  };
}
