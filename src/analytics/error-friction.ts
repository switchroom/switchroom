/**
 * PostHog wrapper for `switchroom_error_friction` events (#1758).
 *
 * One event per structured error envelope emission, fired from
 * `error-builder.ts`'s `.build()` as an intentionally-unawaited
 * side-effect. Reuses the existing `captureEvent` client in
 * `src/analytics/posthog.ts` — no new client, no new env var.
 *
 * PII discipline (issue spec):
 *   - NEVER send `human`, `why`, `docs` body, `yaml_path.to` value,
 *     raw `vault_key`, stdout/stderr tails, or `operator_steps` content.
 *   - `vault_key` → sha256, first 16 hex chars only.
 *   - `yaml_path` is allowed (structural, not secret —
 *     e.g. `hostd.config_edit_enabled`).
 *   - `request_id` verified PII-safe (caller-supplied opaque token).
 */

import { createHash } from "node:crypto";
import { captureEvent } from "./posthog.js";
import type { ErrorEnvelope } from "../host-control/protocol.js";

export interface ErrorFrictionContext {
  /** Verb / operation name (e.g. `config_propose_edit`). */
  op: string;
  /** Who hit the error — drives the friction-by-caller breakdown. */
  caller_kind: "agent" | "operator" | "unknown";
  /** Agent name if `caller_kind === "agent"`. */
  agent_name?: string;
}

function sha256Hex16(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);
}

export function recordErrorFriction(
  env: ErrorEnvelope,
  ctx: ErrorFrictionContext,
): void {
  // Intentional fire-and-forget — `captureEvent` is async but its
  // internal try/catch swallows errors, and we never want telemetry
  // to block (or worse, fail) an error response.
  void captureEvent("switchroom_error_friction", {
    code: env.code,
    op: ctx.op,
    caller_kind: ctx.caller_kind,
    agent_name: ctx.agent_name ?? null,
    fix_kind: env.fix?.kind ?? null,
    has_docs: Boolean(env.docs),
    request_id: env.request_id,
    vault_key_hash:
      env.fix?.kind === "request_vault_grant"
        ? sha256Hex16(env.fix.vault_key)
        : null,
    quota_name: env.fix?.kind === "quota_exceeded" ? env.fix.quota : null,
  });
}
