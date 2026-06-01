/**
 * vault-broker wire protocol — newline-delimited JSON (NDJSON).
 *
 * Frame format:
 *   - One JSON object per line, terminated by "\n".
 *   - Maximum 64 KiB per frame (enforced by the server's line reader and by
 *     the encode helpers, which throw if the serialized length exceeds the cap).
 *   - All communication is request/response — one request per connection turn,
 *     one response. The connection stays open for the lifetime of the consumer
 *     process (cron script), allowing multiple sequential requests.
 *
 * UNLOCK is NOT a wire op on this socket. The passphrase flows over the
 * separate unlock socket (~/.switchroom/vault-broker.unlock.sock) as a raw
 * line, never as JSON through this protocol file.
 *
 * Import the Zod schemas when you need to validate at runtime, or use the
 * encode/decode helpers (which call .parse internally) for type-safe I/O.
 */

import { z } from "zod";
import type { VaultEntry } from "../vault.js";
import { isReservedAgentName } from "./peercred.js";

// ─── Constants ─────────────────────────────────────────────────────────────

export const MAX_FRAME_BYTES = 64 * 1024; // 64 KiB

/**
 * Agent-name validator (#1448). Any broker request that interpolates a
 * wire-supplied `agent` value into a filesystem path MUST validate
 * through this schema before use. Pre-fix `mint_grant` accepted any
 * non-empty string and joined it directly into
 * `~/.switchroom/agents/<agent>/.vault-token` — a malicious peer with
 * broker-IPC access could `agent: "../foo"` to escape the agents tree.
 *
 * Charclass + cap mirror `src/host-control/protocol.ts` AgentNameSchema
 * (kebab-case ASCII, first char alnum, 64-byte cap), which matches the
 * shape `allocateAgentUid` already implicitly requires. Reserved names
 * (`operator`, `hostd` — see RESERVED_AGENT_NAMES in peercred.ts) are
 * rejected at the schema layer so the broker can't be tricked into
 * routing through an alternate identity.
 */
export const AgentNameSchema = z
  .string()
  .min(1)
  .max(64, "agent name max 64 chars")
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/,
    "agent name must be kebab-case ASCII (alnum + _- only, first char alnum)",
  )
  .refine((s) => !isReservedAgentName(s), {
    message: "agent name is reserved",
  });

// ─── Request schemas ────────────────────────────────────────────────────────

export const GetRequestSchema = z.object({
  v: z.literal(1),
  op: z.literal("get"),
  key: z.string().min(1),
  filename: z.string().optional(),
  /** Optional capability token for grant-based access (vg_<id>.<secret>) */
  token: z.string().optional(),
});

/**
 * Put a vault entry. Same ACL as Get — an agent that can read a key
 * via `schedule.secrets[]` can also rotate (write) it.
 *
 * Motivation (#950): the calendar skill (and any OAuth-style skill that
 * stores rotating refresh tokens in vault) reads its token via broker,
 * exchanges it with the IDP for a fresh access_token + possibly-new
 * refresh_token, then needs to persist the rotation. Pre-fix the only
 * write path was `switchroom vault set` which decrypts the vault file
 * directly with the operator's passphrase — agents don't have it. The
 * skill's ms_graph_token.py would refresh against MS successfully and
 * then drop the new tokens on the floor. Calendar never worked.
 *
 * Trust model: the broker is already auto-unlocked (machine-id-derived
 * blob inside the broker container) and holds all decrypted secrets in
 * memory. A pwned broker can already exfiltrate every secret. Allowing
 * authorized agents to rotate keys they're already allowed to READ
 * doesn't expand the broker's surface; it just lets agents repair their
 * own state without operator hand-holding.
 *
 * Out of scope: introducing a NEW key (one not already in vault) is
 * still operator-only — Put refuses keys that aren't already present
 * in the broker's loaded secrets. That keeps the "operator decides
 * what goes in vault" boundary intact; agents can only update existing
 * entries they have ACL for.
 */
export const PutRequestSchema = z.object({
  v: z.literal(1),
  op: z.literal("put"),
  key: z.string().min(1),
  /** New entry value. Kind must match the existing entry — agents can
   *  rotate values, not change the storage shape (string ↔ binary ↔
   *  files). */
  entry: z.union([
    z.object({ kind: z.literal("string"), value: z.string() }),
    z.object({ kind: z.literal("binary"), value: z.string() }),
  ]),
  /** Optional capability token for grant-based access. */
  token: z.string().optional(),
  /**
   * Optional operator-passphrase attestation (issue #969 P1a). When
   * present AND matching the broker's currently-loaded passphrase, the
   * call is authorized as if the operator ran it from a host shell —
   * bypasses path-as-identity, ACL, and the unknown-key gate. The
   * gateway uses this path for one-tap user-approved saves: the user
   * just typed (or has cached) the passphrase via Telegram, so the
   * broker can trust the caller carries operator intent.
   *
   * The gateway already holds the passphrase in memory after any
   * /vault command, so the marginal surface is small. Audit logs tag
   * method="passphrase" so this path is distinguishable in the access
   * log from grants and path-as-identity.
   */
  passphrase: z.string().optional(),
  /**
   * Posture-attestation flag (#1115 follow-up). Same semantics as
   * `MintGrantRequestSchema.attest_via_posture` — broker treats the
   * call as operator-attested IFF its config has
   * `approvalAuth: telegram-id`, the broker is unlocked, and the
   * caller is a per-agent peer. The save/defer approval flow uses
   * this so the gateway never needs the passphrase in memory under
   * telegram-id posture. Mutually exclusive with `passphrase`.
   */
  attest_via_posture: z.boolean().optional(),
});

export const ListRequestSchema = z.object({
  v: z.literal(1),
  op: z.literal("list"),
  /** Optional capability token for grant-based access */
  token: z.string().optional(),
});

// Note: the constraint "keys OR write_keys must be non-empty" is enforced
// in the handler (server.ts) rather than via z.refine() — refine() returns
// a ZodEffects which breaks z.discriminatedUnion's narrowing requirements.
export const MintGrantRequestSchema = z.object({
  v: z.literal(1),
  op: z.literal("mint_grant"),
  agent: AgentNameSchema,
  /** Keys this grant authorizes for READ. May be empty when `write_keys`
   * is non-empty (write-only grant). */
  keys: z.array(z.string().min(1)),
  ttl_seconds: z.number().int().positive().nullable(),
  description: z.string().optional(),
  /**
   * Optional list of keys (or prefix-globs like `OPENAI_*`) this grant
   * authorizes for WRITE via broker PUT. Defaults to `[]` (read-only).
   * Issue #969 P1b.
   */
  write_keys: z.array(z.string().min(1)).optional(),
  /**
   * Optional operator-passphrase attestation (#1012 Phase 2). When
   * present and matching the broker's currently-unlocked passphrase,
   * the call is treated as operator-attested regardless of the
   * caller's agent identity — non-admin agents can mint grants on
   * behalf of an operator who tapped Approve in their Telegram chat.
   * Same trust posture used by PUT (`vault_request_save`).
   */
  passphrase: z.string().optional(),
  /**
   * Posture-attestation flag (#1115 follow-up — broker-mediated mint).
   *
   * When `true`, the broker treats the call as operator-attested IFF
   * its OWN config has `vault.broker.approvalAuth: telegram-id` AND
   * the broker is unlocked AND the caller is a per-agent peer (path-
   * as-identity). The broker uses its retained passphrase
   * internally; the passphrase is never sent over this socket.
   *
   * Why this rather than `passphrase`: under telegram-id posture the
   * passphrase persists in broker memory. Releasing it to gateway
   * peers (as the first cut of #1115 follow-up did) lets any
   * in-container actor with broker-socket access mint grants — claude
   * tools / skills can bypass the operator-tap gate. With
   * `attest_via_posture`, the passphrase stays inside the broker
   * process. The blast radius is restricted to mint_grant only:
   * agents can ASK the broker to mint with telegram-id attestation,
   * but cannot extract material useful for passphrase-attested
   * PUT or list_grants.
   *
   * Mutually exclusive with `passphrase` — if both are present, the
   * broker rejects with BAD_REQUEST so the operator doesn't
   * accidentally double-attest a call.
   */
  attest_via_posture: z.boolean().optional(),
  /**
   * Operator-verified approval decision id (RFC vault-approval-hard-boundary).
   * `attest_via_posture` alone is forgeable — claude shares the per-agent
   * socket. When the broker config requires it
   * (`SWITCHROOM_REQUIRE_OPERATOR_APPROVAL_MINT`), a posture-attested mint
   * must reference a kernel decision recorded with `origin='operator'` (by
   * the host-side approval verifier, on a channel claude cannot reach).
   * Optional on the wire — the gate is flag-gated and default-OFF until the
   * verifier ships, so today this field is unused.
   */
  decision_id: z.string().optional(),
});

export const ListGrantsRequestSchema = z.object({
  v: z.literal(1),
  op: z.literal("list_grants"),
  agent: AgentNameSchema.optional(),
  /**
   * Optional operator-passphrase attestation (#1051). Same trust
   * posture as the mint_grant attestation field (#1012 Phase 2).
   * list_grants needs to be reachable from non-admin agent gateways
   * so the grant-union flow can read the agent's existing keys
   * before minting a unioned grant. Read-only — adds no security
   * regression vs the mint_grant path that's already
   * operator-attested.
   */
  passphrase: z.string().optional(),
  /**
   * Posture-attestation flag (#1115 follow-up). Same semantics as
   * `MintGrantRequestSchema.attest_via_posture` — broker treats the
   * call as operator-attested IFF its own config has
   * `approvalAuth: telegram-id`, the broker is unlocked, and the
   * caller is a per-agent peer. The grant-union flow needs this so
   * a non-admin agent gateway under telegram-id can still read the
   * agent's existing grants before minting (otherwise each mint
   * silently strands the previous .vault-token — see #1051).
   * Mutually exclusive with `passphrase`.
   */
  attest_via_posture: z.boolean().optional(),
});

export const RevokeGrantRequestSchema = z.object({
  v: z.literal(1),
  op: z.literal("revoke_grant"),
  id: z.string().min(1),
});

export const StatusRequestSchema = z.object({
  v: z.literal(1),
  op: z.literal("status"),
});

export const LockRequestSchema = z.object({
  v: z.literal(1),
  op: z.literal("lock"),
});

/**
 * Read-only OPERATOR-ONLY introspection: "for agent <agent>, what is
 * the static existence + ACL/scope status of these keys?" Answered
 * from the broker's already-unlocked in-memory vault using the SAME
 * predicates the real `get` path composes — so the caller (doctor)
 * gets the verified truth WITHOUT holding SWITCHROOM_VAULT_PASSPHRASE.
 * NEVER returns secret values. Agent (per-agent socket) callers are
 * rejected — this is an operator tool, and the key list is a key-
 * existence oracle that only the operator (same trust root as the
 * vault file) may use. `acl`/`scope` mirror what doctor-secret-
 * access.ts already computes locally; the caller decides per
 * provenance which to apply (cron keys → acl; scope always; google:
 * slots → existence n/a). Caveat preserved on the consumer side:
 * a missing static ACL does NOT prove no access (a runtime
 * capability/token grant the static check can't see may still cover
 * it) — same "no *static* ACL" wording as the local path.
 */
export const PreflightAccessRequestSchema = z.object({
  v: z.literal(1),
  op: z.literal("preflight_access"),
  agent: AgentNameSchema,
  keys: z.array(z.string().min(1)).min(1).max(128),
});

export const OkPreflightAccessResponseSchema = z.object({
  ok: z.literal(true),
  op: z.literal("preflight_access"),
  results: z.array(
    z.object({
      key: z.string(),
      /** Key present in the unlocked vault map. */
      exists: z.boolean(),
      /** checkAclByAgent(config, agent, key).allow — the static-ACL
       *  signal the agent `get` path uses. NEVER a value. */
      acl_ok: z.boolean(),
      acl_reason: z.string().optional(),
      /** checkEntryScope(entry.scope, agent).allow */
      scope_ok: z.boolean(),
      scope_reason: z.string().optional(),
    }),
  ),
});


// ─── Approval kernel (RFC B) ────────────────────────────────────────────────

export const ApprovalRequestRequestSchema = z.object({
  v: z.literal(1),
  op: z.literal("approval_request"),
  agent_unit: z.string().min(1),
  scope: z.string().min(1),
  action: z.string().min(1),
  approver_set: z.array(z.string()),
  why: z.string().optional(),
  ttl_ms: z.number().int().positive().optional(),
});

export const ApprovalLookupRequestSchema = z.object({
  v: z.literal(1),
  op: z.literal("approval_lookup"),
  agent_unit: z.string().min(1),
  scope: z.string().min(1),
  action: z.string().min(1),
  current_approver_set: z.array(z.string()),
});

export const ApprovalConsumeRequestSchema = z.object({
  v: z.literal(1),
  op: z.literal("approval_consume"),
  request_id: z.string().regex(/^[0-9a-f]{32}$/),
});

export const ApprovalRevokeRequestSchema = z.object({
  v: z.literal(1),
  op: z.literal("approval_revoke"),
  decision_id: z.string().min(1),
  actor: z.string().min(1),
  reason: z.string().optional(),
});

export const ApprovalListRequestSchema = z.object({
  v: z.literal(1),
  op: z.literal("approval_list"),
  agent_unit: z.string().optional(),
});

export const ApprovalDecisionModeSchema = z.enum([
  "allow_once",
  "allow_always",
  "allow_ttl",
  "deny",
  "deny_perm",
]);
export type ApprovalDecisionMode = z.infer<typeof ApprovalDecisionModeSchema>;

export const ApprovalRecordRequestSchema = z.object({
  v: z.literal(1),
  op: z.literal("approval_record"),
  request_id: z.string().regex(/^[0-9a-f]{32}$/),
  decision: ApprovalDecisionModeSchema,
  approver_set: z.array(z.string()),
  granted_by_user_id: z.number().int(),
  ttl_ms: z.number().int().positive().nullable().optional(),
});

// Atomic consume+record (PR-6). Identical payload to approval_record;
// the kernel burns the single-use nonce AND writes the decision inside
// ONE SQLite transaction, eliminating the consume↔record IPC gap that
// wedged the agent's turn if the broker/gateway died between the two
// legacy ops. Additive: approval_consume / approval_record stay intact
// for their other callers (deferred-secret + /vault-grant dual-dispatch,
// /folders picker, tests) — only the apv: card path migrates.
export const ApprovalConsumeRecordRequestSchema = z.object({
  v: z.literal(1),
  op: z.literal("approval_consume_record"),
  request_id: z.string().regex(/^[0-9a-f]{32}$/),
  decision: ApprovalDecisionModeSchema,
  approver_set: z.array(z.string()),
  granted_by_user_id: z.number().int(),
  ttl_ms: z.number().int().positive().nullable().optional(),
});

export const RequestSchema = z.discriminatedUnion("op", [
  GetRequestSchema,
  PutRequestSchema,
  ListRequestSchema,
  StatusRequestSchema,
  LockRequestSchema,
  PreflightAccessRequestSchema,
  MintGrantRequestSchema,
  ListGrantsRequestSchema,
  RevokeGrantRequestSchema,
  ApprovalRequestRequestSchema,
  ApprovalLookupRequestSchema,
  ApprovalConsumeRequestSchema,
  ApprovalRevokeRequestSchema,
  ApprovalListRequestSchema,
  ApprovalRecordRequestSchema,
  ApprovalConsumeRecordRequestSchema,
]);

export type GetRequest = z.infer<typeof GetRequestSchema>;
export type PutRequest = z.infer<typeof PutRequestSchema>;
export type ListRequest = z.infer<typeof ListRequestSchema>;
export type StatusRequest = z.infer<typeof StatusRequestSchema>;
export type LockRequest = z.infer<typeof LockRequestSchema>;
export type PreflightAccessRequest = z.infer<typeof PreflightAccessRequestSchema>;
export type OkPreflightAccessResponse = z.infer<typeof OkPreflightAccessResponseSchema>;
export type MintGrantRequest = z.infer<typeof MintGrantRequestSchema>;
export type ListGrantsRequest = z.infer<typeof ListGrantsRequestSchema>;
export type RevokeGrantRequest = z.infer<typeof RevokeGrantRequestSchema>;
export type ApprovalRequestRequest = z.infer<typeof ApprovalRequestRequestSchema>;
export type ApprovalLookupRequest = z.infer<typeof ApprovalLookupRequestSchema>;
export type ApprovalConsumeRequest = z.infer<typeof ApprovalConsumeRequestSchema>;
export type ApprovalRevokeRequest = z.infer<typeof ApprovalRevokeRequestSchema>;
export type ApprovalListRequest = z.infer<typeof ApprovalListRequestSchema>;
export type ApprovalRecordRequest = z.infer<typeof ApprovalRecordRequestSchema>;
export type BrokerRequest = z.infer<typeof RequestSchema>;

// ─── Response schemas ───────────────────────────────────────────────────────

const VaultEntrySchema = z.union([
  z.object({ kind: z.literal("string"), value: z.string() }),
  z.object({ kind: z.literal("binary"), value: z.string() }),
  z.object({
    kind: z.literal("files"),
    files: z.record(
      z.string(),
      z.object({
        encoding: z.enum(["utf8", "base64"]),
        value: z.string(),
      }),
    ),
  }),
]);

export const ErrorCode = z.enum([
  "LOCKED",
  "DENIED",
  "UNKNOWN_KEY",
  "BAD_REQUEST",
  "INTERNAL",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const OkEntryResponseSchema = z.object({
  ok: z.literal(true),
  entry: VaultEntrySchema,
});

export const OkKeysResponseSchema = z.object({
  ok: z.literal(true),
  keys: z.array(z.string()),
});

export const BrokerStatus = z.object({
  unlocked: z.boolean(),
  keyCount: z.number().int().nonnegative(),
  uptimeSec: z.number().nonnegative(),
});
export type BrokerStatus = z.infer<typeof BrokerStatus>;

export const OkStatusResponseSchema = z.object({
  ok: z.literal(true),
  status: BrokerStatus,
});

export const OkLockResponseSchema = z.object({
  ok: z.literal(true),
  locked: z.literal(true),
});

export const OkPutResponseSchema = z.object({
  ok: z.literal(true),
  put: z.literal(true),
  /** Echo the key so wire-debug tooling can correlate the response. */
  key: z.string(),
});

export const OkMintGrantResponseSchema = z.object({
  ok: z.literal(true),
  token: z.string(),
  id: z.string(),
  expires_at: z.number().nullable(),
});

export const GrantMetaSchema = z.object({
  id: z.string(),
  agent_slug: z.string(),
  key_allow: z.array(z.string()),
  /** Keys/globs this grant authorizes for WRITE. `[]` = read-only. */
  write_allow: z.array(z.string()).default([]),
  expires_at: z.number().nullable(),
  created_at: z.number(),
  description: z.string().nullable(),
});
export type GrantMeta = z.infer<typeof GrantMetaSchema>;

export const OkListGrantsResponseSchema = z.object({
  ok: z.literal(true),
  grants: z.array(GrantMetaSchema),
});

export const OkRevokeGrantResponseSchema = z.object({
  ok: z.literal(true),
  revoked: z.boolean(),
});

// ─── Approval kernel responses ──────────────────────────────────────────────

/**
 * approval_request response. Two shapes — discriminated by the literal in
 * `state` (NOT `status`, to avoid colliding with the BrokerStatus object on
 * the OkStatusResponse shape).
 *
 * - { state: "pending", request_id, expires_at } — the normal path.
 * - { state: "rate_limited", retry_after_ms } — RFC §10 caps tripped
 *   (per-agent max 2 concurrent; global max 32).
 */
/**
 * approval_request response. Carries a `kind: "approval_request"` tag so
 * the discriminated union at the broker response level can narrow without
 * the lookup response (`state` field, no `kind`) ever matching here.
 *
 * - `state: "pending"` — nonce issued, request_id + expires_at returned.
 * - `state: "rate_limited"` — RFC §10 caps tripped; retry_after_ms returned.
 */
export const OkApprovalRequestResponseSchema = z.discriminatedUnion("state", [
  z.object({
    ok: z.literal(true),
    kind: z.literal("approval_request"),
    state: z.literal("pending"),
    request_id: z.string(),
    expires_at: z.number(),
  }),
  z.object({
    ok: z.literal(true),
    kind: z.literal("approval_request"),
    state: z.literal("rate_limited"),
    retry_after_ms: z.number(),
  }),
]);

export const ApprovalDecisionMetaSchema = z.object({
  id: z.string(),
  agent_unit: z.string(),
  scope: z.string(),
  action: z.string(),
  decision: ApprovalDecisionModeSchema,
  granted_at: z.number(),
  granted_by_user_id: z.number(),
  ttl_expires_at: z.number().nullable(),
  last_used_at: z.number().nullable(),
  revoked_at: z.number().nullable(),
  revoke_reason: z.string().nullable(),
});
export type ApprovalDecisionMeta = z.infer<typeof ApprovalDecisionMetaSchema>;

/**
 * approval_lookup response. Discriminant is `state` — RFC §10 lifecycle.
 * Renamed from `status` to avoid colliding with BrokerStatus on the response
 * union (the latter's `status` is an object; this one's was a string —
 * narrowing required a `typeof` smell at the call site).
 */
export const OkApprovalLookupResponseSchema = z.object({
  ok: z.literal(true),
  state: z.enum(["granted", "denied", "pending", "expired", "drift_revoked", "no_decision"]),
  decision: ApprovalDecisionMetaSchema.nullable().optional(),
});

export const OkApprovalConsumeResponseSchema = z.object({
  ok: z.literal(true),
  consumed: z.boolean(),
  agent_unit: z.string().optional(),
  scope: z.string().optional(),
  action: z.string().optional(),
  why: z.string().nullable().optional(),
});

export const OkApprovalRevokeResponseSchema = z.object({
  ok: z.literal(true),
  revoked: z.boolean(),
});

export const OkApprovalListResponseSchema = z.object({
  ok: z.literal(true),
  decisions: z.array(ApprovalDecisionMetaSchema),
});

export const OkApprovalRecordResponseSchema = z.object({
  ok: z.literal(true),
  decision_id: z.string(),
});

// Reuses OkApprovalConsumeResponseSchema's exact field shape (so the
// gateway's consumed.scope Drive-button path needs no adaptation) plus
// an optional decision_id present only on the consumed+recorded path.
// consumed:false ⇒ nonce already burned/expired/unknown, no decision.
export const OkApprovalConsumeRecordResponseSchema = z.object({
  ok: z.literal(true),
  consumed: z.boolean(),
  decision_id: z.string().optional(),
  agent_unit: z.string().optional(),
  scope: z.string().optional(),
  action: z.string().optional(),
  why: z.string().nullable().optional(),
});

export const ErrorResponseSchema = z.object({
  ok: z.literal(false),
  code: ErrorCode,
  msg: z.string(),
});

export const ResponseSchema = z.union([
  OkEntryResponseSchema,
  OkKeysResponseSchema,
  OkStatusResponseSchema,
  OkLockResponseSchema,
  OkPreflightAccessResponseSchema,
  OkPutResponseSchema,
  OkMintGrantResponseSchema,
  OkListGrantsResponseSchema,
  OkRevokeGrantResponseSchema,
  OkApprovalRequestResponseSchema,
  OkApprovalLookupResponseSchema,
  OkApprovalConsumeResponseSchema,
  OkApprovalRevokeResponseSchema,
  OkApprovalListResponseSchema,
  OkApprovalRecordResponseSchema,
  OkApprovalConsumeRecordResponseSchema,
  ErrorResponseSchema,
]);

export type OkEntryResponse = z.infer<typeof OkEntryResponseSchema>;
export type OkKeysResponse = z.infer<typeof OkKeysResponseSchema>;
export type OkStatusResponse = z.infer<typeof OkStatusResponseSchema>;
export type OkLockResponse = z.infer<typeof OkLockResponseSchema>;
export type OkPutResponse = z.infer<typeof OkPutResponseSchema>;
export type OkMintGrantResponse = z.infer<typeof OkMintGrantResponseSchema>;
export type OkListGrantsResponse = z.infer<typeof OkListGrantsResponseSchema>;
export type OkRevokeGrantResponse = z.infer<typeof OkRevokeGrantResponseSchema>;
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
export type OkApprovalRequestResponse = z.infer<typeof OkApprovalRequestResponseSchema>;
export type OkApprovalLookupResponse = z.infer<typeof OkApprovalLookupResponseSchema>;
export type OkApprovalConsumeResponse = z.infer<typeof OkApprovalConsumeResponseSchema>;
export type OkApprovalRevokeResponse = z.infer<typeof OkApprovalRevokeResponseSchema>;
export type OkApprovalListResponse = z.infer<typeof OkApprovalListResponseSchema>;
export type OkApprovalRecordResponse = z.infer<typeof OkApprovalRecordResponseSchema>;
export type BrokerResponse = z.infer<typeof ResponseSchema>;

// ─── Encode / decode helpers ────────────────────────────────────────────────

/**
 * Serialize a request to a newline-terminated JSON frame.
 * Throws if the serialized length exceeds MAX_FRAME_BYTES.
 */
export function encodeRequest(req: BrokerRequest): string {
  const json = JSON.stringify(req);
  if (Buffer.byteLength(json, "utf8") > MAX_FRAME_BYTES) {
    throw new Error(
      `Request frame too large (${Buffer.byteLength(json, "utf8")} bytes; max ${MAX_FRAME_BYTES})`,
    );
  }
  return json + "\n";
}

/**
 * Parse a raw JSON line (without trailing newline) into a typed BrokerRequest.
 * Throws ZodError on schema violation or SyntaxError on malformed JSON.
 * Throws RangeError if the byte length exceeds MAX_FRAME_BYTES.
 */
export function decodeRequest(line: string): BrokerRequest {
  if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) {
    throw new RangeError(
      `Request frame too large (${Buffer.byteLength(line, "utf8")} bytes; max ${MAX_FRAME_BYTES})`,
    );
  }
  const obj = JSON.parse(line); // SyntaxError on bad JSON
  return RequestSchema.parse(obj); // ZodError on schema violation
}

/**
 * Serialize a response to a newline-terminated JSON frame.
 * Throws if the serialized length exceeds MAX_FRAME_BYTES.
 */
export function encodeResponse(resp: BrokerResponse): string {
  const json = JSON.stringify(resp);
  if (Buffer.byteLength(json, "utf8") > MAX_FRAME_BYTES) {
    throw new Error(
      `Response frame too large (${Buffer.byteLength(json, "utf8")} bytes; max ${MAX_FRAME_BYTES})`,
    );
  }
  return json + "\n";
}

/**
 * Parse a raw JSON line (without trailing newline) into a typed BrokerResponse.
 * Throws ZodError on schema violation or SyntaxError on malformed JSON.
 * Throws RangeError if the byte length exceeds MAX_FRAME_BYTES.
 */
export function decodeResponse(line: string): BrokerResponse {
  if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) {
    throw new RangeError(
      `Response frame too large (${Buffer.byteLength(line, "utf8")} bytes; max ${MAX_FRAME_BYTES})`,
    );
  }
  const obj = JSON.parse(line); // SyntaxError on bad JSON
  return ResponseSchema.parse(obj); // ZodError on schema violation
}

/**
 * Build a typed error response object (not framed).
 */
export function errorResponse(code: ErrorCode, msg: string): ErrorResponse {
  return { ok: false, code, msg };
}

/**
 * Build a typed entry response object (not framed).
 *
 * #8 review-fix: strip the `scope` field before sending. The `scope`
 * allow/deny lists describe the ENTRY'S TRUST TOPOLOGY (which other
 * agents are permitted, which are denied). A successful `get` should
 * deliver the value, not the topology — the recipient gaining knowledge
 * of who else has access is an information disclosure.
 *
 * The Zod `VaultEntrySchema` strips `scope` on the client-side
 * `decodeResponse` parse, so a typed caller's returned object never
 * sees it. But the WIRE BYTES still contain it without this strip —
 * any strace, socket tap, or future debug-log reader would see the
 * full topology. Strip at the source.
 */
export function entryResponse(entry: VaultEntry): OkEntryResponse {
  const stripped = stripWireFields(entry);
  return { ok: true, entry: stripped };
}

/**
 * Project a VaultEntry to the fields appropriate for the wire response.
 * Drops `scope` (server-side ACL metadata, not for the recipient) and
 * preserves the discriminated union over `kind`.
 */
function stripWireFields(entry: VaultEntry): VaultEntry {
  if (entry.kind === "string" || entry.kind === "binary") {
    return {
      kind: entry.kind,
      value: entry.value,
      ...(entry.format !== undefined ? { format: entry.format } : {}),
    };
  }
  // files
  return {
    kind: "files",
    files: entry.files,
  };
}
