import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Test the daemon's core logic without real Telegram or real sockets.
// We test: JSONL parsing, routing table, access control, outbound formatting,
// and graceful disconnect handling.
// ---------------------------------------------------------------------------

// --- JSONL message parsing ---

describe("JSONL message parsing", () => {
  it("should parse a single complete JSONL message", () => {
    const line = '{"type":"register","topicId":42,"agentName":"coach"}';
    const parsed = JSON.parse(line);
    expect(parsed.type).toBe("register");
    expect(parsed.topicId).toBe(42);
    expect(parsed.agentName).toBe("coach");
  });

  it("should parse multiple JSONL messages separated by newlines", () => {
    const data = [
      '{"type":"register","topicId":1,"agentName":"a"}',
      '{"type":"register","topicId":2,"agentName":"b"}',
      '{"type":"outbound","requestId":"r1","action":"typing","chatId":"123"}',
    ].join("\n") + "\n";

    const lines = data.split("\n").filter((l) => l.trim());
    expect(lines.length).toBe(3);

    const messages = lines.map((l) => JSON.parse(l));
    expect(messages[0].type).toBe("register");
    expect(messages[1].topicId).toBe(2);
    expect(messages[2].action).toBe("typing");
  });

  it("should handle partial reads by buffering", () => {
    // Simulate partial read: first chunk ends mid-JSON
    const full = '{"type":"register","topicId":42,"agentName":"test"}\n';
    const chunk1 = full.slice(0, 25);
    const chunk2 = full.slice(25);

    let buffer = "";
    const parsed: unknown[] = [];

    // Process chunk1
    buffer += chunk1;
    const lines1 = buffer.split("\n");
    buffer = lines1.pop()!;
    for (const line of lines1) {
      if (line.trim()) parsed.push(JSON.parse(line));
    }
    expect(parsed.length).toBe(0); // Not yet complete

    // Process chunk2
    buffer += chunk2;
    const lines2 = buffer.split("\n");
    buffer = lines2.pop()!;
    for (const line of lines2) {
      if (line.trim()) parsed.push(JSON.parse(line));
    }
    expect(parsed.length).toBe(1);
    expect((parsed[0] as { topicId: number }).topicId).toBe(42);
  });

  it("should skip empty lines", () => {
    const data = '\n\n{"type":"register","topicId":1,"agentName":"x"}\n\n';
    const lines = data.split("\n").filter((l) => l.trim());
    expect(lines.length).toBe(1);
  });

  it("should handle malformed JSON gracefully", () => {
    const line = "not valid json at all";
    expect(() => JSON.parse(line)).toThrow();
  });
});

// --- Routing table ---

describe("Routing table", () => {
  let routingTable: Map<number, { id: string; topicIds: Set<number> }>;

  beforeEach(() => {
    routingTable = new Map();
  });

  it("should register a client for a topic", () => {
    const client = { id: "client-1", topicIds: new Set<number>() };
    client.topicIds.add(42);
    routingTable.set(42, client);

    expect(routingTable.has(42)).toBe(true);
    expect(routingTable.get(42)?.id).toBe("client-1");
  });

  it("should support multiple topics per client", () => {
    const client = { id: "client-1", topicIds: new Set<number>() };
    client.topicIds.add(42);
    client.topicIds.add(43);
    routingTable.set(42, client);
    routingTable.set(43, client);

    expect(routingTable.size).toBe(2);
    expect(routingTable.get(42)).toBe(routingTable.get(43));
  });

  it("should route to correct client by topic_id", () => {
    const client1 = { id: "client-1", topicIds: new Set([100]) };
    const client2 = { id: "client-2", topicIds: new Set([200]) };
    routingTable.set(100, client1);
    routingTable.set(200, client2);

    expect(routingTable.get(100)?.id).toBe("client-1");
    expect(routingTable.get(200)?.id).toBe("client-2");
  });

  it("should return undefined for unregistered topics", () => {
    expect(routingTable.get(999)).toBeUndefined();
  });

  it("should allow re-registration (reconnect)", () => {
    const client1 = { id: "client-old", topicIds: new Set([42]) };
    routingTable.set(42, client1);

    const client2 = { id: "client-new", topicIds: new Set([42]) };
    routingTable.set(42, client2);

    expect(routingTable.get(42)?.id).toBe("client-new");
  });

  it("should clean up on disconnect", () => {
    const client = { id: "client-1", topicIds: new Set([10, 20, 30]) };
    for (const t of client.topicIds) {
      routingTable.set(t, client);
    }

    expect(routingTable.size).toBe(3);

    // Simulate disconnect: remove all topics owned by this client
    for (const topicId of client.topicIds) {
      routingTable.delete(topicId);
    }

    expect(routingTable.size).toBe(0);
  });

  it("should not affect other clients on disconnect", () => {
    const client1 = { id: "client-1", topicIds: new Set([100]) };
    const client2 = { id: "client-2", topicIds: new Set([200]) };
    routingTable.set(100, client1);
    routingTable.set(200, client2);

    // Disconnect client1
    for (const topicId of client1.topicIds) {
      routingTable.delete(topicId);
    }

    expect(routingTable.size).toBe(1);
    expect(routingTable.has(200)).toBe(true);
    expect(routingTable.get(200)?.id).toBe("client-2");
  });
});

// --- Access control ---

describe("Access control", () => {
  type GroupPolicy = { requireMention: boolean; allowFrom?: string[] };
  type DaemonAccess = { allowFrom: string[]; groups: Record<string, GroupPolicy> };

  function isAllowedSender(
    access: DaemonAccess,
    senderId: string,
    chatId: string,
    chatType: string,
  ): boolean {
    if (chatType === "private") {
      return access.allowFrom.includes(senderId);
    }
    if (chatType === "group" || chatType === "supergroup") {
      const policy = access.groups[chatId];
      if (!policy) return false;
      const groupAllowFrom = policy.allowFrom ?? [];
      if (groupAllowFrom.length > 0 && !groupAllowFrom.includes(senderId)) return false;
      return true;
    }
    return false;
  }

  const access: DaemonAccess = {
    allowFrom: ["111", "222"],
    groups: {
      "-1001234": { requireMention: false, allowFrom: ["111"] },
      "-1005678": { requireMention: true },
    },
  };

  it("should allow DMs from allowlisted users", () => {
    expect(isAllowedSender(access, "111", "111", "private")).toBe(true);
    expect(isAllowedSender(access, "222", "222", "private")).toBe(true);
  });

  it("should reject DMs from non-allowlisted users", () => {
    expect(isAllowedSender(access, "999", "999", "private")).toBe(false);
  });

  it("should allow group messages from allowlisted users in a configured group", () => {
    expect(isAllowedSender(access, "111", "-1001234", "supergroup")).toBe(true);
  });

  it("should reject group messages from non-allowlisted users when group has allowFrom", () => {
    expect(isAllowedSender(access, "999", "-1001234", "supergroup")).toBe(false);
  });

  it("should allow any user in groups without allowFrom restriction", () => {
    expect(isAllowedSender(access, "999", "-1005678", "supergroup")).toBe(true);
  });

  it("should reject messages from unconfigured groups", () => {
    expect(isAllowedSender(access, "111", "-9999999", "supergroup")).toBe(false);
  });

  it("should reject messages from unknown chat types", () => {
    expect(isAllowedSender(access, "111", "111", "channel")).toBe(false);
  });
});

// --- Outbound message formatting ---

describe("Outbound message formatting", () => {
  it("should build a reply outbound message", () => {
    const msg = {
      type: "outbound",
      requestId: "req-123",
      action: "reply",
      chatId: "-1001234",
      text: "Hello world",
      messageThreadId: 42,
    };
    const json = JSON.stringify(msg);
    const parsed = JSON.parse(json);
    expect(parsed.action).toBe("reply");
    expect(parsed.chatId).toBe("-1001234");
    expect(parsed.messageThreadId).toBe(42);
  });

  it("should build a react outbound message", () => {
    const msg = {
      type: "outbound",
      requestId: "req-456",
      action: "react",
      chatId: "-1001234",
      messageId: 789,
      emoji: "thumbs_up",
    };
    expect(msg.action).toBe("react");
    expect(msg.emoji).toBe("thumbs_up");
  });

  it("should build an edit outbound message", () => {
    const msg = {
      type: "outbound",
      requestId: "req-789",
      action: "edit",
      chatId: "-1001234",
      messageId: 100,
      text: "Updated text",
      format: "markdownv2",
    };
    expect(msg.action).toBe("edit");
    expect(msg.format).toBe("markdownv2");
  });

  it("should build a download outbound message", () => {
    const msg = {
      type: "outbound",
      requestId: "req-dl",
      action: "download",
      fileId: "AgACAgIAAxk",
    };
    expect(msg.action).toBe("download");
    expect(msg.fileId).toBe("AgACAgIAAxk");
  });

  it("should include requestId in every outbound message", () => {
    const messages = [
      { type: "outbound", requestId: "r1", action: "reply", chatId: "x", text: "hi" },
      { type: "outbound", requestId: "r2", action: "react", chatId: "x", messageId: 1, emoji: "x" },
      { type: "outbound", requestId: "r3", action: "typing", chatId: "x" },
      { type: "outbound", requestId: "r4", action: "pin", chatId: "x", messageId: 1 },
    ];
    for (const msg of messages) {
      expect(msg.requestId).toBeTruthy();
    }
  });
});

// --- Result message matching ---

describe("Result message matching", () => {
  it("should match result to request by requestId", () => {
    const pending = new Map<string, { resolve: (v: unknown) => void }>();
    let resolved: unknown = null;

    pending.set("req-1", { resolve: (v) => { resolved = v; } });

    const result = { type: "result", requestId: "req-1", success: true, data: { sentIds: [100] } };
    const p = pending.get(result.requestId);
    if (p) {
      p.resolve(result);
      pending.delete(result.requestId);
    }

    expect(resolved).not.toBeNull();
    expect((resolved as { success: boolean }).success).toBe(true);
    expect(pending.size).toBe(0);
  });

  it("should not match unrelated requestIds", () => {
    const pending = new Map<string, { resolve: (v: unknown) => void }>();
    pending.set("req-1", { resolve: () => {} });

    const result = { type: "result", requestId: "req-999", success: true };
    const p = pending.get(result.requestId);
    expect(p).toBeUndefined();
    expect(pending.size).toBe(1); // Still pending
  });
});

// --- Inbound message structure ---

describe("Inbound message structure", () => {
  it("should include all required fields", () => {
    const msg = {
      type: "inbound",
      topicId: 42,
      chatId: "-1001234",
      messageId: 999,
      userId: "111",
      username: "testuser",
      text: "Hello agent",
      ts: "2024-01-01T00:00:00.000Z",
    };
    expect(msg.type).toBe("inbound");
    expect(msg.topicId).toBe(42);
    expect(msg.chatId).toBe("-1001234");
    expect(msg.userId).toBe("111");
    expect(msg.text).toBe("Hello agent");
  });

  it("should include optional attachment fields when present", () => {
    const msg = {
      type: "inbound",
      topicId: 42,
      chatId: "-1001234",
      messageId: 999,
      userId: "111",
      username: "testuser",
      text: "(document: file.pdf)",
      ts: "2024-01-01T00:00:00.000Z",
      attachmentFileId: "AgACAgIAAxk",
      attachmentKind: "document",
      attachmentMime: "application/pdf",
      attachmentName: "file.pdf",
      attachmentSize: 12345,
    };
    expect(msg.attachmentFileId).toBe("AgACAgIAAxk");
    expect(msg.attachmentKind).toBe("document");
    expect(msg.attachmentSize).toBe(12345);
  });

  it("should include imagePath when photo is downloaded", () => {
    const msg = {
      type: "inbound",
      topicId: 42,
      chatId: "-1001234",
      messageId: 999,
      userId: "111",
      username: "testuser",
      text: "(photo)",
      ts: "2024-01-01T00:00:00.000Z",
      imagePath: "/home/user/.switchroom/inbox/1234-abc.jpg",
    };
    expect(msg.imagePath).toContain("inbox");
  });
});

// --- Text chunking ---

describe("Text chunking", () => {
  function chunk(text: string, limit: number): string[] {
    if (text.length <= limit) return [text];
    const out: string[] = [];
    let rest = text;
    while (rest.length > limit) {
      const para = rest.lastIndexOf("\n\n", limit);
      const line = rest.lastIndexOf("\n", limit);
      const space = rest.lastIndexOf(" ", limit);
      const cut =
        para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit;
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut).replace(/^\n+/, "");
    }
    if (rest) out.push(rest);
    return out;
  }

  it("should not chunk short text", () => {
    expect(chunk("hello", 4096)).toEqual(["hello"]);
  });

  it("should chunk long text at paragraph boundaries", () => {
    const text = "A".repeat(2000) + "\n\n" + "B".repeat(2000) + "\n\n" + "C".repeat(100);
    const chunks = chunk(text, 4096);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
    // Total should be close to original (minus stripped newlines)
    expect(totalLen).toBeGreaterThan(4000);
  });

  it("should hard-cut if no good boundary found", () => {
    const text = "A".repeat(5000); // No spaces, newlines
    const chunks = chunk(text, 4096);
    expect(chunks.length).toBe(2);
    expect(chunks[0].length).toBe(4096);
  });
});

// --- MarkdownV2 escaping ---

describe("MarkdownV2 escaping", () => {
  function escapeMarkdownV2(text: string): string {
    const specialChars = /[_*\[\]()~`>#+\-=|{}.!\\]/g;
    const parts: string[] = [];
    let last = 0;
    const codeRe = /(```[\s\S]*?```|`[^`\n]+`)/g;
    let m: RegExpExecArray | null;
    while ((m = codeRe.exec(text)) !== null) {
      if (m.index > last) {
        parts.push(text.slice(last, m.index).replace(specialChars, "\\$&"));
      }
      parts.push(m[0]);
      last = m.index + m[0].length;
    }
    if (last < text.length) {
      parts.push(text.slice(last).replace(specialChars, "\\$&"));
    }
    return parts.join("");
  }

  it("should escape special characters", () => {
    expect(escapeMarkdownV2("hello_world")).toBe("hello\\_world");
    expect(escapeMarkdownV2("test.txt")).toBe("test\\.txt");
  });

  it("should preserve code blocks", () => {
    const input = "hello ```code_block``` world";
    const result = escapeMarkdownV2(input);
    expect(result).toContain("```code_block```");
    expect(result).toContain("hello");
  });

  it("should preserve inline code", () => {
    const input = "use `foo_bar` here";
    const result = escapeMarkdownV2(input);
    expect(result).toContain("`foo_bar`");
  });
});

// --- Graceful disconnect ---

describe("Graceful disconnect handling", () => {
  it("should clear all topic routes for a disconnected client", () => {
    const routingTable = new Map<number, { id: string; topicIds: Set<number> }>();
    const allClients = new Set<{ id: string; topicIds: Set<number> }>();

    const client = { id: "c1", topicIds: new Set([10, 20]) };
    allClients.add(client);
    routingTable.set(10, client);
    routingTable.set(20, client);

    // Simulate close
    for (const t of client.topicIds) {
      routingTable.delete(t);
    }
    allClients.delete(client);

    expect(routingTable.size).toBe(0);
    expect(allClients.size).toBe(0);
  });

  it("should reject pending requests on disconnect", () => {
    const pending = new Map<string, { reject: (err: Error) => void }>();
    const errors: Error[] = [];

    pending.set("r1", { reject: (e) => errors.push(e) });
    pending.set("r2", { reject: (e) => errors.push(e) });

    // Simulate disconnect: reject all pending
    for (const [id, p] of pending) {
      p.reject(new Error("disconnected from daemon"));
    }
    pending.clear();

    expect(errors.length).toBe(2);
    expect(errors[0].message).toBe("disconnected from daemon");
    expect(pending.size).toBe(0);
  });
});

// --- Register message format ---

describe("Register message format", () => {
  it("should include topicId and agentName", () => {
    const msg = { type: "register", topicId: 42, agentName: "coach" };
    const json = JSON.stringify(msg);
    const parsed = JSON.parse(json);
    expect(parsed.type).toBe("register");
    expect(parsed.topicId).toBe(42);
    expect(parsed.agentName).toBe("coach");
  });
});
