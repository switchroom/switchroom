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
 * See reference/rfcs/host-control-daemon.md for the full verb table and
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
  /**
   * Optional operator-passphrase attestation (#1841, RFC
   * host-control-daemon.md §5.4). Second factor on the mutating verbs:
   * the gateway caches the operator passphrase after `/vault unlock`
   * and plaintext-forwards it here when an admin agent invokes a
   * privileged verb — the SAME plaintext-forward pattern the vault
   * broker already uses for `vault_request_save` (broker
   * `server.ts` PUT/list_grants passphrase path). hostd itself NEVER
   * holds the vault passphrase: it forwards this value over its own
   * admin-client connection to the broker and treats a broker `DENIED`
   * as a gate failure (see `AttestVerifier` in `server.ts`).
   *
   * Present on the envelope so it applies uniformly to every verb;
   * read-only verbs ignore it. `checkGate` only CONSUMES it for verbs
   * the operator has opted into requiring attestation for
   * (`hostd.operator_attest_*`), and it is NEVER persisted to the audit
   * log (only the derived `method: "passphrase-attest"` tag is).
   */
  operator_passphrase: z.string().min(1).max(1024).optional(),
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
      /** Optional operator-facing rationale, surfaced on the approval
       *  card's `why:` line (#2469 contract — the card reads ONLY this
       *  caller-supplied arg, never the schema description). */
      reason: z.string().max(512).optional(),
    })
    .optional(),
});

export const ApplyRequestSchema = z.object({
  ...RequestEnvelope,
  op: z.literal("apply"),
  args: z.object({}).optional(),
});

// ─── PR1 (#2487) — agent-reachable safe staggered rollout ─────────────────
//
// `rollout` exposes `switchroom rollout` — the staggered canary +
// per-agent version-assert + stop-on-mismatch verb — over the wire so an
// admin agent can run a SAFE fleet roll behind a single operator approval
// card (the verb is deliberately omitted from HOSTD_MCP_TOOLS in
// scaffold.ts, so any agent call surfaces a Telegram approval).
//
// Wire-layer safety: `pin` is SEMVER-ONLY here (`^v\d+\.\d+\.\d+$`),
// rejecting `sha-…` pins at decode. A sha pin is a valid release.pin but
// is NOT version-assertable (the in-container `switchroom --version`
// always prints the semver), so it would "mismatch" on agent #1 and stop
// the roll with a confusing message. update_apply still accepts sha pins
// (it doesn't assert versions); rollout does not.
export const RolloutRequestSchema = z.object({
  ...RequestEnvelope,
  op: z.literal("rollout"),
  args: z
    .object({
      /** Semver target to roll the fleet to (e.g. v0.15.18). Required:
       *  a staggered version-assert roll has nothing to assert against
       *  without a concrete tag. SHA pins are rejected at the wire. */
      pin: z.string().regex(/^v\d+\.\d+\.\d+$/),
      /** Comma-free explicit subset of agents to roll. Omit ⇒ all
       *  configured agents (canary-first ordering still applies). */
      agents: z.array(AgentNameSchema).min(1).optional(),
      /** Skip the web refresh step (leaves switchroom-web on the prior
       *  version). On the hostd/MCP path the HOSTD self-refresh is ALWAYS
       *  deferred regardless of this flag (it would SIGKILL the in-flight
       *  rollout — hostd's own child); the WEB refresh runs in-plan there
       *  unless this flag skips it. */
      skip_web: z.boolean().optional(),
      /**
       * Operator-approved rollback to a known-good earlier tag (#2487 PR2).
       * When set, the downgrade guard in `switchroom rollout` is relaxed to
       * permit `--pin <oldtag>` even when that tag is older than the current
       * `release.pin`. All other safety rails (canary order, version-assert,
       * stop-on-mismatch, persist-after-canary, hostd deferral) apply
       * unchanged. Absent ⇒ false (downgrade rejected as before).
       */
      allow_downgrade: z.boolean().optional(),
      /** Optional operator-facing rationale, surfaced on the approval
       *  card's `why:` line (#2469 contract — caller-supplied only). */
      reason: z.string().max(512).optional(),
    })
    .required({ pin: true }),
});

export const AgentStartRequestSchema = z.object({
  ...RequestEnvelope,
  op: z.literal("agent_start"),
  args: z.object({
    name: AgentNameSchema,
    /** Optional operator-facing rationale, surfaced on the approval
     *  card's `why:` line (#2469 contract — caller-supplied only). */
    reason: z.string().max(512).optional(),
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
    /** Optional operator-facing rationale, surfaced on the approval
     *  card's `why:` line (#2469 contract — caller-supplied only). */
    reason: z.string().max(512).optional(),
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
// approval-kernel (see reference/rfcs/approval-kernel.md §6).

/** `docker logs --tail <n> <agent>` — synchronous, read-only. */
export const AgentLogsRequestSchema = z.object({
  ...RequestEnvelope,
  op: z.literal("agent_logs"),
  args: z.object({
    name: AgentNameSchema,
    /** Number of trailing lines to return (default 100, max 2000). */
    tail: z.number().int().positive().max(2000).optional(),
    /** Optional operator-facing rationale, surfaced on the approval
     *  card's `why:` line (#2469 contract — caller-supplied only). */
    reason: z.string().max(512).optional(),
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
    /** Optional operator-facing rationale, surfaced on the approval
     *  card's `why:` line (#2469 contract — caller-supplied only). */
    reason: z.string().max(512).optional(),
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

// ─── Dashboard read-ops (dockerless-web fix) ──────────────────────────────
//
// The admin dashboard ships as a DELIBERATELY dockerless container
// (`switchroom-web`, operator uid, no docker binary/socket). That makes
// three things impossible from the web vantage:
//   - agent uptime/memory (needs `docker inspect`/`docker stats`),
//   - reading each agent's `schedule.d/*.yaml` cron overlays (0600,
//     owned by the agent container UID → operator/web gets EACCES),
// hostd runs as root with the docker socket AND `~/.switchroom` mounted,
// so it can do both. These two verbs are READ-ONLY and ungated for the
// operator caller (the web reaches hostd over the operator socket, which
// `checkGate` leaves ungated). Both return their structured result in the
// `payload` field (JSON-encoded; bounded by the 64 KiB frame) rather than
// the 4 KiB stdout_tail. Logs reuse the existing `agent_logs` verb.

/** Whole-fleet (name omitted) or single-agent docker status — uptime +
 *  memory + active. Read-only; result is JSON in `payload`. */
export const AgentStatusRequestSchema = z.object({
  ...RequestEnvelope,
  op: z.literal("agent_status"),
  args: z.object({
    /** Narrow to one agent; omit ⇒ whole fleet. */
    name: AgentNameSchema.optional(),
  }),
});

/** Cascade-resolved cron schedule + recent fires, read FRESH so the
 *  per-agent `schedule.d/*.yaml` overlays (which hostd can read as root)
 *  are merged. Read-only; result is JSON in `payload`. */
export const AgentScheduleRequestSchema = z.object({
  ...RequestEnvelope,
  op: z.literal("agent_schedule"),
  args: z.object({
    /** Narrow to one agent; omit ⇒ whole fleet. */
    name: AgentNameSchema.optional(),
  }),
});

/**
 * Read-only in-agent liveness battery. hostd `docker exec`s a FIXED
 * set of presence/validity probes inside the target agent container
 * (auth creds present, scheduler block + sidecar, .mcp.json /
 * .claude.json valid, bot-token present, /state writable). Every
 * probe returns only a boolean/state — NEVER a secret value. `deep`
 * opts into an additional `auth_live` probe that parses the in-container
 * `.credentials.json` and verifies the OAuth token format and expiry —
 * no model call, no programmatic usage (subscription-honest). The
 * default (deep absent/false) still makes NO model call. Self-target is
 * allowed; cross-agent requires admin (mirrors agent_logs/agent_exec).
 * The doctor CLI (operator socket) + Telegram /doctor consume this to
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
// `config_propose_edit` — an agent proposes a unified-diff patch against
// `/state/config/switchroom.yaml`. SHIPPED end-to-end (#1623): the wire
// shape, the validation pipeline, and the validate→approve→apply→reconcile
// path are all live. When `hostd.config_edit_enabled` is false the
// dispatcher returns `E_CONFIG_EDIT_DISABLED`; otherwise it validates,
// raises an operator approval card, and applies on Allow. (`E_NOT_IMPLEMENTED`
// is retained in the enum below for wire stability but is no longer returned.)
//
// Inputs: a unified diff body, a human-readable rationale rendered onto the
// operator approval card, and an explicit `target_path` that MUST equal the
// canonical config path — guarding against accidental multi-file diffs and
// giving the validator a single load-bearing path string to anchor on.
/**
 * The one config path this verb is allowed to name on the wire — the container
 * path `hostd install` bind-mounts `~/.switchroom/switchroom.yaml` onto
 * (`src/cli/hostd.ts`). Exported so the three places that compare against it
 * (this schema, hostd's fallback resolution, and the startup path-provenance
 * assertion in `main.ts`) cannot drift apart independently.
 */
export const CANONICAL_CONFIG_PATH = "/state/config/switchroom.yaml" as const;

export const ConfigProposeEditRequestSchema = z.object({
  ...RequestEnvelope,
  op: z.literal("config_propose_edit"),
  args: z.object({
    /** Unified diff against switchroom.yaml. Wire layer bounds the
     *  envelope; structural validation (any context level incl. zero,
     *  no path traversal, single-file, LF-only, ≤1 MB) runs in
     *  config-edit-validator. */
    unified_diff: z.string().min(1).max(MAX_FRAME_BYTES - 1024),
    /** Operator-visible justification rendered on the approval card.
     *  Hard-capped at 500 chars per RFC §3.3. */
    reason: z.string().min(1).max(500),
    /** Must be the canonical path. Rejected dispatcher-side if not —
     *  this is a defense-in-depth check on top of PR 1b's diff-path
     *  validation. */
    target_path: z.literal(CANONICAL_CONFIG_PATH),
  }),
});

/**
 * Error codes returned by `config_propose_edit` (shipped, #1623). Stable
 * wire enum; callers switch on it. `E_NOT_IMPLEMENTED` is RETAINED for wire
 * compatibility but is no longer returned by any handler.
 *
 *   E_CONFIG_EDIT_DISABLED — `hostd.config_edit_enabled` is false
 *   E_NOT_IMPLEMENTED      — retained for wire stability; NEVER returned now
 *   E_VALIDATION_REJECTED  — diff shape / path / encoding
 *   E_SCHEMA_REJECTED      — post-patch yaml fails zod
 *   E_APPLY_REJECTED       — `git apply --check` against live file failed
 *   E_RATE_LIMITED         — per-agent token bucket exhausted
 *   E_RECONCILE_FAILED     — `switchroom apply` exited non-zero post-write
 *   E_DENIED               — operator tapped Deny
 *   E_EXPIRED              — 10-minute timeout
 */
export const CONFIG_PROPOSE_EDIT_ERROR_CODES = [
  "E_CONFIG_EDIT_DISABLED",
  "E_NOT_IMPLEMENTED",
  // PR 1b — validation pipeline (RFC §4). The four stages each get a
  // distinct code so callers can render targeted user-facing errors
  // and the audit reader can branch without parsing free text.
  "E_PATCH_INVALID_SHAPE", // stage 1: shape / size / path-traversal
  "E_PATCH_APPLY_FAILED", // stage 2: `git apply --check` rejected
  "E_YAML_UNSAFE_CONSTRUCT", // stage 3a: `!!`-tag, `&`-anchor, `*`-alias, `<<:` merge
  "E_SCHEMA_INVALID", // stage 3b: post-apply yaml fails zod
  "E_SECRET_LEAK_DETECTED", // stage 4: literal secret / un-vaulted-ref regression
  "E_VALIDATION_REJECTED",
  "E_SCHEMA_REJECTED",
  "E_APPLY_REJECTED",
  "E_RATE_LIMITED",
  "E_RECONCILE_FAILED",
  "E_DENIED",
  "E_EXPIRED",
  // #1623 apply path (this PR).
  "E_NO_APPROVAL_GATEWAY",
  "E_APPROVAL_TIMEOUT",
  "E_RECONCILE_FAILED_ROLLED_BACK",
  // #3084 security audit — the live config drifted between propose-time
  // validation and the (up to 60-min-delayed) operator approval, so the apply
  // ABORTED under the mutex rather than silently revert the intervening change.
  "E_CONFIG_CHANGED",
  // #4661 — the apply wrote bytes that are NOT observable at the resolved
  // config path (or the file on disk no longer carries the approved change
  // set). Distinct from E_RECONCILE_FAILED_ROLLED_BACK: nothing rejected the
  // config, hostd could not prove it changed at all.
  "E_WRITE_NOT_OBSERVED",
  // #4661 follow-up — the file hostd would WRITE is not the file the fleet
  // READS: the write target and `findConfigFile()`'s answer resolve to
  // different real paths. Returned BEFORE anything is written (no snapshot, no
  // approval card), because writing one file and reconciling another produces
  // an `exit 0, result: completed` for a change that is absent from the config
  // every other process loads.
  "E_CONFIG_PATH_MISMATCH",
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
  RolloutRequestSchema,
  AgentStartRequestSchema,
  AgentStopRequestSchema,
  AgentLogsRequestSchema,
  AgentExecRequestSchema,
  DoctorRequestSchema,
  AgentSmokeRequestSchema,
  AgentStatusRequestSchema,
  AgentScheduleRequestSchema,
  ConfigProposeEditRequestSchema,
]);

export type AgentRestartRequest = z.infer<typeof AgentRestartRequestSchema>;
export type UpgradeStatusRequest = z.infer<typeof UpgradeStatusRequestSchema>;
export type GetStatusRequest = z.infer<typeof GetStatusRequestSchema>;
export type UpdateCheckRequest = z.infer<typeof UpdateCheckRequestSchema>;
export type UpdateApplyRequest = z.infer<typeof UpdateApplyRequestSchema>;
export type ApplyRequest = z.infer<typeof ApplyRequestSchema>;
export type RolloutRequest = z.infer<typeof RolloutRequestSchema>;
export type AgentStartRequest = z.infer<typeof AgentStartRequestSchema>;
export type AgentStopRequest = z.infer<typeof AgentStopRequestSchema>;
export type AgentLogsRequest = z.infer<typeof AgentLogsRequestSchema>;
export type AgentExecRequest = z.infer<typeof AgentExecRequestSchema>;
export type DoctorRequest = z.infer<typeof DoctorRequestSchema>;
export type AgentSmokeRequest = z.infer<typeof AgentSmokeRequestSchema>;
export type AgentStatusRequest = z.infer<typeof AgentStatusRequestSchema>;
export type AgentScheduleRequest = z.infer<typeof AgentScheduleRequestSchema>;
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

// ─── Error envelope (issue #1758 Phase 1) ─────────────────────────────────
//
// Structured error envelope carried alongside the legacy `error: string`
// field on a `denied` / `error` response. Agents read `fix.kind` directly
// instead of regexing the human string; the Telegram bridge can render
// one-tap unlock / grant cards for safe `fix.kind`s (allowlist-gated).
//
// `error: string` is preserved for one release cycle so existing decoders
// continue to work — the builder synthesises a stable legacy string from
// `code` + `human` + `why`.

export const ErrorFixSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("flip_yaml_flag"),
    yaml_path: z.string(),
    to: z.unknown(),
  }),
  z.object({
    kind: z.literal("request_vault_grant"),
    vault_key: z.string(),
  }),
  z.object({
    kind: z.literal("operator_action"),
    subkind: z.enum(["policy_denied", "infra", "out_of_scope"]),
    operator_steps: z.array(z.string()).min(1).optional(),
  }),
  z.object({
    kind: z.literal("retry_after"),
    retry_at: z.string(),
  }),
  z.object({
    kind: z.literal("quota_exceeded"),
    quota: z.string(),
    current: z.number(),
    limit: z.number(),
  }),
  z.object({
    kind: z.literal("bad_input"),
    field: z.string().optional(),
  }),
]);
export type ErrorFix = z.infer<typeof ErrorFixSchema>;

export const ErrorEnvelopeSchema = z.object({
  v: z.literal(1),
  code: z.string().regex(/^(E_[A-Z0-9_]+|VAULT-[A-Z-]+)$/),
  human: z.string().min(1),
  why: z.string().optional(),
  fix: ErrorFixSchema.optional(),
  docs: z.string().url().optional(),
  /**
   * Optional. The hostd dispatcher path threads the real RPC
   * `request_id` through; CLI emit sites (vault-broker denial line,
   * agent-config sibling JSON key) have no caller-supplied id and
   * omit the field — receivers correlate via `audit_id` or the
   * surrounding context. Relaxed from `.min(1)` to `.optional()`
   * in #1778 to stop fabricated `<service>-<uuid>` placeholders.
   */
  request_id: z.string().min(1).optional(),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;

/**
 * Pure envelope constructor (#1778) — single source of truth for the
 * `ErrorEnvelope` wire shape. Used by the hostd `ErrorBuilder` (which
 * adds `request_id` + `why`/`docs` and wraps in `HostdResponse`) and
 * directly by CLI emit sites (`writeVaultDeniedEnvelope`,
 * `agent-config-write.ts`) that don't have an RPC request_id to thread.
 *
 * `fix` is passed through verbatim — validation that the discriminator
 * + required fields line up is `ErrorEnvelopeSchema`'s job, not this
 * function's. Callers that want author-time validation should pipe the
 * result through `ErrorEnvelopeSchema.parse`.
 *
 * Per-code `fix.kind` selection is the CALLER's responsibility — this
 * function does not mint a default `fix` for any code. Unknown / un-
 * migrated codes pass `undefined` and the field elides from the
 * envelope, matching `ErrorEnvelopeSchema`'s `fix.optional()`.
 */
export interface BuildEnvelopeOptions {
  why?: string;
  docs?: string;
  request_id?: string;
}

export function buildEnvelope(
  code: string,
  human: string,
  fix?: ErrorFix,
  opts: BuildEnvelopeOptions = {},
): ErrorEnvelope {
  return {
    v: 1,
    code,
    human,
    ...(opts.why !== undefined ? { why: opts.why } : {}),
    ...(fix !== undefined ? { fix } : {}),
    ...(opts.docs !== undefined ? { docs: opts.docs } : {}),
    ...(opts.request_id !== undefined ? { request_id: opts.request_id } : {}),
  };
}

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
  /**
   * Optional JSON-encoded STRUCTURED result for read-only verbs that
   * return more than a 4 KiB text tail (e.g. `agent_status` →
   * `{statuses}`, `agent_schedule` → `{entries, recentByAgent}`). The
   * shape is verb-specific; the wire layer only guarantees it's a string
   * and that the WHOLE response frame stays under `MAX_FRAME_BYTES`
   * (64 KiB) — handlers that emit `payload` are responsible for bounding
   * their own content (truncating prompts / fire summaries / fire counts)
   * so the encoded frame fits. Distinct from `stdout_tail`, which is a
   * raw process-output tail; `payload` is producer-shaped data the caller
   * `JSON.parse`s. Absent on every existing verb (back-compatible).
   */
  payload: z.string().optional(),
  /** Operator-visible error message for `denied` / `error`. */
  error: z.string().optional(),
  /** Structured error envelope (#1758 Phase 1). Sibling of `error`;
   *  agents read `fix.kind` directly to know the next move. */
  error_envelope: ErrorEnvelopeSchema.optional(),
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
