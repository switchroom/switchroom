/**
 * Tier-0 model-free action engine — docs/rfcs/cheap-cron-sessions.md §2.1,
 * reference/crons-use-the-model-only-when-it-earns-it.md.
 *
 * A `kind: action` entry COMPLETES its work deterministically in the
 * scheduler process: send a fixed/templated Telegram message to the agent's
 * OWN chat, or fire a fixed HTTP webhook to an allowlisted host. Zero model
 * calls — no `claude`, no SDK, no `inject_inbound`, no session wake. The
 * terminal sibling of poll-engine.ts (a poll escalates on a hit; an action
 * just does the thing). Deps are injected so the engine is unit-tested
 * without network, broker, or gateway.
 *
 * Subscription-honesty: there is no model/inference seam anywhere in this
 * module by construction — `ActionDeps` carries only fetch / vault-secret /
 * dns / egress-allowlist / a model-free `sendMessage`. An action never
 * returns anything that triggers a dispatch.
 */

import type {
  ActionSpecSchema,
  TelegramMessageActionSchema,
  WebhookActionSchema,
} from "../config/schema.js";
import type { z } from "zod";
import {
  checkEgressUrl,
  checkSecretBinding,
  isBlockedAddress,
  normalizeHost,
  type EgressAllowlist,
} from "./poll-egress.js";

export type ActionSpec = z.infer<typeof ActionSpecSchema>;
export type TelegramMessageAction = z.infer<typeof TelegramMessageActionSchema>;
export type WebhookAction = z.infer<typeof WebhookActionSchema>;

export interface ActionDeps {
  /** injected for tests; the real one wraps global fetch (webhook only). */
  fetchImpl: typeof fetch;
  /** resolve a vault secret by name via the in-container broker (webhook only). */
  resolveSecret: (name: string) => Promise<string>;
  /** DNS lookup → resolved IP, for the rebind pin. Return null to skip the pin. */
  lookup: (host: string) => Promise<string | null>;
  allow: EgressAllowlist;
  /** Fire clock — drives {{date}}/{{time}} substitution. */
  now: () => number;
  /** Agent slug — drives {{agent}} substitution. */
  agent: string;
  /**
   * Post a model-free outbound to the AGENT'S OWN chat (the chat + thread are
   * bound by the caller — the engine never sees a chat id, so a
   * telegram-message action cannot target a foreign chat). Returns false on a
   * delivery failure. This is the ONLY output seam and it never wakes a model.
   */
  sendMessage: (text: string, opts: { parseMode: "html" | "text" }) => Promise<boolean>;
  /** Webhook response size cap (bytes). Default 1 MiB. */
  maxBytes?: number;
  /** Webhook fetch timeout (ms). Default 5000. */
  timeoutMs?: number;
}

export interface ActionOutcome {
  /** true ⟹ the action completed; false ⟹ a (non-fatal) error to audit. */
  ok: boolean;
  /** Short human summary for the JSONL audit. */
  summary: string;
  /** Set ⟹ the action failed (audited; never throws out of the tick loop). */
  error?: string;
}

// Deterministic placeholders ONLY — date/time from the fire clock, agent slug.
// Crucially NOT secrets and NOT model output: a telegram-message's text is a
// pure function of config + these.
const PLACEHOLDER_RE = /\{\{\s*(date|time|agent)\s*\}\}/g;

export function substituteDeterministic(
  text: string,
  ctx: { now: number; agent: string },
): string {
  const d = new Date(ctx.now);
  const date = d.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  const time = d.toISOString().slice(11, 16); // HH:MM (UTC)
  return text.replace(PLACEHOLDER_RE, (_, name: string) => {
    if (name === "date") return date;
    if (name === "time") return time;
    return ctx.agent;
  });
}

// {{secret-name}} substitution for webhook headers/body (mirrors poll-engine).
function substituteSecrets(s: string, secretValues: Record<string, string>): string {
  return s.replace(/\{\{([a-zA-Z0-9_\-/]+)\}\}/g, (_, name: string) => secretValues[name] ?? "");
}

async function runTelegramMessage(
  spec: TelegramMessageAction,
  deps: ActionDeps,
): Promise<ActionOutcome> {
  const text = substituteDeterministic(spec.text, { now: deps.now(), agent: deps.agent });
  let delivered: boolean;
  try {
    delivered = await deps.sendMessage(text, { parseMode: spec.parse_mode });
  } catch (e) {
    return { ok: false, summary: "", error: `send failed: ${(e as Error).message}` };
  }
  return delivered
    ? { ok: true, summary: `message sent (${text.length} chars)` }
    : { ok: false, summary: "", error: "message not delivered (no gateway / send rejected)" };
}

async function runWebhook(spec: WebhookAction, deps: ActionDeps): Promise<ActionOutcome> {
  // §6.1 gate BEFORE any network or secret resolution — reuse the poll fence.
  const gate = checkEgressUrl(spec.url, deps.allow);
  if (!gate.ok) return { ok: false, summary: "", error: `egress denied: ${gate.reason}` };
  const host = normalizeHost(new URL(spec.url).hostname);
  for (const s of spec.secrets) {
    const sc = checkSecretBinding(s, host, deps.allow);
    if (!sc.ok) return { ok: false, summary: "", error: `egress denied: ${sc.reason}` };
  }

  // DNS-rebind pin: resolve and re-check the IP against blocked ranges.
  try {
    const ip = await deps.lookup(host);
    if (ip && isBlockedAddress(ip)) return { ok: false, summary: "", error: `resolved ip ${ip} blocked` };
  } catch (e) {
    return { ok: false, summary: "", error: `dns lookup failed: ${(e as Error).message}` };
  }

  // Resolve secrets and substitute into headers + body via {{name}}.
  const secretValues: Record<string, string> = {};
  for (const name of spec.secrets) {
    try {
      secretValues[name] = await deps.resolveSecret(name);
    } catch (e) {
      return { ok: false, summary: "", error: `secret ${name}: ${(e as Error).message}` };
    }
  }
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(spec.headers ?? {})) {
    headers[k] = substituteSecrets(v, secretValues);
  }
  const body = spec.body !== undefined ? substituteSecrets(spec.body, secretValues) : undefined;

  // Fenced fetch: no redirects, hard timeout, response discarded (size-capped).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 5000);
  try {
    const res = await deps.fetchImpl(spec.url, {
      method: spec.method,
      headers,
      ...(body !== undefined ? { body } : {}),
      redirect: "error",
      signal: controller.signal,
    });
    // Drain (capped) so the socket closes; we don't parse the response.
    const buf = await res.arrayBuffer();
    if (buf.byteLength > (deps.maxBytes ?? 1024 * 1024)) {
      return { ok: false, summary: "", error: `response ${buf.byteLength}B exceeds cap` };
    }
    if (!res.ok) return { ok: false, summary: "", error: `http ${res.status}` };
    return { ok: true, summary: `webhook ${spec.method} ${host} → ${res.status}` };
  } catch (e) {
    return { ok: false, summary: "", error: `fetch failed: ${(e as Error).message}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run a declarative action model-free. Never throws — every failure is
 * returned as `{ ok: false, error }` so the scheduler tick records it and
 * moves on without affecting sibling entries.
 */
export async function runAction(spec: ActionSpec, deps: ActionDeps): Promise<ActionOutcome> {
  switch (spec.type) {
    case "telegram-message":
      return runTelegramMessage(spec, deps);
    case "webhook":
      return runWebhook(spec, deps);
    default: {
      // Exhaustiveness guard — a new action type without an arm lands here.
      const _never: never = spec;
      return { ok: false, summary: "", error: `unknown action type: ${JSON.stringify(_never)}` };
    }
  }
}
