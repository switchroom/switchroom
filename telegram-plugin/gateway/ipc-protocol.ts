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

export type GatewayToClient =
  | InboundMessage
  | PermissionEvent
  | StatusEvent
  | ToolCallResult
  | ScheduleRestartResult;

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
 * Edit the pre-allocated DM draft to show a more specific status during
 * the wait between inbound and the agent's first tool call.
 *
 * Sent by hooks (e.g. recall.py at hook-start and after a recall returns)
 * so the user sees `🔵 thinking…` → `📚 recalling…` → `💭 thinking…` →
 * final reply, instead of `🔵 thinking…` for the entire model TTFT.
 *
 * Best-effort: silently no-op when the chat has no pre-allocated draft
 * (forum topic, sendMessageDraft API unavailable, race with pre-alloc
 * round-trip).
 */
export interface UpdatePlaceholderMessage {
  type: "update_placeholder";
  /** DM chat id (positive numeric string). Forum topics are skipped. */
  chatId: string;
  /** New placeholder text. Plain text — no HTML/Markdown parsing. */
  text: string;
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

export type ClientToGateway =
  | RegisterMessage
  | ToolCallMessage
  | SessionEventForward
  | PermissionRequestForward
  | HeartbeatMessage
  | ScheduleRestartMessage
  | OperatorEventForward
  | UpdatePlaceholderMessage
  | PtyPartialForward;
