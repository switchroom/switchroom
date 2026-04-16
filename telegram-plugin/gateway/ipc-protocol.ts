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

export type GatewayToClient =
  | InboundMessage
  | PermissionEvent
  | StatusEvent
  | ToolCallResult;

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

export type ClientToGateway =
  | RegisterMessage
  | ToolCallMessage
  | SessionEventForward
  | PermissionRequestForward
  | HeartbeatMessage;
