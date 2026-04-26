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
});

export const ListRequestSchema = z.object({
  v: z.literal(1),
  op: z.literal("list"),
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
]);

export type GetRequest = z.infer<typeof GetRequestSchema>;
export type ListRequest = z.infer<typeof ListRequestSchema>;
export type StatusRequest = z.infer<typeof StatusRequestSchema>;
export type LockRequest = z.infer<typeof LockRequestSchema>;
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
  ErrorResponseSchema,
]);

export type OkEntryResponse = z.infer<typeof OkEntryResponseSchema>;
export type OkKeysResponse = z.infer<typeof OkKeysResponseSchema>;
export type OkStatusResponse = z.infer<typeof OkStatusResponseSchema>;
export type OkLockResponse = z.infer<typeof OkLockResponseSchema>;
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
 */
export function entryResponse(entry: VaultEntry): OkEntryResponse {
  return { ok: true, entry };
}
