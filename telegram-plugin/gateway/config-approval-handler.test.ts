/**
 * Gateway-side `request_config_approval` handler tests (#1623).
 *
 * Focuses on the load-bearing transitions, not exhaustive plumbing:
 *   - Happy path: card posted, callback resolved, finalize edits.
 *   - Cross-agent rejection.
 *   - Double-tap is a no-op (second `resolvePendingConfigApproval`
 *     returns false and does not send a second verdict).
 *   - Timeout fires `verdict: "timeout"` automatically.
 *   - parseConfigApprovalCallback parses + rejects malformed input.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  buildConfigApprovalCardBody,
  handleRequestConfigApproval,
  handleRequestConfigFinalize,
  parseConfigApprovalCallback,
  resolvePendingConfigApproval,
  _resetPendingConfigApprovalsForTest,
  _peekPendingConfigApprovalForTest,
} from "./config-approval-handler.js";
import type { RequestConfigApprovalMessage } from "./ipc-protocol.js";

const baseMsg: RequestConfigApprovalMessage = {
  type: "request_config_approval",
  requestId: "req-1",
  agentName: "klanker",
  reason: "tighten doctor schedule",
  unifiedDiff: "--- a/x\n+++ b/x\n@@\n-a\n+b\n",
  timeoutMs: 60_000,
};

function fakeDeps(overrides: Partial<Parameters<typeof handleRequestConfigApproval>[2]> = {}) {
  const sent: Array<{ type: string; [k: string]: unknown }> = [];
  const client = {
    send: (m: { type: string; [k: string]: unknown }) => {
      sent.push(m);
    },
  };
  const editCalls: Array<{
    chatId: number | string;
    messageId: number;
    text: string;
  }> = [];
  const deps = {
    agentName: "klanker",
    loadTargetChat: () => ({ chatId: 42 }),
    postCard: vi.fn(async () => ({ messageId: 1001 })),
    buildKeyboard: () => ({ inline_keyboard: [] }),
    editCard: async (a: { chatId: number | string; messageId: number; text: string }) => {
      editCalls.push(a);
    },
    log: () => {},
    ...overrides,
  };
  return { client, sent, deps, editCalls };
}

beforeEach(() => {
  _resetPendingConfigApprovalsForTest();
});
afterEach(() => {
  _resetPendingConfigApprovalsForTest();
});

describe("buildConfigApprovalCardBody", () => {
  it("HTML-escapes the diff body so `<` / `&` can't break out of the <pre> block", () => {
    const body = buildConfigApprovalCardBody({
      agentName: "klanker",
      reason: "<script>",
      unifiedDiff: "a & b <c>",
    });
    expect(body).toContain("&lt;script&gt;");
    expect(body).toContain("a &amp; b &lt;c&gt;");
  });
});

describe("handleRequestConfigApproval", () => {
  it("posts the card, registers a pending entry, and stays open until resolved", async () => {
    const { client, deps } = fakeDeps();
    await handleRequestConfigApproval(client, baseMsg, deps);
    expect(deps.postCard).toHaveBeenCalledTimes(1);
    const pending = _peekPendingConfigApprovalForTest("req-1");
    expect(pending).toBeDefined();
    expect(pending!.messageId).toBe(1001);
  });

  it("rejects a cross-agent request without posting a card", async () => {
    const { client, sent, deps } = fakeDeps();
    await handleRequestConfigApproval(
      client,
      { ...baseMsg, agentName: "evilpeer" },
      deps,
    );
    expect(deps.postCard).not.toHaveBeenCalled();
    expect(sent).toEqual([
      {
        type: "config_approval_resolved",
        requestId: "req-1",
        verdict: "deny",
        reason: expect.stringContaining("gateway serves 'klanker'"),
      },
    ]);
  });

  it("rejects when no target chat is paired", async () => {
    const { client, sent, deps } = fakeDeps({ loadTargetChat: () => null });
    await handleRequestConfigApproval(client, baseMsg, deps);
    expect(sent[0]!.verdict).toBe("deny");
    expect(sent[0]!.reason).toMatch(/not paired/);
  });

  it("rejects when postCard fails (Telegram down)", async () => {
    const { client, sent, deps } = fakeDeps({
      postCard: vi.fn(async () => null),
    });
    await handleRequestConfigApproval(client, baseMsg, deps);
    expect(sent[0]!.verdict).toBe("deny");
    expect(sent[0]!.reason).toMatch(/sendMessage failed/);
  });
});

describe("resolvePendingConfigApproval — double-tap and verdict propagation", () => {
  it("first tap resolves; second tap is a no-op", async () => {
    const { client, sent, deps, editCalls } = fakeDeps();
    await handleRequestConfigApproval(client, baseMsg, deps);
    const first = await resolvePendingConfigApproval("req-1", "approve", deps);
    expect(first).toBe(true);
    const second = await resolvePendingConfigApproval("req-1", "deny", deps);
    expect(second).toBe(false);
    // Only one verdict crossed the wire to hostd.
    const verdicts = sent.filter((s) => s.type === "config_approval_resolved");
    expect(verdicts.length).toBe(1);
    expect(verdicts[0]!.verdict).toBe("approve");
    // Card edited once to the interim 'Applying' state.
    expect(editCalls.length).toBe(1);
    expect(editCalls[0]!.text).toMatch(/Applying/);
  });

  it("returns false when no entry exists (unknown requestId)", async () => {
    const { deps } = fakeDeps();
    const r = await resolvePendingConfigApproval("unknown", "approve", deps);
    expect(r).toBe(false);
  });
});

describe("timeout path", () => {
  it("auto-fires verdict 'timeout' after timeoutMs and edits card to '⏱ Expired'", async () => {
    vi.useFakeTimers();
    try {
      const { client, sent, deps, editCalls } = fakeDeps();
      await handleRequestConfigApproval(
        client,
        { ...baseMsg, timeoutMs: 1000 },
        deps,
      );
      vi.advanceTimersByTime(1500);
      // Allow microtasks scheduled inside the timer to flush.
      await vi.runAllTimersAsync();
      const verdicts = sent.filter((s) => s.type === "config_approval_resolved");
      expect(verdicts.length).toBe(1);
      expect(verdicts[0]!.verdict).toBe("timeout");
      expect(editCalls[0]!.text).toMatch(/Expired/);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("handleRequestConfigFinalize", () => {
  it("edits the card to '✅ Applied' on success", async () => {
    const { client, deps, editCalls } = fakeDeps();
    await handleRequestConfigApproval(client, baseMsg, deps);
    await resolvePendingConfigApproval("req-1", "approve", deps);
    await handleRequestConfigFinalize(
      client,
      {
        type: "request_config_finalize",
        requestId: "req-1",
        outcome: "applied",
      },
      deps,
    );
    const last = editCalls[editCalls.length - 1]!;
    expect(last.text).toMatch(/Applied/);
  });

  it("edits to '⚠️ Reconcile failed; rolled back' with detail", async () => {
    const { client, deps, editCalls } = fakeDeps();
    await handleRequestConfigApproval(client, baseMsg, deps);
    await resolvePendingConfigApproval("req-1", "approve", deps);
    await handleRequestConfigFinalize(
      client,
      {
        type: "request_config_finalize",
        requestId: "req-1",
        outcome: "reconcile_failed_rolled_back",
        detail: "rolled back successfully",
      },
      deps,
    );
    const last = editCalls[editCalls.length - 1]!;
    expect(last.text).toMatch(/Reconcile failed/);
    expect(last.text).toMatch(/rolled back successfully/);
  });

  it("is a no-op when no pending entry exists for the requestId", async () => {
    const { client, deps, editCalls } = fakeDeps();
    await handleRequestConfigFinalize(
      client,
      {
        type: "request_config_finalize",
        requestId: "missing",
        outcome: "applied",
      },
      deps,
    );
    expect(editCalls.length).toBe(0);
  });
});

describe("parseConfigApprovalCallback", () => {
  it("parses well-formed callbacks", () => {
    expect(parseConfigApprovalCallback("cfg:abc:approve")).toEqual({
      requestId: "abc",
      choice: "approve",
    });
    expect(parseConfigApprovalCallback("cfg:deadbeef:deny")).toEqual({
      requestId: "deadbeef",
      choice: "deny",
    });
  });

  it("rejects malformed input", () => {
    expect(parseConfigApprovalCallback("apv:abc:once")).toBeNull();
    expect(parseConfigApprovalCallback("cfg:")).toBeNull();
    expect(parseConfigApprovalCallback("cfg:abc:bogus")).toBeNull();
    expect(parseConfigApprovalCallback("cfg::approve")).toBeNull();
  });
});
