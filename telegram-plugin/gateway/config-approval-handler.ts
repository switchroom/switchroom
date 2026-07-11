// hostd config-edit approval handler (#1623 / RFC §3.3): posts an approval
// card, resolves the verdict back to hostd over IPC, and flips the card to
// a terminal state on finalize.

import { escapeMarkdown } from '../format.js';
import { randomBytes } from "node:crypto";
import type { IpcClient } from "./ipc-server.js";
import type {
  RequestConfigApprovalMessage,
  RequestConfigFinalizeMessage,
} from "./ipc-protocol.js";
import { truncateRawToFit } from "./oversize-card-body.js";

/** Pending approval state — in-memory only (no SQLite per RFC §3.4). */
interface PendingConfigApproval {
  requestId: string;
  /**
   * Per-card nonce embedded in the callback_data (`cfg:<requestId>:<epoch>:
   * <choice>`). hostd's `approvalId` is only randomBytes(4)=32 bits and the
   * callback_data carried no epoch, so a stale tap on a never-stripped old
   * card could in principle resolve a same-id LIVE request. A tap whose epoch
   * doesn't match the live pending entry is rejected as stale (see
   * `resolvePendingConfigApproval`).
   */
  epoch: string;
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

/** Default per-card nonce: 8 hex chars (32 bits) — enough to make a stale
 *  tap's epoch effectively never collide with a live card's. */
function defaultEpoch(): string {
  return randomBytes(4).toString("hex");
}

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
  /**
   * Build the inline keyboard with [✅ Approve] [🚫 Deny] buttons. The
   * `epoch` is a per-card nonce baked into the callback_data so a stale tap
   * on an old card can never match a live request (see PendingConfigApproval).
   */
  buildKeyboard: (requestId: string, epoch: string) => unknown;
  /** Mint a per-card nonce. Default: a short random hex (test seam). */
  mintEpoch?: () => string;
  /**
   * Edit a posted card to a new body. Best-effort — failures logged.
   * When `stripKeyboard` is set, the inline keyboard is removed so the
   * [✅ Approve] [🚫 Deny] buttons stop being tappable on a card that has
   * reached a terminal/interim state — a stale tap must never resolve a
   * request (defense-in-depth alongside the per-card epoch in callback_data).
   */
  editCard: (args: {
    chatId: number | string;
    messageId: number;
    text: string;
    stripKeyboard?: boolean;
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
  /**
   * Single-tap correlation auto-resolve (#1977, security-critical).
   *
   * The durable "🔁 Always allow" flow has the gateway itself call
   * hostd's `config_propose_edit`. hostd then calls BACK to the gateway
   * asking for operator approval — but the operator already tapped the
   * permission card, so posting a SECOND approval card would be a
   * confusing double-tap.
   *
   * When this hook returns `'approve'`, the handler resolves the
   * request immediately WITHOUT posting a card, creating a pending
   * entry, or arming a timer. Returning `null` (the default / no-hook
   * behaviour) falls through to the normal operator-approval card —
   * which is what ANY uncorrelated edit (e.g. an agent-forged config
   * change) gets, preserving the human-in-the-loop control.
   *
   * Forge-resistance lives in the caller's implementation: it must
   * require the rule the diff *adds* to match a rule the gateway just
   * queued, so a forged edit touching any other field finds no
   * correlation and gets a real card.
   */
  tryAutoResolve?: (msg: RequestConfigApprovalMessage) => "approve" | null;
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
): string {
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
  return out === unifiedDiff ? out : out + sentinel;
}

/**
 * Telegram rich-message hard limit (#2669). We render as GFM markdown and
 * ship the diff inside a fenced code block (content is literal there, so no
 * escape inflation).
 */
const TELEGRAM_SENDMESSAGE_LIMIT = 32768;
/** Safety margin under the hard limit for invisible framing wobble. */
const RENDERED_BODY_CAP = 32000;
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
    `🛠 **Config edit proposed**\n` +
    `Agent: \`${args.agentName}\`\n` +
    `Reason: ${escapeMarkdown(safeReason)}\n\n` +
    "```\n" + diff + "\n```";

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

  // Single-tap correlation (#1977): if THIS edit was initiated by the
  // gateway itself in response to an operator tap on the permission
  // card, auto-approve without posting a second card. Forge-resistance
  // is the caller's job — it correlates on the rule the diff adds. Any
  // uncorrelated (e.g. agent-forged) edit returns null here and falls
  // through to the real operator-approval card below.
  if (deps.tryAutoResolve?.(msg) === "approve") {
    deps.log?.(
      `config_approval_auto_resolved requestId=${msg.requestId} agent=${msg.agentName} (operator-tapped always-allow correlation)`,
    );
    reply("approve");
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

  // Pre-flight oversize handling (#1762 / #2669). The rich-message body
  // caps at 32768 chars; the diff ships inside a fenced code block (literal,
  // no escape inflation) but the framing still counts. Fast-path with a
  // cheap raw-input cap, then let
  // buildConfigApprovalCardBody enforce the post-escape rendered cap
  // (which re-truncates the diff if escaping blew past the limit). We
  // ship the full diff as a `.patch` attachment whenever truncation
  // happens in either layer.
  const prelim = truncateDiffForCard(msg.unifiedDiff);
  const built = buildConfigApprovalCardBody({
    agentName: msg.agentName,
    reason: msg.reason,
    unifiedDiff: prelim,
  });
  const body = built.body;
  // Oversize iff EITHER the cheap raw fast-path trimmed lines OR the
  // post-escape rendered cap had to re-truncate. Keyed off the
  // builder's structured `truncated` flag instead of substring-
  // matching the sentinel string (#1767 nit).
  const oversize = prelim !== msg.unifiedDiff || built.truncated;
  // Per-card nonce — baked into callback_data so a stale tap on a previously
  // posted card (e.g. one already finalized/expired) can never match a live
  // pending request even if hostd minted the same 32-bit requestId.
  const epoch = (deps.mintEpoch ?? defaultEpoch)();
  const replyMarkup = deps.buildKeyboard(msg.requestId, epoch);

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
    epoch,
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
 *
 * `expectedEpoch` guards an OPERATOR tap: the callback_data carries the
 * per-card nonce, which must match the live pending entry's `epoch`. A
 * mismatch means the tap came from a STALE card (already finalized/expired,
 * keyboard should have been stripped) — reject it as a no-op so it can never
 * resolve a different live request that happens to share the 32-bit
 * requestId. Internal callers (the per-request timeout timer, finalize) pass
 * `undefined` to skip the check — they already hold the authoritative entry.
 */
export async function resolvePendingConfigApproval(
  requestId: string,
  verdict: "approve" | "deny" | "timeout",
  deps: Pick<ConfigApprovalHandlerDeps, "editCard" | "log">,
  expectedEpoch?: string,
): Promise<boolean> {
  const entry = pending.get(requestId);
  if (!entry || entry.resolved) return false;
  if (expectedEpoch !== undefined && entry.epoch !== expectedEpoch) {
    deps.log?.(
      `config approval stale-tap rejected (requestId=${requestId}): ` +
        `epoch mismatch (tap=${expectedEpoch} live=${entry.epoch})`,
    );
    return false;
  }
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
      ? "👀 **Applying…**"
      : verdict === "deny"
        ? "🚫 **Denied**"
        : "⏱ **Expired**";
  try {
    // Strip the keyboard: once resolved (approve/deny/timeout) the buttons
    // must not stay tappable — a stale tap could otherwise re-hit the
    // callback path.
    await deps.editCard({
      chatId: entry.chatId,
      messageId: entry.messageId,
      text: interim,
      stripKeyboard: true,
    });
  } catch (err) {
    deps.log?.(
      `config approval card edit failed (requestId=${requestId}): ${(err as Error).message}`,
    );
  }
  return true;
}

/**
 * The "make it live" note appended to an Applied card. claude loads config at
 * boot, so an applied edit is inert in the running agents until they restart —
 * this names exactly what must bounce (and the command) instead of letting the
 * change silently not take effect. Fleet-wide (shared config) → guide to a full
 * rollout, never a per-agent list. Empty when nothing runtime-affected.
 */
export function buildLiveNote(affectedAgents?: string[], fleetWide?: boolean): string {
  if (fleetWide) {
    return (
      `\n\n⚠️ Shared config changed — affects all agents. Not live until they ` +
      `restart: run \`switchroom rollout\` (or \`/update apply\`).`
    );
  }
  const agents = (affectedAgents ?? []).filter((a) => typeof a === "string" && a.length > 0);
  if (agents.length === 0) return "";
  const list = agents.map(escapeMarkdown).join(", ");
  const cmds = agents.map((a) => `/restart ${escapeMarkdown(a)}`).join(" · ");
  return `\n\n🔄 Not live until restart — affects: **${list}**\n${cmds}`;
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

  // On apply, tell the operator what must restart for the edit to go LIVE —
  // claude loads config at boot, so an applied edit is inert until restart.
  // Specific agents → name them + the one-liner to bounce them; shared config
  // → guide to a full rollout (never silently leave the change un-live).
  const liveNote =
    msg.outcome === "applied" ? buildLiveNote(msg.affectedAgents, msg.fleetWide) : "";
  const body =
    msg.outcome === "applied"
      ? `✅ **Applied**${msg.detail ? `\n${escapeMarkdown(msg.detail)}` : ""}${liveNote}`
      : msg.outcome === "aborted_config_changed"
        ? // Nothing was written: the config drifted during the approval window
          // and the apply aborted rather than land a different effect than the
          // operator approved (#3121 follow-up).
          `🚫 **Not applied — config changed since proposal**${msg.detail ? `\n${escapeMarkdown(msg.detail)}` : ""}`
        : `⚠️ **Reconcile failed; rolled back**${msg.detail ? `\n${escapeMarkdown(msg.detail)}` : ""}`;
  try {
    // Finalize is terminal — strip the keyboard so the buttons are gone.
    await deps.editCard({
      chatId: entry.chatId,
      messageId: entry.messageId,
      text: body,
      stripKeyboard: true,
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
 * Parse `cfg:<requestId>:<epoch>:<choice>` callback data. Returns null on
 * malformed input. The callback handler in gateway.ts uses this +
 * resolvePendingConfigApproval (passing the parsed `epoch`) to drive the
 * tap → resolve flow; the epoch is verified against the live pending entry
 * so a stale tap can never resolve a same-id live request.
 *
 * The 3-segment legacy form `cfg:<requestId>:<choice>` (no epoch) is still
 * parsed for back-compat with cards posted before this change — `epoch` is
 * undefined there, so the resolver skips the epoch check (degrades to the
 * keyboard-strip protection alone). New cards always carry an epoch.
 */
export function parseConfigApprovalCallback(
  data: string,
): { requestId: string; epoch?: string; choice: "approve" | "deny" } | null {
  if (!data.startsWith("cfg:")) return null;
  const rest = data.slice(4);
  const lastColon = rest.lastIndexOf(":");
  if (lastColon < 0) return null;
  const choice = rest.slice(lastColon + 1);
  if (choice !== "approve" && choice !== "deny") return null;
  const head = rest.slice(0, lastColon);
  // New form carries an epoch as the segment before the choice:
  // <requestId>:<epoch>. The epoch is hex (no colon), so split on the LAST
  // remaining colon to separate it from a requestId (which is also hex).
  const epochColon = head.lastIndexOf(":");
  let requestId: string;
  let epoch: string | undefined;
  if (epochColon >= 0) {
    requestId = head.slice(0, epochColon);
    epoch = head.slice(epochColon + 1);
    if (epoch.length === 0 || epoch.length > 32 || !/^[0-9a-fA-F]+$/.test(epoch)) {
      // Not a well-formed epoch — treat the whole head as the legacy
      // requestId (back-compat for ids that themselves contain a colon).
      requestId = head;
      epoch = undefined;
    }
  } else {
    requestId = head;
  }
  if (requestId.length === 0 || requestId.length > 64) return null;
  return { requestId, ...(epoch !== undefined ? { epoch } : {}), choice };
}
