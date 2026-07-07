/**
 * Microsoft 365 write approval handler — RFC #1873 §8 PR 4.
 *
 * Mirrors `drive-write-approval.ts` shape but with the weak-metadata
 * v1 preview (file path / item ID / size delta / deep link / agent
 * rationale) instead of Google's full DiffPreviewInput.
 *
 * Flow (called by the gateway's IPC dispatcher when the
 * `ms-365-write-pretool` hook sends `request_ms365_approval`):
 *   1. Validate the inbound preview payload (`validateMs365Preview`).
 *   2. Verify the request is for this gateway's agent (cross-agent
 *      requests rejected — defense in depth).
 *   3. Register a kernel approval at scope `ms-365:write:<itemId>`,
 *      action `write`, approver_set = operator allowFrom.
 *   4. Build a plain-text Telegram card showing: tool, target file/
 *      item, size delta, deep link, agent's rationale.
 *   5. Post the card to operator chat.
 *   6. Send `ms365_approval_posted { ok, requestId, expiresAtMs }` back
 *      over IPC so the hook can poll `approval_lookup` for verdict.
 *
 * Fail closed: on any failure (preview malformed, kernel down, card
 * post fails) we send `ok: false` so the hook fails closed and blocks
 * the tool call.
 *
 * **Why weak metadata v1** — softeria upload calls are full-file
 * replacements; computing a structural diff would require downloading
 * the prior version and running the docx/xlsx/pptx skill in diff mode.
 * That's RFC §8 v1.5 work; v1 ships the simpler "operator must trust
 * the agent's rationale + click through to OneDrive to verify" shape.
 */

import type { IpcClient } from "./ipc-server.js";
import type { RequestMs365ApprovalMessage } from "./ipc-protocol.js";
import { hardenCardBreaks } from "../format.js";

// ────────────────────────────────────────────────────────────────────────
// Wire shape — validates an inbound preview payload
// ────────────────────────────────────────────────────────────────────────

export interface Ms365WritePreview {
  /** Agent slug — appears on the card title. */
  agentName: string;
  /** Tool name as Claude Code sees it: `mcp__ms-365__<fn>`. */
  toolName: string;
  /**
   * Item identifier for the OneDrive item / mail message / calendar
   * event the tool will mutate. Used as the kernel scope key:
   * `ms-365:write:<itemId>`. May be "(new)" for create operations.
   */
  itemId: string;
  /** Display name (file name / mail subject / event title). */
  itemDisplayName: string;
  /** Microsoft account email the agent is authenticated as. */
  accountEmail: string;
  /** Deep link to OneDrive / Outlook web — best-effort, may be empty. */
  deepLink?: string;
  /** Byte delta — present only for OneDrive uploads with known sizes. */
  sizeBytesBefore?: number;
  sizeBytesAfter?: number;
  /** 1-line agent rationale — advisory; operator should not over-trust. */
  agentRationale?: string;
}

/**
 * Validate a wire payload into a typed Ms365WritePreview. Returns null
 * on malformed input (defense in depth — the hook is trusted but the
 * payload may be corrupted in transit / by future-version drift).
 */
export function validateMs365Preview(input: unknown): Ms365WritePreview | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  if (typeof o.agentName !== "string" || o.agentName.length === 0) return null;
  if (typeof o.toolName !== "string" || o.toolName.length === 0) return null;
  if (typeof o.itemId !== "string" || o.itemId.length === 0) return null;
  if (typeof o.itemDisplayName !== "string") return null;
  if (typeof o.accountEmail !== "string") return null;
  const out: Ms365WritePreview = {
    agentName: o.agentName,
    toolName: o.toolName,
    itemId: o.itemId,
    itemDisplayName: o.itemDisplayName,
    accountEmail: o.accountEmail,
  };
  if (typeof o.deepLink === "string") out.deepLink = o.deepLink;
  if (typeof o.sizeBytesBefore === "number") out.sizeBytesBefore = o.sizeBytesBefore;
  if (typeof o.sizeBytesAfter === "number") out.sizeBytesAfter = o.sizeBytesAfter;
  if (typeof o.agentRationale === "string") out.agentRationale = o.agentRationale;
  return out;
}

// ────────────────────────────────────────────────────────────────────────
// Handler — DI shape mirrors DriveApprovalHandlerDeps
// ────────────────────────────────────────────────────────────────────────

export interface Ms365ApprovalHandlerDeps {
  agentName: string;
  loadAllowFrom: () => string[];
  loadTargetChat: () => {
    chatId: number | string;
    threadId?: number;
  } | null;
  registerApproval: (args: {
    agent_unit: string;
    scope: string;
    action: string;
    approver_set: string[];
    why: string;
    ttl_ms: number;
  }) => Promise<{ request_id: string; expires_at_ms: number } | null>;
  postCard: (args: {
    chatId: number | string;
    threadId?: number;
    text: string;
    replyMarkup: unknown;
  }) => Promise<{ messageId: number } | null>;
  /**
   * Build the inline keyboard. Defaults to 2-button [✅ Approve]
   * [🚫 Deny] using callback_data `apv:<requestId>:once|deny` — the
   * SAME shape Drive uses. The existing gateway `apv:` handler at
   * `gateway.ts:handleApprovalCallback` consumes the kernel state
   * machine generically (no provider awareness). Reused on purpose:
   * provider-namespaced callback_data would silently drop button
   * taps because there's no `ms365:` branch in the dispatcher.
   * Reviewer of PR 4 caught this — the original `ms365:` prefix was
   * an unwired dead end.
   */
  buildKeyboard?: (requestId: string) => unknown;
  log?: (msg: string) => void;
  defaultTtlMs?: number;
  maxTtlMs?: number;
  minTtlMs?: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const MAX_TTL_MS = 30 * 60 * 1000;
const MIN_TTL_MS = 30 * 1000;

function defaultKeyboard(requestId: string): unknown {
  // `apv:<requestId>:once` is the kernel-generic approval shape used
  // by Drive's diff-preview cards. The existing `apv:` dispatch
  // branch at gateway.ts:14149 routes the kernel consume + record
  // for any provider. Mirroring `apv:` keeps the M365 cards wired
  // through the same well-tested approval state machine instead of a
  // new provider-namespaced one with its own bug surface.
  return {
    inline_keyboard: [
      [
        { text: "✅ Approve", callback_data: `apv:${requestId}:once` },
        { text: "🚫 Deny", callback_data: `apv:${requestId}:deny` },
      ],
    ],
  };
}

/**
 * Build the card body. Plain text (no Markdown) to keep escaping
 * trivial. Truncates the rationale + display name to fit Telegram's
 * 4096-char message limit with safety margin.
 */
export function buildMs365CardText(p: Ms365WritePreview): string {
  const lines: string[] = [];
  lines.push(`📄 Microsoft 365 write approval`);
  lines.push("");
  lines.push(`Agent: ${truncate(p.agentName, 64)}`);
  lines.push(`Tool: ${truncate(p.toolName.replace(/^mcp__/, ""), 96)}`);
  lines.push(`Item: ${truncate(p.itemDisplayName, 256)}`);
  if (p.itemId !== "(new)") {
    lines.push(`ID:   ${truncate(p.itemId, 96)}`);
  }
  lines.push(`Account: ${truncate(p.accountEmail, 96)}`);
  if (
    typeof p.sizeBytesBefore === "number" ||
    typeof p.sizeBytesAfter === "number"
  ) {
    const before = p.sizeBytesBefore ?? 0;
    const after = p.sizeBytesAfter ?? 0;
    const delta = after - before;
    const sign = delta >= 0 ? "+" : "";
    lines.push(`Size: ${humanBytes(before)} → ${humanBytes(after)} (${sign}${humanBytes(delta)})`);
  }
  if (p.deepLink) {
    lines.push(`Link: ${truncate(p.deepLink, 256)}`);
  }
  if (p.agentRationale) {
    lines.push("");
    lines.push(`💬 ${truncate(p.agentRationale, 512)}`);
  }
  lines.push("");
  lines.push(
    "⚠️ Weak attestation (RFC §8 v1): operator should click through to verify the actual change before approving. Structural diff coming v1.5.",
  );
  // hardenCardBreaks: labelled field lines (Agent:/Tool:/Item:/Account:/Size:…)
  // would soft-collapse into one blob under the GFM rich renderer; this card is
  // posted direct (not via the switchroomReply chokepoint).
  return hardenCardBreaks(lines.join("\n"));
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

function humanBytes(bytes: number): string {
  const abs = Math.abs(bytes);
  if (abs < 1024) return `${bytes}B`;
  if (abs < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (abs < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

function clampTtl(
  requested: number | undefined,
  def: number,
  min: number,
  max: number,
): number {
  if (typeof requested !== "number" || !Number.isFinite(requested)) return def;
  return Math.max(min, Math.min(max, requested));
}

/**
 * Main handler — wire the inbound IPC message to kernel + card post.
 */
export async function handleRequestMs365Approval(
  client: IpcClient,
  msg: RequestMs365ApprovalMessage,
  deps: Ms365ApprovalHandlerDeps,
): Promise<void> {
  const log = deps.log ?? (() => {});
  const sendResponse = (
    ok: boolean,
    extra: {
      requestId?: string;
      expiresAtMs?: number;
      reason?: string;
    } = {},
  ): void => {
    client.send({
      type: "ms365_approval_posted",
      correlationId: msg.correlationId,
      ok,
      ...extra,
    });
  };

  // Cross-agent guard
  if (msg.agentName !== deps.agentName) {
    log(
      `ms365-approval: cross-agent request rejected (msg=${msg.agentName} vs gateway=${deps.agentName})`,
    );
    sendResponse(false, { reason: "cross-agent request rejected" });
    return;
  }

  const preview = validateMs365Preview(msg.preview);
  if (!preview) {
    log("ms365-approval: invalid preview payload");
    sendResponse(false, { reason: "invalid preview payload" });
    return;
  }

  const allowFrom = deps.loadAllowFrom();
  if (allowFrom.length === 0) {
    log("ms365-approval: no operator allowFrom configured");
    sendResponse(false, { reason: "no operator allowFrom configured" });
    return;
  }

  const targetChat = deps.loadTargetChat();
  if (!targetChat) {
    log("ms365-approval: no target chat resolved");
    sendResponse(false, { reason: "no target chat resolved" });
    return;
  }

  const ttlMs = clampTtl(
    msg.ttlMs,
    deps.defaultTtlMs ?? DEFAULT_TTL_MS,
    deps.minTtlMs ?? MIN_TTL_MS,
    deps.maxTtlMs ?? MAX_TTL_MS,
  );

  const scope = `ms-365:write:${preview.itemId}`;
  const why =
    preview.agentRationale ??
    `${preview.toolName} on ${preview.itemDisplayName}`;

  let registered;
  try {
    registered = await deps.registerApproval({
      agent_unit: preview.agentName,
      scope,
      action: "write",
      approver_set: allowFrom,
      why,
      ttl_ms: ttlMs,
    });
  } catch (err) {
    const msg2 = err instanceof Error ? err.message : String(err);
    log(`ms365-approval: kernel register failed — ${msg2}`);
    sendResponse(false, { reason: `kernel register failed: ${msg2}` });
    return;
  }
  if (!registered) {
    sendResponse(false, { reason: "kernel returned no request_id" });
    return;
  }

  const text = buildMs365CardText(preview);
  const replyMarkup = (deps.buildKeyboard ?? defaultKeyboard)(registered.request_id);

  let posted;
  try {
    posted = await deps.postCard({
      chatId: targetChat.chatId,
      threadId: targetChat.threadId,
      text,
      replyMarkup,
    });
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    log(`ms365-approval: card post threw — ${m}`);
    sendResponse(false, { reason: `card post failed: ${m}` });
    return;
  }
  if (!posted) {
    sendResponse(false, { reason: "card post returned null" });
    return;
  }

  log(
    `ms365-approval: posted card msg=${posted.messageId} request=${registered.request_id} expires=${new Date(registered.expires_at_ms).toISOString()}`,
  );

  sendResponse(true, {
    requestId: registered.request_id,
    expiresAtMs: registered.expires_at_ms,
  });
}
