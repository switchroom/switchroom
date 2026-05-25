// hostd config-edit approval handler (#1623 / RFC §3.3): posts an approval
// card, resolves the verdict back to hostd over IPC, and flips the card to
// a terminal state on finalize.

import type { IpcClient } from "./ipc-server.js";
import type {
  RequestConfigApprovalMessage,
  RequestConfigFinalizeMessage,
} from "./ipc-protocol.js";
import { truncateRawToFit } from "./oversize-card-body.js";

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
  /**
   * Send the full diff as a `.patch` document attachment when the
   * card body exceeds Telegram's 4096-char sendMessage limit
   * (#1762). Best-effort — failures are logged and do NOT block the
   * approval flow (the truncated card is still actionable).
   */
  postAttachment?: (args: {
    chatId: number | string;
    threadId?: number;
    filename: string;
    content: string;
  }) => Promise<void>;
  log?: (msg: string) => void;
}

/**
 * Build the card body (HTML). Renders the full diff in a `<pre>`
 * code block — Telegram caps messages at 4096 chars, so very large
 * diffs may be truncated by the API; the validator already caps
 * unified_diff at ~63 KiB so practical fleet edits fit comfortably.
 */
/**
 * Truncate a unified diff for inline display in the card body when
 * the full diff would exceed Telegram's 4096-char sendMessage limit.
 * Caps at `maxLines` lines AND at `maxChars` *raw* characters
 * (whichever trips first), then appends a sentinel pointing to the
 * attached `.patch` document. (#1762)
 *
 * NOTE: This is a *raw-input* cap. HTML escaping happens downstream
 * and can inflate by up to 5x per char (`&` → `&amp;`). The
 * load-bearing post-escape cap lives in `buildConfigApprovalCardBody`
 * (rendered-body cap), which re-truncates the raw diff if escaping
 * blew past Telegram's 4096 sendMessage limit. This function is the
 * cheap fast-path for the common case.
 */
export function truncateDiffForCard(
  unifiedDiff: string,
  maxLines = 50,
  maxChars = 3000,
): { out: string; truncated: boolean } {
  const sentinel = "\n[… diff continues, see attached file]";
  const lines = unifiedDiff.split("\n");
  let out: string;
  if (lines.length <= maxLines) {
    out = unifiedDiff;
  } else {
    out = lines.slice(0, maxLines).join("\n");
  }
  if (out.length > maxChars) {
    // Snap to the last complete line within the cap, falling back to
    // a hard char cut if a single line exceeds maxChars.
    const cap = out.slice(0, maxChars);
    const lastNl = cap.lastIndexOf("\n");
    out = lastNl > 0 ? cap.slice(0, lastNl) : cap;
  }
  if (out === unifiedDiff) return { out, truncated: false };
  return { out: out + sentinel, truncated: true };
}

/**
 * Telegram `sendMessage` hard limit. We render with `parse_mode=HTML`,
 * so the limit applies to the rendered (escaped) body, NOT the raw
 * pre-escape source. Worst-case escape is `&` → `&amp;` (5x).
 */
const TELEGRAM_SENDMESSAGE_LIMIT = 4096;
/** Safety margin under the hard limit for invisible framing wobble. */
const RENDERED_BODY_CAP = 3900;
/** Operator-supplied `reason` is unbounded at the wire — clip it. */
const REASON_MAX_CHARS = 500;
const REASON_ELLIPSIS = "…";
/**
 * Sentinel appended to a truncated diff in the inline card body when
 * the full diff ships separately as a `.patch` attachment. Exported
 * so the dispatcher can key oversize detection off the
 * `{truncated}` flag returned by `buildConfigApprovalCardBody`
 * instead of substring-matching this string.
 */
export const DIFF_SENTINEL = "\n[… diff continues, see attached file]";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function clipReason(reason: string): string {
  if (reason.length <= REASON_MAX_CHARS) return reason;
  return reason.slice(0, REASON_MAX_CHARS - REASON_ELLIPSIS.length) +
    REASON_ELLIPSIS;
}

/**
 * Render the card body, guaranteeing the result fits under Telegram's
 * 4096-char sendMessage limit even when HTML escaping inflates the
 * raw diff up to 5x (worst case: all `&`). Strategy:
 *
 *   1. Clip `reason` (user-supplied, unbounded) to REASON_MAX_CHARS.
 *   2. Render with the (already line/char-capped) diff.
 *   3. If the rendered body still exceeds RENDERED_BODY_CAP, binary-
 *      shrink the raw diff and re-render until it fits. Truncation
 *      happens on the RAW diff (then re-escaped), so we never cut
 *      mid-entity like `&am|p;`.
 *
 * The full diff still ships as a `.patch` attachment — this cap only
 * shrinks the inline preview.
 */
export function buildConfigApprovalCardBody(args: {
  agentName: string;
  reason: string;
  unifiedDiff: string;
}): { body: string; truncated: boolean } {
  const safeReason = clipReason(args.reason);
  const render = (diff: string): string =>
    `🛠 <b>Config edit proposed</b>\n` +
    `Agent: <code>${escapeHtml(args.agentName)}</code>\n` +
    `Reason: ${escapeHtml(safeReason)}\n\n` +
    `<pre>${escapeHtml(diff)}</pre>`;

  return truncateRawToFit({
    raw: args.unifiedDiff,
    render,
    cap: RENDERED_BODY_CAP,
    sentinel: DIFF_SENTINEL,
    hardLimit: TELEGRAM_SENDMESSAGE_LIMIT,
  });
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
    denySource?: "operator" | "dispatch_failure",
  ) => {
    try {
      client.send({
        type: "config_approval_resolved",
        requestId: msg.requestId,
        verdict,
        ...(reason ? { reason } : {}),
        ...(denySource ? { denySource } : {}),
      });
    } catch (err) {
      deps.log?.(
        `config_approval_resolved send failed (requestId=${msg.requestId}): ${(err as Error).message}`,
      );
    }
  };

  if (msg.agentName !== deps.agentName) {
    reply(
      "deny",
      `gateway serves '${deps.agentName}', not '${msg.agentName}'`,
      "dispatch_failure",
    );
    return;
  }

  const target = deps.loadTargetChat();
  if (target === null) {
    reply(
      "deny",
      "no target chat available — operator not paired?",
      "dispatch_failure",
    );
    return;
  }

  // Pre-flight oversize handling (#1762). Telegram caps sendMessage
  // at 4096 chars and we render with parse_mode=HTML, so the limit
  // applies to the rendered (escaped) body — worst-case `&` → `&amp;`
  // inflates 5x. Fast-path with a cheap raw-input cap, then let
  // buildConfigApprovalCardBody enforce the post-escape rendered cap
  // (which re-truncates the diff if escaping blew past the limit). We
  // ship the full diff as a `.patch` attachment whenever truncation
  // happens in either layer.
  const prelim = truncateDiffForCard(msg.unifiedDiff);
  const built = buildConfigApprovalCardBody({
    agentName: msg.agentName,
    reason: msg.reason,
    unifiedDiff: prelim.out,
  });
  const body = built.body;
  // Oversize iff EITHER the cheap raw fast-path trimmed lines OR the
  // post-escape rendered cap had to re-truncate. Keyed off the
  // structured `truncated` booleans from both layers rather than
  // substring-matching the sentinel string (#1767 review).
  const oversize = prelim.truncated || built.truncated;
  const replyMarkup = deps.buildKeyboard(msg.requestId);

  const posted = await deps.postCard({
    chatId: target.chatId,
    ...(target.threadId !== undefined ? { threadId: target.threadId } : {}),
    text: body,
    replyMarkup,
  });
  if (posted === null) {
    reply("deny", "Telegram sendMessage failed", "dispatch_failure");
    return;
  }
  if (oversize) {
    await maybePostAttachment(deps, target, msg);
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

/**
 * Best-effort attachment of the full diff as a `.patch` document.
 * Logged-and-swallowed on failure — the truncated card body remains
 * actionable even without the attachment. (#1762)
 */
async function maybePostAttachment(
  deps: ConfigApprovalHandlerDeps,
  target: { chatId: number | string; threadId?: number },
  msg: RequestConfigApprovalMessage,
): Promise<void> {
  if (deps.postAttachment === undefined) {
    deps.log?.(
      `oversize config approval card but no postAttachment dep wired (requestId=${msg.requestId})`,
    );
    return;
  }
  try {
    await deps.postAttachment({
      chatId: target.chatId,
      ...(target.threadId !== undefined ? { threadId: target.threadId } : {}),
      filename: `config-edit-${msg.requestId}.patch`,
      content: msg.unifiedDiff,
    });
  } catch (err) {
    deps.log?.(
      `config approval attachment failed (requestId=${msg.requestId}): ${(err as Error).message}`,
    );
  }
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
