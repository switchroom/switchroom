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
 * Phase 3 (#1175 RFC §10) adds `agent_logs` / `agent_exec` (admin
 * observability). Phase 3.1 (this PR) adds:
 *   - `doctor`        (read-only host-side `switchroom doctor` →
 *                       full-fleet health; same posture as
 *                       `update_check`)
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
     *  is the program; argv[1..] are its arguments. argv[0] is
     *  allowlist-gated and every element is charclass/length-gated
     *  server-side — see isAllowlistedReadOnlyArgv +
     *  isSafeExecArgvElement / MAX_EXEC_ARGV_ELEMENT_BYTES in
     *  host-control/server.ts (#1401 / #1400 target 3). The wire
     *  schema stays permissive-but-bounded; the security charclass is
     *  enforced at dispatch so the denial carries a clear reason. */
    argv: z.array(z.string().min(1)).min(1).max(32),
  }),
});

// ─── Phase 3.1 verb — read-only fleet doctor (this PR) ────────────────────
//
// `switchroom doctor` run host-side, where the docker socket is
// present, so it produces the *full fleet* health view (containers,
// singletons, image/CLI ages) instead of the degraded in-container
// reading an agent gets when it shells `switchroom doctor` itself
// (no docker socket in the agent container). Read-only — same trust
// posture as `update_check`/`upgrade_status`: no fleet-mutation lock,
// returns `completed` synchronously. Gateway only surfaces the
// whole-fleet option on admin agents; the daemon is the audited
// boundary regardless.
export const DoctorRequestSchema = z.object({
  ...RequestEnvelope,
  op: z.literal("doctor"),
  args: z.object({}).optional(),
});

/**
 * Read-only in-agent liveness battery. hostd `docker exec`s a FIXED
 * set of presence/validity probes inside the target agent container
 * (auth creds present, scheduler block + sidecar, .mcp.json /
 * .claude.json valid, bot-token present, /state writable). Every
 * probe returns only a boolean/state — NEVER a secret value. `deep`
 * opts into a real, quota-costing `claude -p` auth smoke; the default
 * makes NO model call (subscription-honest). Self-target is allowed;
 * cross-agent requires admin (mirrors agent_logs/agent_exec). The
 * doctor CLI (operator socket) + Telegram /doctor consume this to
 * upgrade the WS6-F2 host-unverifiable `skip` rows to real ok/fail;
 * a down container / unreachable hostd degrades to skip, never fail.
 */
export const AgentSmokeRequestSchema = z.object({
  ...RequestEnvelope,
  op: z.literal("agent_smoke"),
  args: z.object({
    name: AgentNameSchema,
    deep: z.boolean().optional(),
  }),
});

// ─── PR 1a (admin-agent-config-edit RFC §3.1) ─────────────────────────────
//
// `config_propose_edit` — admin agent proposes a unified-diff patch
// against `/state/config/switchroom.yaml`. PR 1a wires the wire shape
// + dispatcher stub only; the validation pipeline (PR 1b) and apply
// path (PR 1c) follow. Until then the dispatcher returns either
// `E_CONFIG_EDIT_DISABLED` (flag off) or `E_NOT_IMPLEMENTED` (flag on).
//
// Inputs mirror RFC §3.1: a unified diff body, a human-readable
// rationale rendered onto the operator approval card in PR 1c, and an
// explicit `target_path` that MUST equal the canonical config path —
// future-proofing against accidental multi-file diffs and giving the
// validator (PR 1b) a single load-bearing path string to anchor on.
export const ConfigProposeEditRequestSchema = z.object({
  ...RequestEnvelope,
  op: z.literal("config_propose_edit"),
  args: z.object({
    /** Unified diff against switchroom.yaml. Wire layer bounds the
     *  envelope; structural validation (≥3 lines context, no path
     *  traversal, LF-only, ≤1 MB) is PR 1b's job. */
    unified_diff: z.string().min(1).max(MAX_FRAME_BYTES - 1024),
    /** Operator-visible justification rendered on the approval card.
     *  Hard-capped at 500 chars per RFC §3.3. */
    reason: z.string().min(1).max(500),
    /** Must be the canonical path. Rejected dispatcher-side if not —
     *  this is a defense-in-depth check on top of PR 1b's diff-path
     *  validation. */
    target_path: z.literal("/state/config/switchroom.yaml"),
  }),
});

/**
 * Error codes returned by `config_propose_edit`. Stubbed wire vocabulary
 * for PR 1a — only the first two are reachable today; the rest are
 * declared up-front so callers (and the eventual approval-card
 * renderer) can switch on a stable enum once 1b/1c fill them in.
 *
 *   E_CONFIG_EDIT_DISABLED — `hostd.config_edit_enabled` is false (PR 1a)
 *   E_NOT_IMPLEMENTED      — flag on but the apply path isn't shipped (PR 1a)
 *   E_VALIDATION_REJECTED  — diff shape / path / encoding (PR 1b)
 *   E_SCHEMA_REJECTED      — post-patch yaml fails zod (PR 1b)
 *   E_APPLY_REJECTED       — `git apply --check` against live file failed (PR 1c)
 *   E_RATE_LIMITED         — per-agent token bucket exhausted (PR 1c)
 *   E_RECONCILE_FAILED     — `switchroom apply` exited non-zero post-write (PR 1c)
 *   E_DENIED               — operator tapped Deny (PR 1c)
 *   E_EXPIRED              — 10-minute timeout (PR 1c)
 */
export const CONFIG_PROPOSE_EDIT_ERROR_CODES = [
  "E_CONFIG_EDIT_DISABLED",
  "E_NOT_IMPLEMENTED",
  "E_VALIDATION_REJECTED",
  "E_SCHEMA_REJECTED",
  "E_APPLY_REJECTED",
  "E_RATE_LIMITED",
  "E_RECONCILE_FAILED",
  "E_DENIED",
  "E_EXPIRED",
] as const;
export type ConfigProposeEditErrorCode =
  (typeof CONFIG_PROPOSE_EDIT_ERROR_CODES)[number];

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
  DoctorRequestSchema,
  AgentSmokeRequestSchema,
  ConfigProposeEditRequestSchema,
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
export type DoctorRequest = z.infer<typeof DoctorRequestSchema>;
export type AgentSmokeRequest = z.infer<typeof AgentSmokeRequestSchema>;
export type ConfigProposeEditRequest = z.infer<typeof ConfigProposeEditRequestSchema>;
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
