import { describe, it, expect } from "vitest";
import type {
  GatewayToClient,
  ClientToGateway,
  InboundMessage,
  PermissionEvent,
  PermissionRequestForward,
  StatusEvent,
  ToolCallResult,
  RegisterMessage,
  ToolCallMessage,
  SessionEventForward,
  HeartbeatMessage,
} from "../gateway/ipc-protocol.js";

describe("IPC Protocol — round-trip serialization", () => {
  function roundTrip<T>(msg: T): T {
    return JSON.parse(JSON.stringify(msg));
  }

  describe("Gateway -> Client messages", () => {
    it("InboundMessage round-trips", () => {
      const msg: InboundMessage = {
        type: "inbound",
        chatId: "-1001234567890",
        threadId: 42,
        messageId: 999,
        user: "alice",
        userId: 12345,
        ts: 1700000000,
        text: "hello world",
        imagePath: "/tmp/photo.jpg",
        attachment: { fileId: "abc123", mimeType: "image/jpeg", fileName: "photo.jpg" },
        meta: { steering: "false" },
      };
      expect(roundTrip(msg)).toEqual(msg);
    });

    it("InboundMessage round-trips with minimal fields", () => {
      const msg: InboundMessage = {
        type: "inbound",
        chatId: "-100999",
        messageId: 1,
        user: "bob",
        userId: 1,
        ts: 0,
        text: "",
        meta: {},
      };
      const parsed = roundTrip(msg);
      expect(parsed.type).toBe("inbound");
      expect(parsed.threadId).toBeUndefined();
      expect(parsed.imagePath).toBeUndefined();
      expect(parsed.attachment).toBeUndefined();
    });

    it("PermissionEvent round-trips (allow)", () => {
      const msg: PermissionEvent = { type: "permission", requestId: "req-1", behavior: "allow" };
      expect(roundTrip(msg)).toEqual(msg);
    });

    it("PermissionEvent round-trips (deny)", () => {
      const msg: PermissionEvent = { type: "permission", requestId: "req-2", behavior: "deny" };
      expect(roundTrip(msg)).toEqual(msg);
    });

    it("StatusEvent round-trips all statuses", () => {
      for (const status of ["agent_down", "agent_connected", "gateway_shutting_down"] as const) {
        const msg: StatusEvent = { type: "status", status };
        expect(roundTrip(msg)).toEqual(msg);
      }
    });

    it("ToolCallResult round-trips (success)", () => {
      const msg: ToolCallResult = {
        type: "tool_call_result",
        id: "call-1",
        success: true,
        result: { text: "done", count: 42 },
      };
      expect(roundTrip(msg)).toEqual(msg);
    });

    it("ToolCallResult round-trips (error)", () => {
      const msg: ToolCallResult = {
        type: "tool_call_result",
        id: "call-2",
        success: false,
        error: "not found",
      };
      expect(roundTrip(msg)).toEqual(msg);
    });
  });

  describe("Client -> Gateway messages", () => {
    it("RegisterMessage round-trips", () => {
      const msg: RegisterMessage = { type: "register", agentName: "assistant", topicId: 42 };
      expect(roundTrip(msg)).toEqual(msg);
    });

    it("RegisterMessage round-trips without topicId", () => {
      const msg: RegisterMessage = { type: "register", agentName: "worker" };
      const parsed = roundTrip(msg);
      expect(parsed.type).toBe("register");
      expect(parsed.agentName).toBe("worker");
      expect(parsed.topicId).toBeUndefined();
    });

    it("ToolCallMessage round-trips", () => {
      const msg: ToolCallMessage = {
        type: "tool_call",
        id: "tc-1",
        tool: "reply",
        args: { chat_id: "123", text: "hello" },
      };
      expect(roundTrip(msg)).toEqual(msg);
    });

    it("SessionEventForward round-trips", () => {
      const msg: SessionEventForward = {
        type: "session_event",
        event: { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } },
        chatId: "123",
        threadId: 7,
      };
      expect(roundTrip(msg)).toEqual(msg);
    });

    it("PermissionRequestForward round-trips", () => {
      const msg: PermissionRequestForward = {
        type: "permission_request",
        requestId: "abc12",
        toolName: "Bash",
        description: "Execute a bash command",
        inputPreview: '{"command":"rm -rf /tmp/old"}',
      };
      expect(roundTrip(msg)).toEqual(msg);
    });

    it("HeartbeatMessage round-trips", () => {
      const msg: HeartbeatMessage = { type: "heartbeat", agentName: "assistant" };
      expect(roundTrip(msg)).toEqual(msg);
    });
  });

  describe("type discrimination", () => {
    it("GatewayToClient discriminates by type field", () => {
      const messages: GatewayToClient[] = [
        { type: "inbound", chatId: "1", messageId: 1, user: "u", userId: 1, ts: 0, text: "", meta: {} },
        { type: "permission", requestId: "r1", behavior: "allow" },
        { type: "status", status: "agent_down" },
        { type: "tool_call_result", id: "t1", success: true },
      ];

      const types = messages.map((m) => m.type);
      expect(types).toEqual(["inbound", "permission", "status", "tool_call_result"]);

      for (const msg of messages) {
        switch (msg.type) {
          case "inbound":
            expect(msg.chatId).toBeDefined();
            break;
          case "permission":
            expect(msg.requestId).toBeDefined();
            break;
          case "status":
            expect(msg.status).toBeDefined();
            break;
          case "tool_call_result":
            expect(msg.id).toBeDefined();
            break;
          default: {
            const _exhaustive: never = msg;
            throw new Error(`unhandled type: ${(_exhaustive as any).type}`);
          }
        }
      }
    });

    it("ClientToGateway discriminates by type field", () => {
      const messages: ClientToGateway[] = [
        { type: "register", agentName: "a" },
        { type: "tool_call", id: "t1", tool: "reply", args: {} },
        { type: "session_event", event: {}, chatId: "1" },
        { type: "permission_request", requestId: "r1", toolName: "Bash", description: "run cmd", inputPreview: "{}" },
        { type: "heartbeat", agentName: "a" },
      ];

      const types = messages.map((m) => m.type);
      expect(types).toEqual(["register", "tool_call", "session_event", "permission_request", "heartbeat"]);

      for (const msg of messages) {
        switch (msg.type) {
          case "register":
            expect(msg.agentName).toBeDefined();
            break;
          case "tool_call":
            expect(msg.tool).toBeDefined();
            break;
          case "session_event":
            expect(msg.event).toBeDefined();
            break;
          case "permission_request":
            expect(msg.requestId).toBeDefined();
            expect(msg.toolName).toBeDefined();
            break;
          case "heartbeat":
            expect(msg.agentName).toBeDefined();
            break;
          default: {
            const _exhaustive: never = msg;
            throw new Error(`unhandled type: ${(_exhaustive as any).type}`);
          }
        }
      }
    });
  });
});
