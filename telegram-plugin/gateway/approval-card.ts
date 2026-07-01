/**
 * Generic Telegram approval card primitive (RFC B §8).
 *
 * One shape, every surface (secrets / vault grants / MCP tools). Builds
 * the inline keyboard with [Allow once] [Allow always] [Deny] (and an
 * optional [⏱ For 1h] when ttl is offered) and the matching `apv:` callback
 * data. The `apv:` namespace is reserved for the approval kernel; the
 * gateway dispatch table routes those callbacks into kernel.consumeNonce
 * + kernel.recordDecision.
 *
 * Callback wire format (RFC §6.1, fits Telegram's 64-byte cap):
 *   apv:<8-hex request_id>:<choice>[:<param>]
 *     choice = once | always | deny | ttl
 *     param  = (for ttl) 1h | 24h | 7d
 */

import { escapeMarkdown, codeSpanSafe } from '../format.js';
import { InlineKeyboard } from "grammy";

// Re-export so existing importers (e.g. vault-request-access-card.ts) keep
// resolving `codeSpanSafe` from here; the canonical impl lives in format.ts.
export { codeSpanSafe };

export interface ApprovalCardOptions {
  request_id: string;       // 8-hex from kernel.requestApproval
  agent: string;            // shown in the title
  scope_humanized: string;  // human-readable scope (resolver may patch later)
  why?: string;             // optional context paragraph
  offer_always?: boolean;   // hide [Allow always] when scope is too narrow to bind a rule
  offer_ttl?: boolean;      // show [⏱ For 1h] secondary button
}

export interface BuiltApprovalCard {
  text: string;
  reply_markup: InlineKeyboard;
}

/**
 * Build the pristine approval card. Granted/denied/expired states are
 * rendered by the gateway after the user taps — those use editMessageText
 * with a fresh body, no buttons.
 */
export function buildApprovalCard(opts: ApprovalCardOptions): BuiltApprovalCard {
  const lines: string[] = [];
  lines.push(`🔐 **${escapeMarkdown(opts.agent)}** wants approval`);
  // The scope rides in a `code span` — content there is LITERAL, so it must
  // NOT be markdown-escaped (escaping would leak visible backslashes, e.g.
  // `secret:OPENAI\_API\_KEY`). Only an embedded backtick could break out of
  // the span, so defuse that one char with a zero-width space (#2669).
  lines.push(`\`${codeSpanSafe(opts.scope_humanized)}\``);
  if (opts.why && opts.why.trim().length > 0) {
    lines.push("");
    lines.push(escapeMarkdown(opts.why.trim()));
  }
  const text = lines.join("\n");

  const kb = new InlineKeyboard()
    .text("✅ Allow once", `apv:${opts.request_id}:once`)
    .text("🚫 Deny", `apv:${opts.request_id}:deny`);

  // Secondary row — Always + TTL when offered
  const secondary: Array<[string, string]> = [];
  if (opts.offer_always !== false) {
    secondary.push(["🔁 Always", `apv:${opts.request_id}:always`]);
  }
  if (opts.offer_ttl === true) {
    secondary.push(["⏱ For 1h", `apv:${opts.request_id}:ttl:1h`]);
  }
  if (secondary.length > 0) {
    kb.row();
    for (const [label, data] of secondary) {
      kb.text(label, data);
    }
  }

  return { text, reply_markup: kb };
}

/**
 * Parse an `apv:` callback. Returns null on a malformed string so the
 * caller can fall through to whatever generic-callback handling exists.
 */
export type ApprovalChoice =
  | { kind: "once" }
  | { kind: "always" }
  | { kind: "deny" }
  | { kind: "ttl"; param: string };

export interface ParsedApprovalCallback {
  request_id: string;
  choice: ApprovalChoice;
}

export function parseApprovalCallback(data: string): ParsedApprovalCallback | null {
  if (!data.startsWith("apv:")) return null;
  const parts = data.split(":");
  // apv:<id>:<choice>[:<param>]
  if (parts.length < 3) return null;
  const request_id = parts[1];
  const choiceStr = parts[2];
  if (!/^[0-9a-f]{32}$/.test(request_id ?? "")) return null;
  switch (choiceStr) {
    case "once":
      return { request_id: request_id as string, choice: { kind: "once" } };
    case "always":
      return { request_id: request_id as string, choice: { kind: "always" } };
    case "deny":
      return { request_id: request_id as string, choice: { kind: "deny" } };
    case "ttl": {
      const param = parts[3];
      if (!param) return null;
      return { request_id: request_id as string, choice: { kind: "ttl", param } };
    }
    default:
      return null;
  }
}

/** Map a TTL token like '1h' / '24h' / '7d' to milliseconds. */
export function ttlMsFromToken(token: string): number | null {
  const m = /^(\d+)([hd])$/.exec(token);
  if (!m) return null;
  const n = parseInt(m[1] ?? "", 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2];
  if (unit === "h") return n * 60 * 60 * 1000;
  if (unit === "d") return n * 24 * 60 * 60 * 1000;
  return null;
}

