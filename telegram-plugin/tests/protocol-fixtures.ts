/**
 * Canonical wire-format fixtures for IPC messages.
 *
 * Every variant of `ClientToGateway` and `GatewayToClient` appears here
 * with its exact on-the-wire bytes. Both sides of the protocol read
 * from this file so a drift between gateway and bridge (e.g. the gateway
 * writes `tool_id` while the bridge reads `toolId`) fails at test time
 * rather than in production.
 *
 * Fixtures are the smallest valid form of each message. Tests that need
 * richer variants clone + override.
 */

import type {
  ClientToGateway,
  GatewayToClient,
  HeartbeatMessage,
  InboundMessage,
  PermissionEvent,
  PermissionRequestForward,
  RegisterMessage,
  SessionEventForward,
  StatusEvent,
  ToolCallMessage,
  ToolCallResult,
} from '../gateway/ipc-protocol.js'

export interface Fixture<T> {
  readonly decoded: T
  /** Exact JSON bytes that appear on the Unix socket (sans trailing `\n`). */
  readonly wire: string
}

/** Build a fixture and self-verify: `wire === JSON.stringify(decoded)`. */
function fx<T>(decoded: T): Fixture<T> {
  const wire = JSON.stringify(decoded)
  return { decoded, wire }
}

// ─── Client → Gateway ────────────────────────────────────────────────────

export const register: Fixture<RegisterMessage> = fx({
  type: 'register',
  agentName: 'coder',
})

export const registerWithTopic: Fixture<RegisterMessage> = fx({
  type: 'register',
  agentName: 'coder',
  topicId: 42,
})

export const toolCall: Fixture<ToolCallMessage> = fx({
  type: 'tool_call',
  id: 'uuid-1',
  tool: 'reply',
  args: { chat_id: '123', text: 'hi' },
})

export const sessionEvent: Fixture<SessionEventForward> = fx({
  type: 'session_event',
  chatId: '123',
  event: { kind: 'turn_end', durationMs: 500 },
})

export const sessionEventWithThread: Fixture<SessionEventForward> = fx({
  type: 'session_event',
  chatId: '-100123',
  threadId: 42,
  event: { kind: 'thinking' },
})

export const permissionRequest: Fixture<PermissionRequestForward> = fx({
  type: 'permission_request',
  requestId: 'req-1',
  toolName: 'Bash',
  description: 'run ls',
  inputPreview: 'ls -la',
})

export const heartbeat: Fixture<HeartbeatMessage> = fx({
  type: 'heartbeat',
  agentName: 'coder',
})

export const clientFixtures = {
  register,
  registerWithTopic,
  toolCall,
  sessionEvent,
  sessionEventWithThread,
  permissionRequest,
  heartbeat,
} as const

// ─── Gateway → Client ────────────────────────────────────────────────────

export const inbound: Fixture<InboundMessage> = fx({
  type: 'inbound',
  chatId: '123',
  messageId: 999,
  user: 'alice',
  userId: 42,
  ts: 1700000000,
  text: 'hello',
  meta: {},
})

export const inboundWithAttachment: Fixture<InboundMessage> = fx({
  type: 'inbound',
  chatId: '123',
  threadId: 42,
  messageId: 999,
  user: 'alice',
  userId: 42,
  ts: 1700000000,
  text: '(photo)',
  imagePath: '/tmp/photo.jpg',
  attachment: { fileId: 'abc', mimeType: 'image/jpeg', fileName: 'photo.jpg' },
  meta: { steering: 'false' },
})

export const permissionAllow: Fixture<PermissionEvent> = fx({
  type: 'permission',
  requestId: 'req-1',
  behavior: 'allow',
})

export const permissionDeny: Fixture<PermissionEvent> = fx({
  type: 'permission',
  requestId: 'req-1',
  behavior: 'deny',
})

export const statusConnected: Fixture<StatusEvent> = fx({
  type: 'status',
  status: 'agent_connected',
})

export const statusDown: Fixture<StatusEvent> = fx({
  type: 'status',
  status: 'agent_down',
})

export const statusShuttingDown: Fixture<StatusEvent> = fx({
  type: 'status',
  status: 'gateway_shutting_down',
})

export const toolCallSuccess: Fixture<ToolCallResult> = fx({
  type: 'tool_call_result',
  id: 'uuid-1',
  success: true,
  result: { ok: true },
})

export const toolCallFailure: Fixture<ToolCallResult> = fx({
  type: 'tool_call_result',
  id: 'uuid-1',
  success: false,
  error: 'tool not allowed',
})

export const gatewayFixtures = {
  inbound,
  inboundWithAttachment,
  permissionAllow,
  permissionDeny,
  statusConnected,
  statusDown,
  statusShuttingDown,
  toolCallSuccess,
  toolCallFailure,
} as const

// ─── Combined accessors for conformance tests ────────────────────────────

export const allClientFixtures: ReadonlyArray<Fixture<ClientToGateway>> = [
  register,
  registerWithTopic,
  toolCall,
  sessionEvent,
  sessionEventWithThread,
  permissionRequest,
  heartbeat,
]

export const allGatewayFixtures: ReadonlyArray<Fixture<GatewayToClient>> = [
  inbound,
  inboundWithAttachment,
  permissionAllow,
  permissionDeny,
  statusConnected,
  statusDown,
  statusShuttingDown,
  toolCallSuccess,
  toolCallFailure,
]
