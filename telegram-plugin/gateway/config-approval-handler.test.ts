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
  buildLiveNote,
  handleRequestConfigApproval,
  handleRequestConfigFinalize,
  parseConfigApprovalCallback,
  resolvePendingConfigApproval,
  truncateDiffForCard,
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
    stripKeyboard?: boolean;
  }> = [];
  const deps = {
    agentName: "klanker",
    loadTargetChat: () => ({ chatId: 42 }),
    postCard: vi.fn(async () => ({ messageId: 1001 })),
    // Deterministic epoch so callback_data is assertable in tests.
    mintEpoch: () => "cafe1234",
    buildKeyboard: (requestId: string, epoch: string) => ({
      inline_keyboard: [
        [
          { text: "✅ Approve", callback_data: `cfg:${requestId}:${epoch}:approve` },
          { text: "🚫 Deny", callback_data: `cfg:${requestId}:${epoch}:deny` },
        ],
      ],
    }),
    editCard: async (a: {
      chatId: number | string;
      messageId: number;
      text: string;
      stripKeyboard?: boolean;
    }) => {
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
    const { body } = buildConfigApprovalCardBody({
      agentName: "klanker",
      reason: "<script>",
      unifiedDiff: "a & b <c>",
    });
    expect(body).toContain("&lt;script&gt;");
    expect(body).toContain("a &amp; b &lt;c&gt;");
  });

  it("rendered body stays under Telegram's 4096-char limit when raw diff is all `&` (worst-case 5x escape inflation)", () => {
    // 3000 `&` chars escape to 15000 `&amp;` chars — far past 4096.
    // The post-escape cap MUST kick in and truncate the rendered body.
    const evilDiff = "&".repeat(3000);
    const { body } = buildConfigApprovalCardBody({
      agentName: "klanker",
      reason: "test",
      unifiedDiff: evilDiff,
    });
    expect(body.length).toBeLessThanOrEqual(4096);
    expect(body).toContain("diff continues, see attached file");
  });

  it("rendered body stays under 4096 when raw diff is all `<` (5x escape)", () => {
    const evilDiff = "<".repeat(3000);
    const { body } = buildConfigApprovalCardBody({
      agentName: "klanker",
      reason: "test",
      unifiedDiff: evilDiff,
    });
    expect(body.length).toBeLessThanOrEqual(4096);
    expect(body).toContain("&lt;");
  });

  it("clips an unbounded operator-supplied `reason` to ~500 chars with ellipsis", () => {
    const longReason = "x".repeat(2000);
    const { body } = buildConfigApprovalCardBody({
      agentName: "klanker",
      reason: longReason,
      unifiedDiff: "small",
    });
    // The escaped reason should appear, but capped.
    const reasonLine = body
      .split("\n")
      .find((l) => l.startsWith("Reason: "))!;
    // "Reason: " prefix (8) + clipped reason.
    expect(reasonLine.length).toBeLessThanOrEqual(8 + 500);
    expect(reasonLine.endsWith("…")).toBe(true);
  });

  it("returns truncated:false when the rendered body fits without trimming", () => {
    const { body, truncated } = buildConfigApprovalCardBody({
      agentName: "klanker",
      reason: "small",
      unifiedDiff: "-a\n+b\n",
    });
    expect(truncated).toBe(false);
    expect(body).toContain("<pre>-a\n+b\n</pre>");
  });

  it("returns truncated:true and appends the sentinel when the body has to shrink", () => {
    const { body, truncated } = buildConfigApprovalCardBody({
      agentName: "klanker",
      reason: "test",
      unifiedDiff: "&".repeat(3000),
    });
    expect(truncated).toBe(true);
    expect(body).toContain("diff continues, see attached file");
  });

  it("handles a single unbroken line (no `\\n` to snap to) by char-truncation fallback", () => {
    // 8000 `x` chars on a single line. After HTML escape (no inflation
    // for `x`) the diff body alone is 8000 chars + framing — way past
    // the cap. There's no newline to snap to, so the helper must fall
    // through to char-truncation rather than returning empty.
    const oneLongLine = "x".repeat(8000);
    const { body, truncated } = buildConfigApprovalCardBody({
      agentName: "klanker",
      reason: "test",
      unifiedDiff: oneLongLine,
    });
    expect(truncated).toBe(true);
    expect(body.length).toBeLessThanOrEqual(4096);
    // Should still contain SOME of the line content — the helper
    // shouldn't degenerate to "framing + sentinel only" when char-
    // truncation is available.
    expect(body).toMatch(/x{100,}/);
    expect(body).toContain("diff continues, see attached file");
  });

  it("rendered body stays under 4096 even when reason is also adversarial", () => {
    const evilDiff = "&".repeat(3000);
    const evilReason = "&".repeat(2000);
    const { body } = buildConfigApprovalCardBody({
      agentName: "klanker",
      reason: evilReason,
      unifiedDiff: evilDiff,
    });
    expect(body.length).toBeLessThanOrEqual(4096);
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
        denySource: "dispatch_failure",
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
    // Card edited once to the interim 'Applying' state, with the keyboard
    // stripped so the buttons stop being tappable.
    expect(editCalls.length).toBe(1);
    expect(editCalls[0]!.text).toMatch(/Applying/);
    expect(editCalls[0]!.stripKeyboard).toBe(true);
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
      // Allow microtasks scheduled inside the timer callback to flush.
      // NOT vi.runAllTimersAsync() — that is unimplemented under bun's
      // vitest-compat shim and this suite also runs under `bun test`
      // (CLAUDE.md § "Import the right runner"). advanceTimersByTime
      // already fired the timer synchronously; we only need to drain
      // the microtask queue the timer's async callback scheduled.
      for (let i = 0; i < 8; i++) await Promise.resolve();
      const verdicts = sent.filter((s) => s.type === "config_approval_resolved");
      expect(verdicts.length).toBe(1);
      expect(verdicts[0]!.verdict).toBe("timeout");
      expect(editCalls[0]!.text).toMatch(/Expired/);
      // Expired card must also strip the keyboard (no stale tappable buttons).
      expect(editCalls[0]!.stripKeyboard).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("buildLiveNote", () => {
  it("names specific affected agents + the per-agent restart command", () => {
    const note = buildLiveNote(["clerk", "gymbro"], false);
    expect(note).toContain("clerk, gymbro");
    expect(note).toContain("/restart clerk");
    expect(note).toContain("/restart gymbro");
    expect(note).toContain("Not live until restart");
  });
  it("guides to a full rollout when fleet-wide (no per-agent list)", () => {
    const note = buildLiveNote([], true);
    expect(note).toContain("all agents");
    expect(note).toContain("switchroom rollout");
    expect(note).not.toContain("/restart");
  });
  it("is empty when nothing is runtime-affected", () => {
    expect(buildLiveNote([], false)).toBe("");
    expect(buildLiveNote(undefined, undefined)).toBe("");
  });
  it("HTML-escapes agent names", () => {
    expect(buildLiveNote(["a<b>"], false)).toContain("a&lt;b&gt;");
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

describe("oversize diff → attachment fallback (#1762)", () => {
  function bigDiff(lines: number): string {
    // Each line ~80 chars → 200 lines ≈ 16 KB, comfortably > 4096.
    const row =
      "-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    return Array.from({ length: lines }, (_, i) => `${row}${i}`).join("\n");
  }

  it("truncateDiffForCard caps the diff and appends a sentinel", () => {
    const truncated = truncateDiffForCard(bigDiff(200), 50, 3000);
    expect(truncated.length).toBeLessThanOrEqual(3050);
    expect(truncated.endsWith("[… diff continues, see attached file]")).toBe(
      true,
    );
  });

  it("returns the original diff unchanged when below the line cap", () => {
    const small = "--- a\n+++ b\n@@\n-x\n+y\n";
    expect(truncateDiffForCard(small, 50)).toBe(small);
  });

  it("oversize body still posts a card with buttons AND fires postAttachment", async () => {
    const huge = bigDiff(200);
    const attachmentCalls: Array<{
      chatId: number | string;
      filename: string;
      content: string;
    }> = [];
    const { client, sent, deps } = fakeDeps({
      postAttachment: async (a: {
        chatId: number | string;
        filename: string;
        content: string;
      }) => {
        attachmentCalls.push({
          chatId: a.chatId,
          filename: a.filename,
          content: a.content,
        });
      },
    });
    await handleRequestConfigApproval(
      client,
      { ...baseMsg, unifiedDiff: huge },
      deps,
    );

    // Card was posted exactly once, with buttons, and within Telegram's limit.
    expect(deps.postCard).toHaveBeenCalledTimes(1);
    const postArgs = (deps.postCard as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as { text: string; replyMarkup: unknown };
    expect(postArgs.text.length).toBeLessThanOrEqual(4096);
    expect(postArgs.text).toMatch(/diff continues, see attached file/);
    expect(postArgs.replyMarkup).toBeDefined();

    // Attachment carries the FULL diff, named .patch, keyed by requestId.
    expect(attachmentCalls.length).toBe(1);
    expect(attachmentCalls[0]!.filename).toBe("config-edit-req-1.patch");
    expect(attachmentCalls[0]!.content).toBe(huge);

    // The pending entry is registered — handler hasn't auto-denied.
    expect(_peekPendingConfigApprovalForTest("req-1")).toBeDefined();
    // No verdict has crossed the wire yet (still pending operator tap).
    expect(sent.filter((s) => s.type === "config_approval_resolved")).toEqual(
      [],
    );
  });

  it("oversize but no postAttachment dep → card still posts, missing-attachment is logged", async () => {
    const huge = bigDiff(200);
    const logs: string[] = [];
    const { client, deps } = fakeDeps({ log: (m: string) => logs.push(m) });
    await handleRequestConfigApproval(
      client,
      { ...baseMsg, unifiedDiff: huge },
      deps,
    );
    expect(deps.postCard).toHaveBeenCalledTimes(1);
    expect(
      logs.some((l) => l.includes("no postAttachment dep wired")),
    ).toBe(true);
    expect(_peekPendingConfigApprovalForTest("req-1")).toBeDefined();
  });

  it("postCard failure → deny carries denySource='dispatch_failure'", async () => {
    const { client, sent, deps } = fakeDeps({
      postCard: vi.fn(async () => null),
    });
    await handleRequestConfigApproval(client, baseMsg, deps);
    expect(sent[0]!.verdict).toBe("deny");
    expect(sent[0]!.denySource).toBe("dispatch_failure");
  });
});

describe("parseConfigApprovalCallback", () => {
  it("parses the new epoch-bearing form cfg:<requestId>:<epoch>:<choice>", () => {
    expect(parseConfigApprovalCallback("cfg:abc:cafe1234:approve")).toEqual({
      requestId: "abc",
      epoch: "cafe1234",
      choice: "approve",
    });
    expect(parseConfigApprovalCallback("cfg:deadbeef:00ff:deny")).toEqual({
      requestId: "deadbeef",
      epoch: "00ff",
      choice: "deny",
    });
  });

  it("still parses the legacy 3-segment form (no epoch, back-compat)", () => {
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

describe("stale-tap rejection via per-card epoch", () => {
  it("bakes the minted epoch into the posted card's callback_data", async () => {
    const { client, deps } = fakeDeps();
    await handleRequestConfigApproval(client, baseMsg, deps);
    const postCard = deps.postCard as ReturnType<typeof vi.fn>;
    const kb = postCard.mock.calls[0]![0].replyMarkup as {
      inline_keyboard: Array<Array<{ callback_data: string }>>;
    };
    expect(kb.inline_keyboard[0]![0]!.callback_data).toBe(
      "cfg:req-1:cafe1234:approve",
    );
    expect(kb.inline_keyboard[0]![1]!.callback_data).toBe(
      "cfg:req-1:cafe1234:deny",
    );
  });

  it("resolves when the tap epoch matches the live card", async () => {
    const { client, deps } = fakeDeps();
    await handleRequestConfigApproval(client, baseMsg, deps);
    const ok = await resolvePendingConfigApproval(
      "req-1",
      "approve",
      deps,
      "cafe1234",
    );
    expect(ok).toBe(true);
  });

  it("rejects a stale tap whose epoch does NOT match the live card", async () => {
    const { client, sent, deps, editCalls } = fakeDeps();
    await handleRequestConfigApproval(client, baseMsg, deps);
    // A tap carrying a DIFFERENT (stale) epoch must be a no-op — no verdict
    // crosses the wire, no card edit happens, and the request stays live.
    const stale = await resolvePendingConfigApproval(
      "req-1",
      "approve",
      deps,
      "deadbeef",
    );
    expect(stale).toBe(false);
    expect(sent.filter((s) => s.type === "config_approval_resolved")).toEqual(
      [],
    );
    expect(editCalls).toEqual([]);
    // The correct (live) epoch still resolves it.
    const live = await resolvePendingConfigApproval(
      "req-1",
      "approve",
      deps,
      "cafe1234",
    );
    expect(live).toBe(true);
  });
});
