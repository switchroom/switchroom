/**
 * Drive-write approval handler — RFC E §4.2 Cut 2.
 *
 * Called by the gateway's IPC dispatcher when the Drive-write
 * PreToolUse hook sends a `request_drive_approval` message. The
 * handler:
 *
 *   1. Validates the inbound preview payload via `buildDiffPreview`
 *      (which fails closed on malformed inputs).
 *   2. Registers a kernel approval request at scope
 *      `doc:gdrive:write:<fileId>`, action `write`, approver_set =
 *      operator allowFrom.
 *   3. Builds the Telegram card via `buildDiffPreviewCard` (#1299).
 *   4. Posts the card to the operator chat via grammy.
 *   5. Sends a `drive_approval_posted` event back over IPC with the
 *      kernel request_id + expires_at so the hook can poll
 *      `approval_lookup` for the verdict.
 *
 * On any failure the handler sends `drive_approval_posted { ok:
 * false, reason: ... }` so the hook fails closed (blocks the tool).
 *
 * Kept in its own module so the unit tests for the orchestration
 * (kernel call + card build + post + response) live separately
 * from the gateway monolith.
 */

import { buildDiffPreview, type DiffPreviewInput } from "../../src/drive/diff-preview.js";
import type { IpcClient } from "./ipc-server.js";
import type {
  DriveApprovalPostedEvent,
  RequestDriveApprovalMessage,
} from "./ipc-protocol.js";
import { truncateRawToFit } from "./oversize-card-body.js";

// ────────────────────────────────────────────────────────────────────────
// Injected deps — caller (gateway.ts) wires these from the existing
// surface area. Kept abstract so the handler unit-tests don't need
// grammy / the kernel / the gateway in scope.
// ────────────────────────────────────────────────────────────────────────

export interface DriveApprovalHandlerDeps {
  /** This gateway's agent name — cross-agent requests rejected. */
  agentName: string;
  /**
   * Operator allowFrom list (Telegram user ids as strings) — used
   * as the kernel's approver_set, and to pick the target chat for
   * the card post.
   */
  loadAllowFrom: () => string[];
  /**
   * The chat (and optional topic) the picker card should land in.
   * For the standard DM-based operator setup this is the operator's
   * private chat with the bot; for group-based setups the operator
   * group chat + the agent's topic id.
   */
  loadTargetChat: () => {
    chatId: number | string;
    threadId?: number;
  } | null;
  /**
   * Register a kernel approval request. Returns the kernel's
   * request_id + expires_at_ms on success, null on failure (rate
   * limit, broker unreachable, etc.).
   */
  registerApproval: (args: {
    agent_unit: string;
    scope: string;
    action: string;
    approver_set: string[];
    why: string;
    ttl_ms: number;
  }) => Promise<{ request_id: string; expires_at_ms: number } | null>;
  /**
   * Post the diff-preview card to Telegram. Returns a posted
   * message id on success, null on failure.
   */
  postCard: (args: {
    chatId: number | string;
    threadId?: number;
    text: string;
    /** grammy's InlineKeyboard, passed straight through. */
    replyMarkup: unknown;
  }) => Promise<{ messageId: number } | null>;
  /**
   * Build the Telegram-shaped card from a DiffPreview. Pass-through
   * to `buildDiffPreviewCard` (#1299); deferred via deps so the
   * handler tests don't need grammy.
   */
  buildCard: (args: {
    preview: ReturnType<typeof buildDiffPreview>;
    suggestRequestId: string;
  }) => { text: string; reply_markup: unknown };
  log?: (msg: string) => void;
  /** TTL clamping policy. */
  defaultTtlMs?: number;
  maxTtlMs?: number;
  minTtlMs?: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MIN_TTL_MS = 30 * 1000; // 30 seconds

/**
 * Telegram `sendMessage` hard limit. `buildDiffPreviewCard` HTML-
 * escapes the docTitle + every body line with no upstream length
 * cap, so an adversarial or just-unusually-long docTitle / anchor
 * displayName / agent-supplied summary can render past 4096 once
 * `&` / `<` / `>` inflate up to 5x. We rebuild a truncated body
 * keyed off the wrapper-attested fields when that happens. (#1767)
 */
const TELEGRAM_SENDMESSAGE_LIMIT = 4096;
const RENDERED_BODY_CAP = 3900;
const OVERSIZE_SENTINEL = "\n[… preview truncated; open in Drive for full context]";

/**
 * Top-level handler called by ipc-server's onRequestDriveApproval.
 * Always sends a single `drive_approval_posted` reply (success or
 * failure) before returning.
 */
export async function handleRequestDriveApproval(
  client: Pick<IpcClient, "send">,
  msg: RequestDriveApprovalMessage,
  deps: DriveApprovalHandlerDeps,
): Promise<void> {
  const reply = (event: Omit<DriveApprovalPostedEvent, "type">) => {
    try {
      client.send({ type: "drive_approval_posted", ...event });
    } catch (err) {
      deps.log?.(
        `drive_approval_posted send failed (correlation=${msg.correlationId}): ${(err as Error).message}`,
      );
    }
  };

  // 1. Cross-agent guard.
  if (msg.agentName !== deps.agentName) {
    reply({
      correlationId: msg.correlationId,
      ok: false,
      reason: `gateway serves '${deps.agentName}', not '${msg.agentName}'`,
    });
    return;
  }

  // 2. Validate preview shape — buildDiffPreview throws on
  // malformed inputs (fileId missing, metrics invalid, etc).
  let preview: ReturnType<typeof buildDiffPreview>;
  try {
    preview = buildDiffPreview(msg.preview as unknown as DiffPreviewInput);
  } catch (err) {
    reply({
      correlationId: msg.correlationId,
      ok: false,
      reason: `invalid preview payload: ${(err as Error).message}`,
    });
    return;
  }

  // 3. Pull operator targeting + allowFrom.
  const allowFrom = deps.loadAllowFrom();
  if (allowFrom.length === 0) {
    reply({
      correlationId: msg.correlationId,
      ok: false,
      reason: "no operator allowFrom configured — cannot route approval",
    });
    return;
  }
  const target = deps.loadTargetChat();
  if (target === null) {
    reply({
      correlationId: msg.correlationId,
      ok: false,
      reason: "no target chat available — operator not paired?",
    });
    return;
  }

  // 4. TTL clamp.
  const ttlMs = clampTtl(
    msg.ttlMs,
    deps.defaultTtlMs ?? DEFAULT_TTL_MS,
    deps.minTtlMs ?? MIN_TTL_MS,
    deps.maxTtlMs ?? MAX_TTL_MS,
  );

  // 5. Kernel approval request.
  const fileId = preview.audit.wrapperAttested.fileId;
  const scope = `doc:gdrive:write:${fileId}`;
  const registered = await deps.registerApproval({
    agent_unit: deps.agentName,
    scope,
    action: "write",
    approver_set: allowFrom,
    why: `Drive write — ${preview.audit.wrapperAttested.docTitle}`,
    ttl_ms: ttlMs,
  });
  if (registered === null) {
    reply({
      correlationId: msg.correlationId,
      ok: false,
      reason: "kernel approval_request failed (rate limit or broker unreachable)",
    });
    return;
  }

  // 6. Build + post the card.
  let card: { text: string; reply_markup: unknown };
  try {
    card = deps.buildCard({ preview, suggestRequestId: registered.request_id });
  } catch (err) {
    reply({
      correlationId: msg.correlationId,
      ok: false,
      reason: `card build failed: ${(err as Error).message}`,
    });
    return;
  }
  // Oversize guard (#1767). buildDiffPreviewCard renders title +
  // every body line HTML-escaped with no length cap. Worst-case `&`
  // / `<` / `>` inflate 5x — a long docTitle or anchor displayName
  // pushes past Telegram's 4096-char sendMessage limit and the API
  // returns a generic 400 that surfaces as a silent E_DENIED. Cap
  // the rendered body BEFORE posting.
  let cardText = card.text;
  let truncatedForFit = false;
  if (cardText.length > RENDERED_BODY_CAP) {
    const fit = truncateRawToFit({
      raw: card.text,
      // The "raw" here is the already-escaped card text — we don't
      // have access to pre-escape source at this layer because
      // buildDiffPreviewCard owns escaping. Line-snap is the safe
      // granularity: HTML entities like `&amp;` never span `\n`, so
      // truncating at a newline boundary can't bisect an entity.
      // The defensive single-long-line fallback may char-cut into an
      // entity, but the drive-preview lines are short (anchor name,
      // metrics, capped 200-char summary) so this is unreachable
      // unless a multi-KB docTitle slipped through Drive itself.
      render: (slice) => slice,
      cap: RENDERED_BODY_CAP,
      sentinel: OVERSIZE_SENTINEL,
      hardLimit: TELEGRAM_SENDMESSAGE_LIMIT,
    });
    cardText = fit.body;
    truncatedForFit = fit.truncated;
  }

  const posted = await deps.postCard({
    chatId: target.chatId,
    ...(target.threadId !== undefined ? { threadId: target.threadId } : {}),
    text: cardText,
    replyMarkup: card.reply_markup,
  });
  if (posted === null) {
    reply({
      correlationId: msg.correlationId,
      ok: false,
      reason: truncatedForFit
        ? "Telegram sendMessage failed even after oversize-body truncation"
        : "Telegram sendMessage failed",
    });
    return;
  }
  if (truncatedForFit) {
    deps.log?.(
      `drive_approval_posted oversize-truncated correlation=${msg.correlationId} original_len=${card.text.length} rendered_len=${cardText.length}`,
    );
  }

  deps.log?.(
    `drive_approval_posted ok correlation=${msg.correlationId} request_id=${registered.request_id} file=${fileId}`,
  );
  reply({
    correlationId: msg.correlationId,
    ok: true,
    requestId: registered.request_id,
    expiresAtMs: registered.expires_at_ms,
  });
}

function clampTtl(
  requested: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const t = requested === undefined || !Number.isFinite(requested) ? fallback : requested;
  if (t < min) return min;
  if (t > max) return max;
  return t;
}
