/**
 * Structured error builder (#1758 Phase 1).
 *
 * Fluent API used at hostd error-emission sites to replace bare
 * `errorResponse(req.request_id, "E_FOO: human")` calls. Produces a
 * `HostdResponse` that carries BOTH the legacy `error: string` (for
 * one release cycle of backwards-compat) AND a structured
 * `error_envelope` agents read `fix.kind` from directly.
 *
 *   return err("E_CONFIG_EDIT_DISABLED", "config_propose_edit is disabled")
 *     .why("operator opt-in per RFC §3.3")
 *     .fixFlipFlag("hostd.config_edit_enabled", true)
 *     .docs("https://switchroom.dev/docs/config-edit#opt-in")
 *     .op("config_propose_edit")
 *     .caller("agent")
 *     .agentName(callerName)
 *     .build(req.request_id, Date.now() - started);
 *
 * `.build()` also fires `recordErrorFriction(envelope, ctx)` as an
 * intentionally-unawaited side-effect. Any synchronous throw from
 * the recorder is swallowed defensively — telemetry must never block
 * an error response.
 */

import type {
  ErrorEnvelope,
  ErrorFix,
  HostdResponse,
} from "./protocol.js";
import {
  recordErrorFriction,
  type ErrorFrictionContext,
} from "../analytics/error-friction.js";

export class ErrorBuilder {
  private _code: string;
  private _human: string;
  private _why?: string;
  private _fix?: ErrorFix;
  private _docs?: string;
  private _op = "unknown";
  private _caller: "agent" | "operator" | "unknown" = "unknown";
  private _agentName?: string;
  private _result: "denied" | "error" = "error";

  constructor(code: string, human: string) {
    this._code = code;
    this._human = human;
  }

  why(reason: string): this {
    this._why = reason;
    return this;
  }

  fixFlipFlag(yamlPath: string, to: unknown): this {
    this._fix = { kind: "flip_yaml_flag", yaml_path: yamlPath, to };
    return this;
  }

  fixVaultGrant(vaultKey: string): this {
    this._fix = { kind: "request_vault_grant", vault_key: vaultKey };
    return this;
  }

  fixOperatorAction(
    subkind: "policy_denied" | "infra" | "out_of_scope",
    steps?: string[],
  ): this {
    this._fix = {
      kind: "operator_action",
      subkind,
      ...(steps && steps.length > 0 ? { operator_steps: steps } : {}),
    };
    return this;
  }

  fixRetryAfter(retryAt: string): this {
    this._fix = { kind: "retry_after", retry_at: retryAt };
    return this;
  }

  fixQuotaExceeded(quota: string, current: number, limit: number): this {
    this._fix = { kind: "quota_exceeded", quota, current, limit };
    return this;
  }

  fixBadInput(field?: string): this {
    this._fix = { kind: "bad_input", ...(field ? { field } : {}) };
    return this;
  }

  /**
   * Set the docs URL. Validated at author-time (fail loud) so a new
   * call site can't ship an envelope that fails its own
   * `ErrorEnvelopeSchema` (which enforces `z.string().url()`).
   * Throws `TypeError` on a non-URL string — matches how the rest of
   * the codebase treats author-mistake categories (e.g. zod schemas
   * elsewhere parse-throw rather than silently coerce). Issue #1761.
   */
  docs(url: string): this {
    try {
      // node's URL constructor is stricter than a regex and matches
      // zod's `.url()` behavior. Author-time throw beats a runtime
      // schema parse-failure at the receiver.
      new URL(url);
    } catch {
      throw new TypeError(
        `err().docs(): invalid URL: ${JSON.stringify(url)} — ErrorEnvelopeSchema requires a fully-qualified URL`,
      );
    }
    this._docs = url;
    return this;
  }

  op(name: string): this {
    this._op = name;
    return this;
  }

  caller(kind: "agent" | "operator" | "unknown"): this {
    this._caller = kind;
    return this;
  }

  agentName(name?: string): this {
    this._agentName = name;
    return this;
  }

  /** Mark this builder as a `denied` (not `error`) result. Default is `error`. */
  asDenied(): this {
    this._result = "denied";
    return this;
  }

  build(requestId: string, durationMs: number): HostdResponse {
    const envelope: ErrorEnvelope = {
      v: 1,
      code: this._code,
      human: this._human,
      ...(this._why !== undefined ? { why: this._why } : {}),
      ...(this._fix !== undefined ? { fix: this._fix } : {}),
      ...(this._docs !== undefined ? { docs: this._docs } : {}),
      request_id: requestId,
    };
    // Synthesise the legacy `error` string so existing string-matching
    // decoders (audit reader, vault-broker client, telegram-plugin
    // gateway response handler) see no semantic regression.
    const legacy =
      `${this._code}: ${this._human}` +
      (this._why ? ` — ${this._why}` : "");

    const ctx: ErrorFrictionContext = {
      op: this._op,
      caller_kind: this._caller,
      ...(this._agentName ? { agent_name: this._agentName } : {}),
    };
    // Intentional fire-and-forget. If the recorder itself throws
    // synchronously (it shouldn't — captureEvent already has internal
    // try/catch), swallow it: telemetry must never break the error
    // response.
    try {
      recordErrorFriction(envelope, ctx);
    } catch {
      // swallow
    }

    return {
      v: 1,
      request_id: requestId,
      result: this._result,
      exit_code: null,
      duration_ms: durationMs,
      error: legacy,
      error_envelope: envelope,
    };
  }
}

export function err(code: string, human: string): ErrorBuilder {
  return new ErrorBuilder(code, human);
}
