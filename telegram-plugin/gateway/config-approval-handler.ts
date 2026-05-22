// hostd config-edit approval handler (#1623 / RFC §3.3): posts an approval
// card, resolves the verdict back to hostd over IPC, and flips the card to
// a terminal state on finalize.

import type { IpcClient } from "./ipc-server.js";
import type {
  RequestConfigApprovalMessage,
  RequestConfigFinalizeMessage,
} from "./ipc-protocol.js";

/** Pending approval state — in-memory only (no SQLite per RFC §3.4). */
interface PendingConfigApproval {
  requestId: string;
  client: Pick<IpcClient, "send">;
  chatId: number | string;
  threadId?: number;
  messageId: number;
  /** node:Timeout — set when the timer is armed; cleared once the
   *  request resolves (approve/deny/timeout) to make resolve idempotent. */
  timer: ReturnType<typeof setTimeout> | null;
  /** Has a verdict already been sent? Guards against double-tap. */
  resolved: boolean;
}

const pending = new Map<string, PendingConfigApproval>();

// Injected deps — gateway.ts wires these from the existing surface.

export interface ConfigApprovalHandlerDeps {
  /** This gateway's agent name — cross-agent requests rejected. */
  agentName: string;
  /** Operator's primary chat for the card. Returns null if not paired. */
  loadTargetChat: () => {
    chatId: number | string;
    threadId?: number;
  } | null;
  /** Post the Telegram card. Returns the posted message id on success. */
  postCard: (args: {
    chatId: number | string;
    threadId?: number;
    text: string;
    /** grammy InlineKeyboard, passed through verbatim. */
    replyMarkup: unknown;
  }) => Promise<{ messageId: number } | null>;
  /** Build the inline keyboard with [✅ Approve] [🚫 Deny] buttons. */
  buildKeyboard: (requestId: string) => unknown;
  /** Edit a posted card to a new body. Best-effort — failures logged. */
  editCard: (args: {
    chatId: number | string;
    messageId: number;
    text: string;
  }) => Promise<void>;
  log?: (msg: string) => void;
}

/**
 * Build the card body (HTML). Renders the full diff in a `<pre>`
 * code block — Telegram caps messages at 4096 chars, so very large
 * diffs may be truncated by the API; the validator already caps
 * unified_diff at ~63 KiB so practical fleet edits fit comfortably.
 */
export function buildConfigApprovalCardBody(args: {
  agentName: string;
  reason: string;
  unifiedDiff: string;
}): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return (
    `🛠 <b>Config edit proposed</b>\n` +
    `Agent: <code>${esc(args.agentName)}</code>\n` +
    `Reason: ${esc(args.reason)}\n\n` +
    `<pre>${esc(args.unifiedDiff)}</pre>`
  );
}

/**
 * Top-level handler — called by the IPC dispatcher.
 */
export async function handleRequestConfigApproval(
  client: Pick<IpcClient, "send">,
  msg: RequestConfigApprovalMessage,
  deps: ConfigApprovalHandlerDeps,
): Promise<void> {
  const reply = (
    verdict: "approve" | "deny" | "timeout",
    reason?: string,
  ) => {
    try {
      client.send({
        type: "config_approval_resolved",
        requestId: msg.requestId,
        verdict,
        ...(reason ? { reason } : {}),
      });
    } catch (err) {
      deps.log?.(
        `config_approval_resolved send failed (requestId=${msg.requestId}): ${(err as Error).message}`,
      );
    }
  };

  if (msg.agentName !== deps.agentName) {
    reply("deny", `gateway serves '${deps.agentName}', not '${msg.agentName}'`);
    return;
  }

  const target = deps.loadTargetChat();
  if (target === null) {
    reply("deny", "no target chat available — operator not paired?");
    return;
  }

  const body = buildConfigApprovalCardBody({
    agentName: msg.agentName,
    reason: msg.reason,
    unifiedDiff: msg.unifiedDiff,
  });
  const replyMarkup = deps.buildKeyboard(msg.requestId);

  const posted = await deps.postCard({
    chatId: target.chatId,
    ...(target.threadId !== undefined ? { threadId: target.threadId } : {}),
    text: body,
    replyMarkup,
  });
  if (posted === null) {
    reply("deny", "Telegram sendMessage failed");
    return;
  }

  const entry: PendingConfigApproval = {
    requestId: msg.requestId,
    client,
    chatId: target.chatId,
    ...(target.threadId !== undefined ? { threadId: target.threadId } : {}),
    messageId: posted.messageId,
    timer: null,
    resolved: false,
  };
  entry.timer = setTimeout(() => {
    void resolvePendingConfigApproval(msg.requestId, "timeout", deps).catch(
      (err) =>
        deps.log?.(
          `config approval timeout handler threw (requestId=${msg.requestId}): ${(err as Error).message}`,
        ),
    );
  }, msg.timeoutMs);
  pending.set(msg.requestId, entry);

  deps.log?.(
    `config_approval_posted requestId=${msg.requestId} agent=${msg.agentName} messageId=${posted.messageId}`,
  );
}

/**
 * Called by the `cfg:` callback dispatcher in gateway.ts on an
 * operator tap, by the per-request timer on expiry, OR by the
 * finalize path defensively before edit. Sends a single
 * `config_approval_resolved` reply over the original client
 * connection and edits the card to the interim state. Double-tap
 * safe — subsequent calls for the same requestId are no-ops.
 *
 * Returns true if THIS call resolved the request (first call wins),
 * false if it was already resolved.
 */
export async function resolvePendingConfigApproval(
  requestId: string,
  verdict: "approve" | "deny" | "timeout",
  deps: Pick<ConfigApprovalHandlerDeps, "editCard" | "log">,
): Promise<boolean> {
  const entry = pending.get(requestId);
  if (!entry || entry.resolved) return false;
  entry.resolved = true;
  if (entry.timer !== null) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }

  // Send the verdict back to hostd. Best effort — if the IPC
  // connection has dropped, hostd's own timeout will fire.
  try {
    entry.client.send({
      type: "config_approval_resolved",
      requestId,
      verdict,
    });
  } catch (err) {
    deps.log?.(
      `config_approval_resolved send failed (requestId=${requestId}): ${(err as Error).message}`,
    );
  }

  // Edit the card to an interim/terminal state.
  const interim =
    verdict === "approve"
      ? "👀 <b>Applying…</b>"
      : verdict === "deny"
        ? "🚫 <b>Denied</b>"
        : "⏱ <b>Expired</b>";
  try {
    await deps.editCard({
      chatId: entry.chatId,
      messageId: entry.messageId,
      text: interim,
    });
  } catch (err) {
    deps.log?.(
      `config approval card edit failed (requestId=${requestId}): ${(err as Error).message}`,
    );
  }
  return true;
}

/** IPC `request_config_finalize` handler — edits the card to the terminal outcome. */
export async function handleRequestConfigFinalize(
  _client: Pick<IpcClient, "send">,
  msg: RequestConfigFinalizeMessage,
  deps: Pick<ConfigApprovalHandlerDeps, "editCard" | "log">,
): Promise<void> {
  const entry = pending.get(msg.requestId);
  if (!entry) {
    deps.log?.(
      `config_finalize: no pending entry for requestId=${msg.requestId} (likely already cleaned up)`,
    );
    return;
  }
  // Clean up the pending entry — finalize is the terminal transition.
  pending.delete(msg.requestId);

  const body =
    msg.outcome === "applied"
      ? `✅ <b>Applied</b>${msg.detail ? `\n${escapeHtml(msg.detail)}` : ""}`
      : `⚠️ <b>Reconcile failed; rolled back</b>${msg.detail ? `\n${escapeHtml(msg.detail)}` : ""}`;
  try {
    await deps.editCard({
      chatId: entry.chatId,
      messageId: entry.messageId,
      text: body,
    });
  } catch (err) {
    deps.log?.(
      `config finalize card edit failed (requestId=${msg.requestId}): ${(err as Error).message}`,
    );
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Test-only: clear the in-memory pending map between cases.
export function _resetPendingConfigApprovalsForTest(): void {
  for (const entry of pending.values()) {
    if (entry.timer !== null) clearTimeout(entry.timer);
  }
  pending.clear();
}

// Test-only: peek at a pending entry.
export function _peekPendingConfigApprovalForTest(
  requestId: string,
): Readonly<PendingConfigApproval> | undefined {
  return pending.get(requestId);
}

/**
 * Parse `cfg:<requestId>:<choice>` callback data. Returns null on
 * malformed input. The callback handler in gateway.ts uses this +
 * resolvePendingConfigApproval to drive the tap → resolve flow.
 */
export function parseConfigApprovalCallback(
  data: string,
): { requestId: string; choice: "approve" | "deny" } | null {
  if (!data.startsWith("cfg:")) return null;
  const rest = data.slice(4);
  const colon = rest.lastIndexOf(":");
  if (colon < 0) return null;
  const requestId = rest.slice(0, colon);
  const choice = rest.slice(colon + 1);
  if (requestId.length === 0 || requestId.length > 64) return null;
  if (choice !== "approve" && choice !== "deny") return null;
  return { requestId, choice };
}
