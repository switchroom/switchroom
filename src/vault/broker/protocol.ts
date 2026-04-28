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

// ─── Constants ─────────────────────────────────────────────────────────────

export const MAX_FRAME_BYTES = 64 * 1024; // 64 KiB

// ─── Request schemas ────────────────────────────────────────────────────────

export const GetRequestSchema = z.object({
  v: z.literal(1),
  op: z.literal("get"),
  key: z.string().min(1),
  filename: z.string().optional(),
  /** Optional capability token for grant-based access (vg_<id>.<secret>) */
  token: z.string().optional(),
});

export const ListRequestSchema = z.object({
  v: z.literal(1),
  op: z.literal("list"),
  /** Optional capability token for grant-based access */
  token: z.string().optional(),
});

export const MintGrantRequestSchema = z.object({
  v: z.literal(1),
  op: z.literal("mint_grant"),
  agent: z.string().min(1),
  keys: z.array(z.string().min(1)).min(1),
  ttl_seconds: z.number().int().positive().nullable(),
  description: z.string().optional(),
});

export const ListGrantsRequestSchema = z.object({
  v: z.literal(1),
  op: z.literal("list_grants"),
  agent: z.string().optional(),
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

export const RequestSchema = z.discriminatedUnion("op", [
  GetRequestSchema,
  ListRequestSchema,
  StatusRequestSchema,
  LockRequestSchema,
  MintGrantRequestSchema,
  ListGrantsRequestSchema,
  RevokeGrantRequestSchema,
]);

export type GetRequest = z.infer<typeof GetRequestSchema>;
export type ListRequest = z.infer<typeof ListRequestSchema>;
export type StatusRequest = z.infer<typeof StatusRequestSchema>;
export type LockRequest = z.infer<typeof LockRequestSchema>;
export type MintGrantRequest = z.infer<typeof MintGrantRequestSchema>;
export type ListGrantsRequest = z.infer<typeof ListGrantsRequestSchema>;
export type RevokeGrantRequest = z.infer<typeof RevokeGrantRequestSchema>;
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
  OkMintGrantResponseSchema,
  OkListGrantsResponseSchema,
  OkRevokeGrantResponseSchema,
  ErrorResponseSchema,
]);

export type OkEntryResponse = z.infer<typeof OkEntryResponseSchema>;
export type OkKeysResponse = z.infer<typeof OkKeysResponseSchema>;
export type OkStatusResponse = z.infer<typeof OkStatusResponseSchema>;
export type OkLockResponse = z.infer<typeof OkLockResponseSchema>;
export type OkMintGrantResponse = z.infer<typeof OkMintGrantResponseSchema>;
export type OkListGrantsResponse = z.infer<typeof OkListGrantsResponseSchema>;
export type OkRevokeGrantResponse = z.infer<typeof OkRevokeGrantResponseSchema>;
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
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
