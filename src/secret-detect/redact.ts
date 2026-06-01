/**
 * `redact(text)` — sanitize text by replacing detected secrets and
 * credential-bearing URL parts with `[REDACTED]` markers.
 *
 * The implementation now lives in the telegram-plugin so the gateway's
 * inbound/outbound history persistence (`telegram-plugin/history.ts`) and
 * the src-side callers below share ONE redactor backed by the same
 * `detectSecrets` engine — a pattern added once covers every path. This
 * module re-exports it so existing importers keep working unchanged:
 *
 *   - `switchroom issues record` — `src/issues/store.ts:capDetail`, which
 *     calls `redact()` before truncating to `DETAIL_MAX_BYTES`.
 *     `bin/run-hook.sh` is the canonical caller.
 *   - `switchroom secret-detect redact --stdin` — `src/cli/secret-detect.ts`.
 *   - hostd — `src/host-control/server.ts`.
 *
 * Threat model and idempotence notes: see
 * `telegram-plugin/secret-detect/redact.ts`.
 */
export { redact, REDACTED_MARKER } from "../../telegram-plugin/secret-detect/redact.js";
