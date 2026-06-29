// === Gateway -> Bridge (Client) messages ===

export interface InboundMessage {
  type: "inbound";
  chatId: string;
  threadId?: number;
  messageId: number;
  user: string;
  userId: number;
  ts: number;
  text: string;
  imagePath?: string;
  attachment?: { fileId: string; mimeType: string; fileName?: string };
  meta: Record<string, string>;
}

export interface PermissionEvent {
  type: "permission";
  requestId: string;
  behavior: "allow" | "deny";
  /**
   * Session-scoped always-allow rule. Only set when the operator taps
   * "🔁 Always allow" — the gateway already persists the rule to
   * switchroom.yaml + settings.json via `switchroom agent grant`, but
   * those writes only kick in on the NEXT agent boot. This field carries
   * the rule to the running bridge so it can short-circuit future
   * `permission_request` notifications (from the parent claude AND any
   * sub-agents dispatched via the Task tool, which share the same MCP
   * server / bridge process) within the current session.
   *
   * Issue #1138: without this, a sub-agent dispatched after the operator
   * tapped "Always allow" still hit the popup, because Claude Code reads
   * `.claude/settings.json` once at boot.
   *
   * Format matches `resolveScopedAllowChoices`' output: bare tool name
   * (`Edit`), scoped (`Edit(<path>)` / `Bash(<tok>:*)` / `Skill(<name>)`),
   * exact MCP tool (`mcp__<server>__<tool>`), or server wildcard
   * (`mcp__<server>__*`).
   */
  rule?: string;
  /**
   * Optional human-readable reason for the verdict, surfaced to the model
   * verbatim by claude's permission channel as "…the user said: ${message}".
   * Only set on `deny`. switchroom uses it to make a TIMEOUT auto-deny (no
   * operator response within the TTL) distinguishable from a deliberate
   * operator denial — otherwise both render as the generic "Denied" and the
   * model retries the identical call, re-raising an identical card 10 min
   * later (marko Rentals-budget loop, 2026-06-17). When absent, claude falls
   * back to its default "Denied", so this degrades safely on any claude that
   * ignores the field.
   */
  message?: string;
}

export interface StatusEvent {
  type: "status";
  status: "agent_down" | "agent_connected" | "gateway_shutting_down";
}

export interface ToolCallResult {
  type: "tool_call_result";
  id: string;
  success: boolean;
  result?: unknown;
  error?: string;
}

export interface ScheduleRestartResult {
  type: "schedule_restart_result";
  success: boolean;
  restartedImmediately?: boolean;
  waitingForTurn?: boolean;
  error?: string;
}

/**
 * RFC E §4.2 Cut 2 — sent by the gateway to acknowledge that a
 * Drive-write approval card has been posted (or that posting
 * failed). The Drive-write PreToolUse hook (a separate process)
 * uses the `request_id` to poll the kernel's `approval_lookup` for
 * the verdict; if posting fails, the hook fails closed.
 *
 * Why response-shaped: the hook is synchronous from Claude Code's
 * perspective (PreToolUse blocks the tool call). The hook can't
 * return its `decision: "approve" | "block"` until either the
 * card has been posted (so the user can decide) OR posting failed
 * (so the hook can return block immediately). A response message
 * is the cleanest way to surface that.
 */
export interface DriveApprovalPostedEvent {
  type: "drive_approval_posted";
  /** Same correlation_id the client sent on the request. */
  correlationId: string;
  ok: boolean;
  /**
   * Kernel request_id the hook will pass to `approval_lookup` once
   * it starts polling. Only present when `ok: true`.
   */
  requestId?: string;
  /**
   * Unix-ms expiry of the kernel request, mirrors the ttl_ms the
   * gateway used. Hook uses this as its polling deadline. Only
   * present when `ok: true`.
   */
  expiresAtMs?: number;
  /** Diagnostic detail on failure. */
  reason?: string;
}

/**
 * hostd config-edit approval — sent by the gateway back to hostd
 * after the operator taps Approve/Deny on a `request_config_approval`
 * card (or the 10-minute timeout elapses).
 *
 * The gateway is the source of truth for the verdict; hostd treats
 * this as a one-shot reply per `requestId`. Subsequent taps on the
 * same card are ignored at the callback dispatcher (#1623, RFC §3.4).
 */
export interface ConfigApprovalResolvedEvent {
  type: "config_approval_resolved";
  /** Echoes the requestId from the originating request_config_approval. */
  requestId: string;
  verdict: "approve" | "deny" | "timeout";
  /** Diagnostic detail when present. */
  reason?: string;
  /**
   * Distinguishes an actual operator tap-deny (`"operator"`) from a
   * gateway-side dispatch failure that auto-denied because the card
   * never reached the operator (`"dispatch_failure"`). Only set on
   * `verdict: "deny"` events. Caller (hostd) maps `dispatch_failure`
   * to a distinct error code so the failure isn't misattributed to
   * the operator. Issue #1762.
   */
  denySource?: "operator" | "dispatch_failure";
}

export type GatewayToClient =
  | InboundMessage
  | PermissionEvent
  | StatusEvent
  | ToolCallResult
  | ScheduleRestartResult
  | DriveApprovalPostedEvent
  | Ms365ApprovalPostedEvent
  | ConfigApprovalResolvedEvent;

// === Bridge (Client) -> Gateway messages ===

export interface RegisterMessage {
  type: "register";
  agentName: string;
  topicId?: number;
}

export interface ToolCallMessage {
  type: "tool_call";
  id: string;
  tool: string;
  args: Record<string, unknown>;
}

export interface SessionEventForward {
  type: "session_event";
  event: Record<string, unknown>;
  chatId: string;
  threadId?: number;
  /**
   * The session-tail's currently-attached JSONL path (its tracked
   * `currentFile`, not an independent re-scan). Forwarded so the
   * gateway's proactive-compaction check reads occupancy from the
   * exact file the tailer is on — avoids the sub-agent-mtime /
   * stale-rotation wrong-file hazard. Absent until the tailer has
   * attached a file.
   */
  activeFile?: string;
}

export interface PermissionRequestForward {
  type: "permission_request";
  requestId: string;
  toolName: string;
  description: string;
  inputPreview: string;
}

export interface HeartbeatMessage {
  type: "heartbeat";
  agentName: string;
}

export interface ScheduleRestartMessage {
  type: "schedule_restart";
  agentName: string;
}

/**
 * Forwarded from bridge → gateway when session-tail detects a Claude API
 * error in the JSONL transcript (Phase 4b).
 */
export interface OperatorEventForward {
  type: "operator_event";
  /** OperatorEventKind — kept as string to avoid cross-package type dep. */
  kind: string;
  agent: string;
  detail: string;
  chatId: string;
}

/**
 * Forwarded from bridge → gateway when PTY-tail extracts updated reply
 * text from Claude Code's TUI rendering. The gateway routes the text
 * through `handlePtyPartial` → draft-stream so the user sees the model's
 * reply assemble character-by-character (Claude.ai-style streaming).
 *
 * Sent by bridge.ts's `startPtyTail({onPartial})` callback. The bridge
 * doesn't know the chat id — the gateway resolves it from
 * `currentSessionChatId`, which is set when the bridge forwards the
 * matching `enqueue` session event.
 *
 * No throttle on the wire: PTY-tail's onPartial already coalesces at
 * ~150 ms. Same pattern as session_event forwarding.
 */
export interface PtyPartialForward {
  type: "pty_partial";
  /** Extracted reply text snapshot. Up to ~4096 chars (Telegram limit). */
  text: string;
}

/**
 * Legacy `update_placeholder` IPC from `vendor/hindsight-memory`'s
 * `recall.py` hook. The placeholder UX (`🔵 thinking`, `📚 recalling
 * memories`, `💭 thinking`) was removed in PR #553 PR 5 — the gateway no
 * longer registers a real handler for these. We still accept the wire
 * shape so the validator does NOT reject + log "invalid IPC message
 * shape" on every recall.py invocation, and so the message dispatches to
 * a no-op stub instead of falling through to the default-case warning.
 *
 * Important: we cannot edit `vendor/hindsight-memory/scripts/recall.py`
 * (vendored), so this soft-accept is the correct compatibility shim.
 */
export interface UpdatePlaceholderMessage {
  type: "update_placeholder";
  chatId: string;
  text: string;
}

/**
 * Phase 2 cron-fold-in: a privileged client (the in-agent scheduler
 * sibling, supervised by start.sh under SWITCHROOM_INLINE_SCHEDULER=1)
 * sends this to the gateway to inject a synthesized turn into the
 * agent's bridge. The gateway forwards the embedded `inbound` envelope
 * verbatim via `ipcServer.sendToAgent(agentName, inbound)`.
 *
 * Why a separate envelope rather than a direct inbound on the wire:
 *   1. ClientToGateway and GatewayToClient are distinct directions.
 *      A client cannot send a `type: "inbound"` message — that's a
 *      gateway→client envelope. The bridge's validateGatewayMessage
 *      is its security boundary, and the gateway's validateClientMessage
 *      is the parallel boundary on this side. Wrapping in
 *      `inject_inbound` keeps both validators sharp on their own
 *      direction.
 *   2. The gateway is *deciding* to forward — a future scope check
 *      (e.g., reject inbounds whose `meta.source` is not in a known
 *      set, rate-limit per sender) lives naturally at the gateway.
 *
 * Trust model: the gateway socket lives at a per-agent path inside
 * the agent container; only processes inside that container can
 * connect. `inject_inbound` is therefore as trusted as any other
 * process running under that agent's UID.
 */
export interface InjectInboundMessage {
  type: "inject_inbound";
  /** Target agent name — the gateway routes via sendToAgent. */
  agentName: string;
  /** Forwarded verbatim to the bridge as a `type: "inbound"` envelope. */
  inbound: InboundMessage;
}

/**
 * RFC E §4.2 Cut 2 — sent by the Drive-write PreToolUse hook to
 * the gateway to register a diff-preview approval card with the
 * kernel + post it to Telegram. The hook waits on the
 * corresponding `drive_approval_posted` reply (matching
 * `correlationId`), then polls `approval_lookup` for the verdict.
 *
 * The `preview` payload is shaped like
 * `src/drive/diff-preview.ts:DiffPreviewInput`. We don't restate
 * the full shape on the wire — the IPC validator does a structural
 * check (required fields present, types right) and the gateway-side
 * consumer feeds it straight to `buildDiffPreview()` which is
 * already defensive against malformed inputs.
 *
 * Trust model: same as `inject_inbound` — the gateway socket lives
 * inside the agent container, only that-UID processes can connect,
 * so the hook is as trusted as anything else in the container.
 */
export interface RequestDriveApprovalMessage {
  type: "request_drive_approval";
  /**
   * Hook-generated correlation id (any unique string ≤ 64 chars).
   * Echoed back in `drive_approval_posted` so the hook can match
   * the response if multiple Drive-write taps are in flight.
   */
  correlationId: string;
  /**
   * Target agent the gateway serves. Defense in depth — the gateway
   * verifies this matches its own SWITCHROOM_AGENT_NAME and refuses
   * cross-agent requests.
   */
  agentName: string;
  /**
   * DiffPreviewInput payload — see `src/drive/diff-preview.ts`.
   * Carried as an opaque object on the wire; the gateway
   * deserialises it via `buildDiffPreview()`.
   */
  preview: Record<string, unknown>;
  /**
   * TTL for the kernel approval request, in ms. Hook typically
   * passes 5 min; gateway clamps to a sensible range.
   */
  ttlMs?: number;
}

/**
 * RFC #1873 §8 — Microsoft 365 write approval (PR 4).
 *
 * Sent by the `ms-365-write-pretool` PreToolUse hook when softeria
 * tries a gated write tool (OneDrive upload, calendar/mail mutations).
 * Same shape as `request_drive_approval` but carries the weak-metadata
 * v1 preview shape (file path / id / size delta / deep link / agent
 * rationale) rather than Google's full DiffPreviewInput. Structural-
 * diff preview is RFC §8 v1.5.
 */
export interface RequestMs365ApprovalMessage {
  type: "request_ms365_approval";
  correlationId: string;
  agentName: string;
  /**
   * Weak-metadata payload — see Ms365WritePreview in
   * `telegram-plugin/gateway/ms365-write-approval.ts`. Opaque on the
   * wire; gateway validates via the handler.
   */
  preview: Record<string, unknown>;
  ttlMs?: number;
}

/**
 * Gateway → hook response after card is posted (or fails).
 */
export interface Ms365ApprovalPostedEvent {
  type: "ms365_approval_posted";
  correlationId: string;
  ok: boolean;
  requestId?: string;
  expiresAtMs?: number;
  reason?: string;
}

/**
 * hostd config-edit approval — sent by hostd to the caller agent's
 * gateway to render an approval card with the full unified diff in
 * the operator's primary chat. The gateway:
 *
 *   1. Posts a Telegram card with [✅ Approve] [🚫 Deny] buttons
 *      using callback_data `cfg:<requestId>:approve` / `:deny`.
 *   2. Tracks the pending request in-memory (no SQLite).
 *   3. On button tap (or 10-minute timeout) sends a single
 *      `config_approval_resolved` event back over the same
 *      connection.
 *   4. After hostd reports the apply outcome via
 *      `request_config_finalize`, edits the card body to the final
 *      state ("✅ applied" / "⚠️ reconcile failed; rolled back" /
 *      "🚫 denied" / "⏱ expired").
 *
 * Trust model: same as request_drive_approval — the gateway socket
 * lives inside the agent container, only that-UID processes can
 * connect. hostd reaches it via the per-agent state-dir bind mount
 * (`<state-dir>/gateway.sock`).
 */
export interface RequestConfigApprovalMessage {
  type: "request_config_approval";
  /** Hostd-generated stable id (8-hex). Echoed in resolved/finalize. */
  requestId: string;
  /** Name of the admin agent that called config_propose_edit. */
  agentName: string;
  /** Operator-visible justification (≤500 chars). */
  reason: string;
  /** Full unified diff to render in a code block on the card. */
  unifiedDiff: string;
  /** Card timeout in milliseconds (gateway-enforced). */
  timeoutMs: number;
}

/**
 * Sent by hostd after the apply attempt completes (success OR
 * rollback) so the gateway can edit the approval card body to a
 * terminal state. Idempotent: if the card was already edited (e.g.
 * by the timeout path), the second edit is a best-effort no-op.
 */
export interface RequestConfigFinalizeMessage {
  type: "request_config_finalize";
  requestId: string;
  outcome: "applied" | "reconcile_failed_rolled_back";
  /** Optional short diagnostic appended to the card body. */
  detail?: string;
  /**
   * On `applied`: agents that must restart for the edit to go live (claude
   * loads config at boot). Empty when `fleetWide`. The finalize card offers a
   * one-tap restart of these. Computed host-side by classifyBlastRadius.
   */
  affectedAgents?: string[];
  /** On `applied`: a shared/inherited key changed → all agents affected. */
  fleetWide?: boolean;
}

/**
 * The autoaccept-poll wedge-watchdog detected claude's `/rate-limit-options`
 * weekly-quota menu (a TUI wall that never produced a 429 the gateway could
 * see). Asks the gateway to trigger the EXISTING account-failover chain
 * (markExhausted → roll to a fallback subscription account, or the
 * all-exhausted operator alert). Fire-and-forget; no reply.
 *
 * Trust model (same as inject_inbound): the socket is per-agent inside the
 * container, but `agentName` is still validated server-side and never trusted
 * to authorize anything beyond triggering the agent's own failover.
 */
export interface QuotaWallDetectedMessage {
  type: "quota_wall_detected";
  agentName: string;
  /** Parsed weekly-reset epoch-ms. Omitted when the sidecar couldn't parse it;
   *  the gateway then uses a weekly-scale default for markExhausted's `until`
   *  (NOT the ~5h default, which would un-exhaust a weekly wall and re-wedge). */
  resetAt?: number;
}

/**
 * #2307 (Tier-0 action tier) — a MODEL-FREE outbound post. Sent by the
 * in-agent scheduler when a `kind: action` cron's `telegram-message` fires:
 * the gateway posts `text` to the agent's OWN chat with no model involvement
 * (NO `inject_inbound`, NO session wake, NO `currentTurn` mutation). This is
 * the deliberate counterpart to `inject_inbound` — the one ClientToGateway
 * verb that produces an outbound WITHOUT a turn.
 *
 * Trust model: same as `inject_inbound` — the socket is per-agent inside the
 * container, only that-UID processes can connect. `agentName` is validated
 * server-side, and the gateway FENCES `chatId` to the agent's own configured
 * chat (DM allowlist / forum_chat_id) and rejects a foreign chat — an action
 * can never post elsewhere (the action spec carries no chat target; the
 * scheduler supplies the agent's own).
 */
export interface SendOutboundMessage {
  type: "send_outbound";
  /** Target agent — gateway verifies it matches its own SWITCHROOM_AGENT_NAME. */
  agentName: string;
  /** Agent's own chat id (fenced server-side against the agent's config). */
  chatId: string;
  /** Forum topic thread id (General/unset omitted; 1 is stripped on send). */
  threadId?: number;
  /** Message body — already substitution-resolved by the action engine. */
  text: string;
  /** Telegram parse mode. Defaults to HTML. */
  parseMode?: "html" | "text";
}

/**
 * #2670 (one-tap self-improvement) — post a skill-improvement proposal as
 * a one-tap Approve/Dismiss card. Sent by the weekly skill-synthesis flow
 * (`switchroom self-improve propose-skill`) after it drafts a candidate
 * personal skill. The gateway PERSISTS the proposal (full draft bundle) to
 * the self-improve proposal store and posts the card to the agent's own
 * chat. The Approve tap is handled gateway-side: it injects a
 * `skill_proposal_apply` turn so the agent writes the stored draft through
 * the personal-skill pipeline (secret-scan runs; no self-escalation).
 *
 * Trust model identical to send_outbound / inject_inbound: per-agent
 * socket, agentName validated, chat fenced to the agent's own chat.
 */
export interface PostSkillProposalMessage {
  type: "post_skill_proposal";
  agentName: string;
  /** Agent's own chat id (fenced server-side). */
  chatId: string;
  threadId?: number;
  /** Target personal-skill slug (without the `personal-` prefix). */
  skillSlug: string;
  /** True = new skill; false = edit an existing personal skill. */
  isNew: boolean;
  /** One-line lesson the skill captures. */
  lesson: string;
  /** Short evidence line (e.g. "seen across 3 sessions"). */
  evidence: string;
  /** Full drafted skill bundle (SKILL.md + optional files). */
  draft: Record<string, string>;
}

export type ClientToGateway =
  | RegisterMessage
  | ToolCallMessage
  | SessionEventForward
  | PermissionRequestForward
  | HeartbeatMessage
  | ScheduleRestartMessage
  | OperatorEventForward
  | PtyPartialForward
  | UpdatePlaceholderMessage
  | InjectInboundMessage
  | RequestDriveApprovalMessage
  | RequestMs365ApprovalMessage
  | RequestConfigApprovalMessage
  | RequestConfigFinalizeMessage
  | QuotaWallDetectedMessage
  | SendOutboundMessage
  | PostSkillProposalMessage;
