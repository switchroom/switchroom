/**
 * Tests for ms365-write-approval handler — RFC #1873 §8 PR 4.
 * Mirrors `drive-write-approval.test.ts` shape; DI-style — no live
 * kernel / grammy / IPC needed.
 */

import { describe, expect, it, vi } from "vitest";

import {
  buildMs365CardText,
  handleRequestMs365Approval,
  validateMs365Preview,
  type Ms365ApprovalHandlerDeps,
  type Ms365WritePreview,
} from "./ms365-write-approval.js";
import type { IpcClient } from "./ipc-server.js";
import type { RequestMs365ApprovalMessage } from "./ipc-protocol.js";

// ────────────────────────────────────────────────────────────────────────
// validateMs365Preview
// ────────────────────────────────────────────────────────────────────────

describe("validateMs365Preview", () => {
  const validPreview = {
    agentName: "clerk",
    toolName: "mcp__ms-365__upload-file-content",
    itemId: "01ABCDEFG",
    itemDisplayName: "Q3-Strategy.docx",
    accountEmail: "ken@outlook.com",
  };

  it("accepts a minimal valid preview", () => {
    const r = validateMs365Preview(validPreview);
    expect(r).not.toBeNull();
    expect(r!.agentName).toBe("clerk");
    expect(r!.toolName).toBe("mcp__ms-365__upload-file-content");
  });

  it("accepts optional fields when typed correctly", () => {
    const r = validateMs365Preview({
      ...validPreview,
      deepLink: "https://onedrive.live.com/x",
      sizeBytesBefore: 1024,
      sizeBytesAfter: 2048,
      agentRationale: "Add Q3 meeting notes",
    });
    expect(r).not.toBeNull();
    expect(r!.deepLink).toBe("https://onedrive.live.com/x");
    expect(r!.sizeBytesBefore).toBe(1024);
    expect(r!.sizeBytesAfter).toBe(2048);
    expect(r!.agentRationale).toBe("Add Q3 meeting notes");
  });

  it("rejects null / non-object", () => {
    expect(validateMs365Preview(null)).toBeNull();
    expect(validateMs365Preview("string")).toBeNull();
    expect(validateMs365Preview(42)).toBeNull();
  });

  it("rejects missing required fields", () => {
    const cases = ["agentName", "toolName", "itemId", "itemDisplayName", "accountEmail"];
    for (const field of cases) {
      const copy: Record<string, unknown> = { ...validPreview };
      delete copy[field];
      expect(validateMs365Preview(copy)).toBeNull();
    }
  });

  it("rejects empty-string required fields", () => {
    const r = validateMs365Preview({ ...validPreview, agentName: "" });
    expect(r).toBeNull();
  });

  it("ignores wrong-type optional fields gracefully (drops them, doesn't fail)", () => {
    const r = validateMs365Preview({
      ...validPreview,
      deepLink: 42, // wrong type
      sizeBytesAfter: "not-a-number",
    });
    expect(r).not.toBeNull();
    expect(r!.deepLink).toBeUndefined();
    expect(r!.sizeBytesAfter).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────────
// buildMs365CardText
// ────────────────────────────────────────────────────────────────────────

describe("buildMs365CardText", () => {
  const base: Ms365WritePreview = {
    agentName: "clerk",
    toolName: "mcp__ms-365__upload-file-content",
    itemId: "01ABCDEFG",
    itemDisplayName: "Q3-Strategy.docx",
    accountEmail: "ken@outlook.com",
  };

  it("includes agent, tool, item, account", () => {
    const text = buildMs365CardText(base);
    expect(text).toContain("clerk");
    expect(text).toContain("ms-365__upload-file-content");
    expect(text).toContain("Q3-Strategy.docx");
    expect(text).toContain("01ABCDEFG");
    expect(text).toContain("ken@outlook.com");
  });

  it("omits ID line for new files", () => {
    const text = buildMs365CardText({ ...base, itemId: "(new)" });
    expect(text).not.toMatch(/^ID:/m);
  });

  it("shows size delta when before/after present", () => {
    const text = buildMs365CardText({ ...base, sizeBytesBefore: 1024, sizeBytesAfter: 2048 });
    expect(text).toMatch(/Size:.*1\.0KB.*2\.0KB.*\+1\.0KB/);
  });

  it("shows negative delta correctly", () => {
    const text = buildMs365CardText({ ...base, sizeBytesBefore: 2048, sizeBytesAfter: 1024 });
    expect(text).toMatch(/Size:.*-1\.0KB/);
  });

  it("includes deepLink when present", () => {
    const text = buildMs365CardText({ ...base, deepLink: "https://onedrive.live.com/x" });
    expect(text).toContain("https://onedrive.live.com/x");
  });

  it("includes agent rationale when present", () => {
    const text = buildMs365CardText({ ...base, agentRationale: "Adding meeting notes" });
    expect(text).toContain("💬 Adding meeting notes");
  });

  it("always shows weak-attestation warning", () => {
    const text = buildMs365CardText(base);
    expect(text).toContain("Weak attestation (RFC §8 v1)");
  });

  it("truncates over-long display names with ellipsis", () => {
    const text = buildMs365CardText({ ...base, itemDisplayName: "x".repeat(500) });
    expect(text).toContain("…");
  });
});

// ────────────────────────────────────────────────────────────────────────
// handleRequestMs365Approval — DI integration
// ────────────────────────────────────────────────────────────────────────

function makeDeps(): {
  deps: Ms365ApprovalHandlerDeps;
  registerSpy: ReturnType<typeof vi.fn>;
  postCardSpy: ReturnType<typeof vi.fn>;
  client: { send: ReturnType<typeof vi.fn> };
} {
  const registerSpy = vi.fn().mockResolvedValue({
    request_id: "aabbccdd11223344aabbccdd11223344",
    expires_at_ms: Date.now() + 5 * 60 * 1000,
  });
  const postCardSpy = vi.fn().mockResolvedValue({ messageId: 42 });
  const sendSpy = vi.fn();
  const deps: Ms365ApprovalHandlerDeps = {
    agentName: "clerk",
    loadAllowFrom: () => ["12345"],
    loadTargetChat: () => ({ chatId: "12345" }),
    registerApproval: registerSpy,
    postCard: postCardSpy,
    log: () => {},
  };
  return {
    deps,
    registerSpy,
    postCardSpy,
    client: { send: sendSpy },
  };
}

function makeMsg(overrides: Partial<RequestMs365ApprovalMessage> = {}): RequestMs365ApprovalMessage {
  return {
    type: "request_ms365_approval",
    correlationId: "corr-1",
    agentName: "clerk",
    preview: {
      agentName: "clerk",
      toolName: "mcp__ms-365__upload-file-content",
      itemId: "01ABC",
      itemDisplayName: "Strategy.docx",
      accountEmail: "ken@outlook.com",
    },
    ttlMs: 5 * 60 * 1000,
    ...overrides,
  };
}

describe("handleRequestMs365Approval", () => {
  it("happy path: registers kernel, posts card, sends ok=true response", async () => {
    const { deps, registerSpy, postCardSpy, client } = makeDeps();
    await handleRequestMs365Approval(client as unknown as IpcClient, makeMsg(), deps);
    expect(registerSpy).toHaveBeenCalledOnce();
    expect(postCardSpy).toHaveBeenCalledOnce();
    expect(client.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "ms365_approval_posted",
        correlationId: "corr-1",
        ok: true,
        requestId: "aabbccdd11223344aabbccdd11223344",
      }),
    );
  });

  it("uses correct kernel scope ms-365:write:<itemId>", async () => {
    const { deps, registerSpy, client } = makeDeps();
    await handleRequestMs365Approval(
      client as unknown as IpcClient,
      makeMsg({ preview: { ...makeMsg().preview, itemId: "01XYZ" } }),
      deps,
    );
    expect(registerSpy.mock.calls[0][0].scope).toBe("ms-365:write:01XYZ");
    expect(registerSpy.mock.calls[0][0].action).toBe("write");
  });

  it("rejects cross-agent requests", async () => {
    const { deps, registerSpy, client } = makeDeps();
    await handleRequestMs365Approval(
      client as unknown as IpcClient,
      makeMsg({ agentName: "other-agent" }),
      deps,
    );
    expect(registerSpy).not.toHaveBeenCalled();
    expect(client.send).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        reason: expect.stringContaining("cross-agent"),
      }),
    );
  });

  it("rejects invalid preview", async () => {
    const { deps, registerSpy, client } = makeDeps();
    await handleRequestMs365Approval(
      client as unknown as IpcClient,
      makeMsg({ preview: { agentName: "clerk" } }),
      deps,
    );
    expect(registerSpy).not.toHaveBeenCalled();
    expect(client.send).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, reason: "invalid preview payload" }),
    );
  });

  it("rejects when no allowFrom is configured", async () => {
    const { deps, client } = makeDeps();
    deps.loadAllowFrom = () => [];
    await handleRequestMs365Approval(client as unknown as IpcClient, makeMsg(), deps);
    expect(client.send).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, reason: expect.stringContaining("allowFrom") }),
    );
  });

  it("rejects when no target chat resolved", async () => {
    const { deps, client } = makeDeps();
    deps.loadTargetChat = () => null;
    await handleRequestMs365Approval(client as unknown as IpcClient, makeMsg(), deps);
    expect(client.send).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, reason: expect.stringContaining("target chat") }),
    );
  });

  it("fail-closes when kernel registration returns null", async () => {
    const { deps, client } = makeDeps();
    deps.registerApproval = async () => null;
    await handleRequestMs365Approval(client as unknown as IpcClient, makeMsg(), deps);
    expect(client.send).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, reason: expect.stringContaining("kernel") }),
    );
  });

  it("fail-closes when card post returns null", async () => {
    const { deps, client } = makeDeps();
    deps.postCard = async () => null;
    await handleRequestMs365Approval(client as unknown as IpcClient, makeMsg(), deps);
    expect(client.send).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, reason: expect.stringContaining("card post") }),
    );
  });

  it("clamps oversized TTL to maxTtlMs", async () => {
    const { deps, registerSpy, client } = makeDeps();
    await handleRequestMs365Approval(
      client as unknown as IpcClient,
      makeMsg({ ttlMs: 60 * 60 * 1000 }), // 1h, max is 30min
      deps,
    );
    expect(registerSpy.mock.calls[0][0].ttl_ms).toBe(30 * 60 * 1000);
  });

  it("uses default TTL when none provided", async () => {
    const { deps, registerSpy, client } = makeDeps();
    const msg = makeMsg();
    delete (msg as { ttlMs?: number }).ttlMs;
    await handleRequestMs365Approval(client as unknown as IpcClient, msg, deps);
    expect(registerSpy.mock.calls[0][0].ttl_ms).toBe(5 * 60 * 1000);
  });

  it("emits apv:<requestId>:once|deny callback data (kernel-generic, NOT a ms365: dead-end)", async () => {
    const { deps, postCardSpy, client } = makeDeps();
    await handleRequestMs365Approval(client as unknown as IpcClient, makeMsg(), deps);
    const kb = postCardSpy.mock.calls[0][0].replyMarkup as {
      inline_keyboard: Array<Array<{ callback_data: string }>>;
    };
    // MUST be `apv:` so the existing gateway dispatcher handles taps.
    // Provider-namespaced `ms365:` would silently drop button taps.
    expect(kb.inline_keyboard[0][0].callback_data).toMatch(/^apv:.+:once$/);
    expect(kb.inline_keyboard[0][1].callback_data).toMatch(/^apv:.+:deny$/);
  });
});
